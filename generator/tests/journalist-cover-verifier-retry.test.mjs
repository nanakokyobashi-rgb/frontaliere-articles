import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, '..', 'scripts', 'publish-journalist-article.mjs'), 'utf8');

function loadDispositionClassifier() {
  const start = SRC.indexOf('function classifyJournalistPublishError(error) {');
  assert.notEqual(start, -1, 'classifier delle submission mancante');
  const end = SRC.indexOf('\n}\n', start);
  assert.ok(end > start, 'classifier delle submission non chiuso');
  return new Function(`${SRC.slice(start, end + 2)}\nreturn classifyJournalistPublishError;`)();
}

test('a retryable cover-verifier failure stays queued; deterministic visual rejection remains failed', () => {
  const classify = loadDispositionClassifier();

  assert.equal(classify({ code: 'ARTICLE_COVER_VERIFICATION_UNAVAILABLE', retryable: true }), 'deferred');
  assert.equal(classify({ code: 'ARTICLE_COVER_VERIFICATION_STALE', retryable: true }), 'deferred');
  assert.equal(classify({
    code: 'ARTICLE_COVER_NO_RELEVANT_FALLBACK',
    retryable: true,
    imageQualityFailure: true,
  }), 'failed', 'un verdetto vision negativo richiede una nuova copertina del giornalista');
  assert.equal(classify(new Error('translation failed')), 'failed');
});

test('deferred submissions remain in the queued snapshot and are processed only once per drain', () => {
  const deferredAt = SRC.indexOf("if (disposition === 'deferred') {");
  const failedAt = SRC.indexOf("await docSnap.ref.update({ status: 'failed', errorMessage: message.slice(0, 2000) });");
  assert.ok(deferredAt > 0 && failedAt > deferredAt, 'la deferral deve precedere lo stamp terminale');
  const retryBranch = SRC.slice(deferredAt, failedAt);
  assert.match(retryBranch, /return \{ ok: false, deferred: true \};/);
  assert.doesNotMatch(retryBranch, /status:\s*'failed'/, 'una deferral non deve terminalizzare la submission');

  const mainStart = SRC.indexOf('async function main() {');
  const loopStart = SRC.indexOf('for (const docSnap of snap.docs) {', mainStart);
  const processCall = SRC.indexOf('await processDoc(db, FieldValue, docSnap);', loopStart);
  assert.ok(mainStart >= 0 && loopStart > mainStart && processCall > loopStart, 'drain per snapshot mancante');
  const loop = SRC.slice(loopStart, SRC.indexOf('\n    }\n  } catch (err)', loopStart));
  assert.equal((loop.match(/await processDoc\(db, FieldValue, docSnap\)/g) || []).length, 1,
    'ogni documento dello snapshot riceve al massimo un tentativo per run');
  assert.match(loop, /else if \(result\.deferred\) \{\s*deferred \+= 1;/);
  assert.match(SRC, /failed=\$\{failed\} deferred=\$\{deferred\}/);
});
