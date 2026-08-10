/**
 * News-ticker canonical-override detection (issue #166, follow-up to #152).
 * `node --test`.
 *
 * PR #152 deliberately left `news-ticker-live.json` unfiltered — filtering
 * only this producer would diverge from the site's own fast-publish producer,
 * which writes the same payload from the same unfiltered registry (see
 * `generator/tests/frontaliere-sitemap-shadow.test.mjs`, which pins that
 * contract). Its own round-3 adversarial review flagged a residual risk as
 * "latent but not nullo": a canonical-override decided the SAME day as
 * publication could shadow an article still inside the ticker's ~2h,
 * five-newest window, and nothing would notice.
 *
 * `findShadowedTickerArticles` (scripts/lib/ticker-shadow-check.mjs) does not
 * change what gets published — it only detects, so `scripts/build-api.mjs`
 * can log it and record it in `manifest.json`'s `counts.tickerArticlesShadowed`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findShadowedTickerArticles } from '../../scripts/lib/ticker-shadow-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const tickerArticles = [
  { id: 'shadowed-1', slug: { it: 'lavoro-piastrellista-ticino-frontaliere' } },
  { id: 'winner', slug: { it: 'frontaliere-piastrellista-ticino-stipendio-requisiti' } },
  { id: 'control', slug: { it: 'un-articolo-qualunque' } },
];

test('findShadowedTickerArticles returns only the ticker articles whose IT slug is shadowed', () => {
  const shadowed = new Set(['lavoro-piastrellista-ticino-frontaliere']);
  const result = findShadowedTickerArticles(tickerArticles, shadowed);
  assert.deepEqual(
    result.map((a) => a.id),
    ['shadowed-1'],
  );
});

test('findShadowedTickerArticles returns an empty array when nothing in the ticker is shadowed', () => {
  const result = findShadowedTickerArticles(tickerArticles, new Set(['some-other-slug']));
  assert.deepEqual(result, []);
});

test('findShadowedTickerArticles does not mutate its input', () => {
  const before = JSON.stringify(tickerArticles);
  findShadowedTickerArticles(tickerArticles, new Set(['lavoro-piastrellista-ticino-frontaliere']));
  assert.equal(JSON.stringify(tickerArticles), before);
});

// Regression guard for the actual wiring: build-api.mjs must detect but must
// NOT filter — writing a filtered array here would be exactly the caller-side
// drift `generator/tests/frontaliere-sitemap-shadow.test.mjs` already pins
// against, just introduced through a different call site.
test('build-api.mjs detects shadowed ticker articles but writes the FULL, unfiltered tickerArticles array', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'build-api.mjs'), 'utf-8');

  assert.ok(
    src.includes('findShadowedTickerArticles(tickerArticles, shadowedFrontaliereSlugs)'),
    'build-api.mjs no longer calls findShadowedTickerArticles — the same-day canonical-override risk ' +
      '(#166) is silent again',
  );
  assert.match(
    src,
    /write\('news-ticker-live\.json',\s*\{\s*schema:\s*1,\s*articles:\s*tickerArticles\s*\}\)/,
    'news-ticker-live.json is no longer written from the raw tickerArticles array — if this now writes a ' +
      'filtered variant, it reintroduces the caller-side drift #152 deliberately avoided (see ' +
      'frontaliere-sitemap-shadow.test.mjs, "passes the UNFILTERED registries ... to the ticker")',
  );
  assert.match(
    src,
    /tickerArticlesShadowed:\s*shadowedTickerArticles\.length/,
    'manifest.json no longer records counts.tickerArticlesShadowed — the detection becomes invisible ' +
      'outside the build log',
  );
});
