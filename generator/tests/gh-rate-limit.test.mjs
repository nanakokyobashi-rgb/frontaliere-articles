/**
 * gh-rate-limit.test.mjs — le letture dei gate PR sopravvivono al bucket REST
 * esaurito del GITHUB_TOKEN (2026-09-25, 06:58-07:10 UTC), e i gate che le
 * usano restano fail-closed quando il reset e' lontano.
 *
 * Tre livelli, tutti ESEGUITI e non greppati:
 *   1. l'helper `scripts/ci/lib/gh-rate-limit.mjs` con `gh`, orologio e sonno
 *      iniettati;
 *   2. la sua CLI e lo step «Resolve review input revision» di `tests.yml`,
 *      estratto dallo YAML vero ed eseguito con un `gh` finto;
 *   3. `review-gate.mjs` e `generator-ci-gate.mjs` lanciati con un `gh` finto
 *      che risponde 403 da rate limit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GitHubRateLimitError,
  ghWithRateLimitRetry,
  isPrimaryRateLimitError,
  parseRateLimitMarker,
  rateLimitMarker,
  RATE_LIMIT_MAX_WAIT_MS,
} from '../../scripts/ci/lib/gh-rate-limit.mjs';
import { pollDelayMs, POLL_BASE_MS, POLL_MAX_MS } from '../../scripts/ci/generator-ci-gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HELPER = path.join(ROOT, 'scripts/ci/lib/gh-rate-limit.mjs');
const RATE_LIMIT_STDERR = 'gh: API rate limit exceeded for installation. If you reach out to GitHub Support for help, please include the request ID CC40:299409 (HTTP 403)';
const NOW_MS = Date.parse('2026-09-25T07:00:00Z');
const NOW_S = NOW_MS / 1000;

function ghError(stderr, status = 1) {
  const error = new Error(`Command failed: gh\n${stderr}`);
  error.status = status;
  error.stderr = stderr;
  error.stdout = '';
  return error;
}

/**
 * `exec` finto: `rate_limit` risponde con `bucket`, ogni altra chiamata
 * consuma la prossima risposta di `responses` (stringa = stdout, Error =
 * lancio). Registra ogni chiamata.
 */
function fakeExec({ responses = [], bucket = null, rateLimitError = false } = {}) {
  const calls = [];
  const queue = [...responses];
  const exec = (bin, args) => {
    calls.push([bin, ...args].join(' '));
    if (args[0] === 'api' && args[1] === 'rate_limit') {
      if (rateLimitError) throw ghError('gh: boom');
      return JSON.stringify({ resources: { core: bucket, graphql: { remaining: 5000, reset: NOW_S + 3600 } } });
    }
    const next = queue.shift();
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error(`risposta non prevista per ${args.join(' ')}`);
    return next;
  };
  return { exec, calls };
}

function harness(over = {}) {
  const logs = [];
  const sleeps = [];
  return {
    logs,
    sleeps,
    options: {
      now: () => NOW_MS,
      sleep: (ms) => sleeps.push(ms),
      random: () => 0,
      jitterMaxMs: 0,
      budget: { waits: 1 },
      log: (line) => logs.push(line),
      context: 'test-gate',
      ...over,
    },
  };
}

// ── 1. helper ───────────────────────────────────────────────────────────────

test('riconosce il solo rate limit PRIMARIO', () => {
  assert.equal(isPrimaryRateLimitError(RATE_LIMIT_STDERR), true);
  assert.equal(isPrimaryRateLimitError('API rate limit already exceeded for installation ID 1'), true);
  assert.equal(isPrimaryRateLimitError('You have exceeded a secondary rate limit. Please wait'), false);
  assert.equal(isPrimaryRateLimitError('gh: Resource not accessible by integration (HTTP 403)'), false);
  assert.equal(isPrimaryRateLimitError(''), false);
});

test('il marker macchina fa andata e ritorno, anche senza reset', () => {
  assert.deepEqual(parseRateLimitMarker(`x ${rateLimitMarker({ resource: 'core', resetAt: 1790320500 })} y`), { resource: 'core', resetAt: 1790320500 });
  assert.deepEqual(parseRateLimitMarker(rateLimitMarker({ resource: 'core', resetAt: 0 })), { resource: 'core', resetAt: 0 });
  assert.equal(parseRateLimitMarker('API rate limit exceeded'), null);
});

test('successo: una chiamata sola, stdout invariato, nessuna lettura di rate_limit', () => {
  const { exec, calls } = fakeExec({ responses: ['{"ok":true}'] });
  const h = harness();
  assert.equal(ghWithRateLimitRetry(['api', 'repos/o/r/pulls/1'], { ...h.options, exec }), '{"ok":true}');
  assert.deepEqual(calls, ['gh api repos/o/r/pulls/1']);
  assert.deepEqual(h.sleeps, []);
});

test('un errore che non e\' un rate limit risale invariato, senza attese', () => {
  const original = ghError('gh: Not Found (HTTP 404)');
  const { exec, calls } = fakeExec({ responses: [original] });
  const h = harness();
  assert.throws(() => ghWithRateLimitRetry(['api', 'x'], { ...h.options, exec }), (error) => error === original);
  assert.deepEqual(calls, ['gh api x']);
  assert.deepEqual(h.sleeps, []);
});

test('reset entro 15 min: attende fino al reset + jitter e riprova UNA volta', () => {
  const { exec, calls } = fakeExec({
    responses: [ghError(RATE_LIMIT_STDERR), 'body'],
    bucket: { limit: 1000, remaining: 0, reset: NOW_S + 300 },
  });
  const h = harness({ random: () => 0.5, jitterMaxMs: 10_000 });
  assert.equal(ghWithRateLimitRetry(['api', 'repos/o/r/pulls/1'], { ...h.options, exec }), 'body');
  assert.deepEqual(calls, ['gh api repos/o/r/pulls/1', 'gh api rate_limit', 'gh api repos/o/r/pulls/1']);
  assert.deepEqual(h.sleeps, [300_000 + 6_000], 'attesa = reset - adesso + jitter (2 s + 0,5·8 s)');
  assert.equal(h.options.budget.waits, 0);
  assert.match(h.logs.join('\n'), /::warning title=GitHub API rate limit::test-gate: .*reset 2026-09-25T07:05:00Z.*riprovo una volta/);
});

test('bucket gia\' ricaricato (remaining > 0): solo il jitter, non la finestra successiva', () => {
  const { exec } = fakeExec({
    responses: [ghError(RATE_LIMIT_STDERR), 'ok'],
    bucket: { limit: 1000, remaining: 998, reset: NOW_S + 3500 },
  });
  const h = harness({ random: () => 0, jitterMaxMs: 20_000 });
  assert.equal(ghWithRateLimitRetry(['api', 'x'], { ...h.options, exec }), 'ok');
  assert.deepEqual(h.sleeps, [2_000]);
});

test('reset oltre 15 min: fail-closed con ::error:: che nomina rate limit e reset', () => {
  const { exec, calls } = fakeExec({
    responses: [ghError(RATE_LIMIT_STDERR)],
    bucket: { limit: 1000, remaining: 0, reset: NOW_S + 40 * 60 },
  });
  const h = harness();
  assert.throws(
    () => ghWithRateLimitRetry(['api', 'x'], { ...h.options, exec }),
    (error) => error instanceof GitHubRateLimitError && error.resetAt === NOW_S + 2400 && error.resource === 'core',
  );
  assert.deepEqual(h.sleeps, [], 'nessun sonno oltre il tetto');
  assert.equal(calls.length, 2, 'nessun retry');
  const annotation = h.logs.find((line) => line.startsWith('::error title=GitHub API rate limit::'));
  assert.ok(annotation, h.logs.join('\n'));
  assert.match(annotation, /API rate limit exceeded/);
  assert.match(annotation, /reset 2026-09-25T07:40:00Z \(fra 40 min\)/);
  assert.deepEqual(parseRateLimitMarker(annotation), { resource: 'core', resetAt: NOW_S + 2400 });
  assert.equal(annotation.includes('\n'), false, 'un workflow command sta su una riga');
});

test('reset illeggibile: fail-closed senza inventare un\'attesa', () => {
  const { exec } = fakeExec({ responses: [ghError(RATE_LIMIT_STDERR)], rateLimitError: true });
  const h = harness();
  assert.throws(() => ghWithRateLimitRetry(['api', 'x'], { ...h.options, exec }), GitHubRateLimitError);
  assert.deepEqual(h.sleeps, []);
  assert.match(h.logs.join('\n'), /reset non leggibile.*\[gh-rate-limit resource=core reset=0\]/);
});

test('ancora 403 dopo l\'attesa: un solo retry, poi fail-closed', () => {
  const { exec, calls } = fakeExec({
    responses: [ghError(RATE_LIMIT_STDERR), ghError(RATE_LIMIT_STDERR)],
    bucket: { limit: 1000, remaining: 0, reset: NOW_S + 60 },
  });
  const h = harness();
  assert.throws(() => ghWithRateLimitRetry(['api', 'x'], { ...h.options, exec }), GitHubRateLimitError);
  assert.equal(calls.filter((call) => call === 'gh api x').length, 2);
  assert.equal(h.sleeps.length, 1);
});

test('un solo sonno per processo: la seconda lettura limitata fallisce subito', () => {
  const budget = { waits: 1 };
  const first = fakeExec({ responses: [ghError(RATE_LIMIT_STDERR), 'ok'], bucket: { remaining: 0, reset: NOW_S + 60 } });
  const h = harness({ budget });
  assert.equal(ghWithRateLimitRetry(['api', 'a'], { ...h.options, exec: first.exec }), 'ok');
  const second = fakeExec({ responses: [ghError(RATE_LIMIT_STDERR)], bucket: { remaining: 0, reset: NOW_S + 60 } });
  assert.throws(() => ghWithRateLimitRetry(['api', 'b'], { ...h.options, exec: second.exec }), GitHubRateLimitError);
  assert.equal(h.sleeps.length, 1);
  assert.match(h.logs.at(-1), /attesa fino al reset gia' spesa/);
});

test('maxWaitMs del chiamante stringe il tetto (es. scadenza di un gate)', () => {
  const { exec } = fakeExec({ responses: [ghError(RATE_LIMIT_STDERR)], bucket: { remaining: 0, reset: NOW_S + 120 } });
  const h = harness({ maxWaitMs: 60_000 });
  assert.throws(() => ghWithRateLimitRetry(['api', 'x'], { ...h.options, exec }), GitHubRateLimitError);
  assert.deepEqual(h.sleeps, []);
  assert.equal(RATE_LIMIT_MAX_WAIT_MS, 15 * 60 * 1000);
});

// ── 2. CLI e step di tests.yml ─────────────────────────────────────────────

/**
 * `gh` finto su file: la prima lettura non-`rate_limit` risponde 403 da rate
 * limit se `limited` > 0 (decrementato), poi `body`. `rate_limit` risponde con
 * il bucket di `bucket.json`.
 */
function fakeGhDir({ limited = 1, reset, remaining = 0, body = 'corpo della PR', failStatus = 0 }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gh-rate-limit-'));
  const gh = path.join(dir, 'gh');
  writeFileSync(path.join(dir, 'limited'), String(limited));
  writeFileSync(path.join(dir, 'calls'), '');
  writeFileSync(gh, `#!/usr/bin/env node
const fs = require('node:fs');
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
fs.appendFileSync(dir + '/calls', args.join(' ') + '\\n');
if (args[0] === 'api' && args[1] === 'rate_limit') {
  process.stdout.write(JSON.stringify({ resources: { core: { limit: 1000, remaining: ${remaining}, reset: ${reset} } } }));
  process.exit(0);
}
if (${failStatus} > 0) { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(${failStatus}); }
const limited = Number(fs.readFileSync(dir + '/limited', 'utf8'));
if (limited > 0) {
  fs.writeFileSync(dir + '/limited', String(limited - 1));
  process.stdout.write('{"message":"API rate limit exceeded for installation.","status":"403"}');
  process.stderr.write(${JSON.stringify(`${RATE_LIMIT_STDERR}\n`)});
  process.exit(1);
}
process.stdout.write(${JSON.stringify(`${body}\n`)});
`);
  chmodSync(gh, 0o755);
  return { dir, gh, calls: () => readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n').filter(Boolean) };
}

const nowS = () => Math.floor(Date.now() / 1000);
const cliEnv = { ...process.env, GH_RATE_LIMIT_JITTER_MS: '0' };

test('CLI: stdout = solo l\'output di gh; rate limit breve → attesa e retry', () => {
  const fake = fakeGhDir({ limited: 1, reset: nowS() + 1 });
  try {
    const r = spawnSync(process.execPath, [HELPER, '--gh', fake.gh, '--context', 'cli-test', '--', 'api', 'repos/o/r/pulls/1'], { encoding: 'utf8', env: cliEnv });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'corpo della PR\n', 'niente diagnostica su stdout: gli step la redirigono in un file');
    assert.match(r.stderr, /::warning title=GitHub API rate limit::cli-test/);
    assert.deepEqual(fake.calls(), ['api repos/o/r/pulls/1', 'api rate_limit', 'api repos/o/r/pulls/1']);
  } finally {
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('CLI: reset lontano → exit 1, stdout vuoto, annotation con marker su stderr', () => {
  const reset = nowS() + 3000;
  const fake = fakeGhDir({ limited: 5, reset });
  try {
    const r = spawnSync(process.execPath, [HELPER, '--gh', fake.gh, '--', 'api', 'x'], { encoding: 'utf8', env: cliEnv });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /::error title=GitHub API rate limit::/);
    assert.deepEqual(parseRateLimitMarker(r.stderr), { resource: 'core', resetAt: reset });
  } finally {
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('CLI: un errore normale di gh conserva exit code e stderr', () => {
  const fake = fakeGhDir({ limited: 0, reset: nowS() + 60, failStatus: 4 });
  try {
    const r = spawnSync(process.execPath, [HELPER, '--gh', fake.gh, '--', 'api', 'x'], { encoding: 'utf8', env: cliEnv });
    assert.equal(r.status, 4);
    assert.match(r.stderr, /Not Found \(HTTP 404\)/);
    assert.doesNotMatch(r.stderr, /rate limit/i);
  } finally {
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('CLI: argomenti malformati → exit 2 senza chiamare gh', () => {
  const r = spawnSync(process.execPath, [HELPER, 'api', 'x'], { encoding: 'utf8', env: cliEnv });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /uso:/);
});

const TESTS_YML = readFileSync(path.join(ROOT, '.github/workflows/tests.yml'), 'utf8');

function extractRun(stepName) {
  const lines = TESTS_YML.split('\n');
  const start = lines.findIndex((l) => l === `      - name: ${stepName}`);
  assert.notEqual(start, -1, `step non trovato: ${stepName}`);
  const runAt = lines.findIndex((l, i) => i > start && l === '        run: |');
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { body.push(''); continue; }
    if (!l.startsWith('          ')) break;
    body.push(l.slice(10));
  }
  return body.join('\n');
}

const REVIEW_INPUT_RUN = extractRun('Resolve review input revision (zero-Claude)');

function runReviewInputStep({ fake, withTrustedHelper }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'review-input-step-'));
  try {
    const output = path.join(dir, 'output');
    const bodyFile = path.join(dir, 'review-body.txt');
    writeFileSync(output, '');
    const env = {
      ...cliEnv,
      GH_TOKEN: 'x',
      GITHUB_REPOSITORY: 'nanakokyobashi-rgb/frontaliere-articles',
      PR_NUMBER: '1234',
      BODY_FILE: bodyFile,
      TRUSTED_GH_BIN: fake.gh,
      GITHUB_OUTPUT: output,
      RUNNER_TEMP: dir,
    };
    if (withTrustedHelper) {
      // Stessa forma del bootstrap: il gate e i suoi moduli sotto
      // $RUNNER_TEMP/review-gate-main, con il path esportato in GITHUB_ENV.
      const gateDir = path.join(dir, 'review-gate-main/scripts/ci');
      mkdirSync(path.join(gateDir, 'lib'), { recursive: true });
      copyFileSync(HELPER, path.join(gateDir, 'lib/gh-rate-limit.mjs'));
      env.REVIEW_GATE_MAIN_MODULE = path.join(gateDir, 'review-gate.mjs');
    }
    const script = path.join(dir, 'step.sh');
    writeFileSync(script, REVIEW_INPUT_RUN);
    const r = spawnSync('bash', [script], { encoding: 'utf8', env });
    return { ...r, output: readFileSync(output, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('tests.yml — «Resolve review input revision» attende un reset vicino con l\'helper trusted', () => {
  const fake = fakeGhDir({ limited: 1, reset: nowS() + 1, body: 'corpo della PR' });
  try {
    const r = runReviewInputStep({ fake, withTrustedHelper: true });
    assert.equal(r.status, 0, r.stderr);
    const expected = `body:${createHash('sha256').update('corpo della PR\n').digest('hex')}`;
    assert.match(r.output, new RegExp(`^review_revision=${expected}$`, 'm'));
    assert.deepEqual(fake.calls().filter((c) => c.startsWith('api repos/')).length, 2, 'un retry dopo il reset');
  } finally {
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('tests.yml — reset lontano: rosso che nomina il rate limit, niente revisione', () => {
  const fake = fakeGhDir({ limited: 5, reset: nowS() + 3000 });
  try {
    const r = runReviewInputStep({ fake, withTrustedHelper: true });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /::error title=GitHub API rate limit::Resolve review input revision/);
    assert.match(r.stdout, /::error::PR body illeggibile/);
    assert.doesNotMatch(r.output, /review_revision=/);
  } finally {
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('tests.yml — senza l\'helper trusted di main la lettura resta quella diretta, col gh pinnato', () => {
  const ok = fakeGhDir({ limited: 0, reset: nowS() + 60 });
  const limited = fakeGhDir({ limited: 1, reset: nowS() + 1 });
  try {
    const good = runReviewInputStep({ fake: ok, withTrustedHelper: false });
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.output, /^review_revision=body:[0-9a-f]{64}$/m);
    assert.deepEqual(ok.calls(), [`api repos/nanakokyobashi-rgb/frontaliere-articles/pulls/1234 --jq ${extractJq()}`]);
    // Nessun codice del checkout della PR: senza il modulo trusted non c'e'
    // retry, e il rosso resta quello di prima.
    const red = runReviewInputStep({ fake: limited, withTrustedHelper: false });
    assert.equal(red.status, 1);
    assert.match(red.stdout, /PR body illeggibile/);
  } finally {
    rmSync(ok.dir, { recursive: true, force: true });
    rmSync(limited.dir, { recursive: true, force: true });
  }
});

function extractJq() {
  const match = REVIEW_INPUT_RUN.match(/--jq '([^']+)'/);
  assert.ok(match, 'jq del body non trovato');
  return match[1];
}

test('tests.yml — l\'helper viene dal bootstrap trusted, mai dal checkout della PR', () => {
  assert.match(REVIEW_INPUT_RUN, /rate_limit_helper="\$\(dirname "\$\{REVIEW_GATE_MAIN_MODULE:-[^"]+\}"\)\/lib\/gh-rate-limit\.mjs"/);
  assert.doesNotMatch(REVIEW_INPUT_RUN, /node scripts\/ci\/lib\/gh-rate-limit\.mjs/);
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'scripts/ci/review-gate-bootstrap-manifest.json'), 'utf8'));
  assert.ok(manifest.modules.includes('scripts/ci/lib/gh-rate-limit.mjs'));
  const bootstrapAt = TESTS_YML.indexOf('- name: Bootstrap trusted review gate from main');
  const stepAt = TESTS_YML.indexOf('- name: Resolve review input revision (zero-Claude)');
  assert.ok(bootstrapAt > 0 && stepAt > bootstrapAt, 'lo step deve seguire il bootstrap');
});

// ── 3. i gate con un gh che risponde 403 ────────────────────────────────────

function binWithGh(source) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gate-rate-limit-'));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'gh'), source);
  chmodSync(path.join(bin, 'gh'), 0o755);
  return { dir, bin };
}

const limitedGh = (reset, { allow = [] } = {}) => `#!/usr/bin/env node
const args = process.argv.slice(2).join(' ');
if (args === 'api rate_limit') {
  process.stdout.write(JSON.stringify({ resources: { core: { limit: 1000, remaining: 0, reset: ${reset} } } }));
  process.exit(0);
}
for (const [needle, out] of ${JSON.stringify(allow)}) {
  if (args.includes(needle)) { process.stdout.write(out); process.exit(0); }
}
process.stderr.write(${JSON.stringify(`${RATE_LIMIT_STDERR}\n`)});
process.exit(1);
`;

test('review-gate: rate limit lontano → rosso transient con annotation del reset, nessun commento', () => {
  const reset = nowS() + 3000;
  const { dir, bin } = binWithGh(limitedGh(reset));
  const output = path.join(dir, 'output');
  writeFileSync(output, '');
  try {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/ci/review-gate.mjs')], {
      encoding: 'utf8',
      env: {
        ...cliEnv,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        GITHUB_REPOSITORY: 'nanakokyobashi-rgb/frontaliere-articles',
        PR_NUMBER: '1234',
        HEAD_SHA: 'a'.repeat(40),
        REVIEW_REVISION: `body:${'b'.repeat(64)}`,
        GITHUB_OUTPUT: output,
      },
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /::error title=GitHub API rate limit::review-gate/);
    assert.deepEqual(parseRateLimitMarker(r.stderr), { resource: 'core', resetAt: reset });
    assert.match(readFileSync(output, 'utf8'), /^failure_kind=transient$/m, 'un rate limit non e\' un verdetto');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('generator-ci-gate: file della PR illeggibili per rate limit → rosso che lo dice', () => {
  const reset = nowS() + 3000;
  const { dir, bin } = binWithGh(limitedGh(reset));
  try {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/ci/generator-ci-gate.mjs')], {
      encoding: 'utf8',
      env: {
        ...cliEnv,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        GITHUB_REPOSITORY: 'nanakokyobashi-rgb/frontaliere-articles',
        PR_NUMBER: '1234',
        HEAD_SHA: 'a'.repeat(40),
      },
    });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /file della PR illeggibili \(rate limit del token\)/);
    assert.deepEqual(parseRateLimitMarker(r.stderr), { resource: 'core', resetAt: reset });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('generator-ci-gate: check-run illeggibili per rate limit → rosso subito, non «non ha concluso»', () => {
  const { dir, bin } = binWithGh(limitedGh(nowS() + 3000, { allow: [['/pulls/1234/files', 'generator/changed.mjs\n']] }));
  try {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/ci/generator-ci-gate.mjs')], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...cliEnv,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        GITHUB_REPOSITORY: 'nanakokyobashi-rgb/frontaliere-articles',
        PR_NUMBER: '1234',
        HEAD_SHA: 'a'.repeat(40),
      },
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /illeggibili per rate limit del token/);
    assert.doesNotMatch(r.stdout, /non ha concluso entro/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('generator-ci-gate: polling a 60 s con backoff, stessa scadenza, ≤17 letture in 30 min', () => {
  assert.equal(POLL_BASE_MS, 60_000);
  assert.deepEqual([0, 1, 2, 3, 10].map((attempt) => pollDelayMs(attempt)), [60_000, 90_000, 120_000, 120_000, POLL_MAX_MS]);
  // L'ultima attesa e' tagliata sulla scadenza: la lettura finale cade sul tetto.
  assert.equal(pollDelayMs(5, { nowMs: 1_000, deadlineMs: 31_000 }), 30_000);
  assert.equal(pollDelayMs(0, { nowMs: 5_000, deadlineMs: 5_000 }), 0);
  const timeout = 30 * 60 * 1000;
  let t = 0;
  let reads = 1;
  for (let attempt = 0; t < timeout; attempt += 1) {
    t += pollDelayMs(attempt, { nowMs: t, deadlineMs: timeout });
    reads += 1;
  }
  assert.equal(t, timeout, 'l\'ultima lettura avviene esattamente alla scadenza');
  assert.ok(reads <= 17, `letture nel tetto: ${reads} (prima: 91 a 20 s)`);
});
