/**
 * Regressioni per l'enrollment periodico dell'auto-merge nativo.
 * Il workflow non va eseguito dai test: la policy pura usata dal workflow
 * valida la scansione senza trasformare una pagina persa o una risposta API
 * fallita in una coda vuota, e mantiene il filtro base/head esplicito.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { enrollablePullRequestNumbers } from '../../scripts/ci/native-automerge-sweep-policy.mjs';

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
  assert.match(source, /native-automerge-sweep-policy\.mjs/);
  assert.match(source, /--enroll "\$pages_file"/);
  assert.match(source, /'scripts\/ci\/native-automerge-gate\.mjs\|native-automerge-gate\.mjs'/);
  assert.match(source, /source_path="\$\{spec%%\|\*\}"/);
  assert.match(source, /GH_TOKEN="\$GITHUB_PAT_NANAKO" node "\$NATIVE_AUTOMERGE_HELPER_DIR\/native-automerge-gate\.mjs"/);
  assert.doesNotMatch(source, /gh pr merge/, 'lo sweep non deve avere un decisore di merge separato dal gate trusted');
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

const pullRequest = (overrides = {}) => ({
  number: 42,
  draft: false,
  auto_merge: null,
  base: { ref: 'main' },
  head: { ref: 'feature' },
  ...overrides,
});

test('il filtro sweep applica base/head e fallisce chiuso su shape incompleto', () => {
  const cases = [
    {
      name: 'PR main normale',
      payload: [[pullRequest()]],
      expected: [42],
    },
    {
      name: 'PR su base diversa',
      payload: [[pullRequest({ base: { ref: 'release' } })]],
      expected: [],
    },
    {
      name: 'PR lockstep esclusa dal percorso generico',
      payload: [[pullRequest({ head: { ref: 'engine-lockstep-auto' } })]],
      expected: [],
    },
    {
      name: 'draft esclusa',
      payload: [[pullRequest({ draft: true })]],
      expected: [],
    },
    {
      name: 'PR già arruolata esclusa',
      payload: [[pullRequest({ auto_merge: { merge_method: 'squash' } })]],
      expected: [],
    },
    {
      name: 'pagine vuote valide',
      payload: [[], []],
      expected: [],
    },
  ];

  for (const { name, payload, expected } of cases) {
    assert.deepEqual(enrollablePullRequestNumbers(payload), expected, name);
  }

  const noAutoMerge = pullRequest();
  delete noAutoMerge.auto_merge;
  const malformed = [
    ['payload non-array', null],
    ['pagina non-array', [{}]],
    ['PR non-object', [[null]]],
    ['PR senza base/head', [[{ number: 42, draft: false, auto_merge: null }]]],
    ['PR senza auto_merge', [[noAutoMerge]]],
  ];
  for (const [name, payload] of malformed) {
    assert.throws(() => enrollablePullRequestNumbers(payload), TypeError, name);
  }
});

test('il tree helper scaricato dallo sweep si importa senza dipendenze omesse', async () => {
  const helperRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'frontaliere-native-gate-'));
  fs.mkdirSync(path.join(helperRoot, 'lib'));
  const files = [
    ['scripts/ci/native-automerge-gate.mjs', 'native-automerge-gate.mjs'],
    ['scripts/ci/review-test-policy.mjs', 'review-test-policy.mjs'],
    ['scripts/ci/lib/fetchPrFiles.mjs', 'lib/fetchPrFiles.mjs'],
    ['scripts/ci/lib/constants.mjs', 'lib/constants.mjs'],
    ['scripts/ci/native-automerge-sweep-policy.mjs', 'native-automerge-sweep-policy.mjs'],
  ];
  try {
    for (const [from, to] of files) {
      fs.copyFileSync(path.join(ROOT, from), path.join(helperRoot, to));
    }
    const suffix = `?fixture=${Date.now()}-${Math.random()}`;
    const gate = await import(`${pathToFileURL(path.join(helperRoot, 'native-automerge-gate.mjs')).href}${suffix}`);
    const policy = await import(`${pathToFileURL(path.join(helperRoot, 'native-automerge-sweep-policy.mjs')).href}${suffix}`);
    assert.equal(typeof gate.evaluateNativeAutoMerge, 'function');
    assert.equal(typeof gate.nativeAutoMergeArgs, 'function');
    assert.equal(typeof policy.enrollablePullRequestNumbers, 'function');
    assert.equal(typeof policy.requiredCheckDecision, 'function');
    assert.equal(typeof policy.allChecksDecision, 'function');
  } finally {
    fs.rmSync(helperRoot, { recursive: true, force: true });
  }
});
