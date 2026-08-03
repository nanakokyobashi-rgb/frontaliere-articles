/**
 * Static-page HTML chrome the article engine reads through SiteShellContract.
 *
 * Closure extract from the main repo's `build-plugins/htmlTemplate.ts` (449
 * lines): the 5 declarations the contract reaches. Must stay byte-equal to the
 * main repo's — see host/constants.ts.
 */
import { CRITICAL_CSS_LINK } from './shared/criticalCss';
import { SEO_STATIC_CSS_FILENAME } from './constants';


/**
 * Async-CSS swap snippet shared by every static page emitted through
 * {@link buildSimplePage}.
 *
 * Renders a stylesheet `<link>` non-render-blocking via the `media="print"` →
 * `media='all'` onload swap trick, with:
 *  - a `<link rel="preload" as="style">` to start the download immediately,
 *  - a `<noscript>` synchronous fallback so no-JS clients + crawlers still get
 *    the full stylesheet,
 *  - `data-clarity-unmask="true"` so Microsoft Clarity keeps the href in
 *    session recordings.
 *
 * First paint is rendered from the render-blocking {@link CRITICAL_CSS_LINK}
 * (`/assets/critical.css`), so the static SEO content (rendered immediately,
 * not behind a skeleton) does not FOUC while the full sheet streams in. This
 * is the SAME pattern the sibling
 * static emitters already use (`staticPagesPlugin.ts`, `ogPagesPlugin.ts`,
 * `asyncCssPlugin.ts`, and the hand-rolled job-detail head in
 * `jobsSeoPagesPlugin.ts`) — kept in one helper here so the buildSimplePage
 * path can't drift back to render-blocking CSS.
 *
 * `href` may be same-origin (`/assets/…`) or an absolute CDN URL
 * (`https://cdn.…/assets/…`) when ASSET_CDN/renderBuiltUrl is active.
 */
export function asyncCssLink(href: string): string {
  return (
    `<link rel="preload" as="style" crossorigin href="${href}" data-clarity-unmask="true">` +
    `<link rel="stylesheet" crossorigin href="${href}" media="print" onload="this.media='all'" data-clarity-unmask="true">` +
    `<noscript><link rel="stylesheet" crossorigin href="${href}" data-clarity-unmask="true"></noscript>`
  );
}

/**
 * Belt-and-braces timer that flips any still-`media="print"` async stylesheet
 * to `media='all'` after 3s in case the `onload` handler never fired (cached
 * 304 with no load event on some engines, blocked onload, etc.). Mirrors the
 * identical fallback in `staticPagesPlugin.ts` / `ogPagesPlugin.ts`, and the
 * `link[media="print"][href*="/assets/"]` selector the SPA boot path waits on
 * (`index.tsx#waitForAsyncStylesheet`). Emitted once per page.
 *
 * When the timer fires (i.e. the async swap fell back to the 3s timeout — the
 * signal of an onload failure that can cause FOUC/CLS) it queues
 * `sessionStorage._cssFallbackInfo`, which `services/analytics.ts` drains into
 * the GA4 `css_fallback` event (`Analytics.trackCssFallback`). Keeping this
 * telemetry here — identical to the sibling fallbacks — is what makes the
 * post-deploy revert-trigger observable on every page that goes through
 * `asyncCssHeadBlock` (job-detail, collection/faq, soft-landing, recency,
 * sector, hub). Also used verbatim (imported, not copy-pasted — AGENTS.md §6)
 * by `ogPagesPlugin.ts` and `staticPagesPlugin.ts`'s hand-rolled heads, which
 * don't go through `asyncCssHeadBlock` itself.
 *
 * `visibilityState` (issue #4304 triage, 956 events/30d): captures
 * `document.visibilityState` at the moment the timer fires. Live PostHog data
 * showed this event is NOT concentrated in one browser engine (Chrome/Android
 * and Mobile Safari/iOS both contribute proportionally to their traffic
 * share) and 93% of events report `navigator.connection.effectiveType`
 * `'4g'` — evidence against both a single-engine onload bug and a simple
 * slow-network explanation, since `effectiveType` is a soft heuristic that
 * defaults to `'4g'` absent contrary evidence, not a hard measurement. A
 * strong remaining candidate is background-tab throttling (mobile OSes
 * deprioritize timers/fetches for backgrounded tabs — consistent with a
 * cross-engine, "network looked fine" pattern); `visibilityState` lets that
 * be confirmed or ruled out from the next data pull instead of guessing.
 */
export const ASYNC_CSS_FALLBACK_SCRIPT =
  `<script>setTimeout(function(){var ls=document.querySelectorAll('link[media="print"][href*="/assets/"]');for(var i=0;i<ls.length;i++){ls[i].media='all'}if(ls[0]){try{sessionStorage.setItem('_cssFallbackInfo',JSON.stringify({href:ls[0].href,delayMs:3000,pagePath:location.pathname+location.search,visibilityState:document.visibilityState||'unknown',ts:new Date().toISOString()}))}catch(e){}}},3000)</script>`;

/**
 * Full CSS `<head>` block for static SEO landing pages:
 *   1. render-BLOCKING `<link>` to the first-paint {@link CRITICAL_CSS_LINK}
 *      (`/assets/critical.css`),
 *   2. async-swapped Vite entry stylesheet (optional — only when a SPA bundle
 *      is present for the page),
 *   3. async-swapped `seo-static.css` (the s-* utility sheet),
 *   4. the 3s belt-and-braces flip script.
 *
 * This is the SINGLE source of truth so the hand-rolled heads in the
 * job/sector/recency/hub SEO emitters and the buildSimplePage shell can't
 * drift apart (AGENTS.md §6 — one shared module, not copy-pasted async
 * markup). `entryCss` may be a same-origin filename (e.g. `index-abc.css`) or
 * an absolute CDN URL; an empty/undefined value omits the entry sheet.
 */
export function asyncCssHeadBlock(entryCss?: string): string {
  const entryCssHref = entryCss ? (/^https?:\/\//.test(entryCss) ? entryCss : `/assets/${entryCss}`) : '';
  const entryLink = entryCssHref ? `\n    ${asyncCssLink(entryCssHref)}` : '';
  return (
    CRITICAL_CSS_LINK +
    `${entryLink}\n    ${asyncCssLink(`/assets/${SEO_STATIC_CSS_FILENAME}`)}` +
    `\n    ${ASYNC_CSS_FALLBACK_SCRIPT}`
  );
}

/**
 * Empty `#root` for SPA-shell SEO pages, with a first-paint header-height
 * reservation spacer.
 *
 * The crawler-facing SEO content lives in a `<main class="seo-static-content">`
 * body-sibling OUTSIDE `#root`; React mounts the SPA chrome (the sticky nav
 * header, `h-14 md:h-20` = 56/80px) INTO `#root`, which — starting empty — would
 * shove that sibling content down by the header height on mount (live: ~0.08
 * desktop CLS on `/cerca-lavoro-*`). The `.ft-hdr-reserve` spacer (height pinned
 * in `shared/criticalCss.ts`'s `ROOT_HEADER_RESERVE_CSS`) holds the header height
 * from first paint so nothing jumps. `createRoot().render()` REPLACES #root's
 * children (client render, not hydration), so the spacer leaves no residue and
 * the real same-height header takes its place shift-free.
 *
 * Single source of truth so the literal `<div id="root"></div>` emitters in the
 * funnel plugins (`jobsSeoPagesPlugin`, `seoHubsPlugin`, `jobSectorPagesPlugin`,
 * `jobRecencyPagesPlugin`, `staticPagesPlugin`) and the `buildSimplePage` shell
 * can't drift apart (AGENTS.md §6).
 *
 * GATED on the SPA bundle: the spacer is only safe when React actually mounts
 * (createRoot replaces it with the real header). `resolveEntryAssets`
 * (`seoPageShell.ts`) now always returns the fixed entry filenames — it no
 * longer checks disk, so it can't degrade to `''` — but callers still pass
 * the bundle flag (`!!entryJs` / `hasSpaBundle`) defensively: if a future
 * regression genuinely drops the entry chunk, an unconditional spacer would
 * sit as a PERMANENT 56/80px empty band above the indexed SEO content
 * instead of degrading to a plain empty `#root` (0px, content at top).
 */
export function rootShell(hasSpaBundle: boolean): string {
  return hasSpaBundle
    ? '<div id="root"><div class="ft-hdr-reserve" aria-hidden="true"></div></div>'
    : '<div id="root"></div>';
}

/** HTML escape for attribute values and text content. */
export function esc(s: string): string {
 return s
 .replace(/&/g, '&amp;')
 .replace(/</g, '&lt;')
 .replace(/>/g, '&gt;')
 .replace(/"/g, '&quot;');
}
