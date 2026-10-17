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
  let cursor = from;
  let tag;
  while ((tag = nextHtmlTag(html, cursor, true)) !== null) {
    if (tag.closing && tag.name === name) return tag;
    cursor = tag.end;
  }
  return null;
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

/** Cerca markup visibile saltando commenti e i contenuti raw di script/style. */
export function nextHtmlTagOutsideRawText(html, from = 0) {
  let tag = nextHtmlTag(html, from, true);
  while (tag) {
    if (!tag.closing && !tag.selfClosing && HTML_RAW_TEXT_TAGS.has(tag.name)) {
      const close = findHtmlRawTextClosingTag(html, tag.end, tag.name);
      if (!close) return null;
      tag = nextHtmlTag(html, close.end, true);
      continue;
    }
    return tag;
  }
  return null;
}
