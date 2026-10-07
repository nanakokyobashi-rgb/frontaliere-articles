import { rmSync } from 'node:fs';
import '../../../host/cantonSectionsBootstrap.mjs';
import path from 'node:path';

import { generateImageFromSpec } from '../../../engine/shared/generatedImageEngine.mjs';
import {
  articleHeroImagePath,
  articleImageAssetId,
  articleImageSubject,
} from './article-cover-identity.mjs';

export { articleHeroImagePath, articleImageAssetId, articleImageSubject } from './article-cover-identity.mjs';

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
  deadlineAt,
  onProviderAttempt,
} = {}) {
  const articleData = data || { id: articleId, title, imagePrompt };
  const assetId = articleImageAssetId(articleData);
  const stagingDir = path.join(
    root,
    '.cache',
    'generated-article-images',
    `${assetId}-${process.pid}-${Date.now()}`,
  );

  let result;
  try {
    result = await generateImageFromSpec(
      {
        scope: 'article-hero',
        assetId,
        subject: articleImageSubject(articleData),
        area,
        season: 'all seasons',
        variant: 'article hero',
      },
      {
        outputDir: stagingDir,
        assetId,
        // The engine owns provider order; this publishing path permits one
        // attempt total so an outage fails fast and the caller can keep its
        // governed fallback/queue semantics.
        maxAttempts: 1,
        deadlineAt,
        onProviderAttempt,
      },
    );
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }

  articleHeroImagePath(result?.record?.imageUrl);
  return { ...result, stagingDir };
}
