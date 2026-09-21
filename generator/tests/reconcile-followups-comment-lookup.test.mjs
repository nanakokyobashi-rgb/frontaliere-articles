/**
 * Regressioni #1078 item 3: un comment lookup illeggibile resta fail-open per
 * la singola issue, ma una causa persistente deve rendere il run osservabile.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  compareCodeUnitStrings,
  decideReconcileAction,
  isCommentLookupDegraded,
  isCurrentUnclassifiable,
  isUnclassifiableAggregate,
  unclassifiableIssueFingerprint,
  unclassifiableMarker,
  UNCLASSIFIABLE_MARKER_SCHEMA,
  parseIssueCommentsResponse,
} from '../../scripts/ci/reconcile-followups.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'scripts/ci/reconcile-followups.mjs'), 'utf8');

test('#1176: unclassifiable aggregate usa il parser importato e non una copia rimossa', () => {
  assert.equal(
    isUnclassifiableAggregate('follow-up(#1210): 2 items deferred — corpus', 'testo senza heading di item'),
    true,
  );
  assert.equal(
    isUnclassifiableAggregate('follow-up(#1210): 2 items deferred — corpus', '### 1. item'),
    false,
  );
});

test('#1078 item 3: hasPriorFlag null non autorizza flag o chiusura', () => {
  assert.equal(decideReconcileAction({
    resolved: true,
    hasMaybeResolved: false,
    hasPriorFlag: null,
    isAggregate: false,
    blocked: false,
    strongEvidence: true,
  }), 'none');
});

test('#1078 item 3: i fallimenti dei commenti hanno una soglia osservabile', () => {
  assert.equal(isCommentLookupDegraded(0, 10), false);
  assert.equal(isCommentLookupDegraded(2, 10, { minCount: 3, maxRatio: 0.5 }), false);
  assert.equal(isCommentLookupDegraded(3, 10, { minCount: 3, maxRatio: 0.5 }), true);
  assert.equal(
    isCommentLookupDegraded(1, 1, { minCount: 3, maxRatio: 0.5 }),
    true,
    'se ogni lookup del run fallisce, anche una sola issue non può restare invisibile',
  );
  assert.match(SOURCE, /commentLookupFailed\+\+/);
  assert.match(SOURCE, /process\.exitCode = 1/);
});

test('#8034 item 1: stdout vuoto riuscito significa lista commenti vuota', () => {
  assert.deepEqual(parseIssueCommentsResponse(''), []);
  assert.deepEqual(parseIssueCommentsResponse('  \n'), []);
  assert.deepEqual(parseIssueCommentsResponse('{"comments":[]}'), []);
  assert.deepEqual(parseIssueCommentsResponse('{"comments":[{"body":"x"}]}'), [{ body: 'x' }]);
  assert.equal(parseIssueCommentsResponse(null), null);
  assert.equal(parseIssueCommentsResponse('{not-json'), null);
});

test('#8090 item 2: il marker corrente bumpa lo schema e ignora il marker legacy nel fingerprint', () => {
  const issue = {
    title: 'follow-up(#8090): 3 items deferred — test',
    body: 'corpo non enumerato',
    labels: ['reconcile-unclassifiable'],
  };
  const human = [{ id: 'human-1', body: 'nota umana', createdAt: '2026-09-01T00:00:00Z' }];
  const legacy = { id: 'legacy-1', body: '<!-- reconcile-unclassifiable commit=old -->' };
  assert.equal(UNCLASSIFIABLE_MARKER_SCHEMA, 2);
  assert.equal(
    unclassifiableIssueFingerprint(issue, [...human, legacy]),
    unclassifiableIssueFingerprint(issue, human),
  );
  const marker = unclassifiableMarker(issue, human, { classifierVersion: 'a'.repeat(64) });
  assert.match(marker, /<!-- reconcile-unclassifiable schema=2 /);
  assert.equal(
    isCurrentUnclassifiable(issue, [...human, { ...legacy, body: marker.replace('schema=2', 'schema=1') }], { classifierVersion: 'a'.repeat(64) }),
    false,
    'un marker schema 1 non può essere la cache corrente dopo il cambio di grammatica',
  );
  assert.equal(
    isCurrentUnclassifiable(issue, [...human, { ...legacy, body: marker }], { classifierVersion: 'a'.repeat(64) }),
    true,
  );
});

test('#8090 item 1: il marker piu recente usa updatedAt con fallback a createdAt', () => {
  const issue = {
    title: 'follow-up(#8090): 3 items deferred — test',
    body: 'corpo non enumerato',
    labels: ['reconcile-unclassifiable'],
  };
  const human = [{ id: 'human-1', body: 'nota umana', createdAt: '2026-09-01T00:00:00Z' }];
  const classifierVersion = 'b'.repeat(64);
  const marker = unclassifiableMarker(issue, human, { classifierVersion });
  const wrongFingerprint = marker.replace(/fingerprint=[0-9a-f]{64}/, `fingerprint=${'0'.repeat(64)}`);
  const sameCreatedAt = '2026-09-02T00:00:00Z';
  assert.equal(
    isCurrentUnclassifiable(issue, [
      ...human,
      { id: 'a-current', body: marker, created_at: sameCreatedAt, updated_at: '2026-09-03T00:00:00Z' },
      { id: 'z-stale', body: wrongFingerprint, created_at: sameCreatedAt, updated_at: '2026-09-02T00:00:01Z' },
    ], { classifierVersion }),
    true,
  );

  assert.equal(
    isCurrentUnclassifiable(issue, [
      ...human,
      { id: 'a-stale', body: wrongFingerprint, created_at: '2026-09-02T00:00:00Z' },
      { id: 'z-current', body: marker, created_at: '2026-09-03T00:00:00Z' },
    ], { classifierVersion }),
    true,
    'senza updated_at il fallback resta created_at',
  );
});

test('#9439: il parser conserva updated_at dal REST paginato e la query usa l endpoint REST', () => {
  assert.deepEqual(
    parseIssueCommentsResponse('[[{"id":1,"created_at":"2026-09-01T00:00:00Z","updated_at":"2026-09-02T00:00:00Z"}],[{"id":2,"created_at":"2026-09-03T00:00:00Z","updated_at":"2026-09-04T00:00:00Z"}]]'),
    [
      { id: 1, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-02T00:00:00Z' },
      { id: 2, created_at: '2026-09-03T00:00:00Z', updated_at: '2026-09-04T00:00:00Z' },
    ],
  );
  assert.match(SOURCE, /const endpoint = `repos\/\$\{repository\}\/issues\/\$\{number\}\/comments`/);
  assert.match(SOURCE, /gh\(\['api', endpoint, '--paginate', '--slurp'/);
  assert.match(SOURCE, /commentField\(comment, 'updatedAt', 'updated_at'\)/);
});

test('#8090 item 3: il fingerprint ordina per code unit, non per locale', () => {
  assert.match(SOURCE, /compareCodeUnitStrings\(JSON\.stringify\(a\), JSON\.stringify\(b\)\)/);
  assert.doesNotMatch(SOURCE, /JSON\.stringify\(a\)\.localeCompare/);
  assert.equal(compareCodeUnitStrings('z', 'ä'), -1);
  assert.equal(compareCodeUnitStrings('ä', 'z'), 1);
  assert.equal(compareCodeUnitStrings('same', 'same'), 0);
});
