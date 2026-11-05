/**
 * Public, localized index of articles produced from a discovered topic.
 *
 * The source sidecars can contain raw query/evidence URLs and internal scores.
 * This projection intentionally emits only the article id, publication time,
 * normalized provider, and localized reader-facing fields needed by consumers.
 */
import { SITE, publishedArticleLocales } from './build-sitemap.mjs';

const PUBLIC_PROVIDERS = new Set(['google_trends', 'reddit', 'other']);
const TOPIC_PROVIDERS = new Set(['reddit', 'google-news-rss']);
const LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeId(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/u.test(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function timestamp(value) {
  if (!isNonEmptyString(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * Collapse private attribution to the small, stable public provider enum.
 *
 * @param {unknown} sidecar
 * @returns {'google_trends'|'reddit'|'other'|null}
 */
export function normalizeDiscoveryProvider(sidecar) {
  if (!isRecord(sidecar)) return null;

  const discovery = sidecar._discovery_attribution;
  if (
    isRecord(discovery)
    && isNonEmptyString(discovery.candidateId)
    && discovery.signalProvider === 'google-trends'
  ) {
    return 'google_trends';
  }

  const topic = sidecar._topic_candidate_attribution;
  if (
    !isRecord(topic)
    || typeof topic.candidateId !== 'string'
    || !/^[a-f0-9]{8}$/u.test(topic.candidateId)
    || !Array.isArray(topic.providers)
  ) {
    return null;
  }
  const providers = topic.providers.filter((provider) => TOPIC_PROVIDERS.has(provider));
  if (providers.length === 0) return null;
  return providers.includes('reddit') ? 'reddit' : 'other';
}

function safeLocalizedText(value) {
  if (!isNonEmptyString(value)) return null;
  if (/[\u0000-\u001f\u007f]/u.test(value)) return null;
  const text = value.trim();
  return text;
}

function safePublishedAt(sidecar, article) {
  return timestamp(sidecar?.publishedAt) || timestamp(article?.date);
}

function safeLocalizedFields(section, article, slugRows, localeRows) {
  const output = { title: {}, excerpt: {}, url: {} };
  const fallbackReasons = section.fallbackReasons || {};
  const publishedLocales = publishedArticleLocales(
    article,
    section.paths,
    slugRows,
    new Set(),
    fallbackReasons,
  );

  for (const { locale, prefix, slug } of publishedLocales) {
    if (!LOCALES.includes(locale) || typeof prefix !== 'string' || !prefix.startsWith('/')) continue;
    if (!isNonEmptyString(slug) || /[/?#\\\u0000-\u001f\u007f]/u.test(slug)) continue;

    const localized = localeRows?.[locale]?.get(article.id);
    const title = safeLocalizedText(localized?.title);
    const excerpt = safeLocalizedText(localized?.excerpt);
    if (!title || !excerpt) continue;

    output.title[locale] = title;
    output.excerpt[locale] = excerpt;
    output.url[locale] = `${SITE}${prefix}${slug}/`;
  }

  return output.title.it && output.excerpt.it && output.url.it ? output : null;
}

/**
 * Build the closed public discovery index from already-published registry
 * rows and their private attribution sidecars.
 *
 * Each section has:
 *   { name, registry, sidecars: Map<id, sidecar>, paths, slugMap,
 *     fallbackReasons, metaByLocale: { it/en/de/fr: Map<id, {title,excerpt}> } }
 *
 * @param {object} input
 * @param {string} input.commit
 * @param {string} input.generatedAt
 * @param {Array<object>} input.sections
 * @returns {{schema:number,commit:string,generatedAt:string,count:number,articles:Array<object>}}
 */
export function buildDiscoveryArticlesIndex({ commit, generatedAt, sections }) {
  if (!isNonEmptyString(commit)) throw new TypeError('discovery index commit must be a non-empty string');
  const builtAt = timestamp(generatedAt);
  if (!builtAt) throw new TypeError('discovery index generatedAt must be a valid timestamp');
  if (!Array.isArray(sections)) throw new TypeError('discovery index sections must be an array');

  const byId = new Map();
  for (const section of sections) {
    if (!isRecord(section) || !Array.isArray(section.registry)) continue;
    const sidecars = section.sidecars instanceof Map ? section.sidecars : new Map();
    for (const article of section.registry) {
      if (!isRecord(article) || !isSafeId(article.id) || byId.has(article.id)) continue;
      const sidecar = sidecars.get(article.id);
      if (!isRecord(sidecar) || sidecar.id !== article.id) continue;
      const provider = normalizeDiscoveryProvider(sidecar);
      const publishedAt = safePublishedAt(sidecar, article);
      const localized = safeLocalizedFields(
        section,
        article,
        section.slugMap || {},
        section.metaByLocale || {},
      );
      if (!provider || !PUBLIC_PROVIDERS.has(provider) || !publishedAt || !localized) continue;

      byId.set(article.id, {
        id: article.id,
        publishedAt,
        provider,
        title: localized.title,
        excerpt: localized.excerpt,
        url: localized.url,
      });
    }
  }

  const articles = [...byId.values()].sort((a, b) =>
    b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id),
  );

  return {
    schema: 1,
    commit,
    generatedAt: builtAt,
    count: articles.length,
    articles,
  };
}
