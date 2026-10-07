#!/usr/bin/env node
/**
 * content-gates-main.mjs — fa girare i gate che scandiscono `content/**` DOVE
 * il corpus viene davvero scritto: su `main`, dopo il push di un bot.
 *
 * ## Il difetto, misurato il 2026-08-18
 *
 * `tests.yml` e `generator-ci.yml` hanno entrambi `push: branches-ignore:
 * [main]`. Ma i produttori del corpus (`generate-article.yml` e i suoi cinque
 * fratelli — vedi `generator/tests/corpus-producers-guard.test.mjs`) fanno
 * `git push "$REMOTE" "HEAD:$TARGET"` con `$TARGET == main`: 88 articoli nelle
 * ultime 24h. Il contenuto generato dai bot non passa quindi da NESSUN gate,
 * mai.
 *
 * Il gate esiste e funziona — gira solo nel posto sbagliato, e la rottura si
 * presenta come un rosso su lavoro estraneo, ore dopo. Le sei PR aperte quel
 * mattino (#410, #413, #414, #416, #417, #418) erano tutte e sei rosse sugli
 * STESSI tre test, nessuno dei quali causato da loro:
 *
 *   - `content/seo/** — code aperte su una parola funzionale`
 *     (generator/tests/seo-clause-truncation.test.mjs)
 *   - `nessuna occorrenza di «LFW»` e `nessuna occorrenza di «LPS»`
 *     (generator/tests/telelavoro-frontalieri-normative-citations.test.mjs)
 *
 * Applicando le regex esatte di quei gate al `main` di quel momento: ZERO
 * offender. Il contenuto colpevole era gia' stato sostituito da altri articoli
 * generati nel frattempo. `gh pr update-branch` su tutte e sei le PR le ha rese
 * verdi (9 check su 9) senza cambiare una riga.
 *
 * Quindi la seconda meta' del difetto, che e' la peggiore: nessuno ripara il
 * contenuto. Si ripara da solo per sostituzione, oppure resta li' — e intanto
 * blocca il merge di chiunque altro. Il 12-08 la stessa forma ha fermato i
 * merge per 13 ore (nanako#267).
 *
 * ## Perche' esiste come file nuovo, e non come una riga in `tests.yml`
 *
 * Togliere `branches-ignore: [main]` da `tests.yml` farebbe girare l'INTERA
 * suite (112 file) a ogni articolo, ~90 volte al giorno, e — peggio —
 * `tests.yml` e' il check-run che l'auto-merge aspetta: una run su `main` con
 * quel nome entra in un grafo che non e' il suo. Qui si paga solo cio' che il
 * push ha davvero cambiato: i gate che leggono `content/`.
 *
 * ## La precedente e' stata chiusa senza fix
 *
 * La issue #267 («article-fabrication-guard non gira mai sugli articoli
 * generati: tests.yml ignora main») descriveva esattamente questo. L'ultimo
 * commento e' `<!-- FIX_OUTCOME: max-turns -->`: il fixer e' morto per budget di
 * turni e il closer ha chiuso lo stesso. Il difetto e' ricomparso oggi.
 *
 * ## Cosa fa, e cosa deliberatamente NON fa
 *
 *   - Non è un required check e non cambia la branch protection.
 *   - Un gate rosso, TAP incompleto, errore di esecuzione o preflight fallito
 *     esce !=0: lo stato Actions deve riflettere il risultato, anche in dry-run.
 *   - Gli offender aprono/commentano una issue deduplicata su TITLE; un run
 *     interamente verde richiude lo stesso alert. Il reporting non converte
 *     mai un fallimento in successo.
 *   - Scrive sempre un riepilogo JSON, anche su successo o preflight fallito.
 *     Node drena stdout/stderr prima dell'uscita: niente process.exit immediato.
 *
 * Uso:
 *   node scripts/ci/content-gates-main.mjs [--dry-run] [--json <path>]
 * Env:
 *   GH_TOKEN            il PAT (`GITHUB_PAT_NANAKO`), non il GITHUB_TOKEN: una
 *                       issue aperta dal GITHUB_TOKEN non emette
 *                       `issues: opened` e nasce fuori dal triage event-driven.
 *   GITHUB_REPOSITORY   owner/repo (auto in Actions).
 *   GITHUB_SERVER_URL / GITHUB_RUN_ID  per il link alla run nel corpo.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BLOG_BODY_ROOTS,
  collectTypeScriptFiles,
  floorViolations,
} from './check-blog-body-syntax.mjs';
import { historyRevisionFromEnv } from '../lib/corpus-floors.mjs';
import { createGithubIssue, resolveGithubIssue } from '../lib/github-issue-creator.mjs';
import { isRegularFile } from '../lib/article-surfaces.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * STABILE — mai un conteggio dentro: e' la chiave di deduplica di
 * `createGithubIssue` (primi 60 caratteri) ED e' la chiave con cui
 * `resolveGithubIssue` richiude. Il discriminante («gate content su main») sta
 * all'INIZIO perche' `searchSafePrefix()` taglia a 60 e butta il token spezzato
 * dal taglio: un titolo che mettesse la parte distintiva in fondo collasserebbe
 * su un prefisso generico e dedupplicherebbe sulla issue sbagliata.
 *
 * Niente `/` ne' `*` nel titolo: il dedup lo usa dentro `gh issue list --search
 * 'in:title "<frase>"'`, e la phrase search di GitHub e' fragile su quei
 * caratteri (vedi il commento di `searchSafePrefix`).
 */
export const TITLE = 'gate content su main: offender nel corpus generato dai bot';

/**
 * I GATE, MISURATI — non scelti a naso.
 *
 * Metodo (2026-08-18): ognuno dei 112 file di `generator/tests/*.test.mjs` e'
 * stato eseguito con un hook su `fs.readFileSync/readdirSync/statSync/...` che
 * registra ogni path risolto sotto `<repo>/content/`. Diciannove file leggono
 * davvero il corpus. Due sono stati esclusi dopo aver guardato PERCHE' lo
 * leggono:
 *
 *   - `corpus-producers-guard.test.mjs` (15,3s, il piu' lento di tutti): legge
 *     `content/` solo per specchiarlo dentro un repo git usa-e-getta
 *     (`mirror('content')`) su cui poi esercita la guardia. Il suo verdetto non
 *     dipende da cosa c'e' su `main`: e' un test sulla FORMA dei workflow
 *     produttori, e su quelli le PR bastano.
 *   - `generation-health-watchdog.test.mjs`: i suoi accessi a `content/`
 *     arrivano dall'import di `scan-generation-health.mjs`, che legge i registri
 *     a module-scope. Testa un parser di log, non il corpus.
 *
 * Restano i diciassette qui sotto: 32,0s in totale, misurati in sequenza in
 * locale (`awk` sulla somma dei tempi per file). In un `node --test` unico i
 * file girano in parallelo, quindi in CI costa meno.
 *
 * Fra questi ci sono i tre che il difetto ha prodotto DAL VIVO —
 * `seo-clause-truncation` e `telelavoro-frontalieri-normative-citations`
 * (le due sigle LFW/LPS) — piu' `article-fabrication-guard`, che e' quello che
 * la #267 nominava. Gli altri quattordici scandiscono lo stesso corpus con la
 * stessa forma di regola e sarebbero rossi allo stesso modo: escluderli
 * lascerebbe scoperta la meta' del difetto che non si e' ancora manifestata.
 */
export const CONTENT_GATES = [
  'generator/tests/brogeda-editorial-correction.test.mjs',
  'generator/tests/historical-unknown-dates.test.mjs',
  // Il test che dimostra la completezza del gate esegue anche il preflight
  // sul corpus reale: un registro o un pavimento pubblicato rotto deve aprire
  // la stessa issue degli altri lettori, non nascondersi nella meta-suite.
  'generator/tests/content-gates-main.test.mjs',
  // Il caso canonical override apre una superficie reale sotto content/ oltre
  // al corpus sintetico: una nuova coppia shadowed/winner deve restare valida.
  'generator/tests/canton-hubs.test.mjs',
  'generator/tests/courmayeur-vallese-content.test.mjs',
  // Il ratchet legge i ledger URL→id pubblicati: un nuovo articolo può
  // introdurre un duplicato cross-sezione anche senza cambiare il test.
  'generator/tests/cross-section-duplicate-ratchet.test.mjs',
  // P14: i record di credito delle copertine Commons (content/image-credits/)
  // e i letterali SEO delle copertine accreditate: li scrive il generatore,
  // direttamente su `main`.
  'generator/tests/image-credits-content.test.mjs',
  'generator/tests/article-body-wordcount.test.mjs',
  'generator/tests/article-fabrication-guard.test.mjs',
  'generator/tests/article-slug-i18n.test.mjs',
  'generator/tests/article-unrendered-markup.test.mjs',
  'generator/tests/article-topic-coverage-guard.test.mjs',
  'generator/tests/article-source-echo.test.mjs',
  'generator/tests/blog-headline-validation.test.mjs',
  'generator/tests/blog-title-casing.test.mjs',
  'generator/tests/escaped-tab-marker-corpus.test.mjs',
  'generator/tests/evergreen-addizionale-irpef-mappa-comuni-refresh.test.mjs',
  // Lotto «assicurazione malattia» del 2026-10-07: quattro guide rilette contro
  // la scheda dei fatti verificati. Ogni test legge i body nelle quattro lingue
  // e, per due guide, anche estratti e voce SEO.
  'generator/tests/evergreen-assicurazione-malattia-famiglia-refresh.test.mjs',
  'generator/tests/evergreen-fatture-mediche-gonfiate-ticino-refresh.test.mjs',
  'generator/tests/evergreen-lamal-vs-cmi-refresh.test.mjs',
  'generator/tests/evergreen-malattia-frontaliere-guida-assicurazione-refresh.test.mjs',
  'generator/tests/evergreen-bonus-famiglia-frontalieri-2026-refresh.test.mjs',
  'generator/tests/evergreen-calcolo-pensione-avs-inps-refresh.test.mjs',
  'generator/tests/evergreen-calcolo-tasse-entro-confine-refresh.test.mjs',
  'generator/tests/evergreen-comuni-frontalieri-distanza-refresh.test.mjs',
  'generator/tests/evergreen-congedo-genitori-frontaliere-ticino-refresh.test.mjs',
  'generator/tests/evergreen-contributi-sociali-busta-paga-refresh.test.mjs',
  'generator/tests/evergreen-costo-pendolare-auto-ticino-2026-refresh.test.mjs',
  'generator/tests/evergreen-costo-vita-ticino-vs-lombardia-refresh.test.mjs',
  'generator/tests/evergreen-costo-vivere-lugano-trasferirsi-refresh.test.mjs',
  'generator/tests/evergreen-credito-imposta-doppia-tassazione-refresh.test.mjs',
  'generator/tests/evergreen-dichiarazione-redditi-ticino-2026-refresh.test.mjs',
  'generator/tests/evergreen-guida-contributi-sociali-svizzera-refresh.test.mjs',
  'generator/tests/evergreen-guida-dichiarazione-redditi-frontalieri-refresh.test.mjs',
  'generator/tests/evergreen-guida-pensione-frontaliere-avs-lpp-refresh.test.mjs',
  'generator/tests/evergreen-irpef-secondo-scaglione-2026.test.mjs',
  'generator/tests/evergreen-lamal-cmi-scelta-frontaliere-2026-refresh.test.mjs',
  'generator/tests/evergreen-lamal-vs-ssn-decisione-refresh.test.mjs',
  'generator/tests/evergreen-mappa-fiscale-comuni-frontiera-refresh.test.mjs',
  'generator/tests/evergreen-naspi-disoccupazione-frontalieri-refresh.test.mjs',
  'generator/tests/evergreen-maternita-paternita-frontaliere-guida-refresh.test.mjs',
  'generator/tests/evergreen-maternita-paternita-ticino-refresh.test.mjs',
  'generator/tests/evergreen-naspi-ex-frontalieri-2026-refresh.test.mjs',
  'generator/tests/evergreen-naspi-ex-frontalieri-guida-refresh.test.mjs',
  'generator/tests/evergreen-naspi-frontaliere-italia-requisiti-refresh.test.mjs',
  'generator/tests/evergreen-naspi-frontalieri-italia-requisiti-calcolo-domanda-refresh.test.mjs',
  'generator/tests/evergreen-naspi-frontendalieri-requisiti-calcolo-2024-refresh.test.mjs',
  'generator/tests/evergreen-prelievo-secondo-pilastro-frontaliere-refresh.test.mjs',
  'generator/tests/evergreen-pilastro-3a-frontaliere-refresh.test.mjs',
  'generator/tests/evergreen-ristorni-fiscali-ticino-refresh.test.mjs',
  'generator/tests/evergreen-ritenuta-lpp-intermediario-residente-refresh.test.mjs',
  'generator/tests/evergreen-simulazione-fiscale-frontaliere-2026-refresh.test.mjs',
  'generator/tests/evergreen-smart-working-frontalieri-2026-refresh.test.mjs',
  'generator/tests/evergreen-tassa-salute-tensioni-ticino-refresh.test.mjs',
  'generator/tests/evergreen-tassazione-individuale-refresh.test.mjs',
  'generator/tests/evergreen-tassazione-individuale-voto-refresh.test.mjs',
  'generator/tests/evergreen-telelavoro-accordo-definitivo-italia-refresh.test.mjs',
  'generator/tests/evergreen-tredicesima-frontaliere-refresh.test.mjs',
  'generator/tests/evergreen-telelavoro-frontalieri-ratifica-refresh.test.mjs',
  'generator/tests/evergreen-triad-refresh.test.mjs',
  'generator/tests/faq-locale-consistency.test.mjs',
  // Censimento della trasformazione d'uscita delle traduzioni (#2311): passa
  // ogni body italiano dal bilanciatore dei grassetti e pretende lo stesso
  // numero di righe. Giudica una funzione, ma sul corpus reale: un articolo
  // nuovo con una forma di Markdown non prevista lo rende rosso su `main` e
  // su ogni branch, e allora deve aprire una issue, non fermare la coda.
  'generator/tests/free-translate-exit-transform-structure.test.mjs',
  'generator/tests/frontaliere-sitemap-shadow.test.mjs',
  'generator/tests/it-microcopy-guard.test.mjs',
  'generator/tests/key-facts-specificity.test.mjs',
  'generator/tests/meta-fields-plausibility-floor.test.mjs',
  'generator/tests/meta-localized-seo-description.test.mjs',
  'generator/tests/prompt-placeholder-guard.test.mjs',
  // Ogni voce di registry nata dal cutover dichiara `articleType`, e ogni
  // `verifiedAt` ha la sua prova nel ledger delle verifiche.
  'generator/tests/registry-article-type.test.mjs',
  // Osservatore del tetto `TESTIMONE_GIRI_MAX` (#404): non giudica il corpus,
  // giudica se il tetto della riparazione caratteri LEGA sul corpus. Sta qui e
  // non fra i gate di PR per la ragione di tutta questa lista — legge
  // `content/`, che nessuna PR scrive. E' l'unico che costa ~40s (una passata
  // su 19.588 file); gli altri diciotto stanno sotto il secondo.
  'generator/tests/repair-mangled-chars-tetto-corpus.test.mjs',
  'generator/tests/retire-article-leftover-check.test.mjs',
  'generator/tests/retired-articles-fully-removed.test.mjs',
  'generator/tests/seo-clause-truncation.test.mjs',
  'generator/tests/seo-title-prefix-repair.test.mjs',
  'generator/tests/seo-description-cap.test.mjs',
  'generator/tests/seo-digit-residue-guard.test.mjs',
  'generator/tests/seo-http-downgrade.test.mjs',
  'generator/tests/slug-placeholder-guard.test.mjs',
  'generator/tests/telelavoro-frontalieri-normative-citations.test.mjs',
  'generator/tests/ts-literal-span.test.mjs',
  'generator/tests/vacant-key-facts.test.mjs',
  'generator/tests/wrong-latin-language-adoption.test.mjs',
];

/**
 * ── PERCHE' LA LISTA QUI SOPRA NON BASTA, E COSA LA TIENE COMPLETA ─────────
 *
 * La lista e' MISURATA, dice il commento — ed e' vero: e' stata misurata **una
 * volta**, a mano, il 2026-08-18, facendo girare i test sotto un hook su `fs`.
 * Nulla la rimisurava. I test esistenti verificavano che non fosse vuota, che i
 * file elencati esistessero e che non ci fossero duplicati: tutte proprieta'
 * della lista, nessuna del suo RAPPORTO con la cartella dei test.
 *
 * Il costo di quel buco, misurato il 2026-08-19.
 * `generator/tests/article-topic-coverage-guard.test.mjs` legge il corpus reale
 * del checkout e non era registrato. Alle 07:27Z e' atterrato l'articolo
 * `vivere-villa-guardia-lavorare-ticino`: «Villa Guardia» e' un comune, e
 * «guardia» e' l'alias del mestiere `agente-sicurezza`. Il test e' diventato
 * rosso su `main` e su OGNI branch, quindi **nessuna PR poteva auto-mergiare**,
 * e siccome il gate non era registrato **non e' stata aperta nessuna issue**:
 * sei ore di coda ferma senza un segnale. Con la registrazione, la stessa
 * pubblicazione avrebbe aperto una issue `bug`/`automation` a priorita' alta
 * entro pochi minuti, e il fixer l'avrebbe drenata da solo.
 *
 * La lezione non e' «aggiungere quel file»: e' che «non e' un content gate» e
 * «nessuno ha guardato» erano indistinguibili. E' la stessa ambiguita' che
 * `loop-sync-manifest.json` chiude dichiarando i `roots`, e si chiude allo
 * stesso modo: RIDERIVANDO la misura invece di fidarsi di un conteggio a mano.
 *
 * Il rilevatore qui sotto e' statico e imperfetto per costruzione — un hook su
 * `fs` sarebbe esatto ma costringerebbe a eseguire 136 file di test dentro un
 * test. Il patto e' quindi: cio' che il rilevatore VEDE dev'essere registrato
 * oppure esentato con una ragione. Un falso negativo non fa danno (il file o e'
 * gia' registrato, o sfugge come sfuggiva prima); un falso positivo costa una
 * riga di esenzione. Cio' che non e' piu' possibile e' aggiungere in silenzio un
 * test che legge il corpus senza che nessuno abbia deciso.
 */

/**
 * Un file di test che il rilevatore vede come lettore del corpus ma che NON e'
 * un content gate, con la ragione. Una riga qui e' una decisione presa, non un
 * silenzio.
 */
export const NON_SONO_CONTENT_GATES = Object.freeze({
  'generator/tests/canton-article-workflows.test.mjs':
    'verifica la generazione dei workflow cantonali con YAML e corpi sintetici '
    + 'in directory temporanee; non apre il content/ reale del checkout, quindi '
    + 'un articolo pubblicato non puo\' renderla rossa.',
  'generator/tests/regenerate-queued-covers.test.mjs':
    'verifica workflow, script e fixture del drain; il path ancorato a import.meta.url '
    + 'punta a .github/workflows e non apre il content/ reale del checkout, quindi '
    + 'un articolo pubblicato non puo\' renderla rossa.',
  'generator/tests/canton-classifier.test.mjs':
    'classifica snapshot in generator/data e un mini-corpus creato sotto '
    + 'mkdtemp; non legge il content/ reale del checkout, quindi un articolo '
    + 'pubblicato non puo\' renderla rossa.',
  'generator/tests/corpus-paths.test.mjs':
    "verifica la funzione che MAPPA i path del sito su quelli del corpus: i "
    + "'content/...' che il rilevatore vede sono i valori ATTESI delle asserzioni, "
    + 'stringhe confrontate con stringhe. Non apre un file, quindi nessun articolo '
    + 'pubblicato puo\' renderlo rosso.',
  'generator/tests/corpus-producers-guard.test.mjs':
    'controlla la forma dei workflow produttori e specchia content/ in un '
    + 'repository git temporaneo per provare la guardia; il verdetto non dipende '
    + 'dal corpus pubblicato del checkout.',
  'generator/tests/loop-workflow-triggers.test.mjs':
    'verifica solo trigger, concorrenza e forma dei workflow; le stringhe '
    + 'content/** sono valori attesi e nessun file del corpus viene aperto.',
  'generator/tests/sanitize-control-chars.test.mjs':
    'prova il sanitizzatore con titoli fixture e ispeziona solo scripts/; '
    + 'content/ compare come dato atteso, ma nessun articolo o registro del '
    + 'checkout viene letto.',
  'generator/tests/section-pages.test.mjs':
    'prova il publisher con registri, slug, hub e pagine costruiti in directory '
    + 'temporanee; sulle superfici reali verifica solo symlink/layout e presenza, '
    + 'non legge ne\' valuta articoli sotto content/.',
  'generator/tests/section-registry.test.mjs':
    'valida sections/registry.json e il publisher con documenti e superfici '
    + 'sintetiche in directory temporanee; non legge gli articoli reali sotto '
    + 'content/ del checkout.',
});

/**
 * I file di `generator/tests/` che leggono il corpus REALE del checkout.
 *
 * «Reale» e non «un albero qualsiasi»: la discriminante e' che il path sia
 * ancorato alla RADICE DEL REPO, non a una cartella temporanea. E' quella la
 * differenza fra un test che un articolo pubblicato puo' far diventare rosso e
 * uno che si costruisce i propri file: mezza dozzina di test scrivono
 * `path.join(root, 'content', ...)` dentro una `mkdtemp`, e contarli sarebbe
 * rumore puro.
 *
 * Quattro forme, tutte statiche e limitate a questo sorgente:
 *   A. `new URL('../../content/...', import.meta.url)`
 *   B. un identificatore ancorato a `import.meta.url` (di norma `ROOT`), poi
 *      `path.join(ROOT, 'content', ...)`
 *   C. lo stesso identificatore dentro un template literal
 *      (`` `${ROOT}/content/...` ``)
 *   D. un helper che passa un identificatore a `path.join(ROOT, rel)` e usa
 *      altrove un literal che comincia con `content/` — la forma indiretta che
 *      le prime tre non vedevano.
 *
 * Ricorsivo: `{fixtures,lib,parity}/` oggi non hanno `.test.mjs` dentro, ma un
 * file futuro li' andrebbe comunque registrato o esentato, altrimenti e' di
 * nuovo lo stesso silenzio — un lettore del corpus reale invisibile al
 * rilevatore che dovrebbe accorgersene.
 *
 * @param {string} dir cartella dei test, assoluta
 * @param {string} rel prefisso da anteporre ai nomi resi (per confrontarli con CONTENT_GATES)
 * @returns {{file: string, why: string}[]}
 */
export function detectCorpusReaders(dir, rel = 'generator/tests') {
  const out = [];
  const walk = (abs, relPrefix) => {
    const entries = fs.readdirSync(abs, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absChild = path.join(abs, entry.name);
      const relChild = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(absChild, relChild);
        continue;
      }
      if (!entry.name.endsWith('.test.mjs')) continue;
      const src = fs.readFileSync(absChild, 'utf-8');
      const why = corpusReaderReason(src);
      if (why) out.push({ file: `${rel}/${relChild}`, why });
    }
  };
  walk(dir, '');
  return out;
}

/**
 * La forma con cui un sorgente raggiunge il corpus reale, o null.
 *
 * Quattro forme riconosciute: alle due dirette (`new URL(../content/…)` e
 * `path.join(ancora, 'content', …)`) si aggiungono il template literal
 * (`` `${ancora}/content/…` ``) e l'helper indiretto (`path.join(ancora, rel)`)
 * con un literal `content/...` nello stesso sorgente. Un helper importato da un
 * altro modulo che nascondesse l'accesso resterebbe comunque fuori: e' analisi
 * cross-file, non alla portata di un rilevatore statico su un singolo sorgente.
 */
const JS_IDENTIFIER_PATTERN = '[A-Za-z_$][\\w$]*';
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function corpusReaderReason(src) {
  if (/new URL\(\s*[`'"][^`'"]*\.\.\/content\//.test(src)) return 'new URL(../../content/…, import.meta.url)';
  const ancore = new Set();
  const anchoredDeclaration = new RegExp(
    `const\\s+(${JS_IDENTIFIER_PATTERN})\\s*=\\s*path\\.(?:resolve|join)\\([^;]*import\\.meta\\.url[^;]*\\)`,
    'g',
  );
  const anchorAlias = new RegExp(
    `const\\s+(${JS_IDENTIFIER_PATTERN})\\s*=\\s*(${JS_IDENTIFIER_PATTERN})\\s*;`,
    'g',
  );
  for (const m of src.matchAll(anchoredDeclaration)) ancore.add(m[1]);
  for (const m of src.matchAll(anchorAlias)) if (ancore.has(m[2])) ancore.add(m[1]);
  for (const a of ancore) {
    const escapedAnchor = escapeRegExp(a);
    if (new RegExp(`path\\.(?:join|resolve)\\(\\s*${escapedAnchor}\\s*,\\s*['"\`](?:\\.\\.\\/)*content`).test(src)) {
      return `path.join(${a}, 'content', …)`;
    }
  }
  const hasContentLiteral = /['"`]content\/[^'"`]+['"`]/.test(src);
  if (hasContentLiteral) {
    for (const a of ancore) {
      if (new RegExp(`path\\.(?:join|resolve)\\(\\s*${escapeRegExp(a)}\\s*,\\s*[A-Za-z_$][\\w$]*\\s*[,)]`).test(src)) {
        return `path.join/resolve(${a}, <identificatore>) + literal 'content/…' (lettura indiretta)`;
      }
    }
  }
  for (const tpl of src.match(/`[^`]*`/gs) || []) {
    if (!tpl.includes('content/')) continue;
    for (const a of ancore) {
      if (new RegExp(`\\$\\{\\s*${escapeRegExp(a)}\\s*\\}`).test(tpl)) {
        return `\`\${${a}}/content/…\` (template literal)`;
      }
    }
  }
  return null;
}

/**
 * I file singoli che i gate leggono per NOME (non per scansione di cartella):
 * gli otto registri di meta, i due router degli slug, le nove pagine SEO. Un
 * `content/` presente ma amputato di uno di questi rende verdi i gate che lo
 * leggono, in silenzio — e' la stessa classe del pavimento sulle cartelle, su
 * un oggetto che un conteggio di file non copre.
 */
export const REQUIRED_FILES = [
  'content/blog-articles-data.ts',
  'content/swiss-articles-data.ts',
  'content/routerBlogData.ts',
  'content/routerSwissData.ts',
  ...['it', 'en', 'de', 'fr'].map((l) => `content/blog-meta-${l}.ts`),
  ...['it', 'en', 'de', 'fr'].map((l) => `content/blog-meta-ch-${l}.ts`),
];

/** Pavimento sulle pagine SEO: `content/seo` ne ha 9 (misurate il 2026-08-18). */
export const SEO_ROOT = { rel: 'content/seo', minFiles: 4 };

/**
 * NIENTE FALSO VERDE. Riusa i pavimenti di `check-blog-body-syntax.mjs`
 * (`BLOG_BODY_ROOTS` + `floorViolations`, che applica anche il pavimento sul
 * TOTALE) invece di riscriverne di propri: e' lo stesso invariante, sullo stesso
 * corpus, e due copie divergerebbero.
 *
 * Puro rispetto alla rete e a `gh`: prende `root` in input cosi' il test lo puo'
 * puntare su un albero finto.
 *
 * @param {string} [root]
 * @param {{previousRegistryCounts?: Record<string, number>, previousRevision?: string|null}} [options]
 * @returns {{ ok: boolean, violations: string[], perRoot: {rel:string,count:number}[] }}
 */
export function preflight(
  root = ROOT,
  { previousRegistryCounts, previousRevision = historyRevisionFromEnv() } = {},
) {
  const perRoot = [...BLOG_BODY_ROOTS, SEO_ROOT].map((r) => ({
    ...r,
    count: collectTypeScriptFiles(path.join(root, r.rel)).length,
  }));
  const violations = floorViolations(perRoot, {
    root,
    previousRegistryCounts,
    previousRevision,
  });
  for (const rel of REQUIRED_FILES) {
    if (!isRegularFile(root, rel)) {
      violations.push(
        `${rel}: assente o non è un file regolare leggibile. I gate che lo leggono per nome ` +
          'passerebbero su un registro vuoto senza dire niente.',
      );
    }
  }
  return { ok: violations.length === 0, violations, perRoot };
}

/**
 * I nomi dei test falliti da un output TAP di `node --test`.
 *
 * Si legge il TAP e non lo `spec` reporter perche' `spec` e' pensato per un
 * umano e cambia forma fra le minor di Node; il TAP no. Le righe `not ok`
 * annidate portano il nome del test, quelle a indentazione zero il file — e in
 * una run multi-file entrambe compaiono, quindi il filtro sul nome che finisce
 * in `.test.mjs` e' cio' che tiene i due piani separati.
 *
 * @param {string} tap
 * @returns {{ tests: string[], files: string[] }}
 */
export function parseTapFailures(tap) {
  const tests = [];
  const files = [];
  for (const line of String(tap).split('\n')) {
    const m = line.match(/^(\s*)not ok \d+ - (.+?)\s*$/);
    if (!m) continue;
    const name = m[2];
    if (/\.test\.mjs$/.test(name)) {
      if (!files.includes(name)) files.push(name);
    } else if (!tests.includes(name)) {
      tests.push(name);
    }
  }
  return { tests, files };
}

/**
 * Gli offender NOMINATI dai messaggi di fallimento: i gate del corpus stampano
 * il path del file colpevole (e spesso la sigla o la frase incriminata) dentro
 * l'assertion message. Estrarli e' cio' che rende la issue azionabile senza
 * riaprire il log della run.
 *
 * Deliberatamente niente parsing del YAML TAP: i messaggi sono prosa libera e
 * cambiano da gate a gate. Si cercano i path sotto `content/`, che sono l'unica
 * forma comune a tutti.
 *
 * @param {string} output
 * @returns {string[]}
 */
export function extractOffenders(output) {
  const found = new Map();
  const re = /content\/[A-Za-z0-9_@./-]*[A-Za-z0-9_](?:\.ts|\.json)/g;
  for (const m of String(output).matchAll(re)) {
    const p = m[0];
    found.set(p, (found.get(p) || 0) + 1);
  }
  return [...found.keys()].sort();
}

/** Il corpo dell'issue quando la condizione e' accesa. */
export function buildIssueBody({ failures, offenders, perRoot, runUrl, sha }) {
  const lines = [
    'I gate che scandiscono `content/**` sono ROSSI su `main`. Il push che li ha resi rossi',
    'e\' quasi sempre di un bot produttore (`generate-article.yml` e fratelli), che pusha',
    'direttamente su `main` — dove `tests.yml` non gira (`branches-ignore: [main]`).',
    '',
    `- commit: \`${sha || '?'}\``,
    ...(runUrl ? [`- run: ${runUrl}`] : []),
    `- corpus scandito: ${perRoot.map((r) => `${r.rel} ${r.count}`).join(' · ')}`,
    '',
    '## Test falliti',
    '',
    ...(failures.tests.length
      ? failures.tests.map((t) => `- \`${t}\``)
      : ['- _nessun nome di test estratto dal TAP: vedi il log della run_']),
    '',
    '## File del corpus nominati dai fallimenti',
    '',
    ...(offenders.length
      ? offenders.slice(0, 200).map((f) => `- \`${f}\``)
      : ['- _nessun path `content/` nel messaggio di fallimento: vedi il log della run_']),
    ...(offenders.length > 200 ? ['', `_(+${offenders.length - 200} altri, troncati)_`] : []),
    '',
    '## Suggested action',
    '',
    'Riparare il CONTENUTO, non il gate: sono articoli gia\' pubblicati e gia\' scesi al sito.',
    'Finche\' restano su `main` ogni PR aperta da chiunque nasce rossa su questi stessi test,',
    'senza averli causati — e la riparazione «spontanea» che a volte si osserva e\' solo',
    'l\'articolo colpevole sostituito da uno successivo, non una fix.',
    '',
    'Si chiude da sola al primo push su `main` in cui questi gate tornano verdi — vedi',
    '`scripts/ci/content-gates-main.mjs`.',
  ];
  return lines.join('\n');
}

/** Final top-level TAP counters, kept separate from nested subtest output. */
export function parseTapSummary(output) {
  const counters = {};
  for (const name of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const match = String(output).match(new RegExp(`^# ${name} (\\d+)\\s*$`, 'm'));
    counters[name] = match ? Number(match[1]) : null;
  }
  const complete = /^1\.\.\d+\s*$/m.test(String(output))
    && Object.values(counters).every((value) => value !== null)
    && counters.tests > 0
    && counters.tests === counters.pass + counters.fail + counters.cancelled + counters.skipped + counters.todo;
  return { ...counters, complete };
}

/** Dependency injection keeps runner tests independent of the live corpus and GitHub. */
export async function main({
  argv = process.argv.slice(2), root = ROOT, gates = CONTENT_GATES,
  checkPreflight = preflight, runTests = spawnSync,
  createIssue = createGithubIssue, resolveIssue = resolveGithubIssue,
  env = process.env,
} = {}) {
  const dryRun = argv.includes('--dry-run');
  const jsonIndex = argv.indexOf('--json');
  const jsonOut = path.resolve(root, jsonIndex >= 0 && argv[jsonIndex + 1]
    ? argv[jsonIndex + 1] : 'reports/content-gates-main-summary.json');
  const summary = {
    schemaVersion: 1, state: 'execution-error', exitCode: 1,
    commit: env.GITHUB_SHA || null, gates: [...gates],
    preflight: null, child: null, tap: null,
    failures: { tests: [], files: [] }, offenders: [],
  };
  const save = () => {
    fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
    fs.writeFileSync(jsonOut, `${JSON.stringify(summary, null, 2)}\n`);
  };
  try {
    const pre = checkPreflight(root);
    summary.preflight = pre;
    for (const r of pre.perRoot) console.log(`[content-gates-main] ${r.rel}: ${r.count} file`);
    if (!pre.ok) {
      summary.state = 'preflight-failed';
      for (const v of pre.violations) console.error(`::error::preflight content — ${v}`);
      console.error('[content-gates-main] preflight fallito: il gate NON ha guardato il corpus.');
      return 1;
    }

    const res = runTests(process.execPath, ['--test', '--test-reporter=tap', ...gates],
      { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const output = `${res.stdout || ''}\n${res.stderr || ''}`;
    console.log(output);
    summary.child = { status: res.status ?? null, signal: res.signal || null, error: res.error?.message || null };
    summary.tap = parseTapSummary(res.stdout || '');
    summary.failures = parseTapFailures(output);
    summary.offenders = extractOffenders(output);
    const passed = res.status === 0 && !res.error && !res.signal && summary.tap.complete
      && summary.tap.fail === 0 && summary.tap.cancelled === 0
      && summary.failures.tests.length === 0 && summary.failures.files.length === 0;
    summary.state = passed ? 'passed' : (res.error || res.signal || !summary.tap.complete ? 'execution-error' : 'failed');
    summary.exitCode = passed ? 0 : 1;

    const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null;
    if (passed) {
      console.log(`[content-gates-main] ${gates.length} gate verdi — richiudo un eventuale alert aperto.`);
      if (!dryRun) await resolveIssue(TITLE, { workflow: 'content-gates-main', runUrl });
      return 0;
    }

    console.error(`[content-gates-main] ROSSO: ${summary.failures.tests.length} test falliti; `
      + `${summary.offenders.length} file di corpus nominati; stato ${summary.state}.`);
    const description = buildIssueBody({ failures: summary.failures, offenders: summary.offenders,
      perRoot: pre.perRoot, runUrl, sha: env.GITHUB_SHA });
    if (dryRun) console.log(`[content-gates-main] dry-run — aprirei/commenterei "${TITLE}":\n${description}`);
    else await createIssue({ title: TITLE, description, priority: 2, labels: ['bug', 'automation'], workflow: 'content-gates-main' });
    return 1;
  } catch (error) {
    summary.state = 'execution-error';
    summary.exitCode = 1;
    summary.error = error?.message || String(error);
    console.error(`[content-gates-main] errore fatale: ${error?.stack || error}`);
    return 1;
  } finally {
    save();
  }
}

/** Let Node drain stdout/stderr naturally; process.exit() can truncate piped TAP. */
export async function runCli(run = main) {
  try {
    process.exitCode = await run();
  } catch (error) {
    console.error(`[content-gates-main] errore fatale: ${error?.stack || error}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli();
}
