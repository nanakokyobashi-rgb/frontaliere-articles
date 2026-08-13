/**
 * findLostRaceArticles() (issue #291) — the pure comparison at the heart of
 * check-journalist-publish-race.mjs: given the `journalist_articles` docs
 * Firestore reports as published, and this repo's own local registry, which
 * ones does this repo have no local record of (i.e. the sibling publisher
 * won the race for them).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLostRaceArticles } from '../scripts/check-journalist-publish-race.mjs';

test('a published doc present in the local registry is not reported', () => {
  const lost = findLostRaceArticles(
    [{ id: 'doc1', slugs: { it: 'articolo-esistente' }, publishedAt: '2026-08-01T00:00:00.000Z' }],
    (id) => id === 'articolo-esistente',
  );
  assert.deepEqual(lost, []);
});

test('a published doc absent from the local registry is reported, race lost', () => {
  const lost = findLostRaceArticles(
    [{ id: 'doc2', slugs: { it: 'vinto-dal-sito' }, publishedAt: '2026-08-01T00:00:00.000Z' }],
    () => false,
  );
  assert.deepEqual(lost, [
    { docId: 'doc2', articleId: 'vinto-dal-sito', publishedAt: '2026-08-01T00:00:00.000Z' },
  ]);
});

test('falls back to slugifying the Firestore doc id when slugs.it is missing', () => {
  const lost = findLostRaceArticles(
    [{ id: 'Articolo Senza Slug!', slugs: undefined, publishedAt: null }],
    () => false,
  );
  assert.equal(lost.length, 1);
  assert.equal(lost[0].articleId, 'articolo-senza-slug');
});

test('mixed batch reports only the ones missing locally, preserving order', () => {
  const localIds = new Set(['a', 'c']);
  const lost = findLostRaceArticles(
    [
      { id: 'doc-a', slugs: { it: 'a' }, publishedAt: null },
      { id: 'doc-b', slugs: { it: 'b' }, publishedAt: null },
      { id: 'doc-c', slugs: { it: 'c' }, publishedAt: null },
      { id: 'doc-d', slugs: { it: 'd' }, publishedAt: null },
    ],
    (id) => localIds.has(id),
  );
  assert.deepEqual(
    lost.map((e) => e.articleId),
    ['b', 'd'],
  );
});

test('empty published-docs list reports nothing', () => {
  assert.deepEqual(findLostRaceArticles([], () => false), []);
});
