import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRYPOINT = path.join(ROOT, 'scripts/ci/mark-claude-terminal-outcome.mjs');

test('mark-claude-terminal-outcome esegue main anche tramite symlink', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'mark-terminal-outcome-main-'));
  try {
    const link = path.join(tempDir, 'mark-terminal-outcome.mjs');
    symlinkSync(ENTRYPOINT, link);

    const result = spawnSync(process.execPath, [link], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, ISSUE: '', EXEC_FILE: '' },
      timeout: 30_000,
    });

    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ISSUE non impostata/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
