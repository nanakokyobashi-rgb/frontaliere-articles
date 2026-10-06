/**
 * review-claim-health.test.mjs — il report osserva i claim terminali senza
 * trascinare nel report il prompt, la risposta o il JSONL del runner.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEX_CLAIM_HEAD_BLOCKED_HOURS,
  renderReviewClaimHealth,
  reviewClaimAlertBody,
  reviewClaimHealth,
  summarizeReviewClaimHealth,
} from '../../scripts/ci/loop-health-report.mjs';

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const event = (overrides = {}) => ({
  version: 1,
  token: `token-${overrides.dedupeKey || 'one'}`,
  prNumber: String(overrides.prNumber || 42),
  headSha: overrides.headSha || HEAD,
  eventKey: 'pull-request:42',
  contributionFingerprint: 'c'.repeat(64),
  key: 'claim-key',
  dedupeKey: overrides.dedupeKey || `pr:${overrides.prNumber || 42}|head:${HEAD}`,
  state: overrides.state || 'failed-terminal',
  cause: overrides.cause || 'startup_failure',
  issuedAt: overrides.issuedAt || 1_791_277_200,
  expiresAt: 1_791_284_400,
});

const comment = (claim, id) => ({
  body: `<!-- PR_REVIEW_CLAIM: ${JSON.stringify(claim)} -->\nprovider text: sk-live-must-not-appear`,
  createdAt: new Date(claim.issuedAt * 1000).toISOString(),
  databaseId: id,
  author: { login: 'github-actions[bot]' },
});

test('aggregazione per giorno/causa e alert solo sulla head aperta corrente', () => {
  const nowMs = Date.parse('2026-10-06T12:00:00Z');
  const first = Math.floor(Date.parse('2026-10-03T00:00:00Z') / 1000);
  const second = Math.floor(Date.parse('2026-10-04T00:00:00Z') / 1000);
  const pullRequests = [
    { number: 42, title: 'startup', state: 'OPEN', headRefOid: HEAD },
    { number: 43, title: 'head changed', state: 'OPEN', headRefOid: OTHER_HEAD },
    { number: 44, title: 'closed', state: 'MERGED', headRefOid: HEAD },
  ];
  const comments = new Map([
    [42, [
      comment(event({ prNumber: 42, dedupeKey: 'same', state: 'failed-transient', issuedAt: first }), 1),
      comment(event({ prNumber: 42, dedupeKey: 'same', state: 'failed-terminal', cause: 'startup_failure', issuedAt: second }), 2),
    ]],
    [43, [comment(event({ prNumber: 43, dedupeKey: 'different-head', cause: 'server_error', issuedAt: second }), 3)]],
    [44, [comment(event({ prNumber: 44, dedupeKey: 'closed', cause: 'probe_failed', issuedAt: second }), 4)]],
  ]);

  const result = summarizeReviewClaimHealth(pullRequests, comments, {
    sinceMs: Date.parse('2026-10-01T00:00:00Z'),
    nowMs,
  });
  assert.equal(result.terminalCount, 3, 'il retry transient→terminal conta un solo terminale');
  assert.deepEqual(result.byDayCause['2026-10-04'], {
    probe_failed: 1,
    server_error: 1,
    startup_failure: 1,
  });
  assert.deepEqual(result.blockedHeads.map((head) => head.prNumber), [42]);
  assert.equal(result.blockedHeads[0].cause, 'startup_failure');
  assert.equal(JSON.stringify(result).includes('sk-live-must-not-appear'), false);
});

test('un completamento successivo neutralizza il terminale della stessa dedupe key', () => {
  const nowMs = Date.parse('2026-10-06T12:00:00Z');
  const terminal = event({ issuedAt: Math.floor(Date.parse('2026-10-02T00:00:00Z') / 1000), dedupeKey: 'same' });
  const completed = event({ state: 'completed', cause: 'verdict_posted', issuedAt: Math.floor(Date.parse('2026-10-05T00:00:00Z') / 1000), dedupeKey: 'same' });
  const result = summarizeReviewClaimHealth(
    [{ number: 42, state: 'OPEN', headRefOid: HEAD }],
    new Map([[42, [comment(terminal, 1), comment(completed, 2)]]]),
    { sinceMs: Date.parse('2026-10-01T00:00:00Z'), nowMs },
  );
  assert.equal(result.terminalCount, 0);
  assert.deepEqual(result.blockedHeads, []);
});

test('lettura GitHub bounded: limite PR e ultimi 100 commenti sono osservabili', () => {
  const calls = [];
  const terminal = event({ issuedAt: Math.floor(Date.parse('2026-10-04T00:00:00Z') / 1000) });
  const fakeGh = (args) => {
    calls.push(args);
    if (args[0] === 'pr') return [{ number: 42, title: 'startup', state: 'OPEN', headRefOid: HEAD }];
    return {
      data: {
        repository: {
          pullRequest: {
            comments: {
              pageInfo: { hasPreviousPage: true },
              nodes: [comment(terminal, 1)],
            },
          },
        },
      },
    };
  };
  const result = reviewClaimHealth(fakeGh, {
    repo: 'owner/repo',
    since: '2026-10-01',
    nowMs: Date.parse('2026-10-06T12:00:00Z'),
    prLimit: 10,
  });
  assert.equal(result.measured, true);
  assert.equal(result.truncated, true);
  assert.ok(calls[0].includes('--limit') && calls[0].includes('10'));
  assert.match(calls.find((args) => args[0] === 'api').join(' '), /comments\(last:100\)/);
});

test('render e alert nominano causa/età ma non il contenuto del runner', () => {
  const stats = {
    measured: true,
    truncated: false,
    terminalCount: 1,
    byDayCause: { '2026-10-04': { startup_failure: 1 } },
    blockedHeads: [{
      prNumber: 42,
      title: 'startup',
      cause: 'startup_failure',
      ageHours: CODEX_CLAIM_HEAD_BLOCKED_HOURS + 1,
      headSha: HEAD,
    }],
  };
  const rendered = renderReviewClaimHealth(stats);
  assert.match(rendered.lines.join('\n'), /startup_failure/);
  assert.match(reviewClaimAlertBody(stats, Date.parse('2026-10-06T12:00:00Z')), /PR #42/);
  assert.doesNotMatch(reviewClaimAlertBody(stats), /sk-live|JSONL prompt/);
});
