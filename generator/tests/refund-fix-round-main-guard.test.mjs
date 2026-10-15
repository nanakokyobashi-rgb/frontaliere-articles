import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRYPOINT = path.join(ROOT, 'scripts/ci/refund-fix-round.mjs');
const CLEAN_ENV = { ...process.env, PR: '', MARKER: '', ROUND: '' };

test('refund-fix-round si importa senza eseguire il ramo CLI', () => {
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `await import(${JSON.stringify(pathToFileURL(ENTRYPOINT).href)}); process.stdout.write('IMPORT_OK\\n');`,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: CLEAN_ENV,
    timeout: 30_000,
  });

  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'IMPORT_OK\n');
});

test('refund-fix-round esegue main anche tramite symlink', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'refund-fix-round-main-'));
  try {
    const link = path.join(tempDir, 'refund-fix-round.mjs');
    symlinkSync(ENTRYPOINT, link);

    const result = spawnSync(process.execPath, [link], {
      cwd: ROOT,
      encoding: 'utf8',
      env: CLEAN_ENV,
      timeout: 30_000,
    });

    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PR\/MARKER\/ROUND non impostati/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
