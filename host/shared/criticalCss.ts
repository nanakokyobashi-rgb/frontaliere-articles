/**
 * Critical-CSS link. Closure extract from the main repo's
 * `build-plugins/shared/criticalCss.ts` (445 lines — the rest is the inlined
 * CSS payload the article path never emits).
 */
import { ASSET_CDN_ORIGIN } from '../constants';


/**
 * Filename `staticScriptsPlugin.ts` writes {@link CRITICAL_CSS} to under
 * `dist/assets/` — STABLE (no content hash), like every other file that
 * plugin emits, so it revalidates via the `/assets/*` `max-age=600` header
 * instead of a rename on every content change.
 */
export const CRITICAL_CSS_FILENAME = 'critical.css';

/**
 * Render-blocking `<link>` for {@link CRITICAL_CSS_FILENAME} — deliberately
 * NOT the `media="print"` async-swap `asyncCssLink()` (`htmlTemplate.ts`)
 * uses for `seo-static.css`/the entry sheet, because this stylesheet must
 * still be in effect at first paint (see the file header comment).
 */
export const CRITICAL_CSS_LINK =
  `<link rel="stylesheet" href="/assets/${CRITICAL_CSS_FILENAME}" data-clarity-unmask="true">`;
