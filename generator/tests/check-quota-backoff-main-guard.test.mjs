import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRYPOINT = path.join(ROOT, 'scripts/ci/check-quota-backoff.mjs');
const OFFLINE_ENV = {
  ...process.env,
  DRY_RUN: '1',
  GH_REPO: 'nanakokyobashi-rgb/frontaliere-articles',
  PATH: '/usr/bin:/bin',
  QUOTA_BEACON_PEER_REPO: '',
};

test('check-quota-backoff si importa senza eseguire il ramo CLI', () => {
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

test('check-quota-backoff esegue main anche tramite symlink', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'quota-backoff-main-'));
  try {
    const link = path.join(tempDir, 'check-quota-backoff.mjs');
    symlinkSync(ENTRYPOINT, link);

    const result = spawnSync(process.execPath, [link], {
      cwd: ROOT,
      encoding: 'utf8',
      env: OFFLINE_ENV,
      timeout: 30_000,
    });

    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Nessun beacon di quota attivo/);
    assert.match(result.stdout, /quota_blocked=false/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
