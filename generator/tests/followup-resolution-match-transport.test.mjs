/**
 * The follow-up matcher carries the site locator contract into the corpus
 * while retaining corpus-specific acceptance behavior. The manifest records
 * the adapted boundary and shortened digests for both sides.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RELATIVE_PATH = 'scripts/ci/followup-resolution-match.mjs';
const EXPECTED_SITE_SHA256 = '2fc97767d9b962962ea714e3470e5673ea061d45bc4b67df152b151fdec96e78';

test('follow-up matcher keeps the merged site locator baseline as an adapted corpus twin', () => {
  const content = readFileSync(path.join(ROOT, RELATIVE_PATH));
  const digest = createHash('sha256').update(content).digest('hex');
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'scripts/ci/loop-sync-manifest.json'), 'utf8'));
  const entry = manifest.files.find((file) => file.path === RELATIVE_PATH);

  assert.equal(entry?.mode, 'adapted');
  assert.equal(entry?.baseline?.site, EXPECTED_SITE_SHA256.slice(0, 16));
  assert.equal(entry?.baseline?.corpus, digest.slice(0, 16));
  assert.equal(entry?.baseline?.alignedAt, '2026-09-13');
});
