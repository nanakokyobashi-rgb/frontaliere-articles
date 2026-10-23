import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const dispatcher = path.join(repoRoot, 'scripts/ci/dispatch-fast-publish-replay.sh');

test('stale replay accepts a successful dispatch before GitHub lists the child run', () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), 'replay-dispatch-'));
  const bin = path.join(sandbox, 'bin');
  mkdirSync(bin);
  const log = path.join(sandbox, 'gh.log');
  const fakeGh = path.join(bin, 'gh');
  writeFileSync(
    fakeGh,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_TEST_LOG"
case "$1 $2" in
  "run list") printf '%s\\n' '[]' ;;
  "workflow run") exit 0 ;;
  *) exit 99 ;;
esac
`,
  );
  chmodSync(fakeGh, 0o755);

  const output = execFileSync(
    'bash',
    [
      dispatcher,
      'nanakokyobashi-rgb/frontaliere-articles',
      'cover-publish-section / canton-be / nonce=stale-resolve-abc',
      '--ref',
      'main',
      '-f',
      'section=canton-be',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_TEST_LOG: log },
      encoding: 'utf8',
    },
  );

  const calls = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(calls.filter((call) => call.startsWith('run list')).length, 1);
  assert.equal(calls.filter((call) => call.startsWith('workflow run')).length, 1);
  assert.match(output, /replay stale accettato dall'API/);
});
