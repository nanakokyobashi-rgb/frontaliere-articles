import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseArgs } from '../../scripts/lib/main-push-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts/lib/main-push-guard.mjs');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function setupRepository() {
  const root = mkdtempSync(path.join(tmpdir(), 'main-push-guard-'));
  const origin = path.join(root, 'origin.git');
  const writer = path.join(root, 'writer');
  git(root, ['init', '-q', '--bare', '--initial-branch=main', origin]);
  git(root, ['init', '-q', '--initial-branch=main', writer]);
  git(writer, ['config', 'user.name', 'Guard Test']);
  git(writer, ['config', 'user.email', 'guard-test@example.invalid']);
  for (let index = 0; index < 8; index += 1) {
    writeFileSync(path.join(writer, 'tracked-' + index + '.txt'), 'seed-' + index + '\n');
  }
  git(writer, ['add', '.']);
  git(writer, ['commit', '-q', '-m', 'seed main']);
  git(writer, ['remote', 'add', 'origin', origin]);
  git(writer, ['push', '-q', '-u', 'origin', 'main']);
  git(writer, ['fetch', '-q', 'origin', 'main']);
  return { root, origin, writer, base: git(writer, ['rev-parse', 'origin/main']) };
}

function runGuard(repo, args) {
  const result = spawnSync(process.execPath, [SCRIPT, '--repo', repo, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return { ...result, output: String(result.stdout || '') + String(result.stderr || '') };
}

test('main-push-guard richiede esattamente una modalità di esecuzione', () => {
  assert.throws(
    () => parseArgs(['--repo', '/tmp/repo', '--base', 'HEAD']),
    /choose exactly one of --check-only or --push/u,
  );
});

test('rifiuta un candidato discendente il cui albero collassa', () => {
  const scenario = setupRepository();
  try {
    for (let index = 1; index < 8; index += 1) {
      rmSync(path.join(scenario.writer, 'tracked-' + index + '.txt'));
    }
    git(scenario.writer, ['add', '-A']);
    git(scenario.writer, ['commit', '-q', '-m', 'accidental collapsed tree']);

    const result = runGuard(scenario.writer, [
      '--base', scenario.base,
      '--candidate', 'HEAD',
      '--check-only',
    ]);

    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /candidate tree collapse/u);
    assert.equal(git(scenario.writer, ['rev-parse', 'origin/main']), scenario.base);
  } finally {
    rmSync(scenario.root, { recursive: true, force: true });
  }
});

test('pubblica un candidato valido con il lease della base catturata', () => {
  const scenario = setupRepository();
  try {
    writeFileSync(path.join(scenario.writer, 'valid.txt'), 'valid\n');
    git(scenario.writer, ['add', 'valid.txt']);
    git(scenario.writer, ['commit', '-q', '-m', 'valid guarded write']);

    const result = runGuard(scenario.writer, [
      '--base', scenario.base,
      '--candidate', 'HEAD',
      '--push',
    ]);

    assert.equal(result.status, 0, result.output);
    assert.equal(git(scenario.root, ['--git-dir', scenario.origin, 'show', 'main:valid.txt']), 'valid');
  } finally {
    rmSync(scenario.root, { recursive: true, force: true });
  }
});
