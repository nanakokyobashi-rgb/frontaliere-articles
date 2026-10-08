/**
 * Plain-text contract for the short excerpt and the metadata descriptions
 * derived from it.
 *
 * Article bodies are Markdown, but an excerpt is a reader-facing sentence:
 * it is emitted into locale metadata, cards, feeds and SEO surfaces.  Keep
 * the repair deterministic and small enough to use without loading the
 * generator's model/network dependencies.
 */

const LABEL_RE = /^(?:In breve|In short|Kurz gesagt|En bref)\b/i;
const LABEL_START_RE = /^(?:#{1,6}\s*)?(?:In breve|In short|Kurz gesagt|En bref)\b/i;
const LABEL_PREFIX_RE = /^(?:In breve|In short|Kurz gesagt|En bref)\s*(?::|[-–—])?\s*/i;
const HEADING_RE = /^\s*#{1,6}\s+(.+?)\s*$/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+\.)\s+\S/;
const DATE_PREFIX_RE = /^\s*(?:0?[1-9]|[12]\d|3[01])\.\s+(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre|january|february|march|april|may|june|july|august|september|october|november|december|januar|februar|märz|mai|juni|juli|oktober|dezember|janvier|février|juin|juillet|août|septembre|octobre|décembre)\b/iu;
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const TABLE_ROW_RE = /^\s*\|?[^\n|]+\|[^\n]*\|?\s*$/;
const REFERENCE_LINK_RE = /\[[^\]\n]+\]\[[^\]\n]*\]/;
const REFERENCE_DEFINITION_LINE_RE = /^\s{0,3}\[[^\]\n]+\]:\s+\S+/m;
const HORIZONTAL_RULE_LINE_RE = /^\s{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})\s*$/;

const PLAIN_DESCRIPTION_FIELDS = Object.freeze([
  'excerpt',
  'seoDescription',
  'ogDescription',
  'description',
]);

function hasTableSyntax(value) {
  const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n');
  return lines.some((line, index) => {
    if (TABLE_SEPARATOR_RE.test(line)) return true;
    if (!TABLE_ROW_RE.test(line)) return false;
    return TABLE_SEPARATOR_RE.test(lines[index - 1] || '')
      || TABLE_SEPARATOR_RE.test(lines[index + 1] || '')
      || /^\s*\|[^|]+\|/.test(line);
  });
}

function hasHorizontalRuleSyntax(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .some((line) => HORIZONTAL_RULE_LINE_RE.test(line));
}

function hasListSyntax(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .some((line) => LIST_ITEM_RE.test(line) && !DATE_PREFIX_RE.test(line));
}

/**
 * Return the Markdown constructs that make a value invalid as an excerpt.
 * The names are stable so callers can put the reason in a gate diagnostic.
 */
export function findExcerptMarkdownDefects(value) {
  const text = String(value ?? '');
  const defects = [];
  if (/(?:^|\n)\s{0,3}#{1,6}\s+\S/m.test(text)) defects.push('heading');
  if (hasListSyntax(text)) defects.push('list');
  if (/\*\*[^*\n]+\*\*/.test(text)) defects.push('bold');
  if (/(?<![\w*])\*(?!\*)[^*\n]+(?<!\*)\*(?!\*)|(?<![\w_])_(?!_)[^_\n]+(?<!_)_(?!_)/.test(text)) defects.push('italic');
  if (/\[[^\]]+\]\([^)]*\)/.test(text)) defects.push('link');
  if (REFERENCE_LINK_RE.test(text) || REFERENCE_DEFINITION_LINE_RE.test(text)) defects.push('reference-link');
  if (hasTableSyntax(text)) defects.push('table');
  if (hasHorizontalRuleSyntax(text)) defects.push('horizontal-rule');
  if (/`[^`\n]+`/.test(text)) defects.push('code');
  if (/(?:^|\n)\s*>\s*\S/m.test(text)) defects.push('blockquote');
  if (/~~[^~\n]+~~/.test(text)) defects.push('strike');
  if (LABEL_START_RE.test(text.trim())) defects.push('label');
  return defects;
}

function cleanMarkdownLines(value) {
  const source = String(value ?? '').replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  const cleaned = [];

  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    if (TABLE_SEPARATOR_RE.test(line) || HORIZONTAL_RULE_LINE_RE.test(line) || REFERENCE_DEFINITION_LINE_RE.test(line)) continue;

    const heading = line.match(HEADING_RE);
    if (heading) {
      const headingText = heading[1].trim();
      // Keep the useful part of the historical `## In breve - ...` shape,
      // while dropping real body section headings altogether.
      line = LABEL_RE.test(headingText) ? headingText : '';
    }
    if (!line.trim()) {
      cleaned.push('');
      continue;
    }

    if (TABLE_ROW_RE.test(line)) {
      line = line
        .replace(/^\s*\|/, '')
        .replace(/\|\s*$/, '')
        .replace(/\s*\|\s*/g, ' ');
    }

    if (!DATE_PREFIX_RE.test(line)) {
      line = line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '');
    }
    line = line
      .replace(/^\s*>\s?/, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]\n]+)\]\[[^\]\n]*\]/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/`{1,3}([^`\n]+)`{1,3}/g, '$1')
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .replace(/__([^_\n]+)__/g, '$1')
      .replace(/~~([^~\n]+)~~/g, '$1')
      .replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '$1')
      .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '$1')
      // A malformed/unpaired marker is still Markdown syntax.  Removing the
      // marker is safer for a card/description than leaking it publicly.
      .replace(/[\*_`]/g, '')
      .replace(/\|/g, ' ')
      .trim();
    cleaned.push(line);
  }

  return cleaned.join('\n');
}

/** Strip Markdown and labels, retaining all useful prose sentences. */
export function stripExcerptMarkdown(value) {
  return cleanMarkdownLines(value)
    .replace(/\s+/g, ' ')
    .replace(LABEL_PREFIX_RE, '')
    .trim();
}

function isUsefulSentence(value) {
  const sentence = String(value || '').trim();
  return sentence.length >= 12
    && /\p{L}/u.test(sentence)
    && !LABEL_RE.test(sentence);
}

/**
 * Deterministically choose one useful sentence from a generated excerpt or
 * body fallback.  If punctuation is absent, a dash-separated bullet summary
 * supplies the next-best sentence boundary.
 */
export function normalizeExcerpt(value) {
  const plain = stripExcerptMarkdown(value);
  if (!plain) return '';

  const sentence = plain.match(/^(.+?[.!?])(?:\s|$)/u)?.[1]?.trim();
  if (sentence && isUsefulSentence(sentence)) return sentence;

  const fragments = plain
    .split(/\s+[-–—]\s+/)
    .map((fragment) => fragment.trim())
    .filter(Boolean);
  const firstUseful = fragments.find(isUsefulSentence);
  if (firstUseful) return firstUseful;
  return plain;
}

/** Throw the publication gate for Markdown in a reader-facing description. */
export function assertPlainExcerpt(value, { field = 'excerpt', id = 'unknown', locale = 'unknown' } = {}) {
  const defects = findExcerptMarkdownDefects(value);
  if (defects.length > 0) {
    throw new Error(`[excerpt-plain] ${locale}/${id}/${field} contiene Markdown (${defects.join(', ')})`);
  }
  return value;
}

/**
 * Assert every reader-facing description in a record before its writer emits
 * it.  The normal generator, same-day refresh and SEO recovery use different
 * writers, so the shared field list keeps their guards in lockstep.
 */
export function assertPlainDescriptionFields(fields, {
  fieldPrefix = '',
  id = 'unknown',
  locale = 'unknown',
} = {}) {
  for (const field of PLAIN_DESCRIPTION_FIELDS) {
    const value = fields?.[field];
    if (typeof value !== 'string' || value.trim() === '') continue;
    assertPlainExcerpt(value, { field: `${fieldPrefix}${field}`, id, locale });
  }
  return fields;
}
