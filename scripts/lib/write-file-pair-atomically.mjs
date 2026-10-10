import fs from 'node:fs';
import path from 'node:path';

let temporarySequence = 0;

function removeTemporaryFile(fsImpl, file, errors) {
  try {
    fsImpl.unlinkSync(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') errors.push(error);
  }
}

function throwWithRelatedErrors(error, relatedErrors, message) {
  if (relatedErrors.length === 0) throw error;
  throw new AggregateError([error, ...relatedErrors], `${message} (${relatedErrors.length} errori aggiuntivi)`);
}

function restoreAtomically(fsImpl, file, content) {
  const tmp = `${file}.${process.pid}.${temporarySequence++}.pair-rollback.tmp`;
  try {
    fsImpl.writeFileSync(tmp, content, 'utf8');
    fsImpl.renameSync(tmp, file);
  } catch (error) {
    const cleanupErrors = [];
    removeTemporaryFile(fsImpl, tmp, cleanupErrors);
    throwWithRelatedErrors(error, cleanupErrors, `rollback incompleto per ${file}`);
  }
}

/**
 * Stage all changed files before replacement and roll back earlier renames if
 * a later synchronous operation fails. This is not crash/power-loss atomic.
 * Existing targets are canonicalized so symlink aliases cannot be committed
 * twice as if they were distinct files. Cleanup failures are surfaced.
 */
export function writeFilePairAtomically(changes, { fsImpl = fs } = {}) {
  if (!Array.isArray(changes)) throw new TypeError('writeFilePairAtomically: changes deve essere un array');
  for (const change of changes) {
    if (!change || typeof change.file !== 'string' || typeof change.before !== 'string' || typeof change.after !== 'string') {
      throw new TypeError('writeFilePairAtomically: ogni modifica richiede file, before e after testuali');
    }
  }

  const pending = changes.filter((change) => change.before !== change.after);
  const seenFiles = new Set();
  const staged = [];
  for (const change of pending) {
    const file = fsImpl.realpathSync(path.resolve(change.file));
    if (seenFiles.has(file)) throw new Error(`writeFilePairAtomically: file duplicato ${change.file}`);
    seenFiles.add(file);
    staged.push({ ...change, file, tmp: null });
  }
  if (staged.length === 0) return;

  try {
    for (const item of staged) {
      item.tmp = `${item.file}.${process.pid}.${temporarySequence++}.pair.tmp`;
      fsImpl.writeFileSync(item.tmp, item.after, 'utf8');
    }
  } catch (error) {
    const cleanupErrors = [];
    for (const item of staged) {
      if (item.tmp) removeTemporaryFile(fsImpl, item.tmp, cleanupErrors);
    }
    throwWithRelatedErrors(error, cleanupErrors, 'staging della coppia incompleto');
  }

  const committed = [];
  try {
    for (const item of staged) {
      fsImpl.renameSync(item.tmp, item.file);
      item.tmp = null;
      committed.push(item);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const item of staged) {
      if (item.tmp) removeTemporaryFile(fsImpl, item.tmp, rollbackErrors);
    }
    for (const item of committed.reverse()) {
      try {
        restoreAtomically(fsImpl, item.file, item.before);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    throwWithRelatedErrors(error, rollbackErrors, 'commit della coppia e rollback incompleti');
  }
}
