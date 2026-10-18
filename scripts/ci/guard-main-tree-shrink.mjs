#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

export const MIN_BASE_PATHS = 1_000;
export const MAX_REMAINING_RATIO = 0.01;
export const MIN_REMAINING_PATHS = 10;

function expectedObjectIdLength(cwd) {
  const objectFormat = execFileSync('git', ['rev-parse', '--show-object-format'], {
    cwd,
    encoding: 'utf8',
  }).trim();
  if (objectFormat === 'sha1') return 40;
  if (objectFormat === 'sha256') return 64;
  throw new Error(`Unsupported Git object format: ${objectFormat}`);
}

export function evaluateTreeCounts(before, after) {
  if (!Number.isSafeInteger(before) || before < 0 || !Number.isSafeInteger(after) || after < 0) {
    throw new TypeError('Tree counts must be non-negative safe integers');
  }

  const remainingLimit = Math.max(MIN_REMAINING_PATHS, Math.floor(before * MAX_REMAINING_RATIO));
  const suspicious = before >= MIN_BASE_PATHS && after < before && after <= remainingLimit;
  return {
    before,
    after,
    removed: Math.max(0, before - after),
    remainingLimit,
    suspicious,
  };
}

export function countTrackedPaths(revision, cwd = process.cwd()) {
  const expectedLength = expectedObjectIdLength(cwd);
  if (typeof revision !== 'string' || revision.length !== expectedLength || !/^[0-9a-f]+$/i.test(revision)) {
    throw new TypeError(`Expected a full ${expectedLength}-character Git object ID, received: ${revision}`);
  }
  const output = execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', revision], {
    cwd,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  let count = 0;
  for (const byte of output) if (byte === 0) count++;
  return count;
}

function namedHexReference(reference, cwd) {
  for (const prefix of ['refs/heads', 'refs/tags']) {
    const candidate = `${prefix}/${reference}`;
    try {
      execFileSync('git', ['show-ref', '--verify', '--quiet', candidate], { cwd, stdio: 'ignore' });
      return candidate;
    } catch {
      // Keep checking the other explicit ref namespace.
    }
  }
  return null;
}

export function resolveCommitRevision(reference, cwd = process.cwd()) {
  const expectedLength = expectedObjectIdLength(cwd);
  let revisionReference = reference;
  if (/^[0-9a-f]+$/i.test(reference) && reference.length !== expectedLength) {
    revisionReference = namedHexReference(reference, cwd);
    if (!revisionReference) {
      throw new TypeError(`Expected a full ${expectedLength}-character Git object ID or a named ref, received: ${reference}`);
    }
  }
  const resolved = execFileSync('git', [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${revisionReference}^{commit}`,
  ], { cwd, encoding: 'utf8' }).trim();
  if (resolved.length !== expectedLength || !/^[0-9a-f]+$/i.test(resolved)) {
    throw new TypeError(`Expected a commit reference resolving to a full ${expectedLength}-character Git object ID, received: ${reference}`);
  }
  return resolved;
}

export function guardTreeShrink(beforeRevision, afterRevision, cwd = process.cwd()) {
  const before = countTrackedPaths(beforeRevision, cwd);
  const after = countTrackedPaths(afterRevision, cwd);
  return evaluateTreeCounts(before, after);
}

function main(args) {
  if (args.length !== 4 || args[0] !== '--before' || args[2] !== '--after') {
    console.error('Usage: guard-main-tree-shrink.mjs --before <ref-or-object-id> --after <ref-or-object-id>');
    return 2;
  }

  try {
    const before = resolveCommitRevision(args[1]);
    const after = resolveCommitRevision(args[3]);
    const result = guardTreeShrink(before, after);
    const summary = `main tree paths: ${result.before} → ${result.after} (removed ${result.removed})`;
    if (result.suspicious) {
      console.error(`::error::Possible catastrophic main tree shrink: ${summary}; threshold leaves at most ${result.remainingLimit} paths.`);
      return 1;
    }
    console.log(`tree-shrink guard: ${summary}`);
    return 0;
  } catch (error) {
    console.error(`::error::Unable to verify main tree size: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1]?.endsWith('/guard-main-tree-shrink.mjs')) {
  process.exitCode = main(process.argv.slice(2));
}
