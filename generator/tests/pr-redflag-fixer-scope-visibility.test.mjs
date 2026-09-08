/**
 * The PR scope filter must produce an observable preflight verdict.
 *
 * A job-level scope predicate makes GitHub mark the whole job as `skipped`
 * before any comment, label, or annotation can explain the decision.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/pr-redflag-fixer.yml'), 'utf8');
const preflight = workflow.match(/\n  preflight:\n([\s\S]*?)\n  redflag-fix:\n/)?.[1];

assert.ok(preflight, 'preflight job not found');

test('a human PR with a red Important is not filtered at job level', () => {
  const jobIf = preflight.match(/\n    if: \|\n([\s\S]*?)\n    runs-on:/)?.[1] ?? '';

  assert.doesNotMatch(jobIf, /github\.event\.pull_request\.user\.type/);
  assert.doesNotMatch(jobIf, /github\.event\.pull_request\.head\.ref/);
  assert.match(preflight, /PR_AUTHOR_TYPE: \$\{\{ github\.event\.pull_request\.user\.type \}\}/);
  assert.match(
    preflight,
    /if \[ "\$PR_AUTHOR_TYPE" != "Bot" \] && ! printf '%s' "\$HEAD_REF" \| grep -q '\^fix\/'/,
  );
  assert.match(preflight, /REDFLAG_OUT_OF_SCOPE/);
  assert.match(preflight, /gh pr comment "\$PR_NUMBER"/);
});
