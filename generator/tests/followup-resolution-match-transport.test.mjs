/**
 * The adapted corpus matcher must retain the canonical aggregate contract
 * while preserving the corpus-side classification recorded by PR #1470. The
 * manifest records shortened digests; this offline regression pins the complete
 * corpus content after the merge with the current main.
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
const EXPECTED_CORPUS_SHA256 = '24d8694c718f3369d4d4ad27c75b99d6b782f7e43d65cf9989f49d5481f5da79';

test('follow-up matcher corpus preserves the adapted transport baseline', () => {
  const content = readFileSync(path.join(ROOT, RELATIVE_PATH));
  const digest = createHash('sha256').update(content).digest('hex');
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'scripts/ci/loop-sync-manifest.json'), 'utf8'));
  const entry = manifest.files.find((file) => file.path === RELATIVE_PATH);

  assert.equal(digest, EXPECTED_CORPUS_SHA256);
  assert.notEqual(EXPECTED_CORPUS_SHA256, EXPECTED_SITE_SHA256);
  assert.equal(entry?.mode, 'adapted');
  assert.deepEqual(entry?.baseline, {
    site: EXPECTED_SITE_SHA256.slice(0, 16),
    corpus: EXPECTED_CORPUS_SHA256.slice(0, 16),
    alignedAt: '2026-09-13',
  });
});
