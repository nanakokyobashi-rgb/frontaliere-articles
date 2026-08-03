/**
 * Site constants the article engine reads through SiteShellContract.
 *
 * Transported BY FUNCTION CLOSURE from the main repo's
 * `build-plugins/constants.ts` (746 lines): only the 15 declarations the
 * contract reaches. The whole file also imports botPatterns,
 * posthog-error-filter, resilientImport, adSlotHtml and redirectStubMarker,
 * none of which the article path touches.
 *
 * These values MUST stay byte-equal to the main repo's. They end up in every
 * rendered <head>; a drift here makes fast-published pages differ from what
 * the next full build overwrites them with. `host/host-drift.test.mjs` is the
 * guard.
 */


export const SEO_STATIC_CSS_FILENAME = 'seo-static.css';

/**
 * Cross-origin preconnect to the asset CDN (the frontaliere-cdn Pages site).
 *
 * On deploy builds every render-blocking resource on static + locale-shard
 * pages — index.css, seo-static.css, the SPA bundle, early-boot.js,
 * gtag-init.js — is rebased to `${ASSET_CDN}` (cdn.frontaliereticino.ch) by
 * vite.config.ts `renderBuiltUrl`. Without an early hint the browser only
 * opens that cross-origin socket when it reaches the stylesheet `<link>` ~8.6
 * KB into the `<head>` (after the JSON-LD blocks), paying a full DNS+TCP+TLS
 * round-trip (~50-300 ms) BEFORE the blocking CSS can even start downloading —
 * and static pages carry NO `modulepreload` to the CDN to warm it first.
 * Emitting one `<link rel="preconnect">` as an early head hint overlaps that
 * handshake with head parsing → shaves the round-trip off first paint on every
 * page in every locale.
 *
 * `crossorigin` makes it an anonymous (uncredentialed) connection — the same
 * mode the CDN stylesheet/script/font fetches use — so the warmed socket is
 * reused for all of them (HTTP/2 coalesces the no-cors seo-static.css onto the
 * same uncredentialed connection). A single hint therefore covers every CDN
 * fetch; no `dns-prefetch` fallback is emitted (preconnect already resolves
 * DNS, and the ~57 extra bytes ride on ~822k pages).
 *
 * Built from process.env.ASSET_CDN (deploy builds only — the same env that
 * drives renderBuiltUrl). Empty string on dev / non-CDN builds, where assets
 * stay same-origin and no preconnect is needed. constants.ts is build-only
 * (it already imports child_process/node:fs), so reading process.env here is
 * safe — no client bundle pulls it in.
 */
const ASSET_CDN_ORIGIN = ((): string => {
  const raw = (process.env.ASSET_CDN || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    return new URL(raw).origin;
  } catch {
    return '';
  }
})();

export const CDN_PRECONNECT_HINT = ASSET_CDN_ORIGIN
  ? `<link rel="preconnect" href="${ASSET_CDN_ORIGIN}" crossorigin>`
  : '';

export const BASE_URL = 'https://frontaliereticino.ch';

/**
 * GA4 measurement ID — same as Firebase Analytics measurementId.
 * Used in the lightweight gtag.js snippet injected into static HTML pages
 * so that page views are tracked even for users who bounce before React hydrates.
 */
export const GA4_MEASUREMENT_ID = 'G-LGJ9LE360F';

export const GTAG_INIT_FILENAME = 'gtag-init.js';

// gtag-init.js only pushes the GA4 page_view onto window.dataLayer; it does
// NOT need to run before paint. `defer` takes it off the render-blocking path
// (it ran synchronously in <head> before) so first paint no longer waits on a
// cross-origin script fetch — the deferred order still runs it before the
// async gtag/js library consumes the queue. The library tag stays `async`.
/**
 * Cloudflare Web Analytics (RUM/CWV field data) — MANUAL snippet: the
 * zone-level auto-inject never provisions its injection ruleset on this zone
 * (apex HTML flows through the locale-router Worker), so every emitted page
 * ships the beacon directly. Appended to GTAG_SNIPPET so all static emitters
 * get it by construction; index.html carries its own copy for the SPA.
 * The token is public by design (it is meant to appear in served HTML).
 * The `version` key is REQUIRED: without it beacon.min.js posts to the
 * decommissioned central ingest (cloudflareinsights.com → HTML 404); with it
 * the beacon posts same-origin /cdn-cgi/rum (zone ingest — excluded from the
 * trailing-slash-301 rule, which was silently 301-killing beacon POSTs). #3503
 */
export const CF_BEACON_SNIPPET = `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "1268b58e83f74d22a2136ff48e0746b7", "version": "2024.6.1"}'></script>`;

export const GTAG_SNIPPET = `<script async crossorigin="anonymous" src="https://www.googletagmanager.com/gtag/js?id=${GA4_MEASUREMENT_ID}"></script>
 <script defer src="/assets/${GTAG_INIT_FILENAME}"></script>
 ${CF_BEACON_SNIPPET}`;

/**
 * Google AdSense loader snippet. Included in every statically-generated page
 * (job detail, hubs, fuel, health premiums, orphan queries, etc.) so Auto Ads
 * can serve on pages that do not mount the <AdSenseBanner> React component.
 * The client ID must match the meta `google-adsense-account` in index.html.
 *
 * LAZY LOADING (2026-04-23): adsbygoogle.js is no longer eagerly injected in
 * <head>. Semrush flagged 8129 "uncompressed JS" notices because every static
 * crawl fetched the script synchronously. Instead we ship:
 *  - preconnect hints to pagead2 so when we do load it's fast
 *  - google-adsense-account meta (required for AdSense site verification)
 *  - an inline IntersectionObserver loader that injects the script and pushes
 *    each <ins class="adsbygoogle"> slot the first time it scrolls within
 *    200px of the viewport. If no slot ever becomes visible, the script is
 *    never loaded — Semrush/Google crawlers stop seeing it in audits.
 *  - a first-interaction trigger (scroll/touchstart/pointerdown/keydown/
 *    mousemove, once+passive) that loads the script on the first real user
 *    engagement. This closes the biggest Auto Ads leak: quick-bounce mobile
 *    sessions (75% of traffic) that tap/scroll but leave before the idle
 *    fallback fires, so the anchor/vignette overlays never serve. Crawlers
 *    don't interact, so the Semrush "no synchronous JS" benefit is preserved.
 *  - a requestIdleCallback fallback that still loads the script after idle so
 *    Auto Ads (anchor, vignette, in-page) continue to earn on pages with no
 *    manual <ins> slots and no interaction.
 */
export const ADSENSE_CLIENT_ID = 'ca-pub-8628054934855353';

export const ADSENSE_LOADER_FILENAME = 'adsense-loader.js';

export const ADSENSE_LAZY_LOADER = `<script defer src="/assets/${ADSENSE_LOADER_FILENAME}"></script>`;

/**
 * Publisher id (no `ca-` prefix) for the Funding Choices endpoints, derived
 * from {@link ADSENSE_CLIENT_ID} so it never drifts from the AdSense account.
 */
export const FC_PUBLISHER_ID = ADSENSE_CLIENT_ID.replace(/^ca-/, '');

 // pub-8628054934855353

/**
 * Offerwall custom-choice registry + Funding Choices MESSAGING loader, injected
 * PARSE-TIME into the <head> of in-scope STATIC article pages.
 *
 * WHY THIS EXISTS (2026-06-16): the GAM Offerwall is scoped to the article
 * sections, which are emitted as static SSG HTML (staticPagesPlugin) whose head
 * does NOT carry index.html's inline Offerwall block. On those pages the only
 * Funding Choices loader that ever runs is the network-code one pulled in by
 * adsbygoogle.js AFTER hydration — it fetches the Offerwall /f/ message (200,
 * incl. our custom choice) but never instantiates the overlay. The publisher-id
 * MESSAGING loader (`/i/pub-XXX`) — the one index.html uses on SPA roots and the
 * one that actually renders FC messages — is absent. Injecting the registry +
 * pub-id loader at PARSE TIME (before hydration and before adsbygoogle's
 * network-code loader claims the singleton FC instance) brings article pages to
 * parity with index.html's proven render path. (#2312 injected the same loader
 * POST-hydration via the React gate and it never rendered, because FC was
 * already singleton-initialised by the network-code loader — parse-time is the
 * differentiator.)
 *
 * MUST stay byte-aligned with index.html's loadFc()/registry on the essentials
 * (same pub-id loader URL, `data-fc-loader` dedup marker, NO crossOrigin — see
 * tests/index-html-fc-loader.test.ts for the CORS rationale — googlefcPresent
 * signal, requestIdleCallback/DOMContentLoaded deferral for LCP). The drift
 * guard lives in tests/offerwall-static-fc-snippet.test.ts. The registry's
 * behaviour mirrors components/community/OfferwallNewsletterGate.tsx
 * (ensureOfferwallRegistry), which is idempotent (`if (cc.registry) return`) and
 * so no-ops when this parse-time copy already set it — the gate still installs
 * the window.__ftOfferwallSubscribe hook this registry delegates to.
 *
 * The anti-adblock fallback IIFE that index.html also runs from loadFc() is
 * deliberately NOT included here — it is a separate feature, out of scope for
 * the Offerwall render fix.
 */
export const OFFERWALL_FC_SNIPPET = `<script>(function(){var g=window.googlefc=window.googlefc||{};var ow=g.offerwall=g.offerwall||{};var cc=ow.customchoice=ow.customchoice||{};if(cc.registry)return;function hasAccess(){try{if(window.localStorage.getItem('newsletter_subscribed')==='true')return true;for(var i=0;i<window.localStorage.length;i++){var k=window.localStorage.key(i);if(k&&k.indexOf('firebase:authUser:')===0)return true;}}catch(e){}return false;}cc.registry={initialize:function(params){var E=cc.InitializeResponseEnum||{};if(hasAccess()){return Promise.resolve(E.ACCESS_GRANTED||'ACCESS_GRANTED');}window.__ftOfferwallLang=(params&&params.offerwallLanguageCode)||null;return Promise.resolve(E.ACCESS_NOT_GRANTED||'ACCESS_NOT_GRANTED');},show:function(){var fn=window.__ftOfferwallSubscribe;function run(f){try{return Promise.resolve(f(window.__ftOfferwallLang)).then(function(ok){return !!ok;});}catch(e){return Promise.resolve(false);}}if(typeof fn!=='function'){return new Promise(function(resolve){var settled=false;function settle(ok){if(settled)return;settled=true;resolve(!!ok);}var q=window.__ftOfferwallShowQueue=window.__ftOfferwallShowQueue||[];var timer=setTimeout(function(){settle(false);},10000);q.push(function(hook){if(settled)return;clearTimeout(timer);run(hook).then(settle,function(){settle(false);});});});}return run(fn);}};})();</script>
 <script>(function(){function loadFc(){if(!document.querySelector('script[data-fc-loader]')){var s=document.createElement('script');s.async=true;s.src='https://fundingchoicesmessages.google.com/i/${FC_PUBLISHER_ID}?ers=1';s.setAttribute('data-fc-loader','1');document.head.appendChild(s);}(function sig(){if(!window.frames['googlefcPresent']){if(document.body){var f=document.createElement('iframe');f.style='width:0;height:0;border:none;z-index:-1000;left:-1000px;top:-1000px;';f.style.display='none';f.name='googlefcPresent';document.body.appendChild(f);}else{setTimeout(sig,0);}}})();}function ricFb(cb){if(document.readyState==='complete'){setTimeout(cb,200);}else{window.addEventListener('load',function(){setTimeout(cb,200);},{once:true});}}function schedule(){(window.requestIdleCallback||ricFb)(loadFc,{timeout:4000});}if(document.readyState==='loading'){window.addEventListener('DOMContentLoaded',schedule,{once:true});}else{schedule();}})();</script>`;

export const ADSENSE_SNIPPET = `<meta name="google-adsense-account" content="${ADSENSE_CLIENT_ID}">
 <link rel="preconnect" href="https://pagead2.googlesyndication.com" crossorigin>
 <link rel="dns-prefetch" href="https://pagead2.googlesyndication.com">
 ${ADSENSE_LAZY_LOADER}`;

/** Favicon link tags shared across all static HTML pages. */
export const FAVICON_LINKS = `<link rel="icon" href="/favicon.ico" sizes="48x48">
 <link rel="icon" type="image/svg+xml" href="/favicon.svg">`;
