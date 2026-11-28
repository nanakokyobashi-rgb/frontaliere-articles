#!/usr/bin/env node
/**
 * Checkpoint validated pending translation drafts outside a generation
 * worktree before CI discards failed-run changes, then restore and stage only
 * those drafts. The checkpoint lives under RUNNER_TEMP, so `git reset --hard`
 * and `git clean -fd` cannot erase the consumed attempt or its verified IT.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { writeJsonAtomic } from '../../generator/scripts/lib/atomic-write-json.mjs';
import {
  listPendingTranslationDrafts,
  missingPendingTranslationFields,
  normalizePendingTranslationDraft,
  writePendingTranslationDraft,
  MAX_PENDING_TRANSLATION_DRAFTS_PER_SECTION,
} from '../../generator/scripts/lib/pending-article-translations.mjs';
import { sectionWriteSurfaces } from '../lib/article-surfaces.mjs';

const CHECKPOINT_SCHEMA = 1;

function repositoryRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

function assertCheckpointOutsideRepository(root, checkpointPath) {
  if (typeof checkpointPath !== 'string' || !path.isAbsolute(checkpointPath)) {
    throw new Error('pending translation checkpoint path must be absolute');
  }
  const target = path.resolve(checkpointPath);
  const relative = path.relative(root, target);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('pending translation checkpoint must be outside the repository checkout');
  }
  return target;
}

function sectionDirectory(root, section) {
  if (typeof section !== 'string' || !section.trim()) throw new Error('section is required');
  const relative = sectionWriteSurfaces(section).pendingTranslationDir;
  if (typeof relative !== 'string' || !relative) {
    throw new Error(`section '${section}' has no pending translation surface`);
  }
  const directory = path.resolve(root, relative);
  const withinRoot = path.relative(root, directory);
  if (withinRoot === '' || withinRoot.startsWith(`..${path.sep}`) || withinRoot === '..' || path.isAbsolute(withinRoot)) {
    throw new Error(`section '${section}' has an unsafe pending translation path`);
  }
  return { relative, absolute: directory };
}

function assertMissingFieldsMatch(draft) {
  const actual = missingPendingTranslationFields(draft.data).sort();
  const stored = [...draft.missingFields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(stored)) {
    throw new Error(`pending translation fields do not match the saved article for ${draft.articleId}`);
  }
}

export function capturePendingTranslationRecovery({ root = repositoryRoot(), section, checkpointPath }) {
  const checkpoint = assertCheckpointOutsideRepository(root, checkpointPath);
  const { relative, absolute } = sectionDirectory(root, section);
  const drafts = listPendingTranslationDrafts(absolute, section);
  for (const draft of drafts) assertMissingFieldsMatch(draft);

  writeJsonAtomic(checkpoint, {
    schema: CHECKPOINT_SCHEMA,
    section,
    pendingTranslationDir: relative,
    drafts,
  });
  fs.chmodSync(checkpoint, 0o600);
  return drafts.length;
}

export function restorePendingTranslationRecovery({ root = repositoryRoot(), section, checkpointPath }) {
  const checkpoint = assertCheckpointOutsideRepository(root, checkpointPath);
  const { relative, absolute } = sectionDirectory(root, section);
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read pending translation checkpoint: ${error.message}`);
  }
  if (!snapshot || snapshot.schema !== CHECKPOINT_SCHEMA || snapshot.section !== section
    || snapshot.pendingTranslationDir !== relative || !Array.isArray(snapshot.drafts)
    || snapshot.drafts.length > MAX_PENDING_TRANSLATION_DRAFTS_PER_SECTION) {
    throw new Error('pending translation checkpoint has an invalid schema, section, path, or draft count');
  }

  const drafts = snapshot.drafts.map((draft) => {
    const validated = normalizePendingTranslationDraft(draft, section);
    assertMissingFieldsMatch(validated);
    return validated;
  });
  const ids = new Set(drafts.map(({ articleId }) => articleId));
  if (ids.size !== drafts.length) throw new Error('pending translation checkpoint has duplicate article identities');

  fs.rmSync(absolute, { recursive: true, force: true });
  for (const draft of drafts) writePendingTranslationDraft(absolute, section, draft);
  execFileSync('git', ['add', '-A', '--', relative], { cwd: root, stdio: 'ignore' });
  return drafts.length;
}

function main() {
  const [mode, section, checkpointPath] = process.argv.slice(2);
  if (mode === 'capture') {
    process.stdout.write(`${capturePendingTranslationRecovery({ section, checkpointPath })}\n`);
    return;
  }
  if (mode === 'restore') {
    process.stdout.write(`${restorePendingTranslationRecovery({ section, checkpointPath })}\n`);
    return;
  }
  throw new Error('usage: pending-translation-recovery.mjs <capture|restore> <section> <absolute-checkpoint-path>');
}

function isMain() {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    main();
  } catch (error) {
    console.error(`::error::pending-translation-recovery: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
