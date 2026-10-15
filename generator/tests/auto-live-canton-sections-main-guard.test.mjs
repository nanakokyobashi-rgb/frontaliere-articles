import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRYPOINT = path.join(ROOT, 'scripts/ci/auto-live-canton-sections.mjs');
const OFFLINE_ENV = {
  ...process.env,
  PATH: '/usr/bin:/bin',
};

test('auto-live-canton-sections si importa senza eseguire il ramo CLI', () => {
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

test('auto-live-canton-sections esegue main anche tramite symlink', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'auto-live-canton-main-'));
  try {
    const link = path.join(tempDir, 'auto-live-canton-sections.mjs');
    symlinkSync(ENTRYPOINT, link);

    const result = spawnSync(process.execPath, [link, 'comando-non-valido'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: OFFLINE_ENV,
      timeout: 30_000,
    });

    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /::error::auto-live-canton-sections: uso:/u);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
