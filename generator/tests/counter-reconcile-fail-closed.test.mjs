import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmTempTree } from './rm-temp-tree.mjs';
import { mergeCounterDocuments } from '../../scripts/lib/merge-counter-conflict.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const RESOLVER = path.join(ROOT, 'scripts/lib/merge-counter-conflict.mjs');
const REBASE_HELPER = path.join(ROOT, 'scripts/lib/rebase-onto-remote.sh');
const EXPERIMENTAL = 'data/topic-candidates-experimental-counter.json';
const EVERGREEN = 'data/topic-candidates-evergreen-counter.json';
const DISCOVERY_STATE = 'data/discovery-attempt-state.json';
const FRONTALIERE_DISCOVERY_PAIR = 'frontaliereProvenAttempts,frontaliereDiscoveryResetAt';
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

function discoveryState(proven, resetAt, extra = {}) {
  return `${JSON.stringify({
    version: 1,
    frontaliereProvenAttempts: proven,
    frontaliereDiscoveryResetAt: resetAt,
    svizzeraProvenAttempts: 8,
    svizzeraDiscoveryResetAt: 6,
    ...extra,
  }, null, 2)}\n`;
}

function makeDiscoveryWorld({ base, upstream, replayed }) {
  const root = mkdtempSync(path.join(tmpdir(), 'counter-reconcile-discovery-'));
  git(root, 'init', '-q', '--initial-branch=main');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  write(root, DISCOVERY_STATE, base);
  commit(root, 'discovery state base');
  git(root, 'switch', '-q', '-c', 'producer');
  write(root, DISCOVERY_STATE, replayed);
  commit(root, 'discovery state replay');
  const preRebase = git(root, 'rev-parse', 'HEAD').trim();
  git(root, 'switch', '-q', 'main');
  write(root, DISCOVERY_STATE, upstream);
  commit(root, 'discovery state upstream');
  const upstreamRevision = git(root, 'rev-parse', 'HEAD').trim();
  git(root, 'switch', '-q', 'producer');
  return { root, preRebase, upstreamRevision, cleanup: () => rmTempTree(root) };
}

function runDiscoveryReconcile(world) {
  return spawnSync('node', [
    RESOLVER,
    '--reconcile',
    world.preRebase,
    world.upstreamRevision,
    `${DISCOVERY_STATE}:${FRONTALIERE_DISCOVERY_PAIR}`,
  ], {
    cwd: world.root,
    env: GIT_ENV,
    encoding: 'utf8',
  });
}

const mergeDiscoveryPair = (base, upstream, replayed) => mergeCounterDocuments({
  base: discoveryState(...base),
  upstream: discoveryState(...upstream),
  replayed: discoveryState(...replayed),
  field: FRONTALIERE_DISCOVERY_PAIR,
});

test('due reset discovery concorrenti conservano il watermark invece di sommarlo', () => {
  const result = mergeDiscoveryPair([5, 3], [5, 5], [5, 5]);
  assert.equal(result.ok, true, result.reason);
  const merged = JSON.parse(result.merged);
  assert.equal(merged.frontaliereProvenAttempts, 5);
  assert.equal(merged.frontaliereDiscoveryResetAt, 5);
  assert.equal(merged.svizzeraProvenAttempts, 8);
  assert.equal(merged.svizzeraDiscoveryResetAt, 6);
});

test('tentativi proven concorrenti si sommano e il reset resta un watermark', () => {
  const result = mergeDiscoveryPair([5, 3], [6, 3], [6, 3]);
  assert.equal(result.ok, true, result.reason);
  const merged = JSON.parse(result.merged);
  assert.equal(merged.frontaliereProvenAttempts, 7);
  assert.equal(merged.frontaliereDiscoveryResetAt, 3);
});

test('un reset concorrente con un fallimento mantiene il debito successivo al reset', () => {
  const result = mergeDiscoveryPair([5, 3], [5, 5], [6, 3]);
  assert.equal(result.ok, true, result.reason);
  const merged = JSON.parse(result.merged);
  assert.equal(merged.frontaliereProvenAttempts, 6);
  assert.equal(merged.frontaliereDiscoveryResetAt, 5);
  assert.ok(merged.frontaliereDiscoveryResetAt <= merged.frontaliereProvenAttempts);
});

test('successi proven concorrenti sommano i tentativi e lasciano azzerato il debito', () => {
  const result = mergeDiscoveryPair([5, 3], [6, 6], [6, 6]);
  assert.equal(result.ok, true, result.reason);
  const merged = JSON.parse(result.merged);
  assert.equal(merged.frontaliereProvenAttempts, 7);
  assert.equal(merged.frontaliereDiscoveryResetAt, 7);
  assert.match(result.rule, /DiscoveryResetAt=7 \(entrambi i rami terminano con reset\)/);
});

test('il merge rifiuta un watermark discovery invalido in uno dei lati', () => {
  const result = mergeDiscoveryPair([5, 3], [5, 5], [5, 6]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /watermark discovery supera ProvenAttempts/);
});

test('il reconcile integrato aggiorna la coppia discovery come un unico stato', () => {
  const world = makeDiscoveryWorld({
    base: discoveryState(5, 3, { source: 'base' }),
    upstream: discoveryState(5, 5, { source: 'upstream' }),
    replayed: discoveryState(6, 3, { source: 'replayed' }),
  });
  try {
    const result = runDiscoveryReconcile(world);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const merged = JSON.parse(readFileSync(path.join(world.root, DISCOVERY_STATE), 'utf8'));
    assert.equal(merged.frontaliereProvenAttempts, 6);
    assert.equal(merged.frontaliereDiscoveryResetAt, 5);
    assert.equal(merged.source, 'replayed', 'il reconcile modifica solo i campi dichiarati della working tree rebased');
    assert.equal(result.stdout.trim(), DISCOVERY_STATE);
  } finally {
    world.cleanup();
  }
});

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
  {
    name: 'counter decrement in upstream',
    upstreamEvergreen: '{"count":9}\n',
    replayedEvergreen: '{"count":11}\n',
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
  const statusContract = readFileSync(path.join(ROOT, 'scripts/lib/rebase-onto-remote-status.sh'), 'utf8');
  assert.match(statusContract, /^COUNTER_RECONCILE_FAILURE_STATUS=42$/m);
  assert.match(helper, /\. "\$SCRIPT_DIR\/rebase-onto-remote-status\.sh"/);
  assert.equal(
    (helper.match(/reconcile_counters \|\| exit "\$COUNTER_RECONCILE_FAILURE_STATUS"/g) ?? []).length,
    2,
    'every successful rebase path must distinguish a failed counter reconciliation',
  );

  for (const file of WORKFLOWS) {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(
      source,
      /source scripts\/lib\/rebase-onto-remote-status\.sh[\s\S]+?if bash scripts\/lib\/rebase-onto-remote\.sh[\s\S]+?--take-theirs public\/images\/blog\/; then\s+:\s+else\s+rebase_status=\$\?\s+if \[ "\$rebase_status" -eq "\$COUNTER_RECONCILE_FAILURE_STATUS" \]; then\s+echo "::error::counter reconciliation failed; refusing to retry push"\s+exit 1\s+fi\s+rebased=0\s+fi/,
      `${file}: exit 42 must stop push retries while other helper failures retain their retry path`,
    );
    assert.doesNotMatch(source, /--take-theirs public\/images\/blog\/ \|\| rebased=0/, file);
  }
});
