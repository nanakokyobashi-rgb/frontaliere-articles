/**
 * Read the canonicalPath literal emitted by the article writer.
 *
 * `modifySeoService()` owns this grammar: the top-level field is a single-
 * quoted TypeScript literal on one line. Keeping the reader narrow is
 * deliberate. The mirrored engine consumer uses the same form, so accepting
 * double quotes, template literals, or concatenations here would make a
 * producer contract that the live consumer cannot read.
 *
 * @param {string} block one complete generated SEO entry
 * @returns {{kind: 'missing'} | {kind: 'unresolved', expression: string} | {kind: 'resolved', value: string}}
 */
export function readCanonicalPath(block) {
  const field = String(block ?? '').match(
    /^ {4}canonicalPath\s*:\s*([^\r\n]*?)\s*,?[ \t]*$/m,
  );
  if (!field) return { kind: 'missing' };

  const expression = field[1].trim();
  if (!expression.startsWith("'")) {
    return { kind: 'unresolved', expression };
  }

  let cursor = 1;
  let value = '';
  const simpleEscapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };

  while (cursor < expression.length) {
    const ch = expression[cursor++];
    if (ch === "'") {
      if (cursor !== expression.length) return { kind: 'unresolved', expression };
      return { kind: 'resolved', value };
    }
    if (ch === '\n' || ch === '\r') {
      return { kind: 'unresolved', expression };
    }
    if (ch !== '\\') {
      value += ch;
      continue;
    }
    if (cursor >= expression.length) {
      return { kind: 'unresolved', expression };
    }
    const escaped = expression[cursor++];
    if (Object.hasOwn(simpleEscapes, escaped)) {
      value += simpleEscapes[escaped];
    } else if (escaped === '\n') {
      continue;
    } else if (escaped === '\r') {
      if (expression[cursor] === '\n') cursor += 1;
    } else if ("\\'\"$/".includes(escaped)) {
      value += escaped;
    } else {
      return { kind: 'unresolved', expression };
    }
  }

  return { kind: 'unresolved', expression };
}
