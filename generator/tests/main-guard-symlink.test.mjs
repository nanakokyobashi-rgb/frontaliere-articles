import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRYPOINTS = [
  'generator/scripts/publish-journalist-article.mjs',
  'generator/scripts/generate-events-digest-article.mjs',
  'generator/scripts/batch-add-faq-to-articles.mjs',
];

test('gli entrypoint generator canonicalizzano entrambi i lati del main-guard', () => {
  for (const relativePath of ENTRYPOINTS) {
    const source = readFileSync(path.join(ROOT, relativePath), 'utf8');
    const guard = source.slice(source.lastIndexOf('const invokedDirectly'));
    assert.match(guard, /realpathSync\(fileURLToPath\(import\.meta\.url\)\)/, relativePath);
    assert.match(guard, /realpathSync\(process\.argv\[1\]\s*\|\|\s*['"]['"]\)/, relativePath);
    assert.doesNotMatch(guard, /pathToFileURL\(process\.argv\[1\]/, relativePath);
  }
});

test('il batch esegue main anche quando viene avviato tramite symlink', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'frontaliere-main-guard-'));
  try {
    const link = path.join(tempDir, 'batch-add-faq-to-articles.mjs');
    symlinkSync(path.join(ROOT, 'generator/scripts/batch-add-faq-to-articles.mjs'), link);
    const result = spawnSync(process.execPath, [link, '--help'], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /USAGE:/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
