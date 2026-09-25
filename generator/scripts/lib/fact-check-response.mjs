/**
 * fact-check-response.mjs — read the verdict out of a fact-checker's reply.
 *
 * The old parser in create-article.mjs took everything from the first `{` to
 * the last `}` and fed it to JSON.parse. That fails twice over on the replies
 * the NVIDIA verifiers actually send: prose around the object is fine, but a
 * brace inside the prose ("{sic}", a quoted template, a second object after
 * the answer) turns the span into invalid JSON, and a reply with no brace at
 * all is logged as "risposta non JSON" with nothing to show what came back.
 * On run 36096755072 that happened eight times in a row and an article that
 * Codex had written was discarded as "not verified".
 *
 * This module is pure (no network, no process state) so the test can run it.
 */

/**
 * Every balanced `{…}` span in `text`, in order of appearance, honouring
 * string literals so a brace inside a quoted claim does not close the object.
 *
 * @param {string} text
 * @returns {string[]}
 */
function balancedObjectSpans(text) {
  const spans = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          spans.push(text.slice(start, i + 1));
          break;
        }
      }
    }
  }
  return spans;
}

/**
 * Extract the fact-check verdict object from a raw model reply.
 *
 * Preference order: the first parseable object that carries a `verdict` key;
 * then the first parseable object at all; then nothing.
 *
 * @param {string} raw
 * @returns {{ result: object|null, error: null|'no-json'|'invalid-json' }}
 */
export function extractFactCheckJson(raw) {
  const text = typeof raw === 'string' ? raw : '';
  const spans = balancedObjectSpans(text);
  if (spans.length === 0) return { result: null, error: 'no-json' };
  let firstParsed = null;
  for (const span of spans) {
    let parsed;
    try {
      parsed = JSON.parse(span);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    if (Object.prototype.hasOwnProperty.call(parsed, 'verdict')) return { result: parsed, error: null };
    if (!firstParsed) firstParsed = parsed;
  }
  if (firstParsed) return { result: firstParsed, error: null };
  return { result: null, error: 'invalid-json' };
}

/**
 * A short, single-line excerpt of a reply for the run log: the head and the
 * tail, so a reply that was truncated mid-answer or that opens with reasoning
 * is recognisable without dumping the whole thing.
 *
 * @param {string} raw
 * @param {number} [edge=120]
 * @returns {string}
 */
export function factCheckRawSnippet(raw, edge = 120) {
  const text = (typeof raw === 'string' ? raw : '').replace(/\s+/g, ' ').trim();
  if (!text) return '<vuota>';
  if (text.length <= edge * 2 + 5) return text;
  return `${text.slice(0, edge)} … ${text.slice(-edge)} (${text.length} char)`;
}
