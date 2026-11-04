import { isInvalidControlCode } from './sanitize-control-chars.mjs';

// JSON.parse turns `\\u0008` into a raw backspace, while the text fallback
// still sees the six-character escape. Reject both spellings before a writer
// can sanitize one of them and publish text different from the model output.
const ESCAPED_INVALID_CONTROL = /\\(?:u00(?:0[0-8bcef]|1[0-9a-f])|x(?:0[0-8bcef]|1[0-9a-f]))/iu;
const NUMERIC_HTML_ENTITY = /&#(?:x([0-9a-f]+)|([0-9]+));/giu;
const AMPERSAND_HTML_ENTITY = /&(?:amp;|#0*38;)/giu;

function containsInvalidControlEntity(value) {
  // `normalizeLocalizedToponymText()` decodes these ampersand entities for
  // three passes before decoding numeric references. Mirror that sequence so
  // `&amp;#8;` is rejected before a writer turns it into a raw C0 byte.
  let normalized = value;
  for (let pass = 0; pass < 3; pass += 1) {
    normalized = normalized.replace(AMPERSAND_HTML_ENTITY, '&');
  }
  for (const [, hexadecimal, decimal] of normalized.matchAll(NUMERIC_HTML_ENTITY)) {
    const code = Number.parseInt(hexadecimal ?? decimal, hexadecimal ? 16 : 10);
    if (Number.isSafeInteger(code) && isInvalidControlCode(code)) return true;
  }
  return false;
}

export function rejectRawFaqControlEscape(value) {
  if (typeof value !== 'string') return false;
  // Article normalization decodes numeric HTML character references before
  // publishing. Treat references to forbidden C0 bytes as invalid here too,
  // so every FAQ writer sharing this contract catches them before serialize.
  if (ESCAPED_INVALID_CONTROL.test(value) || containsInvalidControlEntity(value)) return true;
  for (let index = 0; index < value.length; index += 1) {
    if (isInvalidControlCode(value.charCodeAt(index))) return true;
  }
  return false;
}

export function faqPairContainsRejectedControl(pair) {
  return rejectRawFaqControlEscape(pair?.q) || rejectRawFaqControlEscape(pair?.a);
}

/** Reject a FAQ collection before any fallback or writer can sanitize it. */
export function assertFaqPairsHaveNoRejectedControls(pairs, context = 'FAQ response') {
  if (!Array.isArray(pairs)) return pairs;
  const invalidIndex = pairs.findIndex(faqPairContainsRejectedControl);
  if (invalidIndex >= 0) {
    throw new Error(
      `${context} contains an unpublishable control character/reference in pair ${invalidIndex}; refusing to sanitize it silently`,
    );
  }
  return pairs;
}
