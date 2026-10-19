import '../../host/cantonSectionsBootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  appendGeneratedImageRecord,
  buildPublishedBlogImageRegistry,
  imageRecordForPath,
  sha256File,
} from '../scripts/lib/blog-image-registry.mjs';
import {
  buildDailyBriefCoverAlt,
  buildDailyBriefCoverPrompt,
  buildDailyBriefImageContext,
  buildDailyBriefImageRecord,
  materializeDailyBriefHero,
} from '../scripts/lib/daily-brief-image.mjs';
import { buildDailyBriefArticle } from '../scripts/lib/daily-brief-content.mjs';
import { articleImageAssetId } from '../scripts/lib/article-cover-identity.mjs';
import { refreshGovernedArticleCover } from '../scripts/lib/governed-article-cover-refresh.mjs';
import { DETERMINISTIC_CARD_KIND } from '../scripts/lib/deterministic-card-provenance.mjs';
import {
  GENERATED_IMAGE_CREDIT,
  GENERATED_IMAGE_LICENSE,
  GENERATED_IMAGE_LICENSE_URLS,
  GENERATED_IMAGE_PROMPT_VERSION,
  GENERATED_IMAGE_RESTRICTIONS,
  LICENSED_PHOTO_KIND,
  LICENSED_PHOTO_RESTRICTIONS,
  validateGeneratedImageRecord,
} from '../../engine/shared/generatedImageRegistry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-brief-image-provenance-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/generated-image-registry.json'), '{"schema":1,"assetCount":0,"assets":[]}\n');
  return root;
}

test('historical daily cards retain the site-owned schema without provider or vision fields', () => {
  const root = tempRoot();
  try {
    const id = 'bollettino-frontaliere-2026-10-07';
    const image = path.join(root, 'public/images/blog', `${id}.webp`);
    fs.mkdirSync(path.dirname(image), { recursive: true });
    fs.writeFileSync(image, Buffer.from('deterministic daily brief hero'));

    const record = buildDailyBriefImageRecord({
      id,
      sha256: sha256File(image),
      bytes: fs.statSync(image).size,
    });

    assert.equal(validateGeneratedImageRecord(record).valid, true);
    assert.equal(record.source, 'deterministic-card');
    assert.equal(record.provider, 'site-owned');
    assert.equal(record.license, 'private-grant');
    for (const field of ['model', 'executorModel', 'promptVersion', 'promptHash', 'licenseUrl', 'generatedAt', 'verifiedAt', 'restrictions', 'vision']) {
      assert.equal(record[field], undefined, `${field} must not be present on a deterministic card`);
    }

    appendGeneratedImageRecord(root, record);
    const provenance = imageRecordForPath(root, record.imageUrl, { strict: true });
    assert.equal(provenance.kind, DETERMINISTIC_CARD_KIND);
    assert.equal(provenance.record.sha256, record.sha256);
    assert.equal(buildPublishedBlogImageRegistry(root).generated[record.imageUrl].source, 'deterministic-card');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('all tracked daily brief heroes have byte-matching governed provenance', () => {
  const covers = fs.readdirSync(path.join(ROOT, 'public/images/blog'))
    .filter((name) => /^bollettino-frontaliere-\d{4}-\d{2}-\d{2}\.webp$/.test(name))
    .sort();
  // One hero is added every day, so an exact count turns this gate red at each
  // edition: written as 57 at 05:03Z on 8 October, it was 58 by 11:53Z. The loop
  // below already checks every file; the floor only keeps a short directory
  // read from passing with nothing to check.
  assert.ok(covers.length >= 57, `only ${covers.length} daily brief heroes found: the directory read is short`);

  for (const name of covers) {
    const imageUrl = `/images/blog/${name}`;
    const provenance = imageRecordForPath(ROOT, imageUrl, { strict: true });
    assert.ok(['generated', DETERMINISTIC_CARD_KIND].includes(provenance?.kind), `${name} has no supported provenance`);
    assert.equal(provenance.record.scope === 'article-hero' || provenance.record.scope === 'place', true);
    assert.equal(provenance.record.bytes, fs.statSync(path.join(ROOT, 'public', imageUrl.slice(1))).size, `${name} byte count drifted`);
    assert.equal(provenance.record.sha256, sha256File(path.join(ROOT, 'public', imageUrl.slice(1))), `${name} hash drifted`);
  }
});

test('the daily producer makes a fresh governed hero before either first registration or same-day refresh', () => {
  const source = fs.readFileSync(path.join(ROOT, 'generator/scripts/generate-daily-brief-article.mjs'), 'utf8');
  assert.match(source, /generateGovernedArticleHero\(/);
  assert.match(source, /materializeDailyBriefHero\(/);
  assert.match(source, /buildDailyBriefCoverPrompt\(h\)/);
  assert.match(source, /buildDailyBriefCoverAlt\(h\)/);
  assert.doesNotMatch(source, /buildDailyBriefSvg\(|renderDailyBriefImage\(/);
  assert.ok(
    source.indexOf('generateGovernedArticleHero(') < source.indexOf('if (!exists)'),
    'the article id cannot turn the previous daily card into a cover cache hit',
  );
  assert.match(source, /refreshImageAlt: true/);
  assert.match(source, /refreshGovernedArticleCover\(/);
  assert.match(source, /imageAlt: data\.imageAlt\?\.\[locale\]/);
});

test('the daily cover scene follows the headline kind without embedding its numbers', () => {
  const cases = [
    [{ kind: 'jobsTrend', weeklyChange: -247, weeklyChangePct: -18.4 }, /contemporary workplace/i],
    [{ kind: 'borderWaitChange', changeMinutes: 23 }, /traffic is building up/i],
    [{ kind: 'borderWait' }, /border crossing/i],
    [{ kind: 'jobs' }, /employment/i],
    [{ kind: 'jobsTotal' }, /employment/i],
    [{ kind: 'exchangeChange', weeklyDelta: 0.00031 }, /franc is strengthening/i],
    [{ kind: 'exchange' }, /exchange/i],
    [{ kind: 'fuelSaving', municipality: 'Chiasso', saving50LEur: 4.75 }, /refuell?ing/i],
    [{ kind: 'fuel' }, /refuell?ing/i],
    [{ kind: 'dailyBrief' }, /cross-border commuter train/i],
  ];

  for (const [headline, expectedScene] of cases) {
    const prompt = buildDailyBriefCoverPrompt(headline);
    assert.match(prompt, expectedScene, headline.kind);
    assert.doesNotMatch(prompt, /\b(?:247|18\.4|23|0\.00031|4\.75)\b/);
    assert.match(prompt, /no words, numbers, dates, signage, flags, logos/i);
    const context = buildDailyBriefImageContext(headline, 'bollettino-frontaliere-2026-10-18');
    assert.equal(context.title, 'Bollettino del Frontaliere');
    assert.equal(context.imagePrompt, prompt);
    assert.ok(!JSON.stringify(context).includes('247'));
    assert.match(buildDailyBriefCoverAlt(headline).it, /^Illustrazione di /);
  }

  const actualPreview = buildDailyBriefArticle({
    dateIso: '2026-10-18',
    blocks: { jobs: { available: true, yesterdayAdded: 942, activeJobs: 22645, activeCompanies: 857 } },
    insights: { jobs: {
      lastClosedDay: '2026-10-17',
      currentWeekAdded: 6942,
      previousWeekAdded: 9713,
      weeklyChange: -2771,
      weeklyChangePct: -28.5,
      currentPeriod: { from: '2026-10-11', to: '2026-10-17' },
      previousPeriod: { from: '2026-10-04', to: '2026-10-10' },
    } },
  });
  const actualPreviewHeadline = actualPreview._headline;
  assert.equal(actualPreviewHeadline.kind, 'jobsTrend');
  assert.equal(actualPreviewHeadline.weeklyChange, -2771);
  assert.match(actualPreview.content.it.body1, /6[.,’']?942/);
  const actualPrompt = buildDailyBriefCoverPrompt(actualPreviewHeadline);
  assert.match(actualPrompt, /cross-border employment/i);
  assert.doesNotMatch(actualPrompt, /employment trend is falling|unemployment|job losses/i);
  assert.doesNotMatch(actualPrompt, /6942|9713|2771|28\.5/);
  for (const locale of ['it', 'en', 'de', 'fr']) {
    assert.match(buildDailyBriefCoverAlt(actualPreviewHeadline)[locale], /workplace|ambiente di lavoro|Arbeitsplatz|lieu de travail/i);
    assert.doesNotMatch(buildDailyBriefCoverAlt(actualPreviewHeadline)[locale], /6942|9713|2771|28\.5/);
  }
  const photoAlt = buildDailyBriefCoverAlt(actualPreviewHeadline, { photograph: true });
  assert.match(photoAlt.it, /^Fotografia di /);
  assert.match(photoAlt.en, /^Photograph of /);
  assert.match(photoAlt.de, /^Foto von /);
  assert.match(photoAlt.fr, /^Photographie de /);
});

test('daily trend scenes reject missing, malformed and non-finite evidence', () => {
  for (const value of [null, '', [], true, '3', Infinity, -Infinity, NaN]) {
    assert.throws(
      () => buildDailyBriefCoverPrompt({ kind: 'borderWaitChange', changeMinutes: value }),
      /finite numeric changeMinutes/,
      `changeMinutes=${String(value)}`,
    );
    assert.throws(
      () => buildDailyBriefCoverPrompt({ kind: 'exchangeChange', weeklyDelta: value }),
      /finite numeric weeklyDelta/,
      `weeklyDelta=${String(value)}`,
    );
  }
  assert.throws(
    () => buildDailyBriefCoverPrompt({ kind: 'jobsTrend', weeklyChange: Infinity }),
    /finite numeric weeklyChange/,
  );
});

test('a malformed daily engine result always releases its staging directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-brief-staging-cleanup-'));
  const stagingDir = path.join(root, '.cache/generated-article-images/orphaned');
  const filePath = path.join(stagingDir, 'candidate.webp');
  const data = { id: 'bollettino-frontaliere-2026-10-18' };
  try {
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(filePath, 'wrong bytes');
    await assert.rejects(materializeDailyBriefHero({
      root,
      data,
      result: {
        filePath,
        stagingDir,
        record: {
          scope: 'article-hero',
          assetId: articleImageAssetId(data),
          imageUrl: `/images/blog/${articleImageAssetId(data)}.webp`,
          width: 1200,
          height: 675,
          bytes: 20,
          sha256: '0'.repeat(64),
        },
      },
    }), /bytes do not match/);
    assert.equal(fs.existsSync(stagingDir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a same-day deterministic card is replaced by a fresh governed hero', async () => {
  const root = tempRoot();
  const id = 'bollettino-frontaliere-2026-10-18';
  const data = { id };
  const oldRecord = buildDailyBriefImageRecord({
    id,
    sha256: 'a'.repeat(64),
    bytes: 64,
  });
  const oldPath = path.join(root, 'public', oldRecord.imageUrl.slice(1));
  const stagingDir = path.join(root, '.cache/generated-article-images/daily-test');
  const filePath = path.join(stagingDir, 'candidate.webp');
  const bytes = Buffer.from('fresh governed daily hero');
  const imageUrl = `/images/blog/${articleImageAssetId(data)}.webp`;
  const heroPath = path.join(root, 'public', imageUrl.slice(1));
  const thumbnailPath = path.join(
    path.dirname(heroPath),
    'thumbnails',
    `${path.basename(heroPath, path.extname(heroPath))}-480w.webp`,
  );
  const record = {
    schema: 1,
    assetId: articleImageAssetId(data),
    provider: 'openai-codex',
    model: 'gpt-image-2.5',
    executorModel: 'gpt-5.6-luna',
    promptVersion: GENERATED_IMAGE_PROMPT_VERSION,
    promptHash: 'b'.repeat(64),
    license: GENERATED_IMAGE_LICENSE,
    licenseUrl: GENERATED_IMAGE_LICENSE_URLS['openai-codex'],
    credit: GENERATED_IMAGE_CREDIT,
    bytes: bytes.length,
    sha256: '0'.repeat(64),
    width: 1200,
    height: 675,
    format: 'webp',
    generatedAt: '2026-10-18T12:00:00.000Z',
    verifiedAt: '2026-10-18T12:00:01.000Z',
    restrictions: [...GENERATED_IMAGE_RESTRICTIONS],
    scope: 'article-hero',
    imageUrl,
    area: 'Ticino e pendolarismo transfrontaliero',
    season: 'all seasons',
    variant: 'article hero',
    vision: {
      ok: true,
      contains_text: false,
      contains_logo: false,
      contains_recognizable_face: false,
      contains_recognizable_foreground_person: false,
      looks_like_specific_real_event: false,
      is_photograph: false,
      is_topic_relevant: true,
      notes: 'Fresh topical hero fixture.',
    },
  };

  try {
    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    fs.writeFileSync(oldPath, Buffer.alloc(64, 0x61));
    oldRecord.sha256 = sha256File(oldPath);
    appendGeneratedImageRecord(root, oldRecord);
    fs.mkdirSync(path.dirname(heroPath), { recursive: true });
    fs.mkdirSync(path.dirname(thumbnailPath), { recursive: true });
    fs.writeFileSync(heroPath, Buffer.from('previous hero'));
    fs.writeFileSync(thumbnailPath, Buffer.from('previous thumbnail'));
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(filePath, bytes);
    record.sha256 = sha256File(filePath);

    const originalRenameSync = fs.renameSync;
    let renameCount = 0;
    fs.renameSync = ((...args) => {
      renameCount += 1;
      if (renameCount === 2) throw new Error('injected thumbnail publish failure');
      return originalRenameSync(...args);
    });
    try {
      await assert.rejects(materializeDailyBriefHero({
        root,
        data,
        result: { filePath, stagingDir, record },
        generateThumbnail: async () => Buffer.from('fresh thumbnail'),
      }), /injected thumbnail publish failure/);
    } finally {
      fs.renameSync = originalRenameSync;
    }
    assert.equal(fs.readFileSync(heroPath, 'utf8'), 'previous hero');
    assert.equal(fs.readFileSync(thumbnailPath, 'utf8'), 'previous thumbnail');
    for (const dir of [path.dirname(heroPath), path.dirname(thumbnailPath)]) {
      assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
    }

    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(filePath, bytes);
    record.sha256 = sha256File(filePath);

    const result = await materializeDailyBriefHero({
      root,
      data,
      result: { filePath, stagingDir, record },
      generateThumbnail: async () => Buffer.from('thumbnail'),
    });

    assert.equal(result.imageUrl, imageUrl);
    assert.equal(data._generatedImagePath, imageUrl);
    assert.equal(data.image, path.basename(imageUrl));
    assert.equal(imageRecordForPath(root, imageUrl, { strict: true }).kind, 'generated');
    assert.equal(imageRecordForPath(root, oldRecord.imageUrl, { strict: true }).kind, DETERMINISTIC_CARD_KIND);
    assert.equal(fs.existsSync(stagingDir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a licensed daily cover keeps its photo credit and localized photographic alt', async () => {
  const root = tempRoot();
  const data = {
    id: 'bollettino-frontaliere-2026-10-18',
    _headline: { kind: 'jobsTrend', weeklyChange: -2771 },
  };
  const stagingDir = path.join(root, '.cache/generated-article-images/daily-photo');
  const filePath = path.join(stagingDir, 'licensed-candidate.webp');
  const bytes = Buffer.from('licensed daily cover photo');
  const assetId = articleImageAssetId(data);
  const imageUrl = `/images/blog/${assetId}.webp`;
  const record = {
    schema: 1,
    assetId,
    kind: LICENSED_PHOTO_KIND,
    provider: 'wikimedia',
    model: 'Wikimedia Commons file mirror',
    executorModel: 'Wikimedia Commons file mirror',
    license: 'CC BY-SA 4.0',
    licenseFamily: 'cc-by-sa',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    credit: 'Ada Foto · CC BY-SA 4.0',
    author: { name: 'Ada Foto', url: 'https://commons.wikimedia.org/wiki/User:Ada_Foto' },
    sourcePageUrl: 'https://commons.wikimedia.org/wiki/File:Ticino_workplace.jpg',
    sourceImageUrl: 'https://upload.wikimedia.org/commons/Ticino_workplace.jpg',
    sourceWidth: 2400,
    sourceHeight: 1600,
    photoTitle: 'Ticino workplace.jpg',
    copyrightNotice: '© Ada Foto',
    acquireLicensePage: 'https://commons.wikimedia.org/wiki/File:Ticino_workplace.jpg',
    modifications: ['cropped', 'resized', 'converted-to-webp'],
    bytes: bytes.length,
    sha256: '0'.repeat(64),
    width: 1200,
    height: 675,
    format: 'webp',
    generatedAt: '2026-10-18T12:00:00.000Z',
    verifiedAt: '2026-10-18T12:00:01.000Z',
    restrictions: [...LICENSED_PHOTO_RESTRICTIONS],
    scope: 'article-hero',
    imageUrl,
    vision: {
      ok: true,
      contains_text: false,
      contains_logo: false,
      contains_recognizable_face: false,
      contains_recognizable_foreground_person: false,
      looks_like_specific_real_event: true,
      is_photograph: true,
      is_topic_relevant: true,
      notes: 'Licensed relevant documentary photograph fixture.',
    },
  };

  try {
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(filePath, bytes);
    record.sha256 = sha256File(filePath);

    await materializeDailyBriefHero({
      root,
      data,
      result: { filePath, stagingDir, record },
      generateThumbnail: async () => Buffer.from('thumbnail'),
    });

    assert.equal(data._generatedImageRecord, null);
    assert.equal(data._imageCredit.source, 'licensed-photo');
    assert.equal(data.imageAlt.it, 'Fotografia di un ambiente di lavoro contemporaneo vicino a una stazione ferroviaria in Ticino.');
    assert.equal(data.imageAlt.en, 'Photograph of a contemporary workplace beside a railway station in Ticino.');
    assert.match(data.imageAlt.de, /^Foto von /);
    assert.match(data.imageAlt.fr, /^Photographie de /);

    const registryPath = path.join(root, 'content/blog-articles-data.ts');
    const seoPath = path.join(root, 'content/seo/seo-blog-1.ts');
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.mkdirSync(path.dirname(seoPath), { recursive: true });
    fs.writeFileSync(registryPath, [
      'export const ARTICLES = [',
      '  {',
      `    id: '${data.id}',`,
      "    image: '/images/blog/legacy-cover.webp',",
      '  },',
      '];',
      '',
    ].join('\n'));
    fs.writeFileSync(seoPath, [
      "const BASE_URL = 'https://frontaliereticino.ch';",
      'const BLOG_SEO_METADATA = {',
      `  'blog-${data.id}': {`,
      '    structuredData: {',
      '      "image": {',
      '        "@type": "ImageObject",',
      '        "url": `${BASE_URL}/images/blog/legacy-cover.webp`,',
      '        "width": 1200,',
      '        "height": 675,',
      '        "caption": "Legacy cover"',
      '      }',
      '    }',
      '  },',
      '};',
      'export default BLOG_SEO_METADATA;',
      '',
    ].join('\n'));

    const refresh = refreshGovernedArticleCover({
      repoRoot: root,
      articleId: data.id,
      imagePath: data._generatedImagePath,
      caption: data.imageAlt.it,
      registryFiles: ['data/blog-articles-data.ts'],
      section: 'frontaliere',
    });
    assert.equal(refresh.changed, true);
    assert.ok(
      fs.readFileSync(seoPath, 'utf8').includes(JSON.stringify(data.imageAlt.it)),
      'the refreshed JSON-LD caption must use the post-materialization photographic alt',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the daily workflow commits and reconciles the cover-provenance ledger', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/generate-daily-brief.yml'), 'utf8');
  const commitStep = workflow.slice(workflow.indexOf('- name: Commit and push'));
  const cacheCheck = commitStep.indexOf('git diff --cached --quiet');
  const registryStage = commitStep.indexOf('data/generated-image-registry.json');
  assert.ok(registryStage >= 0 && registryStage < cacheCheck, 'the generated-image registry must be staged before the cache check');
  const snapshot = commitStep.indexOf('cp data/generated-image-registry.json "$registry_snapshot"');
  const pushLoop = commitStep.indexOf('for attempt in 1 2 3; do');
  assert.ok(snapshot >= 0 && snapshot < pushLoop, 'the run snapshot must be captured before retries');
  assert.match(
    commitStep,
    /bash scripts\/lib\/rebase-onto-remote\.sh "\$REMOTE" "\$TARGET" \\\n\s+data\/generated-image-registry\.json/,
  );
  assert.match(
    commitStep,
    /node scripts\/ci\/merge-generated-image-registry\.mjs[\s\S]*data\/generated-image-registry\.json "\$registry_base" "\$registry_snapshot"/,
  );
  assert.doesNotMatch(commitStep, /git pull --rebase "\$REMOTE" "\$TARGET"/);

  const publishWorkflow = fs.readFileSync(path.join(ROOT, '.github/workflows/publish-api.yml'), 'utf8');
  assert.match(publishWorkflow, /^\s*- 'data\/generated-image-registry\.json'$/m);
});
