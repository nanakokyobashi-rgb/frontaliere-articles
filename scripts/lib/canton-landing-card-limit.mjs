/**
 * Plain-Node adapter for the canton landing card limit owned by the renderer.
 *
 * The renderer source is TypeScript and cannot be imported by the reconciler
 * without a TypeScript runtime. Keep the source extraction here so the
 * reconciler has one parser for the mirrored renderer export instead of a
 * second format-sensitive regex at its call site.
 */

const CANTON_LANDING_CARD_LIMIT_EXPORT_RE = /^[ \t]*export\s+const\s+CANTON_LANDING_CARD_LIMIT\s*(?::\s*number)?\s*=\s*(?<value>0|[1-9]\d*)(?:\s+as\s+const)?[ \t]*(?<semicolon>;)?[ \t]*(?:\/\/[^\r\n]*)?(?:\r?\n|$)/mu;

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

function advanceNormalToken(source, start) {
  const char = source[start];
  if (isIdentifierStart(char)) {
    const end = skipIdentifier(source, start);
    return { end, canStartRegex: REGEX_PREFIX_KEYWORDS.has(source.slice(start, end)) };
  }
  if (char >= '0' && char <= '9') return { end: skipNumber(source, start), canStartRegex: false };
  if ((char === '+' && source[start + 1] === '+') || (char === '-' && source[start + 1] === '-')) {
    return { end: start + 2, canStartRegex: false };
  }
  return { end: start + 1, canStartRegex: char !== ')' && char !== ']' && char !== '}' && char !== '.' };
}

function skipTemplateExpression(source, start) {
  let depth = 1;
  let canStartRegex = true;
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
      continue;
    }
    if (source[index] === '`') {
      index = skipTemplateLiteral(source, index);
      continue;
    }
    if (source[index] === '/' && canStartRegex) {
      index = skipRegexLiteral(source, index);
      canStartRegex = false;
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
    const token = advanceNormalToken(source, index);
    index = token.end;
    canStartRegex = token.canStartRegex;
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
  let canStartRegex = true;
  for (let index = 0; index < source.length;) {
    let end;
    const isLineComment = source[index] === '/' && source[index + 1] === '/';
    const isBlockComment = source[index] === '/' && source[index + 1] === '*';
    const isRegex = source[index] === '/' && !isLineComment && !isBlockComment && canStartRegex;
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
      const token = advanceNormalToken(source, index);
      index = token.end;
      canStartRegex = token.canStartRegex;
      continue;
    }
    chunks.push(source.slice(last, index));
    chunks.push((maskLiterals || isLineComment || isBlockComment || isRegex) ? maskRange(source, index, end) : source.slice(index, end));
    index = end;
    last = end;
    if (!isLineComment && !isBlockComment) canStartRegex = false;
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
  const match = CANTON_LANDING_CARD_LIMIT_EXPORT_RE.exec(lexicalView(normalizedSource, { maskLiterals: true }));
  if (!match || hasUnexpectedTrailingCode(normalizedSource, match)) {
    throw new Error('CANTON_LANDING_CARD_LIMIT export non trovato o non valido');
  }
  const value = Number(match.groups.value);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`CANTON_LANDING_CARD_LIMIT export non valido: ${match.groups.value}`);
  }
  return value;
}
