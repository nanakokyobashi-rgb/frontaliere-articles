/**
 * resolve-registry-conflicts.test.mjs — unit coverage for the merge
 * strategies used to auto-resolve rebase conflicts on the generator's two
 * append-only dedup caches (issue #29: a genuine textual conflict on either
 * file was aborting the whole push and losing an already-generated article).
 *
 * Only the pure merge functions are tested here — no git process, no
 * filesystem. The allowlist gate (RESOLVABLE_PATHS) is what keeps this
 * resolver from ever being asked to merge a file it wasn't verified against.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RESOLVABLE_PATHS,
  mergeImageUsedMap,
  mergeImageCatalog,
} from '../../scripts/lib/resolve-registry-conflicts.mjs';

test('mergeImageUsedMap unions two independent article additions', () => {
  const theirs = { 'article-a': 'https://example.com/a.jpg' };
  const ours = { 'article-b': 'https://example.com/b.jpg' };
  assert.deepEqual(mergeImageUsedMap(ours, theirs), {
    'article-a': 'https://example.com/a.jpg',
    'article-b': 'https://example.com/b.jpg',
  });
});

test('mergeImageUsedMap prefers our value when both sides wrote the same key', () => {
  const theirs = { 'article-a': 'https://example.com/stale.jpg' };
  const ours = { 'article-a': 'https://example.com/fresh.jpg' };
  assert.deepEqual(mergeImageUsedMap(ours, theirs), { 'article-a': 'https://example.com/fresh.jpg' });
});

test('mergeImageCatalog unions two independent catalog appends, preserving both entries', () => {
  const theirs = [{ path: '/images/blog/a.webp', words: ['a'] }];
  const ours = [{ path: '/images/blog/b.webp', words: ['b'] }];
  const merged = mergeImageCatalog(ours, theirs);
  assert.deepEqual(
    merged.map((e) => e.path).sort(),
    ['/images/blog/a.webp', '/images/blog/b.webp'],
  );
});

test('mergeImageCatalog de-duplicates by path instead of double-adding the same entry', () => {
  const theirs = [{ path: '/images/blog/a.webp', words: ['a'] }];
  const ours = [{ path: '/images/blog/a.webp', words: ['a'] }, { path: '/images/blog/b.webp', words: ['b'] }];
  const merged = mergeImageCatalog(ours, theirs);
  assert.equal(merged.length, 2);
});

test('the allowlist is exactly the two known append-only dedup caches', () => {
  assert.deepEqual(
    [...RESOLVABLE_PATHS].sort(),
    ['data/blog-images-used.json', 'public/data/journalist-image-catalog.json'],
  );
});
