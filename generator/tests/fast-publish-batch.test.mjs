import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(resolve(here, '../../.github/workflows/fast-publish-article.yml'), 'utf8');
const publisher = readFileSync(resolve(here, '../../scripts/publish-article-fast.mjs'), 'utf8');

function stepText(name) {
  const matches = [...workflow.matchAll(/^ {6}- name: (.+)$/gm)];
  const index = matches.findIndex((match) => match[1].trim() === name);
  assert.notEqual(index, -1, `step «${name}» non trovato: il test è diventato vacuo`);
  const start = matches[index].index;
  const end = matches[index + 1]?.index ?? workflow.length;
  return workflow.slice(start, end);
}

test('il trigger push conserva tutti gli ID dei body cambiati', () => {
  const resolveStep = stepText('Resolve mode, article ids and section');
  assert.match(resolveStep, /grep -E '\^content\/blog-body\(-ch\)\?\/\[a-z\]\{2\}\/\.\+\\\.ts\$'/);
  assert.match(resolveStep, /sort -u/);
  assert.match(resolveStep, /ids\+=\("\$body_id"\)/);
  assert.match(resolveStep, /echo "ids=\$ids_json"/);
  assert.match(resolveStep, /if \[ "\$\{#ids\[@\]\}" -eq 0 \]; then[\s\S]*git diff --name-only HEAD~1 HEAD/);
  assert.doesNotMatch(resolveStep, /head\s+-1/);
});

test('il dispatch accetta una lista JSON e il workflow la passa al renderer batch', () => {
  assert.match(workflow, /article_ids:\s*\n\s+description: 'JSON array of article ids/);
  assert.match(workflow, /ARTICLE_IDS_INPUT: \$\{\{ inputs\.article_ids \}\}/);
  assert.match(workflow, /--ids "\$ARTICLE_IDS_JSON"/);
  assert.match(publisher, /onlyArticleIds:\s*args\.ids/);
});

test('il publisher rifiuta ID non risolti e riunisce tutte le pagine nel summary', () => {
  assert.match(publisher, /const missingIds = args\.ids\.filter/);
  assert.match(publisher, /for \(const entry of entries\)/);
  assert.match(publisher, /articlePaths = entries\.map/);
  assert.match(publisher, /bridgePaths = entries\.map/);
  assert.match(publisher, /paths: \[\.\.\.articlePaths, \.\.\.bridgePaths, \.\.\.hubPaths\]/);
});
