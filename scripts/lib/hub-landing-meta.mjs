/**
 * Metadata that belongs to the Italian Switzerland article-hub landing.
 *
 * The landing is served from the article shard, so the corpus-side hub
 * refresher has to carry this small correction after it fetches the existing
 * HTML. The replacement is deliberately stale-value guarded: a later full
 * site build or an editorial update remains authoritative.
 */
export const SWISS_HUB_ROOT_SEO_IT = Object.freeze({
  title: 'Articoli sulla Svizzera 2026 | Frontaliere Ticino',
  description: 'Notizie, analisi e guide sulla Svizzera per frontalieri: tasse, lavoro, costo della vita e aggiornamenti cantonali.',
  ogDescription: 'Notizie, analisi e guide sulla Svizzera per frontalieri: tasse, lavoro, costo della vita e aggiornamenti cantonali.',
});

const STALE_SWISS_HUB_ROOT_SEO_IT = Object.freeze({
  title: 'Articoli Svizzera | Frontaliere Ticino',
  description: 'Informazioni utili per frontalieri Svizzera-Italia: articoli svizzera.',
  ogDescription: 'Informazioni utili per frontalieri: articoli svizzera.',
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const HEAD_RAW_TEXT_TAGS = ['script', 'style', 'textarea', 'title'];

function findTagEnd(html, start) {
  let quote = '';
  for (let i = start + 1; i < html.length; i++) {
    const char = html[i];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return i;
    }
  }
  return -1;
}

function readTag(html, start) {
  if (html[start] !== '<') return null;
  let i = start + 1;
  const closing = html[i] === '/';
  if (closing) i++;
  const nameStart = i;
  while (i < html.length && /[A-Za-z0-9:_-]/.test(html[i])) i++;
  if (i === nameStart) return null;
  const end = findTagEnd(html, start);
  if (end < 0) return null;
  const boundary = html[i] ?? '';
  if (boundary && !/[\s/>]/.test(boundary)) return null;
  let beforeEnd = end - 1;
  while (beforeEnd >= i && /\s/.test(html[beforeEnd])) beforeEnd--;
  return {
    closing,
    end,
    name: html.slice(nameStart, i).toLowerCase(),
    selfClosing: !closing && html[beforeEnd] === '/',
  };
}

function skipComment(html, start) {
  const end = html.indexOf('-->', start + 4);
  return end < 0 ? -1 : end + 3;
}

function skipRawTextElement(html, afterOpening, name) {
  const closing = new RegExp(`</${escapeRegExp(name)}\\s*>`, 'ig');
  closing.lastIndex = afterOpening;
  const match = closing.exec(html);
  return match ? match.index + match[0].length : -1;
}

function skipTemplateElement(html, afterOpening) {
  let depth = 1;
  let cursor = afterOpening;
  while (cursor < html.length) {
    const start = html.indexOf('<', cursor);
    if (start < 0) return -1;
    if (html.startsWith('<!--', start)) {
      const afterComment = skipComment(html, start);
      if (afterComment < 0) return -1;
      cursor = afterComment;
      continue;
    }
    const tag = readTag(html, start);
    if (!tag) {
      cursor = start + 1;
      continue;
    }
    if (tag.name === 'template') {
      if (tag.closing) {
        depth--;
        if (depth === 0) return tag.end + 1;
      } else if (!tag.selfClosing) {
        depth++;
      }
    } else if (!tag.closing && !tag.selfClosing && HEAD_RAW_TEXT_TAGS.includes(tag.name)) {
      const afterRawText = skipRawTextElement(html, tag.end + 1, tag.name);
      if (afterRawText < 0) return -1;
      cursor = afterRawText;
      continue;
    }
    cursor = tag.end + 1;
  }
  return -1;
}

function replaceActiveHeadTitle(html, staleValue, nextValue) {
  const head = /<head\b[^>]*>/i.exec(html);
  if (!head) return html;
  const headStart = head.index + head[0].length;
  const rest = html.slice(headStart);
  const closeAt = rest.search(/<\/head\s*>/i);
  const headEnd = headStart + (closeAt < 0 ? rest.length : closeAt);
  let cursor = headStart;
  while (cursor < headEnd) {
    const start = html.indexOf('<', cursor);
    if (start < 0 || start >= headEnd) break;
    if (html.startsWith('<!--', start)) {
      const afterComment = skipComment(html, start);
      if (afterComment < 0) break;
      cursor = afterComment;
      continue;
    }
    const tag = readTag(html, start);
    if (!tag || tag.end >= headEnd) {
      cursor = start + 1;
      continue;
    }
    if (tag.name === 'template' && !tag.closing && !tag.selfClosing) {
      const afterTemplate = skipTemplateElement(html, tag.end + 1);
      if (afterTemplate < 0) break;
      cursor = afterTemplate;
      continue;
    }
    if (tag.name === 'title' && !tag.closing) {
      const close = /<\/title\s*>/i.exec(html.slice(tag.end + 1, headEnd));
      if (!close) break;
      const contentStart = tag.end + 1;
      const contentEnd = contentStart + close.index;
      if (html.slice(contentStart, contentEnd) === staleValue) return `${html.slice(0, contentStart)}${nextValue}${html.slice(contentEnd)}`;
      return html;
    }
    if (!tag.closing && !tag.selfClosing && HEAD_RAW_TEXT_TAGS.includes(tag.name)) {
      const afterRawText = skipRawTextElement(html, tag.end + 1, tag.name);
      if (afterRawText < 0 || afterRawText > headEnd) break;
      cursor = afterRawText;
      continue;
    }
    cursor = tag.end + 1;
  }
  return html;
}

function replaceMetaContent(html, attribute, attributeValue, staleValue, nextValue) {
  const identity = new RegExp(
    `\\b${escapeRegExp(attribute)}\\s*=\\s*(["'])${escapeRegExp(attributeValue)}\\1`,
    'i',
  );
  const content = /\bcontent\s*=\s*(['"])(.*?)\1/i;
  return html.replace(/<meta\b[^>]*>/gi, (tag) => {
    if (!identity.test(tag)) return tag;
    const match = content.exec(tag);
    if (!match || match[2] !== staleValue) return tag;
    const before = tag.slice(0, match.index);
    const after = tag.slice(match.index + match[0].length);
    return `${before}${match[0].slice(0, match[0].indexOf(match[2]))}${nextValue}${match[1]}${after}`;
  });
}

/**
 * Upgrade the stale generic metadata left on the Italian Switzerland landing.
 * Other sections/locales and already-curated values pass through unchanged.
 */
export function patchHubLandingMetadata(html, section, locale) {
  if (section !== 'svizzera' || locale !== 'it') return html;

  let out = replaceActiveHeadTitle(
    String(html),
    STALE_SWISS_HUB_ROOT_SEO_IT.title,
    SWISS_HUB_ROOT_SEO_IT.title,
  );
  out = replaceMetaContent(
    out,
    'name',
    'description',
    STALE_SWISS_HUB_ROOT_SEO_IT.description,
    SWISS_HUB_ROOT_SEO_IT.description,
  );
  out = replaceMetaContent(
    out,
    'property',
    'og:title',
    STALE_SWISS_HUB_ROOT_SEO_IT.title,
    SWISS_HUB_ROOT_SEO_IT.title,
  );
  out = replaceMetaContent(
    out,
    'property',
    'og:description',
    STALE_SWISS_HUB_ROOT_SEO_IT.ogDescription,
    SWISS_HUB_ROOT_SEO_IT.ogDescription,
  );
  return out;
}
