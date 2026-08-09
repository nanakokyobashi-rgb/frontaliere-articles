/**
 * scripts/lib/npm-ci-retry.sh — regression suite.
 *
 * The wrapper exists because an install failure here is a network fluctuation
 * that costs articles: the `onnxruntime-node` postinstall downloads a native
 * binary from outside the npm registry with no retry of its own, and a single
 * `ETIMEDOUT` fails the job (issue #77, and #39 before it).
 *
 * A retry wrapper is the kind of thing that looks obviously correct and is
 * silently wrong in two directions — it can swallow a real failure by exiting 0,
 * or drop the flags its caller passed so `--ignore-scripts` quietly stops
 * applying. Both are pinned below. `npm` is stubbed on PATH so the tests
 * exercise the wrapper's own logic without touching the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '../../scripts/lib/npm-ci-retry.sh');

/**
 * Runs the wrapper with a stubbed `npm` that fails its first `failTimes` calls.
 * The stub records every invocation's arguments so the forwarding test can
 * assert on them.
 */
function runWith({ failTimes, args = [], attempts = 3 }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'npm-ci-retry-'));
  const counter = path.join(dir, 'calls');
  const argsLog = path.join(dir, 'args');
  const stub = path.join(dir, 'npm');

  writeFileSync(
    stub,
    `#!/usr/bin/env bash
n=0
[ -f "${counter}" ] && n=$(cat "${counter}")
n=$((n + 1))
echo "$n" > "${counter}"
echo "$@" >> "${argsLog}"
if [ "$n" -le ${failTimes} ]; then
  echo "npm ERR! code ETIMEDOUT" >&2
  exit 1
fi
exit 0
`,
  );
  chmodSync(stub, 0o755);

  let code = 0;
  let out = '';
  try {
    out = execFileSync('bash', [SCRIPT, ...args], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        NPM_CI_RETRY_ATTEMPTS: String(attempts),
        // Keep the suite fast: the backoff formula is attempt * step.
        NPM_CI_RETRY_BACKOFF: '0',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    code = err.status ?? 1;
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }

  const calls = existsSync(counter) ? Number(readFileSync(counter, 'utf8').trim()) : 0;
  const argLines = existsSync(argsLog)
    ? readFileSync(argsLog, 'utf8').split('\n').filter(Boolean)
    : [];
  rmSync(dir, { recursive: true, force: true });
  return { code, out, calls, argLines };
}

test('a first-attempt success runs npm ci exactly once', () => {
  const { code, calls } = runWith({ failTimes: 0 });
  assert.equal(code, 0);
  assert.equal(calls, 1, 'the happy path must not pay for the retry logic');
});

test('a transient failure is retried and then succeeds', () => {
  const { code, calls, out } = runWith({ failTimes: 1 });
  assert.equal(code, 0, `should recover, got:\n${out}`);
  assert.equal(calls, 2);
});

test('a persistent failure still fails, after exhausting the attempts', () => {
  // The direction that matters most: a wrapper that turned a real breakage into
  // a green run would be worse than no wrapper at all.
  const { code, calls, out } = runWith({ failTimes: 99, attempts: 3 });
  assert.equal(code, 1, 'a genuinely broken install must not be swallowed');
  assert.equal(calls, 3, 'should stop at the configured attempt count');
  assert.match(out, /failed after 3 attempts/);
});

test('every argument is forwarded to npm ci, on every attempt', () => {
  // `--ignore-scripts` is load-bearing in three of the callers: dropping it
  // would silently re-enable the very postinstall this wrapper works around.
  const { code, argLines } = runWith({
    failTimes: 1,
    args: ['--no-audit', '--no-fund', '--ignore-scripts'],
  });
  assert.equal(code, 0);
  assert.equal(argLines.length, 2);
  for (const line of argLines) {
    assert.equal(line.trim(), 'ci --no-audit --no-fund --ignore-scripts');
  }
});

test('every workflow that installs uses the wrapper', () => {
  // The rewire is the half of the fix that rots: a new workflow copied from an
  // old one brings a bare `npm ci` back, and nothing else would notice.
  const workflowsDir = path.resolve(HERE, '../../.github/workflows');
  const offenders = [];
  for (const file of readdirSync(workflowsDir)) {
    if (!file.endsWith('.yml')) continue;
    const src = readFileSync(path.join(workflowsDir, file), 'utf8');
    src.split('\n').forEach((line, i) => {
      // A `run:` step invoking npm ci directly, rather than through the wrapper.
      if (/^\s*(run:\s*)?npm ci\b/.test(line) && !line.includes('npm-ci-retry')) {
        offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    'These steps run `npm ci` without the retry wrapper, so a single network blip fails the job — ' +
      'which is how articles get lost (#77):\n  ' + offenders.join('\n  '),
  );
});
