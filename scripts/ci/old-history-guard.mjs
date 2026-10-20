#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';

/**
 * Fail-closed history check for writers that retry a push after rebasing.
 *
 * The retry helper deliberately works with shallow Actions checkouts, so this
 * guard does not require a complete clone. It checks the stronger invariant
 * that is available locally: the candidate to be pushed must descend from the
 * remote-tracking ref fetched by the caller. A candidate based on an older or
 * unrelated history must never reach the push or the soft-fail path.
 */

const SAFE_REMOTE_RE = /^[A-Za-z0-9._-]+$/u;
const VALID_REF_RE = /^[^\u0000\s]+$/u;

function git(args, { cwd, stdio = ['ignore', 'pipe', 'pipe'] } = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
  }).trim();
}

function validateRef(value, label) {
  if (typeof value !== 'string' || !value || value.startsWith('-') || !VALID_REF_RE.test(value)) {
    throw new TypeError(`${label} must be a non-empty Git ref without whitespace`);
  }
  return value;
}

function resolveCommit(reference, cwd, gitImpl = git) {
  try {
    return gitImpl(['rev-parse', '--verify', '--end-of-options', `${reference}^{commit}`], { cwd });
  } catch {
    throw new Error(`cannot resolve ${reference} as a commit`);
  }
}

function isAncestor(baseSha, candidateSha, cwd) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', baseSha, candidateSha], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
  });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`cannot verify ancestry of ${baseSha} and ${candidateSha}`);
}

/** Parse the CLI without consulting Git. */
export function parseArgs(args = []) {
  const options = {
    remote: 'origin',
    branch: 'main',
    candidate: 'HEAD',
    base: null,
    cwd: process.cwd(),
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (!['--remote', '--branch', '--candidate', '--base', '--cwd'].includes(argument)) {
      throw new TypeError(`Unknown old-history-guard option: ${argument}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new TypeError(`Missing value for ${argument}`);
    index += 1;
    if (argument === '--remote') options.remote = value;
    else if (argument === '--branch') options.branch = value;
    else if (argument === '--candidate') options.candidate = value;
    else if (argument === '--base') options.base = value;
    else options.cwd = resolve(value);
  }

  if (!SAFE_REMOTE_RE.test(options.remote)) {
    throw new TypeError('remote must be a local Git remote name');
  }
  validateRef(options.branch, 'branch');
  validateRef(options.candidate, 'candidate');
  if (options.base !== null) validateRef(options.base, 'base');
  return options;
}

/**
 * Verify that the candidate is based on the fetched remote history.
 *
 * @returns {{baseRef: string, baseSha: string, candidate: string, candidateSha: string, shallow: boolean}}
 */
export function inspectHistory({
  cwd = process.cwd(),
  remote = 'origin',
  branch = 'main',
  base = null,
  candidate = 'HEAD',
  gitImpl = git,
  ancestorImpl = isAncestor,
} = {}) {
  if (!SAFE_REMOTE_RE.test(remote)) throw new TypeError('remote must be a local Git remote name');
  validateRef(branch, 'branch');
  validateRef(candidate, 'candidate');
  if (base !== null) validateRef(base, 'base');

  const root = resolve(cwd);
  if (gitImpl(['rev-parse', '--is-inside-work-tree'], { cwd: root }) !== 'true') {
    throw new Error('current directory is not a Git work tree');
  }

  const baseRef = base || `${remote}/${branch}`;
  const baseSha = resolveCommit(baseRef, root, gitImpl);
  const candidateSha = resolveCommit(candidate, root, gitImpl);
  const shallow = gitImpl(['rev-parse', '--is-shallow-repository'], { cwd: root }) === 'true';

  if (!ancestorImpl(baseSha, candidateSha, root)) {
    throw new Error(
      `OLD_HISTORY_GUARD: candidate ${candidateSha} does not descend from ${baseRef} (${baseSha}); `
      + 'refusing a push from old or unrelated history',
    );
  }

  return { baseRef, baseSha, candidate, candidateSha, shallow };
}

function usage() {
  return [
    'node scripts/ci/old-history-guard.mjs [--remote origin] [--branch main] [--candidate HEAD]',
    '  [--base origin/main] [--cwd PATH]',
  ].join('\n');
}

if (isInvokedDirectly(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
    } else {
      const result = inspectHistory(options);
      console.log(
        `old-history-guard: ${result.baseRef} ${result.baseSha} -> ${result.candidateSha}`
        + ` (shallow=${result.shallow})`,
      );
    }
  } catch (error) {
    console.error(`OLD_HISTORY_GUARD_FATAL: ${error?.message || error}`);
    process.exitCode = 1;
  }
}
