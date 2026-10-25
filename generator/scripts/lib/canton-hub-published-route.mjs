/**
 * A canton hub may link to a real page which is intentionally out of the
 * sitemap while its source release is stale or incomplete.  The page must
 * prove all three parts of that contract: the producer marker, a self
 * canonical URL and an explicit robots noindex directive.
 */
export const INTENTIONAL_NOINDEX_PHARMACY_MARKER = '<!--PHARMACY_NOINDEX_TARGET-->';

function attribute(tag, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(?:^|\\s)${escapedName}\\s*=\\s*(?:(["'])(.*?)\\1|([^\\s"'=<>` + '`' + `]+))`,
    'i',
  );
  const match = pattern.exec(tag);
  return match?.[2] ?? match?.[3] ?? null;
}

function canonicalHref(html) {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = attribute(tag, 'rel');
    if (rel?.split(/\s+/).some((token) => token.toLowerCase() === 'canonical')) {
      return attribute(tag, 'href');
    }
  }
  return null;
}

function robotsContent(html) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if ((attribute(tag, 'name') ?? '').toLowerCase() !== 'robots') continue;
    return attribute(tag, 'content');
  }
  return null;
}

/**
 * Validate a noindex page as a real, intentional destination rather than the
 * SPA fallback.  The caller has already checked that the URL is absent from
 * the published sitemap.
 */
export function isIntentionalNoindexPharmacyPage(html, expectedUrl) {
  if (typeof html !== 'string' || !html.includes(INTENTIONAL_NOINDEX_PHARMACY_MARKER)) return false;
  if (typeof expectedUrl !== 'string' || !expectedUrl) return false;

  const canonical = canonicalHref(html);
  if (!canonical) return false;

  let canonicalUrl;
  let expected;
  try {
    canonicalUrl = new URL(canonical, expectedUrl).href;
    expected = new URL(expectedUrl).href;
  } catch {
    return false;
  }
  if (canonicalUrl !== expected) return false;

  return (robotsContent(html) ?? '')
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .includes('noindex');
}
