#!/usr/bin/env node
/**
 * gh-rate-limit.mjs — una lettura `gh` che sopravvive all'esaurimento del
 * bucket REST orario del token (zero-Claude, solo builtin Node).
 *
 * ## Il difetto che chiude
 *
 * Il `GITHUB_TOKEN` di questo repo ha UN bucket REST da 1.000 richieste l'ora,
 * condiviso da tutti i workflow. Il 2026-09-25 fra le 06:58 e le 07:10 UTC il
 * bucket si e' esaurito e i gate delle PR sono diventati rossi con
 * `gh: API rate limit exceeded for installation (HTTP 403)` — «Resolve review
 * input revision», «Generator CI gate», «Require approving Codex review» — su
 * PR che non avevano niente di sbagliato. Alle 07:15 il bucket era di nuovo
 * pieno, ma nessuno rilanciava quei run: i retry esistenti
 * (`github-actions-read-client.mjs`, 3 tentativi entro 5 s) finiscono molto
 * prima del reset.
 *
 * ## La regola
 *
 * Su un 403 «API rate limit exceeded» (il limite PRIMARIO; il secondario non
 * espone un reset leggibile e resta un errore normale) si legge il reset da
 * `gh api rate_limit` — endpoint che NON consuma quota — sulla risorsa del
 * token (`core` per le letture REST del `GITHUB_TOKEN`):
 *
 *   - reset entro `RATE_LIMIT_MAX_WAIT_MS` (15 min): si dorme fino al reset piu'
 *     un jitter e si riprova UNA volta;
 *   - reset piu' lontano, reset illeggibile, attesa gia' spesa in questo
 *     processo, o un secondo 403 dopo l'attesa: fail-closed con un `::error::`
 *     che nomina il rate limit e l'ora del reset, e con il marker macchina
 *     `[gh-rate-limit resource=<r> reset=<epoch>]` che
 *     `review-quota-rescuer.mjs` legge dalle annotation del run per rilanciarlo
 *     DOPO il reset.
 *
 * Un solo sonno per processo (`budget`): un gate che incontra il limite due
 * volte non puo' allungarsi oltre un reset, e un processo che ha gia' atteso
 * non trasforma ogni lettura successiva in un'altra attesa.
 *
 * Il fail-closed non abbassa niente: senza il dato il chiamante esce rosso come
 * prima, ma con la causa scritta e con una via di rientro deterministica.
 *
 * ## Due forme d'uso
 *
 *   import { ghWithRateLimitRetry } from './lib/gh-rate-limit.mjs';
 *   const out = ghWithRateLimitRetry(['api', 'repos/o/r/pulls/1'], { context: 'review-gate' });
 *
 *   node scripts/ci/lib/gh-rate-limit.mjs [--gh <path>] [--resource core] \
 *     [--context <testo>] -- api repos/o/r/pulls/1 --jq .body
 *
 * La CLI scrive su stdout SOLO l'output di `gh` (gli step la redirigono in un
 * file) e mette annotation e diagnostica su stderr. Exit: 0 successo · codice
 * di `gh` su un errore che non e' un rate limit · 1 su rate limit fail-closed.
 *
 * Env: `GH_RATE_LIMIT_MAX_WAIT_MS` (default 15 min), `GH_RATE_LIMIT_JITTER_MS`
 * (jitter massimo, default 20 s; 0 lo spegne).
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RATE_LIMIT_MAX_WAIT_MS = 15 * 60 * 1000;
const DEFAULT_JITTER_MAX_MS = 20_000;
const JITTER_MIN_MS = 2_000;
const MAX_BUFFER = 64 * 1024 * 1024;

const PRIMARY_RATE_LIMIT_RE = /API rate limit (?:already )?exceeded/i;
const SECONDARY_RATE_LIMIT_RE = /secondary rate limit/i;
const MARKER_RE = /\[gh-rate-limit resource=([a-z_]+) reset=(\d+)\]/;

/** Budget di attese condiviso dal processo: un solo sonno fino al reset. */
const processBudget = { waits: 1 };

/** Il testo di un errore `gh` e' un 403 da limite PRIMARIO? Pura. */
export function isPrimaryRateLimitError(text) {
  const value = String(text || '');
  return PRIMARY_RATE_LIMIT_RE.test(value) && !SECONDARY_RATE_LIMIT_RE.test(value);
}

/** Marker macchina scritto dentro l'annotation del fail-closed. Pura. */
export function rateLimitMarker({ resource = 'core', resetAt = 0 } = {}) {
  const reset = Number.isSafeInteger(resetAt) && resetAt > 0 ? resetAt : 0;
  const name = /^[a-z_]+$/.test(String(resource)) ? String(resource) : 'core';
  return `[gh-rate-limit resource=${name} reset=${reset}]`;
}

/**
 * Legge il marker da un testo (annotation, messaggio d'errore). `resetAt` e' 0
 * quando il reset non era leggibile: il consumer deve allora ricavarlo da solo
 * (il bucket e' orario, quindi un'ora dopo il rosso il reset e' certo). Pura.
 */
export function parseRateLimitMarker(text) {
  const match = String(text || '').match(MARKER_RE);
  if (!match) return null;
  const resetAt = Number(match[2]);
  return { resource: match[1], resetAt: Number.isSafeInteger(resetAt) ? resetAt : 0 };
}

export class GitHubRateLimitError extends Error {
  constructor(message, { resource = 'core', resetAt = 0 } = {}) {
    super(message);
    this.name = 'GitHubRateLimitError';
    this.resource = resource;
    this.resetAt = resetAt;
  }
}

function errorText(error) {
  return [error?.stderr, error?.stdout, error?.message]
    .map((part) => (part == null ? '' : String(part)))
    .join('\n');
}

function isoFromEpoch(epochSec) {
  return Number.isSafeInteger(epochSec) && epochSec > 0
    ? new Date(epochSec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    : 'sconosciuto';
}

/** Sonno sincrono: i chiamanti (gate a exit code) sono sincroni. */
export function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/**
 * Stato del bucket da `gh api rate_limit`, che non consuma quota. `null` quando
 * la risposta non e' leggibile: il chiamante non inventa un reset.
 */
export function readRateLimitReset({ ghBin = 'gh', resource = 'core', exec = execFileSync } = {}) {
  let raw;
  try {
    raw = exec(ghBin, ['api', 'rate_limit'], { encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
  let bucket;
  try {
    bucket = JSON.parse(String(raw))?.resources?.[resource];
  } catch {
    return null;
  }
  const resetAt = Number(bucket?.reset);
  const remaining = Number(bucket?.remaining);
  if (!Number.isSafeInteger(resetAt) || resetAt <= 0) return null;
  return { resetAt, remaining: Number.isSafeInteger(remaining) ? remaining : null };
}

function failClosed({ label, resource, resetAt, nowMs, why, log }) {
  const minutes = resetAt > 0 ? Math.max(0, Math.ceil((resetAt * 1000 - nowMs) / 60_000)) : null;
  const when = resetAt > 0 ? `reset ${isoFromEpoch(resetAt)} (fra ${minutes} min)` : 'reset non leggibile da `gh api rate_limit`';
  const message = `${label}: GitHub API rate limit esaurito sul bucket REST \`${resource}\` del token (403 «API rate limit exceeded»), ${when}; ${why} — fail-closed, nessun verdetto su dati non letti. ${rateLimitMarker({ resource, resetAt })}`;
  log(`::error title=GitHub API rate limit::${message}`);
  throw new GitHubRateLimitError(message, { resource, resetAt });
}

/**
 * Esegue `gh <args>` e restituisce lo stdout; su un rate limit primario attende
 * il reset (se vicino) e riprova una volta, altrimenti lancia
 * `GitHubRateLimitError` dopo aver emesso l'annotation. Ogni altro errore di
 * `gh` risale invariato. Tutte le dipendenze sono iniettabili per i test.
 */
export function ghWithRateLimitRetry(args, {
  ghBin = 'gh',
  resource = 'core',
  context = '',
  exec = execFileSync,
  execOptions = {},
  now = () => Date.now(),
  sleep = sleepSync,
  random = Math.random,
  maxWaitMs = envInt('GH_RATE_LIMIT_MAX_WAIT_MS', RATE_LIMIT_MAX_WAIT_MS),
  jitterMaxMs = envInt('GH_RATE_LIMIT_JITTER_MS', DEFAULT_JITTER_MAX_MS),
  budget = processBudget,
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  // Nessuno `stdio` esplicito: come l'`execFileSync` che sostituisce, lo
  // stderr di `gh` resta visibile nel log E disponibile su `error.stderr`.
  const run = () => exec(ghBin, args, { encoding: 'utf8', maxBuffer: MAX_BUFFER, ...execOptions });
  const label = context || `gh ${args.slice(0, 2).join(' ')}`;
  try {
    return run();
  } catch (error) {
    if (!isPrimaryRateLimitError(errorText(error))) throw error;
  }

  const state = readRateLimitReset({ ghBin, resource, exec });
  const nowMs = now();
  if (!state) {
    failClosed({ label, resource, resetAt: 0, nowMs, why: 'senza reset non si puo\' attendere in modo verificabile', log });
  }
  const jitterCap = Math.max(0, jitterMaxMs);
  const jitterFloor = Math.min(JITTER_MIN_MS, jitterCap);
  const jitterMs = Math.round(jitterFloor + random() * (jitterCap - jitterFloor));
  // `remaining > 0`: il bucket si e' gia' ricaricato fra il 403 e la lettura, e
  // `reset` descrive la finestra SUCCESSIVA. Attenderla sarebbe un'ora persa.
  const waitMs = state.remaining !== null && state.remaining > 0
    ? jitterMs
    : Math.max(0, state.resetAt * 1000 - nowMs) + jitterMs;
  if (waitMs > maxWaitMs) {
    failClosed({ label, resource, resetAt: state.resetAt, nowMs, why: `oltre l'attesa massima di ${Math.round(maxWaitMs / 60_000)} min`, log });
  }
  if (!(budget.waits > 0)) {
    failClosed({ label, resource, resetAt: state.resetAt, nowMs, why: 'attesa fino al reset gia\' spesa in questo processo', log });
  }
  budget.waits -= 1;
  log(`::warning title=GitHub API rate limit::${label}: bucket REST \`${resource}\` esaurito, reset ${isoFromEpoch(state.resetAt)} — attendo ${Math.ceil(waitMs / 1000)} s e riprovo una volta.`);
  sleep(waitMs);
  try {
    return run();
  } catch (error) {
    if (!isPrimaryRateLimitError(errorText(error))) throw error;
    const after = readRateLimitReset({ ghBin, resource, exec });
    failClosed({ label, resource, resetAt: after?.resetAt || state.resetAt, nowMs: now(), why: 'ancora esaurito dopo l\'attesa (unico retry speso)', log });
  }
  return ''; // irraggiungibile: failClosed lancia sempre
}

function parseCliArgs(argv) {
  const options = { ghBin: 'gh', resource: 'core', context: '' };
  const separator = argv.indexOf('--');
  if (separator < 0 || separator === argv.length - 1) {
    throw new Error('uso: gh-rate-limit.mjs [--gh <path>] [--resource <r>] [--context <testo>] -- <argomenti gh>');
  }
  const own = argv.slice(0, separator);
  for (let i = 0; i < own.length; i += 2) {
    const [flag, value] = [own[i], own[i + 1]];
    if (value === undefined) throw new Error(`valore mancante per ${flag}`);
    if (flag === '--gh') options.ghBin = value;
    else if (flag === '--resource') options.resource = value;
    else if (flag === '--context') options.context = value;
    else throw new Error(`opzione sconosciuta: ${flag}`);
  }
  if (!/^[a-z_]+$/.test(options.resource)) throw new Error(`risorsa non valida: ${options.resource}`);
  return { options, ghArgs: argv.slice(separator + 1) };
}

function cli(argv) {
  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    process.stderr.write(`gh-rate-limit: ${error.message}\n`);
    return 2;
  }
  try {
    const out = ghWithRateLimitRetry(parsed.ghArgs, {
      ...parsed.options,
      // Lo stderr di `gh` passa comunque per il catch qui sotto: `pipe` evita
      // che finisca due volte nel log dello step.
      execOptions: { stdio: ['ignore', 'pipe', 'pipe'] },
    });
    process.stdout.write(out);
    return 0;
  } catch (error) {
    if (error instanceof GitHubRateLimitError) return 1;
    if (error?.stderr) process.stderr.write(String(error.stderr));
    else process.stderr.write(`gh-rate-limit: ${String(error?.message || error)}\n`);
    return Number.isInteger(error?.status) && error.status > 0 ? error.status : 1;
  }
}

// Confronto sui path REALI: se la directory passa per un symlink (su macOS
// `/var` -> `/private/var`) `import.meta.url` e `argv[1]` differiscono, e una
// CLI che non parte uscirebbe 0 con stdout vuoto — cioe' un body «vuoto» letto
// come valido dallo step che la redirige in un file.
const isDirectRun = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1] || ''));
  } catch {
    return false;
  }
})();

if (isDirectRun) process.exitCode = cli(process.argv.slice(2));
