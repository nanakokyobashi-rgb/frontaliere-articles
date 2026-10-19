import '../../../host/cantonSectionsBootstrap.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  appendImageRegenerationQueue,
  classifyImageRegenerationFailure,
} from './image-regeneration-queue.mjs';
import { imageRecordForPath, sha256File } from './blog-image-registry.mjs';
import { DETERMINISTIC_CARD_KIND } from './deterministic-card-provenance.mjs';
import {
  GENERATED_IMAGE_KIND,
  LICENSED_PHOTO_KIND,
} from '../../../engine/shared/generatedImageRegistry.mjs';
import {
  imageVisionRejected,
  imageVisionRejectionError,
  isCompleteArticleHeroVisionVerdict,
} from '../../../engine/shared/generatedImageVision.mjs';
import {
  articleImageKeywords,
  articleImagePlace,
  articleImageSubject,
  articleImageTopic,
} from './article-cover-identity.mjs';
import {
  GENERATED_COVER_ALT_BY_LOCALE,
  LICENSED_PHOTO_ALT_BY_LOCALE,
} from './generated-cover-alt.mjs';
import { imageCreditRecordFromGeneratedImageRecord } from '../../../engine/shared/imageCredits.mjs';

export const CATALOG_FALLBACK_MIN_SHARED_WORDS = 2;
export const MAX_CATALOG_FALLBACK_CANDIDATES = 5;
export const ARTICLE_COVER_FALLBACK_ERROR_CODES = Object.freeze({
  NO_RELEVANT_CANDIDATE: 'ARTICLE_COVER_NO_RELEVANT_FALLBACK',
  VERIFICATION_UNAVAILABLE: 'ARTICLE_COVER_VERIFICATION_UNAVAILABLE',
  STALE_VERIFICATION: 'ARTICLE_COVER_VERIFICATION_STALE',
});
export { classifyImageRegenerationFailure } from './image-regeneration-queue.mjs';

const COVER_VERIFICATION_BUDGET_MS = 120_000;
const COVER_VERIFIER_POLICY_VERSION = 'article-hero-vision-v1';
const VERIFIED_CATALOG_IMAGE = Symbol('verified catalog image');
const verificationCache = new Map();

const VERIFIED_FALLBACK_ALT = Object.freeze({
  generated: GENERATED_COVER_ALT_BY_LOCALE,
  'licensed-photo': LICENSED_PHOTO_ALT_BY_LOCALE,
});

function searchTokens(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-zà-ÿ0-9]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 4);
}

function articleSearchWords(data) {
  const searchableText = [
    data?.id || '',
    data?.content?.it?.title || data?.content?.title || '',
    data?.content?.it?.excerpt || data?.content?.excerpt || '',
  ].join(' ').toLowerCase();
  return new Set(searchTokens(searchableText));
}

export function catalogFallbackSharedWordCount(data, imagePath) {
  const basename = String(imagePath || '')
    .replace(/^.*\//, '')
    .replace(/\.[^.]+$/, '');
  if (!basename) return 0;
  const articleWords = articleSearchWords(data);
  const filenameWords = new Set(searchTokens(basename));
  return [...articleWords].filter((word) => filenameWords.has(word)).length;
}

function compactReason(value) {
  return String(value || 'engine-failed').replace(/\s+/g, ' ').trim().slice(0, 180) || 'engine-failed';
}

function readProvenance(root, imagePath) {
  try {
    return imageRecordForPath(root, imagePath, { strict: true });
  } catch (error) {
    console.warn(`  ⚠️  Record copertina non leggibile (${imagePath}): ${compactReason(error.message)}`);
    return null;
  }
}

function articleHeroFilePath(root, imagePath) {
  if (!/^\/images\/blog\/[A-Za-z0-9._-]+\.webp$/i.test(String(imagePath || ''))) return null;
  return path.join(root, 'public', imagePath.slice(1));
}

function verificationContext(data, area) {
  return {
    scope: 'article-hero',
    subject: articleImageSubject(data),
    topic: articleImageTopic(data),
    place: articleImagePlace(data, area),
    keywords: articleImageKeywords(data),
  };
}

function verificationKey(sha256, context, kind) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ policy: COVER_VERIFIER_POLICY_VERSION, sha256: sha256.toLowerCase(), kind, context }))
    .digest('hex');
}

function createIncompleteVisionVerdict(verdict) {
  const error = new Error('vision verifier returned an incomplete article-hero verdict');
  error.code = 'IMAGE_VISION_VERDICT_INCOMPLETE';
  error.retryable = true;
  error.vision = verdict && typeof verdict === 'object' ? verdict : {};
  return error;
}

function assertArticleHeroVisionVerdict(verdict, kind) {
  if (!isCompleteArticleHeroVisionVerdict(verdict)) {
    throw createIncompleteVisionVerdict(verdict);
  }

  // Keep safety and kind-specific media policy in the shared engine. This
  // boundary adds only the explicit positive/context verdict needed before a
  // previously generated binary can be reused for another article.
  if (verdict.ok !== true
    || verdict.is_topic_relevant !== true
    || imageVisionRejected(verdict, { kind, scope: 'article-hero' })) {
    throw imageVisionRejectionError(verdict);
  }
}

async function defaultVerifyImage(filePath, options) {
  const { verifyGeneratedImage } = await import('../../../engine/shared/generatedImageEngine.mjs');
  return verifyGeneratedImage(filePath, options);
}

async function verifyCandidateImage(filePath, sha256, provenance, context, {
  verifyImage = defaultVerifyImage,
  deadlineAt,
} = {}) {
  const kind = provenance.kind === 'licensed-photo' ? LICENSED_PHOTO_KIND : GENERATED_IMAGE_KIND;
  const cacheKey = verificationKey(sha256, context, kind);
  // Injected verifiers are test seams and may have different trust guarantees.
  // They never read from or write to the production-verifier cache.
  const cacheable = verifyImage === defaultVerifyImage;
  const cached = cacheable ? verificationCache.get(cacheKey) : null;
  if (cached) return cached;

  const promise = (async () => {
    const verdict = await verifyImage(filePath, {
      ...context,
      kind,
      deadlineAt,
    });
    // Recheck the full schema and publication policy here too. This protects
    // the capability boundary from skipped, partial, or future verifier output.
    assertArticleHeroVisionVerdict(verdict, kind);
    return verdict;
  })();
  if (cacheable) verificationCache.set(cacheKey, promise);
  try {
    return await promise;
  } catch (error) {
    if (cacheable && verificationCache.get(cacheKey) === promise) verificationCache.delete(cacheKey);
    throw error;
  }
}

function normalizeCandidatePaths(options, data) {
  let candidates;
  if (typeof options.findCatalogImages === 'function') {
    candidates = options.findCatalogImages(data);
  } else if (typeof options.findCatalogImage === 'function') {
    candidates = options.findCatalogImage(data);
  } else {
    candidates = [];
  }
  if (typeof candidates === 'string') candidates = [candidates];
  if (!Array.isArray(candidates)) return [];
  return [...new Set(candidates.filter((value) => typeof value === 'string' && value.trim()))]
    .slice(0, MAX_CATALOG_FALLBACK_CANDIDATES);
}

function noVerifiedFallbackError({ data, candidateCount, rejectedCount, transientErrors }) {
  // A shared deferral is valid only when every verifier exception carries the
  // producer-owned shared-provider marker. A mixed local/unclassified failure
  // must stay section-local even if another candidate also hit an outage.
  const sharedProviderUnavailable = transientErrors.length > 0
    && transientErrors.every((error) => error?.sharedProviderUnavailable === true);
  const transientError = sharedProviderUnavailable
    ? transientErrors[0]
    : transientErrors.find((error) => error?.sharedProviderUnavailable !== true) || transientErrors[0];
  const error = new Error(transientError
    ? `Unable to verify a relevant catalog cover for ${data?.id || '<unknown>'}: ${compactReason(transientError.message)}`
    : `No visually verified, topic-relevant catalog cover for ${data?.id || '<unknown>'}`);
  error.code = transientError
    ? ARTICLE_COVER_FALLBACK_ERROR_CODES.VERIFICATION_UNAVAILABLE
    : ARTICLE_COVER_FALLBACK_ERROR_CODES.NO_RELEVANT_CANDIDATE;
  error.retryable = true;
  if (transientError) error.cause = transientError;
  if (sharedProviderUnavailable) error.sharedProviderUnavailable = true;
  if (!transientError && rejectedCount > 0) error.imageQualityFailure = true;
  error.candidateCount = candidateCount;
  error.rejectedCount = rejectedCount;
  return error;
}

/**
 * Select a catalog fallback only after the current article's context has been
 * checked against the actual image bytes. Existing record vision, filename
 * tokens and article ids rank candidates upstream; none of them grants reuse.
 */
export async function verifyCatalogFallbackCandidates(data, {
  root,
  findCatalogImages,
  findCatalogImage,
  area = 'Ticino e pendolarismo transfrontaliero',
  deadlineAt = Date.now() + COVER_VERIFICATION_BUDGET_MS,
  verifyImage = defaultVerifyImage,
} = {}) {
  const candidates = normalizeCandidatePaths({ findCatalogImages, findCatalogImage }, data);
  const context = verificationContext(data, area);
  const transientErrors = [];
  let rejectedCount = 0;

  for (const imagePath of candidates) {
    const filePath = articleHeroFilePath(root, imagePath);
    if (!filePath) continue;
    const provenance = readProvenance(root, imagePath);
    if (!provenance
      || provenance.record?.scope !== 'article-hero'
      || !['generated', 'licensed-photo'].includes(provenance.kind)
      || provenance.kind === DETERMINISTIC_CARD_KIND) {
      console.warn(`  ⚠️  Fallback catalogato escluso senza prova di hero riutilizzabile: ${imagePath}`);
      continue;
    }

    const recordHash = String(provenance.record.sha256 || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(recordHash)) {
      console.warn(`  ⚠️  Fallback catalogato escluso senza SHA-256 verificabile: ${imagePath}`);
      continue;
    }

    let actualHash;
    try {
      actualHash = sha256File(filePath);
    } catch (error) {
      console.warn(`  ⚠️  Binario fallback non leggibile (${imagePath}): ${compactReason(error.message)}`);
      continue;
    }
    if (actualHash !== recordHash) {
      console.warn(`  ⚠️  Fallback catalogato escluso: SHA-256 del binario diverso dal record (${imagePath})`);
      continue;
    }

    try {
      const vision = await verifyCandidateImage(filePath, actualHash, provenance, context, {
        verifyImage,
        deadlineAt,
      });
      return Object.freeze({
        [VERIFIED_CATALOG_IMAGE]: true,
        path: imagePath,
        area,
        sha256: actualHash,
        contextHash: verificationKey(actualHash, context, provenance.kind === 'licensed-photo'
          ? LICENSED_PHOTO_KIND
          : GENERATED_IMAGE_KIND),
        provenance,
        vision,
      });
    } catch (error) {
      if (error?.code === 'IMAGE_VISION_REJECTED') {
        rejectedCount += 1;
        console.warn(`  ⚠️  Fallback non pertinente per ${data?.id || '<unknown>'}: ${imagePath}`);
        continue;
      }
      transientErrors.push(error);
      if (error?.sharedProviderUnavailable === true || Date.now() >= deadlineAt || error?.code === 'ETIMEDOUT') break;
    }
  }

  throw noVerifiedFallbackError({
    data,
    candidateCount: candidates.length,
    rejectedCount,
    transientErrors,
  });
}

export function applyHeroProvenance(data, imagePath, provenance) {
  data._generatedImagePath = imagePath;
  data._imageCredit = provenance?.kind === 'wikimedia-commons'
    ? provenance.record
    : provenance?.kind === 'licensed-photo'
      ? imageCreditRecordFromGeneratedImageRecord(provenance.record)
      : null;
  data._generatedImageRecord = provenance?.kind === 'generated' || provenance?.kind === DETERMINISTIC_CARD_KIND
    ? provenance.record
    : null;
  data._editorialImageRecord = provenance?.kind === 'editorial-upload' ? provenance.record : null;
  data.image = imagePath.split('/').pop() || data.image;
}

function applyVerifiedFallbackAlt(data, kind) {
  data.imageAlt = { ...VERIFIED_FALLBACK_ALT[kind] };
}

/**
 * The model writes article metadata before the governed image exists, so its
 * topical alt text is not evidence about the final pixels. Keep generated
 * covers on a neutral localized description; non-generated assets retain
 * their separately authored or verified alt text.
 */
export function applyGeneratedHeroAlt(data, provenance) {
  if (!data || provenance?.kind !== 'generated') return false;
  applyVerifiedFallbackAlt(data, 'generated');
  return true;
}

/**
 * Persist the regeneration request only after the caller has registered the
 * article successfully. The cover resolver runs before the final writer, so
 * queueing there could leave a retry for a document that later failed a
 * validation and was never published.
 */
export function queueArticleCoverRegeneration(root, data, { append = appendImageRegenerationQueue } = {}) {
  const request = data?._imageRegenerationRequest;
  if (!request) return false;
  try {
    return append === appendImageRegenerationQueue ? append(root, request) : append(request);
  } finally {
    delete data._imageRegenerationRequest;
  }
}

/**
 * Apply a previously verified fallback and queue its eventual unique cover.
 * A raw catalog path, static landscape, saved record verdict, or deterministic
 * card cannot cross this boundary without the private verifier token.
 */
export function resolveArticleCoverFallback(data, {
  root,
  verifiedCatalogImage,
  reason = 'engine-failed',
} = {}) {
  const engineReason = compactReason(reason);
  if (verifiedCatalogImage?.[VERIFIED_CATALOG_IMAGE] !== true) {
    throw noVerifiedFallbackError({ data, candidateCount: 0, rejectedCount: 0, transientErrors: [] });
  }

  const currentProvenance = readProvenance(root, verifiedCatalogImage.path);
  const filePath = articleHeroFilePath(root, verifiedCatalogImage.path);
  let currentHash = null;
  if (currentProvenance && filePath) {
    try {
      const stat = fs.lstatSync(filePath);
      if (stat.isFile()) currentHash = sha256File(filePath);
    } catch {
      // A missing, unreadable, or replaced path invalidates the capability.
    }
  }
  const currentContext = verificationContext(
    data,
    verifiedCatalogImage.area || 'Ticino e pendolarismo transfrontaliero',
  );
  const currentContextHash = currentHash && verificationKey(
    currentHash,
    currentContext,
    currentProvenance?.kind === 'licensed-photo' ? LICENSED_PHOTO_KIND : GENERATED_IMAGE_KIND,
  );
  if (!currentProvenance
    || currentHash !== verifiedCatalogImage.sha256
    || currentProvenance.record.scope !== 'article-hero'
    || currentContextHash !== verifiedCatalogImage.contextHash) {
    const error = new Error(`Verified fallback changed before publication for ${data?.id || '<unknown>'}`);
    error.code = ARTICLE_COVER_FALLBACK_ERROR_CODES.STALE_VERIFICATION;
    error.retryable = true;
    throw error;
  }

  const failureDisposition = data?._imageGenerationFailureDisposition
    || classifyImageRegenerationFailure(reason);
  applyHeroProvenance(data, verifiedCatalogImage.path, currentProvenance);
  applyVerifiedFallbackAlt(data, currentProvenance.kind);
  Object.defineProperty(data, '_imageRegenerationRequest', {
    value: {
      articleId: data.id,
      title: data.content?.it?.title || data.content?.title || data.title,
      fallbackImage: verifiedCatalogImage.path,
      reason: engineReason,
      retryDisposition: failureDisposition.retryable === false ? 'terminal' : 'retryable',
      ...(failureDisposition.retryable === false ? { terminalReason: failureDisposition.reason } : {}),
      ...(failureDisposition.retryHint === 'no-text' ? { retryHint: 'no-text' } : {}),
    },
    configurable: true,
    writable: true,
  });
  console.error(`[cover] article=${data.id} source=catalog-fallback reason=${engineReason}`);
  return {
    source: 'catalog-fallback',
    path: verifiedCatalogImage.path,
    provenance: currentProvenance.kind,
    vision: verifiedCatalogImage.vision,
  };
}
