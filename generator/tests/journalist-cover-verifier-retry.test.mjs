import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, '..', 'scripts', 'publish-journalist-article.mjs'), 'utf8');
const CREATE_ARTICLE_SRC = readFileSync(path.join(HERE, '..', 'scripts', 'create-article.mjs'), 'utf8');

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

test('journalist engine and catalog verifier share the configured image-phase deadline', () => {
  const importStart = SRC.indexOf('import {\n  registerArticleFiles,');
  const importEnd = SRC.indexOf("} from './create-article.mjs';", importStart);
  assert.ok(importStart >= 0 && importEnd > importStart, 'import del publisher da create-article mancante');
  assert.match(SRC.slice(importStart, importEnd), /\bIMAGE_PHASE_BUDGET_MS\b/);
  assert.match(CREATE_ARTICLE_SRC, /export const IMAGE_PHASE_BUDGET_MS = Math\.max\(/);

  const resolverStart = SRC.indexOf('async function resolveHeroImage(data, doc) {');
  const resolverEnd = SRC.indexOf('\n}\n', resolverStart);
  assert.ok(resolverStart >= 0 && resolverEnd > resolverStart, 'resolveHeroImage non trovata o non chiusa');
  const resolver = SRC.slice(resolverStart, resolverEnd + 2);
  const deadlineLine = 'const imageDeadlineAt = Date.now() + IMAGE_PHASE_BUDGET_MS;';
  const deadlineStart = resolver.indexOf(deadlineLine);
  const fallbackStart = resolver.indexOf('const fallback = resolveArticleCoverFallback', deadlineStart);
  assert.ok(deadlineStart >= 0 && fallbackStart > deadlineStart, 'confine della fase immagini non leggibile');
  const imagePhase = resolver.slice(deadlineStart, fallbackStart);

  assert.match(imagePhase, /generateArticleImage\(data, \{ deadlineAt: imageDeadlineAt \}\)/);
  assert.match(imagePhase, /verifyCatalogFallbackCandidates\(data, \{[\s\S]*?deadlineAt: imageDeadlineAt,/);
  assert.equal((imagePhase.match(/Date\.now\(\) \+ IMAGE_PHASE_BUDGET_MS/g) || []).length, 1,
    'la verifica fallback non deve aprire un secondo budget dopo il motore');
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
