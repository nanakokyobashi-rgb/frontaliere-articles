import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCodexReviewFailure,
  CODEX_REVIEW_FAILURE_CAUSE,
} from '../../scripts/ci/classify-codex-review-failure.mjs';

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
