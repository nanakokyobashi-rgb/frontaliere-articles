const LOCALE_FIELD_RE = /\b(en|de|fr)\s*:/gu;
const FALLBACK_MAP_DECLARATION_RE = /export\s+const\s+[A-Z0-9_]*SLUG_FALLBACK_REASONS\b[^=]*=\s*\{/gu;
const TOP_LEVEL_ENTRY_RE = /^\s*(['"])([^'"]+)\1\s*:\s*\{\s*([\s\S]*?)\s*\},?\s*$/gmu;

function findObjectEnd(source, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return index;
  }
  return -1;
}

/**
 * Read the locales whose published slug is explicitly marked as an Italian
 * fallback in a generated slug registry. The two main registries store a
 * nested `{ source, reason }` record, while canton registries store a reason
 * string; only the locale-key contract is relevant to the repair.
 */
export function extractSlugFallbackLocales(source) {
  const byArticle = new Map();
  const text = String(source || '');
  for (const declaration of text.matchAll(FALLBACK_MAP_DECLARATION_RE)) {
    const openIndex = (declaration.index ?? 0) + declaration[0].length - 1;
    const closeIndex = findObjectEnd(text, openIndex);
    if (closeIndex < 0) continue;
    const body = text.slice(openIndex + 1, closeIndex);
    TOP_LEVEL_ENTRY_RE.lastIndex = 0;
    for (const entry of body.matchAll(TOP_LEVEL_ENTRY_RE)) {
      const locales = [...entry[3].matchAll(LOCALE_FIELD_RE)].map((match) => match[1]);
      if (locales.length === 0) continue;
      const current = byArticle.get(entry[2]) || new Set();
      for (const locale of locales) current.add(locale);
      byArticle.set(entry[2], current);
    }
  }
  return byArticle;
}

export default { extractSlugFallbackLocales };
