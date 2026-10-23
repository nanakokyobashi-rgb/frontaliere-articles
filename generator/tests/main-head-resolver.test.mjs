import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HELPER = path.join(ROOT, 'scripts/ci/read-main-head.sh');
const MAIN_SHA = 'a'.repeat(40);

function runWithFakeGit({ output = `${MAIN_SHA}\trefs/heads/main\n`, status = 0 } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'main-head-resolver-'));
  const bin = path.join(directory, 'bin');
  const fakeGit = path.join(bin, 'git');
  const fakeSleep = path.join(bin, 'sleep');
  const calls = path.join(directory, 'calls');
  mkdirSync(bin);
  // The helper is deliberately exercised as bash, with only the Git transport
  // faked. `timeout`, awk and the shell remain the real runner tools.
  writeFileSync(fakeGit, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n');
process.stdout.write(${JSON.stringify(output)});
process.exit(${status});
`);
  writeFileSync(fakeSleep, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(fakeGit, 0o755);
  chmodSync(fakeSleep, 0o755);
  const result = spawnSync('bash', [HELPER], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  const callLog = readFileSync(calls, 'utf8');
  rmSync(directory, { recursive: true, force: true });
  return { result, callLog };
}

test('read-main-head usa git ls-remote e restituisce la SHA della ref richiesta', () => {
  const { result, callLog } = runWithFakeGit();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${MAIN_SHA}\n`);
  assert.match(callLog, /ls-remote --exit-code --refs origin refs\/heads\/main/);
  assert.doesNotMatch(readFileSync(HELPER, 'utf8'), /gh api/);
});

test('read-main-head resta fail-closed se la ref non e leggibile', () => {
  const { result, callLog } = runWithFakeGit({ output: 'not-a-sha\trefs/heads/main\n', status: 0 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /non risolvibile via git ls-remote/);
  assert.equal(callLog.trim().split('\n').length, 3);
});
