/**
 * Contract for links stored in article Markdown.
 *
 * Article bodies are data, but they are later rendered as HTML by the site.
 * A bare Markdown target therefore is not harmless prose: the browser resolves
 * it against the article URL and turns it into a crawlable same-origin route.
 * Keep the small legacy repair table here so the writer and the corpus gate
 * share one definition of what can be repaired without guessing.
 */

export const VALID_NAV_ACTIONS = new Set([
  'calculator', 'exchange', 'health', 'cost-of-living', 'pension', 'pillar3',
  'payslip', 'tax-return', 'residency', 'ristorni', 'unemployment', 'jobs', 'companies', 'banks',
  'first-day', 'permits', 'border', 'calendar', 'whatif', 'shopping', 'transport',
  'salary-compare', 'traffic-history', 'job-board', 'jobs-observatory', 'search-jobs',
  'border-map', 'municipalities', 'car-transfer', 'car-cost', 'permit-compare', 'renovation',
  'mobile', 'ral', 'parental-leave', 'nursery', 'living-ch', 'living-it', 'livability',
]);

const LEGACY_TARGET_TO_NAV = new Map([
  ['calculator', 'calculator'],
  ['calculator:cost-of-living', 'cost-of-living'],
  ['cost-of-living', 'cost-of-living'],
  ['border-map', 'border-map'],
  ['transport', 'transport'],
  ['salary-compare', 'salary-compare'],
  ['health', 'health'],
  ['health:companies', 'health'],
  ['municipalities:list', 'municipalities'],
  ['rechner: lebenshaltungskosten', 'cost-of-living'],
  ['gesundheit:unternehmen', 'health'],
  ['nav : calculatrice', 'calculator'],
  ['nav : permis', 'permits'],
  ['nav : déclaration de revenus', 'tax-return'],
  ['nav : pilier3', 'pillar3'],
]);

const LOCALE_CANONICAL_TARGETS = {
  it: new Map([
    ['statistiche/', '/statistiche/'],
    ['calcola-stipendio/', '/calcola-stipendio/'],
  ]),
  en: new Map([
    ['statistics/', '/en/statistics/'],
    ['calculate-salary/', '/en/calculate-salary/'],
  ]),
  de: new Map([
    ['Statistik/', '/de/statistiken/'],
    ['Gehaltsabrechnung/', '/de/gehalt-berechnen/'],
  ]),
  fr: new Map([
    ['statistiques/', '/fr/statistiques/'],
    ['calculez-salaire/', '/fr/calculer-salaire/'],
  ]),
};

function closingBracket(source, start) {
  let depth = 0;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '[') depth += 1;
    else if (char === ']') {
      if (depth === 0) return index;
      depth -= 1;
    } else if (char === '\n') {
      return -1;
    }
  }
  return -1;
}

function parseLinkTitle(source, start) {
  const opener = source[start];
  const closer = opener === '(' ? ')' : opener;
  let depth = opener === '(' ? 1 : 0;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (opener === '(' && char === '(') depth += 1;
    else if (char === closer) {
      if (opener !== '(' || --depth === 0) return index + 1;
    } else if (char === '\n' && opener !== '(') {
      return -1;
    }
  }
  return -1;
}

function parseInlineLink(source, start) {
  const labelEnd = closingBracket(source, start);
  if (labelEnd < 0 || source[labelEnd + 1] !== '(') return null;

  let cursor = labelEnd + 2;
  while (/\s/.test(source[cursor] || '') && cursor < source.length) cursor += 1;
  const angle = source[cursor] === '<';
  if (angle) cursor += 1;
  const targetStart = cursor;
  let depth = 0;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === '\\') {
      cursor += cursor + 1 < source.length ? 2 : 1;
      continue;
    }
    if (angle) {
      if (char === '>') break;
      if (char === '\n') return null;
      cursor += 1;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') {
      if (depth === 0) break;
      depth -= 1;
    } else if (/\s/.test(char) && depth === 0) {
      break;
    }
    cursor += 1;
  }
  const targetEnd = cursor;
  if (targetEnd === targetStart || (angle && source[cursor] !== '>')) return null;
  const target = source.slice(targetStart, targetEnd);
  if (angle) cursor += 1;
  const targetSuffixStart = cursor;

  const whitespaceStart = cursor;
  while (/\s/.test(source[cursor] || '') && cursor < source.length) cursor += 1;
  if (cursor > whitespaceStart && ['"', "'", '('].includes(source[cursor])) {
    cursor = parseLinkTitle(source, cursor);
    if (cursor < 0) return null;
    while (/\s/.test(source[cursor] || '') && cursor < source.length) cursor += 1;
  }
  if (source[cursor] !== ')') return null;

  return {
    start,
    end: cursor + 1,
    label: source.slice(start + 1, labelEnd),
    target,
    angle,
    targetSyntaxStart: targetStart - (angle ? 1 : 0),
    targetStart,
    targetEnd,
    targetSuffixStart,
  };
}

function parseHtmlAnchor(source, start) {
  if (
    source[start] !== '<' ||
    source[start + 1]?.toLowerCase() !== 'a' ||
    !/[\s/>]/u.test(source[start + 2] || '')
  ) return null;

  const hrefAttributes = [];
  let cursor = start + 2;
  while (cursor < source.length) {
    const attributeRemovalStart = cursor;
    while (/\s/u.test(source[cursor] || '')) cursor += 1;
    if (source[cursor] === '>') {
      const firstHref = hrefAttributes[0];
      return {
        start,
        end: cursor + 1,
        htmlAnchor: true,
        hasHref: Boolean(firstHref),
        label: '<a href>',
        ...(firstHref ? {
          target: firstHref.target,
          targetStart: firstHref.targetStart,
          targetEnd: firstHref.targetEnd,
          hrefAttributes,
        } : {}),
      };
    }
    if (source[cursor] === '/') {
      cursor += 1;
      continue;
    }

    const attributeStart = cursor;
    while (cursor < source.length && !/[\s=/>]/u.test(source[cursor])) cursor += 1;
    if (cursor === attributeStart) {
      cursor += 1;
      continue;
    }

    const attributeName = source.slice(attributeStart, cursor).toLowerCase();
    const nameEnd = cursor;
    while (/\s/u.test(source[cursor] || '')) cursor += 1;
    let targetStart = nameEnd;
    let targetEnd = nameEnd;
    let attributeEnd = nameEnd;
    if (source[cursor] === '=') {
      cursor += 1;
      while (/\s/u.test(source[cursor] || '')) cursor += 1;
      const quote = source[cursor] === '"' || source[cursor] === "'" ? source[cursor] : '';
      if (quote) {
        targetStart = cursor + 1;
        const quoteEnd = source.indexOf(quote, targetStart);
        if (quoteEnd < 0) return null;
        targetEnd = quoteEnd;
        cursor = quoteEnd + 1;
      } else {
        targetStart = cursor;
        while (cursor < source.length && !/[\s>]/u.test(source[cursor])) cursor += 1;
        targetEnd = cursor;
      }
      attributeEnd = cursor;
    } else {
      cursor = nameEnd;
    }

    if (attributeName === 'href') {
      hrefAttributes.push({
        target: source.slice(targetStart, targetEnd),
        targetStart,
        targetEnd,
        attributeStart,
        attributeRemovalStart,
        attributeEnd,
      });
    }
  }
  return null;
}

function fenceEnd(source, start) {
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  if (!/^[ \t]{0,3}$/.test(source.slice(lineStart, start))) return -1;
  const lineEnd = source.indexOf('\n', start);
  const opening = source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd);
  const match = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(opening);
  if (!match) return -1;
  const marker = match[1][0];
  const minimum = match[1].length;
  let cursor = lineEnd < 0 ? source.length : lineEnd + 1;
  while (cursor < source.length) {
    const end = source.indexOf('\n', cursor);
    const line = source.slice(cursor, end < 0 ? source.length : end);
    const candidate = line.replace(/^[ \t]{0,3}/, '');
    let run = 0;
    while (candidate[run] === marker) run += 1;
    if (run >= minimum && candidate.slice(run).trim() === '') {
      return end < 0 ? source.length : end + 1;
    }
    if (end < 0) break;
    cursor = end + 1;
  }
  return source.length;
}

function codeSpanEnd(source, start) {
  let run = 1;
  while (source[start + run] === '`') run += 1;
  let cursor = start + run;
  while (cursor < source.length) {
    const next = source.indexOf('`', cursor);
    if (next < 0) return -1;
    let closingRun = 1;
    while (source[next + closingRun] === '`') closingRun += 1;
    if (closingRun === run) return next + closingRun;
    cursor = next + closingRun;
  }
  return -1;
}

function indentedCodeBlockEnd(source, start) {
  if (start > 0 && source[start - 1] !== '\n') return -1;
  const firstEnd = source.indexOf('\n', start);
  const firstLine = source.slice(start, firstEnd < 0 ? source.length : firstEnd);
  if (!firstLine.trim() || !/^(?: {4,}|\t)/.test(firstLine)) return -1;

  let cursor = firstEnd < 0 ? source.length : firstEnd + 1;
  while (cursor < source.length) {
    const lineEnd = source.indexOf('\n', cursor);
    const line = source.slice(cursor, lineEnd < 0 ? source.length : lineEnd);
    if (line.trim() && !/^(?: {4,}|\t)/.test(line)) return cursor;
    cursor = lineEnd < 0 ? source.length : lineEnd + 1;
  }
  return source.length;
}

function referenceDefinitionAt(source, start) {
  if (start > 0 && source[start - 1] !== '\n') return null;
  const lineEnd = source.indexOf('\n', start);
  const line = source.slice(start, lineEnd < 0 ? source.length : lineEnd);
  const indent = /^ {0,3}/.exec(line)[0].length;
  if (line[indent] !== '[') return null;

  const labelEnd = line.indexOf(']', indent + 1);
  if (labelEnd < 0) return null;
  let cursor = labelEnd + 1;
  while (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1;
  if (line[cursor] !== ':') return null;
  cursor += 1;
  while (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1;

  const angled = line[cursor] === '<';
  const targetStart = angled ? cursor + 1 : cursor;
  let targetEnd;
  if (angled) {
    const close = line.indexOf('>', targetStart);
    if (close < 0) return null;
    targetEnd = close;
  } else {
    targetEnd = targetStart;
    while (targetEnd < line.length && !/[ \t]/.test(line[targetEnd])) targetEnd += 1;
  }
  if (targetEnd === targetStart) return null;

  return {
    start,
    end: lineEnd < 0 ? source.length : lineEnd + 1,
    label: line.slice(indent + 1, labelEnd),
    target: line.slice(targetStart, targetEnd),
    targetSyntaxStart: start + targetStart - (angled ? 1 : 0),
    targetStart: start + targetStart,
    targetEnd: start + targetEnd,
    angle: angled,
    targetSuffixStart: start + targetEnd + (angled ? 1 : 0),
    referenceDefinition: true,
  };
}

function articleLinks(source, { skipCode = false } = {}) {
  const links = [];
  for (let index = 0; index < source.length;) {
    if (skipCode && (index === 0 || source[index - 1] === '\n')) {
      const definition = referenceDefinitionAt(source, index);
      if (definition) {
        links.push(definition);
        index = definition.end;
        continue;
      }
      const indentedEnd = indentedCodeBlockEnd(source, index);
      if (indentedEnd > index) {
        index = indentedEnd;
        continue;
      }
    }
    if (source[index] === '\\') {
      index += index + 1 < source.length ? 2 : 1;
      continue;
    }
    if (skipCode && (source[index] === '`' || source[index] === '~')) {
      const fencedEnd = fenceEnd(source, index);
      if (fencedEnd > index) {
        index = fencedEnd;
        continue;
      }
      if (source[index] === '`') {
        const inlineEnd = codeSpanEnd(source, index);
        if (inlineEnd > index) {
          index = inlineEnd;
          continue;
        }
      }
    }
    if (source.startsWith('<!--', index)) {
      const commentEnd = source.indexOf('-->', index + 4);
      index = commentEnd < 0 ? source.length : commentEnd + 3;
      continue;
    }
    if (source[index] === '<') {
      const anchor = parseHtmlAnchor(source, index);
      if (anchor) {
        if (anchor.hasHref) links.push(anchor);
        index = anchor.end;
        continue;
      }
    }
    if (source[index] !== '[' || (index > 0 && source[index - 1] === '!')) {
      index += 1;
      continue;
    }
    const link = parseInlineLink(source, index);
    if (!link) {
      index += 1;
      continue;
    }
    links.push(link);
    index = link.end;
  }
  return links;
}

/**
 * Sanitize every Markdown string field in generated FAQ pairs before the
 * object is serialized into a TypeScript body literal.
 */
export function sanitizeArticleFaqMarkdown(faqArray, locale = 'it') {
  if (!Array.isArray(faqArray)) return faqArray;
  return faqArray.map((pair) => {
    if (!pair || typeof pair !== 'object' || Array.isArray(pair)) return pair;
    return Object.fromEntries(Object.entries(pair).map(([key, value]) => [
      key,
      typeof value === 'string' ? sanitizeArticleMarkdownLinks(value, locale) : value,
    ]));
  });
}

/**
 * Return the only safe, deterministic repair for a raw Markdown target.
 * `null` means keep the visible label but remove the link entirely.
 */
export function canonicalArticleLinkTarget(rawTarget, locale = 'it') {
  const target = String(rawTarget ?? '').trim();
  if (!target) return null;

  const legacyAction = LEGACY_TARGET_TO_NAV.get(target.toLowerCase());
  if (legacyAction) return `nav:${legacyAction}`;

  const localeTarget = LOCALE_CANONICAL_TARGETS[locale]?.get(target);
  if (localeTarget) return localeTarget;

  const navAction = /^nav:([a-z0-9-]+)$/.exec(target);
  if (navAction) return VALID_NAV_ACTIONS.has(navAction[1]) ? target : null;

  // Mail links and HTTP(S) links are supported by the article renderer.
  // Require a parseable HTTP(S) URL with a host: the renderer rejects values
  // like `https://`, which otherwise look canonical but become plain text.
  if (/^https?:\/\//i.test(target)) {
    try {
      const url = new URL(target);
      if (['http:', 'https:'].includes(url.protocol) && url.hostname) return target;
    } catch {
      return null;
    }
    return null;
  }
  // `tel:` is intentionally stripped: the site renderer does not preserve it.
  if (/^mailto:/i.test(target)) return target;

  // Root-relative and fragment links are already anchored to the public site
  // rather than to the article directory. Protocol-relative URLs are denied.
  if (/^(?:\/(?!\/)|#)/.test(target)) return target;

  return null;
}

/**
 * Normalize generated article Markdown and inline anchors before persistence.
 * Unknown or malformed targets deliberately lose their clickable href.
 */
export function sanitizeArticleMarkdownLinks(text, locale = 'it') {
  const source = String(text ?? '');
  let output = '';
  let copiedThrough = 0;
  for (const link of articleLinks(source, { skipCode: true })) {
    const canonical = canonicalArticleLinkTarget(link.target, locale);
    const duplicateAnchorHref = link.htmlAnchor && link.hrefAttributes.length > 1;
    if (canonical === link.target && !link.angle && !duplicateAnchorHref) continue;

    if (link.htmlAnchor) {
      output += source.slice(copiedThrough, link.start);
      let tagCursor = link.start;
      let insertedCanonicalHref = false;
      for (const attribute of link.hrefAttributes) {
        output += source.slice(tagCursor, attribute.attributeRemovalStart);
        if (canonical !== null && !insertedCanonicalHref) {
          output += ` href="${canonical}"`;
          insertedCanonicalHref = true;
        }
        tagCursor = attribute.attributeEnd;
      }
      output += source.slice(tagCursor, link.end);
    } else {
      output += source.slice(copiedThrough, canonical === null ? link.start : link.targetSyntaxStart);
      output += canonical === null
        ? (link.referenceDefinition ? '' : link.label)
        : canonical + source.slice(link.targetSuffixStart, link.end);
    }
    copiedThrough = link.end;
  }
  return copiedThrough === 0 ? source : output + source.slice(copiedThrough);
}

/**
 * Find links that still need the contract's repair before publication.
 * The returned index is byte-oriented enough for diagnostics on the UTF-8
 * source files and is intentionally independent of a TypeScript parser.
 */
export function findNonCanonicalArticleLinks(source, locale = 'it') {
  const offenders = [];
  const input = String(source ?? '');
  for (const link of articleLinks(input, { skipCode: true })) {
    const canonical = canonicalArticleLinkTarget(link.target, locale);
    const duplicateAnchorHref = link.htmlAnchor && link.hrefAttributes.length > 1;
    if (canonical === link.target && !link.angle && !duplicateAnchorHref) continue;
    offenders.push({
      label: link.label,
      target: link.target,
      replacement: canonical,
      index: link.start,
      htmlAnchor: Boolean(link.htmlAnchor),
    });
  }
  return offenders;
}
