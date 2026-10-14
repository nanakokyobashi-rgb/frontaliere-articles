import '../../host/cantonSectionsBootstrap.mjs';

/**
 * Pure sitemap-XML builder shared by every active article section (frontaliere,
 * svizzera today, from the section core). Extracted out of scripts/build-api.mjs (issue #138 item 1) so it
 * can be imported by `node --test` without pulling in the rest of that script
 * — which loads the corpus's `.ts` content files via extensionless relative
 * specifiers and therefore requires `tsx`. The `tests (node --test)` gate
 * (.github/workflows/tests.yml) is deliberately dependency-free — no `npm ci`,
 * no network, no browser — because it is the check-run every PR's auto-merge
 * waits on regardless of which path it touches; shelling out to
 * `npx -y tsx@4.23.15` from inside it would trade that guarantee for exactly the
 * registry-fetch flakiness `scripts/ci/retry-cmd.sh` exists to paper over
 * elsewhere (publish-api.yml). Keeping this module free of `.ts` imports is
 * what lets a real behavioural test of the sitemap output run in that gate.
 *
 * The builder keeps the existing shape and arguments, with two publish-boundary
 * invariants: a reserved nullish slug is never emitted as a URL or alternate;
 * family sitemaps emit a `<loc>` for every available published locale, not just
 * the Italian canonical.
 */

import { isReservedPublishedSlug } from './published-slug-guard.mjs';
import { ARTICLE_SECTION_CORE_ALL } from '../../engine/shared/articleSectionCore.mjs';
import { activeCorpusCoreMap } from './corpus-sections.mjs';

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
//
// Derived from the section core (`indexSlug`), ACTIVE sections only: this was a
// hand-written copy of the same slugs, and a section switched on in the core
// would have had no path here. IT lives at the apex, the other locales under
// `/<locale>/` — the same rule the site router and `archiveBase` in build-api use.
export const SECTION_PATHS = Object.freeze(Object.fromEntries(
  Object.entries(activeCorpusCoreMap()).map(([section, core]) => [
    section,
    Object.freeze(Object.fromEntries(
      Object.entries(core.indexSlug).map(([locale, slug]) => [
        locale,
        locale === 'it' ? `/${slug}/` : `/${locale}/${slug}/`,
      ]),
    )),
  ]),
));

function sitemapEntryIsEmitted(article, slugMap, shadowed) {
  const slug = slugMap?.[article.id]?.it;
  return Boolean(slug) && !isReservedPublishedSlug(slug) && !shadowed.has(slug);
}

/**
 * Count the IT entries the sitemap builder can actually emit.
 *
 * This is deliberately the same predicate used by `buildSitemap`, rather than
 * `registry.length - shadowed.size`: canonical override files contain one key
 * per locale, while the article sitemap emits one IT `<url>` per article.
 */
export function countSitemapEntries(entries, slugMap, shadowed = new Set()) {
  return (entries ?? []).filter((article) => sitemapEntryIsEmitted(article, slugMap, shadowed)).length;
}

/**
 * Localized article URLs that the publisher can announce for one registry row.
 * The Italian slug is mandatory because the registry is Italian-canonical; a
 * missing translation simply has no published URL (and therefore no alternate)
 * instead of becoming a guessed or potentially 404 path.
 */
export function publishedArticleLocales(article, paths, slugMap, shadowed = new Set()) {
  const italianSlug = slugMap?.[article.id]?.it;
  if (!sitemapEntryIsEmitted(article, slugMap, shadowed) || shadowed.has(italianSlug)) return [];
  return SITEMAP_LOCALES.flatMap((locale) => {
    const slug = slugMap?.[article.id]?.[locale];
    const prefix = paths?.[locale];
    if (typeof prefix !== 'string' || !prefix || typeof slug !== 'string' || !slug.trim() || isReservedPublishedSlug(slug)) {
      return [];
    }
    return [{ locale, prefix, slug }];
  });
}

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
  const urls = buildArticleUrlBlocks(entries, SECTION_PATHS[section], slugMap, meta, shadowed);
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

/**
 * I blocchi `<url>` degli articoli di una sezione. Per le sezioni storiche il
 * blocco resta uno per articolo, con loc IT e alternate; per le sezioni di
 * famiglia `emitLocalizedLocs` aggiunge una loc per ogni slug locale
 * pubblicato. In entrambi i casi ogni blocco ripete lo stesso insieme coerente
 * di alternate.
 *
 * @param {Record<string, string>} paths prefisso della sezione per locale (`/articoli-x/`)
 * @param {{emitLocalizedLocs?: boolean}} [options]
 */
export function buildArticleUrlBlocks(entries, paths, slugMap, meta, shadowed = new Set(), { emitLocalizedLocs = false } = {}) {
  const urls = [];
  for (const a of entries) {
    const localeRows = publishedArticleLocales(a, paths, slugMap, shadowed);
    const locRows = emitLocalizedLocs ? localeRows : localeRows.filter(({ locale }) => locale === 'it');
    if (locRows.length === 0) continue;
    const italian = localeRows.find(({ locale }) => locale === 'it');
    const title = meta[`blog.article.${a.id}.title`];
    const alt = meta[`blog.article.${a.id}.imageAlt`];
    const lastmod = a.updatedAt || a.date || '';
    const img = a.image ? (a.image.startsWith('http') ? a.image : SITE + a.image) : null;
    for (const { locale, prefix, slug } of locRows) {
      const parts = [`  <url>`, `    <loc>${SITE}${prefix}${xmlEsc(slug)}/</loc>`];
      // Keep the image once, on the Italian canonical, so localized locs do
      // not multiply the same image entry while still carrying all article URLs.
      if (locale === 'it' && img) {
        parts.push(`    <image:image>`);
        parts.push(`      <image:loc>${xmlEsc(img)}</image:loc>`);
        if (title) parts.push(`      <image:title>${xmlEsc(title)}</image:title>`);
        if (alt) parts.push(`      <image:caption>${xmlEsc(alt)}</image:caption>`);
        parts.push(`    </image:image>`);
      }
      for (const alternate of localeRows) {
        parts.push(
          `    <xhtml:link rel="alternate" hreflang="${alternate.locale}" href="${SITE}${alternate.prefix}${xmlEsc(alternate.slug)}/" />`,
        );
      }
      parts.push(
        `    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE}${italian.prefix}${xmlEsc(italian.slug)}/" />`,
      );
      if (lastmod) parts.push(`    <lastmod>${lastmod}</lastmod>`);
      parts.push(`    <changefreq>monthly</changefreq>`);
      parts.push(`    <priority>0.7</priority>`);
      parts.push(`  </url>`);
      urls.push(parts.join('\n'));
    }
  }
  return urls;
}

/** Il prefisso per locale di QUALSIASI sezione nota al core (attiva o no). */
export function sectionPathsOf(section) {
  const core = ARTICLE_SECTION_CORE_ALL[section];
  if (!core) throw new Error(`sectionPathsOf: sezione sconosciuta "${section}"`);
  return Object.fromEntries(
    Object.entries(core.indexSlug).map(([locale, slug]) => [locale, locale === 'it' ? `/${slug}/` : `/${locale}/${slug}/`]),
  );
}

/** Lo slug dell'archivio completo per locale (`/<sezione>/tutti/` e la sua catena `page-N`). */
export const ARCHIVE_ALL_SLUG = Object.freeze({ it: 'tutti', en: 'all', de: 'alle', fr: 'tous' });

const SITEMAP_LOCALES = ['it', 'en', 'de', 'fr'];

/**
 * Le pagine di sezione (non articoli) di una sezione di famiglia, ciascuna come
 * `{ key, paths: {it,en,de,fr}, priority, alternates }`: la landing, i suoi hub
 * tematici (`topicHubs` del core, slug riservati D2) e l'archivio `tutti` con
 * le pagine `page-N`. Gli alternate stanno sulle pagine che li portano
 * (landing, hub, pagina 1 dell'archivio), come nella sitemap dell'archivio
 * storico.
 *
 * Gli hub ci sono SEMPRE: decisione del proprietario (2026-10-05), nessuna
 * pagina cantonale e' `noindex`, nemmeno sotto soglia. Una sezione che non ha
 * ancora contenuti sufficienti resta `draft` nel registro, e il Worker non
 * serve ne' le sue pagine ne' questa sitemap.
 *
 * @param {string} section id di una sezione con `topicHubs` (le cantonali)
 * @param {number} archiveTotal articoli che l'archivio pagina
 * @param {number} pageSize articoli per pagina dell'archivio (ARTICLES_PAGE_SIZE dell'host)
 */
export function familySectionPages(section, archiveTotal, pageSize) {
  if (!Number.isInteger(pageSize) || pageSize <= 0) throw new Error(`familySectionPages: pageSize non valido (${pageSize})`);
  const core = ARTICLE_SECTION_CORE_ALL[section];
  if (!core?.topicHubs) throw new Error(`familySectionPages: "${section}" non ha hub tematici nel core`);
  const base = sectionPathsOf(section);
  const at = (suffix) => Object.fromEntries(SITEMAP_LOCALES.map((loc) => [loc, `${base[loc]}${suffix(loc)}`]));
  const pages = [{ key: 'landing', paths: base, priority: '0.8', alternates: true }];
  for (const [topic, slugs] of Object.entries(core.topicHubs)) {
    pages.push({ key: `hub:${topic}`, paths: at((loc) => `${slugs[loc]}/`), priority: '0.7', alternates: true });
  }
  const archivePages = Math.max(1, Math.ceil(archiveTotal / pageSize));
  for (let page = 1; page <= archivePages; page++) {
    pages.push({
      key: page === 1 ? 'archive' : `archive:${page}`,
      paths: at((loc) => (page === 1 ? `${ARCHIVE_ALL_SLUG[loc]}/` : `${ARCHIVE_ALL_SLUG[loc]}/page-${page}/`)),
      priority: page === 1 ? '0.6' : '0.4',
      alternates: page === 1,
    });
  }
  return pages;
}

/**
 * Quanti articoli pagina l'archivio `/tutti/` di una sezione: l'UNIONE degli
 * id che hanno un titolo nel meta IT e degli id della mappa slug. E' la stessa
 * unione di `readArticleArchiveUnionSlugs` (engine/shared/articleArchiveUnion.ts),
 * cioe' quella su cui il renderer dell'archivio decide quante `page-N`
 * emettere: contare qui un insieme diverso (per esempio solo le righe del
 * registro con uno slug IT) lascerebbe fuori dalla sitemap una pagina che il
 * renderer emette. Niente esclusioni: il renderer non conosce i ritiri del
 * registro, quindi le sue pagine sono quelle dell'unione intera.
 */
export function archiveUnionSize(metaIt, slugMap) {
  const ids = new Set(Object.keys(slugMap ?? {}));
  for (const key of Object.keys(metaIt ?? {})) {
    const m = /^blog\.article\.(.+)\.title$/.exec(key);
    if (m) ids.add(m[1]);
  }
  return ids.size;
}

/**
 * La sitemap di UNA sezione di famiglia (`sitemap-articles-<id>.xml`): le sue
 * pagine di sezione (una `<url>` per locale) e poi gli articoli (una loc per
 * ogni locale pubblicato, con gli alternate coerenti). `articleCount` e' il
 * numero di articoli, non il numero di URL localizzati, separato da `count`
 * perche' i pavimenti si misurano sugli articoli: contare anche landing e hub
 * li renderebbe sempre soddisfatti.
 * `retiredPaths` sono i path che il registro della sezione dichiara `gone` o
 * `redirects`: una pagina di sezione con UNA variante locale ritirata esce
 * intera (le sue `<url>` si citano a vicenda come alternate).
 * Le pagine dell'archivio si contano su `archiveUnionSize` (la stessa unione
 * del renderer), non sugli articoli elencati qui.
 */
export function buildFamilySectionSitemap({ section, entries, slugMap, meta, pageSize, shadowed = new Set(), retiredPaths = new Set() }) {
  const paths = sectionPathsOf(section);
  const articleUrls = buildArticleUrlBlocks(entries, paths, slugMap, meta, shadowed, { emitLocalizedLocs: true });
  const articleLocaleCounts = Object.fromEntries(
    SITEMAP_LOCALES.map((locale) => [
      locale,
      (entries ?? []).reduce(
        (count, article) => count + publishedArticleLocales(article, paths, slugMap, shadowed).filter((row) => row.locale === locale).length,
        0,
      ),
    ]),
  );
  const pageUrls = [];
  for (const page of familySectionPages(section, archiveUnionSize(meta, slugMap), pageSize)) {
    if (SITEMAP_LOCALES.some((loc) => retiredPaths.has(page.paths[loc]))) continue;
    for (const loc of SITEMAP_LOCALES) {
      const parts = [`  <url>`, `    <loc>${SITE}${xmlEsc(page.paths[loc])}</loc>`];
      if (page.alternates) {
        for (const alt of SITEMAP_LOCALES) {
          parts.push(`    <xhtml:link rel="alternate" hreflang="${alt}" href="${SITE}${xmlEsc(page.paths[alt])}" />`);
        }
        parts.push(`    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE}${xmlEsc(page.paths.it)}" />`);
      }
      parts.push(`    <changefreq>daily</changefreq>`);
      parts.push(`    <priority>${page.priority}</priority>`);
      parts.push(`  </url>`);
      pageUrls.push(parts.join('\n'));
    }
  }
  const urls = [...pageUrls, ...articleUrls];
  return {
    xml:
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n` +
      `        xmlns:xhtml="http://www.w3.org/1999/xhtml"\n` +
      `        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n` +
      urls.join('\n') +
      `\n</urlset>\n`,
    count: urls.length,
    articleCount: countSitemapEntries(entries, slugMap, shadowed),
    articleUrlCount: articleUrls.length,
    articleLocaleCounts,
    pageCount: pageUrls.length,
  };
}
