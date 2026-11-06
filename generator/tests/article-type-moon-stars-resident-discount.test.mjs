import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readArticleTypeReadings } from '../scripts/backfill-article-type.mjs';
import { readTsStringMap } from '../scripts/lib/ts-string-map.mjs';
import {
  readTopLevelString,
  scanTopLevelArticleRecords,
} from '../../scripts/lib/article-registry-reader.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'moon-stars-resident-discount-locarno-card';

test('Moon&Stars Locarno Card resta news per l’edizione e la vendita 2026', () => {
  const bodySource = fs.readFileSync(
    path.join(ROOT, 'content/blog-body/it', `${SLUG}.ts`),
    'utf8',
  );
  const fields = readTsStringMap(bodySource);
  const body = [1, 2, 3]
    .map((part) => fields.get(`blog.article.${SLUG}.body${part}`))
    .join('\n');
  assert.match(body, /festival Moon&Stars a Locarno dal 9 al 19 luglio 2026/iu);
  assert.match(body, /dal 22 aprile 2026 alle 12:00 al 29 maggio 2026 alle 23:59/iu);
  assert.match(body, /75 CHF per concerti serali, 45 CHF per Opening Night/u);

  const reading = readArticleTypeReadings(ROOT, { todayYmd: '2026-11-06' })
    .find((row) => row.id === SLUG);
  assert.deepEqual(reading, {
    id: SLUG,
    decision: 'news',
    reason: "L'intero articolo è ancorato al festival Moon&Stars del 9-19 luglio 2026 e alla vendita Locarno Card del 22 aprile-29 maggio 2026: prezzi, contingente e istruzioni scadono con quella edizione.",
    readAt: '2026-11-06',
    basis: 'reading',
  });

  const registry = fs.readFileSync(path.join(ROOT, 'content/blog-articles-data.ts'), 'utf8');
  const record = scanTopLevelArticleRecords(registry).find((row) => row.id === SLUG);
  assert.ok(record, 'articolo presente nel registry');
  assert.equal(readTopLevelString(record, 'articleType'), 'news');
});

test('il controllo Moon&Stars è incluso nel gate contenuti principale', () => {
  const gates = fs.readFileSync(path.join(ROOT, 'scripts/ci/content-gates-main.mjs'), 'utf8');
  assert.match(gates, /generator\/tests\/article-type-moon-stars-resident-discount\.test\.mjs/u);
});
