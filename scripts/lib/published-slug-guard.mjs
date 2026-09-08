/**
 * Reserved URL segments that must never be emitted as published article slugs.
 *
 * This is a publish-boundary guard, not the translation predicate: a German
 * article may legitimately contain the word `Null`, but the literal segment
 * `null` is never a safe fallback for a public URL.
 */

const RESERVED_PUBLISHED_SLUGS = new Set(['null', 'undefined']);

export function isReservedPublishedSlug(value) {
  return typeof value === 'string'
    && RESERVED_PUBLISHED_SLUGS.has(value.trim().toLowerCase());
}
