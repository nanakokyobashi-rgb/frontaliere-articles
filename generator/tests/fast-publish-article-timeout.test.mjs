import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const workflow = readFileSync(
  new URL('../../.github/workflows/fast-publish-article.yml', import.meta.url),
  'utf8',
);

function jobBlock(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `job ${name} missing`);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n  [A-Za-z_][A-Za-z0-9_-]*:\n/u);
  return next < 0 ? rest : rest.slice(0, next);
}

test('fast-publish-article leaves bounded headroom for the measured upload', () => {
  const publish = jobBlock('publish');
  assert.match(publish, /timeout-minutes: 120/u);
  assert.match(publish, /Publish to shards and CDN/u);
});

test('the initial Pages wait stays inside the shared recovery budget', () => {
  const waitStep = workflow.slice(
    workflow.indexOf('- name: Wait for GitHub Pages origin to serve published content'),
    workflow.indexOf('- name: Purge the edge cache for what was published'),
  );
  assert.match(waitStep, /FAST_PUBLISH_PAGES_WAIT_SECONDS \|\| '600'/u);
  assert.match(waitStep, /continue-on-error: true/u);
  assert.match(workflow, /PAGES_BUILD_WAIT_BUDGET_SECONDS=600/u);
});
