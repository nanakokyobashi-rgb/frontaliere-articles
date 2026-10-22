import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(
  new URL('../../.github/workflows/fast-publish-section.yml', import.meta.url),
  'utf8',
);

function triggerBlock(name) {
  const start = workflow.indexOf(`\n  ${name}:`);
  assert.ok(start >= 0, `trigger ${name} missing`);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n  [A-Za-z_][A-Za-z0-9_-]*:/u);
  return next < 0 ? rest : rest.slice(0, next);
}

test('fast-publish-section non crea run push sui branch di PR', () => {
  const push = triggerBlock('push');
  assert.match(push, /\n    branches: \[main\]/u);
  assert.doesNotMatch(push, /branches-ignore/u);
  assert.doesNotMatch(workflow.slice(workflow.indexOf('\non:')), /\n  pull_request:/u);
});

test('fast-publish-section limita i replay workflow_run a publish-api verde su main', () => {
  const run = triggerBlock('workflow_run');
  assert.match(run, /workflows: \['Publish article data API'\]/u);
  assert.match(run, /types: \[completed\]/u);
  assert.match(run, /branches: \[main\]/u);

  const resolve = workflow.slice(workflow.indexOf('\n  resolve:'), workflow.indexOf('\n  plan:'));
  assert.match(resolve, /github\.event\.workflow_run\.conclusion == 'success'/u);
  assert.match(resolve, /github\.event\.workflow_run\.head_branch == 'main'/u);
});

test('fast-publish-section mantiene il contratto dispatch esplicito', () => {
  const dispatch = triggerBlock('workflow_dispatch');
  assert.match(dispatch, /section:/u);
  assert.match(dispatch, /required: true/u);
  assert.match(dispatch, /bootstrap:/u);
  assert.match(dispatch, /push_before:/u);
  assert.match(dispatch, /push_after:/u);
});
