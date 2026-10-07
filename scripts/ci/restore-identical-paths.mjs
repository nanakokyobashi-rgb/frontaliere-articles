#!/usr/bin/env node
/**
 * Ripristino deterministico dei gemelli `identical` toccati da un round.
 *
 * Il ripristino usa il ref precedente al round e crea, quando serve, un
 * commit aggiuntivo senza force-push. I path non `identical` restano intatti.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { partitionPaths } from './lib/identical-paths.mjs';

function runGit(cwd, args, options = {}) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

function names(output) {
  return [...new Set(String(output || '').split(/\0|\r?\n/u).filter(Boolean))];
}

function pathExistsAt(cwd, ref, rel) {
  try {
    runGit(cwd, ['cat-file', '-e', `${ref}:${rel}`]);
    return true;
  } catch {
    return false;
  }
}

export function touchedPaths({ cwd = process.cwd(), baseRef, includeWorkingTree = false } = {}) {
  if (!baseRef) throw new Error('baseRef obbligatorio');
  const committed = names(runGit(cwd, ['diff', '--name-only', `${baseRef}..HEAD`])).sort();
  if (!includeWorkingTree) return { committed, working: [], all: committed };
  const working = names(runGit(cwd, ['diff', '--name-only']));
  const cached = names(runGit(cwd, ['diff', '--cached', '--name-only']));
  const all = [...new Set([...committed, ...working, ...cached])].sort();
  return { committed, working: [...new Set([...working, ...cached])].sort(), all };
}

/**
 * Ripristina e, se un commit del round aveva scritto un `identical`, committa
 * il revert. La funzione ritorna il testo del commento per il workflow.
 */
export function restoreIdenticalPaths({
  cwd = process.cwd(),
  baseRef,
  manifest,
  includeWorkingTree = false,
  commitMessage = 'fix(ci): ripristina i gemelli identical dopo il fixer',
} = {}) {
  const touched = touchedPaths({ cwd, baseRef, includeWorkingTree });
  const partition = partitionPaths(manifest, touched.all);
  const restored = partition.readOnly;
  if (restored.length === 0) {
    return {
      ...touched,
      writable: partition.writable,
      restored: [],
      committedReadOnly: [],
      commitSha: '',
      comment: '',
    };
  }

  for (const rel of restored) {
    if (pathExistsAt(cwd, baseRef, rel)) {
      runGit(cwd, ['restore', '--source', baseRef, '--staged', '--worktree', '--', rel]);
    } else {
      runGit(cwd, ['rm', '--force', '--ignore-unmatch', '--', rel]);
    }
  }

  const committedReadOnly = touched.committed.filter((rel) => restored.includes(rel));
  let commitSha = '';
  if (committedReadOnly.length) {
    let stagedReadOnly = true;
    try {
      runGit(cwd, ['diff', '--cached', '--quiet', '--', ...committedReadOnly]);
      stagedReadOnly = false;
    } catch {
      stagedReadOnly = true;
    }
    if (stagedReadOnly) {
      // This commit is the deterministic barrier's own repair. It must not be
      // blocked by the very hook that prevents the agent from creating it. The
      // explicit path list is important: an agent may have other staged work
      // in the same interval, and the repair must never absorb it.
      runGit(cwd, ['commit', '--no-verify', '--only', '-m', commitMessage, '--', ...committedReadOnly]);
      commitSha = runGit(cwd, ['rev-parse', 'HEAD']).trim();
    }
  }

  const comment = [
    '🛡️ **Fixer identical ripristinato**',
    '',
    'Il round ha toccato un file `mode: identical`: la modifica è stata riportata alla versione precedente al round.',
    '',
    ...restored.map((rel) => '- `' + rel + '`'),
    '',
    'Telemetria: `' + restored.length + '` path identical ripristinati; i path non identical restano invariati.',
  ].join('\n');
  return {
    ...touched,
    writable: partition.writable,
    restored,
    committedReadOnly,
    commitSha,
    comment,
  };
}

function parseArgs(argv) {
  const out = { includeWorkingTree: false, commitMessage: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base-ref') out.baseRef = argv[++i];
    else if (arg === '--manifest') out.manifestPath = argv[++i];
    else if (arg === '--include-working-tree') out.includeWorkingTree = true;
    else if (arg === '--commit-message') out.commitMessage = argv[++i];
    else if (arg === '--json') out.json = true;
    else throw new Error(`argomento sconosciuto: ${arg}`);
  }
  if (!out.baseRef || !out.manifestPath) throw new Error('uso: restore-identical-paths.mjs --base-ref <ref> --manifest <path> [--include-working-tree] [--json]');
  return out;
}

if (process.argv[1] && process.argv[1].endsWith('restore-identical-paths.mjs')) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = restoreIdenticalPaths({
      baseRef: args.baseRef,
      manifest: JSON.parse(fs.readFileSync(args.manifestPath, 'utf8')),
      includeWorkingTree: args.includeWorkingTree,
      commitMessage: args.commitMessage,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(`restore-identical-paths: ${error?.message || error}`);
    process.exitCode = 1;
  }
}
