import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { restoreRegistrySource } from '../../scripts/lib/article-render-pipeline.mjs';

test('registry restore preserves the primary render error when cleanup fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'article-render-restore-'));
  try {
    const primaryError = new Error('render failed');
    const logged = [];

    assert.doesNotThrow(() => restoreRegistrySource({
      registryPath: root,
      original: 'original registry',
      primaryError,
      logger: { error: (message) => logged.push(message) },
    }));
    assert.equal(primaryError.message, 'render failed');
    assert.equal(primaryError.restoreError?.code, 'EISDIR');
    assert.equal(logged.length, 1);

    assert.throws(
      () => restoreRegistrySource({ registryPath: root, original: 'original registry' }),
      (error) => error?.code === 'EISDIR',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('registry restore writes the exact original source after a successful render', () => {
  const root = mkdtempSync(join(tmpdir(), 'article-render-restore-ok-'));
  try {
    const registryPath = join(root, 'registry.ts');
    writeFileSync(registryPath, 'overlay registry', 'utf8');
    restoreRegistrySource({ registryPath, original: 'original registry' });
    assert.equal(readFileSync(registryPath, 'utf8'), 'original registry');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
