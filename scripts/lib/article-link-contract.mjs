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
    targetStart,
    targetEnd,
  };
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

function markdownLinks(source, { skipCode = false } = {}) {
  const links = [];
  for (let index = 0; index < source.length;) {
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
  // `tel:` is intentionally stripped: the site renderer does not preserve it.
  if (/^(?:https?:\/\/|mailto:)/i.test(target)) return target;

  // Root-relative and fragment links are already anchored to the public site
  // rather than to the article directory. Protocol-relative URLs are denied.
  if (/^(?:\/(?!\/)|#)/.test(target)) return target;

  return null;
}

/**
 * Normalize generated article Markdown before it is persisted.
 * Unknown or malformed targets deliberately become plain visible text.
 */
export function sanitizeArticleMarkdownLinks(text, locale = 'it') {
  const source = String(text ?? '');
  let output = '';
  let copiedThrough = 0;
  for (const link of markdownLinks(source, { skipCode: true })) {
    const canonical = canonicalArticleLinkTarget(link.target, locale);
    if (canonical === link.target) continue;
    output += source.slice(copiedThrough, canonical === null ? link.start : link.targetStart);
    output += canonical === null
      ? link.label
      : `${canonical}${source.slice(link.targetEnd, link.end)}`;
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
  for (const link of markdownLinks(input, { skipCode: true })) {
    const canonical = canonicalArticleLinkTarget(link.target, locale);
    if (canonical === link.target) continue;
    offenders.push({
      label: link.label,
      target: link.target,
      replacement: canonical,
      index: link.start,
    });
  }
  return offenders;
}
