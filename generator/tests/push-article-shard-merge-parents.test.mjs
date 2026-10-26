import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve('.');
const PUSHER = join(ROOT, 'scripts/lib/push-article-shard-incremental.sh');
const RELPATH = 'articolifrontaliere/merge-only-second-parent/index.html';

function git(cwd, args, options = {}) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    ...options,
  }).trim();
}

function commit(cwd, message, date) {
  execFileSync('git', [
    '-C', cwd,
    '-c', 'user.name=merge-parent-test',
    '-c', 'user.email=merge-parent-test@example.invalid',
    'commit', '-qm', message,
  ], {
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

test('keeps a newer merge publication when the requested path differs only from a non-first parent', () => {
  const root = mkdtempSync(join(tmpdir(), 'article-shard-merge-parent-'));
  const source = join(root, 'source');
  const repo = join(root, 'repo');
  const remote = join(root, 'remote.git');
  const runnerTemp = join(root, 'runner-temp');
  mkdirSync(source, { recursive: true });
  mkdirSync(runnerTemp);
  mkdirSync(join(source, 'articolifrontaliere/merge-only-second-parent'), { recursive: true });
  writeFileSync(join(source, RELPATH), 'incoming\n');

  try {
    execFileSync('git', ['init', '-q', '--initial-branch=main', repo]);
    git(repo, ['config', 'user.name', 'merge-parent-test']);
    git(repo, ['config', 'user.email', 'merge-parent-test@example.invalid']);
    mkdirSync(join(repo, 'articolifrontaliere/merge-only-second-parent'), { recursive: true });
    writeFileSync(join(repo, RELPATH), 'base\n');
    writeFileSync(join(repo, '.shard-filecount'), '1\n');
    git(repo, ['add', RELPATH, '.shard-filecount']);
    commit(repo, 'seed\n\nContent-Rev: 1300000000.aaaaaaa', '@1300000000 +0000');

    git(repo, ['checkout', '-qb', 'side']);
    writeFileSync(join(repo, RELPATH), 'second-parent\n');
    git(repo, ['add', RELPATH]);
    commit(repo, 'side\n\nContent-Rev: 1400000100.bbbbbbb', '@1400000100 +0000');

    git(repo, ['checkout', 'main']);
    writeFileSync(join(repo, RELPATH), 'first-parent\n');
    git(repo, ['add', RELPATH]);
    commit(repo, 'first parent\n\nContent-Rev: 1400000000.ccccccc', '@1400000000 +0000');

    try {
      git(repo, ['merge', '--no-ff', '--no-commit', 'side'], { stdio: 'ignore' });
    } catch {
      writeFileSync(join(repo, RELPATH), 'first-parent\n');
      git(repo, ['add', RELPATH]);
    }
    commit(repo, 'merge publication\n\nContent-Rev: 2000000000.ddddddd', '@1600000000 +0000');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    git(repo, ['remote', 'add', 'origin', remote]);
    git(repo, ['push', '-q', 'origin', 'main']);
    git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

    const parents = git(repo, ['show', '-s', '--format=%P', 'HEAD']).split(/\s+/);
    assert.equal(parents.length, 2, 'fixture must be a merge commit');
    assert.equal(git(repo, ['show', `HEAD:${RELPATH}`]), 'first-parent');

    const env = {
      ...process.env,
      RUNNER_TEMP: runnerTemp,
      SHARD_REPO_OVERRIDE: remote,
      SHARD_ARTICOLIFRONTALIERE_IT_DEPLOY_KEY: 'unused-for-file-remote',
      ARTICLE_CONTENT_REVISION: '1500000000.eeeeeee',
    };
    const output = execFileSync('bash', [PUSHER, 'articolifrontaliere', 'it', source, RELPATH], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    assert.match(output, /no content changes vs remote/u);
    assert.equal(git(remote, ['show', `main:${RELPATH}`]), 'first-parent');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
