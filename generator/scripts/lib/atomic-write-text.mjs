/** Atomic text writer for generated corpus surfaces. */
import fs from 'node:fs';
import path from 'node:path';

let sequence = 0;

export function writeTextAtomic(filePath, content) {
  if (typeof filePath !== 'string' || typeof content !== 'string') {
    throw new TypeError('writeTextAtomic() requires a string path and string content');
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${sequence++}.tmp`;
  try {
    fs.writeFileSync(tempPath, content, 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
    throw error;
  }
}
