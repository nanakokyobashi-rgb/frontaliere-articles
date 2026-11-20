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
  assert.match(callLog, /ls-remote --refs origin refs\/heads\/main/);
  assert.doesNotMatch(readFileSync(HELPER, 'utf8'), /gh api/);
});

test('read-main-head resta fail-closed se la ref non e leggibile', () => {
  const { result, callLog } = runWithFakeGit({ output: 'not-a-sha\trefs/heads/main\n', status: 0 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /non risolvibile via git ls-remote/);
  assert.equal(callLog.trim().split('\n').length, 3);
});

test('canton publisher only accepts fast-forwards limited to bookkeeping and generation-only code', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'section-source-freshness-'));
  const helper = path.join(ROOT, 'scripts/ci/section-source-unaffected.sh');
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const commit = (relativePath, contents) => {
    mkdirSync(path.dirname(path.join(directory, relativePath)), { recursive: true });
    writeFileSync(path.join(directory, relativePath), contents);
    git('add', '--', relativePath);
    git('commit', '-qm', relativePath);
    return git('rev-parse', 'HEAD');
  };
  const check = (base, head) => spawnSync('bash', [helper, base, head], { cwd: directory }).status;

  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    const base = commit('content/article.txt', 'original');
    const bookkeeping = commit('data/image-regeneration-queue.json', '{}');
    const pending = commit('data/image-regeneration-queue-pending.jsonl', '{}');
    const pendingShard = commit('data/image-regeneration-queue-pending.jsonl.12.34.0.pending', '{}');
    const cantonRejected = commit('data/sections/canton-ju/topic-candidates-evergreen-rejected.json', '{}');
    commit('generator/scripts/create-article.mjs', '// draft generation');
    commit('generator/scripts/lib/canton-news-sources.mjs', '// source scan');
    commit('generator/tests/canton-news-sources.test.mjs', '// source scan tests');
    const generatorFix = commit('generator/tests/pending-body-second-lane.test.mjs', '// translation tests');
    const cantonArticle = commit('data/sections/canton-ju/articles/jura.json', '{}');
    const unrelated = commit('data/image-regeneration-queue-pending.jsonl.12.34.0.pending.bak', '{}');
    const content = commit('content/article.txt', 'updated');
    const latest = commit('data/discovery-attempt-state.json', '{}');
    assert.equal(check(base, base), 0);
    assert.equal(check(base, bookkeeping), 0);
    assert.equal(check(bookkeeping, pending), 0);
    assert.equal(check(bookkeeping, pendingShard), 0);
    assert.equal(check(pendingShard, cantonRejected), 0);
    assert.equal(check(cantonRejected, generatorFix), 0);
    assert.equal(check(generatorFix, cantonArticle), 1);
    assert.equal(check(cantonArticle, unrelated), 1);
    assert.equal(check(content, latest), 0);
    assert.equal(check(base, latest), 1, 'a later bookkeeping commit cannot hide an intervening article change');
    assert.equal(check(latest, base), 1, 'a rewind cannot reuse the snapshot');
    assert.equal(check('invalid', latest), 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
