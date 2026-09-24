/**
 * report-node-test-failure-publish.test.mjs — il publisher sticky non deve
 * perdere in silenzio il proprio fallimento (fork/403).
 *
 * `report-node-test-failure.mjs` pubblica un commento sticky con i test
 * `node:test` falliti. Quando `gh` fallisce (PR da fork, `GITHUB_TOKEN` in
 * sola lettura → 403), lo script deve restare osservabile: un `::warning` su
 * stdout, il body già costruito scritto su `$GITHUB_STEP_SUMMARY` quando la
 * variabile esiste, ed exit 0 (il reporter è best-effort e non deve aggiungere
 * un secondo rosso al gate `tests`, che ha già `continue-on-error: true`).
 *
 * Esegue lo script come processo figlio con un `gh` finto anteposto al PATH,
 * cosi' copre il comportamento reale (non solo `buildComment`, gia' testato
 * altrove).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts/ci/report-node-test-failure.mjs');

const REPORT_FIXTURE = {
  failedTests: 1,
  failedSuites: 1,
  failures: [
    { file: 'generator/tests/example.test.mjs', line: 12, test: 'esempio fallito', error: 'AssertionError: atteso true' },
  ],
  suiteFailures: [],
};

function makeFakeGh(dir, exitCode) {
  const ghPath = path.join(dir, 'gh');
  fs.writeFileSync(
    ghPath,
    `#!/bin/sh\necho "fake gh stub: simulated failure (403)" 1>&2\nexit ${exitCode}\n`,
  );
  fs.chmodSync(ghPath, 0o755);
  return dir;
}

function runScript({ ghExitCode, withSummary }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'report-node-test-failure-'));
  const binDir = path.join(tmp, 'bin');
  fs.mkdirSync(binDir);
  makeFakeGh(binDir, ghExitCode);

  const reportFile = path.join(tmp, 'report.json');
  fs.writeFileSync(reportFile, JSON.stringify(REPORT_FIXTURE));

  const summaryFile = withSummary ? path.join(tmp, 'summary.md') : '';
  if (withSummary) fs.writeFileSync(summaryFile, '');

  const env = {
    ...process.env,
    FORCE_COLOR: '',
    PATH: `${binDir}:${process.env.PATH}`,
    PR_NUMBER: '123',
    GH_REPO: 'nanakokyobashi-rgb/frontaliere-articles',
    NODE_TEST_REPORT_FILE: reportFile,
    RUN_URL: '',
    RUN_ID: '',
    HEAD_SHA: '',
  };
  delete env.FORCE_COLOR;
  if (withSummary) env.GITHUB_STEP_SUMMARY = summaryFile;
  else delete env.GITHUB_STEP_SUMMARY;

  let stdout = '';
  let exitCode = 0;
  try {
    stdout = execFileSync('node', [SCRIPT], { encoding: 'utf8', env });
  } catch (err) {
    stdout = String(err.stdout || '');
    exitCode = typeof err.status === 'number' ? err.status : 1;
  }

  const summaryContent = withSummary ? fs.readFileSync(summaryFile, 'utf8') : '';
  return { stdout, exitCode, summaryContent };
}

test('gh fallito (403 simulato): warning su stdout, summary scritto, exit 0', () => {
  const { stdout, exitCode, summaryContent } = runScript({ ghExitCode: 1, withSummary: true });

  assert.equal(exitCode, 0, `lo script deve uscire 0 anche se \`gh\` fallisce; stdout:\n${stdout}`);
  assert.match(stdout, /::warning title=node:test failure report::/, 'manca il warning osservabile su stdout');
  assert.match(stdout, /#123/, 'il warning deve citare il numero della PR');
  assert.match(summaryContent, /<!-- node-test-failure-report -->/, 'il body del report non è finito nel GITHUB_STEP_SUMMARY');
  assert.match(summaryContent, /esempio fallito/, 'il dettaglio dei test falliti non è nel summary');
});

test('gh fallito senza GITHUB_STEP_SUMMARY in ambiente: warning comunque, nessun crash, exit 0', () => {
  const { stdout, exitCode } = runScript({ ghExitCode: 1, withSummary: false });

  assert.equal(exitCode, 0);
  assert.match(stdout, /::warning title=node:test failure report::/);
});

test('gh riuscito: nessun warning, nessuna scrittura su summary, exit 0', () => {
  const { stdout, exitCode, summaryContent } = runScript({ ghExitCode: 0, withSummary: true });

  assert.equal(exitCode, 0);
  assert.doesNotMatch(stdout, /::warning/, 'non deve comparire un warning quando la pubblicazione riesce');
  assert.equal(summaryContent, '', 'il summary non va toccato quando la pubblicazione riesce');
  assert.match(stdout, /pubblicato\/aggiornato/);
});
