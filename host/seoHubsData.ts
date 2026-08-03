/**
 * Hub slug/locale data the article engine reads through SiteShellContract.
 *
 * Closure extract from the main repo's `build-plugins/seoHubsData.ts` (322
 * lines). `SLUG_TABLES` (services/routeSlugs.data.ts, 589 lines) is NOT
 * transported: the closure reaches exactly two of its fields per locale
 * (`.blog` and `.blogCh`), so those eight strings are inlined below and pinned
 * against the main repo by host/host-drift.test.mjs. Transporting the whole
 * route table would drag the site's entire URL surface into this repo for
 * eight strings.
 */

export type HubLocale = 'it' | 'en' | 'de' | 'fr';
export type HubKind = 'tutti' | 'settori' | 'aziende';


/**
 * Per-locale hub-name slug (the trailing path component after the canton section).
 * Mirrors the locale slugs already used in the legacy TI `HUB_SLUGS` table.
 *
 * Exported (rather than module-private) so `localeTableCompletenessPlugin.ts`
 * can assert its completeness at build time — see
 * `build-plugins/shared/localeTableCompleteness.ts` (#3608 item 2 sibling
 * fix). Purely additive visibility change: the table's values and every
 * existing consumer are unchanged.
 */
export const HUB_SLUG_BY_LOCALE: Record<HubLocale, Record<HubKind, string>> = {
  it: { tutti: 'tutti',  settori: 'settori',  aziende: 'aziende' },
  en: { tutti: 'all',    settori: 'sectors',  aziende: 'companies' },
  de: { tutti: 'alle',   settori: 'branchen', aziende: 'unternehmen' },
  fr: { tutti: 'tous',   settori: 'secteurs', aziende: 'entreprises' },
};

export const HUB_LOCALES: readonly HubLocale[] = ['it', 'en', 'de', 'fr'] as const;

export const ARTICLES_PAGE_SIZE = 100;
/** `SLUG_TABLES[locale].blog` — pinned copy, see header. */
export const BLOG_INDEX_SLUGS: Record<HubLocale, string> = {
  it: 'articoli-frontaliere',
  en: 'cross-border-articles',
  de: 'grenzgaenger-artikel',
  fr: 'articles-frontalier',
};

/** `SLUG_TABLES[locale].blogCh` — pinned copy, see header. */
export const SWISS_BLOG_INDEX_SLUGS: Record<HubLocale, string> = {
  it: 'articoli-svizzera',
  en: 'swiss-articles',
  de: 'schweiz-artikel',
  fr: 'articles-suisse',
};

function articlesAllFor(locale: HubLocale): string {
  const prefix = locale === 'it' ? '' : `/${locale}`;
  return `${prefix}/${BLOG_INDEX_SLUGS[locale]}/${HUB_SLUG_BY_LOCALE[locale].tutti}/`;
}

/** `HUB_SLUGS[locale].articlesAll` for the frontaliere archive. */
export const ARTICLES_ALL_PATHS: Record<HubLocale, string> = {
  it: articlesAllFor('it'),
  en: articlesAllFor('en'),
  de: articlesAllFor('de'),
  fr: articlesAllFor('fr'),
};
