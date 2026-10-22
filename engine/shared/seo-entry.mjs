/**
 * Lexical, balanced resolver for generated SEO entries.
 *
 * This module lives under the engine subtree because that subtree is mirrored
 * to the site. Corpus scripts use the compatibility re-export at
 * `scripts/lib/seo-entry.mjs`; the implementation must remain self-contained
 * so a mirrored engine consumer never imports a corpus-only helper.
 */

const CLOSING = { '{': '}', '[': ']', '(': ')' };
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Find the closing delimiter for the one at `openIdx`, ignoring strings,
 * comments, and regular-expression literals. Returns `-1` when unclosed.
 */
function matchingDelimiter(src, openIdx) {
  const open = src[openIdx];
  const close = CLOSING[open];
  if (!close) throw new Error(`matchingDelimiter: '${open}' non è un delimitatore di apertura`);
  let depth = 0;
  let quote = null;
  // Track code tokens in the forward scan. A backward search cannot tell a
  // nested `/*` marker from the start of the block comment it is inside.
  let previousToken = null;
  let tokenBeforePrevious = null;
  const delimiterStack = [];
  const controlParenthesisKeywords = new Set(['if', 'while', 'for', 'with', 'switch', 'catch']);
  const rememberToken = (kind, value) => {
    tokenBeforePrevious = previousToken;
    previousToken = { kind, value };
  };

  const isRegexPrefixPunctuation = token => token?.kind === 'punct'
    && '([{=,:;!?&|+\-*%^~<>/'.includes(token.value);
  const isRegexPrefixBoundary = token => token?.kind === 'control-close'
    || isRegexPrefixPunctuation(token);
  const isRegexPrefixKeyword = token => token?.kind === 'word'
    && /^(?:return|throw|case|break|continue|debugger|default|delete|void|typeof|instanceof|in|of|yield|await|else|do|new)$/.test(token.value)
    && !['.', '#'].includes(tokenBeforePrevious?.value);

  const canStartRegex = () => {
    if (previousToken === null) return true;
    return isRegexPrefixBoundary(previousToken) || isRegexPrefixKeyword(previousToken);
  };

  const skipRegex = (start) => {
    let inClass = false;
    for (let i = start + 1; i < src.length; i += 1) {
      if (src[i] === '\\') { i += 1; continue; }
      if ('\n\r\u2028\u2029'.includes(src[i])) return start;
      if (src[i] === '[') { inClass = true; continue; }
      if (src[i] === ']' && inClass) { inClass = false; continue; }
      if (src[i] === '/' && !inClass) {
        // A second slash is a line comment, not a regex terminator. Treat the
        // ambiguous literal as unclosed so a hidden bracket cannot be used as
        // an entry boundary.
        if (src[i + 1] === '/') return -1;
        while (/[A-Za-z]/.test(src[i + 1] || '')) i += 1;
        return i;
      }
    }
    return -1;
  };

  for (let i = openIdx; i < src.length; i += 1) {
    const ch = src[i];
    if (quote !== null) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      let end = i + 2;
      while (end < src.length && !'\n\r\u2028\u2029'.includes(src[end])) end += 1;
      i = end - 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (/\s/.test(ch)) continue;
    if (ch === '/' && canStartRegex()) {
      const end = skipRegex(i);
      if (end === -1) return -1;
      if (end === i) {
        rememberToken('punct', '/');
        continue;
      }
      rememberToken('literal', 'regex');
      i = end;
      continue;
    }
    if (ch === '!' && src[i + 1] !== '=') {
      // A postfix non-null assertion ends an expression; a prefix bang starts
      // one. Keep the distinction so a following slash is classified safely.
      rememberToken(isRegexPrefixBoundary(previousToken) || isRegexPrefixKeyword(previousToken)
        ? 'punct' : 'postfix', '!');
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      rememberToken('literal', ch);
      quote = ch;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let end = i + 1;
      while (end < src.length && /[A-Za-z0-9_$]/.test(src[end])) end += 1;
      rememberToken('word', src.slice(i, end));
      i = end - 1;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      delimiterStack.push({
        open: ch,
        control: ch === '('
          && previousToken?.kind === 'word'
          && controlParenthesisKeywords.has(previousToken.value),
      });
      rememberToken('punct', ch);
      if (ch === open) depth += 1;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      const entry = delimiterStack[delimiterStack.length - 1];
      if (entry && { '(': ')', '[': ']', '{': '}' }[entry.open] === ch) delimiterStack.pop();
      rememberToken(ch === ')' && entry?.control ? 'control-close' : 'punct', ch);
      if (ch !== close) continue;
      depth -= 1;
      if (depth === 0) return i;
      continue;
    }
    rememberToken('punct', ch);
  }
  return -1;
}

/** Return the end of an ordinary quoted JavaScript string, or `-1`. */
function quotedEnd(src, start, quote) {
  for (let i = start + 1; i < src.length; i += 1) {
    if (src[i] === '\\') { i += 1; continue; }
    if (src[i] === quote) return i;
    if (src[i] === '\n' || src[i] === '\r') return -1;
  }
  return -1;
}

/**
 * Find the closing backtick, including `${...}` expressions and nested
 * literals. Template text is not an SEO entry.
 */
function templateEnd(src, start) {
  for (let i = start + 1; i < src.length; i += 1) {
    if (src[i] === '\\') { i += 1; continue; }
    if (src[i] === '`') return i;
    if (src[i] !== '$' || src[i + 1] !== '{') continue;

    let depth = 1;
    for (i += 2; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === '\\') { i += 1; continue; }
      if (ch === "'" || ch === '"') {
        const end = quotedEnd(src, i, ch);
        if (end === -1) return -1;
        i = end;
        continue;
      }
      if (ch === '`') {
        const end = templateEnd(src, i);
        if (end === -1) return -1;
        i = end;
        continue;
      }
      if (ch === '/' && src[i + 1] === '/') {
        const end = src.indexOf('\n', i + 2);
        if (end === -1) return -1;
        i = end;
        continue;
      }
      if (ch === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        if (end === -1) return -1;
        i = end + 1;
        continue;
      }
      if (ch === '{') depth += 1;
      if (ch === '}' && --depth === 0) break;
    }
    if (depth !== 0) return -1;
  }
  return -1;
}

function isRealSeoKey(src, start, end) {
  let lineStart = start;
  while (lineStart > 0 && src[lineStart - 1] !== '\n' && src[lineStart - 1] !== '\r') {
    lineStart -= 1;
  }
  if (!/^[\t ]*$/.test(src.slice(lineStart, start))) return false;
  const key = src.slice(start + 1, end);
  return /^blog-[^'\\\r\n]+$/.test(key) && /^\s*:\s*\{/.test(src.slice(end + 1));
}

/**
 * Mask comments and literal contents without changing UTF-16 offsets.
 * Canonical single-quoted SEO keys are deliberately kept visible.
 * Unclosed tokens are rejected instead of turning the remainder into an
 * apparently valid prefix.
 */
export function maskSeoSource(source, file = 'SEO source') {
  const src = String(source);
  const masked = new Array(src.length);
  for (let i = 0; i < src.length; i += 1) {
    masked[i] = src[i] === '\n' || src[i] === '\r' ? src[i] : ' ';
  }

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i + 2);
      i = end === -1 ? src.length - 1 : end - 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) throw new Error(`${file}: commento multilinea non chiuso`);
      i = end + 1;
      continue;
    }
    if (ch === '`') {
      const end = templateEnd(src, i);
      if (end === -1) throw new Error(`${file}: template literal non chiuso`);
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = quotedEnd(src, i, ch);
      if (end === -1) throw new Error(`${file}: stringa ${ch} non chiusa`);
      if (ch === "'" && end !== -1 && isRealSeoKey(src, i, end)) {
        for (let j = i; j <= end; j += 1) masked[j] = src[j];
      }
      i = end;
      continue;
    }
    masked[i] = ch;
  }
  return masked.join('');
}

function locateSeoEntryMatches(source, entryRe, file) {
  const src = String(source);
  const masked = maskSeoSource(src, file);
  const matches = [];
  for (const match of masked.matchAll(entryRe)) {
    const keyOffset = match[0].indexOf("'blog-");
    const index = match.index + keyOffset;
    const openIdx = match.index + match[0].length - 1;
    const closeIdx = matchingDelimiter(src, openIdx);
    if (closeIdx === -1) {
      const id = match[1] ?? 'unknown';
      throw new Error(`${file}: graffe sbilanciate attorno a blog-${id}`);
    }
    matches.push({
      id: match[1],
      index,
      lineStart: match.index,
      indent: match[0].slice(0, keyOffset),
      openIdx,
      closeIdx,
    });
  }
  return matches;
}

/** Locate every real `blog-<id>` object entry, regardless of indentation. */
export function findSeoEntryMatches(source, id, file = 'SEO source') {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`${file}: article id must be a non-empty string`);
  }

  const escaped = escapeRegex(id);
  const entryRe = new RegExp(`^[\\t ]*'blog-(${escaped})'\\s*:\\s*\\{`, 'gm');
  return locateSeoEntryMatches(source, entryRe, file);
}

/** Locate all real SEO entries for consumers that need the whole chunk. */
export function findAllSeoEntryMatches(source, file = 'SEO source') {
  return locateSeoEntryMatches(source, /^[\t ]*'blog-([^']+)'\s*:\s*\{/gm, file);
}

/** Remove every `'blog-<id>': { ... },` block from `source`. */
export function removeSeoEntriesFromSource(source, id, file = 'SEO source') {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`${file}: article id must be a non-empty string`);
  }

  let src = String(source);
  const matches = findSeoEntryMatches(src, id, file);
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const { lineStart, closeIdx } = matches[i];
    let end = closeIdx + 1;
    if (src[end] === ',') end += 1;
    if (src[end] === '\r') end += 1;
    if (src[end] === '\n') end += 1;
    src = src.slice(0, lineStart) + src.slice(end);
  }

  const remaining = findSeoEntryMatches(src, id, file).length;
  if (remaining !== 0) {
    throw new Error(`${file}: restano ${remaining} voci SEO per blog-${id} dopo la rimozione`);
  }
  return { changed: matches.length > 0, src, removed: matches.length };
}
