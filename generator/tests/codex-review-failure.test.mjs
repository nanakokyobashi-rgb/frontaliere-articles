import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCodexReviewFailure,
  CODEX_REVIEW_FAILURE_CAUSE,
  CODEX_REVIEW_WATCHDOG_TIMEOUT_MS,
} from '../../scripts/ci/classify-codex-review-failure.mjs';

test('la soglia watchdog condivisa resta di 1800 secondi', () => {
  assert.equal(CODEX_REVIEW_WATCHDOG_TIMEOUT_MS, 1_800_000);
});

test('classifica max_turns dal marker strutturato Codex e conserva i turni', () => {
  assert.deepEqual(
    classifyCodexReviewFailure({
      outcome: 'failure',
      raw: JSON.stringify({ type: 'turn.failed', error: { terminal_reason: 'max_turns' }, num_turns: 34 }),
    }),
    { cause: CODEX_REVIEW_FAILURE_CAUSE.MAX_TURNS, numTurns: 34, source: 'structured' },
  );
});

test('classifica 429 e 5xx dal payload strutturato, non dal testo del prompt', () => {
  assert.equal(
    classifyCodexReviewFailure({
      outcome: 'failure',
      raw: JSON.stringify({ type: 'error', api_error_status: 429 }),
    }).cause,
    CODEX_REVIEW_FAILURE_CAUSE.RATE_LIMIT,
  );
  assert.equal(
    classifyCodexReviewFailure({
      outcome: 'failure',
      raw: JSON.stringify({ type: 'turn.failed', error: { http_status: 529, message: 'overloaded' } }),
    }).cause,
    CODEX_REVIEW_FAILURE_CAUSE.SERVER_ERROR,
  );
  assert.equal(
    classifyCodexReviewFailure({
      outcome: 'failure',
      raw: JSON.stringify({ type: 'message', text: 'The prompt mentions HTTP 429 rate_limit.' }),
    }).cause,
    CODEX_REVIEW_FAILURE_CAUSE.NON_RETRYABLE,
  );
});

test('un outcome cancelled è retryable anche senza file diagnostico', () => {
  assert.deepEqual(
    classifyCodexReviewFailure({ outcome: 'cancelled', raw: '' }),
    { cause: CODEX_REVIEW_FAILURE_CAUSE.CANCELLED, numTurns: null, source: 'outcome' },
  );
});

test('il timeout interno del watchdog è classificato cancelled e resta retryable', () => {
  assert.deepEqual(
    classifyCodexReviewFailure({
      outcome: 'failure',
      raw: JSON.stringify({ type: 'codex_timeout', codex_timeout: true, timeout_seconds: 1800 }),
    }),
    { cause: CODEX_REVIEW_FAILURE_CAUSE.CANCELLED, numTurns: null, source: 'structured' },
  );
});

test('un watchdog scaduto resta riconoscibile anche senza marker JSON', () => {
  assert.deepEqual(
    classifyCodexReviewFailure({
      outcome: 'failure',
      raw: JSON.stringify({ type: 'item.started', item: { type: 'command_execution' } }),
      durationMs: 1_800_000,
    }),
    { cause: CODEX_REVIEW_FAILURE_CAUSE.CANCELLED, numTurns: null, source: 'watchdog' },
  );
  assert.deepEqual(
    classifyCodexReviewFailure({ outcome: 'failure', raw: '', timedOut: true }),
    { cause: CODEX_REVIEW_FAILURE_CAUSE.CANCELLED, numTurns: null, source: 'watchdog' },
  );
});

test('un exit pulito senza gh pr review è un abort retryable', () => {
  assert.deepEqual(
    classifyCodexReviewFailure({
      outcome: 'failure',
      raw: JSON.stringify({ type: 'codex_no_review', codex_no_review: true }),
    }),
    { cause: CODEX_REVIEW_FAILURE_CAUSE.CANCELLED, numTurns: null, source: 'structured' },
  );
});

test('stderr rate-limit su stream misto JSON+testo resta retryable', () => {
  const mixed = [
    JSON.stringify({ type: 'item.completed', text: 'The prompt mentions HTTP 429 rate_limit.' }),
    'stderr: HTTP 429 rate_limit too many requests',
  ].join('\n');
  assert.deepEqual(
    classifyCodexReviewFailure({ outcome: 'failure', raw: mixed }),
    { cause: CODEX_REVIEW_FAILURE_CAUSE.RATE_LIMIT, numTurns: null, source: 'text' },
  );
});

test('stderr server-error su stream misto JSON+testo resta retryable', () => {
  const mixed = [
    JSON.stringify({ type: 'turn.started', item_id: '1' }),
    'api error: 503 overloaded server_error',
  ].join('\n');
  assert.deepEqual(
    classifyCodexReviewFailure({ outcome: 'failure', raw: mixed }),
    { cause: CODEX_REVIEW_FAILURE_CAUSE.SERVER_ERROR, numTurns: null, source: 'text' },
  );
});
