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
import { decodeTypeScriptString } from '../../generator/scripts/lib/article-meta-block.mjs';

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

function readQuotedValue(source, start, quote) {
  let cursor = start + 1;
  while (cursor < source.length) {
    if (source[cursor] === '\\') {
      if (source[cursor + 1] === '\r' && source[cursor + 2] === '\n') {
        cursor += 3;
        continue;
      }
      cursor += 2;
      continue;
    }
    if (quote === '`' && source[cursor] === '$' && source[cursor + 1] === '{') {
      return { dynamic: true };
    }
    if (source[cursor] === quote) {
      return { raw: source.slice(start + 1, cursor), end: cursor + 1 };
    }
    if (quote !== '`' && (source[cursor] === '\n' || source[cursor] === '\r')) return null;
    cursor += 1;
  }
  return null;
}

function decodeBodyValue(raw, quote) {
  return decodeTypeScriptString(raw, quote);
}

const TEMPLATE_QUOTE = String.fromCharCode(96);

function skipLineComment(source, start) {
  const end = source.indexOf('\n', start + 2);
  return end < 0 ? source.length : end + 1;
}

function skipBlockComment(source, start) {
  const end = source.indexOf('*/', start + 2);
  return end < 0 ? source.length : end + 2;
}

function skipTemplateExpression(source, start) {
  let depth = 1;
  let cursor = start;
  while (cursor < source.length) {
    const char = source[cursor];
    const next = source[cursor + 1];
    if (char === '/' && next === '/') {
      cursor = skipLineComment(source, cursor);
    } else if (char === '/' && next === '*') {
      cursor = skipBlockComment(source, cursor);
    } else if (char === "'" || char === '"' || char === TEMPLATE_QUOTE) {
      cursor = skipQuotedToken(source, cursor);
    } else if (char === '{') {
      depth += 1;
      cursor += 1;
    } else if (char === '}') {
      depth -= 1;
      cursor += 1;
      if (depth === 0) return cursor;
    } else {
      cursor += 1;
    }
  }
  return source.length;
}

function skipQuotedToken(source, start) {
  const quote = source[start];
  let cursor = start + 1;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === '\\') {
      cursor += 2;
      continue;
    }
    if (quote === TEMPLATE_QUOTE && char === '$' && source[cursor + 1] === '{') {
      cursor = skipTemplateExpression(source, cursor + 2);
      continue;
    }
    if (char === quote) return cursor + 1;
    cursor += 1;
  }
  return source.length;
}

function skipTriviaAndComments(source, start) {
  let cursor = start;
  while (cursor < source.length) {
    if (/\s/.test(source[cursor])) {
      cursor += 1;
    } else if (source[cursor] === '/' && source[cursor + 1] === '/') {
      cursor = skipLineComment(source, cursor);
    } else if (source[cursor] === '/' && source[cursor + 1] === '*') {
      cursor = skipBlockComment(source, cursor);
    } else {
      break;
    }
  }
  return cursor;
}

function extractArticleBodyValues(source) {
  const values = [];
  let cursor = 0;
  let previousToken = '';
  while (cursor < source.length) {
    const char = source[cursor];
    const next = source[cursor + 1];
    if (/\s/.test(char)) {
      cursor += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      cursor = skipLineComment(source, cursor);
      continue;
    }
    if (char === '/' && next === '*') {
      cursor = skipBlockComment(source, cursor);
      continue;
    }
    if (char === "'" || char === '"' || char === TEMPLATE_QUOTE) {
      const tokenStart = cursor;
      const tokenEnd = skipQuotedToken(source, tokenStart);
      if (previousToken === '{' || previousToken === ',') {
        const keyLiteral = readQuotedValue(source, tokenStart, char);
        if (keyLiteral && !keyLiteral.dynamic) {
          const propertyKey = decodeBodyValue(keyLiteral.raw, char);
          const keyMatch = /^blog\.article\.(.+)\.(body\d+|faq)$/.exec(propertyKey);
          const afterKey = skipTriviaAndComments(source, tokenEnd);
          if (keyMatch && source[afterKey] === ':') {
            const valueStart = skipTriviaAndComments(source, afterKey + 1);
            const valueQuote = source[valueStart];
            if (!["'", '"', TEMPLATE_QUOTE].includes(valueQuote)) {
              throw new Error('valore TypeScript non letterale per blog.article.'
                + keyMatch[1] + '.' + keyMatch[2]);
            }
            const literal = readQuotedValue(source, valueStart, valueQuote);
            if (!literal) {
              throw new Error('stringa TypeScript non terminata per blog.article.'
                + keyMatch[1] + '.' + keyMatch[2]);
            }
            if (literal.dynamic) {
              throw new Error('template TypeScript dinamico non verificabile per blog.article.'
                + keyMatch[1] + '.' + keyMatch[2]);
            }
            values.push({
              field: 'blog.article.' + keyMatch[1] + '.' + keyMatch[2],
              markdown: decodeBodyValue(literal.raw, valueQuote),
              index: tokenStart,
            });
            cursor = literal.end;
            previousToken = 'string';
            continue;
          }
        }
      }
      cursor = tokenEnd;
      previousToken = 'string';
      continue;
    }
    previousToken = char;
    cursor += 1;
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
  const link = offender.htmlAnchor
    ? `<a href="${offender.target}">`
    : `[${offender.label}](${offender.target})`;
  return `${offender.file}:${offender.line}: ${link}${replacement}`;
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
