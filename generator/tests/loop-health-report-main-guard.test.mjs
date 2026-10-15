import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRYPOINT = path.join(ROOT, 'scripts/ci/loop-health-report.mjs');
const OFFLINE_ENV = {
  ...process.env,
  GH_REPO: '',
  GITHUB_REPOSITORY: '',
  PATH: '/usr/bin:/bin',
};

test('loop-health-report si importa senza eseguire il ramo CLI', () => {
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `await import(${JSON.stringify(pathToFileURL(ENTRYPOINT).href)}); process.stdout.write('IMPORT_OK\\n');`,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: OFFLINE_ENV,
    timeout: 30_000,
  });

  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'IMPORT_OK\n');
});

test('loop-health-report esegue main anche tramite symlink', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'loop-health-main-'));
  try {
    const link = path.join(tempDir, 'loop-health-report.mjs');
    symlinkSync(ENTRYPOINT, link);

    const result = spawnSync(process.execPath, [link, '--no-post'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: OFFLINE_ENV,
      timeout: 30_000,
    });

    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /GITHUB_REPOSITORY\/GH_REPO mancante/);
    assert.equal(result.stdout, '');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
