/**
 * load-rc-env-retry.test.mjs — la classe di bug dietro #45, #54 e #171
 * ("Agent loop down: GITHUB_PAT failed to load"): tutte e tre erano un
 * singolo fetch REST verso Firebase Remote Config, senza retry, che
 * incontrava un 429/503 transitorio e faceva collassare l'intero caricamento
 * secrets — letto poi come "PAT rotto" quando non lo era mai stato.
 *
 * `fetchTemplateViaRest` in load-rc-env.mjs ora retrya 429/5xx; questo test
 * pin-a la sola parte pura e testabile senza rete: la classificazione dello
 * status e il backoff. La stessa classificazione ora guida anche
 * `exchangeAssertionForToken` in lib/google-service-account-token.mjs, il
 * gemello diretto sulla stessa catena di credenziali (vedi quel file).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRetryableRcFetchStatus, extractGoogleErrorReason, rcFetchBackoffMs, RC_FETCH_TIMEOUT_MS } from '../scripts/load-rc-env.mjs';
import { TOKEN_EXCHANGE_TIMEOUT_MS } from '../scripts/lib/google-service-account-token.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('429 e 5xx sono retryable — sono gli status osservati in #45, #54, #171', () => {
  assert.equal(isRetryableRcFetchStatus(429), true);
  assert.equal(isRetryableRcFetchStatus(500), true);
  assert.equal(isRetryableRcFetchStatus(503), true);
  assert.equal(isRetryableRcFetchStatus(599), true);
});

test('4xx diversi da 429 NON sono retryable — un JWT invalido non si risolve riprovando', () => {
  assert.equal(isRetryableRcFetchStatus(400), false);
  assert.equal(isRetryableRcFetchStatus(401), false);
  assert.equal(isRetryableRcFetchStatus(403), false);
  assert.equal(isRetryableRcFetchStatus(404), false);
});

test('il backoff cresce esponenzialmente per tentativo', () => {
  assert.equal(rcFetchBackoffMs(1), 1000);
  assert.equal(rcFetchBackoffMs(2), 2000);
  assert.equal(rcFetchBackoffMs(3), 4000);
  assert.equal(rcFetchBackoffMs(4), 8000);
});

// #199: né fetchTemplateViaRest né exchangeAssertionForToken avevano un
// timeout — solo un retry basato sullo status. Un endpoint lento che non
// risponde MAI (né ok né errore) appende il singolo `fetch()` per sempre, e
// il ciclo di retry non viene mai raggiunto una seconda volta. Il fetch reale
// non è testabile senza rete in questa suite (vedi commento in cima al
// file): questi test pinnano che il cap wall-clock esista, sia finito e sia
// effettivamente cablato nella chiamata fetch, così un refactor futuro non
// può farlo sparire in silenzio.

test('RC_FETCH_TIMEOUT_MS e TOKEN_EXCHANGE_TIMEOUT_MS sono cap finiti e ragionevoli', () => {
  for (const ms of [RC_FETCH_TIMEOUT_MS, TOKEN_EXCHANGE_TIMEOUT_MS]) {
    assert.equal(typeof ms, 'number');
    assert.ok(Number.isFinite(ms) && ms > 0, 'il timeout deve essere un numero finito positivo');
    assert.ok(ms >= 5000 && ms <= 60000, 'il timeout deve restare in un range plausibile per una API Google (5s–60s)');
  }
});

test('fetchTemplateViaRest passa RC_FETCH_TIMEOUT_MS come AbortSignal al fetch', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/load-rc-env.mjs'), 'utf8');
  const fnBody = src.slice(src.indexOf('async function fetchTemplateViaRest'));
  assert.match(
    fnBody,
    /signal:\s*AbortSignal\.timeout\(RC_FETCH_TIMEOUT_MS\)/,
    'il fetch verso Remote Config non ha (più) un AbortSignal.timeout(RC_FETCH_TIMEOUT_MS): un endpoint lento senza mai un errore esplicito appenderebbe la richiesta per sempre',
  );
});

test('exchangeAssertionForToken passa TOKEN_EXCHANGE_TIMEOUT_MS come AbortSignal al fetch', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/lib/google-service-account-token.mjs'), 'utf8');
  const fnBody = src.slice(src.indexOf('export async function exchangeAssertionForToken'));
  assert.match(
    fnBody,
    /signal:\s*AbortSignal\.timeout\(TOKEN_EXCHANGE_TIMEOUT_MS\)/,
    "il fetch verso l'endpoint OAuth di Google non ha (più) un AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS): un endpoint lento senza mai un errore esplicito appenderebbe la richiesta per sempre",
  );
});

// #247: un `fetch()` rifiutato senza Abort/TimeoutError — cioè un fallimento
// di rete nudo (DNS, TLS, connection reset: un `TypeError: fetch failed`
// senza status) — veniva ri-lanciato subito invece di rientrare nel retry
// loop. Misurato in produzione: un `fetch failed` a 272ms dall'avvio della
// richiesta, troppo veloce per essere il timeout da 30s ma indistinguibile
// nell'effetto (nessuna risposta). Questi test pinnano che il catch block di
// entrambi i gemelli non ri-lanci più incondizionatamente sulla base del solo
// nome dell'errore.
test('fetchTemplateViaRest non ri-lancia subito su un fetch() rifiutato senza Abort/TimeoutError', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/load-rc-env.mjs'), 'utf8');
  const fnBody = src.slice(
    src.indexOf('async function fetchTemplateViaRest'),
    src.indexOf('// ─── Main'),
  );
  assert.doesNotMatch(
    fnBody,
    /if\s*\(err\?\.name\s*!==\s*'AbortError'\s*&&\s*err\?\.name\s*!==\s*'TimeoutError'\)\s*throw err;/,
    'un fallimento di rete nudo (DNS/TLS/connection reset, nessun Abort/TimeoutError) deve rientrare nel retry loop, non essere ri-lanciato al primo tentativo',
  );
});

test('exchangeAssertionForToken non ri-lancia subito su un fetch() rifiutato senza Abort/TimeoutError', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/lib/google-service-account-token.mjs'), 'utf8');
  const fnBody = src.slice(src.indexOf('export async function exchangeAssertionForToken'));
  assert.doesNotMatch(
    fnBody,
    /if\s*\(err\?\.name\s*!==\s*'AbortError'\s*&&\s*err\?\.name\s*!==\s*'TimeoutError'\)\s*throw err;/,
    'un fallimento di rete nudo (DNS/TLS/connection reset, nessun Abort/TimeoutError) deve rientrare nel retry loop, non essere ri-lanciato al primo tentativo',
  );
});

// Recidiva del 2026-08-31 (run 33440368972): un REST 403 dalla Remote Config
// che si è auto-risolto 18 minuti dopo (run 33441957650) con le STESSE
// credenziali, mai ruotate — cioè non era mai un problema di permessi, ma un
// rifiuto di quota che Google a volte veste da 403 invece che da 429 (vedi
// `error.errors[].reason` nel body). Il classificatore precedente trattava
// ogni 403 come un JWT invalido e rilanciava subito, saltando l'intero
// retry budget su esattamente il fallimento transitorio misurato qui.
test('un 403 "nudo" (nessuna reason riconosciuta) resta NON retryable — comportamento invariato', () => {
  assert.equal(isRetryableRcFetchStatus(403), false);
  assert.equal(isRetryableRcFetchStatus(403, undefined), false);
  assert.equal(isRetryableRcFetchStatus(403, 'PERMISSION_DENIED'), false);
});

test('un 403 con reason di quota Google È retryable — stesso fallimento transitorio di #247 (2026-08-31)', () => {
  for (const reason of ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceededUnreg', 'quotaExceeded', 'RESOURCE_EXHAUSTED']) {
    assert.equal(isRetryableRcFetchStatus(403, reason), true, `reason=${reason} deve essere retryable`);
  }
});

test('extractGoogleErrorReason legge sia la forma legacy (errors[].reason) sia quella gRPC-status (error.status)', () => {
  assert.equal(
    extractGoogleErrorReason(JSON.stringify({ error: { errors: [{ reason: 'rateLimitExceeded' }] } })),
    'rateLimitExceeded',
  );
  assert.equal(
    extractGoogleErrorReason(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED' } })),
    'RESOURCE_EXHAUSTED',
  );
  assert.equal(extractGoogleErrorReason('not json'), null);
  assert.equal(extractGoogleErrorReason('{}'), null);
});

test('fetchTemplateViaRest legge il body e passa la reason al classificatore prima di ri-lanciare', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/load-rc-env.mjs'), 'utf8');
  const fnBody = src.slice(
    src.indexOf('async function fetchTemplateViaRest'),
    src.indexOf('// ─── Main'),
  );
  assert.match(fnBody, /extractGoogleErrorReason\(bodyText\)/, 'un 403 deve leggere il body per estrarre la reason, non fermarsi allo status');
  assert.match(fnBody, /isRetryableRcFetchStatus\(rcRes\.status,\s*reason\)/, 'la reason estratta deve raggiungere il classificatore');
});

// refresh-daily-brief-data.mjs chiama lo stesso `isRetryableRcFetchStatus`
// contro l'API REST di Firestore (stessa infra Google, stesso classificatore
// condiviso) — senza leggere il body, un 403 di quota qui degrada in
// silenzio il blocco daily-brief invece di riprovare (review PR #683).
test("fetchJson e getDoc in refresh-daily-brief-data.mjs leggono il body e passano la reason al classificatore", () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/refresh-daily-brief-data.mjs'), 'utf8');
  const fnBodyFetchJson = src.slice(
    src.indexOf('async function fetchJson'),
    src.indexOf('/** List every doc'),
  );
  const fnBodyGetDoc = src.slice(
    src.indexOf('async function getDoc'),
    src.indexOf('function loadServiceAccountCreds'),
  );
  for (const [name, fnBody] of [['fetchJson', fnBodyFetchJson], ['getDoc', fnBodyGetDoc]]) {
    assert.match(fnBody, /extractGoogleErrorReason\(bodyText\)/, `${name}: un 403 deve leggere il body per estrarre la reason, non fermarsi allo status`);
    assert.match(fnBody, /isRetryableRcFetchStatus\(res\.status,\s*reason\)/, `${name}: la reason estratta deve raggiungere il classificatore`);
  }
});
