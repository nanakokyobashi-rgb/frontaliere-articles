#!/usr/bin/env node
/**
 * exhaustion-reason-report.mjs — «39-58 modelli esauriti» non era una misura,
 * era una somma di cose diverse.
 *
 * ## Cosa chiedeva la issue #203, e cosa il codice fa GIÀ
 *
 * #203 (2026-08-10) misurava 39-58 modelli marcati esauriti in un solo run su un
 * roster di 101, con `markModelExhausted` che PERSISTE lo stato, e chiedeva due
 * cose: (a) distinguere i motivi, (b) dare una scadenza alla persistenza. La
 * issue dice esplicitamente di non indovinare la fix e di strumentare prima.
 *
 * Rimisurato il 2026-08-13, entrambe risultano GIÀ IMPLEMENTATE in
 * `generator/scripts/lib/ai-models.mjs`:
 *
 *  (a) `_exhaustReason` mappa modelId → `quota` | `timeout` | `content` |
 *      `stale` | `nonretryable`, e `markModelExhausted(modelId, reason)` lo
 *      scrive a ogni marcatura. Il motivo finisce anche nella riga di log.
 *  (b) la persistenza su Firestore (`entry.exhaustedUntil`) è gatata su
 *      `_exhaustReason.get(modelId) === 'quota'`: solo la quota giornaliera
 *      sopravvive al processo, e con scadenza alla mezzanotte UTC successiva.
 *      Timeout / content / nonretryable restano in-process. Un 429 transitorio
 *      quindi NON pesa più come una quota finita — che era il punto della issue.
 *
 * ## Cosa la issue NON poteva vedere, e che questa strumentazione rende visibile
 *
 * I motivi sono distinti nello stato del processo, ma NON sono aggregati da
 * nessuna parte: escono solo come righe di log sparse dentro run da 300-500 KB.
 * «Quanti modelli, per quale motivo» resta una domanda a cui si risponde
 * scaricando i log a mano — che è esattamente il lavoro che #203 chiedeva di non
 * dover rifare ogni volta.
 *
 * Misurato su sei run di `generate-article.yml` del 2026-08-13 (31737586062,
 * 31736592296, 31734876525, 31732061552, 31728613355, 31726656900):
 *
 *   run 31736592296   22 righe   22 modelli distinti   stale=22
 *   run 31728613355   45 righe   23 modelli distinti   stale=44  content=1
 *   run 31726656900   22 righe   22 modelli distinti   stale=22
 *   le altre tre       0 righe    0 modelli
 *
 * Due letture, nessuna delle quali era disponibile prima:
 *
 *  1. **22-23, non 39-58.** Il numero della issue è invecchiato. Il roster non
 *     brucia più metà di sé stesso.
 *  2. **`quota` = 0 su tutte e sei.** Il 100% delle marcature è `stale` — il
 *     pre-esaurimento dei modelli che il provider non offre più (il ramo
 *     `markStale` della discovery), che non è affatto un esaurimento: è un
 *     roster che elenca modelli morti. Non essendo `quota`, non viene persistito
 *     — quindi ogni run rifà lo stesso lavoro e ri-marca gli stessi 22 modelli.
 *     È rumore ricorrente, non avvelenamento dei run successivi.
 *
 * Il rimedio a (2) — potare il roster invece di ri-scoprirlo ogni run — è stato
 * implementato in `generator/scripts/lib/ai-models.mjs` (`_discoverProvider`,
 * il ramo `cfg.markStale`), IN QUESTO REPO: la generazione gira qui, quindi è
 * qui che il rumore si misurava e qui che va tolto. Il `mode` di quel file nel
 * `loop-sync-manifest.json` è `adapted` dal 2026-09-04 (issue #806) e non è
 * un'istruzione di routing: dice che le due copie divergono di proposito — il
 * breaker host-unreachable esiste solo qui (#475, #767) — non su quale lato
 * applicare una fix (vedi generator/tests/generation-health-watchdog.test.mjs
 * §8, che copre esattamente questa confusione per i body di
 * `scan-generation-health.mjs`).
 *
 * ## L'invariante che questo modulo difende
 *
 * `persistencePlan` è la forma esplicita della regola che oggi vive implicita
 * dentro `_persistScoresToFirestore`: **un esaurimento senza un motivo distinto
 * non si persiste mai**. Non «si persiste con cautela»: mai. È l'unica risposta
 * sicura, perché un motivo che non si sa leggere non ha una scadenza nota, e una
 * persistenza senza scadenza nota è indistinguibile da un ban permanente su
 * prove nulle — il difetto che #203 descrive.
 *
 * Zero rete, zero Claude, zero quota: legge testo di log già prodotto.
 *
 * Uso:
 *   node scripts/ci/exhaustion-reason-report.mjs --runs 6
 *   gh run view <id> --log | node scripts/ci/exhaustion-reason-report.mjs --stdin
 *   node scripts/ci/exhaustion-reason-report.mjs --deferral-verdicts --runs 40
 */

import { execFileSync } from 'node:child_process';

import { classifyExhaustionCause } from '../../generator/scripts/lib/ai-models.mjs';
import { isTransientMajority } from '../../generator/scripts/lib/exhaustion-disposition.mjs';

/**
 * La riga che `markModelExhausted` emette:
 *   `🚫 Model <id> marked as exhausted (<reason>) — will be skipped for rest of run`
 * L'id può contenere `/`, `:`, `.`, `-`, quindi si cattura non-greedy fino al
 * letterale che segue.
 */
export const EXHAUSTION_LINE_RE = /Model\s+(\S+?)\s+marked as exhausted\s+\(([^)]*)\)/g;

/**
 * I motivi che `markModelExhausted` sa produrre oggi (ai-models.mjs:
 * `_exhaustReason`). Elenco DICHIARATO qui e non dedotto: è il confronto fra
 * questo elenco e ciò che i log contengono davvero a rendere osservabile un
 * motivo nuovo introdotto senza che nessuno decida come trattarlo.
 */
export const KNOWN_REASONS = Object.freeze(['quota', 'timeout', 'content', 'stale', 'nonretryable']);

/**
 * L'unico motivo che sopravvive al processo. Vedi `_persistScoresToFirestore`:
 * la quota giornaliera è l'unica condizione che dura davvero fino al reset del
 * provider. Le altre descrivono l'esito di UNA chiamata in QUESTO processo.
 */
export const PERSISTED_REASONS = Object.freeze(new Set(['quota']));

/** Mezzanotte UTC successiva a `nowMs` — la scadenza della quota giornaliera. */
export function nextUtcMidnightMs(nowMs) {
  const d = new Date(nowMs);
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * LA REGOLA. Dato un motivo, se e fino a quando l'esaurimento può sopravvivere
 * al processo. Tre verdetti, e nessuno di essi è «per sempre»:
 *
 *   `quota-daily`     persiste, con scadenza alla mezzanotte UTC successiva.
 *   `in-process`      non persiste: vale per il resto del run e basta.
 *   `unknown-reason`  non persiste, ED È UN DIFETTO da segnalare: un motivo che
 *                     non si sa leggere non ha una scadenza nota.
 *
 * `untilMs` è `null` se e solo se `persist` è `false`. Un piano che persiste
 * senza scadenza è la condizione che questo modulo esiste per rendere
 * impossibile — vedi `auditExhaustion`, che la cerca esplicitamente.
 *
 * Pura, `nowMs` iniettato: una scadenza testata contro l'orologio reale è un
 * test che cambia risposta a seconda di quando gira.
 *
 * @param {string} reason
 * @param {number} nowMs
 * @returns {{persist: boolean, untilMs: number|null, verdict: 'quota-daily'|'in-process'|'unknown-reason'}}
 */
export function persistencePlan(reason, nowMs) {
  const r = typeof reason === 'string' ? reason.trim().toLowerCase() : '';
  if (!r || !KNOWN_REASONS.includes(r)) {
    return { persist: false, untilMs: null, verdict: 'unknown-reason' };
  }
  if (PERSISTED_REASONS.has(r)) {
    return { persist: true, untilMs: nextUtcMidnightMs(nowMs), verdict: 'quota-daily' };
  }
  return { persist: false, untilMs: null, verdict: 'in-process' };
}

/**
 * Gli eventi di esaurimento in un testo di log. Ogni occorrenza, non i distinti:
 * la differenza fra righe e modelli distinti è essa stessa un segnale (una
 * discovery che gira due volte marca gli stessi modelli due volte).
 * Pura → testabile.
 * @param {string} text
 * @returns {Array<{model: string, reason: string}>}
 */
export function parseExhaustionEvents(text) {
  const out = [];
  const re = new RegExp(EXHAUSTION_LINE_RE.source, 'g');
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    out.push({ model: m[1], reason: String(m[2] || '').trim().toLowerCase() });
  }
  return out;
}

/**
 * La ripartizione che #203 chiedeva e che nessuno emetteva. Pura → testabile.
 * @param {Array<{model: string, reason: string}>} events
 */
export function summariseExhaustion(events) {
  const list = Array.isArray(events) ? events : [];
  const byReason = {};
  const models = new Set();
  const persistedModels = new Set();
  for (const e of list) {
    byReason[e.reason || '<none>'] = (byReason[e.reason || '<none>'] || 0) + 1;
    models.add(e.model);
    if (PERSISTED_REASONS.has(e.reason)) persistedModels.add(e.model);
  }
  return {
    lines: list.length,
    distinctModels: models.size,
    byReason,
    distinctReasons: Object.keys(byReason).length,
    persistedModels: [...persistedModels].sort(),
  };
}

/**
 * I difetti, non le statistiche. Due classi, entrambe fatali per la fiducia nel
 * dato:
 *
 *   `unknown-reason`          un esaurimento con un motivo che nessuno ha
 *                             dichiarato in `KNOWN_REASONS`. È il caso che #203
 *                             chiama «senza motivo distinto».
 *   `indefinite-persistence`  un piano che persiste senza scadenza. Non può
 *                             accadere con `persistencePlan` così com'è: questa
 *                             condizione è qui perché resti VERIFICATA e non
 *                             solo vera per costruzione — se un giorno qualcuno
 *                             aggiunge un ramo che persiste con `untilMs: null`,
 *                             il difetto ha già il suo osservatore.
 *
 * Pura → testabile.
 * @param {Array<{model: string, reason: string}>} events
 * @param {number} nowMs
 * @returns {Array<{kind: string, model: string, reason: string}>}
 */
export function auditExhaustion(events, nowMs) {
  const findings = [];
  for (const e of Array.isArray(events) ? events : []) {
    const plan = persistencePlan(e.reason, nowMs);
    if (plan.verdict === 'unknown-reason') {
      findings.push({ kind: 'unknown-reason', model: e.model, reason: e.reason || '' });
    }
    if (plan.persist && plan.untilMs === null) {
      findings.push({ kind: 'indefinite-persistence', model: e.model, reason: e.reason || '' });
    }
  }
  return findings;
}

/** I due separatori con cui `callLLM` compone il messaggio aggregato. */
const ERRORS_SEPARATOR = ' | ';
const CHAIN_SEPARATOR = ' → ';

/**
 * ── IL MESSAGGIO AGGREGATO, NON LE RIGHE DI `markModelExhausted` (#854) ─────
 *
 * `callLLM` costruisce l'errore finale come
 * `All AI models failed. Chain: [...]. Errors: <e1> | <e2> | ...` e, quando
 * almeno un modello ha rifiutato sulla TAGLIA, ci appende
 * ` | Prompt budget: N model(s) refused ...`. Quel `<e1> | <e2> | ...` E'
 * l'array `errors` che `classifyExhaustionCause` conta, ricostruibile carattere
 * per carattere: e' l'unico modo di rifare il verdetto di una run passata senza
 * averla eseguita.
 *
 * La coda `Prompt budget:` esce dall'array — non e' una riga di errore, e
 * contarla ne aggiungerebbe una fantasma a ogni run con rifiuti su taglia — ma
 * la sua presenza si conserva: e' `inputCapReport.count > 0`, cioe' la premessa
 * di `isInputCapDeferralVeto`.
 *
 * Pura → testabile.
 *
 * @param {string} text testo di log
 * @returns {Array<{errors: string[], capCount: number}>} una voce per cascata svuotata
 */
export function parseAggregateExhaustion(text) {
  const out = [];
  const re = /All AI models failed\. Chain: \[([^\]]*)\]\. Errors: (.*)$/gm;
  let m;
  while ((m = re.exec(typeof text === 'string' ? text : '')) !== null) {
    const chain = m[1].split(CHAIN_SEPARATOR).map((s) => s.trim()).filter(Boolean);
    const parts = splitErrorEntries(m[2], chain);
    const budget = parts.find((p) => p.startsWith('Prompt budget:'));
    const capMatch = budget && budget.match(/Prompt budget:\s*(\d+) model/);
    out.push({
      errors: parts.filter((p) => !p.startsWith('Prompt budget:')),
      capCount: capMatch ? Number(capMatch[1]) : 0,
    });
  }
  return out;
}

/**
 * ── PERCHE' LO SPLIT NON PUO' ESSERE UNO `split(' | ')` ─────────────────────
 *
 * `callLLM` unisce `errors` con ` | `, ma una delle voci e' testo di provider
 * ripassato tale e quale (`${model}: ${msg.slice(0, 200)}`, ai-models.mjs). Un
 * messaggio che contenga ` | ` si spezza quindi in due voci e gonfia sia
 * `total` sia i secchi di `classifyExhaustionCause` — cioe' proprio i numeri su
 * cui il verdetto lordo/netto viene calibrato. Non e' un difetto di produzione
 * (il messaggio resta leggibile), ma un conteggio gonfio dentro la MISURA e'
 * indistinguibile dal dato vero.
 *
 * Il separatore non e' recuperabile — non esiste una sequenza che il testo di
 * un provider non possa contenere. Cio' che invece e' strutturato, e viaggia
 * nella STESSA riga, e' la catena: `Chain: [m1 → m2 → ...]`. Ogni voce di
 * `errors` comincia per costruzione con `<model>: `, e quel `<model>` e' uno
 * dei modelli della catena (tutte le `errors.push` di `callLLM` hanno quel
 * prefisso). Quindi un frammento che NON comincia con il prefisso di un modello
 * della catena non e' una voce: e' la coda della voce precedente, spezzata da
 * un ` | ` interno, e va ricucita.
 *
 * Se la catena non e' leggibile (gruppo vuoto) si degrada allo split nudo:
 * senza ancore, ricucire tutto in una voce sola sarebbe un errore piu' grande
 * di quello che si vuole evitare.
 *
 * Pura → testabile.
 *
 * @param {string} payload il testo dopo `Errors: `
 * @param {string[]} chainModels i modelli letti da `Chain: [...]`
 * @returns {string[]} le voci di `errors`, piu' l'eventuale coda `Prompt budget:`
 */
export function splitErrorEntries(payload, chainModels) {
  const fragments = String(payload == null ? '' : payload).split(ERRORS_SEPARATOR);
  const models = Array.isArray(chainModels) ? chainModels.filter(Boolean) : [];
  if (!models.length) return fragments;
  const startsEntry = (f) => f.startsWith('Prompt budget:')
    || models.some((model) => f.startsWith(`${model}: `));
  const entries = [];
  for (const f of fragments) {
    if (entries.length && !startsEntry(f)) entries[entries.length - 1] += ERRORS_SEPARATOR + f;
    else entries.push(f);
  }
  return entries;
}

/**
 * I DUE verdetti — LORDO e NETTO — sulla stessa cascata.
 *
 * `gross` riproduce alla lettera il calcolo che i due predicati facevano prima
 * di #856/#857 (`transient > 0 && transient >= persistent` per
 * `transientExhaustion`; `!(transient > persistent)` per il veto): e' il
 * CONTROFATTUALE, e va scritto qui esplicitamente perche' nel codice di
 * produzione non esiste piu'. `net` chiama l'helper vero, quello da cui i due
 * predicati passano oggi.
 *
 * `flip` e' la misura che #854 chiede: la cascata su cui le due aritmetiche
 * NON danno lo stesso esito, cioe' una run in cui togliere gli echi di cooldown
 * cambia l'exit code di produzione.
 *
 * Pura → testabile.
 *
 * @param {{errors: string[], capCount: number}} cascade
 * @returns {{breakdown: object, grossTransient: boolean, netTransient: boolean, grossVeto: boolean, netVeto: boolean, flip: boolean}}
 */
export function deferralVerdicts(cascade) {
  const errors = (cascade && Array.isArray(cascade.errors)) ? cascade.errors : [];
  const capCount = Number(cascade && cascade.capCount) || 0;
  const breakdown = classifyExhaustionCause(errors);
  const grossTransient = breakdown.transient > 0 && breakdown.transient >= breakdown.persistent;
  const netTransient = isTransientMajority(breakdown, { tie: 'transient' });
  // Il veto vive solo dove `callLLM` ha allegato un `inputCapReport`: senza
  // rifiuti su taglia il predicato esce `false` prima di guardare i secchi, e
  // contarlo come «nessun veto» confonderebbe «non si applica» con «si applica
  // e dice no» — cioe' gonfierebbe il denominatore del flip.
  const grossVeto = capCount > 0 && !(breakdown.transient > breakdown.persistent);
  const netVeto = capCount > 0 && !isTransientMajority(breakdown, { tie: 'persistent' });
  return {
    breakdown,
    grossTransient,
    netTransient,
    grossVeto,
    netVeto,
    flip: grossTransient !== netTransient || grossVeto !== netVeto,
  };
}

/** Riga di report per una cascata, LORDO contro NETTO. Pura → testabile. */
export function formatVerdictLine(runId, v) {
  const b = v.breakdown;
  const echo = b.providerCooldownSkips || { total: 0, transient: 0, persistent: 0 };
  const yn = (x) => (x ? 'SI' : 'no');
  return `run ${runId} t=${String(b.transient).padStart(3)} p=${String(b.persistent).padStart(3)} `
    + `tot=${String(b.total).padStart(3)} echi=${echo.total}(t${echo.transient}/p${echo.persistent}) `
    + `transientExhaustion lordo=${yn(v.grossTransient)} netto=${yn(v.netTransient)} `
    + `veto lordo=${yn(v.grossVeto)} netto=${yn(v.netVeto)}`
    + (v.flip ? '  ← FLIP' : '');
}

/** Riga di report per una singola run. Pura → testabile. */
export function formatRunLine(runId, summary) {
  const reasons = Object.entries(summary.byReason)
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${r}=${n}`)
    .join(' ') || '—';
  return `run ${runId}  righe=${String(summary.lines).padStart(3)}  ` +
    `modelli=${String(summary.distinctModels).padStart(3)}  persistiti=${summary.persistedModels.length}  ${reasons}`;
}

// ── CLI (sola lettura) ───────────────────────────────────────────────────────

const repoArgs = process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : [];

/**
 * Quante chiamate a `gh` sono fallite. E' un CONTATORE e non solo una riga su
 * stderr per la stessa ragione di `run-card-report.mjs` (#924 item 3): un log
 * che non si e' riusciti a scaricare si parserizza come «nessuna cascata», cioe'
 * un guasto dello strumento diventa indistinguibile dall'assenza del fenomeno —
 * ed e' esattamente il difetto che questo report esiste per misurare. Il numero
 * viaggia quindi accanto ai totali, dove chi legge il denominatore lo vede.
 */
let ghFailures = 0;

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 128 * 1024 * 1024 });
  } catch (e) {
    ghFailures += 1;
    process.stderr.write(`gh fallita: ${e && e.message ? e.message : e}\n`);
    return '';
  }
}

/** La riga che impedisce di leggere uno zero come un verdetto. */
function ghFailureNote() {
  if (!ghFailures) return null;
  return `⚠️  ${ghFailures} chiamate a \`gh\` fallite: i log non letti si contano come «nessuna cascata»,`
    + ' quindi i numeri qui sopra sono un LIMITE INFERIORE, non una misura.';
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf-8');
}

async function main() {
  const argv = process.argv.slice(2);
  const now = Date.now();

  if (argv.includes('--stdin')) {
    const events = parseExhaustionEvents(await readStdin());
    const summary = summariseExhaustion(events);
    console.log(formatRunLine('<stdin>', summary));
    for (const f of auditExhaustion(events, now)) {
      console.log(`  DIFETTO ${f.kind}: ${f.model} (motivo '${f.reason}')`);
    }
    return;
  }

  const rIdx = argv.indexOf('--runs');
  const limit = rIdx >= 0 ? Number(argv[rIdx + 1]) || 6 : 6;
  const raw = gh(['run', 'list', ...repoArgs, '--workflow=generate-article.yml',
    '--limit', String(limit), '--json', 'databaseId,conclusion']);
  let runs = [];
  try { runs = JSON.parse(raw || '[]'); } catch { runs = []; }
  if (runs.length === 0) {
    console.log('Nessuna run leggibile → niente da riportare.');
    return;
  }

  if (argv.includes('--deferral-verdicts')) {
    let cascades = 0;
    let flips = 0;
    let runsConCascata = 0;
    for (const r of runs) {
      const found = parseAggregateExhaustion(gh(['run', 'view', String(r.databaseId), ...repoArgs, '--log']));
      if (found.length) runsConCascata++;
      for (const c of found) {
        const v = deferralVerdicts(c);
        cascades++;
        if (v.flip) flips++;
        console.log(formatVerdictLine(r.databaseId, v));
      }
    }
    // Il denominatore sono le CASCATE, non le run: una run puo' svuotare la
    // catena piu' volte (un tentativo per sezione) e ogni svuotamento e' un
    // verdetto suo. Le run senza nemmeno una cascata non hanno un verdetto da
    // confrontare, e tenerle nel denominatore diluirebbe la misura fino a
    // renderla illeggibile.
    console.log(`\ncascate confrontabili: ${cascades} su ${runsConCascata}/${runs.length} run lette`);
    console.log(`flip: ${flips}/${cascades} cascate`);
    const note = ghFailureNote();
    if (note) console.log(note);
    return;
  }

  const totals = {};
  let findings = 0;
  for (const r of runs) {
    const log = gh(['run', 'view', String(r.databaseId), ...repoArgs, '--log']);
    const events = parseExhaustionEvents(log);
    const summary = summariseExhaustion(events);
    console.log(formatRunLine(r.databaseId, summary));
    for (const [k, v] of Object.entries(summary.byReason)) totals[k] = (totals[k] || 0) + v;
    for (const f of auditExhaustion(events, now)) {
      findings++;
      console.log(`  DIFETTO ${f.kind}: ${f.model} (motivo '${f.reason}')`);
    }
  }
  const totLine = Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}=${n}`).join(' ') || '—';
  console.log(`\nTOTALE su ${runs.length} run — motivi distinti: ${Object.keys(totals).length} · ${totLine}`);
  console.log(`difetti rilevati: ${findings}`);
  const note = ghFailureNote();
  if (note) console.log(note);
}

if (process.argv[1] && process.argv[1].endsWith('exhaustion-reason-report.mjs')) main();
