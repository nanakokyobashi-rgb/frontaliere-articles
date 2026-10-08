import { rmSync } from 'node:fs';
import '../../../host/cantonSectionsBootstrap.mjs';
import path from 'node:path';

import { generateImageFromSpec } from '../../../engine/shared/generatedImageEngine.mjs';
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

function usedArticlePhotoRecords(root) {
  const generated = readGeneratedImageRecords(root);
  const legacy = readCreditRecords(root)
    .map(({ file, record }) => {
      const pageUrl = record?.source === 'licensed-photo'
        ? record.photo?.pageUrl
        : record?.source === 'wikimedia-commons'
          ? record.commons?.pageUrl
          : null;
      return pageUrl
        ? { scope: 'article-hero', assetId: `legacy-credit-${file}`, sourcePageUrl: pageUrl }
        : null;
    })
    .filter(Boolean);
  return [...generated, ...legacy];
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
        place: articleImagePlace(articleData),
        keywords: articleImageKeywords(articleData),
      },
      {
        outputDir: stagingDir,
        assetId,
        usedRecords: usedArticlePhotoRecords(root),
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
