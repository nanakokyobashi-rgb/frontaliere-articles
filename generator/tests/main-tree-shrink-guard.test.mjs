import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { countTrackedPaths, evaluateTreeCounts, guardTreeShrink, resolveCommitRevision } from '../../scripts/ci/guard-main-tree-shrink.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GUARD_SCRIPT = path.join(ROOT, 'scripts/ci/guard-main-tree-shrink.mjs');
const PUSH_HELPER = path.join(ROOT, 'scripts/lib/git-push-with-retry.sh');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

test('la soglia blocca il collasso reale di main e lascia passare gli aggiornamenti normali', () => {
  assert.equal(evaluateTreeCounts(56_251, 1).suspicious, true);
  assert.equal(evaluateTreeCounts(56_251, 56_000).suspicious, false);
  assert.equal(evaluateTreeCounts(999, 1).suspicious, false);
});

test('il guard conta gli alberi Git e rileva una sostituzione quasi totale', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'main-tree-shrink-'));
  try {
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.name', 'Fixture']);
    git(repo, ['config', 'user.email', 'fixture@example.invalid']);
    for (let index = 0; index < 1_001; index++) {
      writeFileSync(path.join(repo, `tracked-${index}.txt`), 'x');
    }
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'large tree']);
    const before = git(repo, ['rev-parse', 'HEAD']);
    assert.equal(countTrackedPaths(before, repo), 1_001);

    for (let index = 1; index < 1_001; index++) rmSync(path.join(repo, `tracked-${index}.txt`));
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'catastrophic shrink']);
    const after = git(repo, ['rev-parse', 'HEAD']);
    assert.equal(guardTreeShrink(before, after, repo).suspicious, true);

    const cli = spawnSync(process.execPath, [GUARD_SCRIPT, '--before', before, '--after', after], {
      cwd: repo,
      encoding: 'utf8',
    });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /Possible catastrophic main tree shrink/u);
    assert.match(cli.stderr, /1001 → 1/u);

    const refCli = spawnSync(process.execPath, [GUARD_SCRIPT, '--before', 'HEAD^', '--after', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    });
    assert.equal(refCli.status, 1);
    assert.match(refCli.stderr, /Possible catastrophic main tree shrink/u);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('rifiuta gli object ID abbreviati in un repository SHA-256', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'main-tree-shrink-sha256-'));
  try {
    git(repo, ['init', '-q', '--object-format=sha256']);
    git(repo, ['config', 'user.name', 'Fixture']);
    git(repo, ['config', 'user.email', 'fixture@example.invalid']);
    writeFileSync(path.join(repo, 'tracked.txt'), 'x');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'sha256 tree']);
    const head = git(repo, ['rev-parse', 'HEAD']);
    const abbreviated = head.slice(0, 40);

    assert.equal(head.length, 64);
    assert.throws(() => countTrackedPaths(abbreviated, repo), /64-character Git object ID/u);
    assert.throws(() => resolveCommitRevision(abbreviated, repo), /full 64-character Git object ID or a named ref/u);
    git(repo, ['branch', abbreviated]);
    assert.equal(resolveCommitRevision(abbreviated, repo), head);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('il retry helper lega il guard al push main anche quando il push usa --no-verify', () => {
  const helper = readFileSync(PUSH_HELPER, 'utf8');
  assert.match(helper, /--push-main --remote origin --target main --after HEAD/u);
  assert.match(helper, /Possible catastrophic main tree shrink/u);
  assert.match(helper, /MAIN_TREE_GUARD_FATAL:/u);
  assert.match(helper, /--no-thin --no-verify --git-config pack\.window=0 --git-config pack\.threads=1/u);
});

test('il retry helper ferma un push main che riduce l’albero a un solo file', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'main-tree-shrink-push-'));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  const shim = path.join(root, 'bin');
  const pushCounter = path.join(root, 'push-count');
  try {
    git(root, ['init', '-q', '--bare', '--initial-branch=main', remote]);
    git(root, ['init', '-q', '--initial-branch=main', local]);
    git(local, ['config', 'user.name', 'Fixture']);
    git(local, ['config', 'user.email', 'fixture@example.invalid']);
    for (let index = 0; index < 1_001; index++) {
      writeFileSync(path.join(local, `tracked-${index}.txt`), 'x');
    }
    git(local, ['add', '.']);
    git(local, ['commit', '-q', '-m', 'large tree']);
    git(local, ['remote', 'add', 'origin', remote]);
    git(local, ['push', '-q', 'origin', 'HEAD:main']);
    git(local, ['fetch', '-q', 'origin', 'main']);

    for (let index = 1; index < 1_001; index++) rmSync(path.join(local, `tracked-${index}.txt`));
    git(local, ['add', '-A']);
    git(local, ['commit', '-q', '-m', 'replace main tree']);

    mkdirSync(shim);
    writeFileSync(pushCounter, '');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(
      path.join(shim, 'git'),
      `#!/bin/bash\nfor arg in "$@"; do\n  if [ "$arg" = push ]; then echo push >> '${pushCounter}'; break; fi\ndone\nexec '${realGit}' "$@"\n`,
    );
    chmodSync(path.join(shim, 'git'), 0o755);

    const result = spawnSync('bash', [PUSH_HELPER, '--branch', 'refs/heads/main', '--max-attempts', '1'], {
      cwd: local,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${shim}${path.delimiter}${process.env.PATH ?? ''}`,
        APP_TOKEN: '',
        GITHUB_PAT: '',
      },
    });
    assert.equal(result.status, 1, `${result.stdout ?? ''}${result.stderr ?? ''}`);
    assert.match(`${result.stdout ?? ''}${result.stderr ?? ''}`, /Possible catastrophic main tree shrink/u);
    assert.equal(readFileSync(pushCounter, 'utf8'), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('il push guarded aggiorna main in fast-forward e verifica il ref remoto finale', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'main-tree-shrink-push-success-'));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  try {
    git(root, ['init', '-q', '--bare', '--initial-branch=main', remote]);
    mkdirSync(local);
    git(local, ['init', '-q', '--initial-branch=main']);
    git(local, ['config', 'user.name', 'Fixture']);
    git(local, ['config', 'user.email', 'fixture@example.invalid']);
    writeFileSync(path.join(local, 'tracked.txt'), 'x');
    git(local, ['add', '.']);
    git(local, ['commit', '-q', '-m', 'base tree']);
    git(local, ['remote', 'add', 'origin', remote]);
    git(local, ['push', '-q', 'origin', 'HEAD:main']);
    writeFileSync(path.join(local, 'second.txt'), 'y');
    git(local, ['add', '.']);
    git(local, ['commit', '-q', '-m', 'normal update']);
    const candidate = git(local, ['rev-parse', 'HEAD']);

    const result = spawnSync(process.execPath, [
      GUARD_SCRIPT,
      '--push-main', '--remote', 'origin', '--target', 'main', '--after', 'HEAD',
    ], { cwd: local, encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout ?? ''}${result.stderr ?? ''}`);
    assert.match(result.stdout, /guarded main push:/u);
    assert.equal(git(root, ['--git-dir', remote, 'rev-parse', 'refs/heads/main']), candidate);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('il cleanup della tracking ref segnala il fallimento di update-ref', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'main-tree-shrink-cleanup-'));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  const shim = path.join(root, 'bin');
  try {
    git(root, ['init', '-q', '--bare', '--initial-branch=main', remote]);
    mkdirSync(local);
    git(local, ['init', '-q', '--initial-branch=main']);
    git(local, ['config', 'user.name', 'Fixture']);
    git(local, ['config', 'user.email', 'fixture@example.invalid']);
    writeFileSync(path.join(local, 'tracked.txt'), 'base');
    git(local, ['add', '.']);
    git(local, ['commit', '-q', '-m', 'base']);
    git(local, ['remote', 'add', 'origin', remote]);
    git(local, ['push', '-q', 'origin', 'HEAD:main']);
    writeFileSync(path.join(local, 'second.txt'), 'candidate');
    git(local, ['add', '.']);
    git(local, ['commit', '-q', '-m', 'candidate']);
    mkdirSync(shim);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(path.join(shim, 'git'), [
      '#!/bin/bash',
      'if [ "${1:-}" = update-ref ] && [ "${2:-}" = -d ]; then',
      "  echo 'fatal: simulated temporary ref cleanup failure' >&2",
      '  exit 1',
      'fi',
      `exec ${shellQuote(realGit)} "$@"`,
      '',
    ].join('\n'));
    chmodSync(path.join(shim, 'git'), 0o755);

    const result = spawnSync(process.execPath, [
      GUARD_SCRIPT, '--push-main', '--remote', 'origin', '--target', 'main', '--after', 'HEAD',
    ], {
      cwd: local,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${shim}${path.delimiter}${process.env.PATH ?? ''}` },
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /warning: could not remove temporary guarded-push ref \(git update-ref exited 1\)/u);
    assert.match(git(local, ['for-each-ref', '--format=%(refname)', 'refs/ci/main-tree-guard']), /refs\/ci\/main-tree-guard\//u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('il timeout del guard termina anche i processi figli avviati dal fetch Git', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'main-tree-shrink-timeout-'));
  const local = path.join(root, 'local');
  const shim = path.join(root, 'bin');
  const delayedMarker = path.join(root, 'orphan-finished');
  try {
    mkdirSync(local);
    git(local, ['init', '-q']);
    mkdirSync(shim);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const delayedWrite = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(delayedMarker)}, 'orphan survived'), 350)`;
    writeFileSync(path.join(shim, 'git'), [
      '#!/bin/bash',
      'for arg in "$@"; do',
      '  if [ "$arg" = fetch ]; then',
      `    ${shellQuote(process.execPath)} -e ${shellQuote(delayedWrite)} &`,
      '    wait',
      '  fi',
      'done',
      `exec ${shellQuote(realGit)} "$@"`,
      '',
    ].join('\n'));
    chmodSync(path.join(shim, 'git'), 0o755);

    const result = spawnSync(process.execPath, [
      GUARD_SCRIPT,
      '--push-main', '--remote', 'origin', '--target', 'main', '--after', 'HEAD', '--timeout-ms', '100',
    ], {
      cwd: local,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${shim}${path.delimiter}${process.env.PATH ?? ''}` },
    });
    assert.equal(result.status, 1, `${result.stdout ?? ''}${result.stderr ?? ''}`);
    assert.match(`${result.stdout ?? ''}${result.stderr ?? ''}`, /ETIMEDOUT|timed out/iu);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(existsSync(delayedMarker), false, 'the Git descendant must not finish after the guard times out');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SIGTERM al guard termina il gruppo del push e rimuove il ref temporaneo', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'main-tree-shrink-signal-'));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  const shim = path.join(root, 'bin');
  const startedMarker = path.join(root, 'child-started');
  const delayedMarker = path.join(root, 'child-finished');
  let guard;
  try {
    git(root, ['init', '-q', '--bare', '--initial-branch=main', remote]);
    mkdirSync(local);
    git(local, ['init', '-q', '--initial-branch=main']);
    git(local, ['config', 'user.name', 'Fixture']);
    git(local, ['config', 'user.email', 'fixture@example.invalid']);
    writeFileSync(path.join(local, 'tracked.txt'), 'base');
    git(local, ['add', '.']);
    git(local, ['commit', '-q', '-m', 'base']);
    git(local, ['remote', 'add', 'origin', remote]);
    git(local, ['push', '-q', 'origin', 'HEAD:main']);
    writeFileSync(path.join(local, 'candidate.txt'), 'candidate');
    git(local, ['add', '.']);
    git(local, ['commit', '-q', '-m', 'candidate']);
    mkdirSync(shim);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const delayedWrite = `require('node:fs').writeFileSync(${JSON.stringify(startedMarker)}, 'started'); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(delayedMarker)}, 'orphan survived'), 700)`;
    writeFileSync(path.join(shim, 'git'), [
      '#!/bin/bash',
      'for arg in "$@"; do',
      '  if [ "$arg" = push ]; then',
      `    ${shellQuote(process.execPath)} -e ${shellQuote(delayedWrite)} &`,
      '    wait',
      '    exit 1',
      '  fi',
      'done',
      `exec ${shellQuote(realGit)} "$@"`,
      '',
    ].join('\n'));
    chmodSync(path.join(shim, 'git'), 0o755);

    guard = spawn(process.execPath, [
      GUARD_SCRIPT, '--push-main', '--remote', 'origin', '--target', 'main', '--after', 'HEAD',
    ], {
      cwd: local,
      env: { ...process.env, PATH: `${shim}${path.delimiter}${process.env.PATH ?? ''}` },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    guard.stderr.setEncoding('utf8');
    guard.stderr.on('data', (chunk) => { stderr += chunk; });
    const closed = new Promise((resolve, reject) => {
      guard.once('error', reject);
      guard.once('close', (code, signal) => resolve({ code, signal }));
    });
    const startedDeadline = Date.now() + 2_000;
    while (!existsSync(startedMarker) && Date.now() < startedDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(existsSync(startedMarker), true, 'the fake Git descendant should be running before SIGTERM');
    guard.kill('SIGTERM');
    const result = await closed;
    assert.equal(result.code, 1, stderr);
    assert.match(stderr, /MAIN_TREE_GUARD_FATAL: Guarded main push interrupted by SIGTERM/u);
    assert.equal(git(local, ['for-each-ref', '--format=%(refname)', 'refs/ci/main-tree-guard']), '');
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(existsSync(delayedMarker), false, 'the detached Git descendant must not finish after SIGTERM');
  } finally {
    if (guard && guard.exitCode === null && guard.signalCode === null) guard.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});

test('un errore di autenticazione sul fetch è classificato senza stampare credenziali remote', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'main-tree-shrink-auth-'));
  const local = path.join(root, 'local');
  const shim = path.join(root, 'bin');
  try {
    mkdirSync(local);
    git(local, ['init', '-q']);
    mkdirSync(shim);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(path.join(shim, 'git'), [
      '#!/bin/bash',
      'for arg in "$@"; do',
      '  if [ "$arg" = fetch ]; then',
      `    echo ${shellQuote("fatal: Authentication failed for 'https://x-access-token:secret@example.invalid/repo.git'")} >&2`,
      '    exit 128',
      '  fi',
      'done',
      `exec ${shellQuote(realGit)} "$@"`,
      '',
    ].join('\n'));
    chmodSync(path.join(shim, 'git'), 0o755);

    const result = spawnSync(process.execPath, [
      GUARD_SCRIPT,
      '--push-main', '--remote', 'https://x-access-token:secret@example.invalid/repo.git',
      '--target', 'main', '--after', 'HEAD',
    ], {
      cwd: local,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${shim}${path.delimiter}${process.env.PATH ?? ''}` },
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    assert.equal(result.status, 1, output);
    assert.match(output, /MAIN_TREE_GUARD_FATAL: Unable to fetch main.*Authentication failed/u);
    assert.doesNotMatch(output, /x-access-token:secret/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('i rifiuti di permesso e HTTP 403 sul push sono fatali e redigono URL con credenziali', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'main-tree-shrink-push-auth-'));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  const shim = path.join(root, 'bin');
  try {
    git(root, ['init', '-q', '--bare', '--initial-branch=main', remote]);
    mkdirSync(local);
    git(local, ['init', '-q', '--initial-branch=main']);
    git(local, ['config', 'user.name', 'Fixture']);
    git(local, ['config', 'user.email', 'fixture@example.invalid']);
    writeFileSync(path.join(local, 'tracked.txt'), 'base');
    git(local, ['add', '.']);
    git(local, ['commit', '-q', '-m', 'base']);
    git(local, ['remote', 'add', 'origin', remote]);
    git(local, ['push', '-q', 'origin', 'HEAD:main']);
    writeFileSync(path.join(local, 'tracked.txt'), 'update');
    git(local, ['add', '.']);
    git(local, ['commit', '-q', '-m', 'candidate']);
    mkdirSync(shim);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(path.join(shim, 'git'), [
      '#!/bin/bash',
      'for arg in "$@"; do',
      '  if [ "$arg" = push ]; then',
      "    echo 'remote: Permission to owner/repo.git denied to actor' >&2",
      `    echo ${shellQuote("fatal: unable to access 'https://x-access-token:secret@example.invalid/repo.git': The requested URL returned error: 403")} >&2`,
      '    exit 128',
      '  fi',
      'done',
      `exec ${shellQuote(realGit)} "$@"`,
      '',
    ].join('\n'));
    chmodSync(path.join(shim, 'git'), 0o755);

    const result = spawnSync(process.execPath, [
      GUARD_SCRIPT, '--push-main', '--remote', 'origin', '--target', 'main', '--after', 'HEAD',
    ], {
      cwd: local,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${shim}${path.delimiter}${process.env.PATH ?? ''}` },
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    assert.equal(result.status, 1, output);
    assert.match(output, /MAIN_TREE_GUARD_FATAL: Push to the configured remote was rejected \(Write permission denied; HTTP 403 Forbidden\)/u);
    assert.match(output, /https:\/\/\[REDACTED\]@example\.invalid/u);
    assert.doesNotMatch(output, /x-access-token:secret/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('un ref riscritto dopo il push supera la lease solo se la verifica finale lo rileva come fatale', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'main-tree-shrink-final-verify-'));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  const shim = path.join(root, 'bin');
  const firstFetch = path.join(root, 'first-fetch-done');
  try {
    git(root, ['init', '-q', '--bare', '--initial-branch=main', remote]);
    mkdirSync(local);
    git(local, ['init', '-q', '--initial-branch=main']);
    git(local, ['config', 'user.name', 'Fixture']);
    git(local, ['config', 'user.email', 'fixture@example.invalid']);
    writeFileSync(path.join(local, 'base.txt'), 'base');
    git(local, ['add', '.']);
    git(local, ['commit', '-q', '-m', 'base']);
    const base = git(local, ['rev-parse', 'HEAD']);
    git(local, ['remote', 'add', 'origin', remote]);
    git(local, ['push', '-q', 'origin', 'HEAD:main']);

    git(local, ['checkout', '-q', '-b', 'divergent', base]);
    writeFileSync(path.join(local, 'divergent.txt'), 'divergent');
    git(local, ['add', '.']);
    git(local, ['commit', '-q', '-m', 'divergent rewrite']);
    const divergent = git(local, ['rev-parse', 'HEAD']);
    git(local, ['checkout', '-q', 'main']);
    writeFileSync(path.join(local, 'candidate.txt'), 'candidate');
    git(local, ['add', '.']);
    git(local, ['commit', '-q', '-m', 'guarded candidate']);

    mkdirSync(shim);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(path.join(shim, 'git'), [
      '#!/bin/bash',
      'for arg in "$@"; do',
      '  if [ "$arg" = fetch ]; then',
      `    if [ -e ${shellQuote(firstFetch)} ]; then`,
      `      ${shellQuote(realGit)} push -q --force origin ${shellQuote(`${divergent}:refs/heads/main`)} || exit $?`,
      '    else',
      `      touch ${shellQuote(firstFetch)}`,
      '    fi',
      '    break',
      '  fi',
      'done',
      `exec ${shellQuote(realGit)} "$@"`,
      '',
    ].join('\n'));
    chmodSync(path.join(shim, 'git'), 0o755);

    const result = spawnSync(process.execPath, [
      GUARD_SCRIPT, '--push-main', '--remote', 'origin', '--target', 'main', '--after', 'HEAD',
    ], {
      cwd: local,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${shim}${path.delimiter}${process.env.PATH ?? ''}` },
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    assert.equal(result.status, 1, output);
    assert.match(output, /MAIN_TREE_GUARD_FATAL: Push succeeded, but final verification failed \(Final remote main does not contain the pushed commit\)/u);
    assert.equal(git(remote, ['--git-dir', remote, 'rev-parse', 'refs/heads/main']), divergent);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('la lease blocca un avanzamento concorrente incorporato nel candidato e il retry rifà il guard sul nuovo tip', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'main-tree-shrink-lease-'));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  const shim = path.join(root, 'bin');
  const concurrentPush = path.join(root, 'concurrent-push-done');
  try {
    git(root, ['init', '-q', '--bare', '--initial-branch=main', remote]);
    git(root, ['init', '-q', '--initial-branch=main', local]);
    git(local, ['config', 'user.name', 'Fixture']);
    git(local, ['config', 'user.email', 'fixture@example.invalid']);
    writeFileSync(path.join(local, 'tracked-0.txt'), 'x');
    git(local, ['add', '.']);
    git(local, ['commit', '-q', '-m', 'small initial tree']);
    git(local, ['remote', 'add', 'origin', remote]);
    git(local, ['push', '-q', 'origin', 'HEAD:main']);

    for (let index = 1; index < 1_001; index += 1) {
      writeFileSync(path.join(local, `tracked-${index}.txt`), 'x');
    }
    git(local, ['add', '.']);
    git(local, ['commit', '-q', '-m', 'concurrent large tree']);
    const concurrentTip = git(local, ['rev-parse', 'HEAD']);
    for (let index = 1; index < 1_001; index += 1) rmSync(path.join(local, `tracked-${index}.txt`));
    git(local, ['add', '-A']);
    git(local, ['commit', '-q', '-m', 'candidate shrink']);

    mkdirSync(shim);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const shimSource = [
      '#!/bin/bash',
      'for arg in "$@"; do',
      '  if [ "$arg" = push ] && [ ! -e ' + shellQuote(concurrentPush) + ' ]; then',
      '    touch ' + shellQuote(concurrentPush),
      '    ' + shellQuote(realGit) + ' push -q origin ' + shellQuote(`${concurrentTip}:refs/heads/main`) + ' || exit $?',
      '    break',
      '  fi',
      'done',
      'exec ' + shellQuote(realGit) + ' "$@"',
      '',
    ].join('\n');
    writeFileSync(path.join(shim, 'git'), shimSource);
    chmodSync(path.join(shim, 'git'), 0o755);

    const env = { ...process.env, PATH: `${shim}${path.delimiter}${process.env.PATH ?? ''}` };
    const guardedPushArgs = [
      GUARD_SCRIPT,
      '--push-main', '--remote', 'origin', '--target', 'main', '--after', 'HEAD',
    ];
    const racedPush = spawnSync(process.execPath, guardedPushArgs, {
      cwd: local,
      encoding: 'utf8',
      env,
    });
    assert.equal(racedPush.status, 1, `${racedPush.stdout ?? ''}${racedPush.stderr ?? ''}`);
    assert.match(`${racedPush.stdout ?? ''}${racedPush.stderr ?? ''}`, /stale info|stale lease|fetch first/iu);
    assert.equal(git(remote, ['--git-dir', remote, 'rev-parse', 'refs/heads/main']), concurrentTip);

    const retriedPush = spawnSync(process.execPath, guardedPushArgs, {
      cwd: local,
      encoding: 'utf8',
      env,
    });
    assert.equal(retriedPush.status, 1, `${retriedPush.stdout ?? ''}${retriedPush.stderr ?? ''}`);
    assert.match(`${retriedPush.stdout ?? ''}${retriedPush.stderr ?? ''}`, /Possible catastrophic main tree shrink: main tree paths: 1001 → 1/u);
    assert.equal(git(remote, ['--git-dir', remote, 'rev-parse', 'refs/heads/main']), concurrentTip);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ogni workflow corpus che pusha main usa il push con guard e lease atomica', () => {
  const dynamicTargetWorkflows = [
    'rescan-journalist-image-catalog.yml',
    'generate-article.yml',
    'generate-article-core.yml',
    'publish-journalist-articles.yml',
    'refresh-events-digest.yml',
    'batch-faq-articles.yml',
    'generate-border-wait-ranking-weekly.yml',
    'refresh-canton-hubs.yml',
    'generate-daily-brief.yml',
  ];
  const dynamicPush = /(?:if push_target; then|push_target 2>&1 \| tee "\$ATTEMPT_LOG")/gu;
  const guardedTargetFunction = /push_target\(\) \{\s+if \[ "\$TARGET" = 'main' \]; then\s+node scripts\/ci\/guard-main-tree-shrink\.mjs --push-main --remote "\$REMOTE" --target main --after HEAD\s+else\s+git push "\$REMOTE" "HEAD:\$TARGET"\s+fi\s+\}/u;
  for (const workflow of dynamicTargetWorkflows) {
    const source = readFileSync(path.join(ROOT, '.github/workflows', workflow), 'utf8');
    const pushes = [...source.matchAll(dynamicPush)];
    assert.equal(pushes.length, 1, `${workflow}: numero inatteso di invocazioni push_target`);
    assert.match(source, guardedTargetFunction, `${workflow}: manca il push main con fetch e lease`);
    if (workflow !== 'generate-daily-brief.yml') {
      assert.match(source, /if push_target 2>&1 \| tee "\$ATTEMPT_LOG"; then/u, `${workflow}: il log del push non viene conservato`);
    }
    assert.match(
      source,
      /grep -q 'MAIN_TREE_GUARD_FATAL:' "\$ATTEMPT_LOG"[\s\S]{0,220}exit 1/u,
      `${workflow}: gli errori fatali del guard devono fermare il retry`,
    );
  }

  const fixedMainWorkflows = [
    {
      file: 'regenerate-queued-covers.yml',
      push: /node scripts\/ci\/guard-main-tree-shrink\.mjs --push-main --remote origin --target main --after HEAD --no-thin --no-verify --git-config pack\.window=0 --git-config pack\.threads=1/gu,
      pushCount: 3,
    },
    {
      file: 'publish-api.yml',
      push: /node scripts\/ci\/guard-main-tree-shrink\.mjs --push-main --remote origin --target main --after HEAD --git-config "http\.extraheader=AUTHORIZATION: basic \$auth_header"/gu,
      pushCount: 1,
    },
    {
      file: 'transport-identical-twins-realign.yml',
      push: /node scripts\/ci\/guard-main-tree-shrink\.mjs --push-main --remote origin --target main --after HEAD/gu,
      pushCount: 2,
    },
  ];
  for (const { file, push, pushCount } of fixedMainWorkflows) {
    const source = readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8');
    const pushes = [...source.matchAll(push)];
    assert.equal(pushes.length, pushCount, `${file}: numero inatteso di push guarded a main`);
  }

  const dailyBrief = readFileSync(path.join(ROOT, '.github/workflows/generate-daily-brief.yml'), 'utf8');
  assert.match(dailyBrief, /grep -q 'MAIN_TREE_GUARD_FATAL:' "\$ATTEMPT_LOG"[\s\S]{0,220}refusing the ledger-only soft-fail/u);

  const retryWorkflowFatalMarkers = [
    ['publish-api.yml', 1],
    ['regenerate-queued-covers.yml', 3],
    ['transport-identical-twins-realign.yml', 2],
  ];
  for (const [file, expectedCount] of retryWorkflowFatalMarkers) {
    const source = readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8');
    assert.equal(
      [...source.matchAll(/grep -q 'MAIN_TREE_GUARD_FATAL:' "\$push_log"/gu)].length,
      expectedCount,
      `${file}: ogni ciclo di retry deve propagare gli errori fatali della guardia`,
    );
  }
});

test('il batch FAQ controlla entrambi i push intermedi prima di scriverli su main', () => {
  const source = readFileSync(path.join(ROOT, 'generator/scripts/batch-add-faq-to-articles.mjs'), 'utf8');
  const pushCalls = [...source.matchAll(/^\s+pushMainWithTreeGuard\(chainStartedAt(?:, GIT_REBASE_ABORT_RESERVE_MS)?\);/gmu)];

  assert.equal(pushCalls.length, 2, 'ogni checkpoint, incluso il retry dopo rebase, deve usare il push guarded');
  assert.doesNotMatch(source, /authenticatedGit\(\['push', 'origin', 'main'\]/u);
  assert.match(source, /result\.stderr\?\.includes\('MAIN_TREE_GUARD_FATAL:'\)/u);
  assert.match(source, /if \(pushErr\?\.code === 'MAIN_TREE_GUARD_FATAL'\) throw pushErr;/u);
  assert.match(source, /if \(retryErr\?\.code === 'MAIN_TREE_GUARD_FATAL'\) throw retryErr;/u);
  assert.match(source, /if \(err\?\.code === 'MAIN_TREE_GUARD_FATAL'\) throw err;/u);
});
