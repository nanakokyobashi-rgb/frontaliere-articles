#!/usr/bin/env node
/**
 * Hook `pre-commit` dei fixer: un commit che contiene un gemello `identical`
 * viene rifiutato prima che l'agente lo pusha.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { identicalPaths } from './lib/identical-paths.mjs';

export const IDENTICAL_COMMIT_MESSAGE = 'file identical: si corregge nel sito, il rilievo è stato instradato';

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
export function stagedPaths({ cwd = process.cwd(), git = execFileSync } = {}) {
  const output = git('git', ['diff', '--cached', '--name-only', '-z'], {
    cwd,
    encoding: 'utf8',
  });
  return String(output || '').split('\0').filter(Boolean);
}

export function checkStagedPaths({ manifest, paths }) {
  const locked = identicalPaths(manifest);
  return [...new Set((paths || []).filter((rel) => locked.has(rel)))];
}

export function preCommitHook({ nodePath = process.execPath, scriptPath, manifestPath }) {
  if (!scriptPath || !manifestPath) throw new Error('scriptPath e manifestPath sono obbligatori');
  return [
    '#!/bin/sh',
    '# Installato dal fixer-identical-hook trusted da main.',
    `exec ${shellQuote(nodePath)} ${shellQuote(scriptPath)} check --manifest ${shellQuote(manifestPath)}`,
    '',
  ].join('\n');
}

export function installIdenticalCommitHook({ cwd = process.cwd(), manifestPath, scriptPath = fileURLToPath(import.meta.url) } = {}) {
  if (!manifestPath) throw new Error('manifestPath obbligatorio');
  const hooksDir = path.resolve(cwd, execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
    cwd,
    encoding: 'utf8',
  }).trim());
  fs.mkdirSync(hooksDir, { recursive: true });
  const hook = path.join(hooksDir, 'pre-commit');
  fs.writeFileSync(hook, preCommitHook({ scriptPath, manifestPath }), { mode: 0o755 });
  fs.chmodSync(hook, 0o755);
  return { hook, manifestPath, scriptPath };
}

function runCheck(manifestPath, cwd = process.cwd()) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const locked = checkStagedPaths({ manifest, paths: stagedPaths({ cwd }) });
  if (locked.length === 0) return 0;
  console.error(`${IDENTICAL_COMMIT_MESSAGE}: ${locked.join(', ')}`);
  return 1;
}

if (process.argv[1] && process.argv[1].endsWith('fixer-identical-hook.mjs')) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'install') {
      const manifestPath = args[0];
      const result = installIdenticalCommitHook({ manifestPath });
      console.log(`hook pre-commit installato (${result.hook})`);
    } else if (command === 'check') {
      const manifestIndex = args.indexOf('--manifest');
      const manifestPath = manifestIndex >= 0 ? args[manifestIndex + 1] : '';
      if (!manifestPath) throw new Error('uso: fixer-identical-hook.mjs check --manifest <path>');
      process.exitCode = runCheck(manifestPath);
    } else {
      throw new Error('uso: fixer-identical-hook.mjs install <manifest> | check --manifest <path>');
    }
  } catch (error) {
    console.error(`fixer-identical-hook: ${error?.message || error}`);
    process.exitCode = 1;
  }
}
