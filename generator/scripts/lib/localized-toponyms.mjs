import { readFileSync } from 'node:fs';
import { unescapeTsString } from './unescape-ts-string.mjs';
import { decodeHtmlEntities } from './decode-html-entities.mjs';

const TABLE = JSON.parse(
  readFileSync(new URL('../../data/localized-toponyms.json', import.meta.url), 'utf8'),
);

export const LOCALIZED_TOPONYM_LOCALES = Object.freeze([...TABLE.locales]);
export const LOCALIZED_TOPONYMS = Object.freeze(
  TABLE.entities.map((entity) => Object.freeze({
    code: entity.code,
    canton: Object.freeze(Object.fromEntries(
      LOCALIZED_TOPONYM_LOCALES.map((locale) => [locale, Object.freeze([...entity.canton[locale]])]),
    )),
    capital: Object.freeze(Object.fromEntries(
      LOCALIZED_TOPONYM_LOCALES.map((locale) => [locale, Object.freeze([...entity.capital[locale]])]),
    )),
  })),
);

const LOCALE_SET = new Set(LOCALIZED_TOPONYM_LOCALES);
const ENTITY_TYPES = Object.freeze(['canton', 'capital']);

/** Keep detection and historical repair on the same text the writer publishes. */
export function normalizeLocalizedToponymText(value) {
  return decodeHtmlEntities(String(value ?? ''));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function termPattern(term) {
  return String(term)
    .trim()
    .split(/\s+/u)
    .map(escapeRegExp)
    .join('\\s+');
}

// URL destinations are opaque content, including relative Markdown routes.
// The generator may mention a localized slug in prose as `[link](/en/.../...)`;
// that route is not a translated sentence and must neither trigger the gate nor
// be rewritten by the deterministic repair. Plain article slugs, passed as a
// separate projection field, do not start with `/` and remain visible.
const URL_PATTERN = /(?:https?|evergreen|stats-(?:bfs|astra)):\/\/[^\s)]+|(?<![\p{L}\p{N}@])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:ch|com|org|net|it|fr|de|io|info)(?:\/[^\s)]*)?|(?<![\p{L}\p{N}@])\/[a-z0-9][^\s)\]>"]*/giu;

function withoutUrls(value) {
  return String(value || '').replace(URL_PATTERN, ' ');
}

function containsTerm(value, term) {
  const text = withoutUrls(normalizeLocalizedToponymText(value)).normalize('NFKC');
  const pattern = termPattern(term);
  if (!pattern) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

function entityForms(entity) {
  return ENTITY_TYPES.flatMap((type) =>
    LOCALIZED_TOPONYM_LOCALES.flatMap((locale) =>
      entity[type][locale].map((form) => ({ type, locale, form }))));
}

function normalizeForm(value) {
  return String(value).normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/gu, ' ').trim();
}

function localizedSlugForm(value) {
  return String(value)
    .normalize('NFKD')
    .replace(/[\p{M}]/gu, '')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

const ARTICLE_PROJECTION_ESCAPES = Object.freeze({
  "'": "'",
  '"': '"',
  '\\': '\\',
  n: '\n',
  r: '\r',
  t: ' ',
});

/**
 * Extract every published field for one article from a body or meta TS file.
 * The writer stores body, FAQ and metadata in the same article-key namespace;
 * callers can therefore combine the result from both files into one
 * article-wide projection before admitting a replacement.
 */
export function extractArticleProjectionText(fileContent, articleId, { excludeFaq = false, fields = null } = {}) {
  if (!fileContent || !articleId) return '';
  const allowedFields = fields ? new Set(fields) : null;
  const fieldRe = new RegExp(
    "'blog\\.article\\." + escapeRegExp(String(articleId)) + "\\.([^']+)'\\s*:\\s*(['`])((?:\\\\.|(?!\\2)[\\s\\S])*?)\\2",
    'g',
  );
  const prefix = `'blog.article.${articleId}.`;
  return [...String(fileContent).matchAll(fieldRe)]
    .filter((match) => {
      const field = match[1];
      if (excludeFaq && field === 'faq') return false;
      if (allowedFields && !allowedFields.has(field)) return false;
      return match[0].startsWith(`${prefix}${field}'`);
    })
    .map((match) => normalizeLocalizedToponymText(
      unescapeTsString(match[3], ARTICLE_PROJECTION_ESCAPES),
    ))
    .join('\n');
}

function slugTermPattern(term) {
  return escapeRegExp(localizedSlugForm(term));
}

function issueKey(issue) {
  // A canton and its capital can legitimately share one name (LU, BE, GE,
  // ...). Report one offending token, while retaining the type that first
  // established it for diagnostics.
  return [issue.code, issue.locale, issue.form, issue.expected].join('|');
}

const FORM_INDEX = new Map();
const SLUG_FORM_INDEX = new Map();
for (const entity of LOCALIZED_TOPONYMS) {
  for (const type of ENTITY_TYPES) {
    for (const locale of LOCALIZED_TOPONYM_LOCALES) {
      for (const form of entity[type][locale]) {
        const key = normalizeForm(form);
        const descriptors = FORM_INDEX.get(key) || [];
        descriptors.push({ entity, type, locale, form });
        FORM_INDEX.set(key, descriptors);

        const slugKey = localizedSlugForm(form);
        if (slugKey) {
          const slugDescriptors = SLUG_FORM_INDEX.get(slugKey) || [];
          slugDescriptors.push({ entity, type, locale, form });
          SLUG_FORM_INDEX.set(slugKey, slugDescriptors);
        }
      }
    }
  }
}

const TOPONYM_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${[...FORM_INDEX.keys()]
    .sort((left, right) => right.length - left.length)
    .map(termPattern)
    .join('|')})(?![\\p{L}\\p{N}])`,
  'giu',
);

const TOPONYM_SLUG_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${[...SLUG_FORM_INDEX.keys()]
    .map(escapeRegExp)
    .sort((left, right) => right.length - left.length)
    .join('|')})(?![\\p{L}\\p{N}])`,
  'giu',
);

const PROTECTED_NAME_PATTERNS = Object.freeze([
  /\bfrontali(?:ere|er|ère)\s+(?:ticino|tessin)\b/giu,
  /\b(?:ticino|tessin)\s+(?:turismo|tourismus|tourisme|tourism)\b/giu,
  /\b(?:navigazione|navigation)\s+(?:ticino|tessin)\b/giu,
  /\b(?:cardiocentro|cardiocentre)\s+(?:ticino|tessin)\b/giu,
  /\bhotelleriesuisse\s+(?:ticino|tessin)\b/giu,
  /\b(?:giornale\s+del|journal\s+du|gazzetta\s+del)\s+(?:ticino|tessin)\b/giu,
  /\b(?:associazione\s+per\s+la\s+promozione\s+del|banca\s+del|banca\s+dello\s+stato\s+del\s+cantone)\s+(?:ticino|tessin)\b/giu,
  /\b(?:bancastato|caritas|aoz|fly|physioswiss|spitex)\s+(?:ticino|tessin)\b/giu,
  /\b(?:ticino|tessin)\s+(?:spitex|2020)\b/giu,
  /\bavanti\s+con\s+(?:ticino|tessin)\s*(?:&|e|et|und)\s*lavoro\b/giu,
  /\b(?:ticino|tessin)\s+news\b/giu,
  /\b(?:radio|tele|tv)\s+(?:ticino|tessin)\b/giu,
  /\bsva\s+(?:aargau|argovie|argovia|tessin|ticino)\b/giu,
]);

function protectedRanges(value) {
  const ranges = [];
  for (const pattern of PROTECTED_NAME_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of String(value).matchAll(pattern)) {
      ranges.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
    }
  }
  return ranges;
}

function replaceOutsideUrls(value, pattern, replacer) {
  const text = String(value || '');
  let result = '';
  let cursor = 0;
  URL_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const offset = match.index ?? cursor;
    result += text.slice(cursor, offset).replace(pattern, replacer);
    result += match[0];
    cursor = offset + match[0].length;
  }
  return result + text.slice(cursor).replace(pattern, replacer);
}

function localizedToponymHits(value, { protectNames = false, slug = false } = {}) {
  const text = withoutUrls(normalizeLocalizedToponymText(value)).normalize('NFKC');
  const protectedNameRanges = protectNames ? protectedRanges(text) : [];
  const hits = [];
  const pattern = slug ? TOPONYM_SLUG_PATTERN : TOPONYM_PATTERN;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (protectedNameRanges.some(([rangeStart, rangeEnd]) => start >= rangeStart && end <= rangeEnd)) continue;
    const indexKey = slug ? localizedSlugForm(match[0]) : normalizeForm(match[0]);
    const descriptors = (slug ? SLUG_FORM_INDEX : FORM_INDEX).get(indexKey) || [];
    const observedForm = slug ? localizedSlugForm(match[0]) : normalizeForm(match[0]);
    hits.push(...descriptors.map((descriptor) => ({ ...descriptor, observedForm })));
  }
  return hits;
}

/**
 * Finds a localized exonym copied from another locale. The Italian source is
 * used only to establish which Swiss place the article is about; a foreign
 * place name mentioned in an unrelated article is never judged.
 */
export function findLocalizedToponymMismatches({ sourceText = '', targetText = '', locale, slug = false } = {}) {
  if (!LOCALE_SET.has(locale)) return [];
  const sourceEntities = new Set(localizedToponymHits(sourceText).map((hit) => hit.entity.code));
  if (sourceEntities.size === 0) return [];
  const targetHits = localizedToponymHits(targetText, { protectNames: true, slug });
  const issues = [];
  for (const entity of LOCALIZED_TOPONYMS) {
    if (!sourceEntities.has(entity.code)) continue;
    for (const type of ENTITY_TYPES) {
      const expected = new Set(entity[type][locale].flatMap((form) => [
        normalizeForm(form),
        ...(slug ? [normalizeForm(localizedSlugForm(form))] : []),
      ]));
      for (const hit of targetHits) {
        if (hit.entity.code !== entity.code || hit.type !== type || hit.locale === locale) continue;
        if (expected.has(hit.observedForm || normalizeForm(hit.form))) continue;
        const issue = {
          code: entity.code,
          type,
          locale,
          form: hit.form,
          expected: entity[type][locale][0],
        };
        if (!issues.some((candidate) => issueKey(candidate) === issueKey(issue))) issues.push(issue);
      }
    }
  }
  return issues;
}

/**
 * Shared fail-closed write assertion for producers that update an existing
 * localized field instead of going through `registerArticleFiles()`.
 */
export function assertLocalizedToponymPair({ sourceText = '', targetText = '', locale, context = 'traduzione' } = {}) {
  const issues = findLocalizedToponymMismatches({ sourceText, targetText, locale });
  if (issues.length === 0) return [];
  const error = new Error(
    `${context}: esonimo localizzato non valido (${issues.map((issue) => `${issue.code}.${issue.type} ${issue.form}→${issue.expected}`).join(', ')})`,
  );
  error.qualityReject = true;
  error.localizedToponymIssues = issues;
  throw error;
}

/**
 * Deterministically repairs only the foreign exonyms established by the
 * source-language article. URLs are opaque: slugs and source links are never
 * rewritten by this function.
 */
export function replaceLocalizedToponymMismatches({ sourceText = '', targetText = '', locale, slug = false } = {}) {
  const issues = findLocalizedToponymMismatches({ sourceText, targetText, locale, slug });
  let text = normalizeLocalizedToponymText(targetText);
  let replacements = 0;
  const replacementCounts = new Map();
  for (const issue of [...issues].sort((left, right) => right.form.length - left.form.length)) {
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])${slug ? slugTermPattern(issue.form) : termPattern(issue.form)}(?![\\p{L}\\p{N}])`,
      'giu',
    );
    let issueReplacements = 0;
    text = replaceOutsideUrls(text, pattern, (match, offset, segment) => {
      const start = Number(offset);
      const end = start + match.length;
      if (protectedRanges(segment).some(([rangeStart, rangeEnd]) => start >= rangeStart && end <= rangeEnd)) {
        return match;
      }
      replacements += 1;
      issueReplacements += 1;
      return slug ? localizedSlugForm(issue.expected) : issue.expected;
    });
    replacementCounts.set(issueKey(issue), issueReplacements);
  }
  return { text, replacements, replacementCounts, issues };
}

function collectStrings(value, output = []) {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, output));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => collectStrings(item, output));
  return output;
}

function articleLocaleProjection(data, locale) {
  const imageAlt = data?.imageAlt && typeof data.imageAlt === 'object'
    ? data.imageAlt[locale]
    : locale === 'it' ? data?.imageAlt : undefined;
  return {
    content: data?.content?.[locale],
    imageAlt,
    slug: data?.slugs?.[locale],
    // `seo` is the Italian root-level SEO projection; localized SEO fields
    // live in content[locale] and are already collected above.
    seo: locale === 'it' ? data?.seo : undefined,
  };
}

/** Returns the same deterministic check for the complete pre-write article. */
export function findArticleLocalizedToponymMismatches(data) {
  const source = collectStrings(articleLocaleProjection(data, 'it')).join('\n');
  if (!source.trim()) return [];

  const issues = [];
  for (const locale of LOCALIZED_TOPONYM_LOCALES.filter((item) => item !== 'it')) {
    const targetProjection = articleLocaleProjection(data, locale);
    const target = collectStrings({ ...targetProjection, slug: undefined }).join('\n');
    const targetIssues = findLocalizedToponymMismatches({ sourceText: source, targetText: target, locale });
    const provisionalSlugs = new Set([
      ...(Array.isArray(data?._slugsProvisionalFromIt) ? data._slugsProvisionalFromIt : []),
      ...(Array.isArray(data?._slugI18nFallbacks)
        ? data._slugI18nFallbacks
          .map((record) => typeof record === 'string' ? record : record?.locale)
          .filter(Boolean)
        : []),
    ]);
    if (targetProjection.slug && !provisionalSlugs.has(locale)) {
      targetIssues.push(...findLocalizedToponymMismatches({
        sourceText: source,
        targetText: targetProjection.slug,
        locale,
        slug: true,
      }));
    }
    for (const issue of targetIssues) {
      issues.push({ ...issue, locale });
    }
  }
  return issues;
}

export function validateLocalizedToponymTable() {
  const errors = [];
  if (TABLE.schemaVersion !== 1) errors.push(`schemaVersion=${TABLE.schemaVersion}`);
  if (JSON.stringify(TABLE.locales) !== JSON.stringify(['it', 'en', 'de', 'fr'])) {
    errors.push(`locales=${JSON.stringify(TABLE.locales)}`);
  }
  if (LOCALIZED_TOPONYMS.length !== 26) errors.push(`entities=${LOCALIZED_TOPONYMS.length}`);
  if (new Set(LOCALIZED_TOPONYMS.map((entity) => entity.code)).size !== LOCALIZED_TOPONYMS.length) {
    errors.push('codici cantonali duplicati');
  }
  for (const entity of LOCALIZED_TOPONYMS) {
    for (const type of ENTITY_TYPES) {
      for (const locale of LOCALIZED_TOPONYM_LOCALES) {
        if (!Array.isArray(entity[type][locale]) || entity[type][locale].length === 0) {
          errors.push(`${entity.code}.${type}.${locale}`);
          continue;
        }
        if (entity[type][locale].some((form) => typeof form !== 'string' || !form.trim())) {
          errors.push(`${entity.code}.${type}.${locale}: forma non testuale/vuota`);
        }
        if (new Set(entity[type][locale].map(normalizeForm)).size !== entity[type][locale].length) {
          errors.push(`${entity.code}.${type}.${locale}: alias duplicati`);
        }
      }
    }
  }
  return errors;
}

const LOCALIZED_TOPONYM_TABLE_ERRORS = validateLocalizedToponymTable();
if (LOCALIZED_TOPONYM_TABLE_ERRORS.length > 0) {
  throw new Error(`Tabella esonimi localizzati non valida: ${LOCALIZED_TOPONYM_TABLE_ERRORS.join('; ')}`);
}

/**
 * Prompt block shared by every translation producer. It is generated from
 * the same table as the post-translation gate, so adding an exonym cannot
 * silently update only one side of the contract.
 */
export function localizedToponymInstruction(locale) {
  if (!LOCALE_SET.has(locale) || locale === 'it') return '';
  const lines = [];
  for (const entity of LOCALIZED_TOPONYMS) {
    for (const type of ENTITY_TYPES) {
      const source = entity[type].it.join(' / ');
      const target = entity[type][locale].join(' / ');
      if (normalizeForm(source) === normalizeForm(target)) continue;
      lines.push(`- ${source} (${entity.code}, ${type}) → ${target}`);
    }
  }
  return `ESONIMI SVIZZERI OBBLIGATORI — usa la forma della lingua ${locale} per cantoni e capoluoghi; non copiare la forma italiana o di un'altra lingua:\n${lines.join('\n')}`;
}

export default {
  LOCALIZED_TOPONYM_LOCALES,
  LOCALIZED_TOPONYMS,
  findLocalizedToponymMismatches,
  extractArticleProjectionText,
  normalizeLocalizedToponymText,
  assertLocalizedToponymPair,
  replaceLocalizedToponymMismatches,
  findArticleLocalizedToponymMismatches,
  localizedToponymInstruction,
  validateLocalizedToponymTable,
};
