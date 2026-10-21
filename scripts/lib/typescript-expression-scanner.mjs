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

/**
 * Skip a JavaScript/TypeScript expression up to its matching `}` or `]`.
 * The small lexer tracks regex-vs-division context so delimiters inside regex
 * literals, strings, comments, template strings, and declaration bodies do not
 * terminate the containing expression.
 */
function scanTypeScriptExpression(source, offset, terminator) {
  const templateTerminator = terminator === '}';
  let depth = templateTerminator ? 1 : 0;
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
        : awaitingFunctionParams
          ? { kind: 'function', endsStatement: awaitingFunctionDeclaration }
          : { kind: 'paren' });
      awaitingControlParen = false;
      awaitingFunctionParams = false;
      awaitingFunctionDeclaration = false;
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
        && /^(?:case|delete|do|else|in|instanceof|of|return|throw|typeof|void|yield|await)$/u.test(word);
      awaitingControlParen = (!memberProperty && /^(?:catch|for|if|switch|while|with)$/u.test(word))
        || (awaitingControlParen && word === 'await');
      awaitingBlock = !memberProperty && /^(?:catch|do|else|finally|try)$/u.test(word);
      awaitingBlockEndsStatement = awaitingBlock;
      if (!memberProperty && word === 'async') {
        awaitingAsyncFunction = true;
        asyncFunctionDeclaration = statementBoundary;
      } else if (!memberProperty && word === 'function') {
        awaitingFunctionParams = true;
        awaitingFunctionDeclaration = awaitingAsyncFunction ? asyncFunctionDeclaration : statementBoundary;
        awaitingAsyncFunction = false;
      } else {
        awaitingAsyncFunction = false;
      }
      if (!memberProperty && word === 'class') {
        awaitingClassBody = {
          endsStatement: statementBoundary,
          parenDepth: controlParenStack.length,
          inTypeParameters: false,
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
      if (!['*', '<', '>'].includes(ch)) awaitingFunctionParams = false;
      if (ch === '[' && !templateTerminator) depth += 1;
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
      if (awaitingClassBody) {
        if (ch === '<') {
          const nestedTypeArguments = awaitingClassBody.inTypeParameters;
          awaitingClassBody.inTypeParameters = true;
          awaitingClassBody.genericDepth += 1;
          awaitingClassBody.expectsType = nestedTypeArguments;
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
    if (ch === ']' && !templateTerminator) {
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
