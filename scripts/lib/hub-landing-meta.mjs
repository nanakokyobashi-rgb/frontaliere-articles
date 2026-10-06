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

function isHtmlWhitespace(char) {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
}

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

function isSelfClosingStartTag(html, nameEnd, end) {
  let i = nameEnd;
  while (i < end) {
    while (i < end && isHtmlWhitespace(html[i])) i++;
    if (i >= end) return false;
    if (html[i] === '/') {
      return i + 1 === end;
    }

    while (
      i < end &&
      !isHtmlWhitespace(html[i]) &&
      html[i] !== '=' &&
      html[i] !== '/' &&
      html[i] !== '>'
    ) i++;
    if (html[i] !== '=') continue;

    i++;
    while (i < end && isHtmlWhitespace(html[i])) i++;
    if (i >= end) return false;
    const quote = html[i];
    if (quote === '"' || quote === "'") {
      i++;
      while (i < end && html[i] !== quote) i++;
      if (i >= end) return false;
      i++;
      continue;
    }
    // A slash is data in HTML's unquoted attribute-value state. It is a
    // self-closing flag only after that value has ended at whitespace.
    while (i < end && !isHtmlWhitespace(html[i]) && html[i] !== '>') i++;
  }
  return false;
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
  return {
    closing,
    end,
    name: html.slice(nameStart, i).toLowerCase(),
    selfClosing: !closing && isSelfClosingStartTag(html, i, end),
  };
}

function skipComment(html, start) {
  const end = html.indexOf('-->', start + 4);
  return end < 0 ? -1 : end + 3;
}

function findRawTextClose(html, afterOpening, name) {
  const closing = new RegExp(`</${escapeRegExp(name)}\\s*>`, 'ig');
  closing.lastIndex = afterOpening;
  const match = closing.exec(html);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

function skipRawTextElement(html, afterOpening, name) {
  return findRawTextClose(html, afterOpening, name)?.end ?? -1;
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

function findActiveHeadContent(html) {
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf('<', cursor);
    if (start < 0) return null;
    if (html.startsWith('<!--', start)) {
      const afterComment = skipComment(html, start);
      if (afterComment < 0) return null;
      cursor = afterComment;
      continue;
    }
    const tag = readTag(html, start);
    if (!tag) {
      cursor = start + 1;
      continue;
    }
    if (!tag.closing && !tag.selfClosing && tag.name === 'template') {
      const afterTemplate = skipTemplateElement(html, tag.end + 1);
      if (afterTemplate < 0) return null;
      cursor = afterTemplate;
      continue;
    }
    if (!tag.closing && !tag.selfClosing && HEAD_RAW_TEXT_TAGS.includes(tag.name)) {
      const afterRawText = skipRawTextElement(html, tag.end + 1, tag.name);
      if (afterRawText < 0) return null;
      cursor = afterRawText;
      continue;
    }
    if (!tag.closing && tag.name === 'head') {
      const contentStart = tag.end + 1;
      let inside = contentStart;
      while (inside < html.length) {
        const nestedStart = html.indexOf('<', inside);
        if (nestedStart < 0) return null;
        if (html.startsWith('<!--', nestedStart)) {
          const afterComment = skipComment(html, nestedStart);
          if (afterComment < 0) return null;
          inside = afterComment;
          continue;
        }
        const nested = readTag(html, nestedStart);
        if (!nested) {
          inside = nestedStart + 1;
          continue;
        }
        if (nested.closing && nested.name === 'head') {
          return { start: contentStart, end: nestedStart };
        }
        if (!nested.closing && !nested.selfClosing && nested.name === 'template') {
          const afterTemplate = skipTemplateElement(html, nested.end + 1);
          if (afterTemplate < 0) return null;
          inside = afterTemplate;
          continue;
        }
        if (!nested.closing && !nested.selfClosing && HEAD_RAW_TEXT_TAGS.includes(nested.name)) {
          const afterRawText = skipRawTextElement(html, nested.end + 1, nested.name);
          if (afterRawText < 0) return null;
          inside = afterRawText;
          continue;
        }
        inside = nested.end + 1;
      }
      return null;
    }
    cursor = tag.end + 1;
  }
  return null;
}

const HEAD_META_PATCHES = Object.freeze([
  {
    attribute: 'name',
    attributeValue: 'description',
    staleValue: STALE_SWISS_HUB_ROOT_SEO_IT.description,
    nextValue: SWISS_HUB_ROOT_SEO_IT.description,
  },
  {
    attribute: 'property',
    attributeValue: 'og:title',
    staleValue: STALE_SWISS_HUB_ROOT_SEO_IT.title,
    nextValue: SWISS_HUB_ROOT_SEO_IT.title,
  },
  {
    attribute: 'property',
    attributeValue: 'og:description',
    staleValue: STALE_SWISS_HUB_ROOT_SEO_IT.ogDescription,
    nextValue: SWISS_HUB_ROOT_SEO_IT.ogDescription,
  },
]);

function patchMetaTag(tag) {
  const content = /\bcontent\s*=\s*(['"])(.*?)\1/i;
  for (const patch of HEAD_META_PATCHES) {
    const identity = new RegExp(
      `\\b${escapeRegExp(patch.attribute)}\\s*=\\s*(["'])${escapeRegExp(patch.attributeValue)}\\1`,
      'i',
    );
    if (!identity.test(tag)) continue;
    const match = content.exec(tag);
    if (!match || match[2] !== patch.staleValue) return tag;
    const valueOffset = match[0].indexOf(match[2]);
    return `${tag.slice(0, match.index)}${match[0].slice(0, valueOffset)}${patch.nextValue}${match[1]}${tag.slice(match.index + match[0].length)}`;
  }
  return tag;
}

function patchActiveHeadMetadata(html) {
  const source = String(html);
  const head = findActiveHeadContent(source);
  if (!head) return source;

  const replacements = [];
  let titleSeen = false;
  let cursor = head.start;
  while (cursor < head.end) {
    const start = source.indexOf('<', cursor);
    if (start < 0 || start >= head.end) break;
    if (source.startsWith('<!--', start)) {
      const afterComment = skipComment(source, start);
      if (afterComment < 0) break;
      cursor = afterComment;
      continue;
    }
    const tag = readTag(source, start);
    if (!tag || tag.end >= head.end) {
      cursor = start + 1;
      continue;
    }
    if (tag.closing) {
      cursor = tag.end + 1;
      continue;
    }
    if (tag.name === 'template' && !tag.selfClosing) {
      const afterTemplate = skipTemplateElement(source, tag.end + 1);
      if (afterTemplate < 0 || afterTemplate > head.end) break;
      cursor = afterTemplate;
      continue;
    }
    if (tag.name === 'title') {
      const close = findRawTextClose(source, tag.end + 1, 'title');
      if (!close || close.start >= head.end) break;
      const contentStart = tag.end + 1;
      if (!titleSeen && source.slice(contentStart, close.start) === STALE_SWISS_HUB_ROOT_SEO_IT.title) {
        replacements.push({ start: contentStart, end: close.start, value: SWISS_HUB_ROOT_SEO_IT.title });
      }
      titleSeen = true;
      cursor = close.end;
      continue;
    }
    if (tag.name === 'meta') {
      const original = source.slice(start, tag.end + 1);
      const patched = patchMetaTag(original);
      if (patched !== original) replacements.push({ start, end: tag.end + 1, value: patched });
      cursor = tag.end + 1;
      continue;
    }
    if (!tag.selfClosing && HEAD_RAW_TEXT_TAGS.includes(tag.name)) {
      const afterRawText = skipRawTextElement(source, tag.end + 1, tag.name);
      if (afterRawText < 0 || afterRawText > head.end) break;
      cursor = afterRawText;
      continue;
    }
    cursor = tag.end + 1;
  }

  let out = source;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const replacement = replacements[i];
    out = `${out.slice(0, replacement.start)}${replacement.value}${out.slice(replacement.end)}`;
  }
  return out;
}

/**
 * Upgrade the stale generic metadata left on the Italian Switzerland landing.
 * Other sections/locales and already-curated values pass through unchanged.
 */
export function patchHubLandingMetadata(html, section, locale) {
  if (section !== 'svizzera' || locale !== 'it') return html;
  return patchActiveHeadMetadata(String(html));
}
