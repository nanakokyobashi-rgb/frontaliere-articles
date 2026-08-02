/**
 * The vendored Google News whitelist (issue #4974 item 3, §5.3). `node --test`.
 *
 * The point of these is drift: this file is a COPY of main's editorial list, and
 * the failure mode it replaced was silent (an empty list reads as allow-all).
 * So the assertions pin the count and the semantics rather than eyeballing the
 * array, and the eligibility cases are the ones whose answer would flip if the
 * list quietly emptied.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NEWS_SITEMAP_WHITELIST,
  NEWS_SITEMAP_WINDOW_HOURS,
  isArticleNewsEligible,
} from '../data/news-sitemap-whitelist.mjs';

const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000);

test('carries the full token list, not an empty allow-all', () => {
  assert.equal(NEWS_SITEMAP_WHITELIST.length, 98);
  assert.ok(Object.isFrozen(NEWS_SITEMAP_WHITELIST));
});

test('window is the 48h Google News spec value', () => {
  assert.equal(NEWS_SITEMAP_WINDOW_HOURS, 48);
});

test('keeps one token from each of the six macro-themes', () => {
  for (const t of ['fisco', 'avs', 'lamal', 'dogana', 'cambio-valuta', 'treno']) {
    assert.ok(
      NEWS_SITEMAP_WHITELIST.includes(t),
      `theme token '${t}' missing — the list drifted from main`,
    );
  }
});

test('does NOT contain bare frontaliere/frontalieri', () => {
  // Main's own comment: these appear in virtually every Ticino-news slug and
  // would defeat the filter. Re-adding one is the most likely way to silently
  // turn the whitelist back into allow-all.
  assert.ok(!NEWS_SITEMAP_WHITELIST.includes('frontaliere'));
  assert.ok(!NEWS_SITEMAP_WHITELIST.includes('frontalieri'));
});

test('admits an on-topic, fresh article', () => {
  assert.equal(
    isArticleNewsEligible({ slug: 'nuovo-accordo-fisco-2026', publishedAt: hoursAgo(2) }),
    true,
  );
});

test('rejects an off-topic article however fresh', () => {
  assert.equal(
    isArticleNewsEligible({ slug: 'hockey-club-lugano-vittoria', publishedAt: hoursAgo(1) }),
    false,
  );
});

test('rejects an on-topic article that aged out of the window', () => {
  assert.equal(isArticleNewsEligible({ slug: 'fisco', publishedAt: hoursAgo(72) }), false);
});

test('rejects a future-dated article as malformed', () => {
  assert.equal(isArticleNewsEligible({ slug: 'fisco', publishedAt: hoursAgo(-6) }), false);
});

test('rejects an unparseable date rather than letting it through', () => {
  assert.equal(isArticleNewsEligible({ slug: 'fisco', publishedAt: 'not-a-date' }), false);
});

test('matches case-insensitively across every text field', () => {
  const at = hoursAgo(1);
  assert.equal(isArticleNewsEligible({ title: 'Novità sull’AVS', publishedAt: at }), true);
  assert.equal(isArticleNewsEligible({ keywords: 'CASSA MALATI', publishedAt: at }), true);
  assert.equal(isArticleNewsEligible({ tags: ['Pensione'], publishedAt: at }), true);
  assert.equal(isArticleNewsEligible({ articleSection: 'Dogana', publishedAt: at }), true);
});

test('an article with no publishedAt is judged on topic alone', () => {
  assert.equal(isArticleNewsEligible({ slug: 'fisco' }), true);
  assert.equal(isArticleNewsEligible({ slug: 'hockey' }), false);
});
