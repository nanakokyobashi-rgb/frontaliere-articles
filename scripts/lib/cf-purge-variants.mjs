/**
 * cf-purge-variants — "purge THIS url, in every cache variant the edge really
 * keeps for it".
 *
 * ── THE PROBLEM ───────────────────────────────────────────────────────────
 * `cdn.frontaliereticino.ch` answers with `Vary: Origin`. The edge therefore
 * stores TWO entries per URL:
 *
 *   · the one a header-less request creates — curl, CI probes, our own gates;
 *   · the one a cross-origin `fetch()` from the site's SPA creates, which is
 *     the ONLY one a real visitor ever reads.
 *
 * Cloudflare's `files: ['<url>']` purge matches the first. The browser's entry
 * survives for as long as its own `Cache-Control` allows — and this publisher
 * uploads through `upload-cdn-file.sh`, whose default is `max-age=86400`.
 *
 * ── WHY THIS PUBLISHER NEEDS IT ───────────────────────────────────────────
 * Measured on this zone 2026-08-08, right after run 31241440018 published
 * `salario-medio-professioni-svizzera-2026-basilea` and reported success:
 *
 *   /data/blog-index-svizzera-it.json
 *     no Origin (curl, this workflow's own checks) → 2026-08-08T05:20:40Z, 647 articles
 *     Origin sent (a browser inside the page)     → 2026-08-07T16:04:02Z, 637 articles
 *
 * Six of the eight `blog-index-<section>-<locale>.json` files were split the
 * same way, by 12 to 16 hours. The article was live at its own URL, in the
 * sitemaps, in the RSS and in the index this job had just uploaded — and
 * absent from every list on the site, because the list reads the one copy the
 * purge never touched. Every check in the chain was green.
 *
 * The site repo hit this first and fixed it there (its own
 * scripts/lib/cf-purge-variants.mjs, PR valerielinc-ops#5273). This publisher
 * pushes to the SAME bucket behind the SAME zone, so it needs the same
 * treatment: a fix that lives only in the consumer's repo does not cover the
 * files this repo uploads.
 */

/**
 * Origins whose `Vary: Origin` variant must be purged alongside the header-less
 * one. Only the site's own origin sends `Origin` to the CDN host; extra
 * front-end hosts can be added via CF_PURGE_ORIGINS (comma-separated).
 */
export const VARY_ORIGINS = (process.env.CF_PURGE_ORIGINS || 'https://frontaliereticino.ch')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

/**
 * Purge bodies for `urls`, one per cache variant.
 *
 * Separate bodies (⇒ separate POSTs) rather than one doubled `files` list on
 * purpose: the free-plan cap is counted in list entries, and doubling the list
 * would silently halve how many URLs a caller may pass. This way the caller's
 * batch size keeps meaning "URLs".
 *
 * @param {string[]} urls
 * @returns {Array<{ label: string, files: Array<string | { url: string, headers: Record<string,string> }> }>}
 */
export function purgeBodiesForUrls(urls) {
  return [
    { label: 'no Origin (CI/curl variant)', files: urls },
    ...VARY_ORIGINS.map((origin) => ({
      label: `Origin: ${origin} (browser variant)`,
      files: urls.map((url) => ({ url, headers: { Origin: origin } })),
    })),
  ];
}
