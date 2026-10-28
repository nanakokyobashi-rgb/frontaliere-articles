/**
 * The publish matrix needs one exact pre-push commit, not the whole corpus
 * history. Run with `node --test`.
 *
 * The resolve job owns the full-history high-water check. Repeating that
 * unshallow on every shard wastes the bounded publish budget and can fail
 * before rendering when the corpus checkout is large or GitHub is slow.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(resolve(here, '../../.github/workflows/fast-publish-article.yml'), 'utf8');

test('publish fetches only PUSH_BEFORE instead of unshallowing every shard', () => {
  const start = workflow.indexOf('- name: Fetch push base (publish)');
  const end = workflow.indexOf('- name: Download resolved article plan', start);
  assert.ok(start >= 0, 'publish push-base step not found');
  assert.ok(end > start, 'publish push-base step boundary not found');

  const step = workflow.slice(start, end);
  assert.match(
    step,
    /REQUIRE_FULL_HISTORY:\s*['"]false['"]/,
    'the publish matrix must not repeat the resolve job\'s full-history fetch',
  );
  assert.match(step, /PUSH_BEFORE:\s*\$\{\{\s*github\.event\.before\s*\}\}/);
  assert.match(step, /fetch-push-base-if-missing\.sh/);
});
