#!/usr/bin/env node
/**
 * check-blog-body-links.mjs — publication gate for Markdown destinations in
 * the historical frontaliere article corpus.
 *
 * A TypeScript body can parse perfectly while `[label](bare-action)` still
 * becomes `/article-slug/bare-action/` in the browser. This gate checks the
 * source contract before the API is published; it deliberately scans the
 * whole standard body tree rather than trusting a changed-file list.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findNonCanonicalArticleLinks } from '../lib/article-link-contract.mjs';
import { activeSourceSections, configureCorpusActiveSections } from '../lib/corpus-sections.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
configureCorpusActiveSections();
export const BLOG_BODY_ROOTS = Object.freeze(activeSourceSections().map(({ bodyDir }) => bodyDir));
const LOCALES = new Set(['it', 'en', 'de', 'fr']);

function collectTypeScriptFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectTypeScriptFiles(fullPath));
    else if (entry.isFile() && fullPath.endsWith('.ts')) files.push(fullPath);
  }
  return files.sort();
}

function localeForFile(bodyRoot, file) {
  const relative = path.relative(bodyRoot, file);
  const [locale] = relative.split(path.sep);
  return LOCALES.has(locale) ? locale : null;
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

export function scanBlogBodyLinks(root = ROOT) {
  const bodyRoots = BLOG_BODY_ROOTS.map((directory) => path.join(root, directory));
  const entries = bodyRoots.flatMap((bodyRoot) =>
    collectTypeScriptFiles(bodyRoot).map((file) => ({ bodyRoot, file })));
  const files = entries.map(({ file }) => file);
  const offenders = [];
  for (const { bodyRoot, file } of entries) {
    const locale = localeForFile(bodyRoot, file);
    if (!locale) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const offender of findNonCanonicalArticleLinks(source, locale)) {
      offenders.push({
        file: path.relative(root, file).split(path.sep).join('/'),
        line: lineOf(source, offender.index),
        ...offender,
      });
    }
  }
  return { files, offenders };
}

export function formatOffender(offender) {
  const replacement = offender.replacement
    ? ` → ${offender.replacement}`
    : ' → plain text';
  return `${offender.file}:${offender.line}: [${offender.label}](${offender.target})${replacement}`;
}

export function run({ root = ROOT, log = console.log, error = console.error } = {}) {
  const { files, offenders } = scanBlogBodyLinks(root);
  if (files.length === 0) {
    error(`nessun body TypeScript trovato sotto ${BLOG_BODY_ROOTS.join(', ')}: gate non eseguito`);
    return 1;
  }
  if (offenders.length > 0) {
    error(`link Markdown non canonici: ${offenders.length}`);
    for (const offender of offenders) error(formatOffender(offender));
    return 1;
  }
  log(`link Markdown verificati: ${files.length} body, zero destinazioni non canoniche`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run();
}
