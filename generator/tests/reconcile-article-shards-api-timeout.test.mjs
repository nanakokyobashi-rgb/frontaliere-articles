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
  assert.match(WORKFLOW, /GH_API_TIMEOUT_SECONDS: \$\{\{ vars\.GH_API_TIMEOUT_SECONDS \}\}/);
  assert.match(WORKFLOW, /api_timeout_seconds="\$\{GH_API_TIMEOUT_SECONDS:-60\}"/);
  assert.match(WORKFLOW, /api_kill_after_seconds=5/);
  assert.match(WORKFLOW, /api_timeout_seconds=60/);
  assert.match(WORKFLOW, /api_timeout_seconds="\$\{api_timeout_seconds#"\$\{api_timeout_seconds%%\[!0\]\*\}"\}"/);
  assert.match(WORKFLOW, /\[ "\$\{#api_timeout_seconds\}" -le 3 \]/);
  assert.match(
    WORKFLOW,
    /timeout --kill-after="\$\{api_kill_after_seconds\}s" "\$\{api_timeout_seconds\}s" gh api "\$@"/,
  );
  assert.match(
    WORKFLOW,
    /if ! gh_api_timeout -X POST "repos\/\$GITHUB_REPOSITORY\/actions\/workflows\/\$WF\/dispatches"/,
    'il dispatch deve degradare a lost senza terminare il backfill',
  );
  assert.match(
    WORKFLOW,
    /printf '%s\\t%s\\t%s\\n' "\$id" "\$section" "lost" >> "\$results"/,
    'un dispatch fallito deve finire nei risultati e nel conteggio failed',
  );
  assert.doesNotMatch(WORKFLOW, /^\s+gh api\b/m, 'nessuna chiamata deve bypassare il wrapper');
  assert.equal(
    (WORKFLOW.match(/gh_api_timeout(?:\s|\()/g) || []).length,
    8,
    'sette chiamate piu\u0300 la definizione devono restare protette',
  );
});
