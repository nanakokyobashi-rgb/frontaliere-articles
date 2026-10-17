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

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const BLOG_BODY_ROOT = 'content/blog-body';
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

function localeForFile(root, file) {
  const relative = path.relative(path.join(root, BLOG_BODY_ROOT), file);
  const [locale] = relative.split(path.sep);
  return LOCALES.has(locale) ? locale : null;
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

export function scanBlogBodyLinks(root = ROOT) {
  const bodyRoot = path.join(root, BLOG_BODY_ROOT);
  const files = collectTypeScriptFiles(bodyRoot);
  const offenders = [];
  for (const file of files) {
    const locale = localeForFile(root, file);
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
    error(`nessun body TypeScript trovato sotto ${BLOG_BODY_ROOT}: gate non eseguito`);
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
