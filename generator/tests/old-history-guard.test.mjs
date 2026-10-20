import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectHistory, parseArgs } from '../../scripts/ci/old-history-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GUARD = path.join(ROOT, 'scripts/ci/old-history-guard.mjs');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'old-history-guard-'));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  git(root, ['init', '-q', '--bare', '--initial-branch=main', remote]);
  git(root, ['init', '-q', '--initial-branch=main', local]);
  git(local, ['config', 'user.name', 'History Guard Test']);
  git(local, ['config', 'user.email', 'history-guard@example.invalid']);
  writeFileSync(path.join(local, 'base.txt'), 'base\n');
  git(local, ['add', 'base.txt']);
  git(local, ['commit', '-q', '-m', 'base']);
  git(local, ['remote', 'add', 'origin', remote]);
  git(local, ['push', '-q', 'origin', 'HEAD:main']);
  git(local, ['fetch', '-q', 'origin', 'main']);
  writeFileSync(path.join(local, 'candidate.txt'), 'candidate\n');
  git(local, ['add', 'candidate.txt']);
  git(local, ['commit', '-q', '-m', 'candidate']);
  return { root, local, remote };
}

test('la guardia accetta un candidato basato sulla ref remota acquisita', () => {
  const scenario = fixture();
  try {
    const result = inspectHistory({ cwd: scenario.local });
    assert.equal(result.baseRef, 'origin/main');
    assert.equal(result.shallow, false);
    assert.equal(result.candidateSha, git(scenario.local, ['rev-parse', 'HEAD']));
  } finally {
    rmSync(scenario.root, { recursive: true, force: true });
  }
});

test('la guardia rifiuta un candidato costruito su una storia vecchia o scollegata', () => {
  const scenario = fixture();
  try {
    const oldBase = git(scenario.local, ['rev-parse', 'origin/main']);
    writeFileSync(path.join(scenario.local, 'remote-tip.txt'), 'remote tip\n');
    git(scenario.local, ['add', 'remote-tip.txt']);
    git(scenario.local, ['commit', '-q', '-m', 'remote tip']);
    git(scenario.local, ['push', '-q', 'origin', 'HEAD:main']);
    git(scenario.local, ['fetch', '-q', 'origin', 'main']);
    git(scenario.local, ['checkout', '-q', '--detach', oldBase]);
    writeFileSync(path.join(scenario.local, 'old.txt'), 'old\n');
    git(scenario.local, ['add', 'old.txt']);
    git(scenario.local, ['commit', '-q', '-m', 'old candidate']);

    assert.throws(
      () => inspectHistory({ cwd: scenario.local }),
      /OLD_HISTORY_GUARD: candidate .* does not descend from origin\/main/u,
    );
  } finally {
    rmSync(scenario.root, { recursive: true, force: true });
  }
});

test('la CLI resta inerte quando il modulo viene importato e fallisce chiusa fuori da un repo', () => {
  assert.deepEqual(parseArgs(['--remote', 'origin', '--branch', 'main', '--candidate', 'HEAD']), {
    remote: 'origin',
    branch: 'main',
    candidate: 'HEAD',
    base: null,
    cwd: process.cwd(),
    help: false,
  });
  const result = spawnSync(process.execPath, [GUARD, '--cwd', path.join(ROOT, 'missing-old-history-repo')], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /OLD_HISTORY_GUARD_FATAL/u);
});
