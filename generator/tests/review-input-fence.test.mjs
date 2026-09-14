import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reviewInputContextFromPullRequest,
  reviewInputContextMatches,
  reviewInputRevisionForBody,
} from '../../scripts/ci/review-test-policy.mjs';

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const BODY = '## Implementato\n- una modifica';
const REVISION = reviewInputRevisionForBody(BODY);

test('la fence conserva HEAD e hash del body nello stesso snapshot', () => {
  const context = reviewInputContextFromPullRequest({
    head: { sha: HEAD.toUpperCase() },
    body: BODY,
  });

  assert.deepEqual(context, { headSha: HEAD, reviewRevision: REVISION });
  assert.equal(reviewInputContextMatches(context, {
    headSha: HEAD,
    reviewRevision: REVISION,
  }), true);
});

test('la fence rifiuta sia una HEAD nuova sia un body revisionato', () => {
  const context = reviewInputContextFromPullRequest({ head: { sha: HEAD }, body: BODY });
  const changedBody = reviewInputContextFromPullRequest({
    head: { sha: OTHER_HEAD },
    body: `${BODY}\n- edit concorrente`,
  });

  assert.equal(reviewInputContextMatches(changedBody, {
    headSha: HEAD,
    reviewRevision: REVISION,
  }), false);
  assert.equal(reviewInputContextMatches(context, {
    headSha: OTHER_HEAD,
    reviewRevision: REVISION,
  }), false);
});

test('snapshot malformati non diventano una revisione verificata', () => {
  for (const payload of [
    null,
    {},
    { head: { sha: 'not-a-sha' }, body: BODY },
    { head: { sha: HEAD }, body: 42 },
    { head: { sha: HEAD } },
  ]) {
    assert.equal(reviewInputContextFromPullRequest(payload), null);
  }
  assert.equal(reviewInputRevisionForBody(null), null);
});
