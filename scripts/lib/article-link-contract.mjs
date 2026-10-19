/**
 * Contract for links stored in article Markdown.
 *
 * Article bodies are data, but they are later rendered as HTML by the site.
 * A bare Markdown target therefore is not harmless prose: the browser resolves
 * it against the article URL and turns it into a crawlable same-origin route.
 * Keep the small legacy repair table here so the writer and the corpus gate
 * share one definition of what can be repaired without guessing.
 */
import { localizeNavLinkLabels } from './nav-link-labels.mjs';

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

const FAQ_MARKDOWN_KEYS = new Set(['q', 'a']);

function fencedBlankLineStarts(source) {
  // The static renderer joins every line in a fenced block before applying
  // its inline-link regex, so a blank source line there does not break a label.
  const starts = new Set();
  let fence = null;
  let lineStart = 0;
  while (lineStart <= source.length) {
    const lineEnd = source.indexOf('\n', lineStart);
    const line = source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd);
    const trimmed = line.trim();
    if (fence) {
      if (!trimmed) starts.add(lineStart);
      const closing = /^(\x60{3,}|~{3,})\s*$/u.exec(trimmed);
      if (closing && closing[1][0] === fence.char && closing[1].length >= fence.length) {
        fence = null;
      }
    } else {
      const opening = /^(\x60{3,}|~{3,})/u.exec(trimmed);
      if (opening) fence = { char: opening[1][0], length: opening[1].length };
    }
    if (lineEnd < 0) break;
    lineStart = lineEnd + 1;
  }
  return starts;
}

function nestedFencedBlankLineStarts(parentStarts, labelStart, labelEnd) {
  const starts = new Set();
  for (const lineStart of parentStarts) {
    if (lineStart > labelStart && lineStart < labelEnd) starts.add(lineStart - labelStart);
  }
  return starts;
}

function closingBracket(source, start, allowedBlankLines) {
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
      if (!nextLine.trim() && !allowedBlankLines.has(index + 1)) return -1;
    }
  }
  return -1;
}

function parseInlineLink(source, start, allowedBlankLines) {
  const labelEnd = closingBracket(source, start, allowedBlankLines);
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
    // The static renderer does not parse link titles: its href match ends at
    // the first `)`, even when a quote or parenthesis suffix looks balanced.
    const close = source.indexOf(')', cursor);
    if (close < 0) return null;
    targetEnd = close;
    target = source.slice(targetStart, targetEnd);
    cursor = close;
    unsupportedSuffix = true;
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
  // The renderer starts literal anchors with `<a\b`, which also accepts a
  // punctuation boundary such as `<a-foo` but rejects `<abbr` and `<a1`.
  if (
    source[start] !== '<' ||
    source[start + 1]?.toLowerCase() !== 'a' ||
    /[\w]/u.test(source[start + 2] || '')
  ) return null;

  const hrefAttributes = [];
  let cursor = start + 2;
  while (cursor < source.length) {
    const attributeRemovalStart = cursor;
    while (/\s/u.test(source[cursor] || '')) cursor += 1;
    if (source[cursor] === '>') {
      const firstHref = hrefAttributes[0];
      const openingEnd = cursor + 1;
      const closing = /<\/a>/iu.exec(source.slice(openingEnd));
      // The renderer's first pass matches a complete anchor. If no close tag
      // exists, it leaves this text for the later Markdown pass unchanged.
      if (!closing) return null;
      const labelStart = openingEnd;
      const labelEnd = openingEnd + closing.index;
      const end = labelEnd + closing[0].length;
      return {
        start,
        end,
        openingEnd,
        labelStart,
        labelEnd,
        htmlLabel: source.slice(labelStart, labelEnd),
        htmlAnchor: true,
        hasHref: Boolean(firstHref),
        label: '<a href>',
        hrefAttributes,
        ...(firstHref ? {
          target: firstHref.target,
          targetStart: firstHref.targetStart,
          targetEnd: firstHref.targetEnd,
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

    // The renderer uses `/\bhref\s*=/` inside the full attribute text, so
    // names such as `data-href` and `aria-href` are active there as well.
    if (/(?:^|\W)href$/u.test(attributeName)) {
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
function articleLinks(
  source,
  allowedBlankLines = fencedBlankLineStarts(source),
  scanHtmlAnchors = true,
) {
  const links = [];
  for (let index = 0; index < source.length;) {
    if (scanHtmlAnchors && source[index] === '<') {
      const anchor = parseHtmlAnchor(source, index);
      if (anchor) {
        // The renderer does not run its HTML-anchor replacement again on a
        // label returned by an outer anchor. Markdown links are still handled
        // in that label when the outer href is absent or removed.
        anchor.nestedLinks = articleLinks(
          anchor.htmlLabel,
          nestedFencedBlankLineStarts(allowedBlankLines, anchor.labelStart, anchor.labelEnd),
          false,
        );
        links.push(anchor);
        index = anchor.end;
        continue;
      }
    }
    if (source[index] !== '[') {
      index += 1;
      continue;
    }
    const link = parseInlineLink(source, index, allowedBlankLines);
    if (!link) {
      index += 1;
      continue;
    }
    link.nestedLinks = articleLinks(
      link.label,
      nestedFencedBlankLineStarts(allowedBlankLines, link.start + 1, link.labelEnd),
      scanHtmlAnchors,
    );
    links.push(link);
    index = link.end;
  }
  return links;
}

/**
 * Sanitize the Markdown-bearing `q`/`a` fields in generated FAQ pairs before
 * the object is serialized into a TypeScript body literal. Preserve extra
 * fields verbatim because they are not necessarily Markdown.
 */
export function sanitizeArticleFaqMarkdown(faqArray, locale = 'it') {
  if (!Array.isArray(faqArray)) return faqArray;
  return faqArray.map((pair) => {
    if (!pair || typeof pair !== 'object' || Array.isArray(pair)) return pair;
    return Object.fromEntries(Object.entries(pair).map(([key, value]) => [
      key,
      FAQ_MARKDOWN_KEYS.has(key) && typeof value === 'string'
        ? sanitizeArticleMarkdownLinks(value, locale)
        : value,
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
 * Unknown or malformed targets deliberately lose their clickable href. The
 * deterministic nav-label pass runs after target repair, so every provider
 * shares the same visible-label correction before a body is written.
 */
function sanitizeArticleMarkdownLinksInternal(source, locale, allowedBlankLines, scanHtmlAnchors = true) {
  let output = '';
  let copiedThrough = 0;
  for (const link of articleLinks(source, allowedBlankLines, scanHtmlAnchors)) {
    const canonical = link.htmlAnchor && !link.hasHref
      ? null
      : canonicalArticleLinkOccurrenceTarget(link, locale);
    const duplicateAnchorHref = link.htmlAnchor && link.hrefAttributes.length > 1;
    const htmlLabelNeedsMarkdown = link.htmlAnchor && (!link.hasHref || canonical === null);
    const originalLabel = link.htmlAnchor ? link.htmlLabel : link.label;
    const normalizedLabel = link.nestedLinks.length === 0
      || (link.htmlAnchor && !htmlLabelNeedsMarkdown)
      ? originalLabel
      : sanitizeArticleMarkdownLinksInternal(
        originalLabel,
        locale,
        nestedFencedBlankLineStarts(
          allowedBlankLines,
          link.htmlAnchor ? link.labelStart : link.start + 1,
          link.labelEnd,
        ),
        link.htmlAnchor ? false : scanHtmlAnchors,
      );
    if (link.htmlAnchor) {
      if (
        (!link.hasHref || canonical === link.target) &&
        !duplicateAnchorHref &&
        normalizedLabel === originalLabel
      ) continue;
    } else if (
      canonical === link.target &&
      !link.angle &&
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
      output += source.slice(tagCursor, link.openingEnd)
        + normalizedLabel
        + source.slice(link.labelEnd, link.end);
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

export function sanitizeArticleMarkdownLinks(text, locale = 'it') {
  const source = String(text ?? '');
  const sanitized = sanitizeArticleMarkdownLinksInternal(source, locale, fencedBlankLineStarts(source));
  return localizeNavLinkLabels(sanitized, locale);
}

/**
 * Find links that still need the contract's repair before publication.
 * The returned index is byte-oriented enough for diagnostics on the UTF-8
 * source files and is intentionally independent of a TypeScript parser.
 */
function findNonCanonicalArticleLinksInternal(input, locale, baseIndex, allowedBlankLines, scanHtmlAnchors = true) {
  const offenders = [];
  for (const link of articleLinks(input, allowedBlankLines, scanHtmlAnchors)) {
    const canonical = link.htmlAnchor && !link.hasHref
      ? null
      : canonicalArticleLinkOccurrenceTarget(link, locale);
    const duplicateAnchorHref = link.htmlAnchor && link.hrefAttributes.length > 1;
    if (
      link.htmlAnchor
        ? link.hasHref && (canonical !== link.target || duplicateAnchorHref)
        : canonical !== link.target || link.angle
    ) {
      offenders.push({
        label: link.label,
        target: link.target,
        replacement: canonical,
        index: baseIndex + link.start,
        htmlAnchor: Boolean(link.htmlAnchor),
      });
    }
    const scanHtmlLabelMarkdown = link.htmlAnchor && (!link.hasHref || canonical === null);
    if (link.htmlAnchor && scanHtmlLabelMarkdown && link.nestedLinks.length > 0) {
      offenders.push(...findNonCanonicalArticleLinksInternal(
        link.htmlLabel,
        locale,
        baseIndex + link.labelStart,
        nestedFencedBlankLineStarts(allowedBlankLines, link.labelStart, link.labelEnd),
        false,
      ));
    } else if (!link.htmlAnchor && link.nestedLinks.length > 0) {
      offenders.push(...findNonCanonicalArticleLinksInternal(
        link.label,
        locale,
        baseIndex + link.start + 1,
        nestedFencedBlankLineStarts(allowedBlankLines, link.start + 1, link.labelEnd),
        scanHtmlAnchors,
      ));
    }
  }
  return offenders.sort((a, b) => a.index - b.index);
}

export function findNonCanonicalArticleLinks(source, locale = 'it', baseIndex = 0) {
  const input = String(source ?? '');
  return findNonCanonicalArticleLinksInternal(input, locale, baseIndex, fencedBlankLineStarts(input));
}
