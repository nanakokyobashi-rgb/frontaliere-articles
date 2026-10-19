import '../../host/cantonSectionsBootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATALOG_FALLBACK_MIN_SHARED_WORDS,
  catalogFallbackSharedWordCount,
  classifyImageRegenerationFailure,
  queueArticleCoverRegeneration,
  resolveArticleCoverFallback,
  verifyCatalogFallbackCandidates,
} from '../scripts/lib/article-cover-fallback.mjs';
import { articleImageAssetId } from '../scripts/lib/article-cover-identity.mjs';
import {
  appendGeneratedImageRecord,
  imageRecordForPath,
  readGeneratedImageRecords,
  sha256File,
} from '../scripts/lib/blog-image-registry.mjs';
import { buildSeoImageBlock } from '../scripts/lib/seo-entry-builder.mjs';
import {
  GENERATED_IMAGE_CREDIT,
  GENERATED_IMAGE_LICENSE,
  GENERATED_IMAGE_LICENSE_URLS,
  GENERATED_IMAGE_PROMPT_VERSION,
  GENERATED_IMAGE_RESTRICTIONS,
  LICENSED_PHOTO_RESTRICTIONS,
} from '../../engine/shared/generatedImageRegistry.mjs';
import {
  imageVisionRejectionError,
  isCompleteArticleHeroVisionVerdict,
} from '../../engine/shared/generatedImageVision.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the fallback consumer loads its pure vision contract without native addons', () => {
  const fallbackUrl = new URL('../scripts/lib/article-cover-fallback.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [
    '--no-addons',
    '--input-type=module',
    '--eval',
    `await import(${JSON.stringify(fallbackUrl.href)})`,
  ], { encoding: 'utf8', timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const source = fs.readFileSync(fileURLToPath(fallbackUrl), 'utf8');
  assert.match(source, /from ['"]\.\.\/\.\.\/\.\.\/engine\/shared\/generatedImageVision\.mjs['"]/);
  assert.match(source, /await import\(['"]\.\.\/\.\.\/\.\.\/engine\/shared\/generatedImageEngine\.mjs['"]\)/);
  assert.doesNotMatch(source, /from ['"][^'"]*generatedImageEngine\.mjs['"]/);
});

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cover-fallback-'));
}
function generatedCatalogRecord() {
  return {
    schema: 1,
    assetId: 'catalog-fallback-test',
    provider: 'openai-codex',
    model: 'gpt-image-2.5',
    executorModel: 'gpt-5.6-luna',
    promptVersion: GENERATED_IMAGE_PROMPT_VERSION,
    promptHash: 'a'.repeat(64),
    license: GENERATED_IMAGE_LICENSE,
    licenseUrl: GENERATED_IMAGE_LICENSE_URLS['openai-codex'],
    credit: GENERATED_IMAGE_CREDIT,
    width: 1200,
    height: 675,
    format: 'webp',
    bytes: 1024,
    sha256: '0'.repeat(64),
    generatedAt: '2026-10-07T00:00:00.000Z',
    verifiedAt: '2026-10-07T00:01:00.000Z',
    restrictions: [...GENERATED_IMAGE_RESTRICTIONS],
    scope: 'article-hero',
    imageUrl: '/images/blog/catalog-fallback-test.webp',
    vision: {
      ok: true,
      contains_text: false,
      contains_logo: false,
      contains_recognizable_face: false,
      looks_like_specific_real_event: false,
      notes: 'generic catalog illustration',
    },
  };
}

function licensedCatalogRecord() {
  return {
    schema: 1,
    assetId: 'licensed-cover-ledger-test',
    kind: 'photo',
    provider: 'wikimedia',
    model: 'Wikimedia Commons file mirror',
    executorModel: 'Wikimedia Commons file mirror',
    license: 'CC BY-SA 4.0',
    licenseFamily: 'cc-by-sa',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    credit: 'Ada Foto · CC BY-SA 4.0',
    author: { name: 'Ada Foto', url: 'https://commons.wikimedia.org/wiki/User:Ada_Foto' },
    sourcePageUrl: 'https://commons.wikimedia.org/wiki/File:Zurich_employment_office.jpg',
    sourceImageUrl: 'https://upload.wikimedia.org/commons/Zurich_employment_office.jpg',
    sourceWidth: 2400,
    sourceHeight: 1600,
    photoTitle: 'Zurich employment office.jpg',
    copyrightNotice: '© Ada Foto',
    acquireLicensePage: 'https://commons.wikimedia.org/wiki/File:Zurich_employment_office.jpg',
    modifications: ['cropped', 'resized', 'converted-to-webp'],
    width: 1200,
    height: 675,
    format: 'webp',
    bytes: 1024,
    sha256: '0'.repeat(64),
    generatedAt: '2026-10-08T00:00:00.000Z',
    verifiedAt: '2026-10-08T00:01:00.000Z',
    restrictions: [...LICENSED_PHOTO_RESTRICTIONS],
    scope: 'article-hero',
    imageUrl: '/images/blog/licensed-cover-ledger-test.webp',
    vision: {
      ok: true,
      contains_text: false,
      contains_logo: false,
      contains_recognizable_face: false,
      contains_recognizable_foreground_person: false,
      looks_like_specific_real_event: false,
      is_photograph: true,
      is_topic_relevant: true,
      notes: 'relevant, unbranded landscape photograph',
    },
  };
}

function article(id, title = 'Titolo di prova') {
  return {
    id,
    content: { it: { title } },
  };
}

const safeGeneratedVision = Object.freeze({
  ok: true,
  contains_text: false,
  contains_logo: false,
  contains_recognizable_face: false,
  contains_recognizable_foreground_person: false,
  looks_like_specific_real_event: false,
  is_photograph: false,
  is_topic_relevant: true,
  notes: 'Relevant generated image without prohibited content.',
});

async function addAndVerifyCandidate(root, data, record = generatedCatalogRecord(), vision = safeGeneratedVision) {
  const file = path.join(root, 'public', record.imageUrl.slice(1));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(record.bytes, 0x47));
  record.sha256 = sha256File(file);
  appendGeneratedImageRecord(root, record);
  const verifiedCatalogImage = await verifyCatalogFallbackCandidates(data, {
    root,
    findCatalogImages: () => [record.imageUrl],
    verifyImage: async () => (typeof vision === 'function' ? vision() : vision),
  });
  return { record, file, verifiedCatalogImage };
}

test('engine failure uses a freshly verified catalog hero and queues regeneration', async () => {
  const root = tempRoot();
  try {
    const data = article('article-cover-fallback', 'Catalog fallback test');
    const { record, verifiedCatalogImage } = await addAndVerifyCandidate(root, data);
    const result = resolveArticleCoverFallback(data, {
      root,
      verifiedCatalogImage,
      reason: 'Gemini image request failed with HTTP 400',
    });

    assert.equal(result.source, 'catalog-fallback');
    assert.equal(data._generatedImagePath, record.imageUrl);
    assert.equal(data._generatedImageRecord.assetId, record.assetId);
    assert.match(data.imageAlt.it, /illustrativ/i);
    assert.equal(data.qualityReject, undefined);
    assert.equal(data.imagePolicyReject, undefined);
    assert.equal(fs.existsSync(path.join(root, 'data/image-regeneration-queue.json')), false);
    queueArticleCoverRegeneration(root, data);
    const queue = JSON.parse(fs.readFileSync(path.join(root, 'data/image-regeneration-queue.json'), 'utf8'));
    assert.equal(queue.schema, 1);
    assert.equal(queue.items.length, 1);
    assert.equal(queue.items[0].fallbackImage, record.imageUrl);
    assert.match(queue.items[0].reason, /HTTP 400/);
    assert.equal(imageRecordForPath(root, record.imageUrl, { strict: true }).kind, 'generated');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('skipped, unavailable, or non-topic vision never grants a fallback token', async () => {
  const root = tempRoot();
  try {
    const data = article('fallback-verifier-outcomes', 'Cross-border jobs in Ticino');
    const { record } = await addAndVerifyCandidate(root, data);
    const cases = [
      { name: 'skipped', verifyImage: async () => undefined, code: 'ARTICLE_COVER_VERIFICATION_UNAVAILABLE' },
      { name: 'unavailable', verifyImage: async () => { throw new Error('vision service unavailable'); }, code: 'ARTICLE_COVER_VERIFICATION_UNAVAILABLE' },
      {
        name: 'shared provider outage',
        verifyImage: async () => {
          const error = new Error('vision provider unavailable');
          error.sharedProviderUnavailable = true;
          throw error;
        },
        code: 'ARTICLE_COVER_VERIFICATION_UNAVAILABLE',
        sharedProviderUnavailable: true,
      },
      {
        name: 'missing topic signal',
        verifyImage: async () => {
          const { is_topic_relevant: _topic, ...partial } = safeGeneratedVision;
          return partial;
        },
        code: 'ARTICLE_COVER_VERIFICATION_UNAVAILABLE',
      },
      {
        name: 'negative topic signal',
        verifyImage: async () => ({ ...safeGeneratedVision, is_topic_relevant: false }),
        code: 'ARTICLE_COVER_NO_RELEVANT_FALLBACK',
        imageQualityFailure: true,
      },
    ];

    for (const scenario of cases) {
      await assert.rejects(verifyCatalogFallbackCandidates(data, {
        root,
        findCatalogImages: () => [record.imageUrl],
        verifyImage: scenario.verifyImage,
      }), (error) => error.code === scenario.code
        && error.retryable === true
        && Boolean(error.sharedProviderUnavailable) === (scenario.sharedProviderUnavailable === true)
        && Boolean(error.imageQualityFailure) === (scenario.imageQualityFailure === true), scenario.name);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('injected verdicts do not poison the production cache, which is keyed by bytes and context', async () => {
  const root = fs.mkdtempSync(path.join(ROOT, '.cover-fallback-cache-test-'));
  const socketPath = path.join(os.tmpdir(), `cover-fallback-vision-${process.pid}-${Date.now()}.sock`);
  const originalSocket = process.env.CODEX_AUTH_BROKER_SOCKET;
  let providerCalls = 0;
  const verdicts = [
    safeGeneratedVision,
    { ...safeGeneratedVision, is_topic_relevant: false, notes: 'This image is not about the current article.' },
  ];
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.once('data', () => {
      const verdict = verdicts[Math.min(providerCalls, verdicts.length - 1)];
      providerCalls += 1;
      socket.end(`${JSON.stringify({ ok: true, result: JSON.stringify(verdict) })}\n`);
    });
  });

  try {
    const data = article('fallback-cache-policy', 'Cross-border jobs in Ticino');
    const { record } = await addAndVerifyCandidate(root, data, generatedCatalogRecord());
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    process.env.CODEX_AUTH_BROKER_SOCKET = socketPath;

    // A test seam can grant a private test token, but it must not populate the
    // cache read by the production verifier on the next call.
    await verifyCatalogFallbackCandidates(data, {
      root,
      findCatalogImages: () => [record.imageUrl],
      verifyImage: async () => safeGeneratedVision,
    });
    await verifyCatalogFallbackCandidates(data, {
      root,
      findCatalogImages: () => [record.imageUrl],
    });
    assert.equal(providerCalls, 1, 'the production verifier must execute after an injected verdict');

    await verifyCatalogFallbackCandidates(data, {
      root,
      findCatalogImages: () => [record.imageUrl],
    });
    assert.equal(providerCalls, 1, 'the same verified bytes and context may reuse the production result');

    data.content.it.title = 'Swiss pharmacy opening hours';
    await assert.rejects(verifyCatalogFallbackCandidates(data, {
      root,
      findCatalogImages: () => [record.imageUrl],
    }), (error) => error.code === 'ARTICLE_COVER_NO_RELEVANT_FALLBACK'
      && error.imageQualityFailure === true);
    assert.equal(providerCalls, 2, 'a changed article context must be verified again');
  } finally {
    if (originalSocket === undefined) delete process.env.CODEX_AUTH_BROKER_SOCKET;
    else process.env.CODEX_AUTH_BROKER_SOCKET = originalSocket;
    await new Promise((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a changed or missing binary invalidates the fallback capability as retryable stale state', async () => {
  const root = tempRoot();
  try {
    const data = article('fallback-stale-capability', 'Cross-border jobs in Ticino');
    const { file, verifiedCatalogImage } = await addAndVerifyCandidate(root, data);
    fs.rmSync(file);

    assert.throws(() => resolveArticleCoverFallback(data, { root, verifiedCatalogImage }), {
      code: 'ARTICLE_COVER_VERIFICATION_STALE',
      retryable: true,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('un rifiuto vision interamente non adattabile resta nel ledger come terminale', async () => {
  const root = tempRoot();
  try {
    const data = article('terminal-vision-cover');
    const { verifiedCatalogImage } = await addAndVerifyCandidate(root, data);
    const failure = new Error('All image providers failed');
    failure.failures = [
      { provider: 'openai-codex', reason: 'vision gate rejected image: recognizable foreground person' },
      { provider: 'gemini', reason: 'vision gate rejected image: recognizable human face' },
    ];
    failure.imageProviderLedger = {
      schema: 1,
      complete: true,
      expectedProviders: ['openai-codex', 'gemini'],
      attemptedProviders: ['openai-codex', 'gemini'],
    };
    data._imageGenerationFailureDisposition = classifyImageRegenerationFailure(failure);
    resolveArticleCoverFallback(data, {
      root,
      verifiedCatalogImage,
      reason: failure.message,
    });
    queueArticleCoverRegeneration(root, data);

    const queued = JSON.parse(
      fs.readFileSync(path.join(root, 'data/image-regeneration-queue.json'), 'utf8'),
    ).items[0];
    assert.equal(queued.status, 'terminal');
    assert.equal(queued.terminalReason, 'vision-safety-rejection');
    assert.equal(queued.terminalAt, queued.requestedAt);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('un errore transient o un rifiuto testuale adattabile resta retryable', () => {
  const transient = new Error('All image providers failed');
  transient.failures = [
    { provider: 'openai-codex', reason: 'provider unavailable' },
    { provider: 'gemini', reason: 'vision gate rejected image: recognizable face' },
  ];
  const adaptable = new Error('All image providers failed');
  adaptable.failures = [
    { provider: 'openai-codex', reason: 'vision gate rejected image: visible lettering and signage' },
  ];

  assert.equal(classifyImageRegenerationFailure(transient).retryable, true);
  assert.equal(classifyImageRegenerationFailure(adaptable).retryable, true);
  assert.equal(
    classifyImageRegenerationFailure(new Error('vision gate rejected image: recognizable face')).retryable,
    true,
    'un messaggio senza il ledger completo dei provider non prova la terminalità',
  );
});

test('solo un ledger completo e riconosciuto prova la terminalità vision', () => {
  const partial = new Error('image generation deadline exceeded');
  partial.imageProviderLedger = {
    schema: 1,
    complete: false,
    expectedProviders: ['openai-codex', 'gemini'],
    attemptedProviders: ['openai-codex'],
  };
  partial.failures = [
    { provider: 'openai-codex', reason: 'vision gate rejected image: recognizable foreground person' },
  ];
  assert.equal(classifyImageRegenerationFailure(partial).retryable, true, 'deadline: catena incompleta');

  const malformed = new Error('All image providers failed');
  malformed.imageProviderLedger = {
    schema: 1,
    complete: true,
    expectedProviders: ['openai-codex', 'gemini'],
    attemptedProviders: ['openai-codex', 'gemini'],
  };
  malformed.failures = [
    { provider: 'openai-codex', reason: 'vision gate rejected image: recognizable foreground person' },
    { provider: 'gemini', reason: '' },
  ];
  assert.equal(classifyImageRegenerationFailure(malformed).retryable, true, 'reason vuoto: fail-closed');

  const flagsWithoutNotes = new Error('All image providers failed');
  flagsWithoutNotes.imageProviderLedger = {
    schema: 1,
    complete: true,
    expectedProviders: ['openai-codex', 'gemini'],
    attemptedProviders: ['openai-codex', 'gemini'],
  };
  flagsWithoutNotes.failures = [
    { provider: 'openai-codex', reason: 'vision gate rejected image: generic synthetic illustration', vision: { contains_text: true } },
    { provider: 'gemini', reason: 'vision gate rejected image: generic synthetic illustration', vision: { contains_logo: true } },
  ];
  assert.deepEqual(classifyImageRegenerationFailure(flagsWithoutNotes), {
    retryable: true,
    reason: 'transient-or-adaptable',
    retryHint: 'no-text',
  });

  const legacy = new Error('All image providers failed');
  legacy.imageProviderChain = ['openai-codex'];
  legacy.failures = [
    { provider: 'openai-codex', reason: 'vision gate rejected image: recognizable face' },
  ];
  assert.equal(classifyImageRegenerationFailure(legacy).retryable, true, 'lo schema legacy non prova il completamento');
});

test('i flag vision strutturati governano adattamento e terminalità senza dipendere dalle note', () => {
  const ledger = {
    schema: 1,
    complete: true,
    expectedProviders: ['openai-codex'],
    attemptedProviders: ['openai-codex'],
  };
  const cases = [
    [{ contains_text: true, contains_logo: false, contains_recognizable_face: true }, true],
    [{ contains_text: false, contains_logo: true, contains_recognizable_face: true }, true],
    [{ contains_text: true, contains_logo: true, contains_recognizable_face: false }, true],
    [{ contains_text: false, contains_logo: false, contains_recognizable_face: true }, false],
  ];

  for (const [vision, retryable] of cases) {
    const error = new Error('All image providers failed');
    error.imageProviderLedger = ledger;
    error.failures = [{
      provider: 'openai-codex',
      reason: 'vision gate rejected image: generic synthetic illustration',
      vision,
    }];
    const disposition = classifyImageRegenerationFailure(error);
    assert.equal(disposition.retryable, retryable, JSON.stringify(vision));
    assert.equal(disposition.retryHint, retryable ? 'no-text' : undefined, JSON.stringify(vision));
  }

  const malformedFlag = new Error('All image providers failed');
  malformedFlag.imageProviderLedger = ledger;
  malformedFlag.failures = [{
    provider: 'openai-codex',
    reason: 'vision gate rejected image: recognizable face',
    vision: { contains_text: 'false', contains_recognizable_face: true },
  }];
  assert.equal(classifyImageRegenerationFailure(malformedFlag).retryable, true, 'flag malformato: fail-closed');

  const legacyFailure = new Error('All image providers failed');
  legacyFailure.imageProviderLedger = ledger;
  legacyFailure.failures = [{ provider: 'openai-codex', reason: 'vision gate rejected image: recognizable face' }];
  assert.equal(classifyImageRegenerationFailure(legacyFailure).retryable, false, 'record failure legacy riconosciuto');

  for (const reason of [
    'vision gate rejected image: no recognizable face',
    'vision gate rejected image: without identifiable person',
    'vision gate rejected image: {"contains_recognizable_face": false}',
    'vision gate rejected image: {"looks_like_specific_real_event": false}',
  ]) {
    const negatedLegacyFailure = new Error('All image providers failed');
    negatedLegacyFailure.imageProviderLedger = ledger;
    negatedLegacyFailure.failures = [{ provider: 'openai-codex', reason }];
    assert.equal(classifyImageRegenerationFailure(negatedLegacyFailure).retryable, true, reason);
  }

  const structuredNegative = new Error('All image providers failed');
  structuredNegative.imageProviderLedger = ledger;
  structuredNegative.failures = [{
    provider: 'openai-codex',
    reason: 'vision gate rejected image: recognizable face',
    vision: { contains_recognizable_face: false },
  }];
  assert.equal(classifyImageRegenerationFailure(structuredNegative).retryable, true, 'il flag strutturato prevale sulla nota');

  const structuredTerminalWithGenericNote = new Error('All image providers failed');
  structuredTerminalWithGenericNote.imageProviderLedger = ledger;
  structuredTerminalWithGenericNote.failures = [{
    provider: 'openai-codex',
    reason: 'vision gate rejected image: forbidden content',
    vision: { contains_text: false, contains_logo: false, contains_recognizable_face: true },
  }];
  assert.equal(
    classifyImageRegenerationFailure(structuredTerminalWithGenericNote).retryable,
    false,
    'una nota generica non scavalca i flag strutturati non adattabili',
  );
});

test('un flag strutturato text/logo persiste il retry hint anche con note generiche', async () => {
  const root = tempRoot();
  try {
    const failure = new Error('All image providers failed');
    failure.imageProviderLedger = {
      schema: 1,
      complete: true,
      expectedProviders: ['openai-codex'],
      attemptedProviders: ['openai-codex'],
    };
    failure.failures = [{
      provider: 'openai-codex',
      reason: 'vision gate rejected image: generic synthetic illustration',
      vision: { contains_text: true, contains_logo: false },
    }];
    const data = article('structured-text-retry-hint');
    const { verifiedCatalogImage } = await addAndVerifyCandidate(root, data);
    data._imageGenerationFailureDisposition = classifyImageRegenerationFailure(failure);
    resolveArticleCoverFallback(data, {
      root,
      verifiedCatalogImage,
      reason: failure.message,
    });
    queueArticleCoverRegeneration(root, data);

    const queued = JSON.parse(
      fs.readFileSync(path.join(root, 'data/image-regeneration-queue.json'), 'utf8'),
    ).items[0];
    assert.equal(queued.status, 'queued');
    assert.equal(queued.retryHint, 'no-text');
    assert.doesNotMatch(queued.reason, /text|logo/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a licensed article hero writes the shared attribution ledger and resolves as licensed-photo', async () => {
  const root = tempRoot();
  try {
    const record = licensedCatalogRecord();
    const file = path.join(root, 'public', record.imageUrl.slice(1));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(record.bytes, 0x47));
    record.sha256 = sha256File(file);
    appendGeneratedImageRecord(root, record);

    const persisted = JSON.parse(fs.readFileSync(path.join(root, 'content/image-credits/blog/licensed-cover-ledger-test.json'), 'utf8'));
    assert.equal(persisted.source, 'licensed-photo');
    assert.equal(persisted.photo.pageUrl, record.sourcePageUrl);
    assert.equal(persisted.licence.family, 'cc-by-sa');
    const provenance = imageRecordForPath(root, record.imageUrl, { strict: true });
    assert.equal(provenance.kind, 'licensed-photo');
    const data = article('licensed-cover-ledger-test', 'Tasse e lavoro a Zurigo');
    const licensedVision = {
      ...safeGeneratedVision,
      is_photograph: true,
      looks_like_specific_real_event: true,
      notes: 'Authorized documentary photo relevant to the topic.',
    };
    const verifiedCatalogImage = await verifyCatalogFallbackCandidates(data, {
      root,
      findCatalogImages: () => [record.imageUrl],
      verifyImage: async () => licensedVision,
    });
    resolveArticleCoverFallback(data, { root, verifiedCatalogImage });
    assert.equal(data._imageCredit.source, 'licensed-photo');
    assert.equal(data._imageCredit.licence.attributionRequired, true);
    assert.match(data.imageAlt.it, /^Fotografia /);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an incomplete licensed-photo safety verdict is unavailable, not a quality rejection', async () => {
  const root = tempRoot();
  try {
    const record = licensedCatalogRecord();
    const data = article('licensed-incomplete-verdict', 'Tasse e lavoro a Zurigo');
    const file = path.join(root, 'public', record.imageUrl.slice(1));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(record.bytes, 0x47));
    record.sha256 = sha256File(file);
    appendGeneratedImageRecord(root, record);

    const incompletePhotoVerdict = {
      ...safeGeneratedVision,
      contains_text: undefined,
      is_photograph: true,
      looks_like_specific_real_event: true,
      notes: '',
    };
    await assert.rejects(verifyCatalogFallbackCandidates(data, {
      root,
      findCatalogImages: () => [record.imageUrl],
      verifyImage: async () => incompletePhotoVerdict,
    }), (error) => error.code === 'ARTICLE_COVER_VERIFICATION_UNAVAILABLE'
      && error.retryable === true
      && !error.imageQualityFailure);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the shared article-hero checker accepts a complete documentary photo and supplies typed rejection flags', () => {
  const documentaryPhoto = {
    ...safeGeneratedVision,
    is_photograph: true,
    looks_like_specific_real_event: true,
    notes: '',
  };
  assert.equal(isCompleteArticleHeroVisionVerdict(documentaryPhoto), true);

  const rejectedPhoto = { ...documentaryPhoto, contains_logo: true };
  const error = imageVisionRejectionError(rejectedPhoto);
  assert.equal(error.code, 'IMAGE_VISION_REJECTED');
  assert.deepEqual(error.vision, {
    contains_text: false,
    contains_logo: true,
    contains_recognizable_face: false,
    contains_recognizable_foreground_person: false,
    looks_like_specific_real_event: true,
    is_photograph: true,
    is_topic_relevant: true,
  });
});

test('sostituire una foto licenziata con una cover generata rimuove il ledger obsoleto', () => {
  const root = tempRoot();
  try {
    const licensed = licensedCatalogRecord();
    appendGeneratedImageRecord(root, licensed);
    const creditFile = path.join(root, 'content/image-credits/blog/licensed-cover-ledger-test.json');
    assert.equal(fs.existsSync(creditFile), true);

    const generated = generatedCatalogRecord();
    generated.assetId = licensed.assetId;
    generated.imageUrl = licensed.imageUrl;
    appendGeneratedImageRecord(root, generated);

    assert.equal(fs.existsSync(creditFile), false);
    assert.equal(readGeneratedImageRecords(root).find((item) => item.assetId === licensed.assetId).provider, 'openai-codex');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('il blocco SEO di una foto licenziata espone autore, licenza e sorgente', () => {
  const record = licensedCatalogRecord();
  const block = buildSeoImageBlock({
    imagePath: record.imageUrl,
    provenance: { kind: 'licensed-photo', record },
    caption: 'Copertina fotografica',
  });
  assert.match(block, /"acquireLicensePage": "https:\/\/commons\.wikimedia\.org\/wiki\/File:Zurich_employment_office\.jpg"/);
  assert.match(block, /"license": "https:\/\/creativecommons\.org\/licenses\/by-sa\/4\.0\/"/);
  assert.match(block, /"creator": \{[^\n]*"name":"Ada Foto"/);
  assert.match(block, /"isBasedOn": "https:\/\/commons\.wikimedia\.org\/wiki\/File:Zurich_employment_office\.jpg"/);
});
test('un catalogo valido ma non pertinente non diventa la copertina finale', async () => {
  const root = tempRoot();
  try {
    const record = generatedCatalogRecord();
    const file = path.join(root, 'public', record.imageUrl.slice(1));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(record.bytes, 0x47));
    record.sha256 = sha256File(file);
    appendGeneratedImageRecord(root, record);

    const data = article('article-cover-irrelevant', 'Aggressione turisti Como');
    await assert.rejects(verifyCatalogFallbackCandidates(data, {
      root,
      findCatalogImages: () => [record.imageUrl],
      verifyImage: async () => ({ ...safeGeneratedVision, is_topic_relevant: false }),
    }), (error) => error.code === 'ARTICLE_COVER_NO_RELEVANT_FALLBACK'
      && error.imageQualityFailure === true);
    assert.equal(data._generatedImagePath, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('la pertinenza della cover usa il testo finale e una soglia condivisa', () => {
  const data = article('article-cantello-teatro', 'Cantello teatro dialettale ottobre');
  data.imagePrompt = 'Scena editoriale sul teatro dialettale di Cantello';
  assert.equal(
    catalogFallbackSharedWordCount(data, '/images/blog/cantello-teatro-dialettale-ottobre-2026.webp'),
    4,
  );
  assert.equal(
    catalogFallbackSharedWordCount(data, '/images/blog/sindacati-miazzina-diritti-9-ottobre.webp'),
    1,
  );
  assert.equal(CATALOG_FALLBACK_MIN_SHARED_WORDS, 2);
});

test('la pertinenza confronta token esatti e ignora category e imagePrompt boilerplate', () => {
  const data = article('article-casa-tassa', 'Casa tassa');
  data.category = 'fiscale';
  data.imagePrompt = 'Scena editoriale fiscale';

  assert.equal(
    catalogFallbackSharedWordCount(data, '/images/blog/casale-tassazione.webp'),
    0,
  );
  assert.equal(
    catalogFallbackSharedWordCount(data, '/images/blog/fiscale-editoriale.webp'),
    0,
  );
});

test('the mirrored engine closes photo collisions across legacy URL spellings', () => {
  const engine = fs.readFileSync(path.join(ROOT, 'engine/shared/generatedImageEngine.mjs'), 'utf8');
  assert.match(engine, /export function canonicalPhotoSourceUrl\(value\)/);
  assert.match(engine, /function recordSourcePageUrl\(record\)[\s\S]*?return canonicalPhotoSourceUrl\(record\?\.sourcePageUrl \|\| record\?\.pageUrl\)/);
  assert.match(engine, /const excludedPages = new Set\(\(excludedSourcePageUrls[\s\S]*?\.map\(canonicalPhotoSourceUrl\)/);
});

test('when no visually relevant catalog cover exists, nothing generic crosses the resolver', async () => {
  const root = tempRoot();
  try {
    const data = article('article-static-fallback');
    await assert.rejects(verifyCatalogFallbackCandidates(data, {
      root,
      findCatalogImages: () => [],
    }), (error) => error.code === 'ARTICLE_COVER_NO_RELEVANT_FALLBACK'
      && error.retryable === true
      && error.imageQualityFailure !== true);
    assert.throws(() => resolveArticleCoverFallback(data, { root }), {
      code: 'ARTICLE_COVER_NO_RELEVANT_FALLBACK',
      retryable: true,
    });
    assert.equal(data._generatedImagePath, undefined);
    assert.equal(fs.existsSync(path.join(root, 'data/image-regeneration-queue.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the generator lets the governed chain reach licensed photos and keeps the 120-second phase budget', () => {
  const source = fs.readFileSync(path.join(ROOT, 'generator/scripts/create-article.mjs'), 'utf8');
  const engine = fs.readFileSync(path.join(ROOT, 'generator/scripts/lib/article-cover-engine.mjs'), 'utf8');
  assert.doesNotMatch(engine, /maxAttempts:\s*1/);
  assert.match(engine, /usedRecords: photoUsage\.records/);
  assert.match(engine, /readCreditRecords\(root\)/);
  assert.match(engine, /export function legacyPhotoRecordKey\(file, record\)/);
  assert.match(engine, /legacyPhotoRecordKey\(file, record\)/);
  assert.match(engine, /const LEGACY_PHOTO_PAGE_RULES/);
  assert.match(engine, /parsed = new URL\(pageUrl\)/);
  assert.match(engine, /decodeURIComponent\(parsed\.pathname\)/);
  assert.match(engine, /normalizedPath/);
  assert.match(engine, /parsed\.pathname = normalizedPath/);
  assert.match(engine, /return parsed\.toString\(\)/);
  assert.match(engine, /export function photoPageUrlVariants\(provider, value\)/);
  assert.match(engine, /export function photoRecordPageUrlVariants\(record\)/);
  assert.match(engine, /LICENSED_PHOTO_PROVIDERS/);
  assert.match(engine, /generated\.push\(\.\.\.aliases\)/);
  assert.match(engine, /encodedPath/);
  assert.match(engine, /encodedSuffixPath/);
  assert.match(engine, /addPathVariants\(rawUrl, rawUrl\.pathname\)/);
  assert.match(engine, /parsed\.origin !== rule\.origin/);
  assert.match(engine, /pathPrefixes/);
  assert.match(engine, /parsed\.search/);
  assert.match(engine, /parsed\.hash/);
  assert.doesNotMatch(engine, /legacy-photo:/);
  assert.match(engine, /record, parseError \} of readCreditRecords\(root\)/);
  assert.match(engine, /if \(parseError !== null\)/);
  assert.match(engine, /hasUnmatchableLegacy/);
  assert.match(engine, /chain: DEFAULT_GENERATION_PROVIDER_CHAIN/);
  assert.match(engine, /topic: articleImageTopic/);
  assert.match(engine, /place: articleImagePlace\(articleData, area\)/);
  assert.match(engine, /keywords: articleImageKeywords/);
  assert.match(source, /Math\.min\(120_000/);
  assert.match(source, /generateGovernedArticleHero/);
  assert.match(source, /deadlineAt:\s*imageDeadline/);
});
