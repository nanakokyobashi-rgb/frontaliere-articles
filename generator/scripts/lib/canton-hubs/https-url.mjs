/**
 * Absolute HTTPS URL accepted by corpus emitters and validators.
 *
 * Keep the raw value, but reject userinfo (including empty userinfo) and
 * WHATWG-normalised spellings. A slash inserted before a query/fragment on a
 * bare host is the one harmless URL normalisation accepted here.
 */
const RAW_HTTPS_URL_RE = /^https:\/\/[^\s"<>]+$/u;
const HTTPS_PREFIX_LENGTH = 'https://'.length;

function encodeNonAscii(value) {
  return value.replace(/[^\u0000-\u007F]/gu, (character) => encodeURIComponent(character));
}

export function httpsUrlOrNull(value) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || !RAW_HTTPS_URL_RE.test(value)) return null;
  if (value.includes('\\')) return null;

  const remainder = value.slice(HTTPS_PREFIX_LENGTH);
  const authorityEnd = remainder.search(/[\/?#]/u);
  const authority = remainder.slice(0, authorityEnd === -1 ? remainder.length : authorityEnd);
  if (authority.includes('@')) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;

    const encodedValue = encodeNonAscii(value);
    if (url.href === encodedValue) return value;

    // WHATWG inserts `/` for a bare host followed by nothing, a query, or a
    // fragment. Preserve those valid raw forms without allowing other rewrites.
    const hasPath = authorityEnd !== -1 && remainder[authorityEnd] === '/';
    if (!hasPath) {
      const insertion = authorityEnd === -1 ? value.length : HTTPS_PREFIX_LENGTH + authorityEnd;
      const withSlash = `${value.slice(0, insertion)}/${value.slice(insertion)}`;
      if (url.href === encodeNonAscii(withSlash)) return value;
    }
  } catch {
    return null;
  }
  return null;
}

export function isHttpsUrlOrNull(value) {
  return value === null || httpsUrlOrNull(value) !== null;
}
