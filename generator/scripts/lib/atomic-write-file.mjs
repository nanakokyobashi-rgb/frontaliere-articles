import fs from 'node:fs';

// Distinct temporary names are required when one process writes the same
// target more than once: the pid alone would allow a later write to reuse the
// earlier temp path.
let tmpSeq = 0;

/**
 * Writes a text or Buffer file through a sibling temp file, then commits it
 * with renameSync so an interrupted write cannot truncate the target.
 *
 * The cleanup is deliberately best-effort: the original error must reach the
 * caller, while a failed cleanup must not hide it.
 */
export function writeFileAtomic(filePath, content, encoding = 'utf8') {
  const tmp = `${filePath}.${process.pid}.${tmpSeq++}.tmp`;
  try {
    fs.writeFileSync(tmp, content, encoding);
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw error;
  }
}
