import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildComment } from '../../scripts/ci/report-node-test-failure.mjs';
import {
  buildReport,
  describeError,
  normalizeFailure,
  recordStdoutWrite,
} from '../../scripts/ci/node-test-failure-reporter.mjs';
import { findStdoutWriters } from '../../scripts/ci/check-node-test-stdout.mjs';
import { routeInfoLogsToStderr } from './lib/stdout-off-runner-pipe.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = path.join(REPO, '.github', 'workflows', 'tests.yml');
const LIST_LINE = 'files=$(node scripts/ci/list-pr-gate-tests.mjs)';

test('il reporter strutturato conserva file, riga, nome ed errore', () => {
  const failure = normalizeFailure({
    file: 'generator/tests/example.test.mjs',
    line: 12,
    name: 'suite fails',
    type: 'test',
    details: { error: { stack: 'AssertionError: expected 1 to be 2' } },
  });
  const report = buildReport([failure], []);

  assert.deepEqual(report, {
    failedTests: 1,
    failedSuites: 0,
    failures: [failure],
    suiteFailures: [],
    stdoutWriters: [],
  });
});

test('il commento della PR espone il test fallito e il link alla run', () => {
  const body = buildComment({
    failedTests: 1,
    failedSuites: 1,
    failures: [{
      file: 'generator/tests/example.test.mjs',
      line: 12,
      test: 'suite fails',
      error: 'AssertionError: expected 1 to be 2',
    }],
    suiteFailures: [],
  }, {
    runUrl: 'https://github.com/o/r/actions/runs/42',
    runId: '42',
    headSha: 'abcdef123456789',
  });

  assert.match(body, /node-test-failure-report/);
  assert.match(body, /generator\/tests\/example\.test\.mjs:12/);
  assert.match(body, /suite fails/);
  assert.match(body, /AssertionError/);
  assert.match(body, /actions\/runs\/42/);
});

test('un details.error senza stack ne message non degrada a [object Object] (#1764)', () => {
  for (const error of [{}, { stack: {} }, Object.create(null), { code: 'X' }]) {
    const failure = normalizeFailure({ file: 'a.test.mjs', name: 'n', details: { error } });
    assert.notEqual(failure.error, '[object Object]');
    assert.doesNotMatch(failure.error, /\[object Object\]/);
    assert.match(failure.error, /senza stack ne' message/);
  }
  assert.match(describeError({ code: 'X' }), /code: 'X'/, 'la forma dell\'oggetto deve restare leggibile');
  assert.equal(describeError(42), 'valore non-Error lanciato (number): 42');
});

test('ERR_TEST_FAILURE viene srotolato fino al cause che porta file e riga', () => {
  const cause = new Error('Expected values to be strictly equal');
  cause.stack = 'AssertionError: Expected values\n    at file:///x/example.test.mjs:3:37';
  const wrapper = Object.assign(new Error('Expected values to be strictly equal'), {
    code: 'ERR_TEST_FAILURE',
    failureType: 'testCodeFailure',
    cause,
  });
  assert.match(describeError(wrapper), /example\.test\.mjs:3:37/);
  const emptyCause = Object.assign(new Error('{}'), { code: 'ERR_TEST_FAILURE', cause: {} });
  assert.match(describeError(emptyCause), /senza stack ne' message \(Object\): \{\}/);
});

/**
 * Il blocco `run:` VERO dello step `unit_gates` di tests.yml. Nessun parser
 * YAML nel corpus: il blocco e' l'ultima chiave dello step e ha indentazione
 * uniforme. La lista dei file viene sostituita con le fixture; tutto il resto
 * (reporter, doppia destinazione, controllo del file) e' quello di produzione.
 */
function unitGatesRunBlock() {
  const lines = fs.readFileSync(WORKFLOW, 'utf8').split('\n');
  const idAt = lines.findIndex((l) => /^\s*id:\s*unit_gates\s*$/.test(l));
  assert.ok(idAt > 0, 'lo step `id: unit_gates` deve esistere in tests.yml');
  const runAt = lines.findIndex((l, i) => i > idAt && /^\s*run:\s*\|\s*$/.test(l));
  assert.ok(runAt > idAt, 'lo step unit_gates deve avere un blocco `run: |`');
  const bodyIndent = (lines[runAt + 1].match(/^\s*/) || [''])[0].length;
  const out = [];
  for (let i = runAt + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.trim() === '') { out.push(''); continue; }
    const indent = (l.match(/^\s*/) || [''])[0].length;
    if (indent < bodyIndent) break;
    out.push(l.slice(bodyIndent));
  }
  const block = out.join('\n');
  assert.equal(block.split(LIST_LINE).length, 2, 'la riga della lista file deve comparire una volta sola');
  return block.replace(LIST_LINE, 'files="$FIXTURE_FILES"');
}

function runUnitGates(fixtures, { reportFile, block = unitGatesRunBlock() }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-test-reporter-'));
  const files = Object.entries(fixtures).map(([name, source]) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, source);
    return file;
  });
  // `node --test` annidato: senza togliere NODE_TEST_CONTEXT il figlio si
  // crede un worker del runner esterno e salta i file («run() is being called
  // recursively»), cioe' non esegue niente.
  const env = { ...process.env, FIXTURE_FILES: files.join(' '), NODE_TEST_REPORT_FILE: reportFile };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const result = spawnSync('bash', ['-c', block], { cwd: REPO, encoding: 'utf8', env });
  return { ...result, dir };
}

const FAILING_FIXTURE = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "test('lancia un oggetto vuoto', () => { throw {}; });",
  "test('asserzione rossa', () => { assert.equal(1, 2); });",
  "test('verde', () => {});",
  '',
].join('\n');

test('tests.yml: con exit non-zero e doppia destinazione il JSON e\' scritto e informativo (#1764)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'node-test-report-out-'));
  const reportFile = path.join(tmp, 'nested', 'node-test-failures.json');
  const run = runUnitGates({ 'fixture-failing.mjs': FAILING_FIXTURE }, { reportFile });
  try {
    assert.notEqual(run.status, 0, `il gate deve restare rosso; stderr:\n${run.stderr}`);
    assert.match(run.stdout, /asserzione rossa/, 'il reporter spec deve restare su stdout');
    assert.ok(fs.existsSync(reportFile), 'il report JSON deve esistere dopo l\'uscita con errore');
    const raw = fs.readFileSync(reportFile, 'utf8');
    assert.ok(raw.trim().length > 0, 'il report JSON non deve essere vuoto');
    assert.doesNotMatch(raw, /\[object Object\]/);
    const report = JSON.parse(raw);
    assert.equal(report.failedTests, 2);
    const byName = Object.fromEntries(report.failures.map((f) => [f.test, f]));
    assert.match(byName['lancia un oggetto vuoto'].error, /\{\}/);
    assert.match(byName['asserzione rossa'].error, /fixture-failing\.mjs:\d+:\d+/,
      'l\'errore deve portare file e riga dal cause di ERR_TEST_FAILURE');
    assert.doesNotMatch(run.stderr, /::error::node-test-failure-reporter/);
  } finally {
    fs.rmSync(run.dir, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('tests.yml: un report stantio non sopravvive e un reporter muto rende il gate rosso', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'node-test-report-out-'));
  const reportFile = path.join(tmp, 'node-test-failures.json');
  const passing = { 'fixture-passing.mjs': "import { test } from 'node:test';\ntest('ok', () => {});\n" };
  const stale = JSON.stringify({ failedTests: 7, failedSuites: 0, failures: [], suiteFailures: [] });
  try {
    fs.writeFileSync(reportFile, stale);
    const green = runUnitGates(passing, { reportFile });
    fs.rmSync(green.dir, { recursive: true, force: true });
    assert.equal(green.status, 0, `stderr:\n${green.stderr}`);
    assert.equal(JSON.parse(fs.readFileSync(reportFile, 'utf8')).failedTests, 0,
      'il file deve essere quello di questa run, non quello rimasto');

    const muteReporter = path.join(tmp, 'mute-reporter.mjs');
    fs.writeFileSync(muteReporter, 'export default async function* (source) { for await (const _ of source) {} }\n');
    const reporterFlag = '--test-reporter=./scripts/ci/node-test-failure-reporter.mjs';
    const block = unitGatesRunBlock();
    assert.ok(block.includes(reporterFlag), 'il reporter strutturato deve essere quello del repo');
    fs.writeFileSync(reportFile, stale);
    const mute = runUnitGates(passing, {
      reportFile,
      block: block.replace(reporterFlag, `--test-reporter=${muteReporter}`),
    });
    fs.rmSync(mute.dir, { recursive: true, force: true });
    assert.notEqual(mute.status, 0, 'test verdi ma report assente: il gate deve essere rosso');
    assert.match(mute.stderr, /::error::node-test-failure-reporter non ha scritto/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── stdout fuori protocollo: il prerequisito di «Unable to deserialize» ──────
//
// Issue 1819: con l'isolamento a processo il figlio serializza i frame del
// runner su STDOUT, e su Node 22 un `console.log` accanto a un header spezzato
// fra due letture della pipe fa fallire il file intero a subtest verdi
// (`score-ledger-persistence.test.mjs`, run 37174186291 e 37194730172). Il
// flake e' raro, il suo prerequisito e' deterministico: questi casi provano che
// il gate lo vede, che lo vede col blocco VERO di tests.yml, e che il rimedio
// documentato lo spegne senza zittire il log.

const STDOUT_HELPER = new URL('./lib/stdout-off-runner-pipe.mjs', import.meta.url).href;
const LOGGING_FIXTURE = [
  "import { test } from 'node:test';",
  "test('verde ma loggante', () => { console.log('RIGA_SU_STDOUT_1819'); });",
  '',
].join('\n');

test('reporter: un test:stdout diventa uno stdoutWriter con file, byte e frammento', () => {
  const writers = new Map();
  recordStdoutWrite(writers, { file: 'generator/tests/a.test.mjs', message: 'ciao\n' });
  recordStdoutWrite(writers, { file: 'generator/tests/a.test.mjs', message: 'mondo\n' });
  const report = buildReport([], [], writers.values());
  assert.deepEqual(report.stdoutWriters, [
    { file: 'generator/tests/a.test.mjs', events: 2, bytes: 11, sample: 'ciao\nmondo' },
  ]);
  assert.deepEqual(findStdoutWriters(report).map((w) => w.file), ['generator/tests/a.test.mjs']);
  assert.throws(() => findStdoutWriters({ failedTests: 0 }), /stdoutWriters/,
    'un report senza il campo non e\' una prova di pulizia');
});

test('tests.yml: un file verde che scrive su stdout rende il gate rosso e viene nominato (#1819)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'node-test-report-out-'));
  const reportFile = path.join(tmp, 'node-test-failures.json');
  try {
    const run = runUnitGates({ 'fixture-logging.mjs': LOGGING_FIXTURE }, { reportFile });
    fs.rmSync(run.dir, { recursive: true, force: true });
    assert.notEqual(run.status, 0, `stdout fuori protocollo deve essere rosso; stderr:\n${run.stderr}`);
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    assert.equal(report.failedTests, 0, 'il test in se\' e\' verde: il rosso e\' del gate');
    assert.equal(report.stdoutWriters.length, 1);
    assert.match(report.stdoutWriters[0].file, /fixture-logging\.mjs$/);
    assert.match(report.stdoutWriters[0].sample, /RIGA_SU_STDOUT_1819/);
    assert.match(run.stderr, /::error file=[^,]*fixture-logging\.mjs,title=node:test stdout fuori protocollo::/);
    assert.match(buildComment(report), /fixture-logging\.mjs` — \d+ byte: `RIGA_SU_STDOUT_1819/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('tests.yml: col redirect documentato lo stesso file e\' verde e il log resta visibile su stderr', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'node-test-report-out-'));
  const reportFile = path.join(tmp, 'node-test-failures.json');
  try {
    const run = runUnitGates({
      'fixture-routed.mjs': `import ${JSON.stringify(STDOUT_HELPER)};\n${LOGGING_FIXTURE}`,
    }, { reportFile });
    fs.rmSync(run.dir, { recursive: true, force: true });
    assert.equal(run.status, 0, `stderr:\n${run.stderr}`);
    assert.deepEqual(JSON.parse(fs.readFileSync(reportFile, 'utf8')).stdoutWriters, []);
    assert.match(run.stdout, /RIGA_SU_STDOUT_1819/,
      'il reporter spec ristampa lo stderr del figlio: il log non e\' stato zittito');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('score-ledger-persistence.test.mjs non scrive piu\' su stdout fuori protocollo (#1819)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'node-test-report-out-'));
  const reportFile = path.join(tmp, 'node-test-failures.json');
  const block = unitGatesRunBlock().replace('"$FIXTURE_FILES"', '"$REAL_FILES"');
  const env = { ...process.env, REAL_FILES: 'generator/tests/score-ledger-persistence.test.mjs', NODE_TEST_REPORT_FILE: reportFile };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  try {
    const run = spawnSync('bash', ['-c', block], { cwd: REPO, encoding: 'utf8', env });
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    assert.deepEqual(report.stdoutWriters, [], `il flush del ScoreStore logga su stdout:\n${run.stderr}`);
    assert.equal(run.status, 0, `stderr:\n${run.stderr}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('il redirect agisce solo nel figlio del runner e usa il console.error originale', () => {
  const calls = [];
  const fake = {
    log: () => calls.push('log-originale'),
    info: () => calls.push('info-originale'),
    debug: () => calls.push('debug-originale'),
    error: (...a) => calls.push(`error:${a.join(' ')}`),
  };
  assert.equal(routeInfoLogsToStderr(fake, {}), false, 'fuori dal figlio stdout non porta frame');
  fake.log('x');
  assert.deepEqual(calls, ['log-originale']);

  calls.length = 0;
  assert.equal(routeInfoLogsToStderr(fake, { NODE_TEST_CONTEXT: 'child-v8' }), true);
  fake.error = () => calls.push('spia-su-error');
  fake.log('a');
  fake.info('b');
  fake.debug('c');
  assert.deepEqual(calls, ['error:a', 'error:b', 'error:c'],
    'una spia installata dopo su console.error non deve ricevere le righe di console.log');
});

