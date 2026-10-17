/**
 * Contract for links stored in article Markdown.
 *
 * Article bodies are data, but they are later rendered as HTML by the site.
 * A bare Markdown target therefore is not harmless prose: the browser resolves
 * it against the article URL and turns it into a crawlable same-origin route.
 * Keep the small legacy repair table here so the writer and the corpus gate
 * share one definition of what can be repaired without guessing.
 */

export const VALID_NAV_ACTIONS = new Set([
  'calculator', 'exchange', 'health', 'cost-of-living', 'pension', 'pillar3',
  'payslip', 'tax-return', 'residency', 'ristorni', 'unemployment', 'jobs', 'companies', 'banks',
  'first-day', 'permits', 'border', 'calendar', 'whatif', 'shopping', 'transport',
  'salary-compare', 'traffic-history', 'job-board', 'jobs-observatory', 'search-jobs',
  'border-map', 'municipalities', 'car-transfer', 'car-cost', 'permit-compare', 'renovation',
  'mobile', 'ral', 'parental-leave', 'nursery', 'living-ch', 'living-it', 'livability',
]);

const LEGACY_TARGET_TO_NAV = new Map([
  ['calculator', 'calculator'],
  ['calculator:cost-of-living', 'cost-of-living'],
  ['cost-of-living', 'cost-of-living'],
  ['border-map', 'border-map'],
  ['transport', 'transport'],
  ['salary-compare', 'salary-compare'],
  ['health', 'health'],
  ['health:companies', 'health'],
  ['municipalities:list', 'municipalities'],
  ['rechner: lebenshaltungskosten', 'cost-of-living'],
  ['gesundheit:unternehmen', 'health'],
  ['nav : calculatrice', 'calculator'],
  ['nav : permis', 'permits'],
  ['nav : déclaration de revenus', 'tax-return'],
  ['nav : pilier3', 'pillar3'],
]);

const LOCALE_CANONICAL_TARGETS = {
  it: new Map([
    ['statistiche/', '/statistiche/'],
    ['calcola-stipendio/', '/calcola-stipendio/'],
  ]),
  en: new Map([
    ['statistics/', '/en/statistics/'],
    ['calculate-salary/', '/en/calculate-salary/'],
  ]),
  de: new Map([
    ['Statistik/', '/de/statistiken/'],
    ['Gehaltsabrechnung/', '/de/gehalt-berechnen/'],
  ]),
  fr: new Map([
    ['statistiques/', '/fr/statistiques/'],
    ['calculez-salaire/', '/fr/calculer-salaire/'],
  ]),
};

const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(\s*([^\)\n]+?)\s*\)/g;

/**
 * Return the only safe, deterministic repair for a raw Markdown target.
 * `null` means keep the visible label but remove the link entirely.
 */
export function canonicalArticleLinkTarget(rawTarget, locale = 'it') {
  const target = String(rawTarget ?? '').trim();
  if (!target) return null;

  const legacyAction = LEGACY_TARGET_TO_NAV.get(target.toLowerCase());
  if (legacyAction) return `nav:${legacyAction}`;

  const localeTarget = LOCALE_CANONICAL_TARGETS[locale]?.get(target);
  if (localeTarget) return localeTarget;

  // The generator's existing action validator is the authority for whether
  // the action is usable. This contract only rejects malformed schemes and
  // bare routes; preserving the shape here lets that validator report unknown
  // `nav:` actions with its existing diagnostic.
  if (/^nav:[a-z0-9-]+$/.test(target)) return target;

  // Contact links are intentional non-HTTP links. They never become a route
  // under the current article URL and are supported by the article renderer.
  if (/^(?:https?:\/\/|mailto:|tel:)/i.test(target)) return target;

  // Root-relative and fragment links are already anchored to the public site
  // rather than to the article directory. Protocol-relative URLs are denied.
  if (/^(?:\/(?!\/)|#)/.test(target)) return target;

  return null;
}

/**
 * Normalize generated article Markdown before it is persisted.
 * Unknown or malformed targets deliberately become plain visible text.
 */
export function sanitizeArticleMarkdownLinks(text, locale = 'it') {
  return String(text ?? '').replace(MARKDOWN_LINK_RE, (whole, label, rawTarget, offset, source) => {
    // Images are not article navigation links. Leave their relative asset
    // target to the existing image pipeline.
    if (offset > 0 && source[offset - 1] === '!') return whole;
    const canonical = canonicalArticleLinkTarget(rawTarget, locale);
    return canonical ? `[${label}](${canonical})` : label;
  });
}

/**
 * Find links that still need the contract's repair before publication.
 * The returned index is byte-oriented enough for diagnostics on the UTF-8
 * source files and is intentionally independent of a TypeScript parser.
 */
export function findNonCanonicalArticleLinks(source, locale = 'it') {
  const offenders = [];
  const input = String(source ?? '');
  for (const match of input.matchAll(MARKDOWN_LINK_RE)) {
    const offset = match.index ?? 0;
    if (offset > 0 && input[offset - 1] === '!') continue;
    const rawTarget = match[2].trim();
    const canonical = canonicalArticleLinkTarget(rawTarget, locale);
    if (canonical === rawTarget) continue;
    offenders.push({
      label: match[1],
      target: rawTarget,
      replacement: canonical,
      index: offset,
    });
  }
  return offenders;
}
