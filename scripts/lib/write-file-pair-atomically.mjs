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

function releaseWriterLock(fsImpl, lock, errors) {
  let closed = false;
  try {
    fsImpl.closeSync(lock.fd);
    closed = true;
  } catch (error) {
    errors.push(error);
  }
  // If descriptor close fails, keep the path in place: removing it could let
  // a second process enter while the first descriptor may still be active.
  if (!closed) return;
  try {
    fsImpl.unlinkSync(lock.file);
  } catch (error) {
    errors.push(error);
  }
}

function writeStagedFiles(fsImpl, staged) {
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

/**
 * Stage all changed files before replacement and roll back earlier renames if
 * a later synchronous operation fails. Writers sharing a directory lock and
 * compare every input snapshot while holding it, preventing stale concurrent
 * invocations from overwriting each other. This is not crash/power-loss
 * atomic; an interrupted process can leave a mixed pair and a lock that needs
 * manual recovery after verifying no writer is still active. Existing targets
 * are canonicalized so symlink aliases cannot be committed twice as if they
 * were distinct files. Cleanup failures are surfaced.
 */
export function writeFilePairAtomically(changes, { fsImpl = fs } = {}) {
  if (!Array.isArray(changes)) throw new TypeError('writeFilePairAtomically: changes deve essere un array');
  for (const change of changes) {
    if (!change || typeof change.file !== 'string' || typeof change.before !== 'string' || typeof change.after !== 'string') {
      throw new TypeError('writeFilePairAtomically: ogni modifica richiede file, before e after testuali');
    }
  }

  const canonical = changes.map((change) => ({
    ...change,
    file: fsImpl.realpathSync(path.resolve(change.file)),
  }));
  if (canonical.length === 0) return;
  const seenFiles = new Set();
  for (const change of canonical) {
    if (seenFiles.has(change.file)) throw new Error(`writeFilePairAtomically: file duplicato ${change.file}`);
    seenFiles.add(change.file);
  }
  const directories = new Set(canonical.map((change) => path.dirname(change.file)));
  if (directories.size !== 1) {
    throw new Error('writeFilePairAtomically: tutti i registry della coppia devono stare nella stessa directory');
  }

  const staged = canonical
    .filter((change) => change.before !== change.after)
    .map((change) => ({ ...change, tmp: null }));
  if (staged.length === 0) return;

  const directory = directories.values().next().value;
  const lock = { file: path.join(directory, '.registry-pair-write.lock'), fd: null };
  try {
    lock.fd = fsImpl.openSync(lock.file, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(
        `writeFilePairAtomically: lock presente (${lock.file}); verifica un writer attivo o recupera manualmente un lock residuo`,
        { cause: error },
      );
    }
    throw error;
  }

  let transactionError;
  try {
    fsImpl.writeFileSync(lock.fd, `pid=${process.pid}\n`, 'utf8');
    for (const change of canonical) {
      const current = fsImpl.readFileSync(change.file, 'utf8');
      if (current !== change.before) {
        throw new Error(`writeFilePairAtomically: snapshot obsoleto per ${change.file}; rileggi e ripeti il backfill`);
      }
    }
    writeStagedFiles(fsImpl, staged);
  } catch (error) {
    transactionError = error;
  }

  const lockCleanupErrors = [];
  releaseWriterLock(fsImpl, lock, lockCleanupErrors);
  if (transactionError) {
    throwWithRelatedErrors(transactionError, lockCleanupErrors, 'scrittura della coppia e rilascio lock incompleti');
  }
  if (lockCleanupErrors.length > 0) {
    throw new AggregateError(lockCleanupErrors, `writeFilePairAtomically: rilascio lock incompleto (${lockCleanupErrors.length} errori)`);
  }
}

/**
 * Commit one read/modify/write through the same directory lock as a registry
 * pair. `before` must be the exact snapshot used to derive `after`; stale
 * single-file writers then fail closed instead of racing a pair update.
 */
export function writeFileSnapshotAtomically(file, before, after, options = {}) {
  return writeFilePairAtomically([{ file, before, after }], options);
}
