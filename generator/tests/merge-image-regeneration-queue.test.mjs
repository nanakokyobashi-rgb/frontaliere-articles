import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '../../scripts/lib/merge-image-regeneration-queue.mjs');
const QUEUE = 'data/image-regeneration-queue.json';
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
  return execFileSync('git', args, {
    cwd,
    env: GIT_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function queue(items) {
  return `${JSON.stringify({ schema: 1, items }, null, 2)}\n`;
}

function writeQueue(root, items) {
  const file = path.join(root, QUEUE);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, queue(items));
}

function commit(root, message) {
  git(root, 'add', '--', QUEUE);
  git(root, 'commit', '-m', message);
}

function makeConflict() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'merge-image-queue-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  writeQueue(root, [{ articleId: 'upstream', fallbackImage: '/images/places/lugano-view.webp' }]);
  commit(root, 'seed queue');
  git(root, 'checkout', '-q', '-b', 'feature');
  writeQueue(root, [{ articleId: 'replayed', fallbackImage: '/images/places/lugano-view.webp' }]);
  commit(root, 'replayed queue');
  git(root, 'checkout', '-q', 'main');
  writeQueue(root, [{ articleId: 'different-upstream', fallbackImage: '/images/places/lugano-view.webp' }]);
  commit(root, 'advance upstream');
  git(root, 'checkout', '-q', 'feature');
  assert.throws(() => git(root, 'merge', 'main'), /./);
  return root;
}

function run(root) {
  return spawnSync(process.execPath, [SCRIPT, QUEUE], {
    cwd: root,
    env: GIT_ENV,
    encoding: 'utf8',
  });
}

test('queue merge reads verified conflict stages and keeps both sides', () => {
  const root = makeConflict();
  try {
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    const merged = JSON.parse(readFileSync(path.join(root, QUEUE), 'utf8'));
    assert.deepEqual(
      merged.items.map((item) => item.articleId).sort(),
      ['different-upstream', 'replayed'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('queue merge fails closed when Git cannot read the index', () => {
  const root = makeConflict();
  try {
    const index = path.join(root, '.git', 'index');
    const hidden = `${index}.hidden`;
    renameSync(index, hidden);
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /impossibile leggere l'indice Git/);
    assert.equal(existsSync(path.join(root, QUEUE)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
