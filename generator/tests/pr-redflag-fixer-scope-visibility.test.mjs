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
const preflight = workflow.match(/\n  preflight:\n([\s\S]*?)\n  scope:\n/)?.[1];
const scope = workflow.match(/\n  scope:\n([\s\S]*?)\n  redflag-fix:\n/)?.[1];

assert.ok(preflight, 'preflight job not found');

test('the autonomous fixer is limited to bots or fix/* branches', () => {
  const jobIf = preflight.match(/\n    if: \|\n([\s\S]*?)\n    runs-on:/)?.[1] ?? '';

  assert.ok(jobIf, 'job-level if: not found');
  assert.match(jobIf, /github\.event\.review\.user\.type == 'Bot'/);
  assert.match(jobIf, /startsWith\(github\.event\.pull_request\.head\.ref, 'fix\/'\)/);
  assert.match(preflight, /PR_AUTHOR_TYPE: \$\{\{ github\.event\.pull_request\.user\.type \}\}/);
  assert.match(
    preflight,
    /if \[ "\$PR_AUTHOR_TYPE" != "Bot" \] && ! printf '%s' "\$HEAD_REF" \| grep -q '\^fix\/'/,
  );
  assert.match(preflight, /REDFLAG_OUT_OF_SCOPE/);
  assert.match(preflight, /gh pr comment "\$PR_NUMBER"/);
  assert.match(preflight, /comments\?per_page=100"\s+--paginate/);
  assert.match(preflight, /::warning::REDFLAG_OUT_OF_SCOPE/);

  const scopeAt = preflight.indexOf('REDFLAG_OUT_OF_SCOPE');
  const branchGuardAt = preflight.indexOf('if ! gh api "repos/$REPO/branches/$HEAD_REF"');
  assert.ok(scopeAt > branchGuardAt, 'scope verdict must follow closed-PR and branch guards');
});

test('scope job is the shared declassification gate, and errors remain blocking', () => {
  assert.ok(scope, 'scope job not found');
  assert.match(scope, /node scripts\/ci\/review-scope\.mjs/);
  assert.match(scope, /blocking=true/);
  assert.match(workflow, /needs: \[preflight, scope\]/);
  assert.match(workflow, /needs\.scope\.outputs\.blocking == 'true'/);
});
