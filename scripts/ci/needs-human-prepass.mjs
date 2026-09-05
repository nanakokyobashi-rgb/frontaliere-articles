#!/usr/bin/env node
/**
 * needs-human-prepass.mjs — la metà deterministica dello sweep `needs-human`.
 *
 * Adattamento corpus del gemello del sito (manifest: `adapted`). La FORMA è
 * quella di `frontaliere-si-o-no/scripts/ci/needs-human-prepass.mjs`; il
 * CONTENUTO — le famiglie riconosciute — non è copiabile, perché i titoli li
 * scrivono i monitor di QUESTO repo e sono altri (vedi sotto).
 *
 * ## Il difetto, misurato qui
 *
 * `needs-human` è uno stato ASSORBENTE su questo repo: nessun workflow lo
 * riprende in mano. Il sito ha chiuso il buco il 2026-08-21 con
 * `needs-human-sweep.yml` + questo pre-pass; il corpus non ha mai ricevuto né
 * l'uno né l'altro — verificato il 2026-08-25: zero workflow che nominano
 * `needs-human` o `vision` sotto `.github/workflows/`.
 *
 * Cosa costa, misurato il 2026-08-25:
 *   - **17 issue aperte in `needs-human`**, la più ferma dal 2026-08-18;
 *   - e nello stesso momento la coda del ciclo è **VUOTA**: `agent:fix-queued`
 *     0, `agent:decompose-queued` 0, `agent:fix` 0, PR aperte 0, con ~105 PR
 *     mergiate negli ultimi 7 giorni (≈15/giorno).
 *
 * Cioè: il fixer autonomo gira a vuoto mentre 17 issue sono parcheggiate in uno
 * stato da cui nessuno le tira fuori. Non è una coda satura, è un'uscita che non
 * esiste.
 *
 * ## Perché una ALLOWLIST e non una denylist
 *
 * La direzione dell'errore non è simmetrica. Ri-accodare per sbaglio una
 * decisione del proprietario significa far implementare al fixer una scelta che
 * non gli spetta. Lasciare per sbaglio una tecnica al run Claude costa invece
 * una sola azione del suo cap.
 *
 * Quindi si riconoscono POSITIVAMENTE le famiglie generate dai NOSTRI monitor, e
 * tutto il resto resta dov'è. Una famiglia nuova non viene drenata finché
 * qualcuno non la aggiunge qui — che è il modo giusto di sbagliare, perché il run
 * Claude la prende comunque.
 *
 * ## Cosa NON è copiabile dal sito
 *
 * 1. **Le famiglie.** Il sito riconosce `[crawler-health]`, `App Error:`,
 *    `PostHog Exception:`, `CWV regression` — monitor che qui non esistono. I
 *    monitor di questo repo sono altri e i titoli stanno nei loro sorgenti
 *    (citati uno per uno accanto a ogni pattern), non in una lista inventata.
 * 2. **La famiglia PAT, che qui è OWNER-ONLY.** Il sito instrada la sua
 *    identità con una GitHub App; qui il ciclo dipende da `GITHUB_PAT_NANAKO` in
 *    Remote Config, e `alert-pat-down.mjs` / `gh-pat-expiry-monitor.yml` aprono
 *    issue che **solo il proprietario può chiudere** (una rotazione di
 *    credenziale non è codice). Peggio: quando quell'alert è acceso il fixer
 *    stesso non ha il PAT, quindi ri-accodarla è futile per costruzione — e la
 *    rotazione è già stata **declinata dal proprietario il 2026-08-18**. È
 *    l'unica classe che questo file esclude in modo esplicito invece di lasciarla
 *    cadere nel default.
 * 3. **Il rilevatore di aggregati.** Il sito ne tiene uno suo
 *    (`AGGREGATE_TITLE_RE`). Qui ne esiste già uno esportato e testato,
 *    `isAggregate()` in `check-issue-already-resolved.mjs`, e la issue #568 dice
 *    che i rilevatori multi-item di questo repo hanno già una copertura
 *    incompleta. Aggiungerne un terzo divergente sarebbe esattamente il difetto
 *    che #568 descrive, e violerebbe il vincolo «una regex duplicata in ≥2 file
 *    va estratta in UN modulo» (AGENTS.md). Quindi si IMPORTA quello che c'è: se
 *    #568 lo migliora, questo pre-pass migliora con lui, gratis.
 * 4. **`FIX_OUTCOME_RE`, per la stessa ragione.** Il gemello del sito se lo
 *    ridefinisce in casa. Qui la stessa regex è già scritta IDENTICA in tre file
 *    (`followup-drainer.mjs`, `handoff-to-site.mjs`,
 *    `close-recovered-failure-issues.mjs`, che è l'unico a esportarla): una
 *    quarta copia renderebbe il drift solo più probabile, quindi si importa
 *    quella esportata. Le altre tre NON si unificano da qui: sono `identical`
 *    nel manifest, e una fix su un file `identical` fatta sul corpus viene
 *    sovrascritta al mirror successivo — quella de-duplicazione è lavoro del
 *    SITO.
 */
import { execFileSync } from 'node:child_process';
import { isAggregate } from './check-issue-already-resolved.mjs';
// Il marker di verdetto ha UNA definizione, non una quinta copia: vedi il punto
// 4 dell'intestazione.
import { FIX_OUTCOME_RE } from './close-recovered-failure-issues.mjs';
// Stessa ragione: l'insieme dei verdetti che questo stadio non può ri-accodare
// da solo vive in UN posto, `followup-drainer.mjs`, che possiede la semantica
// dei verdetti. Importarlo tiene le due letture allineate per costruzione.
// Stessa ragione anche per l'eleggibilità allo scorporo: il predicato che il
// promotore applica a valle (`isDecomposeEligible`) è QUELLO, non una sua
// parafrasi qui. Instradare a `decompose-queued` una issue che il promotore
// rifiuta la fa uscire da `needs-human` senza entrare in nessuna coda: nessuno
// la guarda più, ed è la forma «smette di avanzare in silenzio» (#780).
import { PREPASS_VERDICT_BEATS_FAMILY, isDecomposeEligible } from './followup-drainer.mjs';

const REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
const DRY = process.argv.includes('--dry-run');

/**
 * Lettura di una manopola numerica da `process.env`, con fallback.
 *
 * `Number(env || d)` non basta e il modo in cui non basta e' silenzioso: un
 * valore non numerico (`PREPASS_VERDICT_MAX_AGE_DAYS=30d`, un incolla con uno
 * spazio) da' `NaN`, e ogni confronto con `NaN` e' `false` — cioe' la finestra
 * di validita' non scade MAI e la guardia che questo file esiste per avere
 * diventa codice morto senza una riga di log. E' la stessa forma del difetto
 * dell'item 1 (#815): una guardia disattivata da un input degenere, non da una
 * decisione. Un valore illeggibile torna al default e lo DICE.
 *
 * @param {string|undefined} raw
 * @param {number} fallback
 * @returns {number}
 */
export function posNum(raw, fallback) {
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.log(`::warning::needs-human-prepass: valore non numerico "${raw}" per una manopola → default ${fallback}.`);
    return fallback;
  }
  return n;
}

/**
 * Cap volutamente BASSO, e tarato sulla portata a valle, non sulla dimensione
 * della coda.
 *
 * Misurato il 2026-08-25 su questo repo: 105 PR mergiate in 7 giorni (≈15 al
 * giorno), la stessa portata del sito — quindi vale lo stesso numero, per la
 * stessa ragione: immettere più di ~10 issue al giorno riempirebbe la coda più
 * in fretta di quanto la si svuota, e sopra ~5 PR aperte i merge rallentano da
 * soli. Con 17 `needs-human` e la coda oggi a zero, 10/giorno le fa rientrare
 * tutte in due giorni.
 */
const MAX_PER_RUN = posNum(process.env.PREPASS_MAX_PER_RUN, 10);
// Cap SEPARATO, non un'esenzione da quello sopra: sono due risorse diverse. Il
// cap di `MAX_PER_RUN` protegge la portata della coda del fixer; una nota non
// instrada niente, scrive un commento e lascia la label dov'e'. Contarle
// insieme farebbe morire di fame proprio le annotazioni, che sono il grosso del
// valore nuovo su una coda di `keep`. Conteggio stampato a parte, e la nota e'
// idempotente (marker riletto dai commenti), quindi a regime il volume e' zero.
const MAX_NOTES_PER_RUN = posNum(process.env.PREPASS_MAX_NOTES_PER_RUN, 10);
// Letture di stato per i blocchi scaduti, per run e su tutte le issue: una
// issue non puo' far esplodere il costo del run nominando quaranta PR.
const MAX_REF_LOOKUPS = posNum(process.env.PREPASS_MAX_REF_LOOKUPS, 40);
// Di quale repo sono i numeri NUDI che questo pre-pass legge. Sul gemello del
// sito vale `'site'` — vedi `matchRegistry`.
const HOME_SCOPE = 'corpus';
// Il repo che ospita `VISION.md`. Stesso default di `needs-human-sweep.yml`.
const SITE_REPO = process.env.SITE_REPO || 'valerielinc-ops/frontaliere-si-o-no';

/**
 * Le famiglie di issue APERTE DA UN MONITOR DI QUESTO REPO, riconosciute sul
 * titolo.
 *
 * Ognuna è un titolo che scrive un nostro script, non una persona: il prefisso è
 * parte del contratto di dedup di chi le apre (il taglio a 60 caratteri sul
 * titolo canonico, `DEDUP_TITLE_PREFIX_LEN` in `scripts/lib/github-issue-creator.mjs`),
 * quindi è stabile e non è un'euristica sul linguaggio.
 *
 * La sorgente di ogni pattern è citata accanto: se un monitor cambia titolo, è
 * lì che si va a guardare.
 */
export const MONITOR_TITLE_PATTERNS = [
  /^Workflow Failure:/i, //           scripts/ci/scan-failed-runs.mjs, .github/workflows/lessons-harvester.yml
  /^CI Failure:/i, //                 famiglia coperta da scripts/ci/close-recovered-failure-issues.mjs
  /^Crawler Failure:/i, //            CRAWLER_FAILURE_TITLE_PREFIX in scripts/lib/github-issue-creator.mjs
  /^follow-up\(#\d+\):/i, //          .github/workflows/post-merge-followup.yml
  /^Watchdog generazione\b/i, //      scripts/ci/scan-generation-health.mjs (globali + per-sezione)
  /^Watchdog news-ticker:/i, //       TITLE in scripts/ci/ticker-shadow-alert.mjs
  /^Roster LLM invecchiato:/i, //     scripts/ci/scan-generation-health.mjs
  /^Loop drift:/i, //                 scripts/ci/loop-drift-check.mjs
  /^gate content su main:/i, //       TITLE in scripts/ci/content-gates-main.mjs
  /^Lockstep engine incagliata:/i, // STALL_ISSUE_TITLE in scripts/ci/lockstep-stall-watch.mjs
];

/**
 * Le famiglie che un monitor apre ma che il ciclo NON può chiudere: rotazione di
 * credenziali. Restano `needs-human` per costruzione, non per omissione.
 *
 * Non basta lasciarle cadere nel default `keep`: sono aperte da un nostro
 * monitor con un prefisso stabile, quindi un domani qualcuno le aggiungerebbe
 * all'allowlist qui sopra ragionando «è un nostro script, quindi è tecnica». Il
 * fatto che il ciclo non possa agirci va scritto, non dedotto.
 */
export const OWNER_ONLY_TITLE_PATTERNS = [
  /^Agent loop down: GITHUB_PAT/i, // PAT_DOWN_TITLE in scripts/ci/alert-pat-down.mjs
  /^GH_PAT expiry warning:/i, //      .github/workflows/gh-pat-expiry-monitor.yml
];

/**
 * Verdetti che il 2026-08-24 hanno smesso di essere blocchi di capacità.
 *
 * `blocked-secrets`: il proprietario ha autorizzato in modo permanente l'uso dei
 * secret (registro in `VISION.md` del sito), e qui `issue-fix.yml` carica Remote
 * Config prima del run Claude (step «Load secrets from Remote Config» →
 * `generator/scripts/load-rc-env.mjs`). Un verdetto emesso prima di quella data
 * descrive una configurazione che non esiste più, quindi la issue è lavoro
 * normale.
 *
 * `blocked-workflows-scope` NON è qui: dipende dal fatto che
 * `GITHUB_PAT_NANAKO` sia stato caricato in QUEL run, che è una condizione
 * runtime e non una decisione superata. Lo valuta il run Claude.
 */
export const STALE_BLOCK_VERDICTS = new Set(['blocked-secrets']);

/**
 * ## Il registro di VISION.md, letto QUI e non solo dal run Claude (#7280)
 *
 * `needs-human-sweep.yml` istruisce il run Claude a «cercare PRIMA una decisione
 * del proprietario già registrata nel registro di VISION.md: se c'è, la issue
 * non è più una domanda — applicala». È corretto, ma quel run è SETTIMANALE, ha
 * cap 15 e costa quota. Questo pre-pass è GIORNALIERO, costa zero e scala — che
 * è testualmente il driver D5 di VISION.md («Allargare il riconoscimento del
 * pre-pass costa zero quota (D4) e scala; un altro run Claude no»).
 *
 * E fino a questa fix il commento che il pre-pass postava affermava «Questa
 * issue non contiene una decisione del proprietario» SENZA averlo verificato:
 * il registro non veniva mai letto da qui.
 *
 * Misurato il 2026-09-05 sul sito: su 42 issue `needs-human`, 11 citano nel
 * corpo un numero su cui il registro ha già deciso — #6404 #6405 #6406 #6407
 * #6408 (→ #6280), #6381 #6382 #6383 (→ #5995), #6357 #6359 (→ #4854), #6761
 * (→ #5705) — ferme da dodici giorni DOPO che la decisione era arrivata.
 *
 * ## La trappola: «cita una riga del registro» NON vuol dire «sbloccala»
 *
 * La riga di #5995 autorizza le leve 1, 3 e 4 e dice a lettere che le leve 2 e
 * 5 «restano BACKLOG, non autorizzate: non aprire lavoro su quelle finché non
 * arriva una decisione dedicata». Una regola ingenua «cita → requeue»
 * riaprirebbe lavoro che il proprietario ha NEGATO: un danno peggiore del non
 * riconoscimento che questa fix ripara. Stessa classe: #5926 è un sì «con
 * vincolo esplicito», #5983 è un NO, #5681 è «NON si fa, per ora».
 *
 * Quindi una riga ha DUE letture, non una:
 *
 *  - **incondizionata** — porta un marcatore affermativo (`SÌ`, `procedi`,
 *    `autorizzat*`) e NESSUN qualificatore fra quelli elencati sotto → il
 *    pre-pass ri-accoda, citando la riga nel commento;
 *  - **condizionata o negativa** — un qualificatore qualsiasi, OPPURE nessun
 *    marcatore affermativo → il pre-pass NON sblocca, ma ALLEGA la riga alla
 *    issue. Il valore resta grande: lo sweep del lunedì non deve più cercarla,
 *    e la issue smette di essere indistinguibile dalle altre 30 del `keep`.
 *
 * L'asimmetria è la stessa dell'allowlist di famiglie qui sopra, e va nella
 * stessa direzione: l'assenza di prova non è prova. Una riga senza marcatore
 * affermativo è «condizionata», mai «incondizionata per default».
 */

/** L'intestazione della sezione-tabella del registro in `VISION.md`. */
export const REGISTRY_HEADING_RE = /^##\s+Decisioni del proprietario gi[àa] prese\b.*$/m;

/**
 * I marcatori che rendono una riga NON applicabile in automatico, con la
 * ragione che finisce nel commento allegato alla issue.
 *
 * Sono FRASI, non la parola «non»: «non solo per questa issue» (riga #5928) è
 * un sì pieno, e un qualificatore su `\bnon\b` lo leggerebbe come condizionato,
 * cioè spegnerebbe il riconoscimento proprio sulle righe più larghe.
 */
export const REGISTRY_QUALIFIERS = [
  [/\bNO\b/, 'decisione negativa'],
  [/\bnon si (fa|fanno|tocca|toccano)\b/i, 'decisione negativa'],
  [/\bnon (si )?stringe(re)?\b/i, 'decisione negativa'],
  [/\bnon autorizzat/i, 'una parte NON è autorizzata'],
  [/\bnon aprire\b/i, 'una parte NON è autorizzata'],
  [/\brestano? BACKLOG\b/i, 'una parte resta a BACKLOG'],
  [/\bsi lasciano stare\b/i, 'famiglia esplicitamente riservata'],
  [/\bdeclinat[oaie]\b/i, 'decisione declinata'],
  [/\bvincol[oi]\b/i, 'autorizzazione con vincolo esplicito'],
  [/\bfinch[éeè]'? non\b/i, 'autorizzazione condizionata nel tempo'],
  [/\bper ora\b/i, 'autorizzazione condizionata nel tempo'],
  [/\bma solo\b/i, 'autorizzazione delimitata'],
  [/\bsoltanto\b/i, 'autorizzazione delimitata'],
  [/\b(delimitat|limitat)[oaie]\b/i, 'autorizzazione delimitata'],
  [/\beccezione\b/i, 'autorizzazione delimitata'],
  [/\bopzione [A-Z]\b/, 'la riga sceglie fra opzioni, non autorizza in blocco'],
  [/\bsalvo\b/i, 'autorizzazione con eccezione'],
  [/\bpurch[éeè]\b/i, 'autorizzazione condizionata'],
  [/\ba condizione\b/i, 'autorizzazione condizionata'],
  [/\bmai\b/i, 'divieto esplicito nella stessa riga'],
];

/**
 * Il «sì» affermativo, in due regex e non in una, perché il flag `i` qui è un
 * difetto e non una comodità: `si` è il pronome impersonale italiano e compare
 * dentro OGNI riga negativa del registro («NON **si** fa», «**si** lasciano
 * stare»). Un `/\bsi\b/i` leggerebbe come affermativa esattamente la riga che
 * nega. Il registro scrive il sì in maiuscolo e accentato: `SÌ`.
 *
 * `\b` non serve e non funzionerebbe: in JS `\w` è ASCII, quindi `Ì` è un
 * non-word char e `/\bSÌ\b/` non aggancia mai la virgola che segue. I lookaround
 * su `\p{L}` fanno il lavoro giusto con il flag `u`.
 */
const REGISTRY_YES_RE = /(?<![\p{L}])(?:SÌ|SI|sì)(?![\p{L}])/u;
const REGISTRY_AUTHORIZED_RE = /\bprocedi\b|\bautorizzat[oaie]\b/i;

/**
 * La lettura di UNA riga del registro. Pura → testabile sui casi reali.
 * @param {string} text testo della riga (cella Decisione + cella Fonte)
 * @returns {{state: 'unconditional'|'conditional', why: string[]}}
 */
export function registryRowState(text = '') {
  const s = String(text || '');
  const why = REGISTRY_QUALIFIERS.filter(([re]) => re.test(s)).map(([, w]) => w);
  if (why.length) return { state: 'conditional', why: [...new Set(why)] };
  if (REGISTRY_YES_RE.test(s) || REGISTRY_AUTHORIZED_RE.test(s)) {
    return { state: 'unconditional', why: [] };
  }
  return { state: 'conditional', why: ['nessun marcatore affermativo: il pre-pass non deduce un sì dal silenzio'] };
}

/**
 * I riferimenti `#N` citati in un testo, filtrati sul repo che li ospita.
 *
 * Il filtro NON è cosmetico. Il registro vive sul sito e i suoi numeri sono
 * numeri del sito; sul gemello del corpus un `#5995` nudo nel corpo di una sua
 * issue significa `nanakokyobashi-rgb/frontaliere-articles#5995`, che non
 * esiste — leggerlo come la riga del registro sarebbe una collisione di
 * numerazione, non un riconoscimento. Da lì `requireRepo`.
 *
 * @param {string} text
 * @param {{repo?: string, requireRepo?: boolean}} opts repo = `owner/name` del sito
 * @returns {Set<number>}
 */
export function citedRefs(text, { repo = '', requireRepo = false } = {}) {
  const [owner, name] = String(repo || '').split('/');
  const out = new Set();
  // Il `(?<!\.md\s{0,3})` non e' un dettaglio: il registro cita le proprie
  // regole come `AGENTS.md #1` e `AGENTS.md #7`, e senza quel lookbehind la
  // riga del 2026-08-20 entra nel registro come una decisione sulla issue #1 —
  // cioe' un numero bassissimo che qualunque corpo puo' nominare per caso.
  for (const m of String(text || '').matchAll(/(?<!\.md\s{0,3})(?:([A-Za-z0-9][\w.-]*)(?:\/([\w.-]+))?)?#(\d+)\b/g)) {
    const o = m[1] || null;
    const n = m[2] || null;
    if (o) {
      if (o !== owner || (n && n !== name)) continue; // riferimento a un terzo repo
    } else if (requireRepo) {
      continue; // numero nudo su un repo diverso da quello del registro
    }
    out.add(Number(m[3]));
  }
  return out;
}

/**
 * Le righe della tabella «Decisioni del proprietario già prese» di `VISION.md`.
 *
 * Parsing a righe e non con un parser Markdown per la stessa ragione per cui
 * `needs-human-prepass-sparse-closure.test.ts` non usa un parser YAML: è
 * l'unico consumatore, gli script del ciclo sono zero-dep, e una dipendenza
 * npm qui morirebbe comunque — il job `prepass` NON esegue `npm ci`.
 *
 * @param {string} md
 * @returns {Array<{date: string, decision: string, source: string, refs: number[],
 *                  state: 'unconditional'|'conditional', why: string[]}>}
 */
export function parseVisionRegistry(md = '') {
  const text = String(md || '');
  const head = REGISTRY_HEADING_RE.exec(text);
  if (!head) return [];
  const rest = text.slice(head.index + head[0].length);
  const end = /\n## /.exec(rest);
  const table = end ? rest.slice(0, end.index) : rest;

  const rows = [];
  for (const raw of table.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.length < 3) continue;
    const [date, decision, ...restCells] = cells;
    if (/^[-:\s]+$/.test(date) || date === 'Data') continue; // separatore / intestazione
    const source = restCells.join(' | ');
    const body = `${decision} | ${source}`;
    const refs = [...citedRefs(body)];
    if (!refs.length) continue; // una riga che non nomina nessuna issue non è agganciabile
    rows.push({ date, decision, source, refs, scope: registryRowScope(body), ...registryRowState(body) });
  }
  return rows;
}

/** I due repo del ciclo, per disambiguare la numerazione dei riferimenti. */
export const REPO_SLUGS = {
  site: 'valerielinc-ops/frontaliere-si-o-no',
  corpus: 'nanakokyobashi-rgb/frontaliere-articles',
};

/**
 * Di QUALE repo sono i numeri di una riga del registro.
 *
 * `VISION.md` sta sul sito ma è il registro del ciclo INTERO: le righe del
 * 2026-09-05 decidono su #727, #728, #814, #621, #625, #787, #804, #832 — che
 * sono numeri del CORPUS. Senza questo campo una issue del sito che nomina
 * `#814` per tutt'altra ragione aggancerebbe una decisione che non la riguarda:
 * i due repo condividono lo spazio dei numeri bassi e non c'è niente nel numero
 * che dica a quale appartiene.
 *
 * La prova che il registro dà è la parola: chi scrive una riga sul corpus lo
 * dice («…, corpus», «Cinque issue del corpus»). È volutamente grossolano nella
 * direzione sicura — una riga del sito che NOMINA il corpus viene letta come
 * corpus-scoped e quindi non sblocca sul sito: un `keep` in più, mai un
 * `requeue` sbagliato.
 */
export function registryRowScope(text = '') {
  return /\bcorpus\b|\bnanako/i.test(String(text || '')) ? 'corpus' : 'site';
}

/**
 * Le righe del registro che riguardano i riferimenti citati da una issue.
 *
 * `homeScope` dice in quale repo gira il pre-pass: lì un `#N` NUDO è un numero
 * di casa, mentre i numeri dell'altro repo contano solo se il corpo li ha
 * qualificati (`valerielinc-ops/frontaliere-si-o-no#6023`). È la stessa
 * asimmetria che GitHub applica quando risolve il link.
 *
 * @returns {{unconditional: Array<object>, conditional: Array<object>, refs: number[]}}
 */
export function matchRegistry(text, rows = [], { homeScope = 'site' } = {}) {
  const away = homeScope === 'site' ? 'corpus' : 'site';
  const home = citedRefs(text, { repo: REPO_SLUGS[homeScope] });
  const foreign = citedRefs(text, { repo: REPO_SLUGS[away], requireRepo: true });
  const seen = (r) => (r.scope === homeScope ? home : foreign);
  const hits = (rows || []).filter((r) => r.refs.some((n) => seen(r).has(n)));
  return {
    unconditional: hits.filter((r) => r.state === 'unconditional'),
    conditional: hits.filter((r) => r.state === 'conditional'),
    refs: [...new Set(hits.flatMap((r) => r.refs.filter((n) => seen(r).has(n))))].sort((a, b) => a - b),
  };
}

/**
 * ## Secondo meccanismo: i blocchi che scadono in silenzio
 *
 * Trovate il 2026-09-05 due issue del corpus ferme su un blocco che non
 * esisteva più: nanako#471 era `blocked` su `valerielinc-ops#6023`, MERGIATA il
 * 2026-08-18 — diciotto giorni oltre la fine del suo blocco; nanako#714
 * attendeva un probe il cui workflow risponde 404, cioè una prova che nessuno
 * avrebbe più prodotto. Il primo caso è verificabile a costo zero.
 *
 * La granularità è la SEZIONE e non la riga, perché il blocco non è scritto in
 * una grammatica: su nanako#471 la parola sta nel titolo di sezione
 * (`## 1. … — blocked su PR esterna aperta`) e il riferimento tre paragrafi
 * sotto. Una regex sulla riga non lo vedrebbe.
 *
 * Ed è proprio per questa imprecisione che il meccanismo ANNOTA e non sblocca:
 * vedi la nota su `prepassDecision`.
 */
export function blockedRefs(body = '', { homeScope = 'site' } = {}) {
  const text = String(body || '');
  if (!/\bblocked\b/i.test(text)) return [];
  const home = REPO_SLUGS[homeScope];
  const away = REPO_SLUGS[homeScope === 'site' ? 'corpus' : 'site'];
  const out = new Map();
  const collect = (chunk) => {
    for (const m of chunk.matchAll(/(?<!\.md\s{0,3})(?:([A-Za-z0-9][\w.-]*)(?:\/([\w.-]+))?)?#(\d+)\b/g)) {
      const owner = m[1] || null;
      let repo = home;
      if (owner) {
        const slug = [home, away].find((r) => r.split('/')[0] === owner
          && (!m[2] || r.split('/')[1] === m[2]));
        if (!slug) continue; // un terzo repo: non è roba di questo ciclo
        repo = slug;
      }
      const key = `${repo}#${m[3]}`;
      if (!out.has(key)) out.set(key, { repo, number: Number(m[3]), key });
    }
  };
  // Le sezioni sono delimitate dalle intestazioni Markdown, e l'intestazione va
  // guardata anche da sola: su nanako#471 la parola `blocked` sta LÌ
  // (`## 1. … — blocked su PR esterna aperta`) e il riferimento nel corpo sotto.
  const headings = text.match(/^#{1,6} .*$/gm) || [];
  const sections = text.split(/^#{1,6} .*$/m);
  for (let i = 0; i < sections.length; i++) {
    const heading = i > 0 ? headings[i - 1] : '';
    if (/\bblocked\b/i.test(`${heading}\n${sections[i]}`)) collect(`${heading}\n${sections[i]}`);
  }
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Il marker di idempotenza del commento. Il pre-pass è stateless per
 * costruzione (zero-Claude, nessun artifact, solo il `GITHUB_TOKEN` del cron):
 * la sola memoria disponibile è quella che si scrive dove la si rilegge, cioè i
 * commenti della issue — che vengono GIÀ letti per il verdetto, quindi zero
 * chiamate in più. Porta dentro i riferimenti, così una riga di registro NUOVA
 * su una issue già annotata riapre bocca una volta sola.
 */
export function noteMarker(reg, staleBlocks = []) {
  const parts = [];
  if (reg && reg.refs.length) parts.push(`r=${reg.refs.join(',')}`);
  if (staleBlocks.length) parts.push(`b=${staleBlocks.map((s) => s.key).join(',')}`);
  return parts.length ? `<!-- PREPASS_NOTE: ${parts.join(' ')} -->` : null;
}

/**
 * Il commento da allegare alla issue: la riga del registro che la riguarda, e i
 * blocchi che il corpo dichiara ma che sono già finiti.
 *
 * Vale anche — anzi soprattutto — quando l'azione resta `keep`: un'issue con la
 * riga allegata non è più indistinguibile dalle altre trenta del `keep`, e lo
 * sweep del lunedì non paga più il costo di cercarla. Pura → testabile.
 */
export function prepassNote(reg, staleBlocks = []) {
  const rows = [...((reg && reg.unconditional) || []), ...((reg && reg.conditional) || [])];
  if (!rows.length && !staleBlocks.length) return null;
  const out = [];

  if (rows.length) {
    out.push('📓 **Registro di `VISION.md`: la decisione che riguarda questa issue esiste già.**', '');
    out.push(
      'Il pre-pass deterministico (zero-Claude, giornaliero) ha agganciato i riferimenti citati '
      + 'nel corpo alle righe del registro «Decisioni del proprietario già prese». Sono qui, '
      + 'trascritte: non vanno più cercate.',
      '',
    );
    out.push('| Data | Decisione registrata | Lettura del pre-pass |');
    out.push('|---|---|---|');
    for (const r of rows) {
      const cell = r.decision.replace(/\|/g, '\\|');
      const read = r.state === 'unconditional'
        ? '✅ **incondizionata** — nessun qualificatore'
        : `⚠️ **condizionata o negativa** — ${r.why.join('; ')}`;
      out.push(`| ${r.date} | ${cell} | ${read} |`);
    }
    out.push('');
    if (reg.conditional.length) {
      out.push(
        '⚠️ Almeno una riga è condizionata o negativa, quindi il pre-pass **non sblocca**. '
        + 'Una regola «cita una riga registrata → rimetti in coda» riaprirebbe lavoro che il '
        + 'proprietario ha delimitato o negato — il danno peggiore di quello che ripara. '
        + 'Chi lavora questa issue resta dentro i limiti scritti nella riga.',
      );
    }
  }

  if (staleBlocks.length) {
    if (out.length) out.push('');
    out.push('⏱️ **Blocco scaduto.** Il corpo dichiara un blocco e nomina riferimenti che oggi risultano chiusi:', '');
    for (const b of staleBlocks) out.push(`- ${b.link} — **${b.state}** il ${b.at}`);
    out.push(
      '',
      'Il pre-pass **non toglie `needs-human` d\'ufficio** su questo segnale, e la ragione è la '
      + 'grammatica: un blocco non è scritto in una forma contrattuale. Su nanako#471 la parola '
      + '`blocked` sta in un titolo di sezione e il riferimento tre paragrafi sotto, mentre altre '
      + 'sezioni della stessa issue dichiarano blocchi SENZA nominare nulla. Il pre-pass può quindi '
      + 'provare che *un* riferimento citato è chiuso, mai che fosse l\'unica causa — e sbloccare su '
      + 'quella prova parziale sarebbe la versione «blocchi» dello sblocco cieco sul registro. '
      + 'Quello che qui costa zero è la MISURA, ed è quella che manca allo sweep: la classe C del '
      + 'suo prompt («claim scaduta») chiede la misura più economica che decide, e ora ce l\'ha già '
      + 'scritta sotto gli occhi.',
    );
  }
  return out.join('\n');
}


/**
 * Il registro, recuperato dal SITO.
 *
 * ADATTAMENTO — è l'unico punto che diverge davvero dal gemello, e la
 * divergenza è deliberata: `VISION.md` NON è duplicato in questo repo e non
 * deve esserlo. È sorgente unica sul sito, e una copia locale divergerebbe in
 * silenzio — esattamente il modo di rompersi che `loop-drift-check` esiste per
 * intercettare. Il comando è lo STESSO che `needs-human-sweep.yml` già usa nel
 * prompt del run Claude (`gh api repos/$SITE_REPO/contents/VISION.md --jq
 * .content | base64 -d`): entrambi i repo sono pubblici, quindi al
 * `GITHUB_TOKEN` del run basta e non serve il PAT.
 *
 * Fail-open, e va detto perché non è pigrizia: senza registro il pre-pass torna
 * ESATTAMENTE al comportamento precedente, mentre un'eccezione lo farebbe
 * morire prima di `main()`. Peggio del non-riconoscimento c'è solo un pre-pass
 * che smette di girare — già successo su questo stesso job, che moriva a ogni
 * run con `ERR_MODULE_NOT_FOUND` per una cartella fuori dal checkout sparse
 * (`generator/tests/needs-human-prepass-sparse-closure.test.mjs`).
 */
export function readVisionRegistry() {
  try {
    const b64 = gh(['api', `repos/${SITE_REPO}/contents/VISION.md`, '--jq', '.content'], { json: false });
    const md = Buffer.from(String(b64).replace(/\s+/g, ''), 'base64').toString('utf8');
    const rows = parseVisionRegistry(md);
    if (!rows.length) console.log(`::warning::needs-human-prepass: VISION.md di ${SITE_REPO} letto ma senza righe di registro riconosciute → riconoscimento disattivato per questo run.`);
    return rows;
  } catch (e) {
    console.log(`::warning::needs-human-prepass: VISION.md di ${SITE_REPO} non recuperabile (${String(e).slice(0, 120)}) → riconoscimento del registro disattivato per questo run.`);
    return [];
  }
}

/**
 * Finestra di validità del verdetto, in giorni.
 *
 * Il ramo `PREPASS_VERDICT_BEATS_FAMILY` tratta il verdetto come vincolante:
 * senza un bound, un `max-turns` di settimane fa tiene la issue in `keep` PER
 * SEMPRE anche quando la causa a monte è cambiata da un pezzo (crawler rimesso
 * a posto, workflow riscritto). L'unica uscita rimasta sarebbe lo sweep
 * settimanale, che ha un cap di azioni per run — cioè di nuovo uno stato
 * assorbente, che è esattamente il difetto che questo file esiste per chiudere.
 *
 * 30 giorni perché è ~4 giri dello sweep settimanale: abbastanza da non
 * ri-accodare un verdetto ancora fresco (il loop misurato sul sito si
 * riproduceva nel giro di GIORNI), abbastanza poco da non superare un mese di
 * immobilità. Scaduto il termine il verdetto non viene cancellato: smette solo
 * di essere vincolante, e la issue torna a valere quanto la sua famiglia — un
 * run del fixer, che è l'errore economico giusto rispetto all'immobilità.
 */
export const VERDICT_MAX_AGE_DAYS = posNum(process.env.PREPASS_VERDICT_MAX_AGE_DAYS, 30);

/**
 * Soglia oltre la quale una run coi lookup del verdetto falliti smette di
 * somigliare a una run normale (#815, item 2).
 *
 * La guardia `verdictLookupFailed` e' per-issue e degrada bene su un fallimento
 * SPORADICO (un secondary rate-limit su qualche lettura): ogni issue diventa un
 * `keep` conservativo, ed e' la direzione giusta. Ma su un fallimento
 * SISTEMATICO — PAT scaduto, permessi revocati, API down — il degrado non e'
 * parziale: ogni lettura fallisce, TUTTE le issue diventano `keep`, lo script
 * esce 0, e il riassunto finale (`requeue=0 decompose=0 keep=17`) e' quello di
 * una run in cui non c'era semplicemente niente da fare. Cioe' l'unica porta di
 * rientro da `needs-human` puo' essere chiusa per settimane senza che nulla
 * fallisca: la stessa forma del difetto che questo file esiste per chiudere,
 * un piano piu' in su.
 *
 * Rapporto E minimo assoluto: il solo rapporto renderebbe rosso un repo con una
 * sola issue `needs-human` e un singolo 502 di rete, che e' rumore.
 */
export const LOOKUP_FAILURE_MAX_RATIO = posNum(process.env.PREPASS_LOOKUP_FAILURE_MAX_RATIO, 0.5);
export const LOOKUP_FAILURE_MIN_COUNT = posNum(process.env.PREPASS_LOOKUP_FAILURE_MIN_COUNT, 3);

/**
 * La run e' degradata al punto da non essere piu' interpretabile? Pura.
 * @param {number} failed  lookup falliti
 * @param {number} attempted  lookup tentati
 * @returns {boolean}
 */
export function isLookupDegraded(failed, attempted) {
  if (attempted <= 0) return false;
  return failed >= LOOKUP_FAILURE_MIN_COUNT && failed / attempted >= LOOKUP_FAILURE_MAX_RATIO;
}

/**
 * Il marker che il pre-pass lascia sul commento con cui ri-accoda una issue
 * PERCHE' il verdetto e' scaduto (o non e' databile).
 *
 * E' HTML comment, quindi invisibile a chi legge la issue, e non e' un
 * `FIX_OUTCOME`: questo stadio non emette verdetti, conta i propri giri. Serve
 * perche' il contatore dei cicli non ha nessun altro posto dove stare — il
 * pre-pass e' stateless per costruzione (zero-Claude, nessun artifact, gira dal
 * cron con il solo `GITHUB_TOKEN`), e la memoria disponibile e' quella che si
 * scrive dove la si rilegge: i commenti della issue, che vengono gia' letti per
 * il verdetto. Zero chiamate in piu'.
 */
export const PREPASS_EXPIRY_MARKER = '<!-- PREPASS_EXPIRY_REQUEUE -->';

/**
 * Quanti cicli scadenza→requeue prima di smettere (#815, item 3).
 *
 * 3 giri sono ~90 giorni con la finestra di default: abbastanza da coprire il
 * caso vero per cui la finestra esiste (la causa a monte E' cambiata e il
 * verdetto descrive un mondo che non c'e' piu'), e abbastanza pochi da non far
 * girare un'oscillazione mensile per un anno prima che qualcuno se ne accorga.
 * Il terzo tentativo che fallisce come i primi due non e' un'ipotesi nuova.
 */
export const EXPIRY_REQUEUE_MAX_CYCLES = posNum(process.env.PREPASS_EXPIRY_REQUEUE_MAX_CYCLES, 3);

/**
 * Quante volte questo stadio ha gia' ri-accodato la issue per scadenza del
 * verdetto, contate sui suoi stessi commenti. Pura.
 * @param {Array<{body?: string}>} comments
 * @returns {number}
 */
export function countExpiryRequeues(comments) {
  let n = 0;
  for (const c of comments || []) if (String(c?.body || '').includes(PREPASS_EXPIRY_MARKER)) n++;
  return n;
}

/**
 * Ultimo verdetto + il suo istante, da una lista di commenti (forma REST o
 * GraphQL). Pura. `at` è `null` se il commento non ha una data parsabile — chi
 * legge non deve poter confondere «senza data» con «vecchissimo».
 *
 * Un verdetto SENZA data non viene più scartato (#815, item 1). Scartarlo
 * sembrava conservativo e non lo era: le due forme accettate qui hanno chiavi
 * diverse (`created_at` REST, `createdAt` GraphQL) e nessuna delle due è
 * garantita da un tipo, quindi bastava che una arrivasse senza data perché
 * l'esito tornasse `{null, null}` — cioè «nessun verdetto», che è
 * indistinguibile dal caso in cui davvero nessun fixer è mai passato. Ora il
 * verdetto emerge con `at: null`, e la DECISIONE di che farne sta in un posto
 * solo: `prepassDecision`, che tratta «senza data» come non vincolante.
 *
 * Un verdetto datato batte sempre uno senza data, a qualunque distanza: una
 * data c'è o non c'è, e un `at` inventato per ordinarli sarebbe di nuovo
 * «assente» travestito da «antico». Fra due senza data vince l'ultimo in ordine
 * di lista, che è l'ordine cronologico con cui l'API li restituisce.
 *
 * @param {Array<{body?: string, created_at?: string, createdAt?: string}>} comments
 * @returns {{outcome: string|null, at: number|null}}
 */
export function latestVerdictEntry(comments) {
  let latest = null;
  let latestAt = null;
  let at = -Infinity;
  let undated = null;
  for (const c of comments || []) {
    const m = FIX_OUTCOME_RE.exec(String(c?.body || ''));
    if (!m) continue;
    const t = Date.parse(c?.created_at ?? c?.createdAt);
    if (Number.isNaN(t)) { undated = m[1].toLowerCase(); continue; }
    if (t >= at) { at = t; latest = m[1].toLowerCase(); latestAt = t; }
  }
  if (latest === null && undated !== null) return { outcome: undated, at: null };
  return { outcome: latest, at: latestAt };
}

/** Ultimo verdetto da una lista di commenti (forma REST o GraphQL). Pura. */
export function latestVerdict(comments) {
  return latestVerdictEntry(comments).outcome;
}

/**
 * Il verdetto va letto (una `gh api` per issue) oppure il titolo decide da solo?
 *
 * Pura, così il risparmio è verificabile invece che dedotto dal codice di
 * `main()`.
 *
 * **La famiglia monitor non è più esente**, e senza questa riga il resto della
 * fix non esisterebbe: fino a oggi il verdetto contava solo nel ramo
 * `STALE_BLOCK_VERDICTS`, che `prepassDecision` valuta dopo aver scartato le due
 * famiglie riconosciute sul titolo, quindi pagarlo per quelle era una chiamata
 * buttata. Ora c'è il ramo `PREPASS_VERDICT_BEATS_FAMILY`, che si applica
 * **proprio** ai titoli di famiglia — è il caso che ha prodotto il loop misurato
 * sul sito (`Crawler Failure: Run zurich`/`Run volg`, escalation #7307). Saltare
 * la lettura per loro renderebbe la guardia codice morto esattamente dove serve.
 *
 * Resta esente la sola famiglia owner-only: lì `prepassDecision` ritorna `keep`
 * PRIMA di guardare il verdetto, quindi la lettura non cambierebbe nulla.
 *
 * Il costo aggiunto è una `gh api` PAGINATA sui commenti per ogni issue non
 * owner-only della lista, fino al `--limit 300` di `main()` — e NON «dentro il
 * cap di 10 azioni», che non c'entra: il lookup avviene per ogni issue prima di
 * `prepassDecision`, e le decisioni `keep` fanno `continue` prima ancora che
 * `acted >= MAX_PER_RUN` venga guardato. Il cap limita le MUTAZIONI, non le
 * letture.
 *
 * @param {string} title
 * @returns {boolean} true se serve leggere i commenti
 */
export function needsVerdictLookup(title = '') {
  return !OWNER_ONLY_TITLE_PATTERNS.some((re) => re.test(title));
}

/**
 * La decisione, dal solo titolo + labels + ultimo verdetto. Pura → testabile.
 *
 * `keep` è il default e non un ramo di errore: significa «non so dirlo senza
 * giudizio», e il run Claude dello sweep è il posto dove quel giudizio si dà.
 *
 * Il body NON è un input della decisione di FAMIGLIA, deliberatamente: vedi la
 * nota su `isAggregate` più sotto — misurato il 2026-08-25 che passandoglielo
 * tre issue finivano in `decompose` per la sola parola «batch» capitata nel
 * testo. Quella nota resta valida e non è stata allentata.
 *
 * Dal 2026-09-05 il body entra però nel riconoscimento del REGISTRO, e la
 * distinzione non è un cavillo: lì il corpo non viene interpretato come prosa.
 * Se ne estraggono riferimenti `#N` e si incrociano con una TABELLA, cioè si usa
 * una chiave esterna; e il giudizio su cosa quella riga autorizzi lo dà la
 * RIGA, non il corpo della issue. Il fallimento di `isAggregate` col body era
 * l'opposto: una parola del corpo che decideva da sola.
 *
 * @param {{title?: string, body?: string, labels?: string[], verdict?: string|null,
 *          verdictAt?: number|null, verdictLookupFailed?: boolean,
 *          expiryRequeues?: number, now?: number,
 *          registry?: Array<object>, staleBlocks?: Array<object>, homeScope?: string}} iss
 * @returns {{action: 'requeue'|'decompose'|'keep', reason: string,
 *            expiryRequeue?: boolean, note?: string, marker?: string}}
 */
export function prepassDecision({
  title = '', body = '', labels = [], verdict = null, verdictAt = null,
  verdictLookupFailed = false, expiryRequeues = 0, now = Date.now(),
  registry = [], staleBlocks = [], homeScope = HOME_SCOPE,
} = {}) {
  const reg = matchRegistry(`${title}\n${body}`, registry, { homeScope });
  const d = decideAction({ title, labels, verdict, verdictAt, verdictLookupFailed, expiryRequeues, now, reg });
  // Un tracker permanente non si annota: il solo che porta `agent:no-age-out` è
  // il digest dello sweep, il cui CORPO viene riscritto ogni settimana con
  // l'elenco delle domande aperte. I riferimenti citati cambierebbero ogni
  // volta, quindi cambierebbe il marker di idempotenza e la nota diventerebbe
  // un commento settimanale sull'unica issue che nessuno vuole più rumorosa.
  const note = labels.includes('agent:no-age-out') ? null : prepassNote(reg, staleBlocks);
  return note ? { ...d, note, marker: noteMarker(reg, staleBlocks) } : d;
}

/** Il ramo che sceglie l'azione. Separato dal wrapper solo per tenerlo puro. */
function decideAction({
  title = '', labels = [], verdict = null, verdictAt = null,
  verdictLookupFailed = false, expiryRequeues = 0, now = Date.now(), reg,
} = {}) {
  // Un tracker permanente è aperto per scelta: non si accoda e non si scorpora.
  if (labels.includes('agent:no-age-out')) return { action: 'keep', reason: 'tracker permanente' };
  // Già in volo da qualche parte: non si tocca.
  for (const l of ['agent:fix', 'agent:fix-queued', 'agent:decompose', 'agent:decompose-queued', 'agent:in-progress']) {
    if (labels.includes(l)) return { action: 'keep', reason: `già in lavorazione (${l})` };
  }

  // PRIMA del verdetto: una rotazione di credenziale resta del proprietario
  // qualunque cosa un fixer abbia registrato passando di lì.
  const ownerOnly = OWNER_ONLY_TITLE_PATTERNS.find((re) => re.test(title));
  if (ownerOnly) {
    return { action: 'keep', reason: 'famiglia credenziali: la chiude solo il proprietario (rotazione declinata il 2026-08-18)' };
  }

  // Lookup del verdetto fallito ≠ nessun verdetto. Su secondary rate-limit ogni
  // lettura torna vuota, e senza questa riga la famiglia decide `requeue`
  // esattamente come prima che la guardia sul verdetto esistesse: il loop che
  // #778 ha chiuso si riapre, e per un motivo che non compare da nessuna parte.
  // `keep` è il default onesto — «non so dirlo» — e costa un giro di sweep, non
  // un run del fixer che riproduce un verdetto già pagato.
  if (verdictLookupFailed) {
    return { action: 'keep', reason: 'verdetto non leggibile (lookup fallito): nessuna decisione su un input mancante' };
  }

  // Il registro di `VISION.md` batte il «famiglia non riconosciuta → keep» qui
  // sotto: una issue che cita una riga INCONDIZIONATA non è più una domanda per
  // il proprietario — è lavoro normale, e la sua porta non deve essere un run
  // Claude settimanale con cap 15 (VISION.md D5).
  //
  // Serve che TUTTE le righe agganciate siano incondizionate, non che ne esista
  // una. Un corpo che cita sia #6280 (sì pieno) sia #5995 (leve 2 e 5 «non
  // autorizzate: non aprire lavoro su quelle») descrive un lavoro a cavallo dei
  // due, e nel dubbio non si sblocca: `keep` costa un giro di sweep, il
  // ri-accodo sbagliato fa implementare al fixer una scelta NEGATA.
  //
  // Sta DOPO `ownerOnly` e `verdictLookupFailed` di proposito: una rotazione di
  // credenziale resta del proprietario qualunque cosa dica il registro, e su un
  // input non letto non si decide niente. E non batte
  // `PREPASS_VERDICT_BEATS_FAMILY` — `max-turns`/`no-root-cause` dicono che
  // l'ultima run è morta per una ragione che il ri-accodo non cambia, e una
  // decisione del proprietario non rende quella run più corta.
  if (reg && reg.unconditional.length && !reg.conditional.length
      && !(verdict && PREPASS_VERDICT_BEATS_FAMILY.has(verdict))) {
    const r = reg.unconditional[0];
    const cited = reg.refs.map((n) => `#${n}`).join(' ');
    return {
      action: 'requeue',
      reason: `il registro di \`VISION.md\` (${SITE_REPO}) ha già deciso il ${r.date} sui riferimenti citati nel corpo (${cited}), con una riga incondizionata (nessun qualificatore): non è più una domanda per il proprietario`,
    };
  }

  if (verdict && STALE_BLOCK_VERDICTS.has(verdict)) {
    return { action: 'requeue', reason: `verdetto \`${verdict}\` superato dalla decisione del 2026-08-24 sui secret` };
  }

  const monitor = MONITOR_TITLE_PATTERNS.find((re) => re.test(title));
  if (!monitor) return { action: 'keep', reason: 'famiglia non riconosciuta: la valuta il run Claude' };

  // Un container con più target si scorpora: ri-accodarlo intero è il modo
  // documentato di rifare `max-turns`. Il rilevatore è quello CONDIVISO di
  // `check-issue-already-resolved.mjs` — vedi l'intestazione, punto 3.
  //
  // Gli si passa il SOLO TITOLO, e non è un dettaglio: il suo fallback a parole
  // chiave (`sweep|batch|bulk`) esiste per gli aggregati che non dichiarano un
  // conteggio *nel titolo* («Sweep: ~30 crawlers»), e su un body lungo diventa
  // un falso positivo. Misurato il 2026-08-25 sulle 17 `needs-human` di questo
  // repo: passando anche il body, TRE issue finivano in `decompose` per la sola
  // parola «batch» capitata nel testo — #170 «Workflow Failure: Post-merge
  // follow-up triage» (662 caratteri, un singolo guasto), #407 e #403 (~4.700
  // caratteri l'una). Nessuna delle tre dichiarava un conteggio di item.
  //
  // Col titolo soltanto quelle tre tornano `requeue`, ed è la direzione giusta
  // dell'errore: un aggregato non riconosciuto viene semplicemente lavorato dal
  // fixer normale, mentre uno scorporo inventato brucia un run di decomposizione
  // e crea sub-issue che non corrispondono a niente. Che i titoli multi-item di
  // QUESTO repo («A + B + C») sfuggano al rilevatore è noto ed è precisamente
  // l'oggetto della issue #568: quando quella si chiude, questo pre-pass ne
  // eredita il miglioramento senza modifiche, ed è il motivo per cui il
  // rilevatore è importato invece che riscritto.
  //
  // Lo scorporo si propone solo se il promotore a valle lo accetterebbe: il
  // predicato è il SUO (`isDecomposeEligible`), importato e non riscritto. Le
  // label che lo escludono (`decomposed:1`, `from-decompose`, `maybe-resolved`)
  // non sono visibili da qui come «già in lavorazione» — quelle sono filtrate
  // sopra — quindi senza questa guardia il pre-pass toglieva `needs-human` e
  // metteva `agent:decompose-queued` su una issue che il promotore rifiuta: via
  // dallo stato assorbente, dentro a nessuna coda. `keep` invece della fall-
  // through a `requeue` perché ri-accodare intero un container multi-item è il
  // modo documentato di rifare `max-turns`: se lo scorporo è precluso, la
  // decisione è di giudizio e la prende il run Claude dello sweep.
  if (isAggregate(title, '')) {
    if (!isDecomposeEligible({ labels: labels.map((name) => ({ name })) })) {
      const blocking = labels.filter((l) => ['decomposed:1', 'from-decompose', 'maybe-resolved'].includes(l));
      return {
        action: 'keep',
        reason: `container multi-item ma NON scorporabile a valle${blocking.length ? ` (${blocking.join(', ')})` : ''}: il promotore lo rifiuterebbe`,
      };
    }
    return { action: 'decompose', reason: 'container multi-item generato da un monitor' };
  }
  // Il verdetto batte il riconoscimento di famiglia — ma SOLO il `requeue`, ed è
  // per questo che sta qui sotto e non prima dello scorporo.
  //
  // Questa guardia non era mai scesa su questa metà: il gemello del sito ce l'ha
  // dal #5608, dove il loop è stato misurato (`PostHog Exception:` →
  // `no-root-cause` → re-accodo di questo pre-pass il giorno dopo → stesso
  // verdetto, tre volte in tre run), e qui il file è `adapted`, che il drift
  // check non confronta. Senza, un'issue di famiglia monitor già chiusa da un
  // verdetto tornava in coda a costo zero per riprodurlo.
  //
  // L'insieme è `NON_RETRYABLE` più `max-turns` (site #7313, escalation #7307).
  // Il criterio non è «il verdetto è definitivo» ma «questo stadio sa cambiare
  // qualcosa prima di rimettere in coda?». Ed è esattamente il criterio che
  // impone la POSIZIONE: lo scorporo qui sopra **cambia** l'input del fixer come
  // lo cambia la scheda dello sweep — è il ramo che il drainer stesso sceglie su
  // `max-turns` (DECOMPOSE-ROUTE) e che il commento sopra `isAggregate` chiama
  // «il modo documentato di rifare max-turns» se lo si salta. Mettere la guardia
  // prima gliela toglieva, trasformando in `keep` un container che aveva
  // un'uscita buona (🔴 della review di questa PR). Qui sotto intercetta il solo
  // ri-accodo intero, che è l'unica azione che non cambia niente.
  //
  // …e solo finché il verdetto è RECENTE (vedi `VERDICT_MAX_AGE_DAYS`): un
  // verdetto scaduto descrive un mondo che non c'è più, e trattarlo come
  // vincolante trasforma questo ramo in un secondo stato assorbente.
  if (verdict && PREPASS_VERDICT_BEATS_FAMILY.has(verdict)) {
    // «Senza data» non è «fresco» (#815, item 1). Il ramo che vincolava era
    // `ageMs == null → expired = false`: un verdetto di cui non si conosce
    // l'istante teneva la issue in `keep` PER SEMPRE, che è esattamente lo stato
    // assorbente che la finestra di validità esiste per chiudere — e con l'unico
    // segnale possibile, l'immobilità della issue. La finestra è un bound
    // sull'ETÀ: se l'età non è calcolabile, il bound non è dimostrabile, e un
    // vincolo indimostrabile non si applica. Non-vincolante ≠ verdetto
    // cancellato: la ragione lo dice, così la scelta è leggibile nel commento
    // che il pre-pass lascia sulla issue invece di essere dedotta dal silenzio.
    const ageMs = verdictAt == null ? null : now - verdictAt;
    if (ageMs == null) {
      return {
        action: 'requeue',
        expiryRequeue: true,
        reason: `famiglia di monitor riconosciuta (${monitor}), verdetto \`${verdict}\` SENZA data leggibile: non databile ⇒ non vincolante (la finestra di ${VERDICT_MAX_AGE_DAYS}g non è verificabile)`,
      };
    }
    if (ageMs <= VERDICT_MAX_AGE_DAYS * 86400000) {
      return { action: 'keep', reason: `verdetto \`${verdict}\` non ri-accodabile a costo zero: resta per il giudizio dello sweep settimanale` };
    }
    // Scaduto — ma la scadenza da sola non accerta che la causa sia cambiata
    // (#815, item 3). Se non lo è, il fixer ri-fallisce, scrive un verdetto
    // fresco, e trenta giorni dopo si ripete: non uno stato assorbente ma
    // un'oscillazione a periodo mensile, che nel riassunto è indistinguibile da
    // un ri-accodo legittimo. Il contatore è il numero di volte che QUESTO ramo
    // ha già instradato la issue (marker `PREPASS_EXPIRY_MARKER` nei suoi stessi
    // commenti): oltre il tetto, il ri-accodo ha smesso di essere un'ipotesi
    // nuova ed è la stessa scommessa persa N volte. Allora si torna a `keep`,
    // cioè al giudizio dello sweep settimanale — che è dove una causa che non
    // cambia da mesi va guardata da qualcuno, non ri-tentata a orologeria.
    if (expiryRequeues >= EXPIRY_REQUEUE_MAX_CYCLES) {
      return {
        action: 'keep',
        reason: `oscillazione scadenza→requeue: ${expiryRequeues} giri già fatti (tetto ${EXPIRY_REQUEUE_MAX_CYCLES}) col verdetto \`${verdict}\` che si riforma ogni volta — la causa a monte non è cambiata, serve il giudizio dello sweep`,
      };
    }
    return {
      action: 'requeue',
      expiryRequeue: true,
      reason: `famiglia di monitor riconosciuta (${monitor}), verdetto \`${verdict}\` scaduto (${Math.floor(ageMs / 86400000)}g > ${VERDICT_MAX_AGE_DAYS}g): non più vincolante — giro ${expiryRequeues + 1}/${EXPIRY_REQUEUE_MAX_CYCLES}`,
    };
  }
  return { action: 'requeue', reason: `famiglia di monitor riconosciuta (${monitor})` };
}

function gh(args, { json = true } = {}) {
  const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return json ? JSON.parse(out) : out;
}

/**
 * Lo stato di un riferimento, con cache e budget. `null` = «non lo so» (aperto,
 * non leggibile, budget esaurito) — mai «non scaduto», che sarebbe la stessa
 * bugia del commento che questa PR toglie.
 */
function makeRefResolver() {
  const cache = new Map();
  return (repo, number) => {
    const key = `${repo}#${number}`;
    if (cache.has(key)) return cache.get(key);
    if (cache.size >= MAX_REF_LOOKUPS) return null;
    let v = null;
    try {
      const o = gh(['api', `repos/${repo}/issues/${number}`]);
      if (o && o.state === 'closed') {
        const merged = o.pull_request && o.pull_request.merged_at;
        v = {
          key,
          link: `${repo}#${number}`,
          state: merged ? 'MERGED' : 'CLOSED',
          at: String(merged || o.closed_at || '').slice(0, 10),
        };
      }
    } catch { v = null; }
    cache.set(key, v);
    return v;
  };
}

function main() {
  if (!REPO) { console.log('needs-human-prepass: nessun repo risolvibile → niente da fare.'); return; }
  const registry = readVisionRegistry();
  let issues = [];
  try {
    issues = gh(['issue', 'list', '--repo', REPO, '--state', 'open', '--label', 'needs-human',
      // `body` entra qui e non con una chiamata per issue: `gh issue list` lo
      // serve nella stessa risposta, quindi il riconoscimento del registro e
      // quello dei blocchi scaduti costano ZERO chiamate in piu' sull'elenco.
      '--json', 'number,title,body,labels,updatedAt', '--limit', '300']);
  } catch (e) {
    console.log(`::warning::needs-human-prepass: elenco non leggibile (${String(e).slice(0, 100)}) → nessuna azione.`);
    return;
  }
  console.log(`needs-human-prepass — repo ${REPO}, ${issues.length} issue \`needs-human\`, registro VISION.md (${SITE_REPO}): ${registry.length} righe${DRY ? ' [DRY-RUN]' : ''}`);

  // Le più stantie prima: sono quelle che aspettano da più tempo, e il cap non
  // deve tagliarle sempre. `gh issue list` ordina dalla più recente.
  const ordered = [...issues].sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));

  const refState = makeRefResolver();
  const counts = { requeue: 0, decompose: 0, keep: 0 };
  let acted = 0;
  let noted = 0;
  let noteCapLogged = false;
  let lookupFailed = 0;
  let lookupAttempted = 0;
  for (const iss of ordered) {
    const labels = (iss.labels || []).map((l) => l.name);
    const body = iss.body || '';
    // Il verdetto costa una lettura: si paga per tutte tranne la famiglia
    // owner-only, l'unica che `prepassDecision` decide prima di guardarlo.
    let verdict = null;
    let verdictAt = null;
    let verdictLookupFailed = false;
    let expiryRequeues = 0;
    let comments = [];
    if (needsVerdictLookup(iss.title)) {
      lookupAttempted++;
      try {
        const cs = gh(['api', `repos/${REPO}/issues/${iss.number}/comments?per_page=100`, '--paginate']);
        comments = Array.isArray(cs) ? cs : [];
        ({ outcome: verdict, at: verdictAt } = latestVerdictEntry(comments));
        // Stessa lettura, nessuna chiamata in piu': i giri di questo stadio
        // stanno nei commenti che abbiamo gia' in mano.
        expiryRequeues = countExpiryRequeues(comments);
      } catch (e) {
        // Un fallimento di lettura NON è «nessun verdetto»: va dichiarato, o su
        // rate-limit l'intera run degrada al comportamento pre-#778 in silenzio.
        verdictLookupFailed = true;
        lookupFailed++;
        console.log(`::warning::needs-human-prepass: #${iss.number} verdetto non leggibile (${String(e).slice(0, 120)}) → keep conservativo.`);
      }
    }
    // I blocchi scaduti si misurano solo dove il corpo ne dichiara uno: su una
    // issue che non nomina mai `blocked` questo costa zero chiamate.
    const staleBlocks = [];
    for (const ref of blockedRefs(body, { homeScope: HOME_SCOPE })) {
      const st = refState(ref.repo, ref.number);
      if (st) staleBlocks.push(st);
    }

    const d = prepassDecision({
      title: iss.title, body, labels, verdict, verdictAt, verdictLookupFailed,
      expiryRequeues, registry, staleBlocks, homeScope: HOME_SCOPE,
    });
    counts[d.action]++;

    const already = d.marker && comments.some((c) => String(c?.body || '').includes(d.marker));

    if (d.action === 'keep') {
      // La nota non consuma `MAX_PER_RUN`: non instrada niente, non tocca le
      // label e non mette pressione sulla coda del fixer, che e' cio' che quel
      // cap protegge. Ha il suo, dichiarato — vedi `MAX_NOTES_PER_RUN`.
      if (!d.note || already) continue;
      if (noted >= MAX_NOTES_PER_RUN) {
        if (!noteCapLogged) {
          console.log(`needs-human-prepass: cap note ${MAX_NOTES_PER_RUN}/run raggiunto → il resto al prossimo giro (no silent cap).`);
          noteCapLogged = true;
        }
        continue;
      }
      noted++;
      if (DRY) { console.log(`[dry] #${iss.number} ✎ nota ${d.marker} — "${iss.title.slice(0, 60)}"`); continue; }
      try {
        gh(['issue', 'comment', String(iss.number), '--repo', REPO, '--body', `${d.note}\n\n${d.marker}`], { json: false });
        console.log(`PREPASS #${iss.number} ✎ nota allegata ${d.marker}`);
      } catch (e) {
        console.log(`::warning::needs-human-prepass: nota non allegata a #${iss.number} (${String(e).slice(0, 100)}).`);
      }
      continue;
    }

    if (acted >= MAX_PER_RUN) {
      console.log(`needs-human-prepass: cap ${MAX_PER_RUN}/run raggiunto → il resto al prossimo giro (no silent cap).`);
      break;
    }
    acted++;
    const add = d.action === 'requeue' ? 'agent:fix-queued' : 'agent:decompose-queued';
    if (DRY) { console.log(`[dry] #${iss.number} → ${add} (${d.reason}) — "${iss.title.slice(0, 60)}"`); continue; }
    // Il marker va SOLO sui ri-accodi per scadenza: e' il contatore dell'item 3,
    // e includerlo nei requeue di famiglia normali lo farebbe contare giri che
    // non sono oscillazioni.
    const mark = d.expiryRequeue ? `\n\n${PREPASS_EXPIRY_MARKER}` : '';
    // La riga che questa PR ripara: prima era `Questa issue non contiene una
    // decisione del proprietario`, affermato SENZA aver letto il registro — che
    // da qui non era mai stato aperto. Ora e' un esito verificato in questo run,
    // e la forma dice quale dei tre casi e'.
    const registryVerdict = registry.length
      ? (d.note ? '' : `Nessuna riga del registro «Decisioni del proprietario già prese» di \`VISION.md\` (${SITE_REPO}, sorgente unica) riguarda i riferimenti citati nel corpo: verificato in questo run, non assunto.`)
      : `Il registro di \`VISION.md\` (${SITE_REPO}) non è stato recuperabile in questo run, quindi il riconoscimento del registro non si è pronunciato (fail-open).`;
    const note = [
      `🔁 **Pre-pass deterministico dello sweep (zero-Claude)**: ${d.reason}. Questa issue torna nel ciclo autonomo invece di occupare un'azione del cap del run Claude settimanale.`,
      registryVerdict,
      already ? '' : d.note,
      already ? '' : d.marker,
    ].filter(Boolean).join('\n\n') + mark;
    try {
      gh(['issue', 'comment', String(iss.number), '--repo', REPO, '--body', note], { json: false });
      gh(['issue', 'edit', String(iss.number), '--repo', REPO,
        '--add-label', add, '--remove-label', 'needs-human', '--remove-label', 'fu-parked'], { json: false });
      console.log(`PREPASS #${iss.number} → ${add} (${d.reason})`);
    } catch (e) {
      console.log(`::warning::needs-human-prepass: #${iss.number} non instradata (${String(e).slice(0, 100)}).`);
    }
  }
  console.log(`needs-human-prepass: requeue=${counts.requeue} decompose=${counts.decompose} keep=${counts.keep} note=${noted} (azioni eseguite: ${acted}, cap ${MAX_PER_RUN}; note cap ${MAX_NOTES_PER_RUN}).`);
  if (lookupFailed) {
    // In cima al riassunto sta il numero, non il dettaglio: una run in cui i
    // verdetti non si leggono NON è una run che ha deciso «nessun verdetto».
    console.log(`::warning::needs-human-prepass: ${lookupFailed}/${lookupAttempted} verdetti non leggibili (rate-limit?) → altrettanti \`keep\` conservativi, non decisioni.`);
  }
  if (isLookupDegraded(lookupFailed, lookupAttempted)) {
    // Riga di riassunto DEDICATA **e** exit non-zero. Il `::warning::` da solo
    // non basta: nessuno guarda i log di un job verde, e il job resterebbe
    // verde. Uscendo ≠ 0 il fallimento risale a `workflow-failure-issues`, che
    // apre `Workflow Failure: Needs-human sweep` — famiglia riconosciuta
    // dall'allowlist qui sopra, quindi la porta chiusa entra da sola nella coda
    // del ciclo invece di aspettare che qualcuno noti l'immobilità.
    //
    // Nessuna mutazione viene persa: una run degradata decide `keep` su ogni
    // issue per costruzione (la guardia `verdictLookupFailed`), quindi non c'è
    // lavoro a metà da proteggere, e il giro successivo del cron ricomincia da
    // capo.
    console.log(`needs-human-prepass: LOOKUP DEGRADATO — ${lookupFailed}/${lookupAttempted} verdetti non leggibili (≥${LOOKUP_FAILURE_MIN_COUNT} e ≥${Math.round(LOOKUP_FAILURE_MAX_RATIO * 100)}%): questa run NON è una run normale, le sue decisioni sono tutte \`keep\` per input mancante.`);
    console.log('::error::needs-human-prepass: credenziale o API dei commenti non utilizzabile → l\'unica porta di rientro da `needs-human` è chiusa. Run marcata rossa apposta: un fallimento sistematico non deve uscire 0.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith('needs-human-prepass.mjs')) main();
