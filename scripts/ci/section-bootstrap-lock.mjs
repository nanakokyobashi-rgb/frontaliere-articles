#!/usr/bin/env node
/** Acquire/release the short R2 gate used by a live section bootstrap. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  SECTION_BOOTSTRAP_LOCK_CACHE_CONTROL,
  SECTION_BOOTSTRAP_LOCK_TTL_MS,
  bootstrapLockOwner,
  makeSectionBootstrapLock,
  makeReleasedSectionBootstrapLock,
  readSectionBootstrapLock,
  readBootstrapLockOwnerRun,
  sectionBootstrapLockKey,
} from '../lib/section-bootstrap-lock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CDN_BASE = 'https://cdn.frontaliereticino.ch';

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  return { code: result.status ?? 1, stdout: result.stdout ?? '' };
}

function parseArgs(argv) {
  const [action, ...rest] = argv;
  if (!['acquire', 'release'].includes(action)) throw new Error('uso: section-bootstrap-lock.mjs <acquire|release> --section <canton-x> [--commit <sha>] [--wait-ms <n>] [--retry-ms <n>]');
  const out = { action, section: null, commit: null, role: 'bootstrap', waitMs: 0, retryMs: 20_000 };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--section') out.section = rest[++i];
    else if (arg === '--commit') out.commit = rest[++i];
    else if (arg === '--role') out.role = rest[++i];
    else if (arg === '--wait-ms') out.waitMs = parseMilliseconds(rest[++i], '--wait-ms');
    else if (arg === '--retry-ms') out.retryMs = parseMilliseconds(rest[++i], '--retry-ms');
    else throw new Error(`argomento sconosciuto: ${arg}`);
  }
  if (!out.section) throw new Error('--section obbligatorio');
  if (action === 'acquire' && !out.commit) throw new Error('--commit obbligatorio in acquire');
  if (!Number.isSafeInteger(out.waitMs) || out.waitMs < 0) throw new Error('--wait-ms deve essere un intero non negativo');
  if (!Number.isSafeInteger(out.retryMs) || out.retryMs < 1) throw new Error('--retry-ms deve essere un intero positivo');
  return out;
}

function parseMilliseconds(value, flag) {
  if (!/^\d+$/.test(String(value ?? ''))) throw new Error(`${flag} richiede millisecondi interi non negativi`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} fuori dal range numerico`);
  return parsed;
}

class LockBusyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LockBusyError';
    this.code = 2;
  }
}

function currentCommit(explicit) {
  if (explicit) return explicit;
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
}

function writeGithubEnv(line) {
  const file = process.env.GITHUB_ENV;
  if (file) fs.appendFileSync(file, `${line}\n`);
}

function writeTempDocument(doc) {
  const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'section-bootstrap-lock-'));
  const file = path.join(dir, 'lock.json');
  fs.writeFileSync(file, `${JSON.stringify(doc)}\n`, 'utf8');
  return { dir, file };
}

function lockReadFailure(existing, action) {
  const marker = existing.transient ? 'SECTION_BOOTSTRAP_LOCK_TRANSIENT: ' : '';
  const error = new Error(`${marker}bootstrap lock ${existing.reason || 'non verificabile'} durante ${action}`);
  if (existing.transient) error.code = 'SECTION_BOOTSTRAP_LOCK_TRANSIENT';
  return error;
}

async function acquireOnce({ section, commit, role }) {
  const owner = bootstrapLockOwner();
  const existing = await readSectionBootstrapLock(section, { cdnBase: CDN_BASE });
  if (existing.state === 'active' && existing.doc.owner === owner && existing.doc.role === role) {
    writeGithubEnv('SECTION_BOOTSTRAP_LOCK_HELD=true');
    console.log(`bootstrap lock gia' acquisito: ${section} (${existing.doc.commit.slice(0, 8)}, role=${role})`);
    return;
  }
  let takeoverEtag = null;
  if (existing.state === 'active' && existing.doc.owner !== owner) {
    const ownerRun = await readBootstrapLockOwnerRun(existing.doc.owner);
    if (ownerRun.state !== 'terminal') {
      const detail = ownerRun.state === 'active'
        ? `run ancora ${ownerRun.status}`
        : `stato non verificabile (${ownerRun.reason})`;
      throw new LockBusyError(`bootstrap lock gia' detenuto da ${existing.doc.owner}: ${detail}`);
    }
    if (!existing.etag) throw new Error(`etag lock terminato non disponibile per ${section}`);
    takeoverEtag = existing.etag;
    console.log(`::notice::[section-bootstrap-lock] recupero lock di ${section}: owner ${existing.doc.owner} ha terminato (${ownerRun.conclusion || 'completed'})`);
  }
  if (existing.state === 'unknown') throw lockReadFailure(existing, 'acquire');
  const resolvedCommit = currentCommit(commit);
  const doc = makeSectionBootstrapLock({ section, commit: resolvedCommit, owner, role });
  const temp = writeTempDocument(doc);
  try {
    let condition;
    if (existing.state === 'expired' || takeoverEtag) {
      const etag = takeoverEtag || existing.etag;
      if (!etag) throw new Error(`etag lock scaduto non disponibile per ${section}`);
      condition = `If-Match: ${etag}`;
    } else {
      condition = 'If-None-Match: *';
    }
    const result = run('bash', [
      'scripts/lib/conditional-cdn-put.sh',
      temp.file,
      sectionBootstrapLockKey(section),
      condition,
      SECTION_BOOTSTRAP_LOCK_CACHE_CONTROL,
    ]);
    if (result.code === 2) throw new LockBusyError(`bootstrap lock perso in gara per ${section}`);
    if (result.code !== 0 || !result.stdout.includes('✅ conditional uploaded')) {
      throw new Error(`PUT condizionale lock non confermato per ${section}`);
    }
    writeGithubEnv('SECTION_BOOTSTRAP_LOCK_HELD=true');
    console.log(`bootstrap lock acquisito atomicamente: ${section} (${doc.commit.slice(0, 8)}, role=${role})`);
  } finally {
    fs.rmSync(temp.dir, { recursive: true, force: true });
  }
}

async function acquire({ section, commit, role, waitMs, retryMs }) {
  const deadline = Date.now() + Math.max(0, waitMs);
  let reportedBusy = false;
  for (;;) {
    try {
      await acquireOnce({ section, commit, role });
      return;
    } catch (error) {
      const retryable = error instanceof LockBusyError || error?.code === 'SECTION_BOOTSTRAP_LOCK_TRANSIENT';
      if (!retryable) throw error;
      const remaining = deadline - Date.now();
      if (remaining < retryMs) {
        throw new LockBusyError(`${error.message}; attesa bootstrap scaduta dopo ${Math.round(waitMs / 60_000)} minuti`);
      }
      if (!reportedBusy) {
        console.log(`::notice::[section-bootstrap-lock] ${section} occupata (${error.message}); ritento fino a ${Math.round(waitMs / 60_000)} minuti`);
        reportedBusy = true;
      }
      const delay = Math.min(retryMs, remaining);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function release({ section }) {
  const owner = bootstrapLockOwner();
  const existing = await readSectionBootstrapLock(section, { cdnBase: CDN_BASE });
  if (existing.state === 'absent') throw new Error(`bootstrap lock assente durante il release: ${section}`);
  if (existing.state === 'unknown') throw lockReadFailure(existing, 'release');
  if (existing.doc.owner !== owner) {
    throw new LockBusyError(`bootstrap lock di ${section} appartiene a ${existing.doc.owner}: ownership persa`);
  }
  if (!existing.etag) throw new Error(`etag lock non disponibile durante il release: ${section}`);
  const temp = writeTempDocument(makeReleasedSectionBootstrapLock({
    section,
    commit: existing.doc.commit,
    owner,
  }));
  try {
    const result = run('bash', [
      'scripts/lib/conditional-cdn-put.sh',
      temp.file,
      sectionBootstrapLockKey(section),
      `If-Match: ${existing.etag}`,
      SECTION_BOOTSTRAP_LOCK_CACHE_CONTROL,
    ]);
    if (result.code === 2) throw new Error(`lock sostituito da un altro owner durante il release: ${section}`);
    if (result.code !== 0 || !result.stdout.includes('✅ conditional uploaded')) {
      throw new Error(`tombstone lock non confermato per ${section}`);
    }
    writeGithubEnv('SECTION_BOOTSTRAP_LOCK_HELD=false');
    console.log(`bootstrap lock rilasciato atomicamente: ${section}`);
  } finally {
    fs.rmSync(temp.dir, { recursive: true, force: true });
  }
}

const invokedDirectly = (() => {
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] || '');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().then(
    () => {},
    (error) => {
      console.error(`::error::[section-bootstrap-lock] ${error?.message ?? error}`);
      process.exitCode = error?.code === 2 ? 2 : 1;
    },
  );
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.action === 'acquire') await acquire(args);
  else await release(args);
}
