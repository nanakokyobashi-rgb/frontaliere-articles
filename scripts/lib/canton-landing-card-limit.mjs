/**
 * Plain-Node adapter for the canton landing card limit owned by the renderer.
 *
 * The renderer source is TypeScript and cannot be imported by the reconciler
 * without a TypeScript runtime. Keep the source extraction here so the
 * reconciler has one parser for the mirrored renderer export instead of a
 * second format-sensitive regex at its call site.
 */

const CANTON_LANDING_CARD_LIMIT_EXPORT_RE = /^[ \t]*export\s+const\s+CANTON_LANDING_CARD_LIMIT\s*(?::\s*number)?\s*=\s*(?<value>0|[1-9]\d*)(?:\s+as\s+const)?\s*;?(?=\s*(?:\/\/[^\r\n]*)?(?:\r?\n|$))/mu;

/**
 * Parse the renderer's `CANTON_LANDING_CARD_LIMIT` export.
 *
 * The declaration may be formatted across lines, carry a `number` annotation,
 * or use `as const`. Anything else is rejected so a future renderer change
 * cannot silently leave the reconciler with a stale or guessed limit.
 *
 * @param {string} source TypeScript source containing the renderer export
 * @returns {number}
 */
export function parseCantonLandingCardLimitExport(source) {
  if (typeof source !== 'string') {
    throw new Error('CANTON_LANDING_CARD_LIMIT export non valido: sorgente non testuale');
  }
  const match = CANTON_LANDING_CARD_LIMIT_EXPORT_RE.exec(source);
  if (!match) {
    throw new Error('CANTON_LANDING_CARD_LIMIT export non trovato o non valido');
  }
  const value = Number(match.groups.value);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`CANTON_LANDING_CARD_LIMIT export non valido: ${match.groups.value}`);
  }
  return value;
}
