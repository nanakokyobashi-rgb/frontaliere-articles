import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderClaimHealth,
  summarizeFailedTerminalClaims,
} from '../../scripts/ci/review-claim-health.mjs';
import {
  REVIEW_CLAIM_MARKER,
  reviewClaimDedupeKey,
  reviewClaimKey,
} from '../../scripts/ci/review-claim.mjs';

const HEAD = 'a'.repeat(40);
const FINGERPRINT = 'b'.repeat(64);

function claimComment({ state = 'failed-terminal', createdAt, causeClass, startupFailure } = {}) {
  const context = {
    prNumber: '2280',
    headSha: HEAD,
    eventKey: `run:${createdAt}`,
    contributionFingerprint: FINGERPRINT,
  };
  const event = {
    version: 1,
    token: `review-${createdAt}`,
    ...context,
    key: reviewClaimKey(context),
    dedupeKey: reviewClaimDedupeKey(context),
    state,
    issuedAt: Date.parse(createdAt) / 1000,
    expiresAt: Date.parse(createdAt) / 1000 + 3600,
    runId: '42',
    ...(causeClass ? { causeClass } : {}),
    ...(startupFailure === undefined ? {} : { startupFailure }),
  };
  return {
    html_url: `https://github.com/owner/repo/pull/2280#issuecomment-${createdAt}`,
    created_at: createdAt,
    body: `${REVIEW_CLAIM_MARKER} ${JSON.stringify(event)} -->`,
  };
}

test('aggrega i failed-terminal per giorno UTC e classe di causa', () => {
  const stats = summarizeFailedTerminalClaims([
    claimComment({ createdAt: '2026-10-05T23:59:00Z', causeClass: 'http-5xx' }),
    claimComment({ createdAt: '2026-10-06T00:01:00Z', causeClass: 'unknown' }),
    claimComment({ createdAt: '2026-10-06T00:02:00Z', causeClass: 'config-error' }),
    claimComment({ createdAt: '2026-10-06T00:03:00Z', state: 'failed-transient', causeClass: 'startup-failure' }),
    {
      ...claimComment({ createdAt: '2026-10-06T00:04:00Z', causeClass: 'http-5xx' }),
      html_url: 'https://github.com/owner/repo/issues/17#issuecomment-1',
    },
  ], { since: '2026-10-05' });

  assert.deepEqual(stats.byDay, {
    '2026-10-05': { 'http-5xx': 1 },
    '2026-10-06': { 'config-error': 1, unknown: 1 },
  });
  assert.equal(stats.total, 3);
  const report = renderClaimHealth(stats, '2026-10-05');
  assert.match(report, /2026-10-06.*config-error.*1/u);
  assert.match(report, /Totale claim failed-terminal:\*\* 3/u);
});

test('un commento non leggibile non viene trasformato in una causa inventata', () => {
  const stats = summarizeFailedTerminalClaims([
    { html_url: 'https://github.com/owner/repo/pull/2280#issuecomment-1', created_at: '2026-10-06T00:00:00Z', body: '<!-- PR_REVIEW_CLAIM: not-json -->' },
  ], { since: '2026-10-06' });
  assert.deepEqual(stats.byDay, {});
  assert.equal(stats.total, 0);
});
