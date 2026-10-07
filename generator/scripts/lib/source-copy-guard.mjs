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
export const SOURCE_COPY_MAX_REPAIR_PASSES = SOURCE_COPY_MAX_RETRIES + 1;
export const SOURCE_COPY_STRUCTURAL_OVERLAP_WORDS = 40;
export const SOURCE_COPY_STRUCTURAL_COVERAGE_RATIO = 0.30;
export const SOURCE_COPY_EXEMPTION_MAX_WORDS = 24;
export const ARTICLE_SOURCE_COPY_MODE_ENV = 'ARTICLE_SOURCE_COPY_MODE';
export const SOURCE_COPY_DEFAULT_MODE = 'repair';
export const SOURCE_COPY_MODES = Object.freeze(['warn', 'repair', 'enforce']);

/**
 * Resolve the production switch fail-safe. `repair` is the safe production
 * default: it can change only the paragraphs named by this guard. `warn` is
 * advisory and `enforce` keeps the strict publication veto for a residual
 * overlap after targeted repair/condensation.
 */
export function getSourceCopyMode(value = process.env[ARTICLE_SOURCE_COPY_MODE_ENV]) {
  const mode = String(value ?? '').trim().toLowerCase();
  return SOURCE_COPY_MODES.includes(mode) ? mode : SOURCE_COPY_DEFAULT_MODE;
}

export function sourceCopyModeBlocks(mode = getSourceCopyMode()) {
  return getSourceCopyMode(mode) === 'enforce';
}

const WORD_RX = /[\p{L}\p{N}]+/gu;
const QUOTED_SPAN_RX = /«([^»\n]{1,4000})»|“([^”\n]{1,4000})”|„([^“\n]{1,4000})“|"([^"\n]{1,4000})"/gu;
const ATTRIBUTION_RX = /\b(?:secondo|stando a|come riferisce|ha detto|ha dichiarato|dichiara|afferma|spiega|osserva|sostiene|scrive|riferisce|dice|said|told|according to|reports?|states?|explains?|laut|sagte|erklärt|berichtet|selon|a déclaré|explique|rapporte)\b/iu;
const OFFICIAL_NAME_WORDS = new Set([
  'accordo', 'accordi', 'agreement', 'abkommen', 'act', 'authority', 'autorita',
  'agenzia', 'agency', 'amministrazione', 'behorde', 'canton', 'cantonale',
  'consiglio', 'council', 'convenzione', 'conventions', 'dipartimento',
  'direttiva', 'directive', 'ente', 'federale', 'federal', 'gesetz', 'istituto',
  'legge', 'law', 'ministero', 'ministry', 'parlamento', 'parliament',
  'regolamento', 'regulation', 'trattato', 'treaty', 'ufficio', 'office',
  'dell', 'delle', 'economia', 'imposte',
  'vereinbarung', 'verordnung',
]);
const DATE_WORDS = new Set([
  'aprile', 'agosto', 'dicembre', 'febbraio', 'gennaio', 'giugno', 'luglio',
  'marzo', 'maggio', 'novembre', 'ottobre', 'settembre', 'april', 'august',
  'december', 'february', 'january', 'june', 'july', 'march', 'may',
  'november', 'october', 'september', 'avril', 'decembre', 'fevrier', 'janvier',
  'juin', 'juillet', 'mai', 'oktober', 'dezember', 'februar', 'januar', 'juni',
  'juli', 'marz',
]);

function localeTag(locale) {
  const value = String(locale || 'it').toLowerCase().split(/[-_]/)[0];
  return ['it', 'de', 'fr', 'en'].includes(value) ? value : 'it';
}
function stripMarkup(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/gi, ' ');
}

function stripMarkupWithOffsets(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, (tag) => ' '.repeat(tag.length))
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/gi, (entity) => ' '.repeat(entity.length));
}

function canonicalWord(value, locale = 'it') {
  return String(value)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase(localeTag(locale));
}

function tokeniseWithOffsets(value, locale = 'it') {
  const text = stripMarkupWithOffsets(value);
  return [...text.matchAll(WORD_RX)].map((match) => ({
    word: canonicalWord(match[0], locale),
    raw: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
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

function bodyFields(value) {
  if (!value || typeof value !== 'object' || typeof value === 'string') {
    return [{ field: null, text: String(value ?? '') }];
  }
  return ['body1', 'body2', 'body3']
    .filter((field) => typeof value[field] === 'string' && value[field])
    .map((field) => ({ field, text: value[field] }));
}

function isAttributedQuote(source, start, end) {
  const context = `${source.slice(Math.max(0, start - 100), start)} ${source.slice(end, Math.min(source.length, end + 100))}`;
  return ATTRIBUTION_RX.test(context);
}

/** Remove only short, attributed quotations allowed by the editorial rule. */
function removeAllowedQuotes(text, locale) {
  const source = stripMarkupWithOffsets(text);
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
      // Preserve character offsets so a later targeted repair can address the
      // original paragraph even after allowed quotations are removed from the
      // comparison text.
      return ' '.repeat(whole.length);
    }
    return whole;
  });
  return { text: cleaned, allowedQuotes, allowedQuoteWords: allowed };
}

/**
 * A short sequence is exempt when at least half of its words are visibly
 * proper names, official denominations, dates, or figures. The cap is
 * deliberately below the 25-word quotation allowance: a long copied passage
 * cannot hide behind a list of names or numbers.
 */
function sourceCopyExemption(sourceTokens, start, end, sourceText) {
  const length = end - start;
  if (length > SOURCE_COPY_EXEMPTION_MAX_WORDS) return { exempt: false, reason: null };
  const counts = { proper: 0, official: 0, figure: 0 };
  const special = new Set();
  for (let index = start; index < end; index += 1) {
    const token = sourceTokens[index];
    const before = sourceText.slice(0, token.start).trimEnd();
    const sentenceStart = !before || /[.!?]\s*$/u.test(before);
    const isProper = /^\p{Lu}/u.test(token.raw) && !sentenceStart;
    const isAcronym = /^[A-ZÀ-ÖØ-Þ]{2,}[A-Z0-9À-ÖØ-Þ-]*$/u.test(token.raw);
    const isOfficial = isAcronym || OFFICIAL_NAME_WORDS.has(token.word);
    const isFigure = /\d/u.test(token.raw) || DATE_WORDS.has(token.word);
    if (isProper) counts.proper += 1;
    if (isOfficial) counts.official += 1;
    if (isFigure) counts.figure += 1;
    if (isProper || isOfficial || isFigure) special.add(index);
  }
  if (special.size > 0 && special.size * 2 >= length) {
    const labels = { proper: 'nomi-propri', official: 'denominazioni-ufficiali', figure: 'date-cifre' };
    const reasons = Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([key]) => labels[key]);
    return { exempt: true, reason: reasons.join('+') };
  }
  return { exempt: false, reason: null };
}

function mergeTokenIntervals(intervals) {
  const merged = [];
  for (const interval of [...intervals].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const previous = merged.at(-1);
    if (previous && interval[0] <= previous[1]) {
      previous[1] = Math.max(previous[1], interval[1]);
    } else {
      merged.push([...interval]);
    }
  }
  return merged;
}

function compareSourceCopy(sourceText, articleText, { locale = 'it', threshold = SOURCE_COPY_OVERLAP_THRESHOLD } = {}) {
  const sourceValue = String(sourceText ?? '');
  const articleValue = bodyText(articleText);
  const sourceTokens = tokeniseWithOffsets(sourceValue, locale);
  const quoteResult = removeAllowedQuotes(articleValue, locale);
  const articleTokens = tokeniseWithOffsets(quoteResult.text, locale);
  const positions = new Map();
  sourceTokens.forEach((token, index) => {
    const list = positions.get(token.word) || [];
    list.push(index);
    positions.set(token.word, list);
  });

  let maxWords = 0;
  let sourceStart = -1;
  let articleStart = -1;
  let rawMaxWords = 0;
  const sequences = [];
  for (let articleIndex = 0; articleIndex < articleTokens.length; articleIndex += 1) {
    const candidates = positions.get(articleTokens[articleIndex].word) || [];
    for (const sourceIndex of candidates) {
      let length = 0;
      while (
        articleIndex + length < articleTokens.length
        && sourceIndex + length < sourceTokens.length
        && articleTokens[articleIndex + length].word === sourceTokens[sourceIndex + length].word
      ) length += 1;
      rawMaxWords = Math.max(rawMaxWords, length);
      const exemption = sourceCopyExemption(sourceTokens, sourceIndex, sourceIndex + length, sourceValue);
      if (!exemption.exempt && length > maxWords) {
        maxWords = length;
        sourceStart = sourceIndex;
        articleStart = articleIndex;
      }
      if (length >= threshold) {
        const sourceFirst = sourceTokens[sourceIndex];
        const sourceLast = sourceTokens[sourceIndex + length - 1];
        const articleFirst = articleTokens[articleIndex];
        const articleLast = articleTokens[articleIndex + length - 1];
        sequences.push({
          words: length,
          sourceStart: sourceIndex,
          sourceEnd: sourceIndex + length,
          articleStart: articleIndex,
          articleEnd: articleIndex + length,
          sourceCharStart: sourceFirst.start,
          sourceCharEnd: sourceLast.end,
          articleCharStart: articleFirst.start,
          articleCharEnd: articleLast.end,
          sourceText: sourceValue.slice(sourceFirst.start, sourceLast.end),
          articleText: articleValue.slice(articleFirst.start, articleLast.end),
          exempt: exemption.exempt,
          exemptionReason: exemption.reason,
        });
      }
    }
  }
  const unsafeSequences = sequences.filter((sequence) => !sequence.exempt);
  const covered = mergeTokenIntervals(unsafeSequences.map((sequence) => [sequence.articleStart, sequence.articleEnd]));
  const coverageWords = covered.reduce((total, [start, end]) => total + end - start, 0);
  const articleWordCount = articleTokens.length;
  return {
    maxWords,
    sourceStart,
    articleStart,
    rawMaxWords,
    sequences,
    unsafeSequences,
    coverageWords,
    coverageRatio: articleWordCount > 0 ? coverageWords / articleWordCount : 0,
    structural: maxWords >= SOURCE_COPY_STRUCTURAL_OVERLAP_WORDS
      || (articleWordCount > 0 && coverageWords / articleWordCount > SOURCE_COPY_STRUCTURAL_COVERAGE_RATIO),
    allowedQuotes: quoteResult.allowedQuotes,
    allowedQuoteWords: quoteResult.allowedQuoteWords,
    sourceWordCount: sourceTokens.length,
    articleWordCount,
    threshold,
    locale: localeTag(locale),
  };
}

/** Return every threshold-sized exact run, with character offsets for repair. */
export function findSourceCopySequences(sourceText, articleText, {
  locale = 'it',
  threshold = SOURCE_COPY_OVERLAP_THRESHOLD,
} = {}) {
  return compareSourceCopy(sourceText, articleText, { locale, threshold }).sequences;
}

/**
 * Find the longest exact consecutive word run shared by source and article.
 * The returned offsets include both token and character positions. Runs made
 * mostly of names/official denominations/dates/figures are reported but do
 * not contribute to the blocking overlap.
 */
export function maxConsecutiveSourceOverlap(sourceText, articleText, { locale = 'it', threshold = SOURCE_COPY_OVERLAP_THRESHOLD } = {}) {
  return compareSourceCopy(sourceText, articleText, { locale, threshold });
}

export function evaluateSourceCopy(sourceText, articleText, {
  locale = 'it',
  threshold = SOURCE_COPY_OVERLAP_THRESHOLD,
} = {}) {
  const overlap = compareSourceCopy(sourceText, articleText, { locale, threshold });
  return {
    ...overlap,
    locale: localeTag(locale),
    threshold,
    safe: overlap.maxWords < threshold,
  };
}

function splitParagraphRanges(text) {
  const ranges = [];
  let offset = 0;
  for (const part of String(text ?? '').split(/(\n{2,})/u)) {
    const start = offset;
    offset += part.length;
    if (!/^\n{2,}$/u.test(part) && part.trim()) ranges.push({ start, end: start + part.length, text: part });
  }
  return ranges;
}

function bodyFieldRanges(article) {
  const fields = bodyFields(article);
  let offset = 0;
  return fields.map(({ field, text }) => {
    const range = { field, text, start: offset, end: offset + text.length };
    offset = range.end + 1;
    return range;
  });
}

/** Locate the paragraphs named by the verdict; only these may be sent to a model. */
export function sourceCopyRepairTargets(article, verdict, { threshold = SOURCE_COPY_OVERLAP_THRESHOLD } = {}) {
  const fields = bodyFieldRanges(article);
  const targets = [];
  const seen = new Set();
  for (const sequence of verdict?.sequences || []) {
    if (sequence.exempt || sequence.words < threshold) continue;
    const field = fields.find((candidate) => sequence.articleCharStart >= candidate.start && sequence.articleCharStart < candidate.end)
      || fields.at(-1);
    if (!field) continue;
    const localStart = Math.max(0, sequence.articleCharStart - field.start);
    const localEnd = Math.min(field.text.length, sequence.articleCharEnd - field.start);
    const paragraphs = splitParagraphRanges(field.text);
    const paragraph = paragraphs.find((candidate) => localStart >= candidate.start && localStart < candidate.end)
      || paragraphs.find((candidate) => localEnd > candidate.start && localEnd <= candidate.end);
    if (!paragraph) continue;
    const key = `${String(field.field)}:${paragraph.start}:${paragraph.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({
      ...sequence,
      field: field.field,
      paragraphIndex: paragraphs.indexOf(paragraph),
      paragraphText: paragraph.text,
      paragraphStart: paragraph.start,
      paragraphEnd: paragraph.end,
      localCharStart: Math.max(0, localStart - paragraph.start),
      localCharEnd: Math.max(0, localEnd - paragraph.start),
    });
  }
  return targets;
}

function replaceParagraphs(article, replacements) {
  if (!Array.isArray(replacements) || replacements.length === 0) return article;
  const clone = typeof article === 'string' ? article : { ...(article || {}) };
  const grouped = new Map();
  for (const replacement of replacements) {
    if (!replacement || typeof replacement.text !== 'string') continue;
    const key = String(replacement.field ?? '__string__');
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(replacement);
  }
  for (const [key, items] of grouped) {
    const field = key === '__string__' ? null : key;
    const current = field === null ? clone : clone?.[field];
    if (typeof current !== 'string') continue;
    const ranges = splitParagraphRanges(current);
    let next = current;
    for (const item of items.sort((a, b) => Number(b.paragraphIndex) - Number(a.paragraphIndex))) {
      const range = ranges[Number(item.paragraphIndex)];
      if (!range) continue;
      const text = item.text.trim();
      next = next.slice(0, range.start) + text + next.slice(range.end);
    }
    if (field === null) {
      return next;
    }
    clone[field] = next;
  }
  return clone;
}

/** Apply only model-approved replacements to the named body paragraphs. */
export function applySourceCopyRepairReplacements(article, replacements) {
  return replaceParagraphs(article, replacements);
}

function sentenceRange(text, start, end) {
  const before = String(text).slice(0, start);
  const punctuation = [...before.matchAll(/[.!?](?:["'»”)]*)?/gu)].at(-1);
  let sentenceStart = punctuation ? punctuation.index + punctuation[0].length : 0;
  while (/\s/u.test(text[sentenceStart] || '')) sentenceStart += 1;
  const tail = String(text).slice(Math.max(start, end));
  const match = tail.match(/[.!?](?:["'»”)]*)?(?=\s|$)/u);
  const sentenceEnd = match ? Math.max(start, end) + match.index + match[0].length : String(text).length;
  return { start: sentenceStart, end: sentenceEnd };
}

/** Deterministic last resort: remove/condense the sentence containing a run. */
export function condenseSourceCopyArticle(article, verdict, { threshold = SOURCE_COPY_OVERLAP_THRESHOLD } = {}) {
  const targets = sourceCopyRepairTargets(article, verdict, { threshold });
  const replacements = [];
  const seen = new Set();
  for (const target of targets) {
    const range = sentenceRange(target.paragraphText, target.localCharStart, target.localCharEnd);
    const key = `${String(target.field)}:${target.paragraphIndex}:${range.start}:${range.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const compacted = `${target.paragraphText.slice(0, range.start).trimEnd()} ${target.paragraphText.slice(range.end).trimStart()}`.trim();
    replacements.push({ field: target.field, paragraphIndex: target.paragraphIndex, text: compacted });
  }
  return {
    article: applySourceCopyRepairReplacements(article, replacements),
    changed: replacements.length > 0,
    removedSentences: replacements.length,
  };
}

function articleBodySignature(article) {
  return JSON.stringify(bodyFields(article).map(({ field, text }) => [field, text]));
}

export async function repairSourceCopyArticle({
  sourceText,
  article,
  articleId = 'unknown',
  locale = 'it',
  mode = getSourceCopyMode(),
  threshold = SOURCE_COPY_OVERLAP_THRESHOLD,
  maxPasses = SOURCE_COPY_MAX_REPAIR_PASSES,
  repair,
  condense = condenseSourceCopyArticle,
  logger = console.error,
} = {}) {
  const sourceCopyMode = getSourceCopyMode(mode);
  let current = article;
  let verdict = evaluateSourceCopy(sourceText, current, { locale, threshold });
  logSourceCopyVerdict(articleId, verdict, logger, sourceCopyMode, 'initial');
  if (verdict.safe) {
    logSourceCopyVerdict(articleId, verdict, logger, sourceCopyMode, 'outcome=safe');
    return { article: current, verdict, passes: 0, outcome: 'safe', rejected: false };
  }
  if (sourceCopyMode === 'warn') {
    logSourceCopyVerdict(articleId, verdict, logger, sourceCopyMode, 'outcome=warn');
    return { article: current, verdict, passes: 0, outcome: 'warn', rejected: false };
  }

  let passes = 0;
  const passLimit = Math.max(0, Math.min(SOURCE_COPY_MAX_REPAIR_PASSES, Number(maxPasses) || SOURCE_COPY_MAX_REPAIR_PASSES));
  for (let pass = 1; pass <= passLimit; pass += 1) {
    const targets = sourceCopyRepairTargets(current, verdict, { threshold });
    if (!targets.length || typeof repair !== 'function') break;
    let next;
    try {
      next = await repair({ article: current, sourceText, locale, verdict, targets, pass });
    } catch (error) {
      logger(`[source-copy] article=${String(articleId || 'unknown')} locale=${localeTag(locale)} pass=${pass} repair_error=${error.message}`);
      break;
    }
    if (next == null || articleBodySignature(next) === articleBodySignature(current)) break;
    current = next;
    passes = pass;
    verdict = evaluateSourceCopy(sourceText, current, { locale, threshold });
    logSourceCopyVerdict(articleId, verdict, logger, sourceCopyMode, `repair-${pass}`);
    if (verdict.safe) {
      logSourceCopyVerdict(articleId, verdict, logger, sourceCopyMode, 'outcome=repaired');
      return { article: current, verdict, passes, outcome: 'repaired', rejected: false };
    }
  }

  const condensed = typeof condense === 'function'
    ? await condense(current, verdict, { locale, threshold })
    : { article: current, changed: false };
  if (condensed?.changed && condensed.article != null) {
    current = condensed.article;
    verdict = evaluateSourceCopy(sourceText, current, { locale, threshold });
    logSourceCopyVerdict(articleId, verdict, logger, sourceCopyMode, 'condense');
  }
  const rejected = verdict.structural || (sourceCopyModeBlocks(sourceCopyMode) && !verdict.safe);
  const outcome = rejected ? 'rejected' : (verdict.safe ? 'repaired' : 'published-residual');
  logSourceCopyVerdict(articleId, verdict, logger, sourceCopyMode, `outcome=${outcome}`);
  return { article: current, verdict, passes, outcome, rejected };
}

export function logSourceCopyVerdict(articleId, verdict, logger = console.error, mode = getSourceCopyMode(), phase = 'verdict') {
  const effectiveMode = getSourceCopyMode(mode);
  logger(
    `[source-copy] article=${String(articleId || 'unknown')} locale=${verdict.locale || 'it'}`
      + ` max_overlap=${verdict.maxWords} threshold=${verdict.threshold ?? SOURCE_COPY_OVERLAP_THRESHOLD}`
      + ` mode=${effectiveMode} phase=${phase} allowed_quotes=${verdict.allowedQuotes || 0}`
      + ` coverage=${((verdict.coverageRatio || 0) * 100).toFixed(1)}% structural=${verdict.structural ? 1 : 0}`,
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
  mode = getSourceCopyMode(),
  maxRetries = SOURCE_COPY_MAX_RETRIES,
  logger = console.error,
} = {}) {
  if (typeof generate !== 'function') throw new TypeError('generate must be a function');
  const sourceCopyMode = getSourceCopyMode(mode);
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
    logSourceCopyVerdict(articleId, lastVerdict, logger, sourceCopyMode);
    if (lastVerdict.safe || !sourceCopyModeBlocks(sourceCopyMode)) {
      return { draft, verdict: lastVerdict, retries: retry };
    }
  }
  throw new SourceCopyError(
    `Source-copy guard failed after ${retryLimit} retries: max overlap ${lastVerdict?.maxWords || 0} words (threshold ${SOURCE_COPY_OVERLAP_THRESHOLD})`,
    lastVerdict,
    { retries: retryLimit },
  );
}
