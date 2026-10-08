/**
 * Runner-local lock for the deterministic SEO orphan writer.
 *
 * The normal article registration lock covers a multi-file article creation;
 * this recovery intentionally writes one SEO chunk only.  It still needs a
 * fail-closed marker so a second recovery cannot append a competing batch to a
 * half-written chunk after an interruption.
 *
 * The marker is created with an exclusive open: of two recoveries that start
 * together exactly one gets it. A check followed by a write would let both
 * pass the check. The marker survives a killed run on purpose; the next run
 * stops on it until someone has looked at what the previous one left behind.
 */
import fs from 'node:fs';
import path from 'node:path';

export const SEO_BACKFILL_LOCK_REL = 'generator/data/seo-backfill-in-progress.json';

export function seoBackfillLockPath(root) {
  return path.join(root, SEO_BACKFILL_LOCK_REL);
}

export function beginSeoBackfillLock(root, ids) {
  if (!Array.isArray(ids) || ids.length === 0) throw new TypeError('SEO backfill lock requires a non-empty id array');
  const lockPath = seoBackfillLockPath(root);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    throw new Error(`SEO backfill lock already exists at ${SEO_BACKFILL_LOCK_REL}; inspect the previous recovery before retrying`);
  }
  try {
    fs.writeFileSync(fd, `${JSON.stringify({
      schema: 1,
      kind: 'seo-orphan-recovery',
      ids,
      startedAt: new Date().toISOString(),
      pid: process.pid,
    }, null, 2)}\n`);
    fs.fsyncSync(fd);
  } catch (error) {
    // The marker is ours and says nothing yet: do not leave an empty one behind.
    fs.closeSync(fd);
    fd = undefined;
    fs.rmSync(lockPath, { force: true });
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function endSeoBackfillLock(root) {
  try {
    fs.unlinkSync(seoBackfillLockPath(root));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
