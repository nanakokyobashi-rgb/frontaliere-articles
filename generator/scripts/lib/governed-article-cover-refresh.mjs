import { imageRecordForPath } from './blog-image-registry.mjs';
import {
  locateArticleRegistry,
  locateArticleSeoImage,
  updateArticleImageInRegistry,
  updateArticleSeoImageBlock,
} from './article-registry-image.mjs';
import { buildSeoImageBlock } from './seo-entry-builder.mjs';

/**
 * Migrate an existing article's registry and JSON-LD cover to a governed
 * image. Both destinations are resolved before either is written; missing,
 * duplicated, or ungoverned records therefore fail closed. The injected I/O
 * hooks let a producer stage both changes inside its refresh transaction.
 */
export function refreshGovernedArticleCover({
  repoRoot,
  articleId,
  imagePath,
  caption,
  section = 'frontaliere',
  registryFiles,
  readFile,
  writeFile,
} = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.trim() === '') {
    throw new TypeError('refreshGovernedArticleCover: repoRoot is required');
  }
  if (typeof articleId !== 'string' || articleId.trim() === '') {
    throw new TypeError('refreshGovernedArticleCover: articleId is required');
  }
  if (typeof imagePath !== 'string' || imagePath.trim() === '') {
    throw new TypeError(`refreshGovernedArticleCover: imagePath is required for ${articleId}`);
  }
  if (typeof caption !== 'string' || caption.trim() === '') {
    throw new TypeError(`refreshGovernedArticleCover: caption is required for ${articleId}`);
  }

  const provenance = imageRecordForPath(repoRoot, imagePath, { strict: true });
  if (!provenance) {
    throw new Error(`article ${articleId} cover has no governed provenance record: ${imagePath}`);
  }

  const registryOptions = { registryFiles, readFile, writeFile };
  const seoOptions = { section, readFile, writeFile };
  // Preflight both surfaces before the first write. The update functions
  // repeat their exact-one lookup while applying their idempotent replacement.
  locateArticleRegistry(repoRoot, articleId, registryOptions);
  locateArticleSeoImage(repoRoot, articleId, seoOptions);

  const imageBlock = buildSeoImageBlock({ imagePath, provenance, caption });
  const registry = updateArticleImageInRegistry(repoRoot, articleId, imagePath, registryOptions);
  const seo = updateArticleSeoImageBlock(repoRoot, articleId, imageBlock, seoOptions);
  return { changed: registry.changed || seo.changed, registry, seo };
}
