/**
 * A canton hub may link to a real page which is intentionally out of the
 * sitemap while its source release is stale or incomplete.  The page must
 * prove all three parts of that contract: the producer marker, a self
 * canonical URL and an explicit robots noindex directive.
 */
export const INTENTIONAL_NOINDEX_PHARMACY_MARKER = '<!--PHARMACY_NOINDEX_TARGET-->';

/**
 * Return opening tags without treating a `>` inside a quoted attribute as the
 * end of the tag.  These pages are fetched from a live SPA fallback, so the
 * predicate must fail closed when the markup is unusual rather than silently
 * reading a truncated attribute.
 */
function tagsByName(html, name) {
  const tags = [];
  const startPattern = new RegExp(`<${name}\\b`, 'gi');
  for (const match of html.matchAll(startPattern)) {
    let quote = null;
    let end = -1;
    for (let index = match.index; index < html.length; index += 1) {
      const char = html[index];
      if (quote) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        end = index;
        break;
      }
    }
    if (end >= 0 && !quote) tags.push(html.slice(match.index, end + 1));
  }
  return tags;
}

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
  for (const tag of tagsByName(html, 'link')) {
    const rel = attribute(tag, 'rel');
    if (rel?.split(/\s+/).some((token) => token.toLowerCase() === 'canonical')) {
      return attribute(tag, 'href')?.trim() ?? null;
    }
  }
  return null;
}

function robotsContents(html) {
  return tagsByName(html, 'meta')
    .filter((tag) => (attribute(tag, 'name') ?? '').trim().toLowerCase() === 'robots')
    .map((tag) => attribute(tag, 'content')?.trim() ?? '')
    .filter(Boolean);
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

  const directives = robotsContents(html)
    .flatMap((content) => content.split(',').map((token) => token.trim().toLowerCase()));
  // Multiple robots tags are combined by crawlers.  Require an unambiguous
  // noindex verdict: a conflicting `index` directive must never turn a
  // malformed/fallback page into an accepted published route.
  return directives.includes('noindex') && !directives.includes('index');
}
