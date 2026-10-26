import '../../host/cantonSectionsBootstrap.mjs';

/**
 * Corpus compatibility entry point for the engine-transported SEO resolver.
 * Keep this shim for generator scripts and older callers; the implementation
 * belongs to `engine/shared/seo-entry.mjs`, which the engine mirror carries to
 * the site.
 */
export {
  maskSeoSource,
  findSeoEntryMatches,
  findAllSeoEntryMatches,
  removeSeoEntriesFromSource,
  hasInterpolatedStaticProperty,
  lastStaticPropertyValue,
  readStructuredSeoBlock,
  readStructuredSeoDescription,
  readStructuredSeoDescriptionState,
  staticPropertyState,
  staticPropertyValues,
  staticPropertySpans,
} from '../../engine/shared/seo-entry.mjs';
