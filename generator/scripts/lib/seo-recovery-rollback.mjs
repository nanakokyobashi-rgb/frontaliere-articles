// Rollback of the SEO recovery (generator/scripts/recover-seo-orphans.mjs).
// Kept apart from the script, which runs its command line at import.
import fs from 'node:fs';
import { writeTextAtomic } from './atomic-write-text.mjs';

function readOrNull(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return null;
  }
}

/**
 * The files a run has written, each with the text it had before the run and
 * the last text the run left in it.
 */
export function createWriteLedger() {
  const writes = new Map();
  return {
    /** `before` is kept from the first record: later writes replace `written` only. */
    record(filePath, before, written) {
      const first = writes.get(filePath);
      writes.set(filePath, { path: filePath, before: first ? first.before : before, written });
    },
    entries() {
      return [...writes.values()];
    },
  };
}

/**
 * Puts back the files a run wrote, each one only if it still holds exactly
 * what the run left in it.
 *
 * A file that changed afterwards carries someone else's work: writing the
 * snapshot over it would erase that work, so it is left alone and reported in
 * `diverged`. `before: null` means the file did not exist; restoring it means
 * removing it, under the same condition.
 */
export function restoreWrittenFiles(writes) {
  const restored = [];
  const diverged = [];
  for (const { path: filePath, before, written } of writes) {
    if (readOrNull(filePath) !== written) {
      diverged.push(filePath);
      continue;
    }
    if (before === null) fs.rmSync(filePath, { force: true });
    else writeTextAtomic(filePath, before);
    restored.push(filePath);
  }
  return { restored, diverged };
}
