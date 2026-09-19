#!/usr/bin/env node
/**
 * fixer-commit-trailer.mjs — il trailer `Fixer: <kind>-round-<N>` sui commit
 * dei fixer di PR (`pr-redflag-fixer.yml`, `pr-redcheck-fixer.yml`).
 *
 * Il round era visibile solo nel marker di commento `<!-- ..._FIX_ROUND: N -->`,
 * cioe' sulla PR e non nella storia: un commit del fixer era indistinguibile da
 * uno umano, e misurare quanti fix automatici atterrano (o quanti round servono)
 * chiedeva di incrociare commenti e timestamp. Il trailer lo mette nel commit.
 *
 * Il commit lo fa l'agente, non uno step `run:`: per non dipendere dal prompt
 * il trailer lo aggiunge un hook `commit-msg` installato nel checkout prima
 * dell'agente. `git interpret-trailers --if-exists addIfDifferent` lo rende
 * idempotente (un `--amend` non lo duplica).
 *
 * Formato UNICO per i due workflow e allineato al sito:
 *   Fixer: redflag-round-N   /   Fixer: redcheck-round-N
 *
 * Uso: node scripts/ci/fixer-commit-trailer.mjs install <redflag|redcheck> <round>
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const FIXER_KINDS = Object.freeze(['redflag', 'redcheck']);
export const FIXER_TRAILER_KEY = 'Fixer';

/** `Fixer: <kind>-round-<N>`. Lancia su input non valido: niente trailer finto. */
export function fixerTrailer(kind, round) {
  if (!FIXER_KINDS.includes(kind)) throw new Error(`kind fixer non valido: ${kind}`);
  const n = Number(round);
  if (!Number.isSafeInteger(n) || n < 1 || String(round) !== String(n)) {
    throw new Error(`round fixer non valido: ${round}`);
  }
  return `${FIXER_TRAILER_KEY}: ${kind}-round-${n}`;
}

/** Corpo dell'hook `commit-msg`. Puro. */
export function commitMsgHook(trailer) {
  const quoted = `'${trailer.replace(/'/g, `'\\''`)}'`;
  return [
    '#!/bin/sh',
    '# Installato da scripts/ci/fixer-commit-trailer.mjs: marca il commit del fixer.',
    `exec git interpret-trailers --in-place --if-exists addIfDifferent --trailer ${quoted} "$1"`,
    '',
  ].join('\n');
}

/** Scrive l'hook nel repository `cwd`; ritorna il path. */
export function installCommitMsgHook(kind, round, { cwd = process.cwd() } = {}) {
  const trailer = fixerTrailer(kind, round);
  const hooksDir = path.resolve(cwd, execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
    cwd, encoding: 'utf8',
  }).trim());
  fs.mkdirSync(hooksDir, { recursive: true });
  const hook = path.join(hooksDir, 'commit-msg');
  fs.writeFileSync(hook, commitMsgHook(trailer), { mode: 0o755 });
  fs.chmodSync(hook, 0o755);
  return { hook, trailer };
}

if (process.argv[1] && process.argv[1].endsWith('fixer-commit-trailer.mjs')) {
  const [cmd, kind, round] = process.argv.slice(2);
  if (cmd !== 'install') {
    console.error('uso: fixer-commit-trailer.mjs install <redflag|redcheck> <round>');
    process.exit(2);
  }
  const { hook, trailer } = installCommitMsgHook(kind, round);
  console.log(`hook commit-msg installato (${hook}): ogni commit porta «${trailer}».`);
}
