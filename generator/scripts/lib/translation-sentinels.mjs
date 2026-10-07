/**
 * Canonical shapes for opaque tokens that article translation protects from
 * machine translation. Producers, restorers and the free cascade all read
 * these shapes so a new classifier cannot silently drift from the masks.
 */
const SENTINEL_SHAPES = Object.freeze({
  gender: Object.freeze({ prefix: 'ZQX', suffix: 'XQZ', index: '\\d{1,3}' }),
  // The producer emits `0NAV${index}0`; the bare `0NAV0` form is also accepted
  // by the classifier. Lazy digits plus a non-digit boundary keep `0NAV10`
  // unambiguous: it is index 1 with the trailing sentinel zero, not index 10.
  nav: Object.freeze({
    prefix: '0NAV',
    suffix: '0',
    suffixPattern: '(?:0(?!\\d)|(?=\\D|$))',
    index: '\\d+?',
  }),
  municipality: Object.freeze({ prefix: '0M0', suffix: 'Q0', index: '\\d+' }),
});

function shapeFor(kind) {
  const shape = SENTINEL_SHAPES[kind];
  if (!shape) throw new TypeError(`translation sentinel kind not supported: ${kind}`);
  return shape;
}

/** Build one canonical sentinel for a producer. */
export function translationSentinel(kind, index) {
  if (!Number.isInteger(index) || index < 0) {
    throw new TypeError('translation sentinel index must be a non-negative integer');
  }
  const shape = shapeFor(kind);
  return `${shape.prefix}${index}${shape.suffix}`;
}

/** Build a fresh regexp for one family, or for all protected families. */
export function translationSentinelRegExp(kind = 'all', flags = 'giu') {
  const kinds = kind === 'all' ? Object.keys(SENTINEL_SHAPES) : [kind];
  const source = kinds.map((name) => {
    const shape = shapeFor(name);
    return `${shape.prefix}(${shape.index})${shape.suffixPattern || shape.suffix}`;
  }).join('|');
  return new RegExp(`(?:${source})`, flags);
}

/** Remove only canonical protected sentinels; surrounding prose is untouched. */
export function stripTranslationSentinels(value = '') {
  return String(value ?? '').replace(translationSentinelRegExp(), '');
}
