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
 * qui che il rumore si misurava e qui che va tolto. `mode: identical` nel
 * `loop-sync-manifest.json` non è un'istruzione di routing — dice solo che le
 * due copie del file vanno tenute allineate, non su quale lato applicare una
 * fix (vedi generator/tests/generation-health-watchdog.test.mjs §8, che copre
 * esattamente questa confusione per i body di `scan-generation-health.mjs`).
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
 */

import { execFileSync } from 'node:child_process';

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
