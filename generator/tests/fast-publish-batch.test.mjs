import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(resolve(here, '../../.github/workflows/fast-publish-article.yml'), 'utf8');
const publisher = readFileSync(resolve(here, '../../scripts/publish-article-fast.mjs'), 'utf8');
// La catena di render condivisa: gli id passano di qui al renderer.
const pipeline = readFileSync(resolve(here, '../../scripts/lib/article-render-pipeline.mjs'), 'utf8');

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
  // Le cartelle dei corpi, la sezione di ogni corpo e lo shard vengono dal
  // core (scripts/ci/fast-publish-section.mjs), non da una regex e un `case`
  // scritti nel workflow; il comportamento dell'helper e' provato in
  // core-driven-consumers.test.mjs.
  // Solo le sezioni servite da uno shard: un corpo cantonale (R2) lo pubblica
  // fast-publish-section.yml, e qui farebbe fallire `shard-of`.
  assert.match(resolveStep, /body_re="\$\(node scripts\/ci\/fast-publish-section\.mjs body-regex shard\)"/);
  assert.match(resolveStep, /grep -E "\$body_re"/);
  assert.match(resolveStep, /body_section="\$\(node scripts\/ci\/fast-publish-section\.mjs section-of "\$body"\)"/);
  assert.match(resolveStep, /shard="\$\(node scripts\/ci\/fast-publish-section\.mjs shard-of "\$section"\)"/);
  assert.match(resolveStep, /echo "shard=\$shard"/);
  assert.doesNotMatch(resolveStep, /body_section=svizzera/);
  assert.match(resolveStep, /sort -u/);
  assert.match(resolveStep, /ids\+=\("\$body_id"\)/);
  assert.match(resolveStep, /echo "ids=\$ids_json"/);
  assert.match(resolveStep, /PUSH_BEFORE: \$\{\{ github\.event\.before \}\}/);
  assert.match(resolveStep, /if \[ "\$\{#ids\[@\]\}" -eq 0 \]; then[\s\S]*git diff --name-only "\$before" HEAD/);
  assert.doesNotMatch(resolveStep, /head\s+-1/);
});

test('il dispatch accetta una lista JSON e il workflow la passa al renderer batch', () => {
  assert.match(workflow, /article_ids:\s*\n\s+description: 'JSON array of article ids/);
  assert.match(workflow, /ARTICLE_IDS_INPUT: \$\{\{ inputs\.article_ids \}\}/);
  assert.match(workflow, /--ids "\$ARTICLE_IDS_JSON"/);
  assert.match(publisher, /renderSectionArticlePipeline\(\{[\s\S]*?ids: args\.ids,/);
  assert.match(pipeline, /onlyArticleIds: ids \}\)/);
});

test('il publisher rifiuta ID non risolti e riunisce tutte le pagine nel summary', () => {
  assert.match(pipeline, /const missingIds = ids\.filter/);
  assert.match(pipeline, /throw new Error\(`article id\(s\) not found in section/);
  assert.match(pipeline, /for \(const entry of entries\)/);
  assert.match(publisher, /articleIds = entries\.filter\(\(entry\) => entry\.paths\[locale\]\)/);
  assert.match(publisher, /bridgeIds = entries\.filter\(\(entry\) => entry\.flatPaths\[locale\]\)/);
  assert.match(publisher, /articlePaths = entries\.map/);
  assert.match(publisher, /bridgePaths = entries\.map/);
  assert.match(publisher, /paths: \[\.\.\.articlePaths, \.\.\.bridgePaths, \.\.\.hubPaths\]/);
  assert.match(publisher, /url: urls\[0\],[\s\S]*urls,/);
});

test('il workflow valida ID e cardinalità dei path per locale e sonda tutto il batch', () => {
  const validation = stepText('Validate what was rendered');
  assert.match(validation, /\.articlePaths \| length/);
  assert.match(validation, /\.bridgePaths \| length/);
  assert.match(validation, /\.hubPaths \| length/);
  assert.match(validation, /\.articleIds\[\]\?/);
  assert.match(validation, /\.bridgeIds\[\]\?/);
  assert.match(validation, /expected_ids/);
  assert.match(validation, /grep -Eq .*Person\|Organization.*autori/);
  assert.doesNotMatch(validation, /has no Person author/);

  const probe = stepText('Verify the article is actually readable');
  assert.match(probe, /\.articlePaths\[\]/);
  assert.match(probe, /\.urls\[\]/);
  assert.match(probe, /origin_locale_gate_started/);
  assert.match(probe, /poll_origin "\$u" 1 8/);
  assert.doesNotMatch(probe, /\.articlePaths\[0\]/);
  assert.doesNotMatch(probe, /\.shards\[\]\.url(?:'|\s|$)/);
});
