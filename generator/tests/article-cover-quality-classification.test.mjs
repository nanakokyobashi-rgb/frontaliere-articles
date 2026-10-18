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
