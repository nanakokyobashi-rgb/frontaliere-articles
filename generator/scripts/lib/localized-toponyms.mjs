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

const ADDITIONAL_HTML_ENTITIES = Object.freeze({
  '&Aacute;': 'Á', '&aacute;': 'á',
  '&Acirc;': 'Â', '&acirc;': 'â',
  '&Agrave;': 'À', '&agrave;': 'à',
  '&Auml;': 'Ä', '&auml;': 'ä',
  '&Ccedil;': 'Ç', '&ccedil;': 'ç',
  '&Eacute;': 'É', '&eacute;': 'é',
  '&Egrave;': 'È', '&egrave;': 'è',
  '&Ecirc;': 'Ê', '&ecirc;': 'ê',
  '&Euml;': 'Ë', '&euml;': 'ë',
  '&Iacute;': 'Í', '&iacute;': 'í',
  '&Icirc;': 'Î', '&icirc;': 'î',
  '&Iuml;': 'Ï', '&iuml;': 'ï',
  '&Ntilde;': 'Ñ', '&ntilde;': 'ñ',
  '&Oacute;': 'Ó', '&oacute;': 'ó',
  '&Ocirc;': 'Ô', '&ocirc;': 'ô',
  '&Ouml;': 'Ö', '&ouml;': 'ö',
  '&Uacute;': 'Ú', '&uacute;': 'ú',
  '&Ucirc;': 'Û', '&ucirc;': 'û',
  '&Uuml;': 'Ü', '&uuml;': 'ü',
  '&Yacute;': 'Ý', '&yacute;': 'ý',
  '&Yuml;': 'Ÿ', '&yuml;': 'ÿ',
  '&szlig;': 'ß',
});
const ADDITIONAL_HTML_ENTITY_PATTERN = new RegExp(
  Object.keys(ADDITIONAL_HTML_ENTITIES)
    .map((entity) => escapeRegExp(entity))
    .join('|'),
  'g',
);
const NUMERIC_HTML_ENTITY_PATTERN = /&#(?:x([0-9a-f]+)|([0-9]+));/giu;
const DASH_VARIANT_PATTERN = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/gu;
const DASH_CHARACTER_PATTERN = /[-\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/u;
const MATCH_DASH_TERM_PATTERN = '\\s*[-\\u2010-\\u2015\\u2212\\uFE58\\uFE63\\uFF0D]\\s*';
const RAW_DASH_TERM_PATTERN = '\\s*(?:[-\\u2010-\\u2015\\u2212\\uFE58\\uFE63\\uFF0D]|&(?:ndash|mdash);|&#(?:8211|8212|x2013|x2014);)\\s*';
const RAW_HTML_ENTITY_BY_CHARACTER = new Map();
for (const [entity, character] of Object.entries({
  ...ADDITIONAL_HTML_ENTITIES,
  '&amp;': '&',
  '&apos;': "'",
  '&nbsp;': ' ',
  '&quot;': '"',
})) {
  const entities = RAW_HTML_ENTITY_BY_CHARACTER.get(character) || [];
  entities.push(entity);
  RAW_HTML_ENTITY_BY_CHARACTER.set(character, entities);
}

/** Keep detection, writing and historical repair on the same normalized text. */
export function normalizeLocalizedToponymText(value) {
  return decodeHtmlEntities(String(value ?? ''))
    .replace(ADDITIONAL_HTML_ENTITY_PATTERN, (entity) => ADDITIONAL_HTML_ENTITIES[entity] ?? entity)
    .replace(NUMERIC_HTML_ENTITY_PATTERN, (_entity, hexadecimal, decimal) => {
      const codePoint = Number.parseInt(hexadecimal || decimal, hexadecimal ? 16 : 10);
      return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : _entity;
    });
}

/** Normalize typography only for matching; writers must not rewrite prose here. */
function normalizeToponymMatchText(value) {
  return normalizeLocalizedToponymText(value)
    .normalize('NFKC')
    .replace(DASH_VARIANT_PATTERN, '-');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function termPattern(term) {
  let pattern = '';
  for (const character of String(term).trim()) {
    if (/\s/u.test(character)) {
      pattern += '\\s+';
    } else if (DASH_CHARACTER_PATTERN.test(character)) {
      pattern += MATCH_DASH_TERM_PATTERN;
    } else {
      pattern += escapeRegExp(character);
    }
  }
  return pattern;
}

function rawTermPattern(term) {
  let pattern = '';
  for (const character of String(term)) {
    if (/\s/u.test(character)) {
      pattern += '\\s+';
      continue;
    }
    if (DASH_CHARACTER_PATTERN.test(character)) {
      pattern += RAW_DASH_TERM_PATTERN;
      continue;
    }
    const alternatives = [escapeRegExp(character)];
    for (const entity of RAW_HTML_ENTITY_BY_CHARACTER.get(character) || []) {
      alternatives.push(escapeRegExp(entity));
    }
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined) {
      alternatives.push(`&#${codePoint};`, `&#x${codePoint.toString(16)};`);
    }
    pattern += alternatives.length === 1 ? alternatives[0] : `(?:${alternatives.join('|')})`;
  }
  return pattern;
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
  const text = withoutUrls(normalizeToponymMatchText(value));
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
  return normalizeToponymMatchText(value)
    .toLocaleLowerCase('en')
    .replace(/\s*-\s*/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim();
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
  const text = withoutUrls(normalizeToponymMatchText(value));
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
  let text = String(targetText ?? '');
  if (issues.length === 0) {
    return {
      text,
      replacements: 0,
      replacementCounts: new Map(),
      issues,
    };
  }
  // Match the raw literal directly. The detector normalizes entities and dash
  // typography for matching, but the repair must not decode unrelated spans:
  // replacing `&#x27;` with `'` inside a single-quoted TS literal would break
  // syntax. The raw pattern accepts the same entity/dash spellings and only
  // the matched exonym span is replaced.
  let replacements = 0;
  const replacementCounts = new Map();
  for (const issue of [...issues].sort((left, right) => right.form.length - left.form.length)) {
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])${slug ? slugTermPattern(issue.form) : rawTermPattern(issue.form)}(?![\\p{L}\\p{N}])`,
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

function parseEventsDigestBody2(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split('\n');
  const headings = [];
  const events = [];
  const eventCountsByHeading = [];
  let currentHeading = -1;
  let currentEvent = null;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line.trim()) {
      currentEvent = null;
      continue;
    }

    const headingMatch = /^(#{2,6})\s+/.exec(line);
    if (headingMatch) {
      currentHeading = headings.length;
      headings.push({ lineIndex, level: headingMatch[1].length });
      eventCountsByHeading.push(0);
      currentEvent = null;
      continue;
    }

    if (line.startsWith('- **')) {
      if (currentHeading < 0) return null;
      const separatorIndex = line.indexOf('** — ');
      if (separatorIndex < 0) return null;
      currentEvent = {
        headingIndex: currentHeading,
        lineIndices: [lineIndex],
        titleStart: separatorIndex + '** — '.length,
      };
      events.push(currentEvent);
      eventCountsByHeading[currentHeading] += 1;
      continue;
    }

    // Event titles may span lines, but only while they remain within their
    // original bullet. Any other body shape is deliberately unrecognized.
    if (!currentEvent) return null;
    currentEvent.lineIndices.push(lineIndex);
  }

  return {
    lines,
    headings,
    events,
    shape: headings.map((heading, index) => `${heading.level}:${eventCountsByHeading[index]}`),
  };
}

function transformEventsDigestBody2({ sourceText = '', targetText = '', locale } = {}) {
  const source = parseEventsDigestBody2(sourceText);
  const target = parseEventsDigestBody2(targetText);
  if (!source || !target) return null;
  if (source.shape.length !== target.shape.length
      || source.shape.some((part, index) => part !== target.shape[index])
      || source.events.length !== target.events.length) return null;

  for (let index = 0; index < source.events.length; index += 1) {
    const sourceEvent = source.events[index];
    const targetEvent = target.events[index];
    if (sourceEvent.headingIndex !== targetEvent.headingIndex
        || sourceEvent.lineIndices.length !== targetEvent.lineIndices.length) return null;
  }

  const lines = [...target.lines];
  const issues = [];
  const replacementCounts = new Map();
  let replacements = 0;
  const applyPair = (sourceValue, targetValue) => {
    const result = replaceLocalizedToponymMismatches({ sourceText: sourceValue, targetText: targetValue, locale });
    replacements += result.replacements;
    for (const issue of result.issues) {
      if (!issues.some((candidate) => issueKey(candidate) === issueKey(issue))) issues.push(issue);
    }
    for (const [key, count] of result.replacementCounts) {
      replacementCounts.set(key, (replacementCounts.get(key) || 0) + count);
    }
    return result.text;
  };

  for (let index = 0; index < source.headings.length; index += 1) {
    const sourceHeading = source.headings[index];
    const targetHeading = target.headings[index];
    lines[targetHeading.lineIndex] = applyPair(
      source.lines[sourceHeading.lineIndex],
      target.lines[targetHeading.lineIndex],
    );
  }

  for (let index = 0; index < source.events.length; index += 1) {
    const sourceEvent = source.events[index];
    const targetEvent = target.events[index];
    const sourceTitle = [
      source.lines[sourceEvent.lineIndices[0]].slice(sourceEvent.titleStart),
      ...sourceEvent.lineIndices.slice(1).map((lineIndex) => source.lines[lineIndex]),
    ].join('\n');
    const targetTitle = [
      target.lines[targetEvent.lineIndices[0]].slice(targetEvent.titleStart),
      ...targetEvent.lineIndices.slice(1).map((lineIndex) => target.lines[lineIndex]),
    ].join('\n');
    const repairedTitle = applyPair(sourceTitle, targetTitle).split('\n');
    if (repairedTitle.length !== targetEvent.lineIndices.length) return null;
    lines[targetEvent.lineIndices[0]] = target.lines[targetEvent.lineIndices[0]].slice(0, targetEvent.titleStart) + repairedTitle[0];
    for (let lineIndex = 1; lineIndex < targetEvent.lineIndices.length; lineIndex += 1) {
      lines[targetEvent.lineIndices[lineIndex]] = repairedTitle[lineIndex];
    }
  }

  return { text: lines.join('\n'), replacements, replacementCounts, issues };
}

export function findEventsDigestBody2LocalizedToponymMismatches(options = {}) {
  return transformEventsDigestBody2(options)?.issues ?? null;
}

export function replaceEventsDigestBody2LocalizedToponymMismatches(options = {}) {
  return transformEventsDigestBody2(options);
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

function omitEventsDigestBody2(projection) {
  const content = projection?.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) return projection;
  return {
    ...projection,
    content: Object.fromEntries(Object.entries(content).filter(([key]) => key !== 'body2')),
  };
}

function findEventsDigestArticleLocaleMismatches(data, locale, sourceText) {
  const sourceProjection = articleLocaleProjection(data, 'it');
  const targetProjection = articleLocaleProjection(data, locale);
  const sourceWithoutBody2 = collectStrings(omitEventsDigestBody2(sourceProjection)).join('\n');
  const targetWithoutBody2 = collectStrings({
    ...omitEventsDigestBody2(targetProjection),
    slug: undefined,
  }).join('\n');
  const issues = findLocalizedToponymMismatches({
    sourceText: sourceWithoutBody2,
    targetText: targetWithoutBody2,
    locale,
  });
  const body2Issues = findEventsDigestBody2LocalizedToponymMismatches({
    sourceText: sourceProjection.content?.body2,
    targetText: targetProjection.content?.body2,
    locale,
  });
  if (body2Issues === null) return null;
  for (const issue of body2Issues) {
    if (!issues.some((candidate) => issueKey(candidate) === issueKey(issue))) issues.push(issue);
  }

  const provisionalSlugs = new Set([
    ...(Array.isArray(data?._slugsProvisionalFromIt) ? data._slugsProvisionalFromIt : []),
    ...(Array.isArray(data?._slugI18nFallbacks)
      ? data._slugI18nFallbacks
        .map((record) => typeof record === 'string' ? record : record?.locale)
        .filter(Boolean)
      : []),
  ]);
  if (targetProjection.slug && !provisionalSlugs.has(locale)) {
    const slugIssues = findLocalizedToponymMismatches({
      sourceText,
      targetText: targetProjection.slug,
      locale,
      slug: true,
    });
    for (const issue of slugIssues) {
      if (!issues.some((candidate) => issueKey(candidate) === issueKey(issue))) issues.push(issue);
    }
  }
  return issues;
}

/** Returns the same deterministic check for the complete pre-write article. */
export function findArticleLocalizedToponymMismatches(data) {
  const source = collectStrings(articleLocaleProjection(data, 'it')).join('\n');
  if (!source.trim()) return [];

  const issues = [];
  const isEventsDigest = typeof data?.id === 'string' && data.id.startsWith('eventi-weekend-');
  for (const locale of LOCALIZED_TOPONYM_LOCALES.filter((item) => item !== 'it')) {
    const targetProjection = articleLocaleProjection(data, locale);
    let targetIssues = isEventsDigest ? findEventsDigestArticleLocaleMismatches(data, locale, source) : null;
    if (targetIssues === null) {
      const target = collectStrings({ ...targetProjection, slug: undefined }).join('\n');
      targetIssues = findLocalizedToponymMismatches({ sourceText: source, targetText: target, locale });
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
