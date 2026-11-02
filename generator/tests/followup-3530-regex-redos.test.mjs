import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseCrossingNames } from '../scripts/lib/canton-hubs/blocks-border-wait.mjs';

const longBackslashRun = '\\'.repeat(40);

function assertMalformedLiteralFinishes(moduleUrl, importName, expression, source) {
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    `import { ${importName} } from ${JSON.stringify(moduleUrl)};
const result = ${expression.replace('SOURCE', JSON.stringify(source))};
if (result !== '') throw new Error('il literal senza terminatore non deve produrre un valore');`,
  ], { encoding: 'utf8', timeout: 5_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
}

test('#3530 extractBodyContent non esplode su un body non terminato con molti backslash', () => {
  const moduleUrl = new URL('../scripts/batch-add-faq-to-articles.mjs', import.meta.url).href;
  const source = `'blog.article.demo.body1': '${longBackslashRun}`;
  assertMalformedLiteralFinishes(moduleUrl, 'extractBodyContent', "extractBodyContent(SOURCE, 'demo')", source);
});

test('#3530 parseCrossingNames non esplode su un nome non terminato con molti backslash', () => {
  const moduleUrl = new URL('../scripts/lib/canton-hubs/blocks-border-wait.mjs', import.meta.url).href;
  const source = `{ name: '${longBackslashRun}`;
  assertMalformedLiteralFinishes(moduleUrl, 'parseCrossingNames', 'parseCrossingNames(SOURCE).size === 0 ? \'\' : \'unexpected\'', source);
});

test('#3530 parseCrossingNames conserva il confine dei terminatori di riga', () => {
  assert.equal(parseCrossingNames("{ name: 'prima\nseconda', country: 'IT' }").size, 0);
});

test('#3530 structuredHeadlineLocator non esplode su un headline JSON non terminato', () => {
  const moduleUrl = new URL('../../scripts/seo/bing-seo-loop.mjs', import.meta.url).href;
  const policyUrl = new URL('../../scripts/seo/bing-seo-policy.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    `import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyFixes } from ${JSON.stringify(moduleUrl)};
import { BING_TITLE_FIXES } from ${JSON.stringify(policyUrl)};
const repoRoot = new URL('../../', ${JSON.stringify(moduleUrl)}).pathname;
const first = BING_TITLE_FIXES[0];
const firstPath = resolve(repoRoot, first.source);
const original = readFileSync(firstPath, 'utf8');
const needle = '"headline": ' + JSON.stringify(first.title);
const malformed = '"headline": "' + '\\\\'.repeat(40);
const mutated = original.replace(needle, malformed);
if (mutated === original) throw new Error('fixture headline non trovato');
const readFile = (absolutePath) => absolutePath === firstPath ? mutated : readFileSync(absolutePath, 'utf8');
try {
  applyFixes({ repoRoot, readFile, writeFile: () => {} });
  throw new Error('headline malformato accettato');
} catch (error) {
  if (!/Structured headline non trovato/u.test(String(error?.message))) throw error;
}`,
  ], { encoding: 'utf8', timeout: 5_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('#3530 singleQuotedPropertyLocator non esplode su un valore TS non terminato', () => {
  const moduleUrl = new URL('../../scripts/seo/bing-seo-loop.mjs', import.meta.url).href;
  const policyUrl = new URL('../../scripts/seo/bing-seo-policy.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    `import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyFixes } from ${JSON.stringify(moduleUrl)};
import { BING_TITLE_FIXES } from ${JSON.stringify(policyUrl)};
const repoRoot = new URL('../../', ${JSON.stringify(moduleUrl)}).pathname;
const first = BING_TITLE_FIXES[0];
const firstPath = resolve(repoRoot, first.source);
const original = readFileSync(firstPath, 'utf8');
const needle = "title: '" + first.title + "'";
const malformed = "title: '" + '\\\\'.repeat(40);
const mutated = original.replace(needle, malformed);
if (mutated === original) throw new Error('fixture title non trovato');
const readFile = (absolutePath) => absolutePath === firstPath ? mutated : readFileSync(absolutePath, 'utf8');
let threw = false;
try {
  applyFixes({ repoRoot, readFile, writeFile: () => {} });
} catch {
  threw = true;
}
if (!threw) throw new Error('title malformato accettato');`,
  ], { encoding: 'utf8', timeout: 5_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
