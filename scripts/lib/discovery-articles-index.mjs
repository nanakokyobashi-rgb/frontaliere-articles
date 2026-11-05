/**
 * Public, localized index of articles produced from a discovered topic.
 *
 * The source sidecars can contain raw query/evidence URLs and internal scores.
 * This projection intentionally emits only the article id, publication time,
 * normalized provider, and localized reader-facing fields needed by consumers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE, publishedArticleLocales } from './build-sitemap.mjs';

const PUBLIC_PROVIDERS = new Set(['google_trends', 'other']);
const TOPIC_PROVIDERS = new Set(['google-news-rss']);
const LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);
const REPOSITORY_ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The registry contract accepts any non-empty string as an article id.
 * Keep this predicate shared with the on-disk sidecar reader so a valid
 * registry row cannot disappear from the discovery projection at either
 * boundary.
 *
 * @param {unknown} value
 * @returns {value is string}
 */
export function isSafeId(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Resolve a registry ID to its sidecar path without allowing path traversal.
 * The registry accepts arbitrary non-empty strings, so unsafe path forms must
 * fail publication instead of silently dropping an otherwise valid article.
 *
 * @param {string} sidecarDir
 * @param {unknown} id
 * @returns {string|null}
 */
export function resolveDiscoverySidecarPath(sidecarDir, id) {
  const segments = typeof id === 'string' ? id.split('/') : [];
  if (typeof sidecarDir !== 'string'
    || !isSafeId(id)
    || id.includes('\\')
    || id.includes('\u0000')
    // A final `..` is part of the literal filename after appending `.json`.
    || segments.slice(0, -1).includes('..')) return null;

  const root = path.resolve(sidecarDir);
  const file = path.resolve(root, `${id}.json`);
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return file;
}

/**
 * Resolve an existing sidecar and reject symlinks escaping its trusted roots.
 *
 * @param {string} sidecarDir
 * @param {unknown} id
 * @param {string} [trustedRoot]
 * @returns {string|null}
 */
export function resolveExistingDiscoverySidecarPath(sidecarDir, id, trustedRoot = REPOSITORY_ROOT) {
  const candidate = resolveDiscoverySidecarPath(sidecarDir, id);
  if (!candidate) return null;

  let root;
  let trusted;
  try {
    root = fs.realpathSync(sidecarDir);
    trusted = fs.realpathSync(trustedRoot);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }

  const rootRelative = path.relative(trusted, root);
  if (!rootRelative || rootRelative === '..' || rootRelative.startsWith(`..${path.sep}`) || path.isAbsolute(rootRelative)) {
    throw new TypeError('discovery sidecar directory resolves outside the repository');
  }

  let parent;
  try {
    parent = fs.realpathSync(path.dirname(candidate));
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
  const parentRelative = path.relative(root, parent);
  if (parentRelative === '..' || parentRelative.startsWith(`..${path.sep}`) || path.isAbsolute(parentRelative)) {
    throw new TypeError('discovery sidecar resolves outside its directory');
  }

  let file;
  try {
    file = fs.realpathSync(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }

  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new TypeError('discovery sidecar resolves outside its directory');
  }
  return file;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Parse an on-disk attribution sidecar and fail closed if it is malformed or
 * belongs to a different registry id.
 *
 * @param {string} raw
 * @param {string} expectedId
 * @returns {Record<string, unknown>}
 */
export function parseDiscoverySidecar(raw, expectedId) {
  let sidecar;
  try {
    sidecar = JSON.parse(raw);
  } catch (cause) {
    throw new TypeError(`invalid JSON for discovery sidecar ${expectedId}`, { cause });
  }
  if (!isRecord(sidecar) || sidecar.id !== expectedId) {
    throw new TypeError(`expected an object whose id is ${expectedId}`);
  }
  return sidecar;
}

/**
 * Compose the same Italian-slug shadow set used by build-api's index surfaces.
 *
 * @param {{canonicalSlugs?:string[],retiredDailySlugs?:string[],retiredRegistrySlugs?:string[],excludedSlugs?:string[]}} input
 * @returns {Set<string>}
 */
export function buildDiscoveryArticleShadow({
  canonicalSlugs = [],
  retiredDailySlugs = [],
  retiredRegistrySlugs = [],
  excludedSlugs = [],
} = {}) {
  return new Set([
    ...canonicalSlugs,
    ...retiredDailySlugs,
    ...retiredRegistrySlugs,
    ...excludedSlugs,
  ]);
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
 * @returns {'google_trends'|'other'|null}
 */
export function normalizeDiscoveryProvider(sidecar) {
  if (!isRecord(sidecar)) return null;

  const topic = sidecar._topic_candidate_attribution;
  if (isRecord(topic) && Array.isArray(topic.providers) && topic.providers.includes('reddit')) {
    return null;
  }

  const discovery = sidecar._discovery_attribution;
  if (
    isRecord(discovery)
    && isNonEmptyString(discovery.candidateId)
    && discovery.signalProvider === 'google-trends'
  ) {
    return 'google_trends';
  }

  if (
    !isRecord(topic)
    || typeof topic.candidateId !== 'string'
    || !/^[a-f0-9]{8}$/u.test(topic.candidateId)
    || !Array.isArray(topic.providers)
  ) {
    return null;
  }
  if (topic.providers.includes('reddit')) return null;
  const providers = topic.providers.filter((provider) => TOPIC_PROVIDERS.has(provider));
  if (providers.length === 0) return null;
  return 'other';
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
    section.shadowed instanceof Set ? section.shadowed : new Set(),
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
