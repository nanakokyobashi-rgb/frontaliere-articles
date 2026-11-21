/** Trova la fine di un tag senza confondere `>` dentro un attributo quotato. */
export function findHtmlTagEndOutsideQuotes(html, start) {
  let quote = '';
  for (let index = start + 1; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

/** Itera gli attributi di un tag d'apertura o della sua porzione attrs. */
export function* htmlAttributes(markup) {
  let attrs = String(markup ?? '');
  if (attrs.startsWith('<')) {
    const tag = readHtmlTagAt(attrs, 0);
    if (!tag || tag.closing || tag.status === 'malformed') return;
    attrs = tag.attrs;
  }

  const namePattern = /[^\s"'<>/=`]+/y;
  const valuePattern = /"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)/y;
  let index = 0;
  while (index < attrs.length) {
    while (isHtmlWhitespace(attrs[index])) index += 1;
    namePattern.lastIndex = index;
    const name = namePattern.exec(attrs);
    if (!name) return;
    index = namePattern.lastIndex;
    while (isHtmlWhitespace(attrs[index])) index += 1;
    let value = '';
    if (attrs[index] === '=') {
      index += 1;
      while (isHtmlWhitespace(attrs[index])) index += 1;
      valuePattern.lastIndex = index;
      const match = valuePattern.exec(attrs);
      if (!match) return;
      value = match[1] ?? match[2] ?? match[3];
      index = valuePattern.lastIndex;
    }
    yield [name[0].toLowerCase(), value];
  }
}

/** Restituisce il primo valore grezzo, oppure stringa vuota se assente. */
export function firstHtmlAttributeValue(markup, name) {
  const wanted = name.toLowerCase();
  for (const [attribute, value] of htmlAttributes(markup)) {
    if (attribute === wanted) return value;
  }
  return '';
}

function hasRawMarkdownPipe(value, start = 0, end = value.length) {
  for (let index = start; index < end; index += 1) {
    if (value[index] !== '|') continue;
    let slashCount = 0;
    for (let previous = index - 1; previous >= start && value[previous] === '\\'; previous -= 1) {
      slashCount += 1;
    }
    if (slashCount % 2 === 0) return true;
  }
  return false;
}

function isEscapedMarkdownCharacter(value, index) {
  let slashCount = 0;
  for (let previous = index - 1; previous >= 0 && value[previous] === '\\'; previous -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

const MARKDOWN_EMAIL_AUTOLINK_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/u;

function readMarkdownAutolinkEnd(value, start) {
  if (value[start] !== '<') return null;
  const end = value.indexOf('>', start + 1);
  if (end === -1 || /[\r\n]/u.test(value.slice(start + 1, end))) return null;
  const target = value.slice(start + 1, end);
  const uri = /^[A-Za-z][A-Za-z0-9+.-]*:[^<>\s]+$/u.test(target);
  const email = MARKDOWN_EMAIL_AUTOLINK_RE.test(target);
  return uri || email ? end + 1 : null;
}

/**
 * True when a raw Markdown table pipe is inside syntax whose contents are not
 * reliably distinguishable from a cell delimiter by the line parser.
 *
 * GFM table splitting happens before inline rendering. A pipe in a code span,
 * link label/destination/title, HTML tag/attribute, or HTML comment can therefore
 * either be content or a delimiter depending on the parser that eventually
 * consumes the line. The safe result for a source-owned translation marker is
 * to reject the whole candidate table rather than attach a marker to the
 * wrong column. Escaped pipes remain ordinary cell text and are not ambiguous.
 */
export function tableHeaderColumnPipeAmbiguity(markdownLine) {
  const value = String(markdownLine ?? '');
  let codeDelimiter = '';
  let bracketDepth = 0;
  let linkDestinationDepth = 0;
  let linkDestinationStarted = false;
  let linkAngleDestination = false;
  let linkTitleQuote = '';

  for (let index = 0; index < value.length; index += 1) {
    if (codeDelimiter) {
      const hasExactClosingRun = value.startsWith(codeDelimiter, index)
        && value[index - 1] !== '`'
        && value[index + codeDelimiter.length] !== '`';
      if (hasExactClosingRun) {
        index += codeDelimiter.length - 1;
        codeDelimiter = '';
        continue;
      }
      if (value[index] === '|' && !isEscapedMarkdownCharacter(value, index)) return true;
      continue;
    }

    if (value[index] === '`' && !isEscapedMarkdownCharacter(value, index)) {
      let runLength = 1;
      while (value[index + runLength] === '`') runLength += 1;
      codeDelimiter = '`'.repeat(runLength);
      index += runLength - 1;
      continue;
    }

    const escaped = isEscapedMarkdownCharacter(value, index);
    if (linkDestinationDepth > 0) {
      if (linkTitleQuote) {
        if (value[index] === '|' && !escaped) return true;
        if (value[index] === linkTitleQuote && !escaped) linkTitleQuote = '';
        continue;
      }

      if (linkAngleDestination) {
        if (value[index] === '|' && !escaped) return true;
        if (value[index] === '>' && !escaped) linkAngleDestination = false;
        continue;
      }

      if (!linkDestinationStarted) {
        if (/\s/u.test(value[index] || '')) continue;
        linkDestinationStarted = true;
        if (value[index] === '<' && !escaped) {
          linkAngleDestination = true;
          continue;
        }
      }

      if (value[index] === '|' && !escaped) return true;
      if ((value[index] === '"' || value[index] === "'")
        && !escaped && /\s/u.test(value[index - 1] || '')) {
        linkTitleQuote = value[index];
        continue;
      }
      if (value[index] === '(' && !escaped) linkDestinationDepth += 1;
      if (value[index] === ')' && !escaped) linkDestinationDepth -= 1;
      continue;
    }

    if (value[index] === '<' && !escaped) {
      if (value.startsWith('<!--', index)) {
        const commentEnd = value.indexOf('-->', index + 4);
        const contentEnd = commentEnd < 0 ? value.length : commentEnd;
        if (hasRawMarkdownPipe(value, index + 4, contentEnd)) return true;
        if (commentEnd < 0) return false;
        index = commentEnd + 2;
        continue;
      }
      const autolinkEnd = readMarkdownAutolinkEnd(value, index);
      if (autolinkEnd !== null) {
        if (hasRawMarkdownPipe(value, index + 1, autolinkEnd - 1)) return true;
        index = autolinkEnd - 1;
        continue;
      }
      const tag = readHtmlTagAtStatus(value, index);
      if (tag?.malformed) {
        // Once a tag boundary is malformed, the ownership of every later raw
        // pipe is unknowable. A pipe-free malformed fragment does not affect
        // the table layout, so only reject when a pipe is actually present.
        return hasRawMarkdownPipe(value, index);
      }
      if (tag?.tag) {
        if (hasRawMarkdownPipe(value, tag.tag.start, tag.tag.end)) return true;
        index = tag.tag.end - 1;
        continue;
      }
    }

    if (value[index] === '[' && !escaped) {
      bracketDepth += 1;
      continue;
    }
    if (value[index] === ']' && !escaped && bracketDepth > 0) {
      bracketDepth -= 1;
      let next = index + 1;
      while (/\s/u.test(value[next] || '')) next += 1;
      if (bracketDepth === 0 && value[next] === '(') {
        linkDestinationDepth = 1;
        linkDestinationStarted = false;
        linkAngleDestination = false;
        linkTitleQuote = '';
        index = next;
      }
      continue;
    }
    if (value[index] === '|' && !escaped && bracketDepth > 0) return true;
  }

  return false;
}

// Distinto da null: null significa che da `start` non inizia un tag, mentre
// questo stato impone al walker di fermarsi invece di riprovare ogni `<`
// contenuto nel tag aperto e ripetere la scansione fino a EOF.
const MALFORMED_HTML_TAG = Object.freeze({ status: 'malformed' });
const EOF_HTML_SCAN = Object.freeze({ status: 'eof' });

function isHtmlWhitespace(character) {
  return character === ' ' || character === '\t' || character === '\n'
    || character === '\r' || character === '\f';
}

/** Distingue `/>` dalla slash finale di un valore non quotato. */
function inspectHtmlSelfClosingStartTag(html, nameEnd, end) {
  let index = nameEnd;
  while (index < end) {
    while (index < end && isHtmlWhitespace(html[index])) index += 1;
    if (index >= end) return false;
    // `end` is the first `>` outside quotes. Seeing another `>` before it
    // means a malformed quote made the outer scanner jump past a real tag
    // boundary. Treat it as malformed instead of feeding the same character
    // back to the token loop forever.
    if (html[index] === '>') return { malformed: true };
    if (html[index] === '/') return index + 1 === end;

    while (
      index < end
      && !isHtmlWhitespace(html[index])
      && html[index] !== '='
      && html[index] !== '/'
      && html[index] !== '>'
    ) index += 1;
    if (html[index] !== '=') continue;

    index += 1;
    while (index < end && isHtmlWhitespace(html[index])) index += 1;
    if (index >= end) return false;
    const quote = html[index];
    if (quote === '"' || quote === "'") {
      index += 1;
      while (index < end && html[index] !== quote) index += 1;
      if (index >= end) return false;
      index += 1;
      continue;
    }
    while (index < end && !isHtmlWhitespace(html[index]) && html[index] !== '>') index += 1;
  }
  return false;
}

function readHtmlTagAtStatus(html, start) {
  if (html[start] !== '<') return null;
  let index = start + 1;
  const closing = html[index] === '/';
  if (closing) index += 1;
  const nameStart = index;
  if (!/[A-Za-z]/u.test(html[index] || '')) return null;
  index += 1;
  while (index < html.length && /[\w:-]/u.test(html[index])) index += 1;
  if (html[index] && !/[\s/>]/u.test(html[index])) return null;

  const endIndex = findHtmlTagEndOutsideQuotes(html, start);
  if (endIndex < 0) return { malformed: true };
  const selfClosingState = inspectHtmlSelfClosingStartTag(html, index, endIndex);
  if (selfClosingState?.malformed) return selfClosingState;
  return {
    tag: {
      start,
      end: endIndex + 1,
      closing,
      name: html.slice(nameStart, index).toLowerCase(),
      attrs: html.slice(index, endIndex),
      selfClosing: !closing && selfClosingState,
    },
  };
}

export function readHtmlTagAt(html, start) {
  const result = readHtmlTagAtStatus(html, start);
  if (result?.malformed) return MALFORMED_HTML_TAG;
  return result?.tag || null;
}

/**
 * Restituisce il prossimo tag mantenendo distinto il termine normale dalla
 * fine anticipata su markup malformato. I caller che raccolgono dati da una
 * fonte devono rifiutare l'intera estrazione su `malformed`: `null` da solo
 * non permette di distinguere una pagina finita da una pagina troncata.
 *
 * @returns {{status: 'tag', tag: object} | {status: 'eof'} | {status: 'malformed'}}
 */
export function nextHtmlTagStatus(html, from = 0, skipComments = true) {
  let start = html.indexOf('<', from);
  while (start !== -1) {
    if (skipComments && html.startsWith('<!--', start)) {
      const commentEnd = html.indexOf('-->', start + 4);
      if (commentEnd < 0) return MALFORMED_HTML_TAG;
      start = html.indexOf('<', commentEnd + 3);
      continue;
    }
    const result = readHtmlTagAtStatus(html, start);
    if (result?.malformed) return MALFORMED_HTML_TAG;
    if (result?.tag) return { status: 'tag', tag: result.tag };
    start = html.indexOf('<', start + 1);
  }
  return EOF_HTML_SCAN;
}

export function nextHtmlTag(html, from = 0, skipComments = true) {
  const result = nextHtmlTagStatus(html, from, skipComments);
  return result.status === 'tag' ? result.tag : null;
}

export function findHtmlClosingTag(html, from, name) {
  const target = String(name ?? '').toLowerCase();
  if (isHtmlRawTextTag(target)) return findHtmlRawTextClosingTag(html, from, target);

  let depth = 1;
  let cursor = from;
  while (true) {
    const result = nextHtmlTagStatus(html, cursor, true);
    if (result.status !== 'tag') return null;
    const tag = result.tag;

    if (tag.closing && tag.name === target) {
      depth -= 1;
      if (depth === 0) return tag;
      cursor = tag.end;
      continue;
    }
    if (!tag.closing && !tag.selfClosing && tag.name === target) {
      depth += 1;
      cursor = tag.end;
      continue;
    }

    // A literal closing tag in raw text or an inactive template must not
    // close the active element being searched. Skip the whole inactive node.
    if (!tag.closing && isHtmlRawTextTag(tag.name)) {
      const close = findHtmlRawTextClosingTag(html, tag.end, tag.name);
      if (!close) return null;
      cursor = close.end;
      continue;
    }
    if (!tag.closing && tag.name === 'template') {
      const close = findHtmlClosingTag(html, tag.end, 'template');
      if (!close) return null;
      cursor = close.end;
      continue;
    }

    cursor = tag.end;
  }
}

export function nextHtmlElementWhere(html, predicate, from = 0) {
  let cursor = from;
  let tag;
  while ((tag = nextHtmlTag(html, cursor)) !== null) {
    cursor = tag.end;
    if (tag.closing || !predicate(tag)) continue;
    const close = findHtmlClosingTag(html, tag.end, tag.name);
    if (!close) continue;
    return {
      ...tag,
      openEnd: tag.end,
      closeStart: close.start,
      end: close.end,
      inner: html.slice(tag.end, close.start),
    };
  }
  return null;
}

export function nextHtmlElement(html, name, from = 0) {
  return nextHtmlElementWhere(html, (tag) => tag.name === name, from);
}

/** Trova il prossimo tag d'apertura anche se non ha un elemento bilanciato. */
export function nextHtmlOpeningTag(html, name, from = 0) {
  let tag = nextHtmlTag(html, from, true);
  while (tag) {
    if (!tag.closing && tag.name === name) return tag;
    tag = nextHtmlTag(html, tag.end, true);
  }
  return null;
}

export function findHtmlRawTextClosingTag(html, from, name) {
  const closing = new RegExp(`</${name}\\s*>`, 'ig');
  closing.lastIndex = from;
  const match = closing.exec(html);
  return match ? { start: match.index, end: closing.lastIndex } : null;
}

const HTML_RAW_TEXT_TAGS = new Set([
  'script', 'style', 'textarea', 'title', 'noscript', 'iframe', 'xmp',
  'noembed', 'noframes',
]);

export function isHtmlRawTextTag(name) {
  return HTML_RAW_TEXT_TAGS.has(String(name ?? '').toLowerCase());
}

/** Cerca markup visibile saltando commenti e i contenuti raw di script/style. */
export function nextHtmlTagOutsideRawTextStatus(html, from = 0) {
  let result = nextHtmlTagStatus(html, from, true);
  while (result.status === 'tag') {
    const { tag } = result;
    // HTML treats a slash on a non-void raw-text opening tag as data: the
    // element remains open until its matching closing tag. Do not let the
    // scanner's syntactic selfClosing flag expose pseudo-tags in its body.
    if (!tag.closing && isHtmlRawTextTag(tag.name)) {
      const close = findHtmlRawTextClosingTag(html, tag.end, tag.name);
      if (!close) return MALFORMED_HTML_TAG;
      result = nextHtmlTagStatus(html, close.end, true);
      continue;
    }
    return result;
  }
  return result;
}

export function nextHtmlTagOutsideRawText(html, from = 0) {
  const result = nextHtmlTagOutsideRawTextStatus(html, from);
  return result.status === 'tag' ? result.tag : null;
}

/** Itera i tag attivi ignorando commenti, raw-text e template inattivi. */
export function nextHtmlTagOutsideInactive(html, from = 0) {
  let cursor = from;
  while (true) {
    const result = nextHtmlTagStatus(html, cursor, true);
    if (result.status !== 'tag') return null;
    const tag = result.tag;
    if (!tag.closing && isHtmlRawTextTag(tag.name)) {
      const close = findHtmlRawTextClosingTag(html, tag.end, tag.name);
      if (!close) return null;
      cursor = close.end;
      continue;
    }
    if (!tag.closing && tag.name === 'template') {
      const close = findHtmlClosingTag(html, tag.end, 'template');
      if (!close) return null;
      cursor = close.end;
      continue;
    }
    return tag;
  }
}
