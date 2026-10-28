#!/usr/bin/env node
/**
 * Upload the CDN assets emitted by a fast-publish summary.
 *
 * The single-file uploader deliberately owns one image-namespace lease for
 * each PUT. That is the right boundary for independent publishers, but a
 * fast-publish of a shared renderer can contain thousands of existing images:
 * invoking it serially makes the workflow spend hours reacquiring the same
 * lease and eventually hit its job timeout.
 *
 * This batch runner acquires one lease per image namespace, passes that
 * verified context to bounded concurrent workers, and releases it only after
 * every worker has stopped. Non-image keys retain the single-file uploader's
 * existing path; if an image namespace cannot be leased once, its whole batch
 * is skipped best-effort rather than repeating the same 15-minute acquisition
 * timeout for every asset.
 * The uploader still owns the per-object timeout, retry, content type and
 * best-effort failure policy; this file only supplies the batch boundary.
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';

import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import {
  IMAGE_LEASE_CONTEXT_ENV,
  imageNamespaceForKey,
  serializeImageLeaseContext,
} from '../lib/r2-image-namespace-lock.mjs';

export const DEFAULT_UPLOAD_CONCURRENCY = 8;
export const MAX_UPLOAD_CONCURRENCY = 32;

const UPLOADER = 'scripts/lib/upload-cdn-file.sh';
const LEASE_CLI = 'scripts/lib/r2-image-namespace-lock.mjs';

function usage(message) {
  if (message) process.stderr.write(`::error::${message}\n`);
  process.stderr.write('Usage: upload-cdn-batch.mjs <fast-publish-summary.json>\n');
  process.exitCode = 2;
}

export function resolveUploadConcurrency(raw = process.env.FRONTALIERE_CDN_UPLOAD_CONCURRENCY) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_UPLOAD_CONCURRENCY;
  if (!/^[1-9]\d*$/u.test(String(raw))) {
    throw new Error(`FRONTALIERE_CDN_UPLOAD_CONCURRENCY must be a positive integer no larger than ${MAX_UPLOAD_CONCURRENCY}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > MAX_UPLOAD_CONCURRENCY) {
    throw new Error(`FRONTALIERE_CDN_UPLOAD_CONCURRENCY must be a positive integer no larger than ${MAX_UPLOAD_CONCURRENCY}`);
  }
  return value;
}

function requiredUploadString(value, label, index) {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000\r\n]/u.test(value)) {
    throw new Error(`cdnUploads[${index}].${label} must be a non-empty string without NUL/newline`);
  }
  return value;
}

export function uploadEntriesFromSummary(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary) || !Array.isArray(summary.cdnUploads)) {
    throw new Error('fast-publish summary must contain a cdnUploads array');
  }
  return summary.cdnUploads.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`cdnUploads[${index}] must be an object`);
    }
    return {
      local: requiredUploadString(entry.local, 'local', index),
      key: requiredUploadString(entry.key, 'key', index),
    };
  });
}

export function readUploadEntries(summaryPath) {
  let summary;
  try {
    summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read fast-publish summary ${summaryPath}: ${error?.message ?? error}`);
  }
  return uploadEntriesFromSummary(summary);
}

/** Run independent entries without ever exceeding the configured worker cap. */
export async function runUploadPool(entries, concurrency, run, { shouldStop = () => false } = {}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error('upload pool concurrency must be a positive integer');
  }
  let cursor = 0;
  const results = new Array(entries.length);
  const worker = async () => {
    while (!shouldStop()) {
      const index = cursor;
      cursor += 1;
      if (index >= entries.length) return;
      try {
        results[index] = await run(entries[index], index);
      } catch (error) {
        results[index] = { code: 1, error };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, entries.length)) }, () => worker()),
  );
  return results;
}

function terminateChild(child, signal) {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process may have exited between the close and the group signal.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The close event still settles the tracked command.
  }
}

function statusFromClose(status, signal) {
  if (typeof status === 'number') return status;
  const signalNumbers = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
  return signal && signalNumbers[signal] ? 128 + signalNumbers[signal] : 1;
}

function createChildRunner(activeChildren) {
  return function runChild(command, args, { env = process.env, capture = false } = {}) {
    return new Promise((resolve) => {
      let child;
      let settled = false;
      let stdout = '';
      let stderr = '';
      const finish = (result) => {
        if (settled) return;
        settled = true;
        activeChildren.delete(child);
        resolve(result);
      };
      try {
        child = spawn(command, args, {
          detached: process.platform !== 'win32',
          env,
          stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        });
      } catch (error) {
        finish({ code: 127, error, stdout, stderr });
        return;
      }
      activeChildren.add(child);
      if (capture) {
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
      }
      child.once('error', (error) => finish({ code: 127, error, stdout, stderr }));
      child.once('close', (status, signal) => finish({
        code: statusFromClose(status, signal),
        signal,
        stdout,
        stderr,
      }));
    });
  };
}

function installSignalHandlers(activeChildren) {
  let requestedExitCode = 0;
  const signals = new Map([
    ['SIGHUP', 129],
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ]);
  const handlers = new Map();
  for (const [signal, code] of signals) {
    const handler = () => {
      if (requestedExitCode === 0) requestedExitCode = code;
      for (const child of activeChildren) terminateChild(child, signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return {
    shouldStop: () => requestedExitCode !== 0,
    requestedExitCode: () => requestedExitCode,
    remove: () => {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    },
  };
}

function leaseContextFromAcquire(result, namespace) {
  if (result.code !== 0) return null;
  try {
    const lines = String(result.stdout ?? '').trim().split(/\r?\n/u).filter(Boolean);
    const parsed = JSON.parse(lines.at(-1) ?? '');
    return serializeImageLeaseContext(parsed.leases);
  } catch (error) {
    throw new Error(`acquire ${namespace} returned an invalid lease context: ${error?.message ?? error}`);
  }
}

async function acquireNamespaceLease(namespace, runChild, shouldStop) {
  if (shouldStop()) return null;
  const result = await runChild(process.execPath, [LEASE_CLI, 'acquire', '--namespace', namespace], { capture: true });
  if (result.code !== 0) {
    const detail = String(result.stderr ?? '').replace(/\s+/gu, ' ').trim().slice(0, 300);
    process.stderr.write(`::warning::[cdn-upload] shared ${namespace} lease unavailable; falling back to per-file leases${detail ? `: ${detail}` : ''}\n`);
    return null;
  }
  return leaseContextFromAcquire(result, namespace);
}

async function releaseNamespaceLease(namespace, context, runChild) {
  const result = await runChild(process.execPath, [
    LEASE_CLI,
    'release',
    '--context',
    context,
  ]);
  if (result.code !== 0) {
    process.stderr.write(`::error::[cdn-upload] shared ${namespace} lease release failed (exit ${result.code})\n`);
    return false;
  }
  return true;
}

async function main() {
  if (process.argv.length !== 3) {
    usage('the fast-publish summary path is required');
    return;
  }

  const entries = readUploadEntries(process.argv[2]);
  if (entries.length === 0) {
    process.stdout.write('[cdn-upload] no CDN assets to upload\n');
    return;
  }
  const concurrency = resolveUploadConcurrency();
  const activeChildren = new Set();
  const runChild = createChildRunner(activeChildren);
  const signals = installSignalHandlers(activeChildren);
  const contexts = new Map();
  const unavailableNamespaces = new Set();
  let failures = 0;

  try {
    // The single-file helper installs rclone lazily. Warm it once before
    // starting workers so they cannot race while creating rclone-bin/rclone.
    const warmup = await runChild('bash', [UPLOADER, '--check', entries[0].key]);
    if (warmup.code !== 0 && !signals.shouldStop()) {
      process.stderr.write(`::warning::[cdn-upload] rclone warmup exited ${warmup.code}; workers will retain the helper fallback\n`);
    }

    const namespaces = [...new Set(entries.map(({ key }) => imageNamespaceForKey(key)).filter(Boolean))];
    for (const namespace of namespaces) {
      if (signals.shouldStop()) break;
      try {
        const context = await acquireNamespaceLease(namespace, runChild, signals.shouldStop);
        if (context) contexts.set(namespace, context);
        else if (!signals.shouldStop()) unavailableNamespaces.add(namespace);
      } catch (error) {
        process.stderr.write(`::warning::[cdn-upload] shared ${namespace} lease setup failed; skipping that image batch: ${error?.message ?? error}\n`);
        unavailableNamespaces.add(namespace);
      }
    }
    for (const namespace of unavailableNamespaces) {
      process.stderr.write(`::notice::[cdn-upload] skipping ${namespace} image batch: namespace lease unavailable\n`);
    }

    const results = await runUploadPool(
      entries,
      concurrency,
      async ({ local, key }) => {
        const namespace = imageNamespaceForKey(key);
        if (namespace && unavailableNamespaces.has(namespace)) return { code: 0, skipped: true };
        const env = { ...process.env };
        const context = contexts.get(namespace);
        if (context) env[IMAGE_LEASE_CONTEXT_ENV] = context;
        return runChild('bash', [UPLOADER, local, key], { env });
      },
      { shouldStop: signals.shouldStop },
    );
    failures += results.filter((result) => result && result.code !== 0).length;
  } finally {
    for (const [namespace, context] of contexts) {
      if (!await releaseNamespaceLease(namespace, context, runChild)) failures += 1;
    }
    signals.remove();
  }

  if (signals.requestedExitCode()) {
    process.exitCode = signals.requestedExitCode();
  } else if (failures > 0) {
    process.stderr.write(`::error::[cdn-upload] ${failures} CDN worker(s) failed to start or exit unexpectedly\n`);
    process.exitCode = 1;
  }
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`::error::[cdn-upload] ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
