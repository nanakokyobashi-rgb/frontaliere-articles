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

test('fast-publish-article leaves upload headroom after the render', () => {
  const publish = jobBlock('publish');
  assert.match(publish, /timeout-minutes: 60/u);
  assert.match(publish, /Publish to shards and CDN/u);
});
