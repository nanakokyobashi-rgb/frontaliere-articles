export const GENERIC_IMAGE_PATH = '/og-image.png';
const SITE_ORIGIN = 'https://frontaliereticino.ch';

// This file is an `identical` loop twin and must remain dependency-free from
// corpus-only modules. Keep this small real-tag walker here so the site copy
// gets the same fail-closed og:image contract without importing the corpus
// generator scanner.
const RAW_TEXT_TAGS = new Set([
  'script', 'style', 'textarea', 'title', 'noscript', 'iframe', 'xmp',
  'noembed', 'noframes',
]);

function tagEndOutsideQuotes(source, start) {
  let quote = null;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '>') return index + 1;
  }
  return null;
}

function parseTagAt(source, start) {
  const end = tagEndOutsideQuotes(source, start + 1);
  if (end === null) return { malformed: true };
  const markup = source.slice(start, end);
  const match = /^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)\b/u.exec(markup);
  if (!match) return { end };
  const closing = Boolean(match[1]);
  const name = match[2].toLowerCase();
  const attrs = [];
  let cursor = match[0].length;
  while (cursor < markup.length - 1) {
    while (cursor < markup.length - 1 && /[\s/]/u.test(markup[cursor])) cursor += 1;
    if (cursor >= markup.length - 1) break;
    const nameStart = cursor;
    while (cursor < markup.length - 1 && !/[\s=/>]/u.test(markup[cursor])) cursor += 1;
    if (cursor === nameStart) {
      cursor += 1;
      continue;
    }
    const attribute = markup.slice(nameStart, cursor).toLowerCase();
    while (cursor < markup.length - 1 && /\s/u.test(markup[cursor])) cursor += 1;
    if (markup[cursor] !== '=') {
      attrs.push([attribute, '']);
      continue;
    }
    cursor += 1;
    while (cursor < markup.length - 1 && /\s/u.test(markup[cursor])) cursor += 1;
    const quote = markup[cursor] === '"' || markup[cursor] === "'" ? markup[cursor] : null;
    if (quote) {
      cursor += 1;
      const valueStart = cursor;
      while (cursor < markup.length - 1 && markup[cursor] !== quote) cursor += 1;
      if (cursor >= markup.length - 1) return { malformed: true };
      attrs.push([attribute, markup.slice(valueStart, cursor)]);
      cursor += 1;
      continue;
    }
    const valueStart = cursor;
    while (cursor < markup.length - 1 && !/[\s>]/u.test(markup[cursor])) cursor += 1;
    attrs.push([attribute, markup.slice(valueStart, cursor)]);
  }
  return { end, tag: { start, end, closing, name, attrs } };
}

function nextTagStatus(source, from) {
  let start = source.indexOf('<', from);
  while (start !== -1) {
    if (source.startsWith('<!--', start)) {
      const commentEnd = source.indexOf('-->', start + 4);
      if (commentEnd < 0) return { status: 'malformed' };
      start = source.indexOf('<', commentEnd + 3);
      continue;
    }
    const parsed = parseTagAt(source, start);
    if (parsed.malformed) return { status: 'malformed' };
    if (parsed.tag) return { status: 'tag', tag: parsed.tag };
    start = source.indexOf('<', parsed.end);
  }
  return { status: 'eof' };
}

function rawTextClose(source, from, name) {
  const close = new RegExp(`</${name}\\s*>`, 'ig');
  close.lastIndex = from;
  const match = close.exec(source);
  return match ? { start: match.index, end: close.lastIndex } : null;
}

function inactiveElementClose(source, from, name) {
  let depth = 1;
  let cursor = from;
  while (true) {
    const result = nextTagStatus(source, cursor);
    if (result.status !== 'tag') return null;
    const { tag } = result;
    cursor = tag.end;
    if (!tag.closing && RAW_TEXT_TAGS.has(tag.name)) {
      const close = rawTextClose(source, tag.end, tag.name);
      if (!close) return null;
      cursor = close.end;
      continue;
    }
    if (tag.closing && tag.name === name) {
      depth -= 1;
      if (depth === 0) return tag;
      continue;
    }
    if (!tag.closing && tag.name === name) depth += 1;
  }
}

function extractRealOgImage(source) {
  let cursor = 0;
  let found;
  while (true) {
    const result = nextTagStatus(source, cursor);
    if (result.status === 'malformed') return null;
    if (result.status === 'eof') return found ?? null;
    const { tag } = result;
    cursor = tag.end;
    if (tag.closing) continue;
    if (RAW_TEXT_TAGS.has(tag.name)) {
      const close = rawTextClose(source, tag.end, tag.name);
      if (!close) return null;
      cursor = close.end;
      continue;
    }
    if (tag.name === 'template') {
      const close = inactiveElementClose(source, tag.end, 'template');
      if (!close) return null;
      cursor = close.end;
      continue;
    }
    if (tag.name !== 'meta' || found !== undefined) continue;
    const attrs = Object.fromEntries(tag.attrs);
    if (String(attrs.property || '').toLowerCase() === 'og:image') found = attrs.content || null;
  }
}

export function normalizeImagePath(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw, SITE_ORIGIN);
    if (url.origin !== SITE_ORIGIN) return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

export function declaredImageIsOwn(value) {
  const normalized = normalizeImagePath(value);
  return Boolean(normalized && normalized.split(/[?#]/, 1)[0] !== GENERIC_IMAGE_PATH);
}

export function extractOgImage(html) {
  return extractRealOgImage(String(html ?? ''));
}

export function isGenericOgImage(html) {
  const normalized = normalizeImagePath(extractOgImage(html));
  return Boolean(normalized && normalized.split(/[?#]/, 1)[0] === GENERIC_IMAGE_PATH);
}

export function filterEntriesByImagePostcondition({ entries = [], declaredImages = {}, htmlByPath = {} } = {}) {
  const keptEntries = [];
  const excludedArticles = [];
  let excludedPages = 0;

  for (const entry of entries) {
    const declaredImage = declaredImages[entry.articleId] ?? declaredImages.get?.(entry.articleId) ?? null;
    const paths = [
      ...Object.values(entry.paths || {}),
      ...Object.values(entry.flatPaths || {}),
    ].filter(Boolean);
    const fallbackPaths = [...new Set(paths.filter((rel) => isGenericOgImage(htmlByPath[rel])))];
    if (!declaredImageIsOwn(declaredImage) || fallbackPaths.length === 0) {
      keptEntries.push(entry);
      continue;
    }
    excludedPages += paths.length;
    excludedArticles.push({ articleId: entry.articleId, declaredImage, fallbackPaths, paths });
  }

  return {
    entries: keptEntries,
    excludedArticles,
    excludedPages,
    firstExcludedArticleIds: excludedArticles.slice(0, 10).map((item) => item.articleId),
    firstFallbackPaths: excludedArticles.flatMap((item) => item.fallbackPaths).slice(0, 10),
  };
}
