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
  readSectionBootstrapLock,
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
  if (!['acquire', 'release'].includes(action)) throw new Error('uso: section-bootstrap-lock.mjs <acquire|release> --section <canton-x> [--commit <sha>]');
  const out = { action, section: null, commit: null };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--section') out.section = rest[++i];
    else if (arg === '--commit') out.commit = rest[++i];
    else throw new Error(`argomento sconosciuto: ${arg}`);
  }
  if (!out.section) throw new Error('--section obbligatorio');
  if (action === 'acquire' && !out.commit) throw new Error('--commit obbligatorio in acquire');
  return out;
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

async function acquire({ section, commit }) {
  const owner = bootstrapLockOwner();
  const existing = await readSectionBootstrapLock(section, { cdnBase: CDN_BASE });
  if (existing.state === 'active' && existing.doc.owner !== owner) {
    throw new Error(`bootstrap lock gia' detenuto da ${existing.doc.owner}`);
  }
  if (existing.state === 'unknown') throw new Error(`bootstrap lock non verificabile: ${existing.reason}`);
  const doc = makeSectionBootstrapLock({ section, commit: currentCommit(commit), owner });
  const temp = writeTempDocument(doc);
  try {
    const result = run('bash', ['scripts/lib/upload-cdn-file.sh', temp.file, sectionBootstrapLockKey(section), SECTION_BOOTSTRAP_LOCK_CACHE_CONTROL]);
    if (!result.stdout.includes('✅ uploaded')) throw new Error(`upload lock non confermato per ${section}`);
    const confirmed = await readSectionBootstrapLock(section, { cdnBase: CDN_BASE });
    if (confirmed.state !== 'active' || confirmed.doc.owner !== owner || confirmed.doc.commit !== doc.commit) {
      throw new Error(`lock bootstrap non confermato per ${section}`);
    }
    writeGithubEnv('SECTION_BOOTSTRAP_LOCK_HELD=true');
    console.log(`bootstrap lock acquisito: ${section} (${doc.commit.slice(0, 8)})`);
  } finally {
    fs.rmSync(temp.dir, { recursive: true, force: true });
  }
}

async function release({ section }) {
  const owner = bootstrapLockOwner();
  const existing = await readSectionBootstrapLock(section, { cdnBase: CDN_BASE });
  if (existing.state === 'absent') return;
  if (existing.state === 'unknown') throw new Error(`bootstrap lock non verificabile durante il release: ${existing.reason}`);
  if (existing.doc.owner !== owner) {
    console.log(`bootstrap lock di ${section} appartiene a ${existing.doc.owner}: non viene rimosso`);
    return;
  }
  const result = run('bash', ['scripts/lib/delete-cdn-file.sh', sectionBootstrapLockKey(section)]);
  if (!result.stdout.includes('✅ deleted')) throw new Error(`delete lock non confermata per ${section}`);
  const confirmed = await readSectionBootstrapLock(section, { cdnBase: CDN_BASE });
  if (confirmed.state !== 'absent') throw new Error(`lock bootstrap ancora presente per ${section}`);
  console.log(`bootstrap lock rilasciato: ${section}`);
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
      process.exitCode = 1;
    },
  );
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.action === 'acquire') await acquire(args);
  else await release(args);
}
