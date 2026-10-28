import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HELPER = resolve(ROOT, 'scripts/ci/verify-publish-api-source-current.sh');
const SOURCE = 'a'.repeat(40);
const CURRENT = 'b'.repeat(40);

function runHelper({ apiInputChanged = false, ancestor = true }) {
  const dir = mkdtempSync(resolve(tmpdir(), 'verify-publish-api-source-'));
  const envFile = resolve(dir, 'github-env');
  const fakeBin = resolve(dir, 'bin');
  mkdirSync(fakeBin);
  const writeExecutable = (name, body) => {
    const file = resolve(fakeBin, name);
    writeFileSync(file, body);
    chmodSync(file, 0o755);
  };
  try {
    writeFileSync(envFile, '');
    writeExecutable('gh', '#!/bin/sh\nprintf "%s\n" "' + CURRENT + '"\n');
    writeExecutable('timeout', '#!/bin/sh\nshift 2\nexec "$@"\n');
    writeExecutable('node', '#!/bin/sh\nprintf "%s\n" "$FAKE_API_INPUT"\n');
    writeExecutable(
      'git',
      '#!/bin/sh\ncase "$1" in\n  fetch) exit 0 ;;\n  merge-base) [ "$FAKE_ANCESTOR" = "true" ] && exit 0 || exit 1 ;;\n  *) exit 0 ;;\nesac\n',
    );
    const env = {
      ...process.env,
      PATH: fakeBin + ':' + process.env.PATH,
      GITHUB_ENV: envFile,
      GH_TOKEN: 'test-token',
      REPOSITORY: 'nanakokyobashi-rgb/frontaliere-articles',
      PUBLISH_API_SOURCE_COMMIT: SOURCE,
      VERIFY_CONTEXT: 'test',
      FAKE_API_INPUT: String(apiInputChanged),
      FAKE_ANCESTOR: String(ancestor),
    };
    try {
      const stdout = execFileSync('bash', [HELPER], {
        cwd: ROOT,
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, output: stdout + readFileSync(envFile, 'utf8') };
    } catch (error) {
      return {
        status: error.status ?? 1,
        output: String(error.stdout ?? '') + String(error.stderr ?? ''),
      };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('freshness helper autorizza un avanzamento non-API senza mutare il commit dell artifact', () => {
  const result = runHelper({ apiInputChanged: false });
  assert.equal(result.status, 0);
  assert.match(result.output, /solo con bookkeeping/u);
  assert.match(result.output, new RegExp('source=' + SOURCE));
  assert.doesNotMatch(result.output, new RegExp('PUBLISH_API_SOURCE_COMMIT=' + CURRENT));
});

test('freshness helper resta fail-closed quando main contiene input API nuovi', () => {
  const result = runHelper({ apiInputChanged: true });
  assert.equal(result.status, 1);
  assert.match(result.output, /contiene input API piu' recenti/u);
  assert.doesNotMatch(result.output, new RegExp('PUBLISH_API_SOURCE_COMMIT=' + CURRENT));
});

test('freshness helper resta fail-closed se la storia non è riconciliabile', () => {
  const result = runHelper({ ancestor: false });
  assert.equal(result.status, 1);
  assert.match(result.output, /avanzamento non riconciliabile/u);
});
