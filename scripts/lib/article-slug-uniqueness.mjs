/**
 * Static localized article-slug map reader and uniqueness checks.
 *
 * The corpus writer, post-rebase gate, and localized-toponym repair all touch
 * the same four-field map. Keep its small static grammar and the route-owner
 * invariant in one builtin-Node module so each write path enforces the same
 * rule without depending on an installed package.
 */

export const ARTICLE_SLUG_LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);

function fail(label, message) {
  throw new SyntaxError(`${label}: ${message}`);
}

function skipTrivia(source, start, label) {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index += 1;
      continue;
    }
    if (source.startsWith('//', index)) {
      const newline = source.indexOf('\n', index + 2);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const close = source.indexOf('*/', index + 2);
      if (close < 0) fail(label, 'commento non chiuso');
      index = close + 2;
      continue;
    }
    break;
  }
  return index;
}

function readString(source, start, label) {
  const quote = source[start];
  if (quote !== "'" && quote !== '"') fail(label, `stringa attesa alla posizione ${start}`);
  let value = '';
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === quote) return { value, end: index + 1 };
    if (character === '\n' || character === '\r') fail(label, `stringa non chiusa alla posizione ${start}`);
    if (character !== '\\') {
      value += character;
      index += 1;
      continue;
    }

    const escape = source[index + 1];
    if (escape === undefined) fail(label, `escape non chiuso alla posizione ${index}`);
    if (escape === '\n') {
      index += 2;
      continue;
    }
    if (escape === '\r' && source[index + 2] === '\n') {
      index += 3;
      continue;
    }
    const simpleEscapes = {
      b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
      '0': '\0', '\\': '\\', "'": "'", '"': '"',
    };
    if (Object.prototype.hasOwnProperty.call(simpleEscapes, escape)) {
      value += simpleEscapes[escape];
      index += 2;
      continue;
    }
    if (escape === 'x') {
      const digits = source.slice(index + 2, index + 4);
      if (!/^[0-9a-f]{2}$/i.test(digits)) fail(label, `escape hex non valido alla posizione ${index}`);
      value += String.fromCharCode(Number.parseInt(digits, 16));
      index += 4;
      continue;
    }
    if (escape === 'u') {
      if (source[index + 2] === '{') {
        const close = source.indexOf('}', index + 3);
        const digits = close < 0 ? '' : source.slice(index + 3, close);
        const codePoint = Number.parseInt(digits, 16);
        if (!/^[0-9a-f]{1,6}$/i.test(digits) || codePoint > 0x10ffff) {
          fail(label, `escape Unicode non valido alla posizione ${index}`);
        }
        value += String.fromCodePoint(codePoint);
        index = close + 1;
        continue;
      }
      const digits = source.slice(index + 2, index + 6);
      if (!/^[0-9a-f]{4}$/i.test(digits)) fail(label, `escape Unicode non valido alla posizione ${index}`);
      value += String.fromCharCode(Number.parseInt(digits, 16));
      index += 6;
      continue;
    }

    // TypeScript accepts identity escapes in quoted strings. Preserve the
    // escaped character; generated URL slugs normally need no such escapes.
    value += escape;
    index += 2;
  }
  fail(label, `stringa non chiusa alla posizione ${start}`);
}

function readStaticKey(source, start, label) {
  if (source[start] === "'" || source[start] === '"') {
    const string = readString(source, start, label);
    return { key: string.value, end: string.end };
  }
  const match = /^[A-Za-z_$][\w$]*/.exec(source.slice(start));
  if (!match) fail(label, `chiave statica attesa alla posizione ${start}`);
  return { key: match[0], end: start + match[0].length };
}

function findInitializer(source, constName, label) {
  const declaration = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:const|let|var)\\s+${constName}\\b`, 'm');
  const match = declaration.exec(source);
  if (!match) fail(label, `dichiarazione ${constName} assente`);

  let index = match.index + match[0].length;
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;
  while (index < source.length) {
    index = skipTrivia(source, index, label);
    const character = source[index];
    if (character === "'" || character === '"') {
      index = readString(source, index, label).end;
      continue;
    }
    if (character === '{') braces += 1;
    else if (character === '}') braces -= 1;
    else if (character === '[') brackets += 1;
    else if (character === ']') brackets -= 1;
    else if (character === '(') parentheses += 1;
    else if (character === ')') parentheses -= 1;
    else if (character === '=' && braces === 0 && brackets === 0 && parentheses === 0) {
      const initializer = skipTrivia(source, index + 1, label);
      if (source[initializer] !== '{') fail(label, `${constName} non inizializza un oggetto statico`);
      return initializer;
    }
    index += 1;
  }
  fail(label, `inizializzatore ${constName} assente`);
}

function readLocaleMap(source, open, label) {
  const fields = {};
  let index = open + 1;
  while (true) {
    index = skipTrivia(source, index, label);
    if (source[index] === '}') {
      index += 1;
      break;
    }
    const property = readStaticKey(source, index, label);
    if (!ARTICLE_SLUG_LOCALES.includes(property.key)) {
      fail(label, `locale non supportato ${property.key}`);
    }
    if (Object.prototype.hasOwnProperty.call(fields, property.key)) {
      fail(label, `locale duplicato ${property.key}`);
    }
    index = skipTrivia(source, property.end, label);
    if (source[index] !== ':') fail(label, `manca ':' dopo ${property.key}`);
    index = skipTrivia(source, index + 1, label);
    const field = readString(source, index, label);
    if (!field.value.trim()) fail(label, `slug ${property.key} vuoto`);
    fields[property.key] = field.value;
    index = skipTrivia(source, field.end, label);
    if (source[index] === ',') {
      index += 1;
      continue;
    }
    if (source[index] === '}') {
      index += 1;
      break;
    }
    fail(label, `separatore mancante dopo ${property.key}`);
  }

  const missing = ARTICLE_SLUG_LOCALES.filter((locale) => !Object.prototype.hasOwnProperty.call(fields, locale));
  if (missing.length > 0) fail(label, `locali mancanti: ${missing.join(', ')}`);
  return { fields: Object.fromEntries(ARTICLE_SLUG_LOCALES.map((locale) => [locale, fields[locale]])), end: index };
}

/**
 * Parse the generated static article-slug object without evaluating the TS
 * module. `null` is accepted only for an explicitly absent, not-yet-created
 * canton section; a present empty file or malformed map fails closed.
 */
export function parseLocalizedArticleSlugMap(source, constName, { allowMissing = false, sourceLabel = 'mappa slug' } = {}) {
  const label = `${sourceLabel}:${constName}`;
  if (source === null && allowMissing) return {};
  if (typeof source !== 'string' || source.trim() === '') fail(label, 'sorgente assente o vuota');
  if (typeof constName !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(constName)) {
    throw new TypeError('constName deve essere un identificatore TypeScript statico');
  }

  const map = {};
  const seenIds = new Set();
  let index = findInitializer(source, constName, label) + 1;
  while (true) {
    index = skipTrivia(source, index, label);
    if (source[index] === '}') break;
    const property = readStaticKey(source, index, label);
    if (seenIds.has(property.key)) fail(label, `id articolo duplicato ${property.key}`);
    seenIds.add(property.key);
    index = skipTrivia(source, property.end, label);
    if (source[index] !== ':') fail(label, `manca ':' dopo l'id ${property.key}`);
    index = skipTrivia(source, index + 1, label);
    if (source[index] !== '{') fail(label, `locale map non statica per ${property.key}`);
    const localized = readLocaleMap(source, index, `${label}:${property.key}`);
    map[property.key] = localized.fields;
    index = skipTrivia(source, localized.end, label);
    if (source[index] === ',') {
      index += 1;
      continue;
    }
    if (source[index] === '}') break;
    fail(label, `separatore mancante dopo l'id ${property.key}`);
  }
  return map;
}

export function findLocalizedSlugCollisions(slugsByArticle, { locales = ARTICLE_SLUG_LOCALES } = {}) {
  const ownersByLocale = new Map(locales.map((locale) => [locale, new Map()]));
  const collisions = [];
  for (const [articleId, localizedSlugs] of Object.entries(slugsByArticle ?? {})) {
    for (const locale of locales) {
      const slug = localizedSlugs?.[locale];
      if (typeof slug !== 'string' || slug.trim() === '') continue;
      const owners = ownersByLocale.get(locale);
      const priorOwners = owners.get(slug) ?? [];
      if (priorOwners.length > 0) {
        collisions.push({ locale, slug, articleIds: [...priorOwners, articleId] });
      }
      owners.set(slug, [...priorOwners, articleId]);
    }
  }
  return collisions;
}

/** Return the current owner of a locale slug, optionally excluding one article. */
export function findLocalizedSlugOwner(slugsByArticle, locale, slug, excludeArticleId = null) {
  if (!ARTICLE_SLUG_LOCALES.includes(locale) || typeof slug !== 'string' || slug.trim() === '') return null;
  for (const [articleId, localizedSlugs] of Object.entries(slugsByArticle ?? {})) {
    if (articleId !== excludeArticleId && localizedSlugs?.[locale] === slug) return articleId;
  }
  return null;
}

export function assertLocalizedSlugMapUnique(slugsByArticle, { sourceLabel = 'mappa slug', locales = ARTICLE_SLUG_LOCALES } = {}) {
  const collisions = findLocalizedSlugCollisions(slugsByArticle, { locales });
  if (collisions.length === 0) return true;
  const details = collisions.map(({ locale, slug, articleIds }) =>
    `${locale.toUpperCase()} "${slug}" maps to ${articleIds.map((id) => `"${id}"`).join(' e ')}`,
  );
  throw new Error(`${sourceLabel}: localized slug duplicati: ${details.join('; ')}`);
}

/** Assert a candidate against the whole current map at a serialized write boundary. */
export function assertLocalizedSlugCandidateUnique(
  source,
  constName,
  candidate,
  { candidateLocales = ARTICLE_SLUG_LOCALES, allowMissing = false, sourceLabel = 'mappa slug' } = {},
) {
  const current = parseLocalizedArticleSlugMap(source, constName, { allowMissing, sourceLabel });
  assertLocalizedSlugMapUnique(current, { sourceLabel });
  if (!candidate || typeof candidate.id !== 'string' || !candidate.id.trim()) {
    throw new Error(`${sourceLabel}: id candidato mancante per la verifica degli slug`);
  }
  if (Object.prototype.hasOwnProperty.call(current, candidate.id)) {
    throw new Error(`${sourceLabel}: id articolo duplicato "${candidate.id}"`);
  }
  for (const locale of candidateLocales) {
    if (!ARTICLE_SLUG_LOCALES.includes(locale)) {
      throw new Error(`${sourceLabel}: locale candidato non supportato "${locale}"`);
    }
    const slug = candidate.slugs?.[locale];
    if (typeof slug !== 'string' || slug.trim() === '') {
      throw new Error(`${sourceLabel}: slug ${locale} mancante prima della scrittura`);
    }
    const existing = Object.entries(current).find(([, localized]) => localized[locale] === slug);
    if (existing) {
      throw new Error(
        `${sourceLabel}: duplicate ${locale.toUpperCase()} slug "${slug}" maps to both "${existing[0]}" and "${candidate.id}"`,
      );
    }
  }
  return current;
}
