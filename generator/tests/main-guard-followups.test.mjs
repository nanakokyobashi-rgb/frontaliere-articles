import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRYPOINTS = [
  'generator/scripts/load-rc-env.mjs',
  'generator/scripts/lib/provider-preflight.mjs',
  'generator/scripts/retranslate-blocking-bodies.mjs',
  'generator/scripts/reset-evergreen-strikes.mjs',
  'generator/scripts/scan-vacuous-key-facts.mjs',
  'scripts/seo/bing-seo-loop.mjs',
  'scripts/lib/merge-content-registry-conflict.mjs',
  'scripts/reconcile-article-shards.mjs',
  'scripts/find-dirty-content-ids.mjs',
];

test('i producer/repairer del follow-up canonicalizzano entrambi i lati del main-guard', () => {
  for (const relativePath of ENTRYPOINTS) {
    const source = readFileSync(path.join(ROOT, relativePath), 'utf8');
    const guard = source.slice(source.lastIndexOf('const invokedDirectly'));

    assert.match(guard, /realpathSync\(fileURLToPath\(import\.meta\.url\)\)/, relativePath);
    assert.match(guard, /realpathSync\(process\.argv\[1\]\s*\|\|\s*['"]['"]\)/, relativePath);
    assert.doesNotMatch(guard, /pathToFileURL\(process\.argv\[1\]/, relativePath);
    assert.doesNotMatch(guard, /path\.resolve\(process\.argv\[1\]\)/, relativePath);
  }
});
