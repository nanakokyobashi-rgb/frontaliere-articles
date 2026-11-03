import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
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
const WORKFLOW = join(ROOT, '.github/workflows/fast-publish-article.yml');
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

test('serializza un push corpus-sized in commit bounded senza perdere path', () => {
  const root = mkdtempSync(join(tmpdir(), 'article-shard-batches-'));
  const source = join(root, 'source');
  const seed = join(root, 'seed');
  const remote = join(root, 'remote.git');
  const runnerTemp = join(root, 'runner-temp');
  const gitBin = join(root, 'git-bin');
  const gitWrapper = join(gitBin, 'git');
  const pushMarker = join(root, 'ambiguous-push-once');
  const statusFile = join(runnerTemp, 'article-status.txt');
  const relpaths = [
    'articolifrontaliere/status-batch-a/index.html',
    'articolifrontaliere/status-batch-b/index.html',
  ];

  try {
    for (const rel of relpaths) {
      mkdirSync(join(source, rel, '..'), { recursive: true });
      mkdirSync(join(seed, rel, '..'), { recursive: true });
      writeFileSync(join(source, rel), `<html><body>${rel}-new</body></html>\n`);
      writeFileSync(join(seed, rel), `<html><body>${rel}-old</body></html>\n`);
    }
    mkdirSync(runnerTemp);
    mkdirSync(gitBin);
    writeFileSync(join(seed, '.shard-filecount'), '2\n');

    execFileSync('git', ['init', '-q', '--initial-branch=main', seed]);
    git(seed, ['config', 'user.name', 'status-test']);
    git(seed, ['config', 'user.email', 'status-test@example.invalid']);
    git(seed, ['add', ...relpaths, '.shard-filecount']);
    git(seed, ['commit', '-qm', 'seed']);
    execFileSync('git', ['init', '-q', '--bare', remote]);
    git(seed, ['remote', 'add', 'origin', remote]);
    git(seed, ['push', '-q', 'origin', 'main']);
    git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(gitWrapper, `#!/bin/sh
if [ "\${1:-}" = "-C" ] && [ "\${3:-}" = "push" ] && [ ! -e "$ARTICLE_PUSH_TEST_PUSH_MARKER" ]; then
  "$REAL_GIT" "$@"
  push_rc=$?
  if [ "$push_rc" -eq 0 ]; then
    : > "$ARTICLE_PUSH_TEST_PUSH_MARKER"
    exit 1
  fi
  exit "$push_rc"
fi
exec "$REAL_GIT" "$@"
`);
    chmodSync(gitWrapper, 0o755);

    const env = {
      ...process.env,
      PATH: `${gitBin}:${process.env.PATH}`,
      REAL_GIT: realGit,
      ARTICLE_PUSH_TEST_PUSH_MARKER: pushMarker,
      RUNNER_TEMP: runnerTemp,
      SHARD_REPO_OVERRIDE: remote,
      SHARD_ARTICOLIFRONTALIERE_IT_DEPLOY_KEY: 'unused-for-file-remote',
      ARTICLE_PUSH_BATCH_SIZE: '1',
      ARTICLE_PUSH_STATUS_FILE: statusFile,
      ARTICLE_CONTENT_REVISION: '',
      GIT_TERMINAL_PROMPT: '0',
    };
    const output = execFileSync('bash', [PUSHER, 'articolifrontaliere', 'it', source, ...relpaths], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    assert.match(output, /serializing 2 path\(s\) in batches of 1/u);
    assert.match(output, /retry found the prior ambiguous push already at the remote tree/u);
    assert.match(output, /Pages build wait skipped for non-GitHub remote/u);
    assert.match(output, /pushed/u);
    assert.equal(readFileSync(statusFile, 'utf8'), 'pushed\n');
    for (const rel of relpaths) {
      assert.equal(git(remote, ['show', `main:${rel}`]), `<html><body>${rel}-new</body></html>`);
    }
    assert.equal(git(remote, ['rev-list', '--count', 'main']), '3');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('il metadata remote-newer è obbligatorio e resta associato al commit del fallback', () => {
  const source = readFileSync(PUSHER, 'utf8');
  assert.match(source, /if ! reset_skipped_newer_paths; then\s+return 1/u);
  assert.match(source, /if ! write_skipped_newer_paths; then\s+return 1/u);
  assert.match(source, /last_commit_skipped_newer_paths=\("\$\{last_skipped_newer_paths\[@\]\}"\)/u);
  assert.match(source, /restore_last_commit_skipped_newer_paths[\s\S]{0,120}shard_pat_push/u);
});

test('i batch Pages sono seriali, raggruppati e riconciliabili', () => {
  const source = readFileSync(PUSHER, 'utf8');
  const workflow = readFileSync(WORKFLOW, 'utf8');
  assert.match(source, /wait_for_pages_build\s+"\$commit"/u);
  assert.match(source, /shard_pat_push[\s\S]{0,240}wait_for_pages_build\s+"\$last_commit"/u);
  assert.match(source, /pages\/builds\/latest/u);
  assert.match(source, /ARTICLE_PUSH_COMMIT_FILE/u);
  assert.match(source, /ARTICLE_PUSH_FALLBACK_STATE_FILE/u);
  assert.match(source, /rollback_serialized_publications/u);
  assert.match(source, /reconcile_failed_publication\s+"\$commit_parent"\s+"\$commit"/u);
  assert.match(source, /reconcile_failed_publication\s+"\$last_commit_parent"\s+"\$last_commit"/u);
  assert.match(source, /write_fallback_state unsafe/u);
  assert.match(source, /write_fallback_state safe/u);
  assert.match(source, /ARTICLE_PUSH_BATCH_GROUPS_FILE/u);
  assert.match(source, /dependency group/u);
  assert.match(workflow, /write_article_push_groups\(\)/u);
  assert.match(workflow, /\.redirectPaths\[\]\?/u);
  assert.match(workflow, /export ARTICLE_PUSH_BATCH_GROUPS_FILE="\$combined_groups"/u);
  assert.match(workflow, /export ARTICLE_PUSH_BATCH_GROUPS_FILE="\$fallback_groups"/u);
  assert.match(workflow, /export ARTICLE_PUSH_FALLBACK_STATE_FILE="\$fallback_state"/u);
  assert.match(workflow, /without a reconciled tree; refusing the article-only fallback/u);
});

test('il rollback mantiene la revisione e condivide il budget Pages fra i batch', () => {
  const source = readFileSync(PUSHER, 'utf8');

  assert.match(source, /rollback_pat_token=.*shard_push_token_for_repo\s+"\$SHARD_REPO"/u);
  assert.match(source, /rollback_repo=.*shard_https_push_url\s+"\$SHARD_REPO"/u);
  assert.match(source, /rollback_git_opts=\(-c credential\.helper=/u);
  assert.match(source, /\$\{rollback_git_opts\[@/u);
  assert.match(source, /candidate_parent=.*show -s --format='%P'\s+"\$candidate"/u);
  assert.match(source, /candidate_parent.*expected_parent/u);
  assert.match(source, /expected_parent="\$candidate"/u);
  assert.match(source, /expected_parent.*remote_head/u);
  assert.doesNotMatch(source, /merge-base --is-ancestor/u);
  assert.match(source, /rollback_content_revision[\s\S]{0,700}Content-Rev: \$rollback_content_revision/u);
  assert.match(source, /export ARTICLE_PUSH_PAGES_DEADLINE="\$article_push_pages_deadline"/u);
  assert.match(source, /ARTICLE_PUSH_PAGES_DEADLINE="\$article_push_pages_deadline"[\s\\\n]+ARTICLE_PUSH_STATUS_FILE/u);
  assert.match(source, /serialized_batch_deadline_available[\s\S]{0,700}reconciling published batches/u);
  assert.match(source, /wait_for_pages_build "\$rollback_commit" "\$rollback_deadline"/u);
  assert.doesNotMatch(source, /deadline=\$\(\(SECONDS \+ article_push_pages_wait_seconds\)\)/u);
});
