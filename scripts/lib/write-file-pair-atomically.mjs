import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';

const WRITER_LOCK_NAME = '.registry-pair-write.lock';
const RECOVERY_LOCK_NAME = '.registry-pair-recovery.lock';
const JOURNAL_NAME = '.registry-pair-write.journal.json';
const JOURNAL_VERSION = 1;

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function pathExists(fsImpl, file) {
  try {
    fsImpl.lstatSync(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function removeTemporaryFile(fsImpl, file, errors) {
  try {
    fsImpl.unlinkSync(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    errors.push(error);
    return false;
  }
}

function throwWithRelatedErrors(error, relatedErrors, message) {
  if (relatedErrors.length === 0) throw error;
  throw new AggregateError([error, ...relatedErrors], `${message} (${relatedErrors.length} errori aggiuntivi)`);
}

function makeTransactionStagingFile(file, transactionId, kind) {
  if (!validTransactionId(transactionId) || !/^[a-z-]+$/u.test(kind)) {
    throw new TypeError('makeTransactionStagingFile: transactionId o kind non valido');
  }
  return `${file}.${transactionId}.${kind}.tmp`;
}

function writeJsonAtomically(fsImpl, file, value, transactionId) {
  const tmp = makeTransactionStagingFile(file, transactionId, 'journal');
  let fd = null;
  let created = false;
  try {
    fd = fsImpl.openSync(tmp, 'wx', 0o600);
    created = true;
    fsImpl.writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8');
    fsImpl.closeSync(fd);
    fd = null;
    fsImpl.renameSync(tmp, file);
    created = false;
  } catch (error) {
    const cleanupErrors = [];
    if (fd !== null) {
      try {
        fsImpl.closeSync(fd);
      } catch (closeError) {
        cleanupErrors.push(closeError);
      }
    }
    if (created) removeTemporaryFile(fsImpl, tmp, cleanupErrors);
    throwWithRelatedErrors(error, cleanupErrors, `scrittura atomica di ${file} incompleta`);
  }
}

function readJsonFile(fsImpl, file, label) {
  let text;
  try {
    text = fsImpl.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`${label}: impossibile leggere ${file}`, { cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label}: JSON non valido in ${file}`, { cause: error });
  }
}

function validPid(pid) {
  return Number.isSafeInteger(pid) && pid > 0;
}

function validHost(value) {
  return typeof value === 'string' && value.length > 0 && !/[\r\n]/u.test(value);
}

function validTransactionId(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM and unexpected errors are treated as live/unknown. Recovery must
    // fail closed unless absence is positively established with ESRCH.
    return error?.code !== 'ESRCH';
  }
}

function writerLockRecord(pid, transactionId, host) {
  return { version: JOURNAL_VERSION, pid, host, transactionId };
}

function readWriterLock(fsImpl, lockFile) {
  const record = readJsonFile(fsImpl, lockFile, 'lock della coppia');
  if (record?.version !== JOURNAL_VERSION
      || !validPid(record.pid)
      || !validHost(record.host)
      || !validTransactionId(record.transactionId)) {
    throw new Error(`lock della coppia non verificabile (${lockFile}); recovery manuale necessaria`);
  }
  return record;
}

function isLegacyJournalTemporaryName(name) {
  const prefix = `${JOURNAL_NAME}.`;
  if (!name.startsWith(prefix) || !name.endsWith('.tmp')) return false;
  return /^\d+\.\d+\.tmp$/u.test(name.slice(prefix.length));
}

function isJournalTemporaryName(name) {
  const prefix = `${JOURNAL_NAME}.`;
  if (!name.startsWith(prefix) || !name.endsWith('.tmp')) return false;
  const suffix = name.slice(prefix.length);
  return isLegacyJournalTemporaryName(name)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.journal\.tmp$/iu.test(suffix);
}

function journalTemporaryNames(fsImpl, directory) {
  return fsImpl.readdirSync(directory).filter(isJournalTemporaryName);
}

function assertNoPendingRecovery(fsImpl, directory) {
  const recoveryLock = path.join(directory, RECOVERY_LOCK_NAME);
  if (pathExists(fsImpl, recoveryLock)) {
    throw new Error(`recovery della coppia in corso o lock recovery residuo (${recoveryLock})`);
  }
  const journal = path.join(directory, JOURNAL_NAME);
  const journalTemps = journalTemporaryNames(fsImpl, directory);
  if (pathExists(fsImpl, journal) || journalTemps.length > 0) {
    throw new Error(`journal della coppia presente (${journal}); esegui recoverInterruptedRegistryPair() dopo aver verificato i writer`);
  }
}

function expectedStagingFile(file, pid, transactionId, stagingFile, directory) {
  if (typeof stagingFile !== 'string' || path.dirname(stagingFile) !== directory) return false;
  const name = path.basename(stagingFile);
  if (name === `${path.basename(file)}.${transactionId}.pair.tmp`) return true;
  const prefix = `${path.basename(file)}.${pid}.`;
  if (!name.startsWith(prefix) || !name.endsWith('.pair.tmp')) return false;
  return /^\d+$/u.test(name.slice(prefix.length, -'.pair.tmp'.length));
}

function validateJournal(fsImpl, directory, journal) {
  if (journal?.version !== JOURNAL_VERSION
      || !validPid(journal.pid)
      || !validHost(journal.host)
      || !validTransactionId(journal.transactionId)
      || journal.directory !== directory
      || !['prepared', 'committed', 'recovered'].includes(journal.phase)
      || !Array.isArray(journal.entries)
      || journal.entries.length < 1) {
    throw new Error(`journal della coppia non verificabile in ${directory}; nessun file è stato ripristinato`);
  }

  const seen = new Set();
  for (const entry of journal.entries) {
    if (!entry || typeof entry.file !== 'string' || !path.isAbsolute(entry.file)
        || path.dirname(entry.file) !== directory
        || typeof entry.before !== 'string'
        || entry.beforeSha256 !== digest(entry.before)
        || typeof entry.afterSha256 !== 'string'
        || !/^[0-9a-f]{64}$/u.test(entry.afterSha256)) {
      throw new Error(`snapshot journal non valido in ${directory}; recovery rifiutata senza modifiche`);
    }
    let realFile;
    try {
      realFile = fsImpl.realpathSync(entry.file);
    } catch (error) {
      throw new Error(`target journal non disponibile (${entry.file}); recovery rifiutata`, { cause: error });
    }
    if (realFile !== entry.file || seen.has(entry.file)) {
      throw new Error(`target journal non canonico o duplicato (${entry.file}); recovery rifiutata`);
    }
    seen.add(entry.file);

    if (entry.before === undefined || entry.stagingFile === undefined) {
      throw new Error(`entry journal incompleta (${entry.file}); recovery rifiutata`);
    }
    if (entry.beforeSha256 === entry.afterSha256 && entry.stagingFile !== null) {
      throw new Error(`staging inatteso per un target invariato (${entry.file}); recovery rifiutata`);
    }
    if (entry.beforeSha256 !== entry.afterSha256
        && !expectedStagingFile(entry.file, journal.pid, journal.transactionId, entry.stagingFile, directory)) {
      throw new Error(`path di staging non verificabile (${entry.file}); recovery rifiutata`);
    }
  }
  return journal;
}

function readJournal(fsImpl, directory) {
  const file = path.join(directory, JOURNAL_NAME);
  return validateJournal(fsImpl, directory, readJsonFile(fsImpl, file, 'journal della coppia'));
}

function makeJournal(directory, transactionId, pid, host, canonical, staged) {
  const stagingByFile = new Map(staged.map((item) => [item.file, item.tmp]));
  return {
    version: JOURNAL_VERSION,
    transactionId,
    pid,
    host,
    directory,
    phase: 'prepared',
    entries: canonical.map((change) => ({
      file: change.file,
      before: change.before,
      beforeSha256: digest(change.before),
      afterSha256: digest(change.after),
      stagingFile: stagingByFile.get(change.file) ?? null,
    })),
  };
}

function currentSnapshot(fsImpl, journal) {
  return journal.entries.map((entry) => {
    const content = fsImpl.readFileSync(entry.file, 'utf8');
    const sha256 = digest(content);
    if (content !== entry.before && sha256 !== entry.afterSha256) {
      throw new Error(`stato ambiguo per ${entry.file}; recovery rifiutata senza modifiche`);
    }
    return { entry, content, sha256 };
  });
}

function allBefore(snapshot) {
  return snapshot.every(({ entry, content }) => content === entry.before);
}

function allAfter(snapshot) {
  return snapshot.every(({ entry, sha256 }) => sha256 === entry.afterSha256);
}

function restoreAtomically(fsImpl, file, content, kind, transactionId) {
  const tmp = makeTransactionStagingFile(file, transactionId, kind);
  let fd = null;
  let created = false;
  try {
    fd = fsImpl.openSync(tmp, 'wx', 0o600);
    created = true;
    fsImpl.writeFileSync(fd, content, 'utf8');
    fsImpl.closeSync(fd);
    fd = null;
    fsImpl.renameSync(tmp, file);
    created = false;
  } catch (error) {
    const cleanupErrors = [];
    if (fd !== null) {
      try {
        fsImpl.closeSync(fd);
      } catch (closeError) {
        cleanupErrors.push(closeError);
      }
    }
    if (created) removeTemporaryFile(fsImpl, tmp, cleanupErrors);
    throwWithRelatedErrors(error, cleanupErrors, `ripristino incompleto per ${file}`);
  }
}

function restoreBeforeSnapshot(fsImpl, journal, snapshot) {
  for (const { entry, content } of snapshot) {
    if (content !== entry.before) {
      restoreAtomically(fsImpl, entry.file, entry.before, 'pair-recovery', journal.transactionId);
    }
  }
}

function recoveryTemporaryNames(fsImpl, directory, journal) {
  const expected = new Set(journal.entries.flatMap((entry) => [
    path.basename(makeTransactionStagingFile(entry.file, journal.transactionId, 'pair-recovery')),
    path.basename(makeTransactionStagingFile(entry.file, journal.transactionId, 'pair-rollback')),
  ]));
  return fsImpl.readdirSync(directory).filter((name) => expected.has(name));
}

function cleanupRecoveryArtifacts(fsImpl, directory, journal, { ownedStagingFiles } = {}) {
  const errors = [];
  // Legacy PID.sequence staging names are accepted for journal compatibility,
  // but retained: without a transaction-specific path, recovery cannot rule
  // out a stale or foreign artifact after PID/sequence reuse.
  for (const entry of journal.entries) {
    const transactionStagingFile = makeTransactionStagingFile(entry.file, journal.transactionId, 'pair');
    if (entry.stagingFile
        && (ownedStagingFiles
          ? ownedStagingFiles.has(entry.stagingFile)
          : entry.stagingFile === transactionStagingFile)) {
      removeTemporaryFile(fsImpl, entry.stagingFile, errors);
    }
  }
  for (const name of recoveryTemporaryNames(fsImpl, directory, journal)) {
    removeTemporaryFile(fsImpl, path.join(directory, name), errors);
  }
  const transactionJournalTemporary = makeTransactionStagingFile(
    path.join(directory, JOURNAL_NAME),
    journal.transactionId,
    'journal',
  );
  removeTemporaryFile(fsImpl, transactionJournalTemporary, errors);
  for (const name of journalTemporaryNames(fsImpl, directory).filter(isLegacyJournalTemporaryName)) {
    const file = path.join(directory, name);
    let candidate;
    try {
      candidate = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    } catch (error) {
      errors.push(new Error(`journal temporaneo legacy non verificabile (${file}); recovery rifiutata`, { cause: error }));
      continue;
    }
    if (candidate?.transactionId !== journal.transactionId || candidate?.directory !== directory) {
      errors.push(new Error(`journal temporaneo legacy di un'altra transazione (${file}); file mantenuto`));
      continue;
    }
    removeTemporaryFile(fsImpl, file, errors);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `cleanup recovery della coppia incompleto (${errors.length} errori)`);
  }
}

function assertAllBefore(fsImpl, journal) {
  if (!journal.entries.every((entry) => fsImpl.readFileSync(entry.file, 'utf8') === entry.before)) {
    throw new Error('snapshot precedente non ripristinato integralmente; lock e journal mantenuti');
  }
}

function assertAllAfter(fsImpl, journal) {
  if (!journal.entries.every((entry) => digest(fsImpl.readFileSync(entry.file, 'utf8')) === entry.afterSha256)) {
    throw new Error('snapshot committed non coerente; lock e journal mantenuti');
  }
}

function releaseWriterLock(fsImpl, lock, errors) {
  let closed = false;
  try {
    fsImpl.closeSync(lock.fd);
    lock.fd = null;
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

function closeWriterLockKeepingPath(fsImpl, lock, errors) {
  if (lock.fd === null) return;
  try {
    fsImpl.closeSync(lock.fd);
    lock.fd = null;
  } catch (error) {
    errors.push(error);
  }
}

function writeStagedFiles(fsImpl, staged, transactionId) {
  try {
    for (const item of staged) {
      fsImpl.writeFileSync(item.tmp, item.after, { encoding: 'utf8', flag: 'wx' });
      item.ownsTmp = true;
    }
  } catch (error) {
    const cleanupErrors = [];
    for (const item of staged) {
      if (item.tmp && item.ownsTmp) {
        if (removeTemporaryFile(fsImpl, item.tmp, cleanupErrors)) item.ownsTmp = false;
      }
    }
    throwWithRelatedErrors(error, cleanupErrors, 'staging della coppia incompleto');
  }

  const committed = [];
  try {
    for (const item of staged) {
      fsImpl.renameSync(item.tmp, item.file);
      item.tmp = null;
      item.ownsTmp = false;
      committed.push(item);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const item of staged) {
      if (item.tmp && item.ownsTmp) {
        if (removeTemporaryFile(fsImpl, item.tmp, rollbackErrors)) item.ownsTmp = false;
      }
    }
    for (const item of committed.reverse()) {
      try {
        restoreAtomically(fsImpl, item.file, item.before, 'pair-rollback', transactionId);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    throwWithRelatedErrors(error, rollbackErrors, 'commit della coppia e rollback incompleti');
  }
}

function recoverWhileLocked(fsImpl, directory) {
  const lockFile = path.join(directory, WRITER_LOCK_NAME);
  const journalFile = path.join(directory, JOURNAL_NAME);
  const lockExists = pathExists(fsImpl, lockFile);
  const journalExists = pathExists(fsImpl, journalFile);
  const journalTemps = journalTemporaryNames(fsImpl, directory);

  if (!journalExists) {
    if (lockExists || journalTemps.length > 0) {
      throw new Error(`lock o journal incompleto senza snapshot verificabile in ${directory}; recovery rifiutata`);
    }
    return { recovered: false, state: 'clean' };
  }

  const journal = readJournal(fsImpl, directory);
  if (lockExists) {
    const lock = readWriterLock(fsImpl, lockFile);
    if (lock.pid !== journal.pid || lock.host !== journal.host || lock.transactionId !== journal.transactionId) {
      throw new Error(`lock e journal non appartengono alla stessa scrittura in ${directory}; recovery rifiutata`);
    }
    if (journal.host !== hostname()) {
      throw new Error(`writer registrato su un altro host (${journal.host}); assenza verificabile solo sull'host locale`);
    }
    if (isProcessAlive(lock.pid)) {
      throw new Error(`writer ${lock.pid} ancora attivo o non verificabile; recovery rifiutata`);
    }
  } else if (journal.phase === 'prepared') {
    throw new Error(`journal prepared senza lock in ${directory}; stato ambiguo, recovery rifiutata`);
  } else if (journal.phase === 'committed') {
    if (journal.host !== hostname()) {
      throw new Error(`writer registrato su un altro host (${journal.host}); assenza verificabile solo sull'host locale`);
    }
    if (isProcessAlive(journal.pid)) {
      throw new Error(`writer ${journal.pid} ancora attivo o non verificabile; recovery rifiutata`);
    }
  }

  const snapshot = currentSnapshot(fsImpl, journal);
  let outcome;
  if (journal.phase === 'prepared') {
    restoreBeforeSnapshot(fsImpl, journal, snapshot);
    assertAllBefore(fsImpl, journal);
    journal.phase = 'recovered';
    writeJsonAtomically(fsImpl, journalFile, journal, journal.transactionId);
    outcome = 'restored-before';
  } else if (journal.phase === 'recovered') {
    if (!allBefore(snapshot)) {
      throw new Error(`journal recovered con snapshot non coerente in ${directory}; recovery rifiutata senza modifiche`);
    }
    outcome = 'restored-before';
  } else {
    if (!allAfter(snapshot)) {
      throw new Error(`journal committed con snapshot non coerente in ${directory}; recovery rifiutata senza modifiche`);
    }
    assertAllAfter(fsImpl, journal);
    outcome = 'kept-committed';
  }

  if (outcome === 'restored-before') assertAllBefore(fsImpl, journal);
  else assertAllAfter(fsImpl, journal);
  cleanupRecoveryArtifacts(fsImpl, directory, journal);

  if (lockExists) {
    const latestLock = readWriterLock(fsImpl, lockFile);
    if (latestLock.pid !== journal.pid || latestLock.host !== journal.host || latestLock.transactionId !== journal.transactionId
        || isProcessAlive(latestLock.pid)) {
      throw new Error(`lock cambiato o writer attivo prima della rimozione in ${directory}; lock mantenuto`);
    }
    fsImpl.unlinkSync(lockFile);
  }
  const journalCleanupErrors = [];
  removeTemporaryFile(fsImpl, journalFile, journalCleanupErrors);
  if (journalCleanupErrors.length > 0) {
    throw new AggregateError(journalCleanupErrors, `rimozione journal recovery incompleta (${journalCleanupErrors.length} errori)`);
  }
  return { recovered: true, state: outcome };
}

function releaseRecoveryLock(fsImpl, lock, errors) {
  let closed = false;
  try {
    fsImpl.closeSync(lock.fd);
    lock.fd = null;
    closed = true;
  } catch (error) {
    errors.push(error);
  }
  if (!closed) return;
  try {
    fsImpl.unlinkSync(lock.file);
  } catch (error) {
    errors.push(error);
  }
}

/**
 * Explicitly recover a previously interrupted registry write in one directory.
 * Recovery requires a valid versioned snapshot and a lock whose recorded PID is
 * positively absent. It restores the pre-write pair (or verifies an already
 * committed pair), and removes the writer lock only after both targets agree.
 * It refuses missing, mismatched, or third-state data. The per-file renames are
 * not a multi-file filesystem transaction, and this journal does not promise
 * durability across power loss or storage that loses acknowledged writes. A
 * recovery lock left by a killed recovery is not reclaimed automatically and
 * requires manual inspection before retrying.
 */
export function recoverInterruptedRegistryPair(directory, { fsImpl = fs } = {}) {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new TypeError('recoverInterruptedRegistryPair: directory deve essere un path testuale');
  }
  const canonicalDirectory = fsImpl.realpathSync(path.resolve(directory));
  const recoveryLock = { file: path.join(canonicalDirectory, RECOVERY_LOCK_NAME), fd: null };
  try {
    recoveryLock.fd = fsImpl.openSync(recoveryLock.file, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`recovery della coppia già attiva o lock recovery residuo (${recoveryLock.file})`, { cause: error });
    }
    throw error;
  }

  try {
    fsImpl.writeFileSync(recoveryLock.fd, `${JSON.stringify({ version: JOURNAL_VERSION, pid: process.pid })}\n`, 'utf8');
  } catch (error) {
    const cleanupErrors = [];
    releaseRecoveryLock(fsImpl, recoveryLock, cleanupErrors);
    throwWithRelatedErrors(error, cleanupErrors, 'inizializzazione del lock recovery incompleta');
  }

  let result;
  let recoveryError;
  try {
    result = recoverWhileLocked(fsImpl, canonicalDirectory);
  } catch (error) {
    recoveryError = error;
  }
  const releaseErrors = [];
  releaseRecoveryLock(fsImpl, recoveryLock, releaseErrors);
  if (recoveryError) throwWithRelatedErrors(recoveryError, releaseErrors, 'recovery della coppia e rilascio lock incompleti');
  if (releaseErrors.length > 0) {
    throw new AggregateError(releaseErrors, `recoverInterruptedRegistryPair: rilascio lock incompleto (${releaseErrors.length} errori)`);
  }
  return result;
}

/**
 * Stage all changed files before replacement and roll back earlier renames if
 * a later synchronous operation fails. A versioned journal lets a later,
 * explicit recovery restore both snapshots after process interruption. Writers
 * sharing a directory lock compare every input snapshot while holding it.
 * Each rename is individually atomic; the pair is not a filesystem transaction.
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
    .map((change) => ({ ...change, tmp: null, ownsTmp: false }));
  if (staged.length === 0) return;

  const directory = directories.values().next().value;
  assertNoPendingRecovery(fsImpl, directory);
  const transactionId = randomUUID();
  for (const item of staged) {
    item.tmp = makeTransactionStagingFile(item.file, transactionId, 'pair');
  }

  const lock = { file: path.join(directory, WRITER_LOCK_NAME), fd: null };
  try {
    lock.fd = fsImpl.openSync(lock.file, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(
        `writeFilePairAtomically: lock presente (${lock.file}); verifica un writer attivo o usa recoverInterruptedRegistryPair() dopo aver verificato il journal`,
        { cause: error },
      );
    }
    throw error;
  }

  const journalFile = path.join(directory, JOURNAL_NAME);
  const writerHost = hostname();
  const journal = makeJournal(directory, transactionId, process.pid, writerHost, canonical, staged);
  let journalPersisted = false;
  let journalWriteAttempted = false;
  let transactionError;
  try {
    assertNoPendingRecovery(fsImpl, directory);
    fsImpl.writeFileSync(lock.fd, `${JSON.stringify(writerLockRecord(process.pid, transactionId, writerHost))}\n`, 'utf8');
    for (const change of canonical) {
      const current = fsImpl.readFileSync(change.file, 'utf8');
      if (current !== change.before) {
        throw new Error(`writeFilePairAtomically: snapshot obsoleto per ${change.file}; rileggi e ripeti il backfill`);
      }
    }
    journalWriteAttempted = true;
    writeJsonAtomically(fsImpl, journalFile, journal, transactionId);
    journalPersisted = true;
    writeStagedFiles(fsImpl, staged, transactionId);
    if (!canonical.every((change) => fsImpl.readFileSync(change.file, 'utf8') === change.after)) {
      throw new Error('writeFilePairAtomically: verifica post-rename non coerente');
    }
    journal.phase = 'committed';
    writeJsonAtomically(fsImpl, journalFile, journal, transactionId);
  } catch (error) {
    transactionError = error;
  }

  if (transactionError) {
    const relatedErrors = [];
    let unreadablePersistedJournal = false;
    if (!journalPersisted && journalWriteAttempted && pathExists(fsImpl, journalFile)) {
      try {
        const existingJournal = readJournal(fsImpl, directory);
        if (existingJournal.transactionId === transactionId) {
          Object.assign(journal, existingJournal);
          journalPersisted = true;
        }
      } catch (error) {
        relatedErrors.push(error);
        unreadablePersistedJournal = true;
      }
    }

    let safeToRelease = !journalPersisted && !unreadablePersistedJournal;
    if (journalPersisted) {
      try {
        const snapshot = currentSnapshot(fsImpl, journal);
        restoreBeforeSnapshot(fsImpl, journal, snapshot);
        assertAllBefore(fsImpl, journal);
        journal.phase = 'recovered';
        writeJsonAtomically(fsImpl, journalFile, journal, transactionId);
        cleanupRecoveryArtifacts(fsImpl, directory, journal, {
          ownedStagingFiles: new Set(staged
            .filter((item) => item.tmp && item.ownsTmp)
            .map((item) => item.tmp)),
        });
        safeToRelease = true;
      } catch (error) {
        relatedErrors.push(error);
      }
    }
    if (journalWriteAttempted && !journalPersisted && journalTemporaryNames(fsImpl, directory).length > 0) {
      relatedErrors.push(new Error(`journal temporaneo residuo in ${directory}; lock mantenuto`));
      safeToRelease = false;
    }

    if (safeToRelease) {
      const lockErrors = [];
      releaseWriterLock(fsImpl, lock, lockErrors);
      relatedErrors.push(...lockErrors);
      if (lockErrors.length === 0 && journalPersisted) {
        removeTemporaryFile(fsImpl, journalFile, relatedErrors);
      }
    } else {
      closeWriterLockKeepingPath(fsImpl, lock, relatedErrors);
    }
    throwWithRelatedErrors(transactionError, relatedErrors, 'scrittura della coppia e recovery sincrona incomplete');
  }

  const lockCleanupErrors = [];
  releaseWriterLock(fsImpl, lock, lockCleanupErrors);
  if (lockCleanupErrors.length > 0) {
    throw new AggregateError(lockCleanupErrors, `writeFilePairAtomically: rilascio lock incompleto (${lockCleanupErrors.length} errori)`);
  }
  try {
    fsImpl.unlinkSync(journalFile);
  } catch (error) {
    throw new Error(`writeFilePairAtomically: coppia committed ma journal residuo (${journalFile})`, { cause: error });
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
