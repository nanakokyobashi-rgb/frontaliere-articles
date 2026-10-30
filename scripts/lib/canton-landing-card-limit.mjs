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
  'break',
  'await',
  'case',
  'delete',
  'do',
  'default',
  'continue',
  'debugger',
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

const REGEX_PREFIX_PUNCTUATION = new Set([
  '(', '[', '{', ',', ':', ';', '=', '!', '?', '+', '-', '*', '%', '&', '|', '^', '~', '<', '>',
]);

const CONTROL_PAREN_KEYWORDS = new Set(['catch', 'for', 'if', 'switch', 'while', 'with']);
const BLOCK_BRACE_KEYWORDS = new Set([
  'catch', 'class', 'do', 'else', 'enum', 'finally', 'function', 'interface', 'module', 'namespace', 'static', 'try',
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

function createLexicalState() {
  return {
    previousToken: null,
    parenContexts: [],
    braceContexts: [],
    statementStart: true,
    awaitingFunctionParams: false,
    pendingBlockKeyword: false,
  };
}

/**
 * Return whether a slash at the current cursor can begin a regex literal.
 *
 * A plain `canStartRegex = char !== ')'` heuristic is not enough: a slash can
 * begin a statement after the closing parenthesis of `if`, `for`, `while`,
 * `with`, `catch`, or `switch`, but it is division after an ordinary grouping
 * or call. Keeping that distinction in the token state prevents a regex body
 * such as `\/ *` from being mistaken for a block comment and hiding the real
 * renderer export.
 *
 * @param {{ type?: string, value?: string }|null} previousToken
 * @returns {boolean}
 */
export function isRegexLiteralContext(previousToken) {
  if (!previousToken) return true;
  if (previousToken.type === 'keyword') return REGEX_PREFIX_KEYWORDS.has(previousToken.value);
  if (previousToken.type === 'punctuation') return REGEX_PREFIX_PUNCTUATION.has(previousToken.value);
  return previousToken.type === 'control-close'
    || previousToken.type === 'block-close'
    || previousToken.type === 'division'
    || previousToken.type === 'prefix'
    || previousToken.type === 'arrow';
}

function isBlockOpening(state) {
  const previousToken = state.previousToken;
  if (state.statementStart || state.pendingBlockKeyword) return true;
  if (!previousToken) return true;
  if (previousToken.type === 'control-close'
    || previousToken.type === 'function-close'
    || previousToken.type === 'close-paren'
    || previousToken.type === 'arrow') return true;
  return previousToken.type === 'word' && BLOCK_BRACE_KEYWORDS.has(previousToken.value);
}

function advanceNormalToken(source, start, state) {
  const char = source[start];
  if (isIdentifierStart(char)) {
    const end = skipIdentifier(source, start);
    const value = source.slice(start, end);
    const member = state.previousToken?.type === 'member-access';
    state.previousToken = {
      type: !member && REGEX_PREFIX_KEYWORDS.has(value) ? 'keyword' : 'word',
      value,
      member,
    };
    state.statementStart = false;
    if (!member && value === 'function') state.awaitingFunctionParams = true;
    if (!member && BLOCK_BRACE_KEYWORDS.has(value)) state.pendingBlockKeyword = true;
    return end;
  }
  if (char >= '0' && char <= '9') {
    const end = skipNumber(source, start);
    state.previousToken = { type: 'literal' };
    state.statementStart = false;
    return end;
  }
  if (source.startsWith('...', start)) {
    state.previousToken = { type: 'prefix', value: '...' };
    state.statementStart = false;
    state.pendingBlockKeyword = false;
    return start + 3;
  }
  if ((char === '+' && source[start + 1] === '+') || (char === '-' && source[start + 1] === '-')) {
    state.previousToken = {
      type: isRegexLiteralContext(state.previousToken) ? 'prefix' : 'postfix',
      value: char + char,
    };
    state.statementStart = false;
    state.pendingBlockKeyword = false;
    return start + 2;
  }
  if (char === '/' && source[start + 1] === '=') {
    state.previousToken = { type: 'division', value: '/=' };
    state.statementStart = false;
    state.pendingBlockKeyword = false;
    return start + 2;
  }
  if (char === '/') {
    state.previousToken = { type: 'division', value: '/' };
    state.statementStart = false;
    state.pendingBlockKeyword = false;
    return start + 1;
  }
  if (source.startsWith('?.', start)) {
    state.previousToken = { type: 'member-access', value: '?.' };
    state.statementStart = false;
    state.pendingBlockKeyword = false;
    return start + 2;
  }
  if (char === '.') {
    state.previousToken = { type: 'member-access', value: '.' };
    state.statementStart = false;
    state.pendingBlockKeyword = false;
    return start + 1;
  }
  if (char === '#') {
    state.previousToken = { type: 'member-access', value: '#' };
    state.statementStart = false;
    state.pendingBlockKeyword = false;
    return start + 1;
  }
  if (char === '!' && source[start + 1] !== '=') {
    state.previousToken = {
      type: isRegexLiteralContext(state.previousToken) ? 'prefix' : 'postfix',
      value: char,
    };
    state.statementStart = false;
    state.pendingBlockKeyword = false;
    return start + 1;
  }
  if (char === '=' && source[start + 1] === '>') {
    state.previousToken = { type: 'arrow', value: '=>' };
    state.statementStart = false;
    state.pendingBlockKeyword = false;
    return start + 2;
  }
  if (char === '(') {
    const previousToken = state.previousToken;
    const control = Boolean(
      previousToken
      && !previousToken.member
      && (previousToken.type === 'word' || previousToken.type === 'keyword')
      && CONTROL_PAREN_KEYWORDS.has(previousToken.value),
    );
    const functionParams = state.awaitingFunctionParams;
    state.parenContexts.push({ control, functionParams });
    state.previousToken = { type: 'punctuation', value: '(' };
    state.statementStart = false;
    if (!control && !functionParams) state.pendingBlockKeyword = false;
    return start + 1;
  }
  if (char === ')') {
    const context = state.parenContexts.pop() ?? {};
    state.previousToken = context.control
      ? { type: 'control-close', value: ')' }
      : context.functionParams
        ? { type: 'function-close', value: ')' }
        : { type: 'close-paren', value: ')' };
    state.statementStart = context.control === true;
    state.pendingBlockKeyword = context.control === true || context.functionParams === true;
    if (context.functionParams) state.awaitingFunctionParams = false;
    return start + 1;
  }
  if (char === '{') {
    const block = isBlockOpening(state);
    state.braceContexts.push({ block });
    state.previousToken = { type: 'punctuation', value: '{', block };
    state.statementStart = block;
    state.pendingBlockKeyword = false;
    return start + 1;
  }
  if (char === '}') {
    const context = state.braceContexts.pop() ?? {};
    state.previousToken = context.block
      ? { type: 'block-close', value: '}' }
      : { type: 'close-object', value: '}' };
    state.statementStart = context.block === true;
    state.pendingBlockKeyword = false;
    return start + 1;
  }
  const end = start + 1;
  state.previousToken = { type: 'punctuation', value: char };
  state.statementStart = char === ';';
  state.pendingBlockKeyword = false;
  return end;
}

function markLiteral(state) {
  state.previousToken = { type: 'literal' };
  state.statementStart = false;
  state.pendingBlockKeyword = false;
}

function skipTemplateExpression(source, start) {
  let depth = 1;
  const state = createLexicalState();
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
      markLiteral(state);
      continue;
    }
    if (source[index] === '`') {
      index = skipTemplateLiteral(source, index);
      markLiteral(state);
      continue;
    }
    if (source[index] === '/' && isRegexLiteralContext(state.previousToken)) {
      index = skipRegexLiteral(source, index);
      markLiteral(state);
      continue;
    }
    if (/\s/u.test(source[index])) {
      index += 1;
      continue;
    }
    if (source[index] === '{') {
      depth += 1;
    }
    const end = advanceNormalToken(source, index, state);
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return end;
    }
    index = end;
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
  const state = createLexicalState();
  for (let index = 0; index < source.length;) {
    if (/\s/u.test(source[index])) {
      index += 1;
      continue;
    }
    let end;
    const isLineComment = source[index] === '/' && source[index + 1] === '/';
    const isBlockComment = source[index] === '/' && source[index + 1] === '*';
    const isRegex = source[index] === '/'
      && !isLineComment
      && !isBlockComment
      && isRegexLiteralContext(state.previousToken);
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
      index = advanceNormalToken(source, index, state);
      continue;
    }
    chunks.push(source.slice(last, index));
    chunks.push((maskLiterals || isLineComment || isBlockComment || isRegex) ? maskRange(source, index, end) : source.slice(index, end));
    index = end;
    last = end;
    if (!isLineComment && !isBlockComment) markLiteral(state);
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
