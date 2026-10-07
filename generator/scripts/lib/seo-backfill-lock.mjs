/**
 * Runner-local lock for the deterministic SEO orphan writer.
 *
 * The normal article registration lock covers a multi-file article creation;
 * this recovery intentionally writes one SEO chunk only.  It still needs a
 * fail-closed marker so a second recovery cannot append a competing batch to a
 * half-written chunk after an interruption.
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-write-json.mjs';

export const SEO_BACKFILL_LOCK_REL = 'generator/data/seo-backfill-in-progress.json';

export function seoBackfillLockPath(root) {
  return path.join(root, SEO_BACKFILL_LOCK_REL);
}

export function beginSeoBackfillLock(root, ids) {
  const lockPath = seoBackfillLockPath(root);
  if (fs.existsSync(lockPath)) {
    throw new Error(`SEO backfill lock already exists at ${SEO_BACKFILL_LOCK_REL}; inspect the previous recovery before retrying`);
  }
  if (!Array.isArray(ids) || ids.length === 0) throw new TypeError('SEO backfill lock requires a non-empty id array');
  writeJsonAtomic(lockPath, {
    schema: 1,
    kind: 'seo-orphan-recovery',
    ids,
    startedAt: new Date().toISOString(),
    pid: process.pid,
  });
}

export function endSeoBackfillLock(root) {
  try {
    fs.unlinkSync(seoBackfillLockPath(root));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
