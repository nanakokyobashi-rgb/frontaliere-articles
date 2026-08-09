/**
 * scripts/lib/rebase-onto-remote.sh — regression suite.
 *
 * The helper exists because a rebase conflict on a whole-file bookkeeping cache
 * is NOT transient: the retry loop in generate-article.yml re-ran the identical
 * operation five times and failed identically, and the step's own error message
 * spells out the stake — "the article is registered locally but not pushed"
 * (issue #76).
 *
 * These tests build throwaway git repositories on disk and drive the real
 * script, because every bug this file pins was in the interaction with git's
 * actual rebase state machine, not in logic that could be unit-tested. In
 * particular `assert_multiple_conflicting_commits_all_replay` pins the one that
 * a first cut of the script got wrong: `git rebase --continue` returning
 * non-zero can mean "advanced and stopped on the NEXT conflict" just as much as
 * "the replayed commit is now empty". Treating it as only the latter aborted a
 * rebase that was halfway through succeeding, and the commit it dropped was the
 * one carrying the article — i.e. the exact failure the helper was written to
 * prevent, reintroduced by the helper.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '../../scripts/lib/rebase-onto-remote.sh');
const BOOKKEEPING = 'data/topic-candidates-evergreen-rejected.json';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function write(root, rel, contents) {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
}

function commitAll(root, message) {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
}

/** Runs the helper. Returns { code, out } — never throws on a non-zero exit. */
function runHelper(cwd, upstreamPath, ...allowlist) {
  try {
    const out = execFileSync('bash', [SCRIPT, upstreamPath, 'main', ...allowlist], {
      cwd,
      env: GIT_ENV,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/**
 * Builds: a bare upstream, a `work` clone (this run) and an `other` clone
 * (a concurrent run), with one shared base commit.
 */
function makeWorld() {
  const root = mkdtempSync(path.join(tmpdir(), 'rebase-onto-remote-'));
  const upstream = path.join(root, 'up.git');
  const work = path.join(root, 'work');
  const other = path.join(root, 'other');

  git(root, 'init', '-q', '--bare', 'up.git');
  git(root, 'init', '-q', 'work');
  write(work, BOOKKEEPING, '{"base":true}\n');
  write(work, 'README.md', 'base\n');
  commitAll(work, 'base');
  git(work, 'push', '-q', upstream, 'HEAD:main');
  git(root, 'clone', '-q', upstream, 'other');

  return {
    root,
    upstream,
    work,
    other,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Makes the concurrent run land `commits` on upstream main. */
function landUpstream(w, commits) {
  git(w.other, 'fetch', '-q', 'origin', 'main');
  git(w.other, 'reset', '-q', '--hard', 'origin/main');
  for (const [rel, contents, message] of commits) {
    write(w.other, rel, contents);
    commitAll(w.other, message);
  }
  git(w.other, 'push', '-q', 'origin', 'HEAD:main');
}

function headSha(root) {
  return git(root, 'rev-parse', 'HEAD').trim();
}

function rebaseInProgress(root) {
  return existsSync(path.join(root, '.git', 'rebase-merge')) || existsSync(path.join(root, '.git', 'rebase-apply'));
}

test('an article survives a conflict confined to the bookkeeping cache', () => {
  const w = makeWorld();
  try {
    landUpstream(w, [[BOOKKEEPING, '{"other":true}\n', 'concurrent run rewrites the cache']]);

    write(w.work, BOOKKEEPING, '{"mine":true}\n');
    write(w.work, 'content/blog-body/it/nuovo-articolo.ts', 'export const x = 1\n');
    commitAll(w.work, 'Generate blog article (frontaliere)');

    const { code, out } = runHelper(w.work, w.upstream, BOOKKEEPING);
    assert.equal(code, 0, `helper should succeed, got:\n${out}`);

    git(w.work, 'push', '-q', w.upstream, 'HEAD:main');
    assert.ok(
      existsSync(path.join(w.work, 'content/blog-body/it/nuovo-articolo.ts')),
      'the generated article must survive the rebase — losing it is the whole bug',
    );
    assert.match(
      git(w.work, 'show', `HEAD:${BOOKKEEPING}`),
      /other/,
      'the bookkeeping cache must end up as upstream wrote it',
    );
  } finally {
    w.cleanup();
  }
});

test('multiple conflicting commits all replay, and the article is not dropped', () => {
  // The regression. Two local commits both conflict on the cache; the first
  // becomes empty once upstream's copy is taken, the second carries the article.
  const w = makeWorld();
  try {
    landUpstream(w, [
      [BOOKKEEPING, '{"u":1}\n', 'u1'],
      [BOOKKEEPING, '{"u":2}\n', 'u2'],
    ]);

    write(w.work, BOOKKEEPING, '{"m":1}\n');
    commitAll(w.work, 'Record rejected topic candidates (no article generated)');
    write(w.work, BOOKKEEPING, '{"m":2}\n');
    write(w.work, 'content/blog-body/it/articolo.ts', 'export const w = 9\n');
    commitAll(w.work, 'Generate blog article (frontaliere)');

    const { code, out } = runHelper(w.work, w.upstream, BOOKKEEPING);
    assert.equal(code, 0, `helper should succeed across several conflict passes, got:\n${out}`);

    git(w.work, 'push', '-q', w.upstream, 'HEAD:main');
    assert.ok(
      existsSync(path.join(w.work, 'content/blog-body/it/articolo.ts')),
      'the article in the SECOND commit must survive',
    );
    assert.match(git(w.work, 'show', `HEAD:${BOOKKEEPING}`), /"u":2/);
    // The bookkeeping-only commit contributed nothing once upstream won, so it
    // should have been dropped rather than landed empty.
    const subjects = git(w.work, 'log', '--format=%s', '-3').trim().split('\n');
    assert.ok(
      !subjects.includes('Record rejected topic candidates (no article generated)'),
      `the emptied bookkeeping commit should be dropped, got: ${JSON.stringify(subjects)}`,
    );
  } finally {
    w.cleanup();
  }
});

test('a bookkeeping-only run ends as a no-op instead of a failure', () => {
  const w = makeWorld();
  try {
    landUpstream(w, [[BOOKKEEPING, '{"other":true}\n', 'concurrent run rewrites the cache']]);

    write(w.work, BOOKKEEPING, '{"mine":true}\n');
    commitAll(w.work, 'Record rejected topic candidates (no article generated)');

    const { code, out } = runHelper(w.work, w.upstream, BOOKKEEPING);
    assert.equal(code, 0, `helper should succeed, got:\n${out}`);

    const upstreamSha = git(w.work, 'ls-remote', w.upstream, 'main').split(/\s/)[0];
    assert.equal(headSha(w.work), upstreamSha, 'HEAD should equal upstream so the retried push is a no-op success');
  } finally {
    w.cleanup();
  }
});

test('a conflict outside the allowlist aborts and leaves the tree untouched', () => {
  const w = makeWorld();
  try {
    landUpstream(w, [['README.md', 'upstream version\n', 'concurrent run edits README']]);

    write(w.work, 'README.md', 'my version\n');
    write(w.work, 'content/blog-body/it/altro.ts', 'export const y = 2\n');
    commitAll(w.work, 'Generate blog article (frontaliere)');
    const before = headSha(w.work);

    const { code, out } = runHelper(w.work, w.upstream, BOOKKEEPING);
    assert.equal(code, 1, 'a non-bookkeeping conflict must still fail, exactly as before the fix');
    assert.match(out, /not a whole-file bookkeeping cache/);
    assert.equal(headSha(w.work), before, 'HEAD must be untouched after the abort');
    assert.equal(git(w.work, 'status', '--porcelain').trim(), '', 'the working tree must be left clean');
    assert.ok(!rebaseInProgress(w.work), 'no rebase may be left in progress');
  } finally {
    w.cleanup();
  }
});

test('a plain divergence with no conflict rebases cleanly', () => {
  const w = makeWorld();
  try {
    landUpstream(w, [['UNRELATED.md', 'upstream\n', 'unrelated upstream commit']]);

    write(w.work, 'content/blog-body/it/terzo.ts', 'export const z = 3\n');
    commitAll(w.work, 'Generate blog article (frontaliere)');

    const { code, out } = runHelper(w.work, w.upstream, BOOKKEEPING);
    assert.equal(code, 0, `the ordinary path must keep working, got:\n${out}`);
    git(w.work, 'push', '-q', w.upstream, 'HEAD:main');
  } finally {
    w.cleanup();
  }
});

test('an empty allowlist is a caller bug, not a silent always-abort', () => {
  // Without this guard a caller that forgot its paths would degrade to exactly
  // the old behaviour, which is indistinguishable from the fix not being there.
  const w = makeWorld();
  try {
    const { code } = runHelper(w.work, w.upstream);
    assert.equal(code, 2);
  } finally {
    w.cleanup();
  }
});
