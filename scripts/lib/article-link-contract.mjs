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
    if (char === '\\' && source[index + 1] !== ']') {
      index += 1;
      continue;
    }
    if (char === '[') depth += 1;
    else if (char === ']') {
      if (depth === 0) return index;
      depth -= 1;
    } else if (char === '\n') {
      const nextLineEnd = source.indexOf('\n', index + 1);
      const nextLine = source.slice(index + 1, nextLineEnd < 0 ? source.length : nextLineEnd);
      if (!nextLine.trim()) return -1;
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
      if (char === '>' || char === ')') break;
      if (char === '\n') return null;
      cursor += 1;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') {
      if (depth === 0) break;
      // The site renderer stops at the first `)`, even inside a parenthesized
      // destination. Keep that same boundary so the writer can strip the href
      // the browser would actually receive.
      break;
    } else if (/\s/.test(char) && depth === 0) {
      break;
    }
    cursor += 1;
  }
  let targetEnd = cursor;
  const angleClosed = angle && source[cursor] === '>';
  if (targetEnd === targetStart && !angle) return null;
  let target = angle && !angleClosed
    ? `<${source.slice(targetStart, targetEnd)}`
    : source.slice(targetStart, targetEnd);
  if (angleClosed) cursor += 1;
  const targetSuffixStart = cursor;

  const whitespaceStart = cursor;
  while (/\s/.test(source[cursor] || '') && cursor < source.length) cursor += 1;
  let hasTitle = false;
  let unsupportedSuffix = false;
  if (cursor > whitespaceStart && ['"', "'", '('].includes(source[cursor])) {
    hasTitle = true;
    cursor = parseLinkTitle(source, cursor);
    if (cursor < 0) return null;
    while (/\s/.test(source[cursor] || '') && cursor < source.length) cursor += 1;
  } else if (cursor > whitespaceStart && source[cursor] !== ')') {
    // The site renderer captures every character through `)` as href text.
    // Consume unquoted suffixes so the writer and gate can strip this shape.
    const close = source.indexOf(')', cursor);
    if (close < 0) return null;
    targetEnd = close;
    target = source.slice(targetStart, targetEnd);
    cursor = close;
    unsupportedSuffix = true;
  } else if (angleClosed && source[cursor] !== ')') {
    // A suffix attached directly after `>` is still captured as href text by
    // the site renderer. Keep the malformed occurrence visible to the gate.
    const close = source.indexOf(')', cursor);
    if (close < 0) return null;
    targetEnd = close;
    target = source.slice(targetStart, targetEnd);
    cursor = close;
    unsupportedSuffix = true;
  }
  if (source[cursor] !== ')') return null;

  return {
    start,
    end: cursor + 1,
    label: source.slice(start + 1, labelEnd),
    labelEnd,
    target,
    angle,
    targetSyntaxStart: targetStart - (angle ? 1 : 0),
    targetStart,
    targetEnd,
    targetSuffixStart,
    hasTitle,
    unsupportedSuffix,
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

// The static article renderer applies its inline-link regex before formatting
// code spans and does not distinguish image syntax. Inspect those same source
// forms here, including comments and escaped prefixes, so hidden links cannot
// bypass the writer and publication gate.
function articleLinks(source) {
  const links = [];
  for (let index = 0; index < source.length;) {
    if (source[index] === '<') {
      const anchor = parseHtmlAnchor(source, index);
      if (anchor) {
        if (anchor.hasHref) links.push(anchor);
        index = anchor.end;
        continue;
      }
    }
    if (source[index] !== '[') {
      index += 1;
      continue;
    }
    const link = parseInlineLink(source, index);
    if (!link) {
      index += 1;
      continue;
    }
    link.nestedLinks = articleLinks(link.label);
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
  const sourceTarget = String(rawTarget ?? '');
  if (/[\u0000-\u001f\u007f\\]/u.test(sourceTarget)) return null;
  const target = sourceTarget.trim();
  if (!target) return null;
  // The static article renderer stops at the first literal `)` in a link.
  // Percent-encoded parentheses remain valid and do not trigger truncation.
  if (/[()]/u.test(target)) return null;

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
  if (/^(?:\/(?!\/)|#)/.test(target)) {
    return /[\\\u0000-\u001f\u007f]/.test(target) ? null : target;
  }

  return null;
}

function canonicalArticleLinkOccurrenceTarget(link, locale) {
  // The static renderer treats angle delimiters, titles, and unquoted suffixes
  // as part of href text. Remove forms the writer cannot canonicalize safely.
  if (link.hasTitle || link.unsupportedSuffix || (link.angle && /\s/u.test(link.target))) return null;
  const canonical = canonicalArticleLinkTarget(link.target, locale);
  // The site renderer supports nav: only in Markdown links, never in literal
  // HTML anchors. Removing such hrefs keeps the gate and writer consistent.
  return link.htmlAnchor && canonical?.startsWith('nav:') ? null : canonical;
}

/**
 * Normalize generated article Markdown and inline anchors before persistence.
 * Unknown or malformed targets deliberately lose their clickable href.
 */
export function sanitizeArticleMarkdownLinks(text, locale = 'it') {
  const source = String(text ?? '');
  let output = '';
  let copiedThrough = 0;
  for (const link of articleLinks(source)) {
    const canonical = canonicalArticleLinkOccurrenceTarget(link, locale);
    const duplicateAnchorHref = link.htmlAnchor && link.hrefAttributes.length > 1;
    const normalizedLabel = link.htmlAnchor || link.nestedLinks.length === 0
      ? link.label
      : sanitizeArticleMarkdownLinks(link.label, locale);
    if (
      canonical === link.target &&
      !link.angle &&
      !duplicateAnchorHref &&
      normalizedLabel === link.label
    ) continue;

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
    } else if (canonical === null) {
      output += source.slice(copiedThrough, link.start) + normalizedLabel;
    } else {
      output += source.slice(copiedThrough, link.start)
        + '[' + normalizedLabel + ']'
        + source.slice(link.labelEnd + 1, link.targetSyntaxStart)
        + canonical
        + source.slice(link.targetSuffixStart, link.end);
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
export function findNonCanonicalArticleLinks(source, locale = 'it', baseIndex = 0) {
  const offenders = [];
  const input = String(source ?? '');
  for (const link of articleLinks(input)) {
    const canonical = canonicalArticleLinkOccurrenceTarget(link, locale);
    const duplicateAnchorHref = link.htmlAnchor && link.hrefAttributes.length > 1;
    if (
      canonical !== link.target ||
      link.angle ||
      duplicateAnchorHref
    ) {
      offenders.push({
        label: link.label,
        target: link.target,
        replacement: canonical,
        index: baseIndex + link.start,
        htmlAnchor: Boolean(link.htmlAnchor),
      });
    }
    if (!link.htmlAnchor && link.nestedLinks.length > 0) {
      offenders.push(...findNonCanonicalArticleLinks(link.label, locale, baseIndex + link.start + 1));
    }
  }
  return offenders.sort((a, b) => a.index - b.index);
}
