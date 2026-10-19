import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, '..', 'scripts', 'create-article.mjs'), 'utf8');

function loadQualityClassifier() {
  const start = SRC.indexOf('function isQualityRejectError(e) {');
  assert.notEqual(start, -1, 'classifier qualità mancante');
  const end = SRC.indexOf('\n}\n', start);
  assert.ok(end > start, 'classifier qualità non chiuso');
  const source = SRC.slice(start, end + 2);
  return new Function(
    'isFactCheckUnavailableError',
    'isRegisterLockError',
    'isRegisterLockHeld',
    `${source}\nreturn isQualityRejectError;`,
  )(
    error => error?.factCheckUnavailable === true,
    error => error?.registerLock === true,
    () => false,
  );
}

function loadCoverDeferralClassifier() {
  const start = SRC.indexOf('function isRetryableArticleCoverError(e) {');
  assert.notEqual(start, -1, 'classifier cover retryable mancante');
  const end = SRC.indexOf('\n}\n', start);
  assert.ok(end > start, 'classifier cover retryable non chiuso');
  const source = SRC.slice(start, end + 2);
  return new Function(
    'ARTICLE_COVER_FALLBACK_ERROR_CODES',
    source + '\nreturn isRetryableArticleCoverError;',
  )({
    NO_RELEVANT_CANDIDATE: 'ARTICLE_COVER_NO_RELEVANT_FALLBACK',
    VERIFICATION_UNAVAILABLE: 'ARTICLE_COVER_VERIFICATION_UNAVAILABLE',
    STALE_VERIFICATION: 'ARTICLE_COVER_VERIFICATION_STALE',
  });
}

test('a deterministic no-relevant-cover result skips its article; verifier outages stay retryable', () => {
  const isQualityRejectError = loadQualityClassifier();

  assert.equal(isQualityRejectError({
    code: 'ARTICLE_COVER_NO_RELEVANT_FALLBACK',
    retryable: true,
    imageQualityFailure: true,
  }), true, 'un rifiuto vision confermato è un problema della candidata, non del pool intero');

  assert.equal(isQualityRejectError({
    code: 'ARTICLE_COVER_VERIFICATION_UNAVAILABLE',
    retryable: true,
  }), false, 'un verifier temporaneamente indisponibile non deve consumare una candidata');

  assert.equal(isQualityRejectError({
    code: 'ARTICLE_COVER_NO_RELEVANT_FALLBACK',
    retryable: true,
  }), false, 'il codice generico senza il marker deterministico non basta a riclassificare');
});

test('a retryable cover-boundary failure defers the run without weakening the image gate', () => {
  const isRetryableArticleCoverError = loadCoverDeferralClassifier();

  assert.equal(isRetryableArticleCoverError({
    code: 'ARTICLE_COVER_VERIFICATION_UNAVAILABLE',
    retryable: true,
  }), true);
  assert.equal(isRetryableArticleCoverError({
    code: 'ARTICLE_COVER_VERIFICATION_STALE',
    retryable: true,
  }), true);
  assert.equal(isRetryableArticleCoverError({
    code: 'ARTICLE_COVER_NO_RELEVANT_FALLBACK',
    retryable: true,
  }), true);
  assert.equal(isRetryableArticleCoverError({
    code: 'ARTICLE_COVER_NO_RELEVANT_FALLBACK',
    retryable: true,
    imageQualityFailure: true,
  }), false, 'un rifiuto vision deterministico resta una rejection della candidata');
  assert.equal(isRetryableArticleCoverError({
    code: 'SOME_OTHER_ERROR',
    retryable: true,
  }), false);
  assert.equal(isRetryableArticleCoverError({
    code: 'ARTICLE_COVER_VERIFICATION_UNAVAILABLE',
    retryable: false,
  }), false);
});

test('the top-level catch has a declared exit for retryable cover failures', () => {
  assert.match(
    SRC,
    /if \(isRetryableArticleCoverError\(e\)\) \{[\s\S]*?EXIT_NO_ARTICLE_DECLARED/,
    'il guasto del verifier cover non deve ricadere sull\\'exit 1 generico',
  );
});

test('a cover-only rejection skips an evergreen candidate without striking its topic keyword', () => {
  const strikeCondition = 'isQualityReject && e.imageQualityFailure !== true && selectedTopic';
  assert.ok(SRC.includes(`} else if (${strikeCondition}) {`), 'il ramo strike evergreen deve escludere esplicitamente i rifiuti solo immagine');
  const mayStrikeKeyword = new Function('isQualityReject', 'e', 'selectedTopic', `return ${strikeCondition};`);

  assert.equal(mayStrikeKeyword(true, { imageQualityFailure: true }, true), false);
  assert.equal(mayStrikeKeyword(true, { qualityReject: true }, true), true);
  assert.equal(mayStrikeKeyword(false, { retryable: true }, true), false);
});
