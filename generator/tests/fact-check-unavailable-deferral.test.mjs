import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, '..', 'scripts', 'create-article.mjs'), 'utf8');

function loadSharedTransientRosterClassifier() {
  const start = SRC.indexOf('function isSharedTransientFactCheckRosterOutage(');
  assert.notEqual(start, -1, 'classifier del roster fact-check mancante');
  const end = SRC.indexOf('\n}\n', start);
  assert.ok(end > start, 'classifier del roster fact-check non chiuso');
  const source = SRC.slice(start, end + 2);
  return new Function(`${source}\nreturn isSharedTransientFactCheckRosterOutage;`)();
}

test('solo l esaurimento transitorio senza risposte non-outage prova un outage condiviso', () => {
  const isSharedTransientRoster = loadSharedTransientRosterClassifier();
  assert.equal(isSharedTransientRoster([
    { code: 'ALL_MODELS_EXHAUSTED', transientExhaustion: true },
    { code: 'ALL_MODELS_EXHAUSTED', transientExhaustion: true },
  ]), true);
  assert.equal(isSharedTransientRoster([
    { code: 'ALL_MODELS_EXHAUSTED', transientExhaustion: true },
  ], { hadNonOutageResult: true }), false,
  'un voto valido accanto a una lane transitoria non prova un outage del pool intero');
  assert.equal(isSharedTransientRoster([{ code: 'ALL_MODELS_EXHAUSTED', transientExhaustion: false }]), false);
  assert.equal(isSharedTransientRoster([{ message: 'HTTP 401: invalid API key' }]), false);
  assert.equal(isSharedTransientRoster([]), false);

  const unverifiedResultStart = SRC.indexOf('unverified: true,', SRC.indexOf('async function llmFactCheck('));
  const unverifiedResultEnd = SRC.indexOf('\n    };', unverifiedResultStart);
  const unverifiedResult = SRC.slice(unverifiedResultStart, unverifiedResultEnd);
  assert.match(
    unverifiedResult,
    /isSharedTransientFactCheckRosterOutage\(fcProviderErrors,\s*\{\s*hadNonOutageResult:\s*fcHadNonOutageResult,?\s*\}\)\s*\?/,
    'solo errori di roster transitori e strutturati senza risposte possono fermare la catena condivisa',
  );
  assert.match(
    SRC,
    /if \(s\.status === 'fulfilled'\) fcHadNonOutageResult = true;/,
    'un voto valido insieme a una lane fallita prova che il pool non e\' interamente indisponibile',
  );
  assert.doesNotMatch(unverifiedResult, /modelResults\.length/);
});

test('a fail-closed fact-check outage defers the run instead of retrying the article', () => {
  const helperStart = SRC.indexOf('function createFactCheckUnavailableError(');
  const qualityStart = SRC.indexOf('function isQualityRejectError(');
  assert.ok(helperStart !== -1 && qualityStart > helperStart, 'helper di deferral del fact-check mancante');
  const helper = SRC.slice(helperStart, qualityStart);
  assert.match(helper, /error\.factCheckUnavailable = true;/);
  assert.match(helper, /error\.unverified = true;/);
  assert.match(helper, /if \(result\?\.sharedProviderUnavailable === true\) error\.sharedProviderUnavailable = true;/);

  const primaryStart = SRC.indexOf('const factResult = await llmFactCheck(');
  const primaryEnd = SRC.indexOf('// `itWords` / `lastWordCount`', primaryStart);
  assert.ok(primaryStart !== -1 && primaryEnd > primaryStart, 'percorso primary del fact-check mancante');
  const primary = SRC.slice(primaryStart, primaryEnd);
  assert.ok(
    primary.indexOf('if (factResult.unverified === true)') < primary.indexOf('if (!factResult.passed)'),
    'unverified deve uscire prima del retry editoriale',
  );
  assert.match(primary, /if \(isFactCheckUnavailableError\(fcErr\)\) throw fcErr;/);

  const expansionStart = SRC.indexOf('const expandFactResult = await llmFactCheck(');
  const expansionEnd = SRC.indexOf('if (!expandFactOk)', expansionStart);
  assert.ok(expansionStart !== -1 && expansionEnd > expansionStart, 'percorso di espansione del fact-check mancante');
  const expansion = SRC.slice(expansionStart, expansionEnd);
  assert.match(expansion, /if \(expandFactResult\.unverified === true\)/);
  assert.match(expansion, /if \(isFactCheckUnavailableError\(expandFcErr\)\) throw expandFcErr;/);

  const finalStart = SRC.indexOf('const finalCantonFactResult = await llmFactCheck(');
  const finalEnd = SRC.indexOf('// Step 3b:', finalStart);
  assert.ok(finalStart !== -1 && finalEnd > finalStart, 'percorso finale cantonale del fact-check mancante');
  assert.match(SRC.slice(finalStart, finalEnd), /if \(finalCantonFactResult\.unverified === true\)/);

  const catchStart = SRC.indexOf('main().then(async () =>');
  const sharedUnavailable = SRC.indexOf('if (isSharedFactCheckUnavailableError(e))', catchStart);
  const unavailable = SRC.indexOf('if (isFactCheckUnavailableError(e))', sharedUnavailable);
  const coverUnavailable = SRC.indexOf('if (isSharedArticleCoverVerifierUnavailableError(e))', unavailable);
  const cover = SRC.indexOf('// The article-hero verifier', coverUnavailable);
  const quality = SRC.indexOf('if (isQualityRejectError(e))', catchStart);
  assert.ok(catchStart !== -1 && sharedUnavailable > catchStart && unavailable > sharedUnavailable
    && coverUnavailable > unavailable && cover > coverUnavailable && quality > cover, 'ordine dei rami top-level non verificabile');
  const sharedRunDeferral = SRC.slice(sharedUnavailable, unavailable);
  assert.match(sharedRunDeferral, /finalizeRunReport\('deferred'/);
  assert.match(sharedRunDeferral, /EXIT_AI_PROVIDER_ROSTER_UNAVAILABLE/);
  const localRunDeferral = SRC.slice(unavailable, coverUnavailable);
  assert.match(localRunDeferral, /EXIT_NO_ARTICLE_DECLARED/);
  assert.doesNotMatch(localRunDeferral, /EXIT_AI_PROVIDER_ROSTER_UNAVAILABLE/);
  assert.match(localRunDeferral, /articolo non pubblicato/);
});
