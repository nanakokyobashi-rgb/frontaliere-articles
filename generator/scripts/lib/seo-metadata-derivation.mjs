/**
 * Deterministic SEO metadata derivation for corpus recovery tools only.
 *
 * The normal article generator receives `ogTitle`, `headline` and `keywords`
 * from its model payload and preserves that writer contract. Recovery has no
 * model payload, so this module derives those fields from persisted Italian
 * metadata. No copywriter or model is involved here: the inputs are
 * registry/meta values and the existing clause-tail rules. The persisted
 * Italian title is never shortened or disambiguated here: recovery does not
 * also rewrite the paired locale meta surface.
 */
import { truncateToClauseNonEmpty } from '../../../host/shared/clauseTail.mjs';

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

/** Extract a 4-digit year from the registry date or article id. */
export function extractArticleYear(data) {
  if (data?.date) {
    const date = new Date(data.date);
    if (!Number.isNaN(date.getTime())) return String(date.getFullYear());
  }
  return String(data?.id || '').match(/\b(20[2-3]\d)\b/)?.[1] || '';
}

/**
 * Mutate `data.seo` using only persisted article content and deterministic
 * repository rules. The persisted Italian meta title is the source of truth:
 * recovery fills the missing SEO entry and must not invent a different H1 or
 * JSON-LD headline without updating the paired `blog-meta-it` surface.
 */
export function deriveSeoMetadata(data) {
  const it = data?.content?.it || {};
  if (!data.seo || typeof data.seo !== 'object') data.seo = {};

  const rawTitle = normalizeSeoTitle(it.title || data.id || 'Articolo frontalieri');
  const seoTitleCore = rawTitle || 'Articolo frontalieri';
  const candidate = `${seoTitleCore}${TITLE_SUFFIX}`;
  data.seo.title = candidate.length <= TITLE_MAX_CHARS ? candidate : seoTitleCore;

  // `content.it.title` is also the rendered H1. Keep the social title and
  // JSON-LD headline byte-for-byte aligned with that persisted meta value;
  // only the HTML title may carry the normal brand suffix above.
  data.seo.ogTitle = seoTitleCore;
  data.seo.headline = seoTitleCore;

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
