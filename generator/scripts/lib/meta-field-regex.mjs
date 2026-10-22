/**
 * Quote-safe extraction of `blog.article.<id>.<field>` values from the
 * `blog-meta-*.ts` tables.
 *
 * Extracted here because the naive `'[^']*'` shape had drifted into five
 * independent copies inside `create-article.mjs` alone (#4881), four of them
 * truncating on the first apostrophe. Article titles routinely contain one
 * ("l'iniziativa", "dell'A9"), so those copies silently under-matched and
 * weakened duplicate detection across the whole corpus.
 *
 * One definition, imported by every consumer — including the tests, which
 * previously re-declared their own copy and so could have gone on passing
 * while the script regressed.
 */

import { readStaticObjectEntries } from '../../../engine/shared/ts-literals.mjs';
import { parseStaticArticleTranslationEntries } from '../../../engine/shared/articleStaticSource.mjs';
import { unescapeTsString } from './unescape-ts-string.mjs';

/**
 * Read requested fields from one or more complete static metadata modules.
 * Each module is validated independently before its entries are appended, so
 * input-module order and property order remain observable to callers that
 * apply their existing first/last-wins policy. Callers decide which missing
 * files to omit; a present malformed module rejects the entire operation.
 *
 * This API is additive. The RegExp-compatible exports below remain available
 * for consumers that edit source spans rather than read field values.
 *
 * @param {{source: string, sourcePath: string}|Array<{source: string, sourcePath: string}>} modules
 * @param {string[]} fields
 * @returns {Record<string, Array<{id: string, value: string}>>}
 */
export function readStaticMetaFields(modules, fields) {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new TypeError('[meta-fields] fields must be a non-empty array');
  }
  for (const field of fields) {
    if (typeof field !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/u.test(field)) {
      throw new TypeError('[meta-fields] each field must be a simple identifier');
    }
  }
  if (new Set(fields).size !== fields.length) {
    throw new TypeError('[meta-fields] fields must not contain duplicates');
  }

  const requestedFields = new Set(fields);
  const inputs = Array.isArray(modules) ? modules : [modules];
  const entriesByField = Object.fromEntries(fields.map((field) => [field, []]));
  for (const module of inputs) {
    if (!module || typeof module.source !== 'string' || typeof module.sourcePath !== 'string' || module.sourcePath.trim() === '') {
      throw new TypeError('[meta-fields] each module must include source text and a non-empty sourcePath');
    }
    for (const entry of parseStaticArticleTranslationEntries(module.source, module.sourcePath)) {
      if (requestedFields.has(entry.field)) {
        entriesByField[entry.field].push({ id: entry.articleId, value: entry.value });
      }
    }
  }
  return entriesByField;
}

/** @returns {Array<{id: string, value: string}>} */
export function readStaticMetaFieldEntries(modules, field) {
  return readStaticMetaFields(modules, [field])[field];
}

function makeMatch(source, entry, index) {
  const full = source.slice(index, entry.end);
  const lastDot = entry.key.lastIndexOf('.');
  const match = [full, entry.key.slice('blog.article.'.length, lastDot), entry.rawValue];
  match.index = index;
  match.input = source;
  return match;
}

/**
 * Token-aware replacement for the old raw RegExp API.
 *
 * Callers historically use both `source.matchAll(metaFieldRegex(field))` and
 * `metaFieldRegex(field).exec(source)`, so keep that surface while making the
 * matching lexical: quoted keys in comments/prose are ignored and escaped
 * apostrophes do not terminate a value. The returned object deliberately
 * exposes only the small RegExp-compatible surface used by this repository.
 */
export function metaFieldRegex(field) {
  return createMetaFieldMatcher(field);
}

/**
 * Explicit adapter for the append-only metadata block emitted before it is
 * wrapped in the complete object file. Full metadata readers must use
 * `metaFieldRegex`, which rejects a truncated object at EOF.
 */
export function metaFieldRegexFragment(field) {
  return createMetaFieldMatcher(field, { allowTerminalFragment: true });
}

function createMetaFieldMatcher(field, { allowTerminalFragment = false } = {}) {
  if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(field)) {
    throw new TypeError(`invalid meta field: ${field}`);
  }
  let sourceRef = null;
  let matches = [];
  let cursor = 0;
  const collect = (source) => {
    if (sourceRef === source) return;
    sourceRef = source;
    // A missing metadata section is a valid zero-match input during the
    // first article selection. Do not make the strict full-object reader
    // report an absent file as a malformed object.
    if (source.length === 0) {
      matches = [];
      cursor = 0;
      return;
    }
    matches = readStaticObjectEntries(
      source,
      'blog-meta.ts',
      allowTerminalFragment ? { allowTerminalFragment: true } : {},
    )
      .filter(({ key }) => {
        const suffix = `.${field}`;
        return key.startsWith('blog.article.') && key.endsWith(suffix);
      })
      .map((entry) => ({ entry, index: entry.start }));
    cursor = 0;
  };
  const matcher = {
    global: true,
    lastIndex: 0,
    exec(source) {
      collect(source);
      if (cursor >= matches.length) {
        matcher.lastIndex = 0;
        return null;
      }
      const current = matches[cursor++];
      matcher.lastIndex = current.index + 1;
      return makeMatch(source, current.entry, current.index);
    },
    *[Symbol.matchAll](source) {
      collect(source);
      for (const current of matches) yield makeMatch(source, current.entry, current.index);
    },
  };
  return matcher;
}

/**
 * Unescapes a TS single-quoted string body captured by `metaFieldRegex`.
 * Only quotes and a literal backslash are decoded here — title/excerpt
 * fields are single-line, so `\n`/`\r`/`\t` were never part of this
 * function's scope and stay untouched (see unescape-ts-string.mjs for why
 * that matters and for the shared decoder this now runs through, fixed for
 * #5632).
 */
export function unescapeTsValue(s) {
  return unescapeTsString(s, { "'": "'", '"': '"', '\\': '\\' });
}
