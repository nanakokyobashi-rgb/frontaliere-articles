import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixerTrailer, installCommitMsgHook } from '../../scripts/ci/fixer-commit-trailer.mjs';

const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('formato unico del trailer, allineato al sito', () => {
  assert.equal(fixerTrailer('redflag', 1), 'Fixer: redflag-round-1');
  assert.equal(fixerTrailer('redcheck', '2'), 'Fixer: redcheck-round-2');
  for (const bad of [0, -1, '1.5', '', 'x', ' 2']) assert.throws(() => fixerTrailer('redflag', bad));
  assert.throws(() => fixerTrailer('issue', 1));
});

test("l'hook marca il commit e non duplica il trailer su --amend", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-trailer-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    installCommitMsgHook('redcheck', 2, { cwd: dir });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    git('add', 'a.txt');
    git('commit', '-qm', 'fix: qualcosa');
    assert.equal(git('log', '-1', '--format=%(trailers:key=Fixer,valueonly)'), 'redcheck-round-2');
    git('commit', '-q', '--amend', '-m', git('log', '-1', '--format=%B'));
    assert.equal(git('log', '-1', '--format=%(trailers:key=Fixer)').split('\n').filter(Boolean).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--amend di un round diverso lascia UN trailer, col round nuovo (FU-2026-09-20-022)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-trailer-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    installCommitMsgHook('redcheck', 1, { cwd: dir });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    git('add', 'a.txt');
    git('commit', '-qm', 'fix: primo round');
    assert.equal(git('log', '-1', '--format=%(trailers:key=Fixer,valueonly)'), 'redcheck-round-1');
    installCommitMsgHook('redcheck', 2, { cwd: dir });
    git('commit', '-q', '--amend', '-m', git('log', '-1', '--format=%B'));
    const values = git('log', '-1', '--format=%(trailers:key=Fixer,valueonly)').split('\n').filter(Boolean);
    assert.deepEqual(values, ['redcheck-round-2']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const [file, kind, marker] of [
  ['pr-redflag-fixer.yml', 'redflag', 'REDFLAG_NEEDS_HUMAN'],
  ['pr-redcheck-fixer.yml', 'redcheck', 'REDCHECK_NEEDS_HUMAN'],
]) {
  test(`${file}: installa l'hook col round del guard prima dell'agente`, () => {
    const src = read(`.github/workflows/${file}`);
    const install = src.indexOf(`node scripts/ci/fixer-commit-trailer.mjs install ${kind} "$FIX_ROUND"`);
    assert.ok(install > 0, 'install hook assente');
    assert.ok(install > src.indexOf('id: guard'), 'deve seguire il guard che calcola il round');
    assert.ok(install < src.indexOf('uses: ./.github/actions/claude-codex-fallback'), "deve precedere l'agente");
    assert.match(src, new RegExp(`Fixer: ${kind}-round-`));
  });

  test(`${file}: il commento needs-human al cap si posta una volta sola`, () => {
    const src = read(`.github/workflows/${file}`);
    const cap = src.slice(src.indexOf('if [ "$ROUND" -ge "$MAX_ROUNDS" ]; then'));
    const block = cap.slice(0, cap.indexOf('\n          fi\n\n'));
    assert.match(block, new RegExp(`grep -qF '<!-- ${marker} -->'`));
    assert.match(block, new RegExp(`<!-- ${marker} -->`));
    const guardAt = block.indexOf(`grep -qF '<!-- ${marker} -->'`);
    assert.ok(guardAt < block.indexOf('gh pr comment'), 'il controllo deve precedere il commento');
  });
}
