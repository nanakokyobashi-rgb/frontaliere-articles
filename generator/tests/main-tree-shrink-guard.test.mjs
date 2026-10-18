import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('il retry helper controlla main anche quando il push usa --no-verify', () => {
  const helper = readFileSync(PUSH_HELPER, 'utf8');
  const guardCall = helper.indexOf('if ! guard_main_tree_shrink; then');
  const pushCall = helper.indexOf('git -c pack.window=0 -c pack.threads=1 push --no-thin --no-verify');
  assert.ok(guardCall >= 0, 'guardia main assente dal retry helper');
  assert.ok(pushCall > guardCall, 'il push parte prima del controllo integrità');
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

test('ogni workflow corpus che pusha main controlla prima la dimensione dell’albero', () => {
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
  const dynamicPush = /git push\s+"\$REMOTE"\s+"HEAD:\$TARGET"/gu;
  const dynamicGuard = /if \[ "\$TARGET" = 'main' \]; then\s+node scripts\/ci\/guard-main-tree-shrink\.mjs --before origin\/main --after HEAD \|\| exit 1\s+fi/gu;
  for (const workflow of dynamicTargetWorkflows) {
    const source = readFileSync(path.join(ROOT, '.github/workflows', workflow), 'utf8');
    const pushes = [...source.matchAll(dynamicPush)];
    const guards = [...source.matchAll(dynamicGuard)];
    assert.equal(pushes.length, 1, `${workflow}: numero inatteso di push con target dinamico`);
    assert.equal(guards.length, pushes.length, `${workflow}: manca il guard per il target main`);
    assert.ok(guards[0].index < pushes[0].index, `${workflow}: il guard viene dopo il push`);
  }

  const fixedMainWorkflows = [
    {
      file: 'regenerate-queued-covers.yml',
      push: /git -c pack\.window=0 -c pack\.threads=1 push --no-thin --no-verify origin HEAD:main/gu,
      guardCount: 3,
    },
    {
      file: 'publish-api.yml',
      push: /push origin HEAD:main/gu,
      guardCount: 1,
    },
    {
      file: 'transport-identical-twins-realign.yml',
      push: /git push origin HEAD:main/gu,
      guardCount: 2,
    },
  ];
  for (const { file, push, guardCount } of fixedMainWorkflows) {
    const source = readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8');
    const pushes = [...source.matchAll(push)];
    const guards = [...source.matchAll(/node scripts\/ci\/guard-main-tree-shrink\.mjs --before origin\/main --after HEAD(?: \|\| (?:exit 1|return 1))?/gu)];
    assert.equal(pushes.length, guardCount, `${file}: numero inatteso di push a main`);
    assert.equal(guards.length, pushes.length, `${file}: manca un guard prima del push a main`);
    for (let index = 0; index < pushes.length; index += 1) {
      assert.ok(guards[index].index < pushes[index].index, `${file}: guard ${index + 1} dopo il push`);
    }
  }
});

test('il batch FAQ controlla entrambi i push intermedi prima di scriverli su main', () => {
  const source = readFileSync(path.join(ROOT, 'generator/scripts/batch-add-faq-to-articles.mjs'), 'utf8');
  const guardCalls = [...source.matchAll(/guardMainTreeBeforePush\(chainStartedAt\);/gu)];
  const pushCalls = [...source.matchAll(/authenticatedGit\(\['push', 'origin', 'main'\]/gu)];

  assert.equal(guardCalls.length, 2, 'ogni checkpoint, incluso il retry dopo rebase, deve controllare il tree');
  assert.equal(pushCalls.length, 2, 'numero inatteso di push checkpoint a main');
  for (let index = 0; index < pushCalls.length; index++) {
    assert.ok(guardCalls[index].index < pushCalls[index].index, `guard FAQ ${index + 1} dopo il push`);
  }
});
