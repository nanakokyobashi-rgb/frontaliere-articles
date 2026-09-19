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
const NATIVE_WORKFLOW = path.join(ROOT, '.github/workflows/enable-native-automerge.yml');
const source = fs.readFileSync(WORKFLOW, 'utf8');
const nativeSource = fs.readFileSync(NATIVE_WORKFLOW, 'utf8');

function downloaderBlock(workflow) {
  const start = workflow.indexOf('download_and_check() {');
  const end = workflow.indexOf('\n          }', start);
  return start >= 0 && end > start ? workflow.slice(start, end) : '';
}

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

test('#1604: anche il fallback periodico ritenta il bootstrap senza aprire un percorso fail-open', () => {
  const start = source.indexOf('download_and_check() {');
  const end = source.indexOf('\n\n          download_and_check \\\n', start);
  assert.ok(start >= 0 && end > start, 'helper downloader block non trovato');
  const downloader = source.slice(start, end);
  assert.match(downloader, /for attempt in 1 2 3/);
  assert.match(downloader, /> "\$destination" 2> "\$error_file"/);
  assert.match(downloader, /timeout/);
  assert.match(downloader, /deadline\[\[:space:\]\.\_-\]\*exceeded/);
  assert.match(downloader, /timed\[\[:space:\]\.\_-\]\*out/);
  assert.match(downloader, /HTTP 429/);
  assert.match(downloader, /rate limit exceeded/);
  assert.match(downloader, /secondary rate limit/);
  assert.doesNotMatch(downloader, /HTTP 403/);
  assert.match(downloader, /HTTP 5\[0-9\]\[0-9\]/);
  assert.match(downloader, /\[ "\$attempt" -eq 3 \] \|\| ! grep/);
  assert.match(downloader, /sleep "\$\(\(attempt \* 5\)\)"/);
  assert.match(downloader, /return 1\b/);
  assert.match(source, /download_and_check \\\n\s+'generator\/scripts\/load-rc-env\.mjs' "\$helper_dir\/load-rc-env\.mjs"/);
});

test('#1604: i due ingressi dell auto-merge usano lo stesso downloader', () => {
  assert.equal(downloaderBlock(source), downloaderBlock(nativeSource));
});
