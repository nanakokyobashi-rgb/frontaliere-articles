/**
 * Regressioni statiche per l'enrollment periodico dell'auto-merge nativo.
 * Il workflow non va eseguito dai test: la proprietà da sorvegliare è che la
 * scansione non trasformi una pagina persa o una risposta API fallita in una
 * coda vuota.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const WORKFLOW = path.join(ROOT, '.github/workflows/auto-merge-enroll-sweep.yml');
const source = fs.readFileSync(WORKFLOW, 'utf8');

test('#1139: auto-merge sweep usa REST paginata e fallisce chiuso sulla lettura', () => {
  assert.match(source, /if ! gh api --paginate --slurp/);
  assert.match(source, /repos\/\$\{REPO\}\/pulls\?state=open&per_page=100/);
  assert.match(source, /pages_file=/);
  assert.match(source, /if ! prs="\$\(jq -r/);
  assert.match(source, /type != "array"/);
  assert.match(source, /any\(\.\[\]; type != "array"\)/);
  assert.match(source, /\.auto_merge == null/);
  assert.match(source, /echo "::error::lettura paginata/);
  assert.match(source, /echo "::error::payload REST paginato/);
  assert.doesNotMatch(source, /^\s*prs=\$\(gh pr list/m);
  assert.doesNotMatch(source, /^\s*--limit 200/m);
  assert.doesNotMatch(source, /^\s*.*\|\| true/m);
});
