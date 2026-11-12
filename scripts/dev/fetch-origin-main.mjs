#!/usr/bin/env node
// Aggiorna origin/main una sola volta per repository prima della creazione
// simultanea di worktree da parte di più sessioni agentiche.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { withSingleFlightLock } from '../lib/single-flight-lock.mjs';

const [repoRootArg] = process.argv.slice(2);
if (!repoRootArg) {
  console.error('usage: fetch-origin-main.mjs REPO_ROOT');
  process.exit(64);
}

const repoRoot = realpathSync(repoRootArg);
let commonDir;
try {
  const raw = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--git-common-dir'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  commonDir = realpathSync(resolve(repoRoot, raw));
} catch {
  console.error('directory Git comune non verificabile; rifiuto di usare un origin/main forse obsoleto.');
  process.exit(69);
}

const lockPath = join(commonDir, 'frontaliere-agent-worktree-fetch.lock');
const result = withSingleFlightLock(lockPath, () => {
  try {
    execFileSync('git', [
      '-C', repoRoot,
      'fetch',
      '--quiet',
      '--no-tags',
      'origin',
      '+refs/heads/main:refs/remotes/origin/main',
    ], {
      stdio: 'ignore',
      timeout: 25 * 60 * 1000,
      killSignal: 'SIGTERM',
    });
    return true;
  } catch {
    return false;
  }
});

if (!result.acquired) {
  console.error(`fetch origin/main concorrente in corso (${lockPath}); riprova dopo il completamento.`);
  process.exit(75);
}
if (!result.value) {
  console.error('fetch origin/main non riuscito; rifiuto di creare un worktree da una base forse obsoleta.');
  process.exit(1);
}

try {
  execFileSync('git', ['-C', repoRoot, 'rev-parse', '--verify', 'refs/remotes/origin/main'], {
    stdio: 'ignore',
  });
} catch {
  console.error('origin/main non verificabile dopo il fetch; rifiuto di creare il worktree.');
  process.exit(1);
}
