import { rmSync } from 'node:fs';
import '../../../host/cantonSectionsBootstrap.mjs';
import path from 'node:path';

import {
  DEFAULT_GENERATION_PROVIDER_CHAIN,
  generateImageFromSpec,
} from '../../../engine/shared/generatedImageEngine.mjs';
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
 * like a used record while matching no provider candidate. Missing or
 * malformed URLs therefore return null and are handled by the caller's
 * fail-closed provider policy. The old inline call shape
 * `usedRecords: usedArticlePhotoRecords(root)` could not carry that policy
 * decision alongside the comparable records, so the adapter now resolves the
 * two values together before calling the engine.
 */
export function legacyPhotoRecordKey(file, record) {
  void file;
  const source = record?.source === 'licensed-photo'
    ? record.photo
    : record?.source === 'wikimedia-commons'
      ? record.commons
      : null;
  if (!source) return null;

  const pageUrl = String(source.pageUrl || '').trim();
  return /^https:\/\//i.test(pageUrl) ? pageUrl : null;
}

function usedArticlePhotoRecords(root) {
  const generated = readGeneratedImageRecords(root);
  const legacy = [];
  let hasUnmatchableLegacy = false;
  for (const { file, record } of readCreditRecords(root)) {
    const isPhotoRecord = record?.source === 'licensed-photo' || record?.source === 'wikimedia-commons';
    if (!isPhotoRecord) continue;
    const sourcePageUrl = legacyPhotoRecordKey(file, record);
    if (!sourcePageUrl) {
      // Do not let an opaque local fallback enter the engine's URL/hash gate.
      // Until this provenance can be resolved, a licensed-photo candidate is
      // unsafe because its real source URL cannot be compared here.
      hasUnmatchableLegacy = true;
      continue;
    }
    legacy.push({ scope: 'article-hero', assetId: `legacy-credit-${file}`, sourcePageUrl });
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
