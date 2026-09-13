/**
 * The identical follow-up matcher must carry the byte-level source contract
 * into the corpus. The manifest records a shortened digest for the loop, while
 * this offline regression pins the complete content observed after site PR
 * #8469 merged.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RELATIVE_PATH = 'scripts/ci/followup-resolution-match.mjs';
const EXPECTED_SHA256 = '2fc97767d9b962962ea714e3470e5673ea061d45bc4b67df152b151fdec96e78';

test('follow-up matcher corpus is byte-identical to the merged site source', () => {
  const content = readFileSync(path.join(ROOT, RELATIVE_PATH));
  const digest = createHash('sha256').update(content).digest('hex');
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'scripts/ci/loop-sync-manifest.json'), 'utf8'));
  const entry = manifest.files.find((file) => file.path === RELATIVE_PATH);

  assert.equal(digest, EXPECTED_SHA256);
  assert.equal(entry?.mode, 'identical');
  assert.deepEqual(entry?.baseline, {
    site: EXPECTED_SHA256.slice(0, 16),
    corpus: EXPECTED_SHA256.slice(0, 16),
    alignedAt: '2026-09-13',
  });
});
