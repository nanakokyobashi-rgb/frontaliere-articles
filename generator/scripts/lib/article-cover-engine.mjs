import { rmSync } from 'node:fs';
import '../../../host/cantonSectionsBootstrap.mjs';
import path from 'node:path';

import {
  DEFAULT_GENERATION_PROVIDER_CHAIN,
  generateImageFromSpec,
} from '../../../engine/shared/generatedImageEngine.mjs';
import {
  LICENSED_PHOTO_KIND,
  LICENSED_PHOTO_PROVIDERS,
} from '../../../engine/shared/generatedImageRegistry.mjs';
import {
  articleImageKeywords,
  articleImagePlace,
  articleHeroImagePath,
  articleImageAssetId,
  articleImageSubject,
  articleImageTopic,
} from './article-cover-identity.mjs';
import { readGeneratedImageRecords } from './blog-image-registry.mjs';
import { readCreditRecords } from '../../../scripts/lib/image-credit-records.mjs';

export {
  articleHeroImagePath,
  articleImageAssetId,
  articleImageSubject,
  articleImageTopic,
  articleImagePlace,
  articleImageKeywords,
} from './article-cover-identity.mjs';

/**
 * Return the source-page identity the photo engine can actually compare for
 * one legacy credit record.
 *
 * The engine's collision gate compares this value with the provider's real
 * `sourcePageUrl`. A local cover/file key is not a substitute: it would look
 * like a used record while matching no provider candidate. Missing, malformed,
 * or provider-mismatched URLs therefore return null and are handled by the
 * caller's fail-closed provider policy. The old inline call shape
 * `usedRecords: usedArticlePhotoRecords(root)` could not carry that policy
 * decision alongside the comparable records, so the adapter now resolves the
 * two values together before calling the engine.
 */
const LEGACY_PHOTO_PAGE_RULES = Object.freeze({
  wikimedia: Object.freeze({
    origin: 'https://commons.wikimedia.org',
    pathPrefixes: Object.freeze(['/wiki/File:']),
  }),
  pexels: Object.freeze({
    origin: 'https://www.pexels.com',
    pathPrefixes: Object.freeze(['/photo/']),
  }),
  pixabay: Object.freeze({
    origin: 'https://pixabay.com',
    pathPrefixes: Object.freeze(['/photos/', '/users/']),
  }),
});

function providerPageUrl(provider, value) {
  if (typeof value !== 'string') return null;
  const pageUrl = value.trim();
  if (!pageUrl) return null;

  let parsed;
  let normalizedPath;
  try {
    parsed = new URL(pageUrl);
    normalizedPath = decodeURIComponent(parsed.pathname).replace(/\/+$/u, '');
  } catch {
    return null;
  }

  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const rule = LEGACY_PHOTO_PAGE_RULES[normalizedProvider];
  if (!rule
    || parsed.protocol !== 'https:'
    || parsed.origin !== rule.origin
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.search
    || parsed.hash) {
    return null;
  }

  if (!normalizedPath) return null;
  const path = normalizedPath.toLowerCase();
  const prefix = rule.pathPrefixes.find((candidate) => path.startsWith(candidate.toLowerCase()));
  if (!prefix) return null;
  const suffix = normalizedPath.slice(prefix.length);
  if (!suffix || /^\/+$/u.test(suffix)) return null;
  // Keep one stable member of the URL equivalence class. The adapter supplies
  // the raw and trailing-slash aliases to the engine below because the mirrored
  // collision gate still compares its string operands literally.
  parsed.pathname = normalizedPath;
  return parsed.toString();
}

/**
 * Return the URL spellings that the engine must treat as one photo identity.
 *
 * `generatedImageEngine` deliberately receives plain records and compares
 * their source-page strings exactly. Keep the provider's original spelling so
 * a fresh API candidate can match it, and add the canonical and
 * trailing-slash spellings so a legacy record can match a provider URL whose
 * only difference is URL serialization.
 */
export function photoPageUrlVariants(provider, value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const canonical = providerPageUrl(provider, raw);
  if (!canonical) return [];

  const variants = new Set([raw, canonical]);
  const addPathVariants = (baseUrl, pathname) => {
    const pathWithoutSlash = pathname.replace(/\/+$/u, '');
    for (const pathVariant of [pathWithoutSlash, `${pathWithoutSlash}/`]) {
      const url = new URL(baseUrl);
      url.pathname = pathVariant;
      variants.add(url.toString());
    }
  };

  const canonicalUrl = new URL(canonical);
  const rawUrl = new URL(raw);
  const decodedPath = decodeURIComponent(canonicalUrl.pathname).replace(/\/+$/u, '');
  const encodedPath = decodedPath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  addPathVariants(canonicalUrl, decodedPath);
  addPathVariants(canonicalUrl, encodedPath);
  const rule = LEGACY_PHOTO_PAGE_RULES[String(provider || '').trim().toLowerCase()];
  const prefix = rule?.pathPrefixes.find((candidate) => decodedPath.toLowerCase().startsWith(candidate.toLowerCase()));
  if (prefix) {
    const encodedSuffixPath = `${decodedPath.slice(0, prefix.length)}${encodeURIComponent(decodedPath.slice(prefix.length))}`;
    addPathVariants(canonicalUrl, encodedSuffixPath);
  }
  // Provider JSON can contain a literal space or Unicode path character even
  // though URL serialization normally emits its percent-encoded spelling.
  if (!/[?#]/u.test(decodedPath)) {
    const origin = canonicalUrl.origin;
    for (const pathVariant of [decodedPath, `${decodedPath}/`]) variants.add(`${origin}${pathVariant}`);
  }
  addPathVariants(rawUrl, rawUrl.pathname);
  return [...variants].filter(Boolean);
}

function licensedPhotoProvider(record) {
  if (record?.kind !== LICENSED_PHOTO_KIND) return null;
  const provider = String(record.provider || '').trim().toLowerCase();
  return LICENSED_PHOTO_PROVIDERS.includes(provider) ? provider : null;
}

/**
 * Expand one persisted provider record into the exact URL operands accepted
 * by the mirrored engine collision gate. Invalid provider URLs return no
 * aliases so the caller can fail closed instead of silently selecting photos.
 */
export function photoRecordPageUrlVariants(record) {
  const provider = licensedPhotoProvider(record);
  if (!provider) return [];
  return photoPageUrlVariants(provider, record.sourcePageUrl || record.pageUrl);
}

function expandPhotoRecordPageAliases(record) {
  const aliases = photoRecordPageUrlVariants(record);
  if (!aliases.length) return [];
  return aliases.map((sourcePageUrl) => ({ ...record, sourcePageUrl }));
}

export function legacyPhotoRecordKey(file, record) {
  void file;
  const source = record?.source === 'licensed-photo' ? record.photo : record?.source === 'wikimedia-commons' ? record.commons : null;
  if (!source) return null;

  const provider = record?.source === 'licensed-photo' ? source.provider : 'wikimedia';
  return providerPageUrl(provider, source.pageUrl);
}

function usedArticlePhotoRecords(root) {
  const generated = [];
  let hasUnmatchableLegacy = false;
  for (const record of readGeneratedImageRecords(root)) {
    if (record?.kind !== LICENSED_PHOTO_KIND) {
      generated.push(record);
      continue;
    }
    const aliases = expandPhotoRecordPageAliases(record);
    if (!aliases.length) {
      // A persisted provider photo without a comparable URL cannot safely
      // participate in literal collision checks. Do not let a new photo reuse
      // it; force the generation-only chain instead.
      hasUnmatchableLegacy = true;
      continue;
    }
    generated.push(...aliases);
  }
  const legacy = [];
  for (const { file, record, parseError } of readCreditRecords(root)) {
    if (parseError !== null) {
      // A corrupt credit file may be a legacy photo whose source identity is
      // unavailable. Force the generative-only chain before trying photos.
      hasUnmatchableLegacy = true;
      continue;
    }
    const isPhotoRecord = record?.source === 'licensed-photo' || record?.source === 'wikimedia-commons';
    if (!isPhotoRecord) continue;
    const source = record?.source === 'licensed-photo'
      ? record.photo
      : record?.source === 'wikimedia-commons' ? record.commons : null;
    const provider = record?.source === 'licensed-photo' ? source?.provider : 'wikimedia';
    const sourcePageUrls = photoPageUrlVariants(provider, source?.pageUrl);
    if (!sourcePageUrls.length) {
      // Do not let an opaque local fallback enter the engine's URL/hash gate.
      // Until this provenance can be resolved, a licensed-photo candidate is
      // unsafe because its real source URL cannot be compared here.
      hasUnmatchableLegacy = true;
      continue;
    }
    for (const sourcePageUrl of sourcePageUrls) {
      legacy.push({ scope: 'article-hero', assetId: `legacy-credit-${file}`, sourcePageUrl });
    }
  }
  return {
    records: [...generated, ...legacy],
    hasUnmatchableLegacy,
  };
}

/**
 * The article-cover adapter shared by the normal generator and the queue
 * drainer. The engine remains the owner of provider order, policy prompt,
 * image verification, and the generated-image record; this module owns only
 * the article-hero input and staging location.
 */

/**
 * Generate one governed article hero into a private staging directory.
 * Callers decide when to materialize the file and append its record so they
 * can keep those writes transactional with the article registry and queue.
 */
export async function generateGovernedArticleHero({
  root,
  data,
  articleId,
  title,
  imagePrompt,
  area,
  safetyHint = '',
  deadlineAt,
  onProviderAttempt,
} = {}) {
  const articleData = data || { id: articleId, title, imagePrompt };
  const assetId = articleImageAssetId(articleData);
  const promptArea = [area, String(safetyHint || '').trim()].filter(Boolean).join('. ');
  const stagingDir = path.join(
    root,
    '.cache',
    'generated-article-images',
    `${assetId}-${process.pid}-${Date.now()}`,
  );

  try {
    const photoUsage = usedArticlePhotoRecords(root);
    const result = await generateImageFromSpec(
      {
        scope: 'article-hero',
        assetId,
        subject: articleImageSubject(articleData),
        area: promptArea,
        season: 'all seasons',
        variant: 'article hero',
        title: articleData.title || articleData.content?.it?.title || articleData.content?.title,
        topic: articleImageTopic(articleData),
        place: articleImagePlace(articleData, area),
        keywords: articleImageKeywords(articleData),
      },
      {
        outputDir: stagingDir,
        assetId,
        usedRecords: photoUsage.records,
        ...(photoUsage.hasUnmatchableLegacy ? { chain: DEFAULT_GENERATION_PROVIDER_CHAIN } : {}),
        deadlineAt,
        onProviderAttempt,
      },
    );

    // Keep the staging cleanup on every governed-contract failure, including
    // a malformed engine result. A provider success is not a publish success
    // until its hero URL has passed the article-hero path contract.
    articleHeroImagePath(result?.record?.imageUrl);
    return { ...result, stagingDir };
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}
