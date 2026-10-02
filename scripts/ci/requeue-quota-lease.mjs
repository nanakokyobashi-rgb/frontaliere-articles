#!/usr/bin/env node
/**
 * Re-queue an issue after a shared quota lease was denied.
 *
 * `gh issue edit` is an idempotent mutation: a transient GraphQL/5xx failure
 * can happen after GitHub has applied some or all of the label changes. Retry
 * the whole transition with a bounded exponential backoff so the workflow does
 * not turn a temporary API blip into a failed run. Permanent API errors still
 * fail closed and leave the active label untouched for the rescue path.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_BUFFER = 8 * 1024 * 1024;

function errorText(error) {
  return [error?.stderr, error?.stdout, error?.message]
    .map((part) => (part == null ? '' : String(part)))
    .join('\n');
}

/**
 * Only retry failures that can plausibly be transient GitHub transport/API
 * failures. Auth, permission, validation and missing-issue errors must remain
 * visible instead of being hidden behind a retry loop.
 */
export function isRetryableGitHubMutationError(error) {
  const text = errorText(error);
  return [
    /GraphQL:\s+Something went wrong/i,
    /\bHTTP\s+5\d{2}\b/i,
    /\b5\d{2}\s+(?:Internal Server Error|Not Implemented|Bad Gateway|Service Unavailable|Gateway Timeout|HTTP Version Not Supported|Variant Also Negotiates|Insufficient Storage|Loop Detected|Not Extended|Network Authentication Required)\b/i,
    /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN)\b/i,
    /(?:connection\s+(?:reset|closed)|timed out|temporarily unavailable)/i,
  ].some((pattern) => pattern.test(text));
}

function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

/**
 * Execute an idempotent GitHub mutation with bounded retries.
 *
 * @param {() => unknown} operation
 * @param {{maxAttempts?: number, retryDelayMs?: number, sleep?: (ms: number) => void,
 *          log?: (line: string) => void}} options
 */
export function retryGitHubMutation(operation, {
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  sleep = sleepSync,
  log = (line) => console.log(line),
} = {}) {
  const attempts = positiveInteger(maxAttempts, DEFAULT_MAX_ATTEMPTS);
  const delay = nonNegativeInteger(retryDelayMs, DEFAULT_RETRY_DELAY_MS);
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableGitHubMutationError(error) || attempt === attempts) throw error;

      const waitMs = delay * (2 ** (attempt - 1));
      log(`::warning::GitHub quota requeue transient failure (tentativo ${attempt}/${attempts}) → retry tra ${waitMs} ms.`);
      sleep(waitMs);
    }
  }

  throw lastError;
}

function validLabel(label) {
  return typeof label === 'string' && label.trim() !== '';
}

/** Build the one-transition `gh issue edit` command. Pure. */
export function requeueArguments({ issue, repo = '', addLabel, removeLabels = [] } = {}) {
  if (!/^[1-9][0-9]*$/.test(String(issue ?? ''))) {
    throw new Error(`issue non valida: ${issue}`);
  }
  if (!validLabel(addLabel)) throw new Error('label di coda mancante');
  if (!Array.isArray(removeLabels) || removeLabels.length === 0 || !removeLabels.every(validLabel)) {
    throw new Error('label da rimuovere mancanti');
  }

  const args = ['issue', 'edit', String(issue)];
  if (repo) args.push('--repo', String(repo));
  args.push('--add-label', addLabel);
  for (const label of removeLabels) args.push('--remove-label', label);
  return args;
}

/**
 * Re-queue one issue after lease denial. The label transition is deliberately
 * idempotent so a retry is safe even if the first GraphQL mutation committed
 * before its response was lost.
 */
export function requeueQuotaLease({
  issue,
  repo = '',
  addLabel,
  removeLabels = [],
  ghBin = 'gh',
  exec = execFileSync,
  ...retryOptions
} = {}) {
  const args = requeueArguments({ issue, repo, addLabel, removeLabels });
  return retryGitHubMutation(
    () => exec(ghBin, args, {
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    retryOptions,
  );
}

function parseArgs(argv) {
  const options = { removeLabels: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--remove-label') {
      options.removeLabels.push(argv[++index]);
    } else if (flag === '--issue') {
      options.issue = argv[++index];
    } else if (flag === '--repo') {
      options.repo = argv[++index];
    } else if (flag === '--add-label') {
      options.addLabel = argv[++index];
    } else if (flag === '--max-attempts') {
      options.maxAttempts = argv[++index];
    } else if (flag === '--retry-delay-ms') {
      options.retryDelayMs = argv[++index];
    } else if (flag === '--help') {
      options.help = true;
    } else {
      throw new Error(`argomento sconosciuto: ${flag}`);
    }
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      console.log('uso: requeue-quota-lease.mjs --issue N --repo owner/repo --add-label <label> --remove-label <label> [--remove-label <label>]');
      return 0;
    }
    requeueQuotaLease(options);
    console.log(`Quota requeue riuscito per issue #${options.issue}.`);
    return 0;
  } catch (error) {
    const detail = errorText(error).replace(/\s+/g, ' ').trim().slice(0, 240);
    console.error(`::error::Quota requeue fallito: ${detail}`);
    return 1;
  }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
