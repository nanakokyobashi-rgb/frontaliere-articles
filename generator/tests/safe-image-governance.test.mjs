import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyJournalistImage,
  editorialUploadMetadata,
} from '../scripts/lib/journalist-image-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const CREATE = read('generator/scripts/create-article.mjs');
const COVER_ENGINE = read('generator/scripts/lib/article-cover-engine.mjs');
const JOURNALIST = read('generator/scripts/publish-journalist-article.mjs');
const between = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const RETIRED_FLASH_IMAGE_MODEL = ['gemini', '2.5', 'flash', 'image'].join('-');

test('create-article usa solo il motore governato per nuove copertine', () => {
  const source = read('generator/scripts/create-article.mjs');
  const imageAdapter = between(source, '// ── Governed image generation', '// ── Step 4: Modify source files');
  assert.match(imageAdapter, /generateGovernedArticleHero/);
  assert.match(COVER_ENGINE, /generateImageFromSpec/);
  assert.match(COVER_ENGINE, /scope: 'article-hero'/);
  assert.match(imageAdapter, /function materializeGovernedArticleImage\(result\)/);
  assert.match(imageAdapter, /scope !== 'article-hero'/);
  assert.match(imageAdapter, /articleHeroPath\.test\(imageUrl\)/);
  assert.match(COVER_ENGINE, /outputDir: stagingDir/);
  assert.match(COVER_ENGINE, /generated-article-images/);
  assert.match(imageAdapter, /renameSync\(result\.filePath, destination\)/);
  assert.match(imageAdapter, /appendGeneratedImageRecord/);
  assert.match(imageAdapter, /deadlineAt:\s*imageDeadline/);
  assert.doesNotMatch(imageAdapter, new RegExp(`fetch\\(|${RETIRED_FLASH_IMAGE_MODEL}|Pollinations|Together|Fal\\.ai|Pixabay|Pexels|Picsum`));
  assert.doesNotMatch(source, new RegExp(RETIRED_FLASH_IMAGE_MODEL));
  assert.match(source, /hasValidBlogImageRecord/);
  assert.match(source, /resolveArticleCoverFallback/);
  assert.match(COVER_ENGINE, /maxAttempts:\s*1/);
});

test('il publisher non scarica URL senza prova di licenza', () => {
  const source = read('generator/scripts/publish-journalist-article.mjs');
  const policy = read('generator/scripts/lib/journalist-image-policy.mjs');
  const resolver = between(source, 'async function resolveHeroImage', '\n/**\n * Resolves the byline');
  assert.match(source, /rightsHolder/);
  assert.match(source, /proofUrl/);
  assert.match(policy, /imageAuthor/);
  assert.match(resolver, /if \(isRejectedUrl\)/);
  assert.match(resolver, /if \(isEditorialUpload && upload\)/);
  assert.match(resolver, /non scarico la risorsa/);
  assert.match(resolver, /generateArticleImage/);
  assert.match(resolver, /resolveArticleCoverFallback/);
  assert.doesNotMatch(resolver, /resolveCommonsPick|STATIC_FALLBACK_IMAGE/);
});

test('la policy pura rifiuta URL arbitrari e accetta solo upload con quattro campi', () => {
  const url = 'https://example.invalid/photo.jpg';
  assert.deepEqual(classifyJournalistImage(url, {}), {
    kind: 'rejected-url',
    url,
    reason: 'missing-editorial-provenance',
  });
  assert.equal(editorialUploadMetadata({ image: url, rightsHolder: 'Redazione', license: 'CC BY 4.0', proofUrl: 'https://example.invalid/licence', author: 'A. Autore' }).author, 'A. Autore');
  assert.equal(classifyJournalistImage('http://example.invalid/photo.jpg', {}).kind, 'rejected-url');
});

test('daily brief resta una card SVG deterministica, non un provider raster esterno', () => {
  const source = read('generator/scripts/lib/daily-brief-image.mjs');
  assert.match(source, /<svg/);
  assert.match(source, /renderDailyBriefImage/);
  assert.doesNotMatch(source, /fetch\(|gemini|pollinations|pixabay|pexels/i);
});

test('la superficie API copia anche le immagini generate e pubblica il ledger aggregato', () => {
  const buildApi = read('scripts/build-api.mjs');
  const buildIndex = read('scripts/build-blog-index.mjs');
  assert.match(buildApi, /\['public', 'images', 'blog'\]/);
  assert.match(buildApi, /\['public', 'images', 'generated'\]/);
  assert.match(buildApi, /images\/\${kind}/);
  assert.match(buildIndex, /BLOG_IMAGE_CREDITS_AGGREGATE/);
  assert.match(buildIndex, /buildBlogImageCreditsAggregate/);
});

test('create e publisher applicano il gate anti-copia al testo sorgente e loggano il massimo', () => {
  assert.match(CREATE, /sourceCopyInputText\(pageContent\)/);
  assert.match(CREATE, /SOURCE_COPY_OVERLAP_THRESHOLD/);
  assert.match(CREATE, /repairGeneratedArticleSourceCopy\(\s*data\.content\.it/);
  assert.match(CREATE, /mode: sourceCopyMode/);
  assert.match(CREATE, /for \(const locale of \['it', 'en', 'de', 'fr'\]\)/);
  assert.doesNotMatch(CREATE, /_sourceCopyRefinement|Anti-copia:.*rigenero/);
  assert.match(JOURNALIST, /assertJournalistSourceCopySafe\(data, sourceText\)/);
  assert.match(JOURNALIST, /SourceCopyError/);
});
