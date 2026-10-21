/**
 * Corpus RSS entry point. The emitter remains in the mirrored engine; this
 * adapter injects the corpus article-body scanner without making engine code
 * depend on corpus-only scripts.
 */
import {
  buildSectionFeeds as buildMirroredSectionFeeds,
  RSS_SECTIONS,
} from '../../engine/rssFeeds.mjs';
import { extractArticleBodyFields } from './article-body-api.mjs';

export { RSS_SECTIONS };

export function buildSectionFeeds(options) {
  return buildMirroredSectionFeeds({
    ...options,
    bodyFieldParser: extractArticleBodyFields,
  });
}
