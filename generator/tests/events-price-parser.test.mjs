import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(ROOT, 'generator/scripts/lib/events-utils.mjs'), 'utf8');
const start = source.indexOf('const PRICE_FREE_RE =');
const end = source.indexOf('/**\n * Whether a parsed', start);
assert.ok(start >= 0 && end > start, 'price parser block not found');
const parsePriceText = new Function(
  `${source.slice(start, end).replace('export function parsePriceText', 'function parsePriceText')}\nreturn parsePriceText;`,
)();

test('preserves a bare numeric price already supplied by the price field', () => {
  assert.deepEqual(parsePriceText('20'), { amount: 20, currency: 'CHF', isFree: false });
  assert.deepEqual(parsePriceText('20.50'), { amount: 20.5, currency: 'CHF', isFree: false });
});

test('keeps free and contextual prices on their existing paths', () => {
  assert.deepEqual(parsePriceText('0'), { amount: 0, currency: 'CHF', isFree: true });
  assert.deepEqual(parsePriceText('CHF 10 pro Person'), { amount: 10, currency: 'CHF', isFree: false });
  assert.deepEqual(parsePriceText('CHF10'), { amount: 10, currency: 'CHF', isFree: false });
  assert.deepEqual(parsePriceText('10CHF'), { amount: 10, currency: 'CHF', isFree: false });
  assert.deepEqual(parsePriceText('CHF 20 (EUR 22)'), { amount: 20, currency: 'CHF', isFree: false });
  assert.deepEqual(parsePriceText('Bambini gratuiti, adulti CHF 20'), { amount: 20, currency: 'CHF', isFree: false });
  assert.deepEqual(parsePriceText('entrata gratuita'), { amount: 0, currency: 'CHF', isFree: true });
  assert.deepEqual(parsePriceText('gratuite'), { amount: 0, currency: 'CHF', isFree: true });
});

test('keeps the paid adult tariff when children are free, including punctuation and inflection', () => {
  assert.deepEqual(parsePriceText('Bambini: gratis, adulti CHF 20'), { amount: 20, currency: 'CHF', isFree: false });
  assert.deepEqual(parsePriceText('Bambini gratuiti, adulti CHF 20'), { amount: 20, currency: 'CHF', isFree: false });
});

test('keeps grouped amounts and associates the selected amount with its currency', () => {
  assert.deepEqual(parsePriceText("CHF 1'000"), { amount: 1000, currency: 'CHF', isFree: false });
  assert.deepEqual(parsePriceText('CHF 20 (EUR 22)'), { amount: 20, currency: 'CHF', isFree: false });
});

test('accepts an explicit currency marker adjacent to the amount', () => {
  assert.deepEqual(parsePriceText('CHF10'), { amount: 10, currency: 'CHF', isFree: false });
  assert.deepEqual(parsePriceText('10CHF'), { amount: 10, currency: 'CHF', isFree: false });
});

test('does not treat ambiguous dates or phone numbers as bare prices', () => {
  assert.equal(parsePriceText('31.12.2026').amount, null);
  assert.equal(parsePriceText('+41 79 123 45 67').amount, null);
});
