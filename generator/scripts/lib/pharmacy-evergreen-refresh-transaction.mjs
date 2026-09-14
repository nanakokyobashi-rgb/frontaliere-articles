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
let lockTmpSeq = 0;

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

function readLock(file) {
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`pharmacy refresh: lock parziale o non leggibile (${file}): ${error.message}`);
  }
  if (!lock || typeof lock !== 'object' || !Number.isInteger(lock.pid) || lock.pid <= 0) {
    throw new Error(`pharmacy refresh: lock parziale o non valido (${file})`);
  }
  return lock;
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

function activeLockError(lock) {
  return new Error(
    `pharmacy refresh: lock attivo (pid ${lock.pid}); `
    + 'attendere il termine del producer prima di rilanciare',
  );
}

/**
 * Publish a complete lock with an exclusive hard-link.  `open(..., 'wx')`
 * alone exposes an empty file between create and write; the hard-link makes
 * the final lock visible only after its JSON and fsync are complete, while
 * still refusing a competing publisher without overwriting its lock.
 */
function publishLock(paths, lock) {
  const temporary = `${paths.lockPath}.${process.pid}.${lockTmpSeq++}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx');
    fs.writeSync(fd, `${JSON.stringify(lock)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.linkSync(temporary, paths.lockPath);
    try { fs.unlinkSync(temporary); } catch { /* best-effort cleanup */ }
    return true;
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best-effort cleanup */ }
    }
    try { fs.unlinkSync(temporary); } catch { /* best-effort cleanup */ }
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

function claimLock(paths, { pid, startedAt }) {
  fs.mkdirSync(path.dirname(paths.lockPath), { recursive: true });
  const lock = {
    version: TRANSACTION_VERSION,
    pid,
    startedAt,
    transaction: PHARMACY_REFRESH_TRANSACTION_RELATIVE_PATH,
    token: `${process.pid}:${pid}:${lockTmpSeq++}`,
  };

  for (;;) {
    if (!fs.existsSync(paths.lockPath)) {
      if (publishLock(paths, lock)) return lock;
      continue;
    }

    const existing = readLock(paths.lockPath);
    if (processIsAlive(existing.pid)) throw activeLockError(existing);

    // A stale lock is moved out of the way with one atomic rename. Only the
    // contender that wins the subsequent exclusive publication may recover
    // the transaction; a loser never removes another producer's lock.
    const stale = `${paths.lockPath}.${process.pid}.${lockTmpSeq++}.stale`;
    try {
      fs.renameSync(paths.lockPath, stale);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (publishLock(paths, lock)) {
      try { fs.unlinkSync(stale); } catch { /* best-effort cleanup */ }
      Object.defineProperty(lock, 'reclaimedLock', {
        value: existing,
        enumerable: false,
      });
      return lock;
    }
    try { fs.unlinkSync(stale); } catch { /* best-effort cleanup */ }
  }
}

function releaseOwnedLock(paths, token) {
  if (!fs.existsSync(paths.lockPath)) return;
  let lock;
  try {
    lock = readLock(paths.lockPath);
  } catch {
    return;
  }
  if (lock.token !== token) return;
  fs.unlinkSync(paths.lockPath);
}

function assertOwnedLock(paths, token) {
  if (!fs.existsSync(paths.lockPath)) {
    throw new Error('pharmacy refresh: lock del producer assente durante il recovery');
  }
  const lock = readLock(paths.lockPath);
  if (lock.token !== token) throw activeLockError(lock);
}

function restoreJournal(paths, journal) {
  const failures = [];
  const restored = new Set(Array.isArray(journal.restored) ? journal.restored : []);
  journal.phase = 'rolling_back';
  journal.restored = [...restored];
  atomicStateWrite(paths.journalPath, journal);
  for (const entry of [...(journal.files || [])].reverse()) {
    if (restored.has(entry.path)) continue;
    const target = path.join(paths.root, entry.path);
    const backup = path.join(paths.transactionRoot, entry.backup);
    try {
      if (entry.existed) {
        if (fs.existsSync(backup)) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.renameSync(backup, target);
        } else if (!fs.existsSync(target)) {
          throw new Error(`backup assente per ${entry.path}`);
        }
      } else if (fs.existsSync(target)) {
        fs.unlinkSync(target);
      }
      restored.add(entry.path);
      journal.restored = [...restored];
      atomicStateWrite(paths.journalPath, journal);
    } catch (error) {
      failures.push(`${entry.path}: ${error.message}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`rollback pharmacy refresh incompleto: ${failures.join(' | ')}`);
  }
  journal.phase = 'rolled_back';
  atomicStateWrite(paths.journalPath, journal);
}

/**
 * Recover a transaction left by a killed process.  An active PID is never
 * touched; a stale prepared/committing journal is restored from its backups.
 * A caller that already owns the lock passes its token so recovery does not
 * race with a second lock claim.
 */
export function recoverPharmacyEvergreenRefresh(
  repoRoot,
  { log = () => {}, ownerToken = null, keepLock = false } = {},
) {
  const paths = transactionPaths(repoRoot);
  const lockExists = fs.existsSync(paths.lockPath);
  const transactionExists = fs.existsSync(paths.transactionRoot);

  if (!ownerToken && !lockExists && !transactionExists) return { recovered: false };
  let claimed = null;
  if (ownerToken) {
    assertOwnedLock(paths, ownerToken);
  } else {
    claimed = claimLock(paths, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    ownerToken = claimed.token;
  }

  try {
    if (fs.existsSync(paths.journalPath)) {
      const journal = readJson(paths.journalPath);
      if (journal.phase !== 'committed') restoreJournal(paths, journal);
    }
    removeTransactionTree(paths);
    if (!keepLock) releaseOwnedLock(paths, ownerToken);
  } catch (error) {
    // The lock is ours, but the transaction must remain on disk if recovery
    // failed so a later producer can retry it from the persisted journal.
    if (!keepLock) {
      if (claimed?.reclaimedLock) {
        assertOwnedLock(paths, ownerToken);
        atomicStateWrite(paths.lockPath, claimed.reclaimedLock);
      } else {
        releaseOwnedLock(paths, ownerToken);
      }
    }
    throw error;
  }
  log('  ♻️ recuperata e ripulita una transazione pharmacy evergreen interrotta.');
  return { recovered: transactionExists };
}

export function acquirePharmacyEvergreenRefresh(repoRoot, {
  log = () => {},
  pid = process.pid,
  now = () => new Date().toISOString(),
} = {}) {
  const paths = transactionPaths(repoRoot);
  const lock = claimLock(paths, { pid, startedAt: now() });
  let recovered;
  try {
    recovered = recoverPharmacyEvergreenRefresh(paths.root, {
      log,
      ownerToken: lock.token,
      keepLock: true,
    });
  } catch (error) {
    releaseOwnedLock(paths, lock.token);
    throw error;
  }

  // The lock is published before this directory exists. A concurrent
  // producer therefore fails closed on the lock and can never mistake this
  // producer's in-progress staging tree for an orphan.
  try {
    fs.mkdirSync(paths.transactionRoot);
    fs.mkdirSync(paths.stageRoot);
    fs.mkdirSync(paths.backupRoot);
  } catch (error) {
    releaseOwnedLock(paths, lock.token);
    throw error;
  }

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
      restored: [],
      files,
    };
    atomicStateWrite(paths.journalPath, journal);
    return journal;
  };

  const cleanup = () => {
    assertOwnedLock(paths, lock.token);
    removeTransactionTree(paths);
    releaseOwnedLock(paths, lock.token);
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
