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
 *
 * E il modo che misura i due voti di deferral sul messaggio aggregato (#854):
 *   node scripts/ci/exhaustion-reason-report.mjs --deferral-verdicts --runs 40
 *   gh run view <id> --log | node scripts/ci/exhaustion-reason-report.mjs --deferral-verdicts --stdin
 */

import { execFileSync } from 'node:child_process';
// Le due regex del voto vivono in ai-models.mjs e l'aritmetica del netto in
// exhaustion-disposition.mjs: si IMPORTANO, non si ricopiano (AGENTS.md #6).
// Una copia locale delle regex renderebbe questo report capace di misurare un
// verdetto che la produzione non prende — cioe' esattamente il difetto che sta
// misurando. Entrambi i moduli sono importabili senza rete: `ai-models.mjs` non
// ha un solo import di primo livello e `firebase-admin` lo carica lazy.
import { classifyExhaustionCause } from '../../generator/scripts/lib/ai-models.mjs';
import {
  isInputCapDeferralVeto,
  isTransientMajority,
  inputCapVetoSummary,
} from '../../generator/scripts/lib/exhaustion-disposition.mjs';

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

/** Riga di report per una singola run. Pura → testabile. */
export function formatRunLine(runId, summary) {
  const reasons = Object.entries(summary.byReason)
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${r}=${n}`)
    .join(' ') || '—';
  return `run ${runId}  righe=${String(summary.lines).padStart(3)}  ` +
    `modelli=${String(summary.distinctModels).padStart(3)}  persistiti=${summary.persistedModels.length}  ${reasons}`;
}

/**
 * ── IL MESSAGGIO AGGREGATO, NON LE RIGHE DI MARCATURA (issue #854) ──────────
 *
 * Tutto ciò che sta sopra aggrega `markModelExhausted`, cioè le marcature per
 * MOTIVO. I due voti di maggioranza che decidono l'exit code di produzione —
 * `transientExhaustion` (ai-models.mjs) e `isInputCapDeferralVeto`
 * (exhaustion-disposition.mjs) — non leggono quelle righe: leggono l'array
 * `errors` che finisce nel messaggio aggregato
 *
 *   `All AI models failed. Chain: [...]. Errors: <e1> | <e2> | … [| Prompt budget: …]`
 *
 * Sono due campioni diversi, e finora questo report vedeva solo il primo:
 * «quanto pesano gli echi di cooldown sulle due maggioranze» (punto 1 di #821)
 * non era ricavabile con lo strumento che c'era, pur essendo
 * `providerCooldownSkips` già nel breakdown da #805.
 *
 * `.` non matcha il newline, quindi la cattura si ferma a fine riga: il
 * messaggio è emesso su una riga sola, e un log di `gh run view --log` la
 * prefissa con `job\tstep\ttimestamp`, che sta PRIMA del letterale ancorato.
 */
export const AGGREGATE_MESSAGE_RE = /All AI models failed\. Chain: \[[^\]]*\]\. Errors: (.*)/g;

/**
 * Il separatore che chiude la lista degli errori. `callLLM` appende il report
 * di budget con la STESSA `' | '` che separa gli errori, quindi senza tagliare
 * qui la coda entrerebbe nel tally come un errore fantasma. Non è innocuo
 * neanche quando nessuna delle due regex lo colloca: `classifyExhaustionCause`
 * incrementa `total` per OGNI riga, e `total` è il denominatore su cui #805
 * misura gli echi e su cui `isLegitimateQuotaDeferral` prende il suo quoziente.
 */
export const PROMPT_BUDGET_SEPARATOR = ' | Prompt budget: ';

/** `| Prompt budget: 38 model(s) refused a ~9740-token request; …` */
export const PROMPT_BUDGET_REFUSALS_RE = /Prompt budget: (\d+) model\(s\) refused/;

/**
 * Ogni messaggio aggregato presente nel testo, ricomposto nella forma su cui i
 * due predicati votano: la lista `errors` e il numero di rifiuti su input cap
 * (che è `inputCapReport.count`, cioè il gate che arma il veto).
 *
 * Pura → testabile.
 * @param {string} text
 * @returns {Array<{errors: string[], capRefusals: number}>}
 */
export function parseAggregateErrors(text) {
  const out = [];
  const re = new RegExp(AGGREGATE_MESSAGE_RE.source, 'g');
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const tail = m[1];
    const cut = tail.indexOf(PROMPT_BUDGET_SEPARATOR);
    const listPart = cut >= 0 ? tail.slice(0, cut) : tail;
    const budgetPart = cut >= 0 ? tail.slice(cut) : '';
    const capM = budgetPart.match(PROMPT_BUDGET_REFUSALS_RE);
    out.push({
      errors: listPart.split(' | ').map((s) => s.trim()).filter(Boolean),
      capRefusals: capM ? Number(capM[1]) : 0,
    });
  }
  return out;
}

/**
 * Lo STESSO breakdown con gli echi di cooldown azzerati. È così che si ottiene
 * il verdetto LORDO senza riscrivere il confronto: `isTransientMajority` e
 * `isInputCapDeferralVeto` girano su un campione in cui non c'è niente da
 * sottrarre, quindi collassano esattamente sul `>=` di `classifyExhaustionCause`
 * e sul `!(>)` che `isInputCapDeferralVeto` aveva prima di #856.
 *
 * Il lordo NON è ricopiato a mano proprio perché è il termine di paragone: una
 * copia dell'aritmetica renderebbe il `flip` misurato sulla differenza fra la
 * produzione e questo file, invece che fra due campioni.
 */
function grossOf(breakdown) {
  return { ...breakdown, providerCooldownSkips: { total: 0, transient: 0, persistent: 0 } };
}

/**
 * `transientExhaustion` come lo calcola `callLLM` (ai-models.mjs: `transient > 0
 * && transient >= persistent`), ma sul campione che gli si passa. Il `> 0` si
 * legge sul secchio transitorio DI QUEL CAMPIONE — al netto, una cascata i cui
 * soli transitori erano echi di un unico cooldown non ha una sola prova
 * indipendente che aspettare aiuti.
 */
function transientExhaustionVerdict(breakdown) {
  const buckets = inputCapVetoSummary({ exhaustionBreakdown: breakdown });
  return buckets.transient > 0 && isTransientMajority(breakdown, { tie: 'transient' });
}

/**
 * I due verdetti, LORDO contro NETTO, su un singolo messaggio aggregato.
 *
 * `veto` include il gate `cap.count > 0`: senza un solo rifiuto su taglia il
 * veto non è armato e resta falso da entrambe le parti, che è il verdetto vero
 * — riportare la sola maggioranza direbbe «cambia» dove la produzione non
 * cambia niente.
 *
 * Pura → testabile.
 * @param {{errors: string[], capRefusals: number}} sample
 */
export function deferralVerdicts(sample) {
  const errors = Array.isArray(sample && sample.errors) ? sample.errors : [];
  const capRefusals = Math.max(0, Number(sample && sample.capRefusals) || 0);
  const net = classifyExhaustionCause(errors);
  const gross = grossOf(net);
  const inputCapReport = capRefusals > 0 ? { count: capRefusals } : null;
  const asErr = (breakdown) => ({ code: 'ALL_MODELS_EXHAUSTED', inputCapReport, exhaustionBreakdown: breakdown });
  const buckets = inputCapVetoSummary({ exhaustionBreakdown: net });
  const verdicts = {
    grossTransientExhaustion: transientExhaustionVerdict(gross),
    netTransientExhaustion: transientExhaustionVerdict(net),
    grossInputCapVeto: isInputCapDeferralVeto(asErr(gross)),
    netInputCapVeto: isInputCapDeferralVeto(asErr(net)),
  };
  return {
    transient: net.transient,
    persistent: net.persistent,
    total: net.total,
    ambiguous: Math.max(0, net.total - net.transient - net.persistent),
    echoTotal: net.providerCooldownSkips.total,
    echoTransient: net.providerCooldownSkips.transient,
    echoPersistent: net.providerCooldownSkips.persistent,
    netTransient: buckets.transient,
    netPersistent: buckets.persistent,
    echoDominated: buckets.echoDominated,
    capRefusals,
    ...verdicts,
    flipped: verdicts.grossTransientExhaustion !== verdicts.netTransientExhaustion
      || verdicts.grossInputCapVeto !== verdicts.netInputCapVeto,
  };
}

const si = (b) => (b ? 'si' : 'no');

/** Riga di report per un messaggio aggregato. Pura → testabile. */
export function formatVerdictLine(runId, v) {
  return `run ${runId}  t=${v.transient} p=${v.persistent} amb=${v.ambiguous} tot=${v.total}`
    + `  echi=${v.echoTotal}(t${v.echoTransient}/p${v.echoPersistent})`
    + `  netto=${v.netTransient}/${v.netPersistent}  cap=${v.capRefusals}`
    + `  transientExhaustion L=${si(v.grossTransientExhaustion)} N=${si(v.netTransientExhaustion)}`
    + `  inputCapVeto L=${si(v.grossInputCapVeto)} N=${si(v.netInputCapVeto)}`
    + (v.echoDominated ? '  [echi-dominanti]' : '')
    + (v.flipped ? '  ⇄ FLIP' : '');
}

/**
 * Il campione di una run: l'ULTIMO messaggio aggregato del log, non il primo.
 * È quello risalito fino al catch di primo livello di `create-article.mjs`,
 * cioè l'unico su cui i due predicati hanno davvero deciso un exit code; le
 * cascate svuotate prima possono essere state riprese da un retry di sezione.
 * `null` quando la run non ne contiene nessuno — non è un difetto, è una run
 * che non ha svuotato la cascata, e va tenuta fuori dal denominatore.
 *
 * Pura → testabile.
 * @param {string} text
 */
export function pickDecidingSample(text) {
  const samples = parseAggregateErrors(text);
  return samples.length ? samples[samples.length - 1] : null;
}

// ── CLI (sola lettura) ───────────────────────────────────────────────────────

const repoArgs = process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : [];

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 128 * 1024 * 1024 });
  } catch (e) {
    process.stderr.write(`gh fallita: ${e && e.message ? e.message : e}\n`);
    return '';
  }
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Il modo `--deferral-verdicts`: per ogni run, i due voti LORDO contro NETTO.
 *
 * Il denominatore di `flip:` sono le run CONFRONTABILI — quelle il cui log
 * contiene un messaggio aggregato — e non le run scandite. Una run che non ha
 * mai svuotato la cascata non ha un verdetto, e metterla al denominatore
 * diluirebbe la misura verso lo zero proprio come farebbe un parser rotto: due
 * cause opposte con lo stesso numero in fondo. Per questo le due cifre restano
 * separate anche nell'output.
 */
async function mainDeferralVerdicts(argv) {
  if (argv.includes('--stdin')) {
    const sample = pickDecidingSample(await readStdin());
    if (!sample) {
      console.log('Nessun messaggio aggregato «All AI models failed» → nessun verdetto confrontabile.');
      return;
    }
    const v = deferralVerdicts(sample);
    console.log(formatVerdictLine('<stdin>', v));
    console.log(`\nflip: ${v.flipped ? 1 : 0}/1 run`);
    return;
  }

  const rIdx = argv.indexOf('--runs');
  const limit = rIdx >= 0 ? Number(argv[rIdx + 1]) || 40 : 40;
  const raw = gh(['run', 'list', ...repoArgs, '--workflow=generate-article.yml',
    '--limit', String(limit), '--json', 'databaseId,conclusion']);
  let runs = [];
  try { runs = JSON.parse(raw || '[]'); } catch { runs = []; }
  if (runs.length === 0) {
    console.log('Nessuna run leggibile → niente da riportare.');
    return;
  }

  let comparable = 0;
  let flips = 0;
  for (const r of runs) {
    const sample = pickDecidingSample(gh(['run', 'view', String(r.databaseId), ...repoArgs, '--log']));
    if (!sample) {
      console.log(`run ${r.databaseId}  — nessun messaggio aggregato (cascata mai svuotata)`);
      continue;
    }
    comparable += 1;
    const v = deferralVerdicts(sample);
    if (v.flipped) flips += 1;
    console.log(formatVerdictLine(r.databaseId, v));
  }
  console.log(`\nrun scandite: ${runs.length} · confrontabili: ${comparable}`);
  console.log(`flip: ${flips}/${comparable} run`);
}

async function main() {
  const argv = process.argv.slice(2);
  const now = Date.now();

  if (argv.includes('--deferral-verdicts')) {
    await mainDeferralVerdicts(argv);
    return;
  }

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
}

if (process.argv[1] && process.argv[1].endsWith('exhaustion-reason-report.mjs')) main();
