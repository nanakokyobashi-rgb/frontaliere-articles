import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = readFileSync(
  path.join(ROOT, '.github/workflows/reconcile-article-shards.yml'),
  'utf8',
);

test('il backfill applica un timeout a ogni chiamata GitHub', () => {
  assert.match(WORKFLOW, /api_timeout_seconds=60/);
  assert.match(
    WORKFLOW,
    /timeout --kill-after=0s "\$\{api_timeout_seconds\}s" gh api "\$@"/,
  );
  assert.doesNotMatch(WORKFLOW, /^\s+gh api\b/m, 'nessuna chiamata deve bypassare il wrapper');
  assert.equal(
    (WORKFLOW.match(/gh_api_timeout(?:\s|\()/g) || []).length,
    8,
    'sette chiamate piu\u0300 la definizione devono restare protette',
  );
});
