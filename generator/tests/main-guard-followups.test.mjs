import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRYPOINTS = [
  'generator/scripts/generate-canton-hubs.mjs',
  'generator/scripts/load-rc-env.mjs',
  'generator/scripts/lib/provider-preflight.mjs',
  'generator/scripts/repair-truncated-seo-titles.mjs',
  'generator/scripts/recover-seo-orphans.mjs',
  'generator/scripts/regenerate-queued-covers.mjs',
  'generator/scripts/retranslate-blocking-bodies.mjs',
  'generator/scripts/reset-evergreen-strikes.mjs',
  'generator/scripts/scan-vacuous-key-facts.mjs',
  'scripts/ci/check-node-test-stdout.mjs',
  'scripts/ci/claude-codex-fallback.mjs',
  'scripts/ci/redcheck-review-prefilter.mjs',
  'scripts/ci/review-claim.mjs',
  'scripts/seo/bing-seo-loop.mjs',
  'scripts/lib/merge-content-registry-conflict.mjs',
  'scripts/backfill-image-credits.mjs',
  'scripts/publish-section-edge.mjs',
  'scripts/publish-section-pages.mjs',
  'scripts/reconcile-article-shards.mjs',
  'scripts/reconcile-section-pages.mjs',
  'scripts/backfill-image-credits.mjs',
  'scripts/find-dirty-content-ids.mjs',
  'scripts/ci/unwedge-pages-deploy-queue.mjs',
  'generator/scripts/backfill-article-cantons.mjs',
  'generator/scripts/measure-article-waste.mjs',
];
const SYMLINK_ENTRYPOINTS = [
  {
    relativePath: 'scripts/reconcile-section-pages.mjs',
    status: 1,
    stderr: /\[reconcile-sections\] manca --out <report\.json>/,
  },
  {
    relativePath: 'scripts/publish-section-pages.mjs',
    status: 1,
    stderr: /\[publish-section-pages\] manca --section/,
  },
  {
    relativePath: 'scripts/backfill-image-credits.mjs',
    status: 2,
    stderr: /usage: node scripts\/backfill-image-credits\.mjs/,
  },
];

test('i producer/repairer del follow-up canonicalizzano entrambi i lati del main-guard', () => {
  for (const relativePath of ENTRYPOINTS) {
    const source = readFileSync(path.join(ROOT, relativePath), 'utf8');
    const guard = source.slice(source.lastIndexOf('const invokedDirectly'));

    assert.match(guard, /realpathSync\(fileURLToPath\(import\.meta\.url\)\)/, relativePath);
    assert.match(guard, /realpathSync\(process\.argv\[1\]\s*\|\|\s*['"]['"]\)/, relativePath);
    assert.doesNotMatch(guard, /pathToFileURL\(process\.argv\[1\]/, relativePath);
    assert.doesNotMatch(guard, /path\.resolve\(process\.argv\[1\]\)/, relativePath);
  }
});

test('gli entrypoint di #2317 eseguono davvero main quando invocati tramite symlink', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'frontaliere-followup-main-guard-'));
  try {
    for (const entrypoint of SYMLINK_ENTRYPOINTS) {
      const link = path.join(tempDir, path.basename(entrypoint.relativePath));
      symlinkSync(path.join(ROOT, entrypoint.relativePath), link);
      const result = spawnSync(process.execPath, [link], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 30_000,
      });

      assert.ifError(result.error);
      assert.equal(result.status, entrypoint.status, `${entrypoint.relativePath}: ${result.stderr}`);
      assert.match(result.stderr, entrypoint.stderr, entrypoint.relativePath);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
