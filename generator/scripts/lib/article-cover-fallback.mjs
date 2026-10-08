import { appendImageRegenerationQueue } from './image-regeneration-queue.mjs';
import { imageRecordForPath, STATIC_FALLBACK_IMAGE } from './blog-image-registry.mjs';
import { DETERMINISTIC_CARD_KIND } from './deterministic-card-provenance.mjs';

export const CATALOG_FALLBACK_MIN_SHARED_WORDS = 2;

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

export function applyHeroProvenance(data, imagePath, provenance) {
  data._generatedImagePath = imagePath;
  data._imageCredit = provenance?.kind === 'wikimedia-commons' ? provenance.record : null;
  data._generatedImageRecord = provenance?.kind === 'generated' || provenance?.kind === DETERMINISTIC_CARD_KIND
    ? provenance.record
    : null;
  data._editorialImageRecord = provenance?.kind === 'editorial-upload' ? provenance.record : null;
  data.image = imagePath.split('/').pop() || data.image;
}

/**
 * Persist the regeneration request only after the caller has registered the
 * article successfully. The cover resolver runs before the final writer, so
 * queueing there could leave a retry for a document that later failed a
 * validation and was never published.
 */
export function queueArticleCoverRegeneration(root, data) {
  const request = data?._imageRegenerationRequest;
  if (!request) return false;
  try {
    return appendImageRegenerationQueue(root, request);
  } finally {
    delete data._imageRegenerationRequest;
  }
}

/**
 * Resolve a non-blocking cover after the governed engine has failed.
 *
 * `findCatalogImage` is injected by the caller so the existing topical and
 * recent-image selection policy remains the single source of truth.
 */
export function resolveArticleCoverFallback(data, {
  root,
  findCatalogImage,
  reason = 'engine-failed',
} = {}) {
  const engineReason = compactReason(reason);
  let selected = null;
  let provenance = null;
  const catalogImage = typeof findCatalogImage === 'function' ? findCatalogImage(data) : null;
  if (catalogImage) {
    const sharedWords = catalogFallbackSharedWordCount(data, catalogImage);
    if (sharedWords < CATALOG_FALLBACK_MIN_SHARED_WORDS) {
      console.warn(
        `  ⚠️  Fallback catalogato ignorato per scarsa pertinenza (${sharedWords}/`
          + `${CATALOG_FALLBACK_MIN_SHARED_WORDS} parole condivise): ${catalogImage}`,
      );
    } else {
      provenance = readProvenance(root, catalogImage);
      if (provenance) selected = { path: catalogImage, source: 'catalog-fallback' };
      else console.warn(`  ⚠️  Fallback catalogato ignorato senza record: ${catalogImage}`);
    }
  }

  if (!selected) {
    provenance = readProvenance(root, STATIC_FALLBACK_IMAGE);
    selected = { path: STATIC_FALLBACK_IMAGE, source: 'static' };
  }

  // The static record is bundled in the reader for this site-owned asset. If
  // that invariant is ever broken, preserve the original failure context and
  // let the final SEO provenance gate report the configuration defect.
  if (!provenance) {
    throw new Error(`No governed record for static fallback ${STATIC_FALLBACK_IMAGE}`);
  }

  applyHeroProvenance(data, selected.path, provenance);
  Object.defineProperty(data, '_imageRegenerationRequest', {
    value: {
      articleId: data.id,
      title: data.content?.it?.title || data.content?.title || data.title,
      fallbackImage: selected.path,
      reason: engineReason,
    },
    configurable: true,
    writable: true,
  });
  console.error(`[cover] article=${data.id} source=${selected.source} reason=${engineReason}`);
  return {
    source: selected.source,
    path: selected.path,
    provenance: provenance.kind,
  };
}
