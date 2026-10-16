/** Shared, lightweight event marker contract for the digest producer/parser. */
// The end anchor makes title text containing a lookalike comment unambiguous.
export const DIGEST_EVENT_MARKER_PATTERN = /(?:^|[ \t])<!--\s*digest-event:([^\s]+)\s*-->[ \t]*$/u;

function toWellFormedString(value) {
  if (typeof value.toWellFormed === 'function') return value.toWellFormed();

  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index] + value[index + 1];
        index += 1;
      } else {
        result += '\uFFFD';
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      result += '\uFFFD';
    } else {
      result += value[index];
    }
  }
  return result;
}

/** Encode an event id without allowing malformed UTF-16 to abort the producer. */
export function encodeDigestEventId(value) {
  const id = String(value ?? '').trim();
  if (!id) return '';
  return encodeURIComponent(toWellFormedString(id)).replaceAll('-', '%2D');
}

/** Return the invisible, locale-independent marker appended to a digest event. */
export function digestEventMarker(event) {
  const payload = encodeDigestEventId(event?.id);
  return payload ? ' <!-- digest-event:' + payload + ' -->' : '';
}
