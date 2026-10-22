/**
 * Lettore dei sorgenti TS di stringhe del corpus (i body in `content/blog-body`
 * e `content/blog-body-ch`, i meta): un solo decodificatore per ogni script che ha bisogno
 * del VALORE di un campo `blog.article.<id>.<campo>` senza un parser TS.
 *
 * I due backfill del registry (`backfill-article-cantons.mjs` e
 * `backfill-article-type.mjs`) ne avevano una copia ciascuno, identica riga per
 * riga: due copie di un decodificatore di escape possono divergere e leggere
 * body diversi dallo stesso file (review della PR 2312). La storia di
 * `unescape-ts-string.mjs`, qui accanto, e' la stessa classe di difetto gia'
 * pagata due volte: tre catene di `.replace()` indipendenti, due rotte.
 *
 * Senza dipendenze: i content gate di `main` girano senza `npm ci`.
 * Il decoder copre anche le forme esadecimali `\\xNN` e Unicode code-point
 * `\\u{...}`: un URL scritto con una di queste forme deve arrivare al parser
 * esattamente come il valore che il compilatore TS consegna a runtime.
 */

function hexCodePoint(raw) {
  if (!/^[0-9a-fA-F]+$/u.test(raw)) return null;
  const value = Number.parseInt(raw, 16);
  return value <= 0x10FFFF ? value : null;
}

function isLineTerminator(character) {
  return character === '\n' || character === '\r' || character === '\u2028' || character === '\u2029';
}

/** Decodifica un letterale TS statico che comincia a `i` (apice singolo, doppio o backtick). */
export function readTsStringLiteral(src, i) {
  const quote = src[i];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  let out = '';
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') {
      const n = src[j + 1];
      if (n === '\r' && src[j + 2] === '\n') {
        j += 3;
        continue;
      }
      if (n === '\n' || n === '\r' || n === '\u2028' || n === '\u2029') {
        j += 2;
        continue;
      }
      if (n === 'n') out += '\n';
      else if (n === 't') out += '\t';
      else if (n === 'r') out += '';
      else if (n === 'b') out += '\b';
      else if (n === 'f') out += '\f';
      else if (n === 'v') out += '\v';
      else if (n === '0' && !/[0-9]/u.test(src[j + 2] || '')) out += '\0';
      else if (n === 'x' && /^[0-9a-fA-F]{2}$/u.test(src.slice(j + 2, j + 4))) {
        out += String.fromCharCode(parseInt(src.slice(j + 2, j + 4), 16));
        j += 4;
        continue;
      } else if (n === 'u' && src[j + 2] === '{') {
        const close = src.indexOf('}', j + 3);
        const codePoint = close === -1 ? null : hexCodePoint(src.slice(j + 3, close));
        if (codePoint !== null && codePoint !== undefined) {
          out += String.fromCodePoint(codePoint);
          j = close + 1;
          continue;
        }
        out += n;
      } else if (n === 'u' && /^[0-9a-fA-F]{4}$/u.test(src.slice(j + 2, j + 6))) {
        out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
        j += 6;
        continue;
      } else out += n ?? '';
      j += 2;
      continue;
    }
    if (quote === '`' && c === '$' && src[j + 1] === '{') {
      throw new Error('Interpolated template literal is not supported in static article string source');
    }
    if (c === quote) return { value: out, end: j + 1 };
    if (quote === '`' && c === '$' && src[j + 1] === '{') {
      throw new Error('Interpolated template literal is not supported in static article fields');
    }
    out += c;
    j += 1;
  }
  return null;
}

/**
 * Tokenizza il sottoinsieme lessicale usato dai moduli dati del corpus. I commenti
 * non producono token; ogni letterale resta un singolo token. Anche i regex
 * literal sono un token unico: virgolette, parentesi quadre e slash nel pattern
 * non devono diventare codice o commenti del modulo. Un'interpolazione in
 * qualunque template del file rende il sorgente non statico, quindi si rifiuta
 * il file intero prima di estrarre qualsiasi chiave.
 */
const STATIC_LITERAL_QUOTES = new Set(['"', "'", '`']);
const REGEX_PREFIX_KEYWORDS = new Set([
  'await', 'break', 'case', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of', 'return',
  'throw', 'typeof', 'void', 'yield',
]);
const REGEX_PREFIX_PUNCTUATION = new Set([
  '(', '[', '{', ',', ':', ';', '=', '!', '?', '+', '-', '*', '%', '&', '|', '^', '~', '<', '>',
]);
const CONTROL_PAREN_KEYWORDS = new Set(['catch', 'for', 'if', 'switch', 'while', 'with']);
const BLOCK_BRACE_KEYWORDS = new Set([
  'catch', 'class', 'do', 'else', 'enum', 'finally', 'function', 'interface', 'module', 'namespace', 'static', 'try',
]);
const DECLARATION_BRACE_KEYWORDS = new Set(['class', 'enum', 'function', 'interface', 'module', 'namespace']);
const DECLARATION_PREFIX_KEYWORDS = new Set(['abstract', 'async', 'declare', 'default', 'export']);
const AMBIENT_BLOCK_KEYWORDS = new Set(['global']);
const TYPE_BODY_KEYWORDS = new Set(['class', 'enum', 'global', 'interface', 'module', 'namespace']);
const TYPE_CONTEXT_WORDS = new Set(['asserts', 'extends', 'infer', 'is', 'keyof', 'readonly', 'typeof', 'unique']);
const TYPE_ASSERTION_PREFIX_WORDS = new Set([
  'await', 'case', 'delete', 'else', 'return', 'throw', 'typeof', 'void', 'yield',
]);
const ASI_EXPRESSION_ENDS = new Set([
  'close-block', 'close-expression-block', 'close-object', 'close-paren', 'close-type-alias',
  'close-type-declaration', 'identifier', 'literal', 'postfix',
]);
const BLOCK_BRACE_PENDING_RESET = new Set(['(', ')', '[', ']', ',', ':', ';', '=']);

function isRegexLineTerminator(character) {
  return character === '\n' || character === '\r' || character === '\u2028' || character === '\u2029';
}

/** Salta un regex literal completo, incluse classi carattere ed escape. */
function skipRegexLiteral(src, offset) {
  let inCharacterClass = false;
  let i = offset + 1;

  while (i < src.length) {
    const character = src[i];
    if (character === '\\') {
      i += 2;
      continue;
    }
    if (isRegexLineTerminator(character)) return -1;
    if (character === '[') {
      inCharacterClass = true;
    } else if (character === ']' && inCharacterClass) {
      inCharacterClass = false;
    } else if (character === '/' && !inCharacterClass) {
      i += 1;
      while (/[A-Za-z]/u.test(src[i] || '')) i += 1;
      return i;
    }
    i += 1;
  }

  return -1;
}

/**
 * TypeScript's angle assertions start an expression, while relational
 * comparisons start after an expression. Use that distinction when the
 * assertion's type begins with a named or composed type (`<Foo & {...}>`).
 */
function looksLikeTypeAssertionPosition(src, offset, statementStart) {
  let cursor = offset - 1;
  while (cursor >= 0 && /\s/u.test(src[cursor])) cursor -= 1;
  if (cursor < 0) return true;
  if (src[cursor] === '}' && statementStart) return true;
  if ('([{,;:=!?&|+-*/%^~>'.includes(src[cursor])) return true;
  const wordEnd = cursor + 1;
  while (cursor >= 0 && /[A-Za-z0-9_$]/u.test(src[cursor])) cursor -= 1;
  const previousWord = src.slice(cursor + 1, wordEnd);
  return TYPE_ASSERTION_PREFIX_WORDS.has(previousWord);
}

/** Detect a generic type argument list without treating an ordinary `<` comparison as one. */
function looksLikeGenericStart(src, offset, statementStart = false) {
  let angleDepth = 1;
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let cursor = offset + 1; cursor < src.length; cursor += 1) {
    const character = src[cursor];
    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      cursor += 1;
      while (cursor < src.length) {
        if (src[cursor] === '\\') {
          cursor += 1;
        } else if (src[cursor] === quote) {
          break;
        }
        cursor += 1;
      }
      continue;
    }
    if (character === '/' && src[cursor + 1] === '/') {
      cursor += 2;
      while (cursor < src.length && src[cursor] !== '\n' && src[cursor] !== '\r') cursor += 1;
      continue;
    }
    if (character === '/' && src[cursor + 1] === '*') {
      const close = src.indexOf('*/', cursor + 2);
      if (close < 0) return false;
      cursor = close + 1;
      continue;
    }
    if (character === '/') {
      const regexEnd = skipRegexLiteral(src, cursor);
      if (regexEnd >= 0) {
        cursor = regexEnd - 1;
        continue;
      }
    }
    if (character === '{') braceDepth += 1;
    else if (character === '}' && braceDepth > 0) braceDepth -= 1;
    else if (character === '[') bracketDepth += 1;
    else if (character === ']' && bracketDepth > 0) bracketDepth -= 1;
    else if (character === '(') parenDepth += 1;
    else if (character === ')' && parenDepth > 0) parenDepth -= 1;
    else if (character === '<') angleDepth += 1;
    else if (character === '>' && src[cursor - 1] !== '=' && braceDepth === 0
      && bracketDepth === 0 && parenDepth === 0) {
      angleDepth -= 1;
      if (angleDepth === 0) {
        let next = cursor + 1;
        while (/\s/u.test(src[next] || '')) next += 1;
        const nextWord = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(src.slice(next))?.[0];
        const typeAssertionOperand = Boolean(
          nextWord
          || src[next] === '{'
          || src[next] === '['
          || src[next] === '('
          || STATIC_LITERAL_QUOTES.has(src[next])
          || /[0-9]/u.test(src[next] || '')
          || ['!', '+', '-', '~', '/'].includes(src[next]),
        );
        const typeAssertion = Boolean(
          typeAssertionOperand && looksLikeTypeAssertionPosition(src, offset, statementStart),
        );
        return src[next] === '(' || src.startsWith('=>', next) || src[next] === ';'
          || src[next] === ',' || src[next] === ')' || src[next] === '.' || src[next] === '|'
          || src[next] === '&' || src[next] === '=' || src[next] === '[' || src[next] === '!'
          || src.startsWith('?.', next) || src.startsWith('??', next) || src.startsWith('&&', next)
          || src.startsWith('||', next) || src[next] === '+' || src[next] === '-'
          || src[next] === '*' || src[next] === '/' || src[next] === '%' || src[next] === '?'
          || nextWord === 'as' || nextWord === 'satisfies' || nextWord === 'instanceof'
          || nextWord === 'in' || typeAssertion;
      }
    }
  }
  return false;
}

function skipParserTrivia(src, start) {
  let cursor = start;
  while (cursor < src.length) {
    if (/\s/u.test(src[cursor])) {
      cursor += 1;
      continue;
    }
    if (src.startsWith('//', cursor)) {
      cursor += 2;
      while (cursor < src.length && src[cursor] !== '\n' && src[cursor] !== '\r') cursor += 1;
      continue;
    }
    if (src.startsWith('/*', cursor)) {
      const close = src.indexOf('*/', cursor + 2);
      if (close < 0) return src.length;
      cursor = close + 2;
      continue;
    }
    break;
  }
  return cursor;
}

function staticSourceTokens(src) {
  const tokens = [];
  let i = 0;
  let canStartRegex = true;
  let lastSignificant = null;
  let lastIdentifier = null;
  const parenContexts = [];
  const braceContexts = [];
  let blockBracePending = null;
  let statementStart = true;
  let labelCandidate = false;
  let caseLabelPending = false;
  let caseLabelOrigin = null;
  const conditionalOrigins = [];
  let bracketDepth = 0;
  let genericAngleDepth = 0;
  let typeAnnotationPending = false;
  let returnTypeActive = false;
  let parameterTypeActive = false;
  let typeAssertionActive = false;
  let typeAliasPending = false;
  let typeAliasActive = false;
  let typeBodyPending = false;
  let declarationPrefix = false;
  let moduleStatementKind = null;
  let moduleNamedActive = false;
  let moduleSourcePending = false;
  let lineTerminatorPending = false;

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (/\s/u.test(c)) {
      if (isRegexLineTerminator(c)) lineTerminatorPending = true;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      i += 2;
      while (i < src.length && !isLineTerminator(src[i])) i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) throw new Error('Unterminated comment in static article source');
      if (/[\n\r\u2028\u2029]/u.test(src.slice(i + 2, end))) lineTerminatorPending = true;
      i = end + 2;
      continue;
    }
    if (lineTerminatorPending) {
      if (parenContexts.length === 0 && bracketDepth === 0 && !braceContexts.includes('object')
        && ASI_EXPRESSION_ENDS.has(lastSignificant)) {
        statementStart = true;
        if (lastSignificant === 'close-expression-block' || typeAnnotationPending
          || parameterTypeActive || returnTypeActive || typeAliasActive || typeAssertionActive) {
          canStartRegex = true;
        }
      }
      lineTerminatorPending = false;
    }
    if (c === "'" || c === '"' || c === '`') {
      const literal = readTsStringLiteral(src, i);
      if (!literal) throw new Error('Unterminated string literal in static article source');
      tokens.push({
        type: braceContexts.includes('type-object') || braceContexts.includes('type-alias-object')
          || braceContexts.includes('type-declaration') || moduleNamedActive
          || moduleSourcePending || braceContexts.includes('block') || braceContexts.includes('expression')
          || conditionalOrigins.length > 0
          ? 'expression-string' : 'string',
        value: literal.value,
      });
      i = literal.end;
      if (moduleSourcePending) {
        canStartRegex = true;
        statementStart = true;
        moduleSourcePending = false;
        moduleStatementKind = null;
        typeAliasPending = false;
        typeAliasActive = false;
        typeAssertionActive = false;
        typeAnnotationPending = false;
        parameterTypeActive = false;
        returnTypeActive = false;
      } else {
        canStartRegex = false;
        statementStart = false;
      }
      lastSignificant = 'literal';
      lastIdentifier = null;
      labelCandidate = false;
      declarationPrefix = false;
      typeAnnotationPending = false;
      continue;
    }

    if (/[A-Za-z_$]/u.test(c)) {
      let end = i + 1;
      while (/[A-Za-z0-9_$]/u.test(src[end] || '')) end += 1;
      const word = src.slice(i, end);
      const previousSignificant = lastSignificant;
      const wasStatementStart = statementStart;
      const hadDeclarationPrefix = declarationPrefix;
      const hadTypeAliasPending = typeAliasPending;
      const hadModuleStatementKind = moduleStatementKind;
      const member = previousSignificant === 'dot' || previousSignificant === 'private-prefix';
      typeAnnotationPending = false;
      for (let position = i; position < end; position += 1) {
        tokens.push({ type: 'punctuation', value: src[position] });
      }
      canStartRegex = !member && REGEX_PREFIX_KEYWORDS.has(word);
      lastIdentifier = { value: word, member };
      lastSignificant = 'identifier';
      if (!member && BLOCK_BRACE_KEYWORDS.has(word)) {
        const declarationInExpression = DECLARATION_BRACE_KEYWORDS.has(word)
          && !(wasStatementStart || hadDeclarationPrefix);
        blockBracePending = declarationInExpression ? 'expression' : 'block';
        declarationPrefix = false;
        typeBodyPending = TYPE_BODY_KEYWORDS.has(word);
      } else if (!member && hadDeclarationPrefix && AMBIENT_BLOCK_KEYWORDS.has(word)) {
        blockBracePending = 'block';
        declarationPrefix = false;
        typeBodyPending = true;
      } else if (!member && DECLARATION_PREFIX_KEYWORDS.has(word)) {
        declarationPrefix = wasStatementStart || hadDeclarationPrefix;
      } else if (!member) {
        declarationPrefix = false;
      }
      if (!member && wasStatementStart && (word === 'import' || word === 'export')) {
        moduleStatementKind = word;
        moduleSourcePending = word === 'import';
      } else if (!moduleNamedActive && moduleStatementKind && word === 'from') {
        moduleSourcePending = true;
      } else if (!moduleNamedActive && moduleStatementKind
        && ['const', 'let', 'var', 'function', 'class', 'interface', 'namespace', 'enum', 'default'].includes(word)) {
        moduleStatementKind = null;
        moduleSourcePending = false;
      }
      if (!member && !moduleNamedActive && (word === 'as' || word === 'satisfies')) {
        typeAssertionActive = true;
        typeAnnotationPending = true;
      }
      if (!member && TYPE_CONTEXT_WORDS.has(word)
        && (returnTypeActive || parameterTypeActive || typeAliasActive || typeAssertionActive)) {
        typeAnnotationPending = true;
      }
      const moduleTypeSpecifier = moduleNamedActive
        && (moduleStatementKind === 'import' || moduleStatementKind === 'export');
      if (!member && word === 'type' && (wasStatementStart || hadDeclarationPrefix) && !moduleTypeSpecifier) {
        typeAliasPending = true;
        typeAliasActive = false;
      } else if (!member && hadTypeAliasPending && !moduleTypeSpecifier) {
        typeAliasPending = true;
      }
      const switchDefault = word === 'default' && wasStatementStart
        && braceContexts[braceContexts.length - 1] === 'block' && !hadModuleStatementKind;
      if (!member && ((word === 'case' && wasStatementStart) || switchDefault)) {
        caseLabelPending = true;
        caseLabelOrigin = {
          paren: parenContexts.length,
          brace: braceContexts.length,
          bracket: bracketDepth,
        };
      }
      labelCandidate = !member && wasStatementStart;
      statementStart = false;
      i = end;
      continue;
    }

    if (c === '/' && canStartRegex) {
      const end = skipRegexLiteral(src, i);
      if (end < 0) throw new Error('Unterminated regex literal in static article source');
      tokens.push({ type: 'regex' });
      i = end;
      canStartRegex = false;
      lastSignificant = 'literal';
      lastIdentifier = null;
      blockBracePending = null;
      statementStart = false;
      labelCandidate = false;
      declarationPrefix = false;
      continue;
    }

    // A division slash consumes the expression on its left. Its right-hand
    // operand may start with a regex literal, so keep that transition explicit
    // instead of deriving it one punctuation character at a time.
    if (c === '/' && !canStartRegex) {
      tokens.push({ type: 'punctuation', value: c });
      i += 1;
      canStartRegex = true;
      lastSignificant = 'division';
      lastIdentifier = null;
      blockBracePending = null;
      statementStart = false;
      labelCandidate = false;
      declarationPrefix = false;
      continue;
    }

    if (c === '(') {
      tokens.push({ type: 'punctuation', value: c });
      const controlParen = Boolean(
        lastIdentifier && !lastIdentifier.member && CONTROL_PAREN_KEYWORDS.has(lastIdentifier.value),
      );
      const surroundingBrace = braceContexts[braceContexts.length - 1];
      const methodCandidate = !controlParen
        && !blockBracePending
        && lastSignificant === 'identifier'
        && lastIdentifier
        && !lastIdentifier.member
        && (surroundingBrace === 'object' || surroundingBrace === 'block'
          || surroundingBrace === 'type-declaration');
      parenContexts.push({
        control: controlParen,
        blockKind: methodCandidate ? 'block' : blockBracePending,
        typeContext: typeAnnotationPending,
      });
      i += 1;
      canStartRegex = true;
      lastSignificant = 'open-paren';
      lastIdentifier = null;
      if (!blockBracePending) blockBracePending = null;
      statementStart = false;
      labelCandidate = false;
      continue;
    }

    if (c === ')') {
      tokens.push({ type: 'punctuation', value: c });
      const parenContext = parenContexts.pop() || {};
      while (conditionalOrigins.length > 0) {
        const origin = conditionalOrigins[conditionalOrigins.length - 1];
        if (origin.phase !== 'after-colon' || parenContexts.length !== origin.paren
          || braceContexts.length !== origin.brace || bracketDepth !== origin.bracket) break;
        conditionalOrigins.pop();
      }
      const controlParen = parenContext.control === true;
      const typeParen = parenContext.typeContext === true;
      i += 1;
      canStartRegex = controlParen;
      lastSignificant = 'close-paren';
      lastIdentifier = null;
      blockBracePending = controlParen ? 'block' : (parenContext.blockKind || 'expression');
      statementStart = controlParen;
      labelCandidate = false;
      const typeArrow = typeParen && /^\s*=>/u.test(src.slice(i));
      if (!typeArrow) typeAnnotationPending = false;
      if (!typeParen) parameterTypeActive = false;
      continue;
    }

    if (c === '=' && next === '>') {
      tokens.push({ type: 'punctuation', value: c }, { type: 'punctuation', value: next });
      i += 2;
      canStartRegex = true;
      lastSignificant = 'arrow';
      lastIdentifier = null;
      if (!typeAnnotationPending) blockBracePending = 'expression';
      statementStart = false;
      labelCandidate = false;
      declarationPrefix = false;
      continue;
    }

    // Postfix increment/decrement terminate an expression. Treating either
    // character as a prefix operator would make the following division slash
    // look like the start of a regex literal and expose its body as source.
    if ((c === '+' && next === '+') || (c === '-' && next === '-')) {
      tokens.push({ type: 'punctuation', value: c }, { type: 'punctuation', value: next });
      i += 2;
      canStartRegex = false;
      lastSignificant = 'postfix';
      lastIdentifier = null;
      blockBracePending = null;
      statementStart = false;
      labelCandidate = false;
      declarationPrefix = false;
      continue;
    }

    // TypeScript's postfix non-null assertion has the same expression-ending
    // effect. A leading `!` remains a prefix context through the generic path.
    if (c === '!' && !canStartRegex) {
      tokens.push({ type: 'punctuation', value: c });
      i += 1;
      canStartRegex = false;
      lastSignificant = 'postfix';
      lastIdentifier = null;
      blockBracePending = null;
      statementStart = false;
      labelCandidate = false;
      declarationPrefix = false;
      continue;
    }

    if (c === '{') {
      const pendingBraceKind = blockBracePending;
      const moduleBrace = Boolean(moduleStatementKind && !moduleNamedActive && (
        lastIdentifier?.value === 'import' || lastIdentifier?.value === 'export'
          || lastIdentifier?.value === 'type' || lastSignificant === 'comma'
      ));
      const typeDeclarationBrace = typeBodyPending && pendingBraceKind;
      const typeBrace = genericAngleDepth > 0 || typeAnnotationPending || typeDeclarationBrace;
      const typeAliasBrace = typeAliasActive
        && !braceContexts.includes('type-alias-object')
        && typeBrace;
      const implicitBlock = statementStart;
      const braceKind = moduleBrace || typeDeclarationBrace ? 'block' : typeBrace ? null : pendingBraceKind
        || (lastSignificant === 'close-paren' ? 'expression' : null)
        || (lastSignificant === 'arrow' ? 'expression' : null)
        || (lastSignificant === 'open-block' && statementStart ? 'block' : null)
        || (lastSignificant === 'semicolon' || lastSignificant === 'close-block' ? 'block' : null)
        || (implicitBlock ? 'block' : null);
      const isBlockBrace = Boolean(braceKind);
      tokens.push({ type: 'punctuation', value: c });
      braceContexts.push(moduleBrace ? 'block'
        : typeDeclarationBrace ? 'type-declaration'
          : typeAliasBrace ? 'type-alias-object'
            : typeBrace ? 'type-object' : isBlockBrace ? braceKind : 'object');
      i += 1;
      canStartRegex = true;
      lastSignificant = isBlockBrace ? 'open-block' : 'open-object';
      lastIdentifier = null;
      blockBracePending = isBlockBrace ? null : typeBrace ? pendingBraceKind : null;
      if (moduleBrace) {
        moduleNamedActive = true;
        moduleSourcePending = false;
      }
      if (typeDeclarationBrace) typeBodyPending = false;
      statementStart = isBlockBrace;
      labelCandidate = false;
      if (!isBlockBrace && !typeDeclarationBrace) typeAnnotationPending = false;
      if (!typeBrace) returnTypeActive = false;
      continue;
    }

    if (c === '}') {
      const braceContext = braceContexts.pop();
      while (conditionalOrigins.length > 0) {
        const origin = conditionalOrigins[conditionalOrigins.length - 1];
        if (origin.phase !== 'after-colon' || parenContexts.length !== origin.paren
          || braceContexts.length !== origin.brace || bracketDepth !== origin.bracket) break;
        conditionalOrigins.pop();
      }
      tokens.push({ type: 'punctuation', value: c });
      i += 1;
      const nextAfterBrace = skipParserTrivia(src, i);
      const returnTypeBodyFollows = braceContext === 'type-object'
        && returnTypeActive
        && !braceContexts.includes('type-object')
        && !braceContexts.includes('type-alias-object')
        && (src[nextAfterBrace] === '{' || src.startsWith('=>', nextAfterBrace));
      if (returnTypeBodyFollows) {
        returnTypeActive = false;
        typeAnnotationPending = false;
      }
      const moduleBlock = moduleNamedActive && braceContext === 'block';
      canStartRegex = braceContext === 'block' || braceContext === 'type-declaration';
      lastSignificant = braceContext === 'block' ? 'close-block'
        : braceContext === 'type-declaration' ? 'close-type-declaration'
        : braceContext === 'expression' ? 'close-expression-block' : 'close-object';
      lastIdentifier = null;
      if (moduleBlock) {
        moduleNamedActive = false;
        moduleSourcePending = true;
        if (moduleStatementKind === 'export' && typeAliasPending) {
          typeAliasPending = false;
          typeAliasActive = false;
        }
        statementStart = true;
      }
      if (braceContext === 'type-alias-object' && !braceContexts.includes('type-alias-object')) {
        canStartRegex = true;
        lastSignificant = 'close-type-alias';
        statementStart = true;
        blockBracePending = null;
        typeAnnotationPending = typeAliasActive || typeAssertionActive || parameterTypeActive || returnTypeActive;
      } else if (braceContext === 'type-object') {
        typeAnnotationPending = typeAliasActive || typeAssertionActive || parameterTypeActive || returnTypeActive;
      } else if (braceContext !== 'type-object' && braceContext !== 'type-alias-object'
        && braceContext !== 'type-declaration'
        && !braceContexts.includes('type-object') && !braceContexts.includes('type-alias-object')) {
        blockBracePending = null;
      }
      statementStart = moduleBlock || braceContext === 'block' || braceContext === 'type-declaration'
        || (braceContext === 'type-alias-object' && !braceContexts.includes('type-alias-object'));
      labelCandidate = false;
      if (braceContext === 'block') {
        caseLabelPending = false;
        caseLabelOrigin = null;
      }
      continue;
    }

    // Keep every significant source character so a key only matches an actual
    // adjacent `string : string` property, not text spanning intervening code.
    tokens.push({ type: 'punctuation', value: c });
    i += 1;
    canStartRegex = REGEX_PREFIX_PUNCTUATION.has(c);
    const inObject = braceContexts[braceContexts.length - 1] === 'object'
      && !braceContexts.includes('type-object')
      && !braceContexts.includes('type-alias-object')
      && !braceContexts.includes('type-declaration');
    const insideTypeObject = braceContexts.includes('type-object')
      || braceContexts.includes('type-alias-object') || braceContexts.includes('type-declaration');
    if (c === '[') bracketDepth += 1;
    if (c === ']' && bracketDepth > 0) bracketDepth -= 1;
    const startsTypeAlias = c === '=' && typeAliasPending;
    if (startsTypeAlias) {
      typeAliasPending = false;
      typeAliasActive = true;
    }
    if (c === '<' && (typeAliasPending || typeAliasActive
      || looksLikeGenericStart(src, i - 1, statementStart))) genericAngleDepth += 1;
    if (c === '>' && genericAngleDepth > 0) genericAngleDepth -= 1;
    const atCaseOrigin = caseLabelPending && caseLabelOrigin
      && parenContexts.length === caseLabelOrigin.paren
      && braceContexts.length === caseLabelOrigin.brace
      && bracketDepth === caseLabelOrigin.bracket;
    const previousCharacter = src[i - 2];
    const optionalParameterMarker = c === '?' && next === ':'
      && parenContexts.length > 0 && lastSignificant === 'identifier';
    const isConditional = c === '?'
      && previousCharacter !== '?' && next !== '.' && next !== '?'
      && !optionalParameterMarker;
    if (c === ':' && conditionalOrigins.length > 0) {
      const completed = conditionalOrigins[conditionalOrigins.length - 1];
      if (completed.phase === 'after-colon'
        && parenContexts.length === completed.paren
        && braceContexts.length === completed.brace
        && bracketDepth === completed.bracket) {
        conditionalOrigins.pop();
      }
    }
    const conditionalOrigin = conditionalOrigins[conditionalOrigins.length - 1];
    const closesCaseConditional = c === ':' && conditionalOrigin
      && conditionalOrigin.phase === 'pending'
      && parenContexts.length === conditionalOrigin.paren
      && braceContexts.length === conditionalOrigin.brace
      && bracketDepth === conditionalOrigin.bracket;
    if (isConditional) {
      conditionalOrigins.push({
        paren: parenContexts.length,
        brace: braceContexts.length,
        bracket: bracketDepth,
        phase: 'pending',
      });
    }
    const returnTypeStart = c === ':'
      && (blockBracePending === 'block' || blockBracePending === 'expression')
      && lastSignificant === 'close-paren'
      && !caseLabelPending
      && !atCaseOrigin;
    const parameterTypeColon = c === ':'
      && !inObject
      && !insideTypeObject
      && lastSignificant === 'identifier'
      && !closesCaseConditional
      && !conditionalOrigin
      && !labelCandidate;
    const optionalTypeColon = c === ':'
      && !inObject
      && !insideTypeObject
      && previousCharacter === '?'
      && !closesCaseConditional
      && !conditionalOrigin
      && !labelCandidate;
    const annotationColon = parameterTypeColon || optionalTypeColon;
    const opensLabeledBlock = c === ':' && !inObject
      && !closesCaseConditional
      && (labelCandidate || atCaseOrigin);
    lastSignificant = c === '.' ? 'dot'
      : c === ';' ? 'semicolon'
        : c === ',' ? 'comma'
          : c === '#' ? 'private-prefix' : 'punctuation';
    lastIdentifier = null;
    if (c === ':') {
      if (closesCaseConditional) {
        conditionalOrigin.phase = 'after-colon';
      } else if (opensLabeledBlock) {
        blockBracePending = 'block';
      } else if (!returnTypeStart && !insideTypeObject) {
        blockBracePending = null;
      }
      statementStart = opensLabeledBlock;
      typeAnnotationPending = returnTypeStart || annotationColon;
      if (returnTypeStart) returnTypeActive = true;
      else if (!insideTypeObject) returnTypeActive = false;
      if (annotationColon) parameterTypeActive = true;
      else if (!insideTypeObject) parameterTypeActive = false;
      if (opensLabeledBlock) {
        caseLabelPending = false;
        caseLabelOrigin = null;
      }
    } else {
      if (BLOCK_BRACE_PENDING_RESET.has(c) && !insideTypeObject) blockBracePending = null;
      statementStart = c === ';';
      labelCandidate = false;
      if (c === ';') {
        caseLabelPending = false;
        caseLabelOrigin = null;
        conditionalOrigins.length = 0;
        if (!insideTypeObject) {
          typeAliasPending = false;
          typeAliasActive = false;
          typeAssertionActive = false;
          typeBodyPending = false;
          moduleStatementKind = null;
          moduleNamedActive = false;
          moduleSourcePending = false;
          if (genericAngleDepth > 0 && parenContexts.length === 0 && bracketDepth === 0) {
            genericAngleDepth = 0;
          }
        }
      }
      if (startsTypeAlias) {
        typeAnnotationPending = true;
      } else if ((returnTypeActive || parameterTypeActive || typeAliasActive || typeAssertionActive)
        && ['|', '&', '(', '[', '?'].includes(c)) {
        typeAnnotationPending = true;
      } else if (c === '>' && genericAngleDepth === 0) {
        typeAnnotationPending = false;
      } else if (c === ']') {
        typeAnnotationPending = false;
      } else if (c !== '<' && c !== '>' && c !== '[') {
        typeAnnotationPending = false;
      }
      if (c !== '<' && c !== '>') declarationPrefix = false;
    }
    if (c === ',' && conditionalOrigins.length > 0) {
      const completed = conditionalOrigins[conditionalOrigins.length - 1];
      if (completed.phase === 'after-colon'
        && parenContexts.length === completed.paren
        && braceContexts.length === completed.brace
        && bracketDepth === completed.bracket) {
        conditionalOrigins.pop();
      }
    }
  }

  return tokens;
}

/**
 * Le chiavi fra parentesi quadre sono espressioni, anche quando contengono un
 * solo letterale. Non possono quindi contribuire a una mappa statica: se le
 * ignorassimo, il chiamante riceverebbe una mappa parziale. La stessa guardia
 * copre i metodi e gli accessor con chiave computata.
 */
function assertNoComputedPropertyKeys(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type !== 'punctuation' || token.value !== '[') continue;

    const previous = tokens[i - 1];
    const startsProperty = !previous || (
      previous.type === 'punctuation' && (previous.value === '{' || previous.value === ',')
    );

    let depth = 1;
    let end = i + 1;
    while (end < tokens.length && depth > 0) {
      const current = tokens[end];
      if (current.type === 'punctuation' && current.value === '[') depth += 1;
      if (current.type === 'punctuation' && current.value === ']') depth -= 1;
      end += 1;
    }
    if (depth !== 0) throw new Error('Unterminated computed article map key');

    const next = tokens[end];
    const afterOptionalMarker = next?.type === 'punctuation' && next.value === '?'
      ? tokens[end + 1]
      : next;
    if (!startsProperty && !(afterOptionalMarker?.type === 'punctuation' && afterOptionalMarker.value === '(')) {
      continue;
    }
    if (afterOptionalMarker?.type === 'punctuation' && afterOptionalMarker.value === ':') {
      throw new Error('Computed article map keys are not supported in static article sources');
    }
    if (afterOptionalMarker?.type === 'punctuation' && afterOptionalMarker.value === '(') {
      throw new Error('Computed article map methods and accessors are not supported in static article sources');
    }
  }
}

/** Rifiuta membri che il lettore non puo' materializzare senza eseguire codice. */
function assertNoDynamicObjectMembers(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const next = tokens[i + 1];
    const nextNext = tokens[i + 2];

    if (token.type === 'punctuation' && token.value === '.' &&
      next?.type === 'punctuation' && next.value === '.' &&
      nextNext?.type === 'punctuation' && nextNext.value === '.') {
      throw new Error('Spread members are not supported in static article sources');
    }

    if (token.type === 'string' && token.value.startsWith('blog.article.') &&
      next?.type === 'punctuation' && next.value === '(') {
      throw new Error('Article map methods and accessors are not supported in static article sources');
    }
  }
}

/** Tutte le coppie `'chiave': <letterale>` di un sorgente TS di stringhe. */
export function readTsStringMap(src) {
  const tokens = staticSourceTokens(src);
  assertNoDynamicObjectMembers(tokens);
  assertNoComputedPropertyKeys(tokens);
  const out = new Map();
  for (let i = 0; i < tokens.length; i += 1) {
    const key = tokens[i];
    const separator = tokens[i + 1];
    if (key.type !== 'string' || !key.value.startsWith('blog.article.') || !separator ||
      separator.type !== 'punctuation' || separator.value !== ':') continue;
    const value = tokens[i + 2];
    if (!value || value.type !== 'string') {
      throw new Error(`Non-static value for article field ${key.value}`);
    }

    const end = tokens[i + 3];
    if (end && !(end.type === 'punctuation' && (end.value === ',' || end.value === '}'))) {
      throw new Error(`Unexpected token after static article field ${key.value}`);
    }

    out.set(key.value, value.value);
    i += 2;
  }
  return out;
}
