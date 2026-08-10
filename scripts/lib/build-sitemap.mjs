/**
 * Pure sitemap-XML builder shared by both article sections (frontaliere,
 * svizzera). Extracted out of scripts/build-api.mjs (issue #138 item 1) so it
 * can be imported by `node --test` without pulling in the rest of that script
 * — which loads the corpus's `.ts` content files via extensionless relative
 * specifiers and therefore requires `tsx`. The `tests (node --test)` gate
 * (.github/workflows/tests.yml) is deliberately dependency-free — no `npm ci`,
 * no network, no browser — because it is the check-run every PR's auto-merge
 * waits on regardless of which path it touches; shelling out to
 * `npx -y tsx@4` from inside it would trade that guarantee for exactly the
 * registry-fetch flakiness `scripts/ci/retry-cmd.sh` exists to paper over
 * elsewhere (publish-api.yml). Keeping this module free of `.ts` imports is
 * what lets a real behavioural test of the sitemap output run in that gate.
 *
 * No behaviour change from the code this replaces — same shape, same
 * arguments, same output byte-for-byte.
 */

export const SITE = 'https://frontaliereticino.ch';

export const xmlEsc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// Per-locale section prefix. hreflang alternates are NOT optional decoration: the
// site's committed sitemaps carry five links per url (it/en/de/fr/x-default) and
// publishing without them would silently drop every alternate from the index.
export const SECTION_PATHS = {
  frontaliere: {
    it: '/articoli-frontaliere/',
    en: '/en/cross-border-articles/',
    de: '/de/grenzgaenger-artikel/',
    fr: '/fr/articles-frontalier/',
  },
  svizzera: {
    it: '/articoli-svizzera/',
    en: '/en/swiss-articles/',
    de: '/de/schweiz-artikel/',
    fr: '/fr/articles-suisse/',
  },
};

/**
 * @param entries article registry entries ({ id, image?, updatedAt?, date? }[])
 * @param section 'frontaliere' | 'svizzera'
 * @param slugMap id -> { it, en, de, fr } page slug
 * @param meta per-locale meta object, keyed `blog.article.<id>.<field>`
 * @param shadowed set of IT slugs to de-list from the sitemap without
 *   removing or noindexing the page itself (canonical-override winners, plus
 *   — for the frontaliere caller — retired daily editions). A `<loc>` whose
 *   own page canonicalises elsewhere is a hard CI gate failure downstream
 *   ("Sitemap <loc> URLs MUST self-canonicalize"), so this is the one place
 *   that failure is preventable before it is published.
 */
export function buildSitemap(entries, section, slugMap, meta, shadowed = new Set()) {
  const paths = SECTION_PATHS[section];
  const sectionPath = paths.it;
  const urls = [];
  for (const a of entries) {
    const slug = slugMap?.[a.id]?.it;
    if (!slug) continue;
    // A canonical-overridden ("shadowed") article points its canonical at a
    // different winner URL, so listing it here — as <loc> OR as an hreflang
    // alternate — contradicts the self-canonical gate the consumer enforces
    // (tests/blog-slugs-sitemap-sync.test.ts, guarding against #3120).
    if (shadowed.has(slug)) continue;
    const title = meta[`blog.article.${a.id}.title`];
    const alt = meta[`blog.article.${a.id}.imageAlt`];
    const lastmod = a.updatedAt || a.date || '';
    const img = a.image ? (a.image.startsWith('http') ? a.image : SITE + a.image) : null;
    const parts = [`  <url>`, `    <loc>${SITE}${sectionPath}${xmlEsc(slug)}/</loc>`];
    if (img) {
      parts.push(`    <image:image>`);
      parts.push(`      <image:loc>${xmlEsc(img)}</image:loc>`);
      if (title) parts.push(`      <image:title>${xmlEsc(title)}</image:title>`);
      if (alt) parts.push(`      <image:caption>${xmlEsc(alt)}</image:caption>`);
      parts.push(`    </image:image>`);
    }
    for (const loc of ['it', 'en', 'de', 'fr']) {
      const s2 = slugMap?.[a.id]?.[loc];
      if (s2) {
        parts.push(
          `    <xhtml:link rel="alternate" hreflang="${loc}" href="${SITE}${paths[loc]}${xmlEsc(s2)}/" />`,
        );
      }
    }
    parts.push(
      `    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE}${sectionPath}${xmlEsc(slug)}/" />`,
    );
    if (lastmod) parts.push(`    <lastmod>${lastmod}</lastmod>`);
    parts.push(`    <changefreq>monthly</changefreq>`);
    parts.push(`    <priority>0.7</priority>`);
    parts.push(`  </url>`);
    urls.push(parts.join('\n'));
  }
  return {
    xml:
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n` +
      `        xmlns:xhtml="http://www.w3.org/1999/xhtml"\n` +
      `        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n` +
      urls.join('\n') +
      `\n</urlset>\n`,
    count: urls.length,
  };
}
