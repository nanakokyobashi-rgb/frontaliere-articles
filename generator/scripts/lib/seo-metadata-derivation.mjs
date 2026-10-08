/**
 * Deterministic SEO metadata derivation for corpus recovery tools only.
 *
 * The normal article generator receives `ogTitle`, `headline` and `keywords`
 * from its model payload and preserves that writer contract. Recovery has no
 * model payload, so this module derives those fields from persisted Italian
 * metadata. No copywriter or model is involved here: the inputs are
 * registry/meta values, the existing clause-tail rules and the existing title
 * repair.
 */
import {
  TRAILING_STOPWORDS,
  peelDanglingClauseTail,
  truncateToClauseNonEmpty,
} from '../../../host/shared/clauseTail.mjs';
import { repairSeoTitleFields } from './seo-title-repair.mjs';

const TITLE_SUFFIX = ' | Frontaliere Ticino';
const TITLE_MAX_CHARS = 66;
const DESCRIPTION_MAX_CHARS = 160;
const OG_DESCRIPTION_MAX_CHARS = 250;
const FALLBACK_YEAR = '2026';
const KEYWORD_STOP_WORDS = new Set([
  'frontaliere', 'frontalieri', 'ticino', 'svizzera', 'italia',
  'della', 'delle', 'degli', 'come', 'guida',
]);

export function normalizeSeoTitle(value) {
  return String(value || '')
    .replace(/\s*\|\s*Frontaliere Ticino\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleWithoutDanglingTail(value) {
  const normalized = normalizeSeoTitle(value);
  if (!normalized) return normalized;
  const lastWord = /(\S+)$/.exec(normalized)?.[1]
    ?.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .toLowerCase();
  if (!TRAILING_STOPWORDS.has(lastWord)) return normalized;
  return peelDanglingClauseTail(normalized);
}

/** Extract a 4-digit year from the registry date or article id. */
export function extractArticleYear(data) {
  if (data?.date) {
    const date = new Date(data.date);
    if (!Number.isNaN(date.getTime())) return String(date.getFullYear());
  }
  return String(data?.id || '').match(/\b(20[2-3]\d)\b/)?.[1] || '';
}

/** Extract the first known place token used by the existing collision rule. */
export function extractArticleCity(slug) {
  const known = [
    ['lugano', 'Lugano'],
    ['mendrisio', 'Mendrisio'],
    ['bellinzona', 'Bellinzona'],
    ['locarno', 'Locarno'],
    ['chiasso', 'Chiasso'],
    ['ticino', 'Ticino'],
    ['milano', 'Milano'],
    ['como', 'Como'],
    ['varese', 'Varese'],
    ['lombardia', 'Lombardia'],
  ];
  const cleaned = String(slug || '').toLowerCase();
  return known.find(([key]) => cleaned.includes(key))?.[1] || '';
}

function disambiguateTitle(initialTitle, data, existingTitles, log) {
  if (!existingTitles.has(initialTitle.toLowerCase())) return initialTitle;
  const year = extractArticleYear(data);
  const city = extractArticleCity(data?.id);
  let mutated = initialTitle;
  if (year && !mutated.includes(year)) {
    mutated = `${mutated} (${year})`;
    log(`  🪪 Collisione titolo IT — aggiunto anno: "${mutated}"`);
  } else if (city && !mutated.toLowerCase().includes(city.toLowerCase())) {
    mutated = `${mutated} — ${city}`;
    log(`  🪪 Collisione titolo IT — aggiunta città: "${mutated}"`);
  }
  if (mutated !== initialTitle && !existingTitles.has(mutated.toLowerCase())) return mutated;
  log(`  ❌ Titolo IT "${initialTitle}" collide con un articolo esistente.`);
  log(`     Anno (${year || 'n/a'}) e città (${city || 'n/a'}) non bastano a disambiguare — provo un altro headline.`);
  throw new Error(`DUPLICATO: titolo IT "${initialTitle}" collide con un articolo esistente`);
}

/**
 * Mutate `data.seo` using only persisted article content and deterministic
 * repository rules.  `existingTitles` is injected so a recovery run can build
 * a stable collision set without importing the full generator.
 */
export function deriveSeoMetadata(data, { existingTitles = new Set(), log = () => {} } = {}) {
  const it = data?.content?.it || {};
  if (!data.seo || typeof data.seo !== 'object') data.seo = {};

  const rawTitle = normalizeSeoTitle(it.title || data.id || 'Articolo frontalieri');
  const initialTitle = titleWithoutDanglingTail(rawTitle) || rawTitle;
  const seoTitleCore = disambiguateTitle(initialTitle, data, existingTitles, log);
  const candidate = `${seoTitleCore}${TITLE_SUFFIX}`;
  data.seo.title = candidate.length <= TITLE_MAX_CHARS ? candidate : seoTitleCore;

  const ogTitle = data.seo.ogTitle ? titleWithoutDanglingTail(data.seo.ogTitle) : seoTitleCore;
  const headline = data.seo.headline ? titleWithoutDanglingTail(data.seo.headline) : seoTitleCore;
  data.seo.ogTitle = ogTitle || seoTitleCore;
  data.seo.headline = headline || seoTitleCore;
  for (const { field, before, after } of repairSeoTitleFields(data.seo, seoTitleCore)) {
    log(`  🔧 SEO ${field} ⇐ content.it.title ("${before}" → "${after}")`);
  }

  data.seo.breadcrumbName = truncateToClauseNonEmpty(
    data.seo.breadcrumbName || seoTitleCore.split(/[:.–—]/)[0] || 'Articolo',
    42,
  );

  const year = extractArticleYear(data) || FALLBACK_YEAR;
  let description = String(data.seo.description || it.excerpt || '').replace(/\s+/g, ' ').trim();
  if (!description) {
    description = `${seoTitleCore}. Guida pratica per frontalieri tra Ticino e Italia con dati aggiornati ${year}.`;
  }
  if (description.length < 145) {
    description = `${description}${description.endsWith('.') ? '' : '.'} Dati aggiornati ${year} per frontalieri in Ticino.`;
  }
  data.seo.description = truncateToClauseNonEmpty(description, DESCRIPTION_MAX_CHARS);
  data.seo.ogDescription = truncateToClauseNonEmpty(
    data.seo.ogDescription || data.seo.description,
    OG_DESCRIPTION_MAX_CHARS,
  );

  const isStopYear = (word) => /^(19|20)\d{2}$/.test(word);
  const terms = `${it.title || ''} ${it.excerpt || ''} ${data.id || ''}`
    .toLowerCase()
    .replace(/[^a-z0-9àèéìòùäöüßç\s-]/gi, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3 && !KEYWORD_STOP_WORDS.has(word) && !isStopYear(word));
  const uniqueTerms = [];
  for (const term of terms) {
    if (!uniqueTerms.includes(term)) uniqueTerms.push(term);
    if (uniqueTerms.length >= 4) break;
  }
  data.seo.keywords = ['frontalieri', 'ticino', 'svizzera', 'italia', ...uniqueTerms]
    .slice(0, 8)
    .join(', ');
  return data;
}

export { TITLE_MAX_CHARS, DESCRIPTION_MAX_CHARS, OG_DESCRIPTION_MAX_CHARS };
