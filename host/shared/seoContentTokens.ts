/**
 * H1/title differentiation. Closure extract from the main repo's
 * `build-plugins/shared/seoContentTokens.ts` (1025 lines — the rest is job /
 * company / canton card chrome the article path never reaches).
 */


function squashSpaces(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Per-locale "guida frontaliere" tag appended to an H1 when it would
 * otherwise collide with the page <title> after the brand suffix gets
 * dropped by `buildTitleWithBrand` (headline + brand > 66 chars).
 *
 * Used by `differentiateH1FromTitle` — see its docstring for the full
 * rationale (Semrush "Duplicate H1 and title tags", deploy-blocking
 * `audit:h1-title-duplicates`).
 */
const H1_DIFFERENTIATOR_TAG: Record<'it' | 'en' | 'de' | 'fr', string> = {
  it: 'guida frontaliere',
  en: 'cross-border guide',
  de: 'Grenzgänger-Leitfaden',
  fr: 'guide frontalier',
};

/**
 * Guarantee the visible H1 string differs from the page `<title>`.
 *
 * Why this exists: `buildTitleWithBrand` drops the
 * " | Frontaliere Ticino" brand suffix when the headline alone already
 * fills the 66-char SERP cap. When that happens the final `<title>`
 * becomes byte-identical to the matching `<h1>` — Semrush flags this
 * as "Duplicate H1 and title tags" and the deploy-blocking
 * `audit:h1-title-duplicates` ratchet (baseline 0) refuses the build.
 *
 * The fix: when title (after brand-strip) ≡ h1 (case-insensitive,
 * whitespace-collapsed), append a small locale-aware narrative tag in
 * parentheses. The tag is keyword-relevant (frontaliere context), short
 * enough to not push the H1 line into a wrap on mobile, and never
 * applied when the strings already differ. No effect on the `<title>`.
 *
 * @param h1     Original visible H1 string from the plugin.
 * @param title  The corresponding `<title>` string (may include the
 *               brand suffix; we strip it before comparison so the
 *               check matches the audit's normalisation).
 * @param locale Page locale — drives the appended tag.
 * @returns      H1 string that is guaranteed to differ from `title`.
 */
export function differentiateH1FromTitle(
  h1: string,
  title: string,
  locale: 'it' | 'en' | 'de' | 'fr',
): string {
  const safeH1 = squashSpaces(String(h1 || ''));
  const safeTitle = squashSpaces(String(title || '')).replace(
    /\s*[|·]\s*Frontaliere Ticino\s*$/i,
    '',
  ).trim();
  if (!safeH1 || !safeTitle) return safeH1;
  if (safeH1.toLowerCase() !== safeTitle.toLowerCase()) return safeH1;
  const tag = H1_DIFFERENTIATOR_TAG[locale] ?? H1_DIFFERENTIATOR_TAG.it;
  return `${safeH1} (${tag})`;
}
