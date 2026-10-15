import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRYPOINT = path.join(ROOT, 'scripts/ci/content-gates-main.mjs');
const OFFLINE_ENV = {
  PATH: '/usr/bin:/bin',
  TMPDIR: os.tmpdir(),
};
test('content-gates-main si importa senza eseguire il ramo CLI', () => {
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

test('content-gates-main esegue la CLI anche tramite symlink, senza rete', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'content-gates-main-'));
  try {
    const link = path.join(tempDir, 'content-gates-main.mjs');
    const summaryPath = path.join(tempDir, 'summary.json');
    const preloaderSource = [
      "import fs from 'node:fs';",
      "import { syncBuiltinESMExports } from 'node:module';",
      `const contentRoot = ${JSON.stringify(path.join(ROOT, 'content'))};`,
      'const originalReaddirSync = fs.readdirSync;',
      'fs.readdirSync = function patchedReaddirSync(target, ...args) {',
      '  const pathname = typeof target === "string" ? target : target?.toString();',
      `  if (pathname === contentRoot || pathname?.startsWith(contentRoot + ${JSON.stringify(path.sep)})) return [];`,
      '  return originalReaddirSync.call(this, target, ...args);',
      '};',
      'syncBuiltinESMExports();',
    ].join('\n');
    const preloaderUrl = `data:text/javascript;base64,${Buffer.from(preloaderSource).toString('base64')}`;
    symlinkSync(ENTRYPOINT, link);

    const result = spawnSync(process.execPath, [
      '--import', preloaderUrl,
      link,
      '--dry-run',
      '--json', summaryPath,
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      env: OFFLINE_ENV,
      timeout: 90_000,
    });

    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /\[content-gates-main\] preflight fallito/u);

    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    assert.equal(summary.state, 'preflight-failed');
    assert.equal(summary.child, null);
    assert.ok(summary.gates.length > 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
