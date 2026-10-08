import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'generator/scripts/repair-plain-excerpts.mjs');

test('il repair storico include i chunk SEO delle sezioni cantonali', () => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(report.files >= 24, 'il report deve includere i chunk SEO cantonali');
  assert.equal(report.bySection.cantonale, 0, 'i chunk SEO cantonali devono essere plain-text');
});
