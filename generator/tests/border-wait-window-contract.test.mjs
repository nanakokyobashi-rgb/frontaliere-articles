import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { rankingFromStats, MIN_SAMPLES_FOR_RANKING } from '../scripts/lib/border-wait-ranking.mjs';
import { buildBorderWaitRankingArticle } from '../scripts/lib/border-wait-ranking-content.mjs';
import { isTicinoCrossing } from '../build-plugins/borderWaitData.ts';

// ── issue #101 ──────────────────────────────────────────────────────────────
//
// `border-wait-ranking-window.json` is the consumer half of a cross-repo
// contract: the site's `scripts/publish-border-wait-window.mjs` produces it,
// `refresh-border-wait-window.mjs` fetches and shape-checks it, and
// `generate-border-wait-ranking-article.mjs`'s `computeSnapshot()` turns it
// into the evergreen ranking article. None of that chain ran against a fixture
// before this file — the only coverage was the fetch-side shape check
// (`--check`, live CDN only, no CI trigger on `pull_request`) and that check
// is blind to exactly the failure mode that matters: it counts
// `Object.keys(perCrossing).length` on the RAW payload, before the
// Ticino-only filter `computeSnapshot()` applies. A renamed/unrecognised
// Ticino slug on the producer side passes the raw check and then silently
// empties the ranking, and the evergreen article is replaced by the
// "not enough data yet" stub — see the "Rinomina di slug sul sito" scenario
// in issue #101.
//
// `computeSnapshot()` itself cannot be imported directly here:
// `generate-border-wait-ranking-article.mjs` also statically imports
// `create-article.mjs` (for `refreshBodyFiles`/`main`), whose closure pulls
// npm dependencies (jsdom, sharp, undici…) this repo's test job does not
// install on purpose — the same constraint documented in
// `seo-description-cap.test.mjs`. So this file exercises the same pure
// building blocks `computeSnapshot()` composes (`rankingFromStats` +
// `isTicinoCrossing`, both dependency-free and safe to import) and pins,
// via a literal source match, that `computeSnapshot()` still wires them the
// same way — the "guardia che non ha forma di import" pattern used in
// `generator/tests/seo-clause-truncation.test.mjs`.

const GENERATOR_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RANKING_ARTICLE_SCRIPT = path.join(GENERATOR_ROOT, 'scripts', 'generate-border-wait-ranking-article.mjs');

// Two real Ticino–Como crossings (see generator/build-plugins/borderWaitData.ts).
const TICINO_SLUG_A = 'chiasso-centro';
const TICINO_SLUG_B = 'ponte-tresa';

function crossing(weightedAvgMinutes, totalSamples = MIN_SAMPLES_FOR_RANKING) {
  return { weightedAvgMinutes, totalSamples };
}

/** Mirrors computeSnapshot()'s own Ticino-only ranking derivation exactly. */
function ticinoRanking(perCrossing) {
  return rankingFromStats(perCrossing)
    .filter((r) => isTicinoCrossing(r.slug))
    .map((r, idx) => ({ ...r, rank: idx + 1 }));
}

test('computeSnapshot still filters the raw ranking through isTicinoCrossing (source pin)', () => {
  const src = fs.readFileSync(RANKING_ARTICLE_SCRIPT, 'utf-8');
  assert.match(
    src,
    /rankingFromStats\(windowPayload\.current\.perCrossing\)/,
    'computeSnapshot must still derive the raw ranking from rankingFromStats over the fetched window',
  );
  assert.match(
    src,
    /\.filter\(\(r\) => isTicinoCrossing\(r\.slug\)\)/,
    'computeSnapshot must still drop non-Ticino/unrecognised slugs before the article is built — ' +
      'without this filter a renamed Ticino slug silently reaches the article as an empty ranking (issue #101)',
  );
});

test('healthy window: >=2 known Ticino crossings produce a real ranking, not the stub', () => {
  const ranking = ticinoRanking({
    [TICINO_SLUG_A]: crossing(8),
    [TICINO_SLUG_B]: crossing(14),
  });
  assert.equal(ranking.length, 2);

  const article = buildBorderWaitRankingArticle({ ranking, trend: {}, funFacts: null, todayIso: '2026-08-09' });
  assert.equal(article._rankedCount, 2);
  assert.match(article.content.it.body1, /Le dogane del Ticino/);
  assert.doesNotMatch(article.content.it.body1, /Non ci sono ancora abbastanza dati/);
});

test('renamed/unrecognised Ticino slugs pass the raw shape gate but collapse the ranking to the "no data" stub', () => {
  // Mirrors the "Rinomina di slug sul sito" failure mode from issue #101: the
  // producer renames a Ticino crossing slug to something this repo's registry
  // (build-plugins/borderWaitData.ts) does not recognise. The raw payload is
  // still well-formed (non-empty perCrossing, finite numbers, enough samples),
  // so a shape-only check (what `refresh-border-wait-window.mjs --check`
  // actually does) would pass — but the Ticino filter drops every
  // unrecognised slug and the evergreen article silently becomes the
  // "not enough data" stub.
  const rawPerCrossing = {
    'chiasso-centro-rinominato': crossing(8),
    'ponte-tresa-rinominato': crossing(14),
  };
  // What a raw shape check sees: two well-formed crossings.
  assert.equal(rankingFromStats(rawPerCrossing).length, 2);

  // What the article actually gets, after the Ticino filter:
  const ranking = ticinoRanking(rawPerCrossing);
  assert.equal(ranking.length, 0);

  const article = buildBorderWaitRankingArticle({ ranking, trend: {}, funFacts: null, todayIso: '2026-08-09' });
  assert.equal(article._rankedCount, 0);
  assert.match(article.content.it.body1, /Non ci sono ancora abbastanza dati/);
});

test('a crossing below MIN_SAMPLES_FOR_RANKING is excluded from the ranking', () => {
  const ranking = ticinoRanking({
    [TICINO_SLUG_A]: crossing(8, MIN_SAMPLES_FOR_RANKING - 1),
    [TICINO_SLUG_B]: crossing(14, MIN_SAMPLES_FOR_RANKING),
  });
  assert.deepEqual(
    ranking.map((r) => r.slug),
    [TICINO_SLUG_B],
  );
});

test('weightedAvgMinutes flows into the ranking as avgMinutes unchanged (minutes, not seconds or an unweighted mean)', () => {
  const ranking = ticinoRanking({
    [TICINO_SLUG_A]: crossing(8.5),
    [TICINO_SLUG_B]: crossing(14.25),
  });
  const bySlug = Object.fromEntries(ranking.map((r) => [r.slug, r.avgMinutes]));
  assert.equal(bySlug[TICINO_SLUG_A], 8.5);
  assert.equal(bySlug[TICINO_SLUG_B], 14.25);
});
