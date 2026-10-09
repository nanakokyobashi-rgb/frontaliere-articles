/**
 * Sitemap families that can contain URLs emitted by canton hub links.
 *
 * Keep this predicate separate from the verifier so the list is executable
 * contract code rather than a regex hidden inside a networked CLI. The
 * locale-variant shards are the sitemap-owned `<loc>` backfill for translated
 * pages declared by the site's seeded sitemaps.
 */
const RELEVANT_SITEMAP_RE = /\/sitemap-(?:pages|locale-variants(?:-\d+)?|fuel-[a-z-]+|border-wait|health-premiums|farmacie|plate-auctions-\d+|weather|eventi|jobs-[a-z-]+|blog)\.xml$/;

export function isRelevantCantonHubSitemap(url) {
  return RELEVANT_SITEMAP_RE.test(String(url));
}
