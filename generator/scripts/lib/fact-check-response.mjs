/**
 * fact-check-response.mjs — read the verdict out of a fact-checker's reply,
 * and count each verifier's vote once per model that actually answered.
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

const VERDICTS = new Set(['PASS', 'FAIL']);

/**
 * The root-level balanced `{…}` spans of `text`, in order of appearance,
 * honouring string literals so a brace inside a quoted claim does not close
 * the object.
 *
 * Root-level only: an object nested inside another is never a candidate of
 * its own, so `{"result": {"verdict": "PASS"}}` does not yield the inner
 * verdict (review of PR #1848). A brace that never closes ends the scan:
 * everything after it sits inside that brace — typically a reply cut off at
 * maxTokens, e.g. `{"analisi": {"verdict": "PASS"}, "verdict": "FAIL", …` —
 * and reading an inner object as the answer would take a nested value for
 * the verdict. Fail-closed: no candidate, no vote. Each character is visited
 * once, so a brace-heavy reply costs one linear pass.
 *
 * @param {string} text
 * @returns {Generator<string>}
 */
function* rootObjectSpans(text) {
  let start = text.indexOf('{');
  while (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
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
          end = i;
          break;
        }
      }
    }
    if (end === -1) return;
    yield text.slice(start, end + 1);
    start = text.indexOf('{', end + 1);
  }
}

/**
 * A fact-check verdict the consensus can count: a top-level `verdict` of
 * PASS or FAIL (any case) and, when present, an `issues` array. Anything
 * else — an echo of the schema, a `{"nota": …}` draft, `{"verdict": "OK"}` —
 * is not a vote, and counting it as one would let an empty issues list
 * pass the article.
 *
 * @param {unknown} parsed
 * @returns {boolean}
 */
function isFactCheckVerdict(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  if (typeof parsed.verdict !== 'string' || !VERDICTS.has(parsed.verdict.trim().toUpperCase())) return false;
  if (parsed.issues !== undefined && !Array.isArray(parsed.issues)) return false;
  return true;
}

/**
 * Extract the fact-check verdict object from a raw model reply: the ONE
 * root-level object that parses and has the verdict shape above.
 *
 * Exactly one, not the first (third review of PR #1848): a reply that quotes
 * the schema or an example `{"verdict":"PASS"}` before its real `FAIL` has two
 * candidates, and nothing in the text says which is the answer. Picking
 * either is a guess that can publish an article the checker rejected, so two
 * or more verdicts make the reply `ambiguous` — no vote, like prose.
 *
 * `no-json`: no brace at all. `invalid-json`: braces, but nothing parses
 * (a brace that never closes included). `no-verdict`: JSON parses, but no
 * root-level object carries a PASS/FAIL verdict. `ambiguous`: more than one
 * does.
 *
 * @param {string} raw
 * @returns {{ result: object|null, error: null|'no-json'|'invalid-json'|'no-verdict'|'ambiguous' }}
 */
export function extractFactCheckJson(raw) {
  const text = typeof raw === 'string' ? raw : '';
  let sawSpan = false;
  let sawParsed = false;
  const verdicts = [];
  for (const span of rootObjectSpans(text)) {
    sawSpan = true;
    let parsed;
    try {
      parsed = JSON.parse(span);
    } catch {
      continue;
    }
    sawParsed = true;
    if (isFactCheckVerdict(parsed)) verdicts.push(parsed);
  }
  if (verdicts.length === 1) return { result: verdicts[0], error: null };
  if (verdicts.length > 1) return { result: null, error: 'ambiguous' };
  if (!sawSpan) return { result: null, error: text.includes('{') ? 'invalid-json' : 'no-json' };
  return { result: null, error: sawParsed ? 'no-verdict' : 'invalid-json' };
}

/**
 * Add one verifier's verdict to the consensus, at most once per model that
 * actually served it.
 *
 * `callLLM` treats the requested model as a starting point, not a pin: it
 * re-sorts the cascade by score and falls through to the rest of the chain
 * when that model fails. Two verifiers asked of two different models can
 * therefore both be answered by the same fallback — and counting those as
 * two votes turns one model's opinion into a "consensus", which is what the
 * critical-issue rule relies on.
 *
 * @param {Array<object>} votes the consensus so far; appended to in place
 * @param {string} requested the verifier that was asked
 * @param {{ servedBy?: string|null }} value the parsed verdict, with the model
 *   that answered (`modelUsedRef.model`); a missing one counts as `requested`
 * @returns {object|null} the earlier vote from the same model, when this one
 *   was dropped as a duplicate; `null` when it was counted
 */
export function addIndependentVote(votes, requested, value) {
  const servedBy = value.servedBy || requested;
  const earlier = votes.find((v) => v.servedBy === servedBy);
  if (earlier) return earlier;
  votes.push({ ...value, model: servedBy, requested, servedBy });
  return null;
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
  // Control characters (ANSI escapes included) become spaces: the snippet is
  // one log line, whatever the provider sent.
  const text = (typeof raw === 'string' ? raw : '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return '<vuota>';
  if (text.length <= edge * 2 + 5) return text;
  return `${text.slice(0, edge)} … ${text.slice(-edge)} (${text.length} char)`;
}
