import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve('.');
const PUSHER = join(ROOT, 'scripts/lib/push-article-shard-incremental.sh');
const RELPATH = 'articolifrontaliere/status-no-op/index.html';

function git(cwd, args, options = {}) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    ...options,
  }).trim();
}

test('reports clean-no-op when the incoming tree is already live', () => {
  const root = mkdtempSync(join(tmpdir(), 'article-shard-status-'));
  const source = join(root, 'source');
  const seed = join(root, 'seed');
  const remote = join(root, 'remote.git');
  const runnerTemp = join(root, 'runner-temp');
  const statusFile = join(runnerTemp, 'article-status.txt');
  const body = '<html><body>already live</body></html>\n';

  try {
    mkdirSync(join(source, 'articolifrontaliere/status-no-op'), { recursive: true });
    mkdirSync(join(seed, 'articolifrontaliere/status-no-op'), { recursive: true });
    mkdirSync(runnerTemp);
    writeFileSync(join(source, RELPATH), body);
    writeFileSync(join(seed, RELPATH), body);
    writeFileSync(join(seed, '.shard-filecount'), '1\n');

    execFileSync('git', ['init', '-q', '--initial-branch=main', seed]);
    git(seed, ['config', 'user.name', 'status-test']);
    git(seed, ['config', 'user.email', 'status-test@example.invalid']);
    git(seed, ['add', RELPATH, '.shard-filecount']);
    git(seed, ['commit', '-qm', 'seed']);
    execFileSync('git', ['init', '-q', '--bare', remote]);
    git(seed, ['remote', 'add', 'origin', remote]);
    git(seed, ['push', '-q', 'origin', 'main']);
    git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

    const env = {
      ...process.env,
      RUNNER_TEMP: runnerTemp,
      SHARD_REPO_OVERRIDE: remote,
      SHARD_ARTICOLIFRONTALIERE_IT_DEPLOY_KEY: 'unused-for-file-remote',
      ARTICLE_PUSH_STATUS_FILE: statusFile,
      ARTICLE_CONTENT_REVISION: '',
      GIT_TERMINAL_PROMPT: '0',
    };
    const output = execFileSync('bash', [PUSHER, 'articolifrontaliere', 'it', source, RELPATH], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    assert.match(output, /clean no-op/u);
    assert.equal(readFileSync(statusFile, 'utf8'), 'clean-no-op\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
