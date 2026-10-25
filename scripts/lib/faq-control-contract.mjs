import { isInvalidControlCode } from './sanitize-control-chars.mjs';

// JSON.parse turns `\\u0008` into a raw backspace, while the text fallback
// still sees the six-character escape. Reject both spellings before a writer
// can sanitize one of them and publish text different from the model output.
const ESCAPED_INVALID_CONTROL = /\\(?:u00(?:0[0-8bcef]|1[0-9a-f])|x(?:0[0-8bcef]|1[0-9a-f]))/iu;

export function rejectRawFaqControlEscape(value) {
  if (typeof value !== 'string') return false;
  if (ESCAPED_INVALID_CONTROL.test(value)) return true;
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
      `${context} contains a raw control escape in pair ${invalidIndex}; refusing to sanitize it silently`,
    );
  }
  return pairs;
}
