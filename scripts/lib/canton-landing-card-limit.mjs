/**
 * Plain-Node adapter for the canton landing card limit owned by the renderer.
 *
 * The renderer source is TypeScript and cannot be imported by the reconciler
 * without a TypeScript runtime. Keep the source extraction here so the
 * reconciler has one parser for the mirrored renderer export instead of a
 * second format-sensitive regex at its call site.
 */

const CANTON_LANDING_CARD_LIMIT_EXPORT_RE = /^[ \t]*export\s+const\s+CANTON_LANDING_CARD_LIMIT\s*(?::\s*number)?\s*=\s*(?<value>0|[1-9]\d*)(?:\s+as\s+const)?[ \t]*(?<semicolon>;)?[ \t]*(?:\/\/[^\r\n]*)?(?:\r?\n|$)/gmu;

function maskRange(source, start, end) {
  return source.slice(start, end).replace(/[^\r\n]/g, ' ');
}

function skipEscapedCharacter(source, index) {
  const escapedIndex = index + 1;
  if (source[escapedIndex] === '\r' && source[escapedIndex + 1] === '\n') return escapedIndex + 2;
  return Math.min(escapedIndex + 1, source.length);
}

function skipQuotedLiteral(source, start, quote) {
  for (let index = start + 1; index < source.length;) {
    if (source[index] === '\\') {
      index = skipEscapedCharacter(source, index);
      continue;
    }
    if (source[index] === quote) return index + 1;
    index += 1;
  }
  return source.length;
}

const REGEX_PREFIX_KEYWORDS = new Set([
  'await',
  'case',
  'delete',
  'do',
  'else',
  'extends',
  'in',
  'instanceof',
  'new',
  'of',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
]);

const CONTROL_HEADER_KEYWORDS = new Set([
  'catch',
  'for',
  'if',
  'switch',
  'while',
  'with',
]);

function isIdentifierStart(char) {
  if (char === undefined) return false;
  return char === '_' || char === '$' || (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || char.charCodeAt(0) >= 0x80;
}

function isIdentifierPart(char) {
  return isIdentifierStart(char) || (char >= '0' && char <= '9');
}

function skipIdentifier(source, start) {
  let index = start + 1;
  while (isIdentifierPart(source[index])) index += 1;
  return index;
}

function skipNumber(source, start) {
  let index = start + 1;
  while (isIdentifierPart(source[index]) || source[index] === '.') index += 1;
  return index;
}

function skipRegexLiteral(source, start) {
  let inCharacterClass = false;
  for (let index = start + 1; index < source.length;) {
    if (source[index] === '\\') {
      index = skipEscapedCharacter(source, index);
      continue;
    }
    if (source[index] === '\r' || source[index] === '\n') return source.length;
    if (source[index] === '[') {
      inCharacterClass = true;
    } else if (source[index] === ']') {
      inCharacterClass = false;
    } else if (source[index] === '/' && !inCharacterClass) {
      index += 1;
      while (isIdentifierPart(source[index])) index += 1;
      return index;
    }
    index += 1;
  }
  return source.length;
}

function createLexicalContext() {
  return {
    canStartRegex: true,
    pendingControlHeader: null,
    parenthesisContexts: [],
    lastClosedControlHeader: false,
    afterMemberAccess: false,
  };
}

function isRegexLiteralContext(context) {
  return context.canStartRegex || context.lastClosedControlHeader;
}

function consumeLiteral(context) {
  context.canStartRegex = false;
  context.pendingControlHeader = null;
  context.lastClosedControlHeader = false;
  context.afterMemberAccess = false;
}

function advanceNormalToken(source, start, context) {
  const char = source[start];
  if (isIdentifierStart(char)) {
    const end = skipIdentifier(source, start);
    const word = source.slice(start, end);
    if (context.pendingControlHeader === 'for' && word === 'await') {
      context.pendingControlHeader = 'for';
    } else {
      context.pendingControlHeader = !context.afterMemberAccess && CONTROL_HEADER_KEYWORDS.has(word)
        ? word
        : null;
    }
    context.canStartRegex = !context.afterMemberAccess && REGEX_PREFIX_KEYWORDS.has(word);
    context.lastClosedControlHeader = false;
    context.afterMemberAccess = false;
    return { end };
  }
  if (char >= '0' && char <= '9') {
    context.canStartRegex = false;
    context.pendingControlHeader = null;
    context.lastClosedControlHeader = false;
    context.afterMemberAccess = false;
    return { end: skipNumber(source, start) };
  }
  if ((char === '+' && source[start + 1] === '+') || (char === '-' && source[start + 1] === '-')) {
    context.canStartRegex = false;
    context.pendingControlHeader = null;
    context.lastClosedControlHeader = false;
    context.afterMemberAccess = false;
    return { end: start + 2 };
  }
  if (char === '(') {
    context.parenthesisContexts.push(Boolean(context.pendingControlHeader));
    context.pendingControlHeader = null;
    context.canStartRegex = true;
    context.lastClosedControlHeader = false;
    context.afterMemberAccess = false;
    return { end: start + 1 };
  }
  if (char === ')') {
    context.lastClosedControlHeader = context.parenthesisContexts.pop() === true;
    context.pendingControlHeader = null;
    context.canStartRegex = false;
    context.afterMemberAccess = false;
    return { end: start + 1 };
  }
  if (char === '?' && source[start + 1] === '.') {
    context.pendingControlHeader = null;
    context.lastClosedControlHeader = false;
    context.canStartRegex = true;
    context.afterMemberAccess = true;
    return { end: start + 2 };
  }
  context.pendingControlHeader = null;
  context.lastClosedControlHeader = false;
  context.afterMemberAccess = char === '.';
  context.canStartRegex = char !== ']' && char !== '}' && char !== '.';
  return { end: start + 1 };
}

function skipTemplateExpression(source, start) {
  let depth = 1;
  const context = createLexicalContext();
  for (let index = start; index < source.length;) {
    if (source[index] === '/' && source[index + 1] === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\r' && source[index] !== '\n') index += 1;
      continue;
    }
    if (source[index] === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (source[index] === '\'' || source[index] === '"') {
      index = skipQuotedLiteral(source, index, source[index]);
      consumeLiteral(context);
      continue;
    }
    if (source[index] === '`') {
      index = skipTemplateLiteral(source, index);
      consumeLiteral(context);
      continue;
    }
    if (source[index] === '/' && isRegexLiteralContext(context)) {
      index = skipRegexLiteral(source, index);
      consumeLiteral(context);
      continue;
    }
    if (/\s/u.test(source[index])) {
      index += 1;
      continue;
    }
    if (source[index] === '{') {
      depth += 1;
    } else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    const token = advanceNormalToken(source, index, context);
    index = token.end;
  }
  return source.length;
}

function skipTemplateLiteral(source, start) {
  for (let index = start + 1; index < source.length;) {
    if (source[index] === '\\') {
      index = skipEscapedCharacter(source, index);
      continue;
    }
    if (source[index] === '`') return index + 1;
    if (source[index] === '$' && source[index + 1] === '{') {
      index = skipTemplateExpression(source, index + 2);
      continue;
    }
    index += 1;
  }
  return source.length;
}

function lexicalView(source, { maskLiterals }) {
  const chunks = [];
  let last = 0;
  const context = createLexicalContext();
  for (let index = 0; index < source.length;) {
    if (/\s/u.test(source[index])) {
      index += 1;
      continue;
    }
    let end;
    const isLineComment = source[index] === '/' && source[index + 1] === '/';
    const isBlockComment = source[index] === '/' && source[index + 1] === '*';
    const isRegex = source[index] === '/' && !isLineComment && !isBlockComment && isRegexLiteralContext(context);
    if (isLineComment) {
      end = index + 2;
      while (end < source.length && source[end] !== '\r' && source[end] !== '\n') end += 1;
    } else if (isBlockComment) {
      const commentEnd = source.indexOf('*/', index + 2);
      end = commentEnd === -1 ? source.length : commentEnd + 2;
    } else if (isRegex) {
      end = skipRegexLiteral(source, index);
    } else if (source[index] === '\'' || source[index] === '"') {
      end = skipQuotedLiteral(source, index, source[index]);
    } else if (source[index] === '`') {
      end = skipTemplateLiteral(source, index);
    } else {
      const token = advanceNormalToken(source, index, context);
      index = token.end;
      continue;
    }
    chunks.push(source.slice(last, index));
    chunks.push((maskLiterals || isLineComment || isBlockComment || isRegex) ? maskRange(source, index, end) : source.slice(index, end));
    index = end;
    last = end;
    if (!isLineComment && !isBlockComment) consumeLiteral(context);
  }
  chunks.push(source.slice(last));
  return chunks.join('');
}

function normalizeSource(source) {
  return source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
}

function hasUnexpectedTrailingCode(source, match) {
  if (match.groups.semicolon) return false;
  const remainder = lexicalView(source, { maskLiterals: false }).slice(match.index + match[0].length);
  return /\S/u.test(remainder);
}

/**
 * Parse the renderer's `CANTON_LANDING_CARD_LIMIT` export.
 *
 * The declaration may be formatted across lines, carry a `number` annotation,
 * or use `as const`. A semicolonless declaration is accepted only when it is
 * the final non-comment code in the source; anything else is rejected so a
 * future renderer change cannot silently leave the reconciler with a stale or
 * guessed limit.
 *
 * @param {string} source TypeScript source containing the renderer export
 * @returns {number}
 */
export function parseCantonLandingCardLimitExport(source) {
  if (typeof source !== 'string') {
    throw new Error('CANTON_LANDING_CARD_LIMIT export non valido: sorgente non testuale');
  }
  const normalizedSource = normalizeSource(source);
  const maskedSource = lexicalView(normalizedSource, { maskLiterals: true });
  const matches = [...maskedSource.matchAll(CANTON_LANDING_CARD_LIMIT_EXPORT_RE)];
  if (matches.length === 0) {
    throw new Error('CANTON_LANDING_CARD_LIMIT export non trovato o non valido');
  }
  if (matches.length > 1) {
    throw new Error('CANTON_LANDING_CARD_LIMIT export duplicato: dichiarazione non univoca');
  }
  const [match] = matches;
  if (hasUnexpectedTrailingCode(normalizedSource, match)) {
    throw new Error('CANTON_LANDING_CARD_LIMIT export non trovato o non valido');
  }
  const value = Number(match.groups.value);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`CANTON_LANDING_CARD_LIMIT export non valido: ${match.groups.value}`);
  }
  return value;
}

/**
 * Resolve the effective landing-card limit for a caller that may override the
 * renderer default. The reconciler and its fallback use this same guard so a
 * malformed override cannot silently become a different coverage contract.
 *
 * @param {unknown} limit explicit caller override, or undefined
 * @param {number} fallback renderer-owned default
 * @returns {number}
 */
export function resolveCantonLandingCardLimit(limit, fallback) {
  const value = limit === undefined ? fallback : limit;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`limite landing non valido: ${value}`);
  }
  return value;
}
