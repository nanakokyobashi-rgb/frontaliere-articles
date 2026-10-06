import test from 'node:test';
import assert from 'node:assert/strict';

import {
  firstAllowlistedStderr,
  isStartupFailure,
  parseCodexPrimaryDiagnostics,
  STARTUP_FAILURE_MAX_DURATION_MS,
} from '../../scripts/ci/codex-primary-diagnostics.mjs';

test('conta solo il tipo degli eventi JSONL e non esporta i payload', () => {
  const result = parseCodexPrimaryDiagnostics([
    JSON.stringify({ type: 'thread.started', thread_id: 'private-thread' }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12 } }),
    'non-json stderr line',
  ].join('\n'), '');

  assert.deepEqual(result.event_counts, { 'thread.started': 1, 'turn.completed': 1 });
  assert.equal(result.event_total, 2);
  assert.doesNotMatch(JSON.stringify(result), /private-thread|input_tokens/u);
});

test('la allowlist restituisce solo una firma sicura della prima riga riconosciuta', () => {
  const result = firstAllowlistedStderr([
    'prompt=PRIVATE_PROMPT token=SECRET_TOKEN',
    'Codex: stream disconnected; prompt=PRIVATE_PROMPT token=SECRET_TOKEN',
    'HTTP 503 body=PRIVATE_RESPONSE',
  ].join('\n'));

  assert.deepEqual(result, {
    causeClass: 'stream-disconnected',
    stderrMatch: 'stream disconnected',
  });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROMPT|SECRET_TOKEN|PRIVATE_RESPONSE/u);
  assert.deepEqual(firstAllowlistedStderr('prompt=PRIVATE_PROMPT\nordinary text'), {
    causeClass: 'unknown',
    stderrMatch: '',
  });
});

test('classifica le forme note senza rendere pubblico lo stderr', () => {
  assert.equal(firstAllowlistedStderr('api_error_status: 529 details=secret').causeClass, 'http-5xx');
  assert.equal(firstAllowlistedStderr('usage limit reached secret=1').causeClass, 'usage-limit');
  assert.equal(firstAllowlistedStderr('model not found: private-model').causeClass, 'model-not-found');
  assert.equal(firstAllowlistedStderr('invalid configuration: token=secret').causeClass, 'config-error');
  assert.equal(firstAllowlistedStderr('unknown option --private-flag').causeClass, 'argument-error');
});

test('fallimento all avvio: exit non-zero, zero eventi, nessun effetto e sotto soglia', () => {
  assert.equal(STARTUP_FAILURE_MAX_DURATION_MS, 60_000);
  assert.equal(parseCodexPrimaryDiagnostics('', '', {
    exitCode: 1,
    reviewPosted: false,
    sideEffectDetected: false,
    durationMs: 10,
  }).cause_class, 'startup-failure');
  assert.equal(isStartupFailure({
    exitCode: 1,
    eventTotal: 0,
    reviewPosted: false,
    sideEffectDetected: false,
    durationMs: STARTUP_FAILURE_MAX_DURATION_MS - 1,
  }), true);
  assert.equal(isStartupFailure({
    exitCode: 1,
    eventTotal: 0,
    reviewPosted: false,
    sideEffectDetected: false,
    durationMs: STARTUP_FAILURE_MAX_DURATION_MS,
  }), false);
  assert.equal(isStartupFailure({
    exitCode: 1,
    eventTotal: 0,
    reviewPosted: false,
    sideEffectDetected: true,
    durationMs: 10,
  }), false);
  assert.equal(isStartupFailure({
    exitCode: 1,
    eventTotal: 1,
    reviewPosted: false,
    sideEffectDetected: false,
    durationMs: 10,
  }), false);
});

test('timeout e side effect non diventano startup failure', () => {
  assert.equal(isStartupFailure({
    exitCode: 124,
    eventTotal: 0,
    reviewPosted: false,
    sideEffectDetected: false,
    durationMs: 1_800_000,
  }), false);
});
