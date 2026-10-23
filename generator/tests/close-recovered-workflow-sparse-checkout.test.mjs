import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = '.github/workflows/close-recovered-failure-issues.yml';

function checkoutSparsePatterns(source) {
  const checkout = source.match(
    /      - name: Checkout\n        uses: actions\/checkout@v7\n        with:\n([\s\S]*?)(?=\n      - name: Setup Node\.js)/u,
  );
  assert.ok(checkout, `${WORKFLOW}: checkout del reconciler non trovato`);
  const sparse = checkout[1].match(
    /^          sparse-checkout: \|\n(?<patterns>(?:            .*\n)+?)          sparse-checkout-cone-mode: false$/mu,
  );
  assert.ok(sparse, `${WORKFLOW}: sparse-checkout del reconciler non trovato`);
  return sparse.groups.patterns
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

test('il reconciler delle failure usa il profilo sparse del corpus senza escludere il codice', () => {
  const source = fs.readFileSync(path.join(ROOT, WORKFLOW), 'utf8');
  const patterns = checkoutSparsePatterns(source);

  assert.ok(patterns.includes('/*'), 'il profilo deve partire dall\'albero completo');
  for (const excluded of [
    '!/public/images/',
    '!/data/jobs/',
    '!/data/seo-404-compat/',
    '!/data/translation-cache/',
    '!/packages/articles/content/',
    '!/public/data/',
    '!/data/evidence-index.json',
    '!/data/jobs-crawler-summaries/',
  ]) {
    assert.ok(patterns.includes(excluded), `profilo sparse senza ${excluded}`);
  }

  assert.ok(!patterns.some((pattern) => pattern.startsWith('!/scripts/')),
    'il profilo non deve escludere la chiusura transitiva del reconciler');
  assert.ok(!patterns.includes('!/docs/'), 'docs non deve essere riescluso dopo il delta #11533');
});

