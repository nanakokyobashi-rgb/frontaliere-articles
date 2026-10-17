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
import { unescapeForSingleQuoteTS } from '../../generator/scripts/lib/article-meta-block.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
configureCorpusActiveSections();
export const BLOG_BODY_ROOTS = Object.freeze(activeSourceSections().map(({ bodyDir }) => bodyDir));
const LOCALES = new Set(['it', 'en', 'de', 'fr']);
const ARTICLE_BODY_PROPERTY = /(['"])blog\.article\.([^'"]+)\.(body\d+|faq)\1\s*:\s*(['"])/g;

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

function readQuotedValue(source, start, quote) {
  let cursor = start + 1;
  while (cursor < source.length) {
    if (source[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (source[cursor] === quote) {
      return { raw: source.slice(start + 1, cursor), end: cursor + 1 };
    }
    if (source[cursor] === '\n' || source[cursor] === '\r') return null;
    cursor += 1;
  }
  return null;
}

function decodeBodyValue(raw, quote) {
  if (quote === "'") return unescapeForSingleQuoteTS(raw);
  return JSON.parse(`"${raw}"`);
}

function extractArticleBodyValues(source) {
  const values = [];
  const matcher = new RegExp(ARTICLE_BODY_PROPERTY.source, 'g');
  let match;
  while ((match = matcher.exec(source)) !== null) {
    const valueStart = matcher.lastIndex - 1;
    const quote = match[4];
    const literal = readQuotedValue(source, valueStart, quote);
    if (!literal) {
      throw new Error(`stringa TypeScript non terminata per blog.article.${match[2]}.${match[3]}`);
    }
    values.push({
      field: `blog.article.${match[2]}.${match[3]}`,
      markdown: decodeBodyValue(literal.raw, quote),
      index: match.index,
    });
    matcher.lastIndex = literal.end;
  }
  return values;
}

function normalizedChangedFiles(changedFiles) {
  if (changedFiles == null) return null;
  return new Set(changedFiles.map((file) => String(file).trim().replace(/\\/g, '/')).filter(Boolean));
}

export function scanBlogBodyLinks(root = ROOT, changedFiles = null) {
  const changed = normalizedChangedFiles(changedFiles);
  const bodyRoots = BLOG_BODY_ROOTS.map((directory) => path.join(root, directory));
  const entries = bodyRoots.flatMap((bodyRoot) =>
    collectTypeScriptFiles(bodyRoot).map((file) => ({ bodyRoot, file })))
    .filter(({ file }) => changed == null || changed.has(path.relative(root, file).split(path.sep).join('/')));
  const files = entries.map(({ file }) => file);
  const offenders = [];
  const errors = [];
  for (const { bodyRoot, file } of entries) {
    const locale = localeForFile(bodyRoot, file);
    if (!locale) continue;
    const source = fs.readFileSync(file, 'utf8');
    const relativeFile = path.relative(root, file).split(path.sep).join('/');
    let bodyValues;
    try {
      bodyValues = extractArticleBodyValues(source);
    } catch (parseError) {
      errors.push({ file: relativeFile, message: parseError?.message || String(parseError) });
      continue;
    }
    for (const body of bodyValues) {
      for (const offender of findNonCanonicalArticleLinks(body.markdown, locale)) {
        offenders.push({
          file: relativeFile,
          line: lineOf(source, body.index),
          field: body.field,
          ...offender,
        });
      }
    }
  }
  return { files, offenders, errors };
}

export function formatOffender(offender) {
  const replacement = offender.replacement
    ? ` → ${offender.replacement}`
    : ' → plain text';
  return `${offender.file}:${offender.line}: [${offender.label}](${offender.target})${replacement}`;
}

export function run({ root = ROOT, log = console.log, error = console.error } = {}) {
  let changedFiles = null;
  if (process.env.PREFLIGHT_SCAN_MODE === 'changed') {
    const changedFilesPath = process.env.PREFLIGHT_CHANGED_FILES_FILE;
    if (changedFilesPath) {
      try {
        changedFiles = fs.readFileSync(changedFilesPath, 'utf8').split(/\r?\n/).filter(Boolean);
      } catch (readError) {
        error(`impossibile leggere PREFLIGHT_CHANGED_FILES_FILE: ${readError?.message || readError}`);
        return 1;
      }
    } else if (process.env.PREFLIGHT_CHANGED_FILES) {
      changedFiles = process.env.PREFLIGHT_CHANGED_FILES.split(/\r?\n/).filter(Boolean);
    } else {
      error('PREFLIGHT_SCAN_MODE=changed richiede PREFLIGHT_CHANGED_FILES_FILE o PREFLIGHT_CHANGED_FILES');
      return 1;
    }
  }
  const { files, offenders, errors } = scanBlogBodyLinks(root, changedFiles);
  if (errors.length > 0) {
    error(`stringhe body TypeScript non leggibili: ${errors.length}`);
    for (const item of errors) error(`${item.file}: ${item.message}`);
    return 1;
  }
  if (changedFiles !== null && files.length === 0) {
    log('nessun body TypeScript modificato nelle sezioni attive; link gate non necessario');
    return 0;
  }
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
