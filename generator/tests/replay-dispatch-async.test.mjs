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

test('an equivalent pending replay is delegated without a duplicate dispatch', () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), 'replay-dispatch-pending-'));
  const bin = path.join(sandbox, 'bin');
  mkdirSync(bin);
  const log = path.join(sandbox, 'gh.log');
  const fakeGh = path.join(bin, 'gh');
  writeFileSync(
    fakeGh,
    `#!/bin/sh
printf '%s\n' "$*" >> "$GH_TEST_LOG"
case "$1 $2" in
  "run list") printf '%s\n' '[{"databaseId":123,"displayTitle":"cover-publish-section / canton-be / nonce=reconcile-test","status":"in_progress","conclusion":""}]' ;;
  "workflow run") exit 99 ;;
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
      'cover-publish-section / canton-be / nonce=reconcile-test',
      '--ref',
      'main',
      '-f',
      'section=canton-be',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GH_TEST_LOG: log,
        GITHUB_RUN_ID: '999',
        REPLAY_PENDING_POLL_LIMIT: '1',
        REPLAY_PENDING_POLL_DELAY_SECONDS: '0',
      },
      encoding: 'utf8',
    },
  );

  const calls = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(calls.filter((call) => call.startsWith('run list')).length, 2);
  assert.equal(calls.filter((call) => call.startsWith('workflow run')).length, 0);
  assert.match(output, /delego la superficie alla run attiva/);
});

test('a pending replay is not delegated when the final status read fails', () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), 'replay-dispatch-read-error-'));
  const bin = path.join(sandbox, 'bin');
  mkdirSync(bin);
  const log = path.join(sandbox, 'gh.log');
  const count = path.join(sandbox, 'run-list-count');
  const fakeGh = path.join(bin, 'gh');
  writeFileSync(
    fakeGh,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_TEST_LOG"
case "$1 $2" in
  "run list")
    n="$(cat "$GH_TEST_COUNT" 2>/dev/null || printf '0')"
    n=$((n + 1))
    printf '%s\\n' "$n" > "$GH_TEST_COUNT"
    if [ "$n" -eq 1 ]; then
      printf '%s\\n' '[{"databaseId":124,"displayTitle":"cover-publish-section / canton-be / nonce=read-error","status":"in_progress","conclusion":""}]'
    else
      exit 42
    fi
    ;;
  "workflow run") exit 99 ;;
  *) exit 99 ;;
esac
`,
  );
  chmodSync(fakeGh, 0o755);

  let error = null;
  try {
    execFileSync(
      'bash',
      [
        dispatcher,
        'nanakokyobashi-rgb/frontaliere-articles',
        'cover-publish-section / canton-be / nonce=read-error',
        '--ref',
        'main',
        '-f',
        'section=canton-be',
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GH_TEST_LOG: log,
          GH_TEST_COUNT: count,
          REPLAY_PENDING_POLL_LIMIT: '1',
          REPLAY_PENDING_POLL_DELAY_SECONDS: '0',
        },
        encoding: 'utf8',
      },
    );
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, 'un errore di lettura finale deve restare fail-closed');
  assert.match(`${error.stdout || ''}\n${error.stderr || ''}`, /stato finale del replay pendente non verificato/);

  const calls = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(calls.filter((call) => call.startsWith('workflow run')).length, 0);
});

test('a pending replay that disappears is not delegated as a success', () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), 'replay-dispatch-missing-'));
  const bin = path.join(sandbox, 'bin');
  mkdirSync(bin);
  const log = path.join(sandbox, 'gh.log');
  const count = path.join(sandbox, 'run-list-count');
  const fakeGh = path.join(bin, 'gh');
  writeFileSync(
    fakeGh,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_TEST_LOG"
case "$1 $2" in
  "run list")
    n="$(cat "$GH_TEST_COUNT" 2>/dev/null || printf '0')"
    n=$((n + 1))
    printf '%s\\n' "$n" > "$GH_TEST_COUNT"
    if [ "$n" -eq 1 ]; then
      printf '%s\\n' '[{"databaseId":125,"displayTitle":"cover-publish-section / canton-be / nonce=missing","status":"in_progress","conclusion":""}]'
    else
      printf '%s\\n' '[]'
    fi
    ;;
  "workflow run") exit 99 ;;
  *) exit 99 ;;
esac
`,
  );
  chmodSync(fakeGh, 0o755);

  let error = null;
  try {
    execFileSync(
      'bash',
      [
        dispatcher,
        'nanakokyobashi-rgb/frontaliere-articles',
        'cover-publish-section / canton-be / nonce=missing',
        '--ref',
        'main',
        '-f',
        'section=canton-be',
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GH_TEST_LOG: log,
          GH_TEST_COUNT: count,
          REPLAY_PENDING_POLL_LIMIT: '1',
          REPLAY_PENDING_POLL_DELAY_SECONDS: '0',
        },
        encoding: 'utf8',
      },
    );
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, 'una run scomparsa deve restare fail-closed');
  assert.match(`${error.stdout || ''}\n${error.stderr || ''}`, /run replay pendente non più osservabile/);

  const calls = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(calls.filter((call) => call.startsWith('workflow run')).length, 0);
});
