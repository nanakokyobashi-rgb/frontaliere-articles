/**
 * Pure helper: which news-ticker articles are currently canonical-overridden
 * (shadowed) — issue #166, follow-up to #152.
 *
 * `news-ticker-live.json` is DELIBERATELY published unfiltered (see the
 * `computeTickerArticles` call in scripts/build-api.mjs and the pinning test
 * in generator/tests/frontaliere-sitemap-shadow.test.mjs): filtering only
 * this producer would diverge from the site's own fast-publish producer,
 * which writes the same payload from the same unfiltered registry — a real,
 * visible top-5 mismatch introduced by the "fix".
 *
 * This function does not filter anything. It only detects, so the risk #152's
 * review flagged as "latent" (a canonical-override decided the SAME day as
 * publication, while the shadowed article is still inside the 5-newest ticker
 * window) is visible in build logs and manifest.json `counts` instead of
 * silent — no exposure until a human looks, none after either, just sooner.
 *
 * @param {{ id: string, slug?: Record<string, string> }[]} tickerArticles
 * @param {Set<string>} shadowedSlugs shadowed IT slugs (the same set fed into
 *   buildSitemap for the frontaliere section)
 * @returns {{ id: string, slug?: Record<string, string> }[]} the ticker
 *   articles whose IT slug is currently shadowed
 */
export function findShadowedTickerArticles(tickerArticles, shadowedSlugs) {
  return tickerArticles.filter((a) => shadowedSlugs.has(a.slug?.it));
}
