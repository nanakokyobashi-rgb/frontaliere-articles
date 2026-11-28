#!/usr/bin/env node
/**
 * Checkpoint validated pending translation drafts of every section outside a generation
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
import { SECTIONS, sectionWriteSurfaces } from '../lib/article-surfaces.mjs';

const CHECKPOINT_SCHEMA = 2;

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

/** `all` (o una lista separata da virgole) -> elenco di sezioni con superficie pending. */
export function resolveRecoverySections(spec) {
  if (typeof spec !== 'string' || !spec.trim()) throw new Error('section is required');
  const names = spec.trim() === 'all'
    ? Object.keys(SECTIONS).filter((name) => typeof SECTIONS[name]?.pendingTranslationDir === 'string')
    : [...new Set(spec.split(',').map((name) => name.trim()).filter(Boolean))];
  if (names.length === 0) throw new Error('no section with a pending translation surface');
  return names.sort();
}

/**
 * Cattura lo stato pending di TUTTE le sezioni indicate. Un run puo' tentare
 * piu' sezioni (target piu' sibling): la sezione che salva la bozza non e'
 * necessariamente quella riportata in output.
 */
export function capturePendingTranslationRecovery({ root = repositoryRoot(), section, checkpointPath }) {
  const checkpoint = assertCheckpointOutsideRepository(root, checkpointPath);
  const sections = {};
  let total = 0;
  for (const name of resolveRecoverySections(section)) {
    const { relative, absolute } = sectionDirectory(root, name);
    const drafts = listPendingTranslationDrafts(absolute, name);
    for (const draft of drafts) assertMissingFieldsMatch(draft);
    sections[name] = { pendingTranslationDir: relative, drafts };
    total += drafts.length;
  }

  writeJsonAtomic(checkpoint, { schema: CHECKPOINT_SCHEMA, sections });
  fs.chmodSync(checkpoint, 0o600);
  return total;
}

/**
 * Ripristina e mette in stage le bozze di ogni sezione catturata. Restituisce
 * il numero di path realmente in stage sotto le directory pending, cosi' il
 * chiamante apre un commit di recovery solo se qualcosa e' cambiato.
 */
export function restorePendingTranslationRecovery({ root = repositoryRoot(), section, checkpointPath }) {
  const checkpoint = assertCheckpointOutsideRepository(root, checkpointPath);
  const names = resolveRecoverySections(section);
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read pending translation checkpoint: ${error.message}`);
  }
  if (!snapshot || snapshot.schema !== CHECKPOINT_SCHEMA || !snapshot.sections
    || typeof snapshot.sections !== 'object' || Array.isArray(snapshot.sections)
    || JSON.stringify(Object.keys(snapshot.sections).sort()) !== JSON.stringify(names)) {
    throw new Error('pending translation checkpoint has an invalid schema or section set');
  }

  const plan = names.map((name) => {
    const { relative, absolute } = sectionDirectory(root, name);
    const entry = snapshot.sections[name];
    if (!entry || entry.pendingTranslationDir !== relative || !Array.isArray(entry.drafts)
      || entry.drafts.length > MAX_PENDING_TRANSLATION_DRAFTS_PER_SECTION) {
      throw new Error('pending translation checkpoint has an invalid path or draft count');
    }
    const drafts = entry.drafts.map((draft) => {
      const validated = normalizePendingTranslationDraft(draft, name);
      assertMissingFieldsMatch(validated);
      return validated;
    });
    if (new Set(drafts.map(({ articleId }) => articleId)).size !== drafts.length) {
      throw new Error('pending translation checkpoint has duplicate article identities');
    }
    return { name, relative, absolute, drafts };
  });

  for (const { name, relative, absolute, drafts } of plan) {
    fs.rmSync(absolute, { recursive: true, force: true });
    for (const draft of drafts) writePendingTranslationDraft(absolute, name, draft);
    const tracked = execFileSync('git', ['ls-files', '--', relative], { cwd: root, encoding: 'utf8' }).trim();
    // `git add -A` su un path assente sia dal disco sia dall'indice e' un errore.
    if (tracked || fs.existsSync(absolute)) {
      execFileSync('git', ['add', '-A', '--', relative], { cwd: root, stdio: 'ignore' });
    }
  }
  const staged = execFileSync(
    'git',
    ['diff', '--cached', '--name-only', '--', ...plan.map(({ relative }) => relative)],
    { cwd: root, encoding: 'utf8' },
  ).split('\n').filter(Boolean);
  return staged.length;
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
