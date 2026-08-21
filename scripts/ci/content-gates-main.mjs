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
 *   - NON blocca niente. Non e' un required check, non entra nel gate
 *     dell'auto-merge (che aspetta il check-run chiamato `tests`), non tocca la
 *     branch protection. Su offender trovati esce 0: il segnale e' la issue.
 *   - Su offender trovati apre — o commenta — UNA sola issue, deduplicata sul
 *     titolo dal macchinario esistente (`scripts/lib/github-issue-creator.mjs`,
 *     dedup sui primi 60 caratteri). `TITLE` e' stabile e porta il
 *     discriminante all'INIZIO: il taglio a 60 butta l'ultimo token.
 *   - Quando i gate tornano verdi richiude la stessa issue, sullo stesso
 *     titolo, con `resolveGithubIssue`. Apertura e chiusura sono la STESSA
 *     valutazione, per la ragione di `ticker-shadow-alert.mjs`: una condizione
 *     senza un percorso di chiusura proprio resterebbe accesa per sempre col
 *     dedup sul titolo.
 *   - Esce !=0 SOLO quando il preflight fallisce, cioe' quando `content/` non
 *     c'e' o e' quasi vuoto. E' l'unico caso in cui una run rossa e' il segnale
 *     giusto: significa che il gate non ha guardato niente, e un gate che passa
 *     senza guardare e' peggio di nessun gate. Il rosso arriva a
 *     `workflow-failure-issues.yml`, che apre la sua issue centrale — ed e'
 *     anche il motivo per cui gli offender NON fanno uscire !=0: darebbero due
 *     issue per la stessa condizione.
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
import { createGithubIssue, resolveGithubIssue } from '../lib/github-issue-creator.mjs';

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
  'generator/tests/article-body-wordcount.test.mjs',
  'generator/tests/article-fabrication-guard.test.mjs',
  'generator/tests/article-slug-i18n.test.mjs',
  'generator/tests/article-topic-coverage-guard.test.mjs',
  'generator/tests/article-source-echo.test.mjs',
  'generator/tests/blog-headline-validation.test.mjs',
  'generator/tests/blog-title-casing.test.mjs',
  'generator/tests/escaped-tab-marker-corpus.test.mjs',
  'generator/tests/faq-locale-consistency.test.mjs',
  'generator/tests/frontaliere-sitemap-shadow.test.mjs',
  'generator/tests/it-microcopy-guard.test.mjs',
  'generator/tests/meta-localized-seo-description.test.mjs',
  'generator/tests/prompt-placeholder-guard.test.mjs',
  'generator/tests/seo-clause-truncation.test.mjs',
  'generator/tests/seo-description-cap.test.mjs',
  'generator/tests/seo-digit-residue-guard.test.mjs',
  'generator/tests/slug-placeholder-guard.test.mjs',
  'generator/tests/telelavoro-frontalieri-normative-citations.test.mjs',
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
  'generator/tests/corpus-paths.test.mjs':
    "verifica la funzione che MAPPA i path del sito su quelli del corpus: i "
    + "'content/...' che il rilevatore vede sono i valori ATTESI delle asserzioni, "
    + 'stringhe confrontate con stringhe. Non apre un file, quindi nessun articolo '
    + 'pubblicato puo\' renderlo rosso.',
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
 * Due forme, entrambe misurate sui 18 file che oggi la usano:
 *   A. `new URL('../../content/...', import.meta.url)`
 *   B. un identificatore ancorato a `import.meta.url` (di norma `ROOT`), poi
 *      `path.join(ROOT, 'content', ...)`
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
 * Tre forme riconosciute, non due: alle due dirette (`new URL(../content/…)`
 * e `path.join(ancora, 'content', …)`) si aggiunge l'indirezione via template
 * literal (`` `${ancora}/content/…` ``) sulla stessa `ancora` ancorata a
 * `import.meta.url`. Un helper importato da un altro modulo che nascondesse
 * l'accesso resterebbe comunque fuori: e' analisi cross-file, non alla
 * portata di un rilevatore statico su un singolo sorgente.
 */
function corpusReaderReason(src) {
  if (/new URL\(\s*[`'"][^`'"]*\.\.\/content\//.test(src)) return 'new URL(../../content/…, import.meta.url)';
  const ancore = new Set();
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*path\.(?:resolve|join)\([^;]*import\.meta\.url[^;]*\)/g)) ancore.add(m[1]);
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*(\w+)\s*;/g)) if (ancore.has(m[2])) ancore.add(m[1]);
  for (const a of ancore) {
    if (new RegExp(`path\\.(?:join|resolve)\\(\\s*${a}\\s*,\\s*['"\`](?:\\.\\.\\/)*content`).test(src)) {
      return `path.join(${a}, 'content', …)`;
    }
  }
  for (const tpl of src.match(/`[^`]*`/gs) || []) {
    if (!tpl.includes('content/')) continue;
    for (const a of ancore) {
      if (new RegExp(`\\$\\{\\s*${a}\\s*\\}`).test(tpl)) {
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
 * @returns {{ ok: boolean, violations: string[], perRoot: {rel:string,count:number}[] }}
 */
export function preflight(root = ROOT) {
  const perRoot = [...BLOG_BODY_ROOTS, SEO_ROOT].map((r) => ({
    ...r,
    count: collectTypeScriptFiles(path.join(root, r.rel)).length,
  }));
  const violations = floorViolations(perRoot);
  for (const rel of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(root, rel))) {
      violations.push(
        `${rel}: assente. I gate che lo leggono per nome passerebbero su un registro ` +
          'vuoto senza dire niente.',
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

const ARGV = process.argv.slice(2);
const val = (n, d) => {
  const i = ARGV.indexOf(n);
  return i !== -1 && ARGV[i + 1] ? ARGV[i + 1] : d;
};

export async function main() {
  const dryRun = ARGV.includes('--dry-run');
  const jsonOut = val('--json', null);

  const pre = preflight();
  for (const r of pre.perRoot) console.log(`[content-gates-main] ${r.rel}: ${r.count} file`);
  if (!pre.ok) {
    for (const v of pre.violations) console.error(`::error::preflight content — ${v}`);
    console.error(
      '[content-gates-main] preflight fallito: il gate NON ha guardato il corpus. ' +
        'Esco !=0 di proposito — un verde qui sarebbe la bugia peggiore che questo file possa dire.',
    );
    return 1;
  }

  const res = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', ...CONTENT_GATES],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const output = `${res.stdout || ''}\n${res.stderr || ''}`;
  console.log(output);

  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null;

  if (res.status === 0) {
    console.log(`[content-gates-main] ${CONTENT_GATES.length} gate verdi — richiudo un eventuale alert aperto.`);
    if (!dryRun) resolveGithubIssue(TITLE, { workflow: 'content-gates-main', runUrl });
    return 0;
  }

  const failures = parseTapFailures(output);
  const offenders = extractOffenders(output);
  console.log(
    `[content-gates-main] ROSSO: ${failures.tests.length} test falliti in ` +
      `${failures.files.length} gate, ${offenders.length} file di corpus nominati.`,
  );

  const description = buildIssueBody({
    failures,
    offenders,
    perRoot: pre.perRoot,
    runUrl,
    sha: process.env.GITHUB_SHA,
  });
  if (jsonOut) {
    fs.writeFileSync(jsonOut, `${JSON.stringify({ failures, offenders }, null, 2)}\n`);
  }
  if (dryRun) {
    console.log(`[content-gates-main] dry-run — aprirei/commenterei "${TITLE}":\n${description}`);
    return 0;
  }

  await createGithubIssue({
    title: TITLE,
    description,
    // priority:high — `classifyIssue` manda questo titolo in coda (categoria
    // `other`), e la label e' cio' che lo fa drenare per primo (`fuPrio` alto).
    priority: 2,
    labels: ['bug', 'automation'],
    workflow: 'content-gates-main',
  });

  // 0 di proposito: vedi l'intestazione. Il segnale e' la issue, e una run rossa
  // qui produrrebbe una SECONDA issue da `workflow-failure-issues.yml`.
  return 0;
}

// Solo in modalita' CLI: senza la guardia, importare questo modulo da un test lo
// eseguirebbe — e questo script apre issue sul repo.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      console.error(`[content-gates-main] errore fatale: ${e && e.stack ? e.stack : e}`);
      process.exit(1);
    },
  );
}
