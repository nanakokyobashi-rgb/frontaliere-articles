import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const WORKFLOW = readFileSync(
  new URL('../../.github/workflows/issue-fix.yml', import.meta.url),
  'utf8',
);

test('il contesto B19 scrive il fallback singolo prima del primo comando fail-fast', () => {
  const stepStart = WORKFLOW.indexOf('id: group');
  const stepEnd = WORKFLOW.indexOf('id: group_context', stepStart);
  assert.ok(stepStart >= 0 && stepEnd > stepStart, 'step group non trovato');
  const step = WORKFLOW.slice(stepStart, stepEnd);
  const defaults = step.indexOf('echo "is_group=false"');
  const failFast = step.indexOf('set -euo pipefail');

  assert.ok(defaults >= 0, 'default is_group=false non scritto');
  assert.ok(defaults < failFast, 'il default deve precedere ogni abort dello step');
  assert.match(step, /echo "group_label="/);
  assert.match(step, /echo "group_numbers="/);
});

test('i consumer del contesto B19 hanno fallback espliciti', () => {
  assert.match(WORKFLOW, /ISSUE_GROUP: \$\{\{ steps\.group\.outputs\.is_group \|\| 'false' \}\}/);
  assert.match(WORKFLOW, /ISSUE_GROUP_LABEL: \$\{\{ steps\.group\.outputs\.group_label \|\| '' \}\}/);
  assert.match(WORKFLOW, /ISSUE_GROUP_NUMBERS: \$\{\{ steps\.group\.outputs\.group_numbers \|\| '' \}\}/);
  assert.match(WORKFLOW, /`group=\$\{\{ steps\.group\.outputs\.is_group \|\| 'false' \}\}`/);
});
