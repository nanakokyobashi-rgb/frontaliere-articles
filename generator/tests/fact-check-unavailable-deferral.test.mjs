import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, '..', 'scripts', 'create-article.mjs'), 'utf8');

test('a fail-closed fact-check outage defers the run instead of retrying the article', () => {
  const helperStart = SRC.indexOf('function createFactCheckUnavailableError(');
  const qualityStart = SRC.indexOf('function isQualityRejectError(');
  assert.ok(helperStart !== -1 && qualityStart > helperStart, 'helper di deferral del fact-check mancante');
  const helper = SRC.slice(helperStart, qualityStart);
  assert.match(helper, /error\.factCheckUnavailable = true;/);
  assert.match(helper, /error\.unverified = true;/);

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
  const unavailable = SRC.indexOf('if (isFactCheckUnavailableError(e))', catchStart);
  const cover = SRC.indexOf('// The article-hero verifier', unavailable);
  const quality = SRC.indexOf('if (isQualityRejectError(e))', catchStart);
  assert.ok(catchStart !== -1 && unavailable > catchStart && cover > unavailable && quality > cover, 'ordine dei rami top-level non verificabile');
  const runDeferral = SRC.slice(unavailable, cover);
  assert.match(runDeferral, /finalizeRunReport\('deferred'/);
  assert.match(runDeferral, /EXIT_AI_PROVIDER_ROSTER_UNAVAILABLE/);
  assert.doesNotMatch(runDeferral, /EXIT_NO_ARTICLE_DECLARED/);
  assert.match(runDeferral, /articolo non pubblicato/);
});
