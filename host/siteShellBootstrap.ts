/**
 * SiteShellContract implementation for THIS repository acting as its own host.
 *
 * WHY THIS EXISTS (issue #4974 item 3, migration §10.4 step 3)
 * ───────────────────────────────────────────────────────────
 * `engine/` reads every one of the contract's 37 fields through
 * `getSiteShell()`, and until now nothing in this repository ever called
 * `configureSiteShell()`. The engine files were here, but they could not RUN
 * here — `getSiteShell()` throws when unconfigured. The migration doc's §10.3
 * reads "steps 1 and 3 are already here — `renderArticlePages` lives in
 * `engine/ogPagesPlugin.ts`", which is true of the FILE and false of the
 * capability. That gap is why fast-publish could not simply be pointed at this
 * repo.
 *
 * The main repo's equivalent is `build-plugins/articlesSiteShellBootstrap.ts`,
 * which sits OUTSIDE `packages/articles` by design — the package must not
 * reach into a host's internals. Same rule applies here: everything under
 * `host/` is this repo's host role, and `engine/` never imports from it. The
 * only edge between them is `configureSiteShell(contract)`.
 *
 * TRANSPORT AND THE DRIFT IT CREATES
 * ──────────────────────────────────
 * Every value below is a copy of the main repo's. They render into each
 * article's `<head>`, so a divergence makes a fast-published page differ from
 * the full build that later overwrites it — the exact churn
 * `scripts/check-article-byte-identity.mjs` exists to catch, except it would
 * catch it AFTER publication.
 *
 * This is a genuine second producer, and unlike migration steps 1 and 2 it
 * could not be avoided by re-exporting: the host values are what the host
 * owns. `host/host-drift.test.mjs` is the mitigation — it pins every
 * transported literal against the main repo's published API surface and fails
 * when the two disagree. Read it before changing anything in `host/`.
 *
 * Transported by function closure, not by file, throughout: `constants.ts`
 * carries 15 of 746 lines, `criticalCss.ts` 2 declarations of 445,
 * `seoContentTokens.ts` 3 of 1025, and `SLUG_TABLES` (589 lines) collapses to
 * the eight blog slugs the closure actually reaches.
 */

import {
  BASE_URL,
  GTAG_SNIPPET,
  ADSENSE_SNIPPET,
  OFFERWALL_FC_SNIPPET,
  FAVICON_LINKS,
  SEO_STATIC_CSS_FILENAME,
  CDN_PRECONNECT_HINT,
} from './constants';
import { asyncCssLink, ASYNC_CSS_FALLBACK_SCRIPT, esc, asyncCssHeadBlock, rootShell } from './htmlTemplate';
import { WriteCollector } from './batchWrite';
import {
  buildTitleWithBrand,
  truncateHeadline,
  TITLE_BRAND_SUFFIX,
  TITLE_MAX_CHARS,
  clampMetaDescription,
  META_DESCRIPTION_MAX_CHARS,
} from './shared/titleSuffix';
import { resolveSpaBundle } from './spaBundleResolver';
import { truncateCodeUnits } from './shared/safeTruncate';
import { stableChunkFile, stableChunkFiles } from './shared/chunkFiles';
import { differentiateH1FromTitle } from './shared/seoContentTokens';
import { inlineScriptJson } from './shared/inlineJsonScript';
import { CRITICAL_CSS_LINK } from './shared/criticalCss';
import { railGutters } from './shared/railGutters';
import { buildDayStampIso } from './shared/buildDayStamp';
import { stripLiteralMarkdown } from './shared/stripLiteralMarkdown';
import { imageObjectLd } from './seo/imageObjectLd';
import { ORGANIZATION_LD } from './seo/organizationLd';
import { getAuthorBySlug } from './authors';
import {
  HUB_LOCALES,
  ARTICLES_PAGE_SIZE,
  ARTICLES_ALL_PATHS,
  BLOG_INDEX_SLUGS,
  SWISS_BLOG_INDEX_SLUGS,
} from './seoHubsData';
import {
  BLOG_CONTEXTUAL_LINKS,
  BLOG_LINKS_MAX_PER_ARTICLE,
  BLOG_LINKS_MIN_ARTICLE_WORDS,
} from './blogContextualLinksData';
import { configureSiteShell, type SiteShellContract } from '../engine/siteShell';

const contract: SiteShellContract = {
  baseUrl: BASE_URL,
  gtagSnippet: GTAG_SNIPPET,
  adsenseSnippet: ADSENSE_SNIPPET,
  offerwallFcSnippet: OFFERWALL_FC_SNIPPET,
  faviconLinks: FAVICON_LINKS,
  seoStaticCssFilename: SEO_STATIC_CSS_FILENAME,
  cdnPreconnectHint: CDN_PRECONNECT_HINT,

  asyncCssLink,
  asyncCssFallbackScript: ASYNC_CSS_FALLBACK_SCRIPT,
  esc,
  asyncCssHeadBlock,
  rootShell,

  railGutters,

  buildDayStampIso,

  stripLiteralMarkdown,

  WriteCollector,

  buildTitleWithBrand,
  truncateHeadline,
  titleBrandSuffix: TITLE_BRAND_SUFFIX,
  titleMaxChars: TITLE_MAX_CHARS,
  clampMetaDescription,
  metaDescriptionMaxChars: META_DESCRIPTION_MAX_CHARS,

  truncateCodeUnits,

  stableChunkFile,
  stableChunkFiles,

  differentiateH1FromTitle,

  inlineScriptJson,

  criticalCssLink: CRITICAL_CSS_LINK,

  imageObjectLd,

  resolveSpaBundle,

  organizationLd: ORGANIZATION_LD,

  getAuthorBySlug,

  blogIndexSlugs: BLOG_INDEX_SLUGS,
  swissBlogIndexSlugs: SWISS_BLOG_INDEX_SLUGS,

  hubLocales: HUB_LOCALES,
  articlesPageSize: ARTICLES_PAGE_SIZE,
  articlesAllPaths: ARTICLES_ALL_PATHS,

  contextualLinkRules: BLOG_CONTEXTUAL_LINKS,
  contextualLinksMaxPerArticle: BLOG_LINKS_MAX_PER_ARTICLE,
  contextualLinksDefaultMinWords: BLOG_LINKS_MIN_ARTICLE_WORDS,
};

configureSiteShell(contract);

export { contract };
