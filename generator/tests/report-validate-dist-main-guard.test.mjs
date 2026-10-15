import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPORTER = path.join(ROOT, 'scripts/ci/report-validate-dist-failure.mjs');

test('report-validate-dist-failure esegue il main anche tramite symlink', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'frontaliere-report-dist-main-guard-'));
  try {
    const link = path.join(tempDir, 'report-validate-dist-failure.mjs');
    symlinkSync(REPORTER, link);

    const result = spawnSync(process.execPath, [link], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    });

    assert.ifError(result.error);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /Usage: node scripts\/ci\/report-validate-dist-failure\.mjs/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
