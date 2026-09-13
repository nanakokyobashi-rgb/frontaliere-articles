import fs from 'node:fs';
import path from 'node:path';

// Monotonic counter so two concurrent writes to the SAME target from the SAME
// process (same pid) still get distinct temp files — the pid alone would not
// disambiguate them.
let tmpSeq = 0;

/**
 * Atomically write `value` as pretty-printed JSON to `filePath`.
 *
 * Commits via temp+rename so a SIGKILL/OOM mid-write cannot leave the target
 * (e.g. data/jobs.json — the served/indexed dataset) truncated. `renameSync`
 * is a single POSIX syscall, atomic on the same filesystem (the Linux CI runner
 * and local dev always qualify). The temp file lives next to the target so the
 * rename never crosses a filesystem boundary.
 *
 * Single source of truth for the ~95 crawler/job-data scripts that previously
 * each duplicated a non-atomic `fs.writeFileSync` helper (issue #2805,
 * follow-up to #2803). Keeping it in one module makes the atomic guarantee
 * impossible to drift away from by copy-paste.
 *
 * @param {string} filePath destination path
 * @param {unknown} value JSON-serializable value
 * @param {{compact?: boolean}} [opts] `compact` emits minified JSON (no indent)
 */
export function writeJsonAtomic(filePath, value, { compact = false } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const json = compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  const content = `${json}\n`;
  const tmp = `${filePath}.${process.pid}.${tmpSeq++}.tmp`;
  // This block is the commit/rollback boundary: before rename the target is
  // still untouched, so every failure can remove the temporary file without
  // lying to the caller about what was committed.
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    const tempFd = fs.openSync(tmp, 'r');
    try {
      fs.fsyncSync(tempFd);
    } finally {
      fs.closeSync(tempFd);
    }
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }

  // The rename is already committed. Directory fsync is a durability hint,
  // not part of the rollback transaction: overlayfs and some network mounts
  // reject fsync on a directory even though the target is valid. Never report
  // that expected portability limitation as an unwritten file.
  try {
    const directoryFd = fs.openSync(path.dirname(filePath), 'r');
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  } catch { /* best-effort durability hint after the commit */ }
}
