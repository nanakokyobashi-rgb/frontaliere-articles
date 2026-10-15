import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { isMainModuleInvocation } from '../../scripts/ci/verify-crawler-contract-provenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRYPOINT = path.join(ROOT, 'scripts/ci/verify-crawler-contract-provenance.mjs');
const ENTRYPOINT_URL = pathToFileURL(ENTRYPOINT).href;
const ENTRYPOINT_SOURCE = readFileSync(ENTRYPOINT, 'utf8');

function runMainGuardProbe(argvPath) {
  const source = [
    `import { isMainModuleInvocation } from ${JSON.stringify(pathToFileURL(ENTRYPOINT).href)};`,
    'process.argv[1] = process.argv[2];',
    `if (isMainModuleInvocation(${JSON.stringify(ENTRYPOINT_URL)})) process.stdout.write('MAIN\\n');`,
  ].join('\n');
  return spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    source,
    'main-guard-probe.mjs',
    argvPath,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

test('il verificatore usa il main guard canonico e resta inerte quando è importato', () => {
  assert.match(ENTRYPOINT_SOURCE, /if \(isMainModuleInvocation\(import\.meta\.url\)\)/u);
  assert.equal(
    isMainModuleInvocation(ENTRYPOINT_URL, fileURLToPath(import.meta.url)),
    false,
  );
});

test('il main guard riconosce l’invocazione del path reale senza avviare il verificatore', () => {
  const result = runMainGuardProbe(ENTRYPOINT);

  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'MAIN\n');
});

test('il main guard riconosce il verificatore invocato tramite symlink senza rete', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'crawler-provenance-main-guard-'));
  try {
    const link = path.join(tempDir, 'verify-crawler-contract-provenance.mjs');
    symlinkSync(ENTRYPOINT, link);
    const result = runMainGuardProbe(link);

    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'MAIN\n');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
