import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildConflictHandoffIssue,
  conflictHandoffMarker,
  shouldHandOffConflict,
} from '../../scripts/ci/pr-autorebase.mjs';

const SOURCE = readFileSync(new URL('../../scripts/ci/pr-autorebase.mjs', import.meta.url), 'utf8');
const HEAD = '685bcb73'.padEnd(40, '0');

test('passa la mano solo con LGTM e una volta per HEAD', () => {
  assert.equal(shouldHandOffConflict({ lgtm: true, alreadyHandedOff: false }), true);
  assert.equal(shouldHandOffConflict({ lgtm: false, alreadyHandedOff: false }), false);
  assert.equal(shouldHandOffConflict({ lgtm: true, alreadyHandedOff: true }), false);
});

test("il marker e' legato alla HEAD", () => {
  assert.equal(conflictHandoffMarker(HEAD), '<!-- AUTOREBASE_CONFLICT_HANDOFF head=685bcb730000 -->');
  assert.notEqual(conflictHandoffMarker('b'.repeat(40)), conflictHandoffMarker(HEAD));
});

test('la issue porta PR, branch, HEAD e file senza keyword di chiusura sulla PR', () => {
  const { title, body } = buildConflictHandoffIssue({
    num: 1597,
    branch: 'fix/corpus-sweep-lockstep-20260919',
    head: HEAD,
    files: ['.github/workflows/auto-merge-enroll-sweep.yml', 'generator/tests/auto-merge-enroll-sweep.test.mjs'],
  });
  assert.equal(title, 'Conflitto con main dopo LGTM: riapplicare la PR #1597 su main');
  assert.ok(body.includes('`fix/corpus-sweep-lockstep-20260919`'));
  assert.ok(body.includes('- `generator/tests/auto-merge-enroll-sweep.test.mjs`'));
  assert.ok(body.includes('Supersedes #1597'));
  assert.doesNotMatch(body, /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#1597\b/i);
});

test('ogni ramo che abortisce un conflitto non auto-risolvibile passa la mano', () => {
  const handed = SOURCE.match(/ensureStaleLabel\(num\);\n\s+commentConflictOnce\(num, branch\);\n\s+handOffConflictToFixer\(num, branch, head, lgtm\);/g) || [];
  const bare = SOURCE.match(/commentConflictOnce\(num, branch\);/g) || [];
  assert.equal(handed.length, 3);
  assert.equal(bare.length, handed.length);
});

test('la issue salta il triage e riceve agent:fix con un evento separato', () => {
  assert.ok(SOURCE.includes("'--label', 'agent:triaged'"));
  assert.match(SOURCE, /'issue', 'edit', issue, '--repo', REPO, '--add-label', 'agent:fix'/);
});
