/**
 * follow-up 565: faq parked outside content[primaryLocale] must still
 * survive the split-meta merge. normalizeItalianContentFromPayload only
 * copies strings, so the shipped recoverMisplacedFaq walks the same three
 * candidate locations for a non-empty FAQ object/array.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  recoverMisplacedFaq,
  isPresentFaq,
  normalizeItalianContentFromPayload,
  META_ONLY_FIELDS,
} from '../scripts/lib/body2-payload-verdict.mjs';

const FAQ = [
  { question: 'Quanto costa il permesso G?', answer: 'Dipende dal cantone di lavoro.' },
];

test('recoverMisplacedFaq reads faq at content[locale]', () => {
  const got = recoverMisplacedFaq({ content: { it: { title: 'T', excerpt: 'E', faq: FAQ } } }, 'it');
  assert.deepEqual(got, FAQ);
});

test('recoverMisplacedFaq reads faq parked on content without locale', () => {
  const got = recoverMisplacedFaq({
    content: { title: 'T', excerpt: 'E', faq: FAQ, it: { title: 'T', excerpt: 'E' } },
  }, 'it');
  assert.deepEqual(got, FAQ);
});

test('recoverMisplacedFaq reads faq parked at the payload root', () => {
  const got = recoverMisplacedFaq({
    title: 'T',
    excerpt: 'E',
    faq: FAQ,
    content: { it: { title: 'T', excerpt: 'E' } },
  }, 'it');
  assert.deepEqual(got, FAQ);
});

test('recoverMisplacedFaq returns undefined when faq is absent', () => {
  assert.equal(recoverMisplacedFaq({ content: { it: { title: 'T', excerpt: 'E' } } }, 'it'), undefined);
});

test('isPresentFaq rejects empty / literal-null stand-ins', () => {
  assert.equal(isPresentFaq(null), false);
  assert.equal(isPresentFaq(''), false);
  assert.equal(isPresentFaq('null'), false);
  assert.equal(isPresentFaq([]), false);
  assert.equal(isPresentFaq({}), false);
  assert.equal(isPresentFaq(FAQ), true);
});

test('normalizeItalianContentFromPayload does NOT recover a faq object (that is why recoverMisplacedFaq exists)', () => {
  const block = normalizeItalianContentFromPayload(
    { faq: FAQ, content: { it: { title: 'Titolo vero', excerpt: 'Excerpt vero' } } },
    'it',
    META_ONLY_FIELDS,
  );
  assert.equal(block.title, 'Titolo vero');
  assert.equal('faq' in block, false);
});

test('the split-meta merge in create-article.mjs calls recoverMisplacedFaq', () => {
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../scripts/create-article.mjs'),
  );
  // The file may contain NUL bytes; search the raw buffer.
  const text = src.toString('latin1');
  assert.match(text, /recoverMisplacedFaq\(metaData, primaryLocale\)/);
  assert.match(text, /recoveredFaq !== undefined \? \{ faq: recoveredFaq \}/);
});
