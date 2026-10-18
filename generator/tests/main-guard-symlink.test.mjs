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
  'generator/scripts/create-article.mjs',
  'generator/scripts/generate-daily-brief-article.mjs',
  'generator/scripts/generate-border-wait-ranking-article.mjs',
  'generator/scripts/refresh-daily-brief-data.mjs',
  'generator/scripts/generate-pharmacy-evergreen-guides.mjs',
  'generator/scripts/fix-faq-locales.mjs',
  'generator/scripts/repair-source-echo.mjs',
  'generator/scripts/generate-journalist-image-catalog.mjs',
];

test('gli entrypoint generator canonicalizzano entrambi i lati del main-guard', () => {
  for (const relativePath of ENTRYPOINTS) {
    const source = readFileSync(path.join(ROOT, relativePath), 'utf8');
    assert.match(source, /realpathSync\(fileURLToPath\(import\.meta\.url\)\)/, relativePath);
    assert.match(source, /realpathSync\(process\.argv\[1\](?:\s*\|\|\s*['"]['"])?\)/, relativePath);
    assert.doesNotMatch(source, /pathToFileURL\(process\.argv\[1\]/, relativePath);
    assert.doesNotMatch(source, /import\.meta\.url\s*===\s*`file:\/\/\$\{process\.argv\[1\]\}`/, relativePath);
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

function runViaSymlink(relativePath, args = []) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'frontaliere-main-guard-'));
  const link = path.join(tempDir, 'entry.mjs');
  symlinkSync(path.join(ROOT, relativePath), link);
  const env = { ...process.env };
  delete env.GITHUB_REPOSITORY;
  delete env.GH_REPO;
  try {
    return spawnSync(process.execPath, [link, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      env,
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test('resolve-issue-verified entra in CLI anche quando invocato via symlink', () => {
  const result = runViaSymlink('scripts/ci/resolve-issue-verified.mjs');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /serve --number <n> oppure --title/);
});

test('ensure-loop-labels entra in CLI anche quando invocato via symlink', () => {
  const result = runViaSymlink('scripts/ci/ensure-loop-labels.mjs', ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /GITHUB_REPOSITORY non impostato/);
});
