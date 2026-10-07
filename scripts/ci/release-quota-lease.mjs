#!/usr/bin/env node
/**
 * Release a consumed quota lease with bounded retries.
 *
 * The lease event stream is append-only and the release operation is
 * idempotent: after a response is lost, a retry observes the released marker
 * and verifies it instead of extending the lease. The child command is put in
 * strict release mode so an API/parser failure is observable to this wrapper;
 * the normal quota gate remains fail-closed and exit-zero for its preflight
 * callers.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_DELAY_MS,
  retryGitHubMutation,
} from './requeue-quota-lease.mjs';

const MAX_BUFFER = 8 * 1024 * 1024;

function errorText(error) {
  return [error?.stderr, error?.stdout, error?.message]
    .map((part) => (part == null ? '' : String(part)))
    .join('\n');
}

/**
 * Run the release gate again only for transient GitHub failures.
 *
 * @param {{nodeBin?: string, checkScript?: string, exec?: Function,
 *          env?: NodeJS.ProcessEnv, maxAttempts?: number, retryDelayMs?: number,
 *          sleep?: (ms: number) => void, log?: (line: string) => void}} options
 */
export function releaseLeaseWithRetry({
  nodeBin = process.execPath,
  checkScript = 'scripts/ci/check-quota-backoff.mjs',
  exec = execFileSync,
  env = process.env,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  sleep,
  log,
} = {}) {
  const args = [checkScript];
  return retryGitHubMutation(
    () => exec(nodeBin, args, {
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, QUOTA_LEASE_STRICT_RELEASE: '1' },
    }),
    {
      maxAttempts,
      retryDelayMs,
      ...(sleep ? { sleep } : {}),
      ...(log ? { log } : {}),
      mutationName: 'quota lease release',
    },
  );
}

function main() {
  try {
    const output = releaseLeaseWithRetry();
    if (output) process.stdout.write(output);
    return 0;
  } catch (error) {
    const detail = errorText(error).replace(/\s+/g, ' ').trim().slice(0, 240);
    console.error(`::error::Quota lease release fallito: ${detail}`);
    return 1;
  }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
