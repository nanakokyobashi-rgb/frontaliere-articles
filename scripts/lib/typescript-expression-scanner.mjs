export function skipTypeScriptQuotedToken(source, offset) {
  const quote = source[offset];
  let index = offset + 1;
  while (index < source.length) {
    const ch = source[index];
    if (ch === '\\') {
      index += index + 1 < source.length && source[index + 1] === '\r' && source[index + 2] === '\n' ? 3 : 2;
      continue;
    }
    if (quote === '`' && ch === '$' && source[index + 1] === '{') {
      index = scanTypeScriptExpression(source, index + 2, '}');
      continue;
    }
    if (ch === quote) return index + 1;
    if (quote !== '`' && (ch === '\n' || ch === '\r')) return source.length;
    index += 1;
  }
  return source.length;
}

function skipTrivia(source, offset) {
  let index = offset;
  while (index < source.length) {
    if (/\s/u.test(source[index])) {
      index += 1;
      continue;
    }
    if (source[index] !== '/' || index + 1 >= source.length) break;
    if (source[index + 1] === '/') {
      const newline = source.indexOf('\n', index + 2);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2);
      index = close < 0 ? source.length : close + 2;
      continue;
    }
    break;
  }
  return index;
}

function skipRegexLiteral(source, offset) {
  let inCharacterClass = false;
  let index = offset + 1;
  while (index < source.length) {
    const ch = source[index];
    if (ch === '\\') {
      index += 2;
      continue;
    }
    if (ch === '\n' || ch === '\r') return -1;
    if (ch === '[') inCharacterClass = true;
    else if (ch === ']' && inCharacterClass) inCharacterClass = false;
    else if (ch === '/' && !inCharacterClass) {
      index += 1;
      while (/[A-Za-z]/u.test(source[index] || '')) index += 1;
      return index;
    }
    index += 1;
  }
  return -1;
}

const REGEX_PREFIX_KEYWORDS = new Set([
  'await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of', 'return', 'throw',
  'typeof', 'void', 'yield',
]);
const REGEX_PREFIX_PUNCTUATION = new Set([
  '(', '[', '{', ',', ':', ';', '=', '!', '?', '+', '-', '*', '%', '&', '|', '^', '~', '<', '>', '=>',
]);
const TS_TRIVIA_PATTERN = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*`;
const COMPUTED_PROPERTY_PREFIX_RE = new RegExp(
  `(?:^|[,{])${TS_TRIVIA_PATTERN}(?:(?:get|set|async|\\*)${TS_TRIVIA_PATTERN})*$`,
  'u',
);
const OBJECT_MEMBER_PREFIX_RE = new RegExp(`(?:^|[,{])${TS_TRIVIA_PATTERN}$`, 'u');
function typeAliasHeaderEqualsOffset(source, offset) {
  let cursor = skipTrivia(source, offset);
  if (!/[$_\p{ID_Start}]/u.test(source[cursor] || '')) return -1;
  cursor += 1;
  while (/[$_\u200c\u200d\p{ID_Continue}]/u.test(source[cursor] || '')) cursor += 1;
  cursor = skipTrivia(source, cursor);
  if (source[cursor] !== '<') return source[cursor] === '=' ? cursor : -1;

  let depth = 0;
  while (cursor < source.length) {
    const ch = source[cursor];
    const next = source[cursor + 1];
    if (ch === '/' && (next === '/' || next === '*')) {
      cursor = skipTrivia(source, cursor);
      continue;
    }
    if (ch === '"' || ch === "'" || source.charCodeAt(cursor) === 96) {
      cursor = skipTypeScriptQuotedToken(source, cursor);
      continue;
    }
    if (ch === '<') depth += 1;
    else if (ch === '>' && source[cursor - 1] !== '=') {
      depth -= 1;
      if (depth === 0) {
        cursor = skipTrivia(source, cursor + 1);
        return source[cursor] === '=' ? cursor : -1;
      }
    }
    cursor += 1;
  }
  return -1;
}

function isTypeAssertionBeforeExpression(source, offset) {
  let cursor = offset;
  let depth = 0;
  while (cursor < source.length) {
    const ch = source[cursor];
    const next = source[cursor + 1];
    if (ch === '/' && (next === '/' || next === '*')) {
      cursor = skipTrivia(source, cursor);
      continue;
    }
    if (ch === '"' || ch === "'" || source.charCodeAt(cursor) === 96) {
      cursor = skipTypeScriptQuotedToken(source, cursor);
      continue;
    }
    if (ch === '<') depth += 1;
    else if (ch === '>' && source[cursor - 1] !== '=') {
      depth -= 1;
      if (depth === 0) {
        cursor = skipTrivia(source, cursor + 1);
        return source[cursor] === '{'
          || source[cursor] === '('
          || source[cursor] === '['
          || ['"', "'", '`', '/'].includes(source[cursor])
          || ['!', '~', '+', '-'].includes(source[cursor])
          || /[0-9]/u.test(source[cursor] || '')
          || source[cursor] === '.' && /[0-9]/u.test(source[cursor + 1] || '')
          || /[$_\p{ID_Start}]/u.test(source[cursor] || '');
      }
    }
    cursor += 1;
  }
  return false;
}

/**
 * Report whether `offset` begins a comma-separated element inside parentheses.
 * Array binding patterns in helper parameters can otherwise look like computed
 * properties to source scanners. Delimiter nesting keeps commas in annotations
 * such as callback and object types from changing the outer parameter context.
 */
function delimiterContextAt(source, offset) {
  const delimiters = [];
  let previousToken = null;
  let previousSignificantEnd = 0;
  let pendingTypeAliasEquals = -1;
  let pendingTypeAliasDepth = -1;
  let typeAliasDepth = -1;
  let typeAliasHasRhsToken = false;
  let typeAliasAngleDepth = 0;
  let awaitingFunctionParametersDepth = -1;
  let functionTypeParameterDepth = 0;
  let awaitingInterfaceBodyDepth = -1;
  let interfaceTypeParameterDepth = 0;
  let lastClosedFunctionParameters = false;
  let pendingFunctionReturnObjectType = false;
  let variableDeclarationDepth = -1;
  let variableNamePending = false;
  let variableTypePending = false;
  let pendingVariableTypeObject = false;
  const markToken = (token, closesFunctionParameters = false) => {
    if (delimiters.length) delimiters.at(-1).lastToken = token;
    previousToken = token;
    lastClosedFunctionParameters = closesFunctionParameters;
    if (typeAliasDepth >= 0 && delimiters.length === typeAliasDepth) typeAliasHasRhsToken = true;
  };
  let index = 0;
  while (index < offset) {
    const ch = source[index];
    const next = source[index + 1];
    if (/\s/u.test(ch)) {
      index += 1;
      continue;
    }
    if (ch === '/' && (next === '/' || next === '*')) {
      index = skipTrivia(source, index);
      continue;
    }
    if (ch !== '{') {
      pendingFunctionReturnObjectType = false;
      pendingVariableTypeObject = false;
    }
    if (awaitingFunctionParametersDepth >= 0 && delimiters.length === awaitingFunctionParametersDepth) {
      if (ch === '<') functionTypeParameterDepth += 1;
      else if (ch === '>' && source[index - 1] !== '=' && functionTypeParameterDepth > 0) {
        functionTypeParameterDepth -= 1;
      }
    }
    if (awaitingInterfaceBodyDepth >= 0 && delimiters.length === awaitingInterfaceBodyDepth) {
      if (ch === '<') interfaceTypeParameterDepth += 1;
      else if (ch === '>' && source[index - 1] !== '=' && interfaceTypeParameterDepth > 0) {
        interfaceTypeParameterDepth -= 1;
      }
    }
    const token = source.startsWith('=>', index)
      ? '=>'
      : /[$_\p{ID_Start}]/u.test(ch)
      ? /^[\w$]+/u.exec(source.slice(index, offset))?.[0]
      : ch;
    if (typeAliasDepth >= 0 && typeAliasHasRhsToken && delimiters.length === typeAliasDepth
      && /[\r\n\u2028\u2029]/u.test(source.slice(previousSignificantEnd, index))
      && !['&', '|', '?', '[', ':', ',', '>', '=>', 'extends'].includes(token)
      && !(token === '<' && !isTypeAssertionBeforeExpression(source, index))
      && !['=', '&', '|', '?', ':', ',', '<', '=>', 'extends'].includes(previousToken)
      && !(previousToken === '>' && typeAliasAngleDepth > 0)) {
      typeAliasDepth = -1;
      typeAliasHasRhsToken = false;
      typeAliasAngleDepth = 0;
    }
    if (ch === "'" || ch === '"' || source.charCodeAt(index) === 96) {
      index = skipTypeScriptQuotedToken(source, index);
      markToken('literal');
      previousSignificantEnd = index;
      continue;
    }
    if (ch === '/' && (previousToken === null
      || REGEX_PREFIX_PUNCTUATION.has(previousToken)
      || REGEX_PREFIX_KEYWORDS.has(previousToken))) {
      const regexEnd = skipRegexLiteral(source, index);
      if (regexEnd >= 0) {
        index = regexEnd;
        markToken('literal');
        continue;
      }
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      const interfaceBody = ch === '{' && awaitingInterfaceBodyDepth === delimiters.length
        && interfaceTypeParameterDepth === 0;
      const typeLiteral = interfaceBody
        || ch === '{' && previousToken === ':'
        && (delimiters.some(({ typeLiteral: parentIsTypeLiteral }) => parentIsTypeLiteral)
          || pendingFunctionReturnObjectType || pendingVariableTypeObject)
        || ch === '{' && typeAliasDepth >= 0;
      const functionParameters = ch === '(' && awaitingFunctionParametersDepth === delimiters.length
        && functionTypeParameterDepth === 0;
      if (functionParameters) {
        awaitingFunctionParametersDepth = -1;
        functionTypeParameterDepth = 0;
      }
      if (interfaceBody) {
        awaitingInterfaceBodyDepth = -1;
        interfaceTypeParameterDepth = 0;
      }
      markToken(ch);
      delimiters.push({ delimiter: ch, offset: index, lastToken: null, typeLiteral, functionParameters });
      pendingFunctionReturnObjectType = false;
      pendingVariableTypeObject = false;
      index += 1;
      previousSignificantEnd = index;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      const matching = { ')': '(', ']': '[', '}': '{' }[ch];
      const closesFunctionParameters = matching === '('
        && delimiters.at(-1)?.functionParameters === true;
      if (delimiters.at(-1)?.delimiter === matching) delimiters.pop();
      if (typeAliasDepth >= 0 && delimiters.length < typeAliasDepth) {
        typeAliasDepth = -1;
        typeAliasHasRhsToken = false;
        typeAliasAngleDepth = 0;
      }
      if (pendingTypeAliasDepth >= 0 && delimiters.length < pendingTypeAliasDepth) {
        pendingTypeAliasEquals = -1;
        pendingTypeAliasDepth = -1;
      }
      markToken(ch, closesFunctionParameters);
      index += 1;
      previousSignificantEnd = index;
      continue;
    }
    if (/[A-Za-z_$]/u.test(ch)) {
      const identifier = /^[A-Za-z_$][\w$]*/u.exec(source.slice(index, offset))[0];
      if (['const', 'let', 'var'].includes(identifier)) {
        variableDeclarationDepth = delimiters.length;
        variableNamePending = true;
        variableTypePending = false;
      } else if (variableNamePending && delimiters.length === variableDeclarationDepth) {
        variableNamePending = false;
        variableTypePending = true;
      }
      if (identifier === 'function' && !['.', '?.'].includes(previousToken)) {
        awaitingFunctionParametersDepth = delimiters.length;
        functionTypeParameterDepth = 0;
      }
      const afterInterfaceKeyword = identifier === 'interface'
        ? skipTrivia(source, index + identifier.length)
        : -1;
      const hasInterfaceName = afterInterfaceKeyword >= 0
        && /[$_\p{ID_Start}]/u.test(source[afterInterfaceKeyword] || '');
      if (identifier === 'interface' && hasInterfaceName && !['.', '?.'].includes(previousToken)) {
        awaitingInterfaceBodyDepth = delimiters.length;
        interfaceTypeParameterDepth = 0;
      }
      if (identifier === 'type') {
        const equalsOffset = typeAliasHeaderEqualsOffset(source, index + identifier.length);
        if (equalsOffset >= 0) {
          pendingTypeAliasEquals = equalsOffset;
          pendingTypeAliasDepth = delimiters.length;
        }
      }
      index += identifier.length;
      markToken(identifier);
      previousSignificantEnd = index;
      continue;
    }
    if ((ch === '+' && next === '+') || (ch === '-' && next === '-')) {
      index += 2;
      markToken('postfix');
      previousSignificantEnd = index;
      continue;
    }
    if (ch === '=' && next === '>') {
      index += 2;
      markToken('=>');
      previousSignificantEnd = index;
      continue;
    }
    if (ch === ':') {
      pendingFunctionReturnObjectType = lastClosedFunctionParameters;
      pendingVariableTypeObject = variableTypePending
        && delimiters.length === variableDeclarationDepth;
      variableTypePending = false;
    } else {
      pendingFunctionReturnObjectType = false;
      pendingVariableTypeObject = false;
    }
    if ((ch === '=' || ch === ';') && delimiters.length === variableDeclarationDepth) {
      variableDeclarationDepth = -1;
      variableNamePending = false;
      variableTypePending = false;
    }
    markToken(ch);
    index += 1;
    if (ch === ';' && delimiters.length === typeAliasDepth) {
      typeAliasDepth = -1;
      typeAliasHasRhsToken = false;
      typeAliasAngleDepth = 0;
    }
    if (ch === ';' && delimiters.length === pendingTypeAliasDepth) {
      pendingTypeAliasEquals = -1;
      pendingTypeAliasDepth = -1;
    } else if (ch === '=' && index - 1 === pendingTypeAliasEquals
      && delimiters.length === pendingTypeAliasDepth) {
      typeAliasDepth = delimiters.length;
      typeAliasHasRhsToken = false;
      typeAliasAngleDepth = 0;
      pendingTypeAliasEquals = -1;
      pendingTypeAliasDepth = -1;
    } else if (typeAliasDepth >= 0 && ch === '<') {
      typeAliasAngleDepth += 1;
    } else if (typeAliasDepth >= 0 && ch === '>' && typeAliasAngleDepth > 0) {
      typeAliasAngleDepth -= 1;
    }
    previousSignificantEnd = index;
  }

  return delimiters;
}

export function isParenthesizedCommaContext(source, offset) {
  if (source[offset] !== '[') return false;
  const current = delimiterContextAt(source, offset).at(-1);
  return current?.delimiter === '(' && current.lastToken === ',';
}

export function hasComputedPropertyPrefix(source, offset) {
  const prefix = source.slice(0, offset);
  return COMPUTED_PROPERTY_PREFIX_RE.test(prefix) && !isParenthesizedCommaContext(source, offset);
}

function hasObjectMemberPrefix(source, offset) {
  if (!OBJECT_MEMBER_PREFIX_RE.test(source.slice(0, offset))) return false;
  const contexts = delimiterContextAt(source, offset);
  const current = contexts.at(-1);
  if (!current || current.delimiter !== '{' || current.typeLiteral) return false;
  if (contexts.at(-2)?.functionParameters) return false;
  if (/\b(?:const|let|var|import|export)\s*$/u.test(source.slice(0, current.offset))) return false;
  const objectEnd = scanTypeScriptExpression(source, current.offset + 1, '}');
  if (objectEnd >= source.length) return true;
  const afterObject = skipTrivia(source, objectEnd);
  if (source[afterObject] === '=' && source[afterObject + 1] !== '>') return false;
  if (source[afterObject] !== ')') return true;
  return !source.startsWith('=>', skipTrivia(source, afterObject + 1));
}

/**
 * Return a dynamic object member that a static article-body consumer cannot
 * resolve. Both body extraction and the publication gate must reject the same
 * spread, shorthand, and computed-member forms so they cannot disagree about
 * which fields are going to be published.
 */
export function unsupportedObjectMemberAt(source, offset) {
  const character = source[offset];
  if (character === '[' && hasComputedPropertyPrefix(source, offset)) {
    const keyEnd = computedPropertyKeyEnd(source, offset);
    if (!isTypeScriptIndexSignature(source, offset, keyEnd)
      && !isTypeScriptMappedTypeMember(source, offset, keyEnd)) {
      return { kind: 'computed', keyEnd };
    }
  }
  if (character !== '.' && !/[$_\p{ID_Start}]/u.test(character || '')) return null;
  if (!hasObjectMemberPrefix(source, offset)) return null;
  if (character === '.' && source.startsWith('...', offset)) return { kind: 'spread', end: offset + 3 };
  if (character === '.') return null;
  const shorthand = /^[$_\p{ID_Start}][$_\u200c\u200d\p{ID_Continue}]*/u.exec(source.slice(offset));
  if (!shorthand) return null;
  const end = offset + shorthand[0].length;
  const after = skipTrivia(source, end);
  if (source[after] === ',' || source[after] === '}') return { kind: 'shorthand', end };
  return null;
}

/**
 * A TypeScript index signature has its name annotation inside the brackets,
 * unlike a computed object key whose colon follows the closing bracket.
 */
export function isTypeScriptIndexSignature(source, start, end) {
  if (end < 0 || source[start] !== '[' || source[end - 1] !== ']') return false;
  let cursor = skipTrivia(source, start + 1);
  if (!/[$_\p{ID_Start}]/u.test(source[cursor] || '')) return false;
  cursor += 1;
  while (/[$_\u200c\u200d\p{ID_Continue}]/u.test(source[cursor] || '')) cursor += 1;
  cursor = skipTrivia(source, cursor);
  if (source[cursor] === '?') cursor = skipTrivia(source, cursor + 1);
  return source[cursor] === ':';
}

/**
 * A mapped type member is written `[Key in Constraint]: Value` directly inside
 * a type literal. `in keyof T` is also an unambiguous type-only constraint when
 * the alias is not nested in a parameter annotation.
 */
export function isTypeScriptMappedTypeMember(source, start, end) {
  if (end < 0 || source[start] !== '[' || source[end - 1] !== ']') return false;
  let cursor = skipTrivia(source, start + 1);
  if (!/[$_\p{ID_Start}]/u.test(source[cursor] || '')) return false;
  cursor += 1;
  while (/[$_\u200c\u200d\p{ID_Continue}]/u.test(source[cursor] || '')) cursor += 1;
  cursor = skipTrivia(source, cursor);
  if (source.slice(cursor, cursor + 2) !== 'in'
    || /[$_\u200c\u200d\p{ID_Continue}]/u.test(source[cursor + 2] || '')) return false;
  return delimiterContextAt(source, start).at(-1)?.typeLiteral === true;
}

/**
 * Skip a JavaScript/TypeScript expression up to its matching `}` or `]`.
 * The small lexer tracks regex-vs-division context so delimiters inside regex
 * literals, strings, comments, template strings, and declaration bodies do not
 * terminate the containing expression.
 */
function scanTypeScriptExpression(source, offset, terminator) {
  const templateTerminator = terminator === '}';
  let depth = templateTerminator ? 1 : 0;
  let bracketDepth = 0;
  let index = offset;
  let canStartRegex = true;
  let afterMemberAccess = false;
  let awaitingControlParen = false;
  const controlParenStack = [];
  let awaitingBlock = false;
  let awaitingBlockEndsStatement = false;
  const braceBlockStack = [];
  let statementBoundary = false;
  let awaitingFunctionParams = false;
  let functionTypeParameterDepth = 0;
  let awaitingFunctionDeclaration = false;
  let awaitingAsyncFunction = false;
  let asyncFunctionDeclaration = false;
  let pendingFunctionBody = null;
  const awaitingClassBodies = [];
  let awaitingClassBody = null;
  while (index < source.length) {
    const ch = source[index];
    const next = source[index + 1];
    if (awaitingAsyncFunction && /[\r\n\u2028\u2029]/u.test(ch)) awaitingAsyncFunction = false;
    if (awaitingAsyncFunction && !/[A-Za-z_$]/u.test(ch) && !/\s/u.test(ch)
      && !(ch === '/' && (next === '/' || next === '*'))) awaitingAsyncFunction = false;
    if (ch === '/' && (next === '/' || next === '*')) {
      const nextToken = skipTrivia(source, index);
      if (awaitingAsyncFunction && /[\r\n\u2028\u2029]/u.test(source.slice(index, nextToken))) {
        awaitingAsyncFunction = false;
      }
      index = nextToken;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      index = skipTypeScriptQuotedToken(source, index);
      canStartRegex = false;
      afterMemberAccess = false;
      awaitingControlParen = false;
      awaitingBlock = false;
      statementBoundary = false;
      continue;
    }
    if ((ch === '+' && next === '+') || (ch === '-' && next === '-')) {
      // Preserve the current context: prefix updates admit an operand, while
      // postfix updates leave the following slash as division.
      index += 2;
      afterMemberAccess = false;
      awaitingControlParen = false;
      awaitingBlock = false;
      statementBoundary = false;
      continue;
    }
    if (ch === '/' && canStartRegex) {
      const regexEnd = skipRegexLiteral(source, index);
      if (regexEnd < 0) return templateTerminator ? source.length : -1;
      index = regexEnd;
      canStartRegex = false;
      afterMemberAccess = false;
      awaitingControlParen = false;
      awaitingBlock = false;
      statementBoundary = false;
      continue;
    }
    if (ch === '/') {
      index += 1;
      canStartRegex = true;
      afterMemberAccess = false;
      awaitingControlParen = false;
      awaitingBlock = false;
      statementBoundary = false;
      continue;
    }
    if (ch === '{') {
      if (templateTerminator) depth += 1;
      const functionType = pendingFunctionBody?.inReturnType
        && (pendingFunctionBody.typeDepth > 0 || pendingFunctionBody.expectsType);
      const classType = awaitingClassBody?.inTypeParameters
        && (awaitingClassBody.typeDepth > 0 || awaitingClassBody.expectsType);
      if (functionType) pendingFunctionBody.typeDepth += 1;
      if (classType) awaitingClassBody.typeDepth += 1;
      const classBody = awaitingClassBody !== null && !classType
        && !awaitingClassBody.bodyOpen
        && controlParenStack.length === awaitingClassBody.parenDepth
        && bracketDepth === awaitingClassBody.bracketDepth
        && !awaitingClassBody.inTypeParameters && !awaitingClassBody.expectsType;
      const functionBody = pendingFunctionBody !== null && !functionType;
      const isBareBlock = statementBoundary && braceBlockStack.some((frame) => frame.isBlock);
      const isBlock = !functionType && !classType
        && (awaitingBlock || functionBody || classBody || isBareBlock);
      const endsStatement = functionBody ? pendingFunctionBody.endsStatement
        : classBody ? awaitingClassBody.endsStatement
          : (awaitingBlock ? awaitingBlockEndsStatement : isBareBlock);
      braceBlockStack.push({
        isBlock,
        endsStatement,
        typeOwner: functionType ? 'function' : classType ? 'class' : null,
        classOwner: classBody ? awaitingClassBody : null,
      });
      index += 1;
      canStartRegex = true;
      afterMemberAccess = false;
      awaitingControlParen = false;
      awaitingBlock = false;
      awaitingBlockEndsStatement = false;
      if (!functionType) pendingFunctionBody = null;
      awaitingFunctionDeclaration = false;
      if (classBody) awaitingClassBody.bodyOpen = true;
      statementBoundary = isBlock;
      continue;
    }
    if (ch === '}') {
      if (templateTerminator) {
        depth -= 1;
        index += 1;
        if (depth === 0) return index;
      } else {
        index += 1;
      }
      const closedBrace = braceBlockStack.pop();
      if (closedBrace?.typeOwner === 'function' && pendingFunctionBody) {
        pendingFunctionBody.typeDepth -= 1;
        if (pendingFunctionBody.typeDepth === 0) pendingFunctionBody.expectsType = false;
      }
      if (closedBrace?.typeOwner === 'class' && awaitingClassBody) {
        awaitingClassBody.typeDepth -= 1;
        if (awaitingClassBody.typeDepth === 0) awaitingClassBody.expectsType = false;
      }
      if (closedBrace?.classOwner) {
        const classContext = awaitingClassBodies.pop();
        if (classContext !== closedBrace.classOwner) return templateTerminator ? source.length : -1;
        awaitingClassBody = awaitingClassBodies.at(-1) ?? null;
      }
      canStartRegex = closedBrace?.endsStatement === true;
      afterMemberAccess = false;
      awaitingControlParen = false;
      awaitingBlock = false;
      awaitingBlockEndsStatement = false;
      statementBoundary = closedBrace?.endsStatement === true;
      continue;
    }
    if (ch === '(') {
      controlParenStack.push(awaitingControlParen
        ? { kind: 'control' }
        : awaitingFunctionParams && functionTypeParameterDepth === 0
          ? { kind: 'function', endsStatement: awaitingFunctionDeclaration }
          : { kind: 'paren' });
      awaitingControlParen = false;
      if (functionTypeParameterDepth === 0) {
        awaitingFunctionParams = false;
        awaitingFunctionDeclaration = false;
      }
      canStartRegex = true;
      afterMemberAccess = false;
      awaitingBlock = false;
      statementBoundary = false;
      index += 1;
      continue;
    }
    if (ch === ')') {
      const parenContext = controlParenStack.pop();
      const closesControlParen = parenContext?.kind === 'control';
      canStartRegex = closesControlParen;
      awaitingControlParen = false;
      // Keep a function body pending through parenthesized TypeScript return types.
      if (parenContext?.kind === 'function') {
        pendingFunctionBody = {
          endsStatement: parenContext.endsStatement,
          inReturnType: false,
          expectsType: false,
          typeDepth: 0,
        };
        awaitingBlock = true;
        awaitingBlockEndsStatement = parenContext.endsStatement;
      } else {
        awaitingBlock = parenContext !== undefined;
        awaitingBlockEndsStatement = closesControlParen;
      }
      afterMemberAccess = false;
      statementBoundary = false;
      index += 1;
      continue;
    }
    if (/\s/u.test(ch)) {
      index += 1;
      continue;
    }
    if (/[A-Za-z_$]/u.test(ch)) {
      let end = index + 1;
      while (/[A-Za-z0-9_$]/u.test(source[end] || '')) end += 1;
      const word = source.slice(index, end);
      const memberProperty = afterMemberAccess;
      canStartRegex = !memberProperty
        && /^(?:case|delete|do|else|in|instanceof|new|of|return|throw|typeof|void|yield|await)$/u.test(word);
      awaitingControlParen = (!memberProperty && /^(?:catch|for|if|switch|while|with)$/u.test(word))
        || (awaitingControlParen && word === 'await');
      awaitingBlock = !memberProperty && /^(?:catch|do|else|finally|try)$/u.test(word);
      awaitingBlockEndsStatement = awaitingBlock;
      if (!memberProperty && word === 'async') {
        awaitingAsyncFunction = true;
        asyncFunctionDeclaration = statementBoundary;
      } else if (!memberProperty && word === 'function') {
        awaitingFunctionParams = true;
        functionTypeParameterDepth = 0;
        awaitingFunctionDeclaration = awaitingAsyncFunction ? asyncFunctionDeclaration : statementBoundary;
        awaitingAsyncFunction = false;
      } else {
        awaitingAsyncFunction = false;
      }
      if (!memberProperty && word === 'class') {
        awaitingClassBody = {
          endsStatement: statementBoundary,
          parenDepth: controlParenStack.length,
          bracketDepth,
          inTypeParameters: false,
          inHeritageExpression: false,
          expectsType: false,
          typeDepth: 0,
          genericDepth: 0,
          bodyOpen: false,
        };
        awaitingClassBodies.push(awaitingClassBody);
      }
      if (pendingFunctionBody?.inReturnType) {
        pendingFunctionBody.expectsType = /^(?:asserts|extends|infer|is|keyof|new|readonly|typeof)$/u.test(word);
      }
      if (awaitingClassBody?.inTypeParameters) {
        awaitingClassBody.expectsType = word === 'extends';
      } else if (awaitingClassBody && !awaitingClassBody.bodyOpen && word === 'extends') {
        awaitingClassBody.inHeritageExpression = true;
      }
      statementBoundary = false;
      index = end;
      afterMemberAccess = false;
      continue;
    }
    if (source.startsWith('...', index)) {
      canStartRegex = true;
      afterMemberAccess = false;
      awaitingControlParen = false;
      awaitingBlock = false;
      statementBoundary = false;
      index += 3;
      continue;
    }
    if (source.startsWith('=>', index)) {
      canStartRegex = true;
      afterMemberAccess = false;
      awaitingControlParen = false;
      awaitingBlock = !pendingFunctionBody?.inReturnType;
      awaitingBlockEndsStatement = false;
      if (pendingFunctionBody?.inReturnType) pendingFunctionBody.expectsType = true;
      statementBoundary = false;
      index += 2;
      continue;
    }
    if (ch === '!') {
      if (next === '=') {
        index += source[index + 2] === '=' ? 3 : 2;
        canStartRegex = true;
      } else {
        // In TypeScript `value!` is postfix and preserves expression-ending
        // context; prefix `!value` preserves expression-starting context.
        index += 1;
      }
      afterMemberAccess = false;
      awaitingControlParen = false;
      awaitingBlock = false;
      statementBoundary = false;
      continue;
    }
    if ('([{,;:=?&|+\\-*%^~<>'.includes(ch)) {
      canStartRegex = true;
      afterMemberAccess = false;
      awaitingControlParen = false;
      awaitingBlock = false;
      statementBoundary = ch === ';' && braceBlockStack.some((frame) => frame.isBlock);
      if (awaitingFunctionParams) {
        if (ch === '<') functionTypeParameterDepth += 1;
        else if (ch === '>' && functionTypeParameterDepth > 0) functionTypeParameterDepth -= 1;
        else if (functionTypeParameterDepth === 0 && ch !== '*') awaitingFunctionParams = false;
      }
      if (ch === '[') {
        bracketDepth += 1;
        if (!templateTerminator) depth += 1;
      }
      if (pendingFunctionBody) {
        if (ch === ':' && !pendingFunctionBody.inReturnType) {
          pendingFunctionBody.inReturnType = true;
          pendingFunctionBody.expectsType = true;
        } else if (pendingFunctionBody.inReturnType) {
          if (ch === ':' || ch === '[' || ch === '<' || ch === '|' || ch === '&'
            || ch === '?' || ch === '=' || ch === '+' || ch === '*') {
            pendingFunctionBody.expectsType = true;
          } else if (ch === '>' || ch === ']') {
            pendingFunctionBody.expectsType = false;
          } else if (ch === ',' && pendingFunctionBody.typeDepth === 0) {
            pendingFunctionBody.expectsType = true;
          }
        }
      }
      const classTypeContext = awaitingClassBody && !awaitingClassBody.bodyOpen
        && (!awaitingClassBody.inHeritageExpression
          || (controlParenStack.length === awaitingClassBody.parenDepth
            && bracketDepth === awaitingClassBody.bracketDepth));
      if (classTypeContext) {
        if (ch === '<') {
          const nestedTypeArguments = awaitingClassBody.inTypeParameters;
          awaitingClassBody.inTypeParameters = true;
          awaitingClassBody.genericDepth += 1;
          awaitingClassBody.expectsType = nestedTypeArguments || awaitingClassBody.inHeritageExpression;
        } else if (ch === '>' && awaitingClassBody.inTypeParameters) {
          awaitingClassBody.genericDepth -= 1;
          if (awaitingClassBody.genericDepth <= 0) {
            awaitingClassBody.inTypeParameters = false;
            awaitingClassBody.expectsType = false;
          }
        } else if (awaitingClassBody.inTypeParameters) {
          awaitingClassBody.expectsType = ch === '=' || ch === ',' || ch === ':'
            || ch === '[' || ch === '|' || ch === '&' || ch === '?';
        }
      }
      index += 1;
      continue;
    }
    if (ch === '.') {
      canStartRegex = false;
      afterMemberAccess = true;
      awaitingControlParen = false;
      awaitingBlock = false;
      statementBoundary = false;
      index += 1;
      continue;
    }
    if (ch === ']') {
      if (bracketDepth > 0) bracketDepth -= 1;
      if (!templateTerminator) {
        if (depth === 0) return index + 1;
        depth -= 1;
        canStartRegex = false;
        afterMemberAccess = false;
        awaitingControlParen = false;
        awaitingBlock = false;
        statementBoundary = false;
        index += 1;
        continue;
      }
    }
    if (')]}'.includes(ch)) {
      canStartRegex = false;
      afterMemberAccess = false;
      awaitingControlParen = false;
      awaitingBlock = false;
      statementBoundary = false;
      index += 1;
      continue;
    }
    canStartRegex = false;
    afterMemberAccess = false;
    awaitingControlParen = false;
    awaitingBlock = false;
    statementBoundary = false;
    index += 1;
  }
  return templateTerminator ? source.length : -1;
}


export function skipTemplateExpression(source, offset) {
  return scanTypeScriptExpression(source, offset, '}');
}

export function computedPropertyKeyEnd(source, start) {
  if (source[start] !== '[') return -1;
  return scanTypeScriptExpression(source, start + 1, ']');
}
