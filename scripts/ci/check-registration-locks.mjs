/**
 * Fail clearly when a registration lock reaches a checkout that is being
 * tested.  Locks are intentionally runner-local and ignored by git; seeing
 * one in a checked-out corpus therefore means a producer forced it into a
 * commit (or an old checkpoint was not retired).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerLockFilenamePattern } from '../../generator/scripts/lib/register-lock.mjs';

export const REGISTER_LOCK_FILE_RE = registerLockFilenamePattern();

export function sectionFromFilename(fileName) {
  const match = REGISTER_LOCK_FILE_RE.exec(path.basename(fileName));
  return match?.[1] || null;
}

function sectionFrom(fileName, parsed) {
  return sectionFromFilename(fileName)
    || (typeof parsed?.section === 'string' && parsed.section.length > 0 ? parsed.section : null)
    || 'non-identificata';
}

function sectionMismatchFrom(fileName, parsed) {
  const filenameSection = sectionFromFilename(fileName);
  const payloadSection = typeof parsed?.section === 'string' && parsed.section.length > 0
    ? parsed.section
    : null;
  if (!filenameSection || !payloadSection || filenameSection === payloadSection) return null;
  return { filename: filenameSection, payload: payloadSection };
}

function runIdFrom(parsed) {
  return typeof parsed?.runId === 'string' && parsed.runId.length > 0
    ? parsed.runId
    : 'non-identificata';
}

/**
 * Return every legacy or section-scoped marker currently present in dataDir.
 * Exported so the guard has an executable unit test without touching the real
 * repository state.
 */
export function findRegistrationLocks(dataDir) {
  if (!fs.existsSync(dataDir)) return [];
  return fs.readdirSync(dataDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && REGISTER_LOCK_FILE_RE.test(entry.name))
    .map((entry) => {
      const file = path.join(dataDir, entry.name);
      let parsed = null;
      let parseError = null;
      try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (error) {
        parseError = error;
      }
      return {
        file: entry.name,
        path: file,
        section: sectionFrom(entry.name, parsed),
        sectionMismatch: sectionMismatchFrom(entry.name, parsed),
        runId: runIdFrom(parsed),
        parsed,
        parseError,
      };
    });
}

export function formatRegistrationLockError(lock) {
  const details = [];
  if (lock.sectionMismatch) {
    details.push(
      `sezione JSON=${lock.sectionMismatch.payload} diversa dal filename=${lock.sectionMismatch.filename}`,
    );
  }
  details.push(lock.parseError
    ? 'JSON illeggibile'
    : `workflow=${lock.parsed?.workflow || 'non identificato'}`);
  const detail = details.join(', ');
  return `lock orfano di ${lock.section} dalla run ${lock.runId}: ${lock.file} (${detail})`;
}

export function checkRegistrationLocks(dataDir) {
  const locks = findRegistrationLocks(dataDir);
  if (locks.length === 0) {
    console.log('registration lock guard: nessun lock orfano');
    return 0;
  }
  for (const lock of locks) {
    console.error(`::error::${formatRegistrationLockError(lock)}`);
  }
  return 1;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  process.exit(checkRegistrationLocks(path.join(root, 'generator', 'data')));
}
