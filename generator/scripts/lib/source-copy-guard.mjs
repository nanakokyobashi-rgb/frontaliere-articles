/**
 * Guard against publishing a generated article that copies a source verbatim.
 *
 * The guard is deliberately dependency-free: generation tests run with
 * `node --test` before the full npm install, and the same tokenisation must be
 * used by the producer and by its regression tests.
 */

export const SOURCE_COPY_OVERLAP_THRESHOLD = 12;
export const SOURCE_COPY_MAX_ATTRIBUTED_QUOTES = 2;
export const SOURCE_COPY_MAX_QUOTE_WORDS = 25;
export const SOURCE_COPY_MAX_RETRIES = 2;

const WORD_RX = /[\p{L}\p{N}]+/gu;
const QUOTED_SPAN_RX = /«([^»\n]{1,4000})»|“([^”\n]{1,4000})”|„([^“\n]{1,4000})“|"([^"\n]{1,4000})"/gu;
const ATTRIBUTION_RX = /\b(?:secondo|stando a|come riferisce|ha detto|ha dichiarato|dichiara|afferma|spiega|osserva|sostiene|scrive|riferisce|dice|said|told|according to|reports?|states?|explains?|laut|sagte|erklärt|berichtet|selon|a déclaré|explique|rapporte)\b/iu;

function localeTag(locale) {
  const value = String(locale || 'it').toLowerCase().split(/[-_]/)[0];
  return ['it', 'de', 'fr', 'en'].includes(value) ? value : 'it';
}
function stripMarkup(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/gi, ' ');
}

function canonicalWord(value, locale = 'it') {
  return String(value)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase(localeTag(locale));
}

/**
 * Return normalized comparison words. It/de/fr/en use the same conservative
 * rule: accents and case are ignored, but no stemming or synonym expansion is
 * performed, so the guard only rejects an actual consecutive copy.
 */
export function normalizeSourceWords(text, locale = 'it') {
  const source = stripMarkup(text);
  return [...source.matchAll(WORD_RX)].map((match) => canonicalWord(match[0], locale));
}

function bodyText(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return ['body1', 'body2', 'body3']
    .map((field) => value[field] || '')
    .filter(Boolean)
    .join('\n');
}

function isAttributedQuote(source, start, end) {
  const context = `${source.slice(Math.max(0, start - 100), start)} ${source.slice(end, Math.min(source.length, end + 100))}`;
  return ATTRIBUTION_RX.test(context);
}

/** Remove only short, attributed quotations allowed by the editorial rule. */
function removeAllowedQuotes(text, locale) {
  const source = stripMarkup(text);
  let allowed = 0;
  let allowedQuotes = 0;
  const cleaned = source.replace(QUOTED_SPAN_RX, (whole, ...args) => {
    const groups = args.slice(0, 4);
    const inner = groups.find((value) => typeof value === 'string') || '';
    // With four capture groups, String#replace appends the numeric offset and
    // the full input after those groups. The old code treated that offset as
    // a match object, so every quote was attributed as if it started at 0 and
    // attribution near the actual quote was silently ignored.
    const start = Number.isInteger(args[4]) ? args[4] : 0;
    const end = start + whole.length;
    const words = normalizeSourceWords(inner, locale).length;
    if (
      allowedQuotes < SOURCE_COPY_MAX_ATTRIBUTED_QUOTES
      && words > 0
      && words <= SOURCE_COPY_MAX_QUOTE_WORDS
      && isAttributedQuote(source, start, end)
    ) {
      allowedQuotes += 1;
      allowed += words;
      return ' ';
    }
    return whole;
  });
  return { text: cleaned, allowedQuotes, allowedQuoteWords: allowed };
}

/**
 * Find the longest exact consecutive word run shared by source and article.
 * The returned offsets are token offsets, not character offsets.
 */
export function maxConsecutiveSourceOverlap(sourceText, articleText, { locale = 'it' } = {}) {
  const sourceWords = normalizeSourceWords(sourceText, locale);
  const quoteResult = removeAllowedQuotes(bodyText(articleText), locale);
  const articleWords = normalizeSourceWords(quoteResult.text, locale);
  const positions = new Map();
  sourceWords.forEach((word, index) => {
    const list = positions.get(word) || [];
    list.push(index);
    positions.set(word, list);
  });

  let maxWords = 0;
  let sourceStart = -1;
  let articleStart = -1;
  for (let articleIndex = 0; articleIndex < articleWords.length; articleIndex += 1) {
    const candidates = positions.get(articleWords[articleIndex]) || [];
    for (const sourceIndex of candidates) {
      let length = 0;
      while (
        articleIndex + length < articleWords.length
        && sourceIndex + length < sourceWords.length
        && articleWords[articleIndex + length] === sourceWords[sourceIndex + length]
      ) length += 1;
      if (length > maxWords) {
        maxWords = length;
        sourceStart = sourceIndex;
        articleStart = articleIndex;
      }
    }
  }
  return {
    maxWords,
    sourceStart,
    articleStart,
    allowedQuotes: quoteResult.allowedQuotes,
    allowedQuoteWords: quoteResult.allowedQuoteWords,
    sourceWordCount: sourceWords.length,
    articleWordCount: articleWords.length,
  };
}

export function evaluateSourceCopy(sourceText, articleText, {
  locale = 'it',
  threshold = SOURCE_COPY_OVERLAP_THRESHOLD,
} = {}) {
  const overlap = maxConsecutiveSourceOverlap(sourceText, articleText, { locale });
  return {
    ...overlap,
    locale: localeTag(locale),
    threshold,
    safe: overlap.maxWords < threshold,
  };
}

export function logSourceCopyVerdict(articleId, verdict, logger = console.error) {
  logger(
    `[source-copy] article=${String(articleId || 'unknown')} locale=${verdict.locale || 'it'}`
      + ` max_overlap=${verdict.maxWords} threshold=${verdict.threshold ?? SOURCE_COPY_OVERLAP_THRESHOLD}`
      + ` allowed_quotes=${verdict.allowedQuotes || 0}`,
  );
}

export class SourceCopyError extends Error {
  constructor(message, verdict, { retries = 0 } = {}) {
    super(message);
    this.name = 'SourceCopyError';
    this.sourceCopyReject = true;
    this.qualityReject = true;
    this.verdict = verdict;
    this.retries = retries;
  }
}

/**
 * Small orchestration helper used by tests and by producers that can isolate
 * their text call. `generate` receives a deterministic rephrase instruction
 * after every rejected draft; after the retry cap it fails closed.
 */
export async function generateWithSourceCopyGuard({
  sourceText,
  generate,
  articleId = 'unknown',
  locale = 'it',
  maxRetries = SOURCE_COPY_MAX_RETRIES,
  logger = console.error,
} = {}) {
  if (typeof generate !== 'function') throw new TypeError('generate must be a function');
  const retryLimit = Math.max(0, Number.isInteger(maxRetries) ? maxRetries : SOURCE_COPY_MAX_RETRIES);
  let lastVerdict = null;
  for (let retry = 0; retry <= retryLimit; retry += 1) {
    const draft = await generate({
      retry,
      instruction: retry === 0
        ? ''
        : `Riformula indipendentemente il testo: non riutilizzare sequenze di ${SOURCE_COPY_OVERLAP_THRESHOLD} parole consecutive della fonte.`,
    });
    lastVerdict = evaluateSourceCopy(sourceText, draft, { locale });
    logSourceCopyVerdict(articleId, lastVerdict, logger);
    if (lastVerdict.safe) return { draft, verdict: lastVerdict, retries: retry };
  }
  throw new SourceCopyError(
    `Source-copy guard failed after ${retryLimit} retries: max overlap ${lastVerdict?.maxWords || 0} words (threshold ${SOURCE_COPY_OVERLAP_THRESHOLD})`,
    lastVerdict,
    { retries: retryLimit },
  );
}
