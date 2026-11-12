import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const HELPER = join(ROOT, 'scripts/dev/fast-worktree.sh');
const FETCH_HELPER = join(ROOT, 'scripts/dev/fetch-origin-main.mjs');
const LOCK_HELPER = join(ROOT, 'scripts/lib/single-flight-lock.mjs');

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function put(repo, path, contents = path) {
  const target = join(repo, path);
  mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true });
  writeFileSync(target, contents);
}

test('fast-worktree --add includes requested paths and excludes siblings', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'fast-worktree-sparse-add-'));
  const repo = join(tempRoot, 'repo');
  const remote = join(tempRoot, 'origin.git');

  try {
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'test');

    mkdirSync(join(repo, 'scripts/dev'), { recursive: true });
    mkdirSync(join(repo, 'scripts/lib'), { recursive: true });
    cpSync(HELPER, join(repo, 'scripts/dev/fast-worktree.sh'), { recursive: true });
    cpSync(FETCH_HELPER, join(repo, 'scripts/dev/fetch-origin-main.mjs'), { recursive: true });
    cpSync(LOCK_HELPER, join(repo, 'scripts/lib/single-flight-lock.mjs'), { recursive: true });
    put(repo, 'content/selected.json');
    put(repo, 'content/sibling.json');
    put(repo, 'content/nested/selected.json');
    put(repo, 'content/nested/sibling.json');
    put(repo, 'data/docs/guide.md');
    put(repo, 'data/docs/reference.md');
    put(repo, 'data/other.json');

    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'fixture');
    git(tempRoot, 'init', '-q', '--bare', remote);
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', '-u', 'origin', 'main');

    execFileSync('bash', [join(repo, 'scripts/dev/fast-worktree.sh'), 'requested-files',
      '--add', 'content/selected.json', '--add', 'content/nested/selected.json'], { encoding: 'utf8' });
    const fileWorktree = join(repo, '.claude/worktrees/requested-files');
    assert.equal(readFileSync(join(fileWorktree, 'content/selected.json'), 'utf8'), 'content/selected.json');
    assert.equal(readFileSync(join(fileWorktree, 'content/nested/selected.json'), 'utf8'), 'content/nested/selected.json');
    assert.equal(exists(fileWorktree, 'content/sibling.json'), false);
    assert.equal(exists(fileWorktree, 'content/nested/sibling.json'), false);

    execFileSync('bash', [join(repo, 'scripts/dev/fast-worktree.sh'), 'requested-directory',
      '--add', 'data/docs'], { encoding: 'utf8' });
    const directoryWorktree = join(repo, '.claude/worktrees/requested-directory');
    assert.equal(exists(directoryWorktree, 'data/docs/guide.md'), true);
    assert.equal(exists(directoryWorktree, 'data/docs/reference.md'), true);
    assert.equal(exists(directoryWorktree, 'data/other.json'), false);

    let missingPathError;
    try {
      execFileSync('bash', [join(repo, 'scripts/dev/fast-worktree.sh'), 'missing-path',
        '--add', 'content/not-present.json'], { encoding: 'utf8' });
    } catch (error) {
      missingPathError = error;
    }
    assert.equal(missingPathError?.status, 1);
    assert.match(missingPathError?.stderr?.toString() ?? '', /path --add non materializzati: content\/not-present\.json/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

function exists(root, path) {
  try {
    readFileSync(join(root, path));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
