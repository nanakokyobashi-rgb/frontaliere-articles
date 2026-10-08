#!/usr/bin/env node

/**
 * Deterministic historical repair for reader-facing excerpts and their
 * duplicated IT SEO descriptions.  It never regenerates an article and never
 * calls a model: Markdown/labels are stripped and the first useful sentence
 * is retained.
 *
 * Usage:
 *   node scripts/repair-plain-excerpts.mjs          # report only
 *   node scripts/repair-plain-excerpts.mjs --write  # apply the repair
 */

import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertPlainExcerpt,
  findExcerptMarkdownDefects,
  normalizeExcerpt,
} from './lib/article-excerpt.mjs';
import {
  escapeForSingleQuoteTS,
  unescapeForSingleQuoteTS,
} from './lib/article-meta-block.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const writeMode = process.argv.includes('--write');

function decodeDoubleQuotedTS(value) {
  return value.replace(/\\([\\"nrt])/g, (_, c) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c));
}

function atomicWrite(file, value) {
  const tmp = `${file}.${process.pid}.excerpt-repair.tmp`;
  writeFileSync(tmp, value, 'utf8');
  renameSync(tmp, file);
}

function sectionForMeta(file) {
  if (file.startsWith('blog-meta-canton-')) return 'cantonale';
  if (file.startsWith('blog-meta-ch-')) return 'svizzera';
  return 'frontaliere';
}

function localeForMeta(file) {
  return file.match(/-(it|en|de|fr)\.ts$/)?.[1] ?? 'unknown';
}

function repairValue(value, context) {
  const defects = findExcerptMarkdownDefects(value);
  if (defects.length === 0) return { value, changed: false, defects: [] };
  const repaired = normalizeExcerpt(value);
  assertPlainExcerpt(repaired, context);
  return { value: repaired, changed: repaired !== value, defects };
}

function repairMetaFile(relativeFile) {
  const file = path.join(repoRoot, relativeFile);
  const before = readFileSync(file, 'utf8');
  let after = before;
  let changed = 0;
  const details = [];
  const section = sectionForMeta(path.basename(relativeFile));
  const locale = localeForMeta(path.basename(relativeFile));
  // The field name is inside the quoted object key: `...excerpt': '...`.
  // Keeping the closing quote in the match is essential; without it this
  // historical repair scans zero values and can report a false green.
  const re = /(^[ \t]*'blog\.article\.([^']+)\.(excerpt|seoDescription|ogDescription)'\s*:\s*')((?:[^'\\]|\\.)*)(')/gm;
  after = after.replace(re, (full, prefix, id, field, encoded, suffix) => {
    const value = unescapeForSingleQuoteTS(encoded);
    const result = repairValue(value, { field, id, locale });
    if (!result.changed) return full;
    changed += 1;
    details.push({ section, locale, id, field, defects: result.defects });
    return `${prefix}${escapeForSingleQuoteTS(result.value)}${suffix}`;
  });
  if (after !== before && writeMode) atomicWrite(file, after);
  return { file: relativeFile, changed, details };
}

function repairSeoFile(relativeFile) {
  const file = path.join(repoRoot, relativeFile);
  const before = readFileSync(file, 'utf8');
  let after = before;
  let changed = 0;
  const details = [];
  const section = relativeFile.startsWith('content/cantons/')
    ? 'cantonale'
    : path.basename(relativeFile).includes('-ch') ? 'svizzera' : 'frontaliere';

  const entries = [...before.matchAll(/^[ \t]*'blog-([^']+)':\s*\{/gm)];
  const entryForOffset = (currentEntries, offset) => {
    let current = currentEntries[0]?.[1] ?? 'unknown';
    for (const entry of currentEntries) {
      if (entry.index > offset) break;
      current = entry[1];
    }
    return current;
  };
  const repair = (value, id, field) => {
    const result = repairValue(value, { field, id, locale: 'it' });
    if (result.changed) {
      changed += 1;
      details.push({ section, locale: 'it', id, field, defects: result.defects });
    }
    return result;
  };

  after = after.replace(/(^[ \t]*)(description|ogDescription)(:\s*')((?:[^'\\]|\\.)*)(')/gm, (full, indent, field, prefix, encoded, suffix, offset) => {
    const id = entryForOffset(entries, offset);
    const result = repair(unescapeForSingleQuoteTS(encoded), id, field);
    if (!result.changed) return full;
    return `${indent}${field}${prefix}${escapeForSingleQuoteTS(result.value)}${suffix}`;
  });

  const structuredEntries = [...after.matchAll(/^[ \t]*'blog-([^']+)':\s*\{/gm)];
  after = after.replace(/(^[ \t]*)"description"(\s*:\s*")((?:[^"\\]|\\.)*)(")/gm, (full, indent, prefix, encoded, suffix, offset) => {
    const id = entryForOffset(structuredEntries, offset);
    const result = repair(decodeDoubleQuotedTS(encoded), id, 'structuredData.description');
    if (!result.changed) return full;
    return `${indent}"description"${prefix}${JSON.stringify(result.value).slice(1, -1)}${suffix}`;
  });

  if (after !== before && writeMode) atomicWrite(file, after);
  return { file: relativeFile, changed, details };
}

const contentDir = path.join(repoRoot, 'content');
const allMetaFiles = readdirSync(contentDir)
  .filter((name) => /^blog-meta-(?:canton-.+|ch-)?(?:it|en|de|fr)\.ts$/.test(name))
  .sort()
  .map((name) => path.join('content', name));
const seoFiles = readdirSync(path.join(contentDir, 'seo'))
  .filter((name) => /^seo-blog(?:-ch)?(?:-\d+)?\.ts$/.test(name))
  .sort()
  .map((name) => path.join('content', 'seo', name));
const cantonDir = path.join(contentDir, 'cantons');
const cantonSeoFiles = existsSync(cantonDir)
  ? readdirSync(cantonDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join('content', 'cantons', entry.name, 'seo.ts'))
    .filter((relativeFile) => existsSync(path.join(repoRoot, relativeFile)))
    .sort()
  : [];

const results = [
  ...allMetaFiles.map(repairMetaFile),
  ...seoFiles.map(repairSeoFile),
  ...cantonSeoFiles.map(repairSeoFile),
];
const details = results.flatMap((result) => result.details);
const summary = {
  mode: writeMode ? 'write' : 'check',
  files: results.length,
  changedValues: details.length,
  bySection: Object.fromEntries(['frontaliere', 'svizzera', 'cantonale'].map((section) => [
    section,
    details.filter((item) => item.section === section).length,
  ])),
  byField: Object.fromEntries([...new Set(details.map((item) => item.field))].sort().map((field) => [
    field,
    details.filter((item) => item.field === field).length,
  ])),
  details,
};
console.log(JSON.stringify(summary, null, 2));
if (!writeMode && details.length > 0) process.exitCode = 1;
