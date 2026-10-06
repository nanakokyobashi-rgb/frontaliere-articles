import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatRateLimitBudget,
  rateLimitBuckets,
} from '../../scripts/ci/report-rate-limit-budget.mjs';

test('rate_limit response is reduced to the named buckets without exposing a token', () => {
  const buckets = rateLimitBuckets(JSON.stringify({
    resources: {
      core: { limit: 5000, used: 17, remaining: 4983, reset: 1234567890 },
      graphql: { limit: 5000, used: 4, remaining: 4996, reset: 1234567890 },
    },
  }));
  assert.deepEqual(buckets.core, { limit: 5000, used: 17, remaining: 4983, reset: 1234567890 });
  assert.equal(buckets.graphql.remaining, 4996);
});

test('budget output has a stable grep-able shape and redacts invalid names', () => {
  const line = formatRateLimitBudget({
    workflow: 'stale-pr-rescuer',
    token: 'GITHUB_PAT_NANAKO',
    resource: 'core',
    bucket: { limit: 5000, used: 17, remaining: 4983, reset: 1234567890 },
  });
  assert.equal(
    line,
    'RATE_LIMIT_BUDGET workflow=stale-pr-rescuer used=17 remaining=4983 limit=5000 token=GITHUB_PAT_NANAKO resource=core reset=1234567890',
  );
  assert.doesNotMatch(line, /token-value|secret/i);
  assert.match(formatRateLimitBudget({ workflow: 'bad name', token: 'x/y', resource: 'core', bucket: {} }), /workflow=unknown[\s\S]*token=unknown/);
  assert.match(formatRateLimitBudget({ workflow: 'w', token: 't', resource: 'core', bucket: { reset: null } }), /reset=unknown/);
});
