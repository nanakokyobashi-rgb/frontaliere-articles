/**
 * Recoverable transaction for an existing pharmacy-guide refresh.
 *
 * A refresh touches body, localized meta/SEO and freshness registries.  A
 * process can be killed between two renames, so the transaction keeps a
 * repository-local lock, staged files and backups.  The commit is a sequence
 * of atomic same-filesystem renames; an interrupted or failed sequence is
 * rolled back before the next refresh is allowed to start.
 */
import fs from 'node:fs';
import path from 'node:path';

export const PHARMACY_REFRESH_LOCK_RELATIVE_PATH =
  'generator/data/.pharmacy-evergreen-refresh.lock.json';
export const PHARMACY_REFRESH_TRANSACTION_RELATIVE_PATH =
  'generator/data/.pharmacy-evergreen-refresh-tx';

const JOURNAL_NAME = 'journal.json';
const STAGE_NAME = 'stage';
const BACKUP_NAME = 'backup';
const TRANSACTION_VERSION = 1;
let stateTmpSeq = 0;

function transactionPaths(repoRoot) {
  const root = path.resolve(repoRoot);
  const transactionRoot = path.join(root, PHARMACY_REFRESH_TRANSACTION_RELATIVE_PATH);
  return {
    root,
    lockPath: path.join(root, PHARMACY_REFRESH_LOCK_RELATIVE_PATH),
    transactionRoot,
    journalPath: path.join(transactionRoot, JOURNAL_NAME),
    stageRoot: path.join(transactionRoot, STAGE_NAME),
    backupRoot: path.join(transactionRoot, BACKUP_NAME),
  };
}

function repoFile(paths, file) {
  const absolute = path.resolve(file);
  const prefix = `${paths.root}${path.sep}`;
  if (absolute === paths.root || !absolute.startsWith(prefix)) {
    throw new Error(`pharmacy refresh: path fuori dal repository: ${file}`);
  }
  return { absolute, relative: path.relative(paths.root, absolute) };
}

function atomicTextWrite(file, content) {
  const tmp = `${file}.${process.pid}.${stateTmpSeq++}.tmp`;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

function atomicStateWrite(file, value) {
  atomicTextWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`pharmacy refresh: stato transazione non leggibile (${file}): ${error.message}`);
  }
}

function removeTransactionTree(paths) {
  fs.rmSync(paths.transactionRoot, { recursive: true, force: true });
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not inspectable by this user.
    return error.code !== 'ESRCH';
  }
}

function restoreJournal(paths, journal) {
  const failures = [];
  for (const entry of [...(journal.files || [])].reverse()) {
    const target = path.join(paths.root, entry.path);
    const backup = path.join(paths.transactionRoot, entry.backup);
    try {
      if (entry.existed) {
        if (!fs.existsSync(backup)) {
          throw new Error(`backup assente per ${entry.path}`);
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(backup, target);
      } else if (fs.existsSync(target)) {
        fs.unlinkSync(target);
      }
    } catch (error) {
      failures.push(`${entry.path}: ${error.message}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`rollback pharmacy refresh incompleto: ${failures.join(' | ')}`);
  }
}

/**
 * Recover a transaction left by a killed process.  An active PID is never
 * touched; a stale prepared/committing journal is restored from its backups.
 */
export function recoverPharmacyEvergreenRefresh(repoRoot, { log = () => {} } = {}) {
  const paths = transactionPaths(repoRoot);
  const lockExists = fs.existsSync(paths.lockPath);
  const transactionExists = fs.existsSync(paths.transactionRoot);
  if (!lockExists && !transactionExists) return { recovered: false };

  let lock = null;
  if (lockExists) {
    try {
      lock = readJson(paths.lockPath);
    } catch (error) {
      // A process can die between creating and filling the lock. The
      // transaction directory is still scoped to this producer, so cleaning
      // this incomplete state is safer than blocking every future refresh.
      log(`  ⚠️ ${error.message}; lock incompleto considerato stale.`);
    }
  }
  if (lock && processIsAlive(lock.pid)) {
    throw new Error(
      `pharmacy refresh: lock attivo (pid ${lock.pid}); `
      + 'attendere il termine del producer prima di rilanciare',
    );
  }

  if (fs.existsSync(paths.journalPath)) {
    const journal = readJson(paths.journalPath);
    if (journal.phase !== 'committed') restoreJournal(paths, journal);
  }
  removeTransactionTree(paths);
  if (fs.existsSync(paths.lockPath)) fs.unlinkSync(paths.lockPath);
  log('  ♻️ recuperata e ripulita una transazione pharmacy evergreen interrotta.');
  return { recovered: true };
}

export function acquirePharmacyEvergreenRefresh(repoRoot, {
  log = () => {},
  pid = process.pid,
  now = () => new Date().toISOString(),
} = {}) {
  const paths = transactionPaths(repoRoot);
  const recovered = recoverPharmacyEvergreenRefresh(paths.root, { log });

  // The fixed directory is itself a second collision guard: a stale directory
  // cannot be silently reused if recovery failed before the lock was written.
  fs.mkdirSync(paths.transactionRoot);
  fs.mkdirSync(paths.stageRoot);
  fs.mkdirSync(paths.backupRoot);

  let fd;
  try {
    fd = fs.openSync(paths.lockPath, 'wx');
    fs.writeSync(fd, `${JSON.stringify({
      version: TRANSACTION_VERSION,
      pid,
      startedAt: now(),
      transaction: PHARMACY_REFRESH_TRANSACTION_RELATIVE_PATH,
    })}\n`);
    fs.fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best-effort cleanup */ }
    }
    removeTransactionTree(paths);
    if (error.code === 'EEXIST') {
      throw new Error(
        `pharmacy refresh: impossibile acquisire il lock ${PHARMACY_REFRESH_LOCK_RELATIVE_PATH}; `
        + 'un altro producer potrebbe essere attivo',
      );
    }
    throw error;
  }
  fs.closeSync(fd);

  const staged = new Map();
  let journal = null;

  const stage = (file, content) => {
    if (typeof content !== 'string') throw new TypeError(`pharmacy refresh: contenuto non stringa per ${file}`);
    const target = repoFile(paths, file);
    const stagePath = path.join(paths.stageRoot, target.relative);
    fs.mkdirSync(path.dirname(stagePath), { recursive: true });
    atomicTextWrite(stagePath, content);
    staged.set(target.relative, { target, stagePath });
  };

  const read = (file) => {
    const target = repoFile(paths, file);
    const pending = staged.get(target.relative);
    return pending ? fs.readFileSync(pending.stagePath, 'utf8') : fs.readFileSync(target.absolute, 'utf8');
  };

  const prepare = () => {
    if (journal) return journal;
    const files = [...staged.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([relative, entry]) => {
        const existed = fs.existsSync(entry.target.absolute);
        const backup = path.join(BACKUP_NAME, relative);
        if (existed) {
          const backupPath = path.join(paths.transactionRoot, backup);
          fs.mkdirSync(path.dirname(backupPath), { recursive: true });
          fs.copyFileSync(entry.target.absolute, backupPath);
        }
        return { path: relative, stage: path.join(STAGE_NAME, relative), backup, existed };
      });
    journal = {
      version: TRANSACTION_VERSION,
      phase: 'prepared',
      committed: 0,
      files,
    };
    atomicStateWrite(paths.journalPath, journal);
    return journal;
  };

  const cleanup = () => {
    removeTransactionTree(paths);
    if (fs.existsSync(paths.lockPath)) fs.unlinkSync(paths.lockPath);
  };

  const rollback = () => {
    if (!journal && !fs.existsSync(paths.journalPath)) {
      cleanup();
      return;
    }
    const current = journal || readJson(paths.journalPath);
    if (current.phase !== 'committed') restoreJournal(paths, current);
    cleanup();
  };

  const commit = () => {
    prepare();
    journal.phase = 'committing';
    atomicStateWrite(paths.journalPath, journal);
    try {
      for (let index = 0; index < journal.files.length; index += 1) {
        const entry = journal.files[index];
        const target = path.join(paths.root, entry.path);
        const stagePath = path.join(paths.transactionRoot, entry.stage);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(stagePath, target);
        journal.committed = index + 1;
        atomicStateWrite(paths.journalPath, journal);
      }
      journal.phase = 'committed';
      atomicStateWrite(paths.journalPath, journal);
      cleanup();
    } catch (error) {
      try {
        restoreJournal(paths, journal);
        cleanup();
      } catch (rollbackError) {
        throw new Error(
          `pharmacy refresh fallito (${error.message}); ${rollbackError.message}. `
          + `Rilanciare per il recovery da ${PHARMACY_REFRESH_LOCK_RELATIVE_PATH}.`,
        );
      }
      throw error;
    }
  };

  return {
    paths,
    recovered,
    stage,
    read,
    prepare,
    commit,
    rollback,
  };
}
