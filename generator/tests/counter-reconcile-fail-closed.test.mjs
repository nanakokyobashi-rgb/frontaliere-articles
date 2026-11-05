import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmTempTree } from './rm-temp-tree.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const RESOLVER = path.join(ROOT, 'scripts/lib/merge-counter-conflict.mjs');
const REBASE_HELPER = path.join(ROOT, 'scripts/lib/rebase-onto-remote.sh');
const EXPERIMENTAL = 'data/topic-candidates-experimental-counter.json';
const EVERGREEN = 'data/topic-candidates-evergreen-counter.json';
const WORKFLOWS = [
  '.github/workflows/generate-article.yml',
  '.github/workflows/generate-article-core.yml',
];
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  NODE_TEST_CONTEXT: '',
};

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    env: GIT_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function write(root, rel, text) {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function commit(root, message) {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
}

function makeWorld({ upstreamEvergreen, replayedEvergreen = '{"count":11}\n' }) {
  const root = mkdtempSync(path.join(tmpdir(), 'counter-reconcile-fail-closed-'));
  git(root, 'init', '-q', '--initial-branch=main');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  write(root, EXPERIMENTAL, '{"count":10}\n');
  write(root, EVERGREEN, '{"count":10}\n');
  commit(root, 'counter base');

  git(root, 'switch', '-q', '-c', 'producer');
  write(root, EXPERIMENTAL, '{"count":11}\n');
  write(root, EVERGREEN, replayedEvergreen);
  write(root, 'content/blog-body/it/article.ts', 'export const article = true\n');
  commit(root, 'generated article');
  const preRebase = git(root, 'rev-parse', 'HEAD').trim();

  git(root, 'switch', '-q', 'main');
  if (upstreamEvergreen === null) unlinkSync(path.join(root, EVERGREEN));
  else write(root, EVERGREEN, upstreamEvergreen);
  commit(root, 'upstream counter state');
  const upstream = git(root, 'rev-parse', 'HEAD').trim();

  return { root, preRebase, upstream, cleanup: () => rmTempTree(root) };
}

function runReconcile(world) {
  return spawnSync('node', [
    RESOLVER,
    '--reconcile',
    world.preRebase,
    world.upstream,
    `${EXPERIMENTAL}:count`,
    `${EVERGREEN}:count`,
  ], {
    cwd: world.root,
    env: GIT_ENV,
    encoding: 'utf8',
  });
}

for (const scenario of [
  {
    name: 'missing upstream counter file',
    upstreamEvergreen: null,
    expectedCategory: 'missing-revision-file',
  },
  {
    name: 'unreadable upstream counter',
    upstreamEvergreen: '{"count":"invalid"}\n',
    expectedCategory: 'counter-not-reconcilable',
  },
  {
    name: 'counter decrement in replayed commit',
    upstreamEvergreen: '{"count":12}\n',
    replayedEvergreen: '{"count":9}\n',
    expectedCategory: 'counter-not-reconcilable',
  },
]) {
  test(`post-rebase reconcile fails closed on ${scenario.name} before writing any counter`, () => {
    const world = makeWorld(scenario);
    try {
      const result = runReconcile(world);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, new RegExp(`category=${scenario.expectedCategory}`));
      assert.equal(JSON.parse(readFileSync(path.join(world.root, EXPERIMENTAL), 'utf8')).count, 10,
        'the valid first spec must not be written before a later spec fails');
      assert.equal(git(world.root, 'status', '--porcelain').trim(), '',
        'a rejected reconciliation leaves the rebased worktree unchanged');
    } finally {
      world.cleanup();
    }
  });
}

test('una spec assente da tutte le revisioni e dal worktree e\' un no-op verificato', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'counter-reconcile-absent-'));
  try {
    git(root, 'init', '-q', '--initial-branch=main');
    git(root, 'config', 'user.name', 'test');
    git(root, 'config', 'user.email', 'test@example.invalid');
    write(root, 'README.md', 'base\n');
    commit(root, 'base without optional counter');
    const revision = git(root, 'rev-parse', 'HEAD').trim();
    const result = spawnSync('node', [
      RESOLVER,
      '--reconcile',
      revision,
      revision,
      'data/optional-counter.json:count',
    ], {
      cwd: root,
      env: GIT_ENV,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(git(root, 'status', '--porcelain').trim(), '');
  } finally {
    rmTempTree(root);
  }
});

test('counter reconciliation failures stop both retry workflows while ordinary rebase failures remain retryable', () => {
  const helper = readFileSync(REBASE_HELPER, 'utf8');
  assert.match(helper, /COUNTER_RECONCILE_FAILURE_STATUS=42/);
  assert.equal(
    (helper.match(/reconcile_counters \|\| exit "\$COUNTER_RECONCILE_FAILURE_STATUS"/g) ?? []).length,
    2,
    'every successful rebase path must distinguish a failed counter reconciliation',
  );

  for (const file of WORKFLOWS) {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(
      source,
      /if bash scripts\/lib\/rebase-onto-remote\.sh[\s\S]+?--take-theirs public\/images\/blog\/; then\s+:\s+else\s+rebase_status=\$\?\s+if \[ "\$rebase_status" -eq 42 \]; then\s+echo "::error::counter reconciliation failed; refusing to retry push"\s+exit 1\s+fi\s+rebased=0\s+fi/,
      `${file}: exit 42 must stop push retries while other helper failures retain their retry path`,
    );
    assert.doesNotMatch(source, /--take-theirs public\/images\/blog\/ \|\| rebased=0/, file);
  }
});
