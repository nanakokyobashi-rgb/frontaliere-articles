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
    if [ "$n" -eq 1 ] || [ "$n" -eq 2 ]; then
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
          REPLAY_PENDING_POLL_LIMIT: '2',
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
  assert.equal(calls.filter((call) => call.startsWith('run list')).length, 3);
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

test('a stale-late replay delegates a matching run beyond the recent history', () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), 'replay-dispatch-old-active-'));
  const bin = path.join(sandbox, 'bin');
  mkdirSync(bin);
  const fakeGh = path.join(bin, 'gh');
  const title = 'cover-publish-section / canton-ur / nonce=stale-late-same-payload';
  const recent = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({
    databaseId: i + 900,
    displayTitle: 'unrelated',
    status: 'completed',
    conclusion: 'success',
  })));
  const old = JSON.stringify({
    workflow_runs: [{ id: 123, display_title: title + ' / dry=false / c=older', status: 'queued' }],
  });
  writeFileSync(fakeGh, `#!/bin/sh
case "$1 $2" in
  "run list") printf '%s\\n' '${recent}' ;;
  "api --paginate")
    printf '%s\\n' '{"workflow_runs":[]}'
    case "$3" in *status=queued*) printf '%s\\n' '${old}' ;; esac ;;
  *) exit 99 ;;
esac
`);
  chmodSync(fakeGh, 0o755);

  const output = execFileSync('bash', [dispatcher, 'owner/repo', title, '--ref', 'main'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      REPLAY_PENDING_POLL_LIMIT: '1',
      REPLAY_PENDING_POLL_DELAY_SECONDS: '0',
    },
    encoding: 'utf8',
  });
  assert.match(output, /delego la superficie alla run attiva/);
});

test('a stale-late replay retries an old run that completes as failed while polling', () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), 'replay-dispatch-old-active-'));
  const bin = path.join(sandbox, 'bin');
  mkdirSync(bin);
  const seen = path.join(sandbox, 'seen');
  const fakeGh = path.join(bin, 'gh');
  const title = 'cover-publish-section / canton-ur / nonce=stale-late-same-payload';
  const recent = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({
    databaseId: i + 900,
    displayTitle: 'unrelated',
    status: 'completed',
    conclusion: 'success',
  })));
  const old = JSON.stringify({
    workflow_runs: [{ id: 123, display_title: title + ' / dry=false / c=older', status: 'queued' }],
  });
  const completed = JSON.stringify({ id: 123, display_title: title + ' / dry=false / c=older', status: 'completed', conclusion: 'failure' });
  writeFileSync(fakeGh, `#!/bin/sh
case "$1 $2" in
  "run list") printf '%s\\n' '${recent}' ;;
  "api --paginate")
    printf '%s\\n' '{"workflow_runs":[]}'
    case "$3" in *status=queued*)
      if [ ! -e "$GH_TEST_SEEN" ]; then
        touch "$GH_TEST_SEEN"
        printf '%s\\n' '${old}'
      fi ;;
    esac ;;
  "api repos/owner/repo/actions/runs/123") printf '%s\\n' '${completed}' ;;
  "workflow run") exit 0 ;;
  *) exit 99 ;;
esac
`);
  chmodSync(fakeGh, 0o755);

  const output = execFileSync('bash', [dispatcher, 'owner/repo', title, '--ref', 'main'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GH_TEST_SEEN: seen,
      REPLAY_PENDING_POLL_LIMIT: '1',
      REPLAY_PENDING_POLL_DELAY_SECONDS: '0',
    },
    encoding: 'utf8',
  });
  assert.match(output, /il replay gia' in corso e' fallito/);
  assert.match(output, /replay stale accettato dall'API/);
});
