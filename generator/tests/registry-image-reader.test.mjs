import test from 'node:test';
import assert from 'node:assert/strict';
import { readArticleRegistry } from '../../scripts/lib/registry-image-reader.mjs';

test('registry reader skips comments, strings and nested properties, keeping the direct image', () => {
  const source = `export const articles = [{
    id: 'article-one',
    details: { image: '/nested.webp', text: "a closing } and image: '/string.webp'" },
    /* comment between the comma and the direct property */
    image: '/direct.webp',
    date: '2026-10-10',
  }] as const;`;

  const [entry] = readArticleRegistry(source, 'fixture.ts');
  assert.equal(entry.id, 'article-one');
  assert.equal(entry.image, '/direct.webp');
  assert.equal(entry.fields.date, '2026-10-10');
  assert.match(entry.block, /details: \{ image: '\/nested\.webp'/);
});

test('registry reader fails closed on accessors, dynamic images and duplicate image keys', () => {
  assert.throws(
    () => readArticleRegistry("[{ id: 'accessor', get image() { return '/live.webp'; } }]"),
    /image non è una stringa letterale statica/,
  );
  assert.throws(
    () => readArticleRegistry("[{ id: 'dynamic', image: imageForArticle() }]"),
    /image non è una stringa letterale statica/,
  );
  assert.throws(
    () => readArticleRegistry("[{ id: 'duplicate', image: '/one.webp', 'image': '/two.webp' }]"),
    /proprietà image ripetuta/,
  );
});

test('registry reader rejects spreads that can override an image', () => {
  assert.throws(
    () => readArticleRegistry("[{ id: 'spread', ...coverFields, image: '/literal.webp' }]"),
    /spread o chiave calcolata/,
  );
});
