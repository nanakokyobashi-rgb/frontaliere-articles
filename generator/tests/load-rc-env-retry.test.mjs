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
import { isRetryableRcFetchStatus, rcFetchBackoffMs, RC_FETCH_TIMEOUT_MS } from '../scripts/load-rc-env.mjs';
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
