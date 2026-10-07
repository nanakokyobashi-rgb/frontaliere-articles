import { appendImageRegenerationQueue } from './image-regeneration-queue.mjs';
import { imageRecordForPath, STATIC_FALLBACK_IMAGE } from './blog-image-registry.mjs';

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
  data._generatedImageRecord = provenance?.kind === 'generated' ? provenance.record : null;
  data._editorialImageRecord = provenance?.kind === 'editorial-upload' ? provenance.record : null;
  data.image = imagePath.split('/').pop() || data.image;
}

export function queueArticleCoverRegeneration(root, data, resolution) {
  if (!resolution?.regeneration) return false;
  return appendImageRegenerationQueue(root, {
    articleId: data.id,
    title: data.content?.it?.title || data.content?.title || data.title,
    fallbackImage: resolution.regeneration.fallbackImage,
    reason: resolution.regeneration.reason,
  });
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
    provenance = readProvenance(root, catalogImage);
    if (provenance) selected = { path: catalogImage, source: 'catalog-fallback' };
    else console.warn(`  ⚠️  Fallback catalogato ignorato senza record: ${catalogImage}`);
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
  console.error(`[cover] article=${data.id} source=${selected.source} reason=${engineReason}`);
  return {
    source: selected.source,
    path: selected.path,
    provenance: provenance.kind,
    regeneration: {
      fallbackImage: selected.path,
      reason: engineReason,
    },
  };
}
