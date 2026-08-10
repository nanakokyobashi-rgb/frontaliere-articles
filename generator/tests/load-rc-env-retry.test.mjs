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
import { isRetryableRcFetchStatus, rcFetchBackoffMs } from '../scripts/load-rc-env.mjs';

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
