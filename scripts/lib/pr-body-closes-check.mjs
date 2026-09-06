/**
 * pr-body-closes-check.mjs — Deterministic detector for the PR-body bugs that
 * leave an issue OPEN after the PR that fixes it merges. ZERO Claude (pure
 * regex), used by pr-body-contract.yml.
 *
 * Two defects, one question: **will GitHub actually close what the body says it
 * closes?** The body is verified for its EFFECT, not for its shape.
 *
 *   1. MULTI-REF — `Closes #12 #34 #56` closes only #12 (below).
 *   2. INEFFECTIVE KEYWORD — `Chiude #133` closes nothing at all. GitHub honors
 *      only close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved;
 *      everything else is prose, however unambiguous the intent. Real
 *      recurrence: PR #139 on the corpus wrote `Chiude #133`, merged, and #133
 *      stayed in the backlog with its fix already on `main` until someone
 *      closed it by hand. Census over merged PRs since 2026-07-25: 7 (1 corpus,
 *      6 here — #5417, #5372, #5368, #5338, #5300, #5271).
 *
 * Defect 2 was invisible to this module by construction: the detector started
 * FROM the valid keywords, so a line that never uses one was neither a
 * violation nor a `Closes` — it simply did not exist for the check. Same shape
 * as the defect nanako's escalation #140 closes on the other section: a
 * contract verified for its form rather than its effect.
 *
 * THE BUG: GitHub honors only the FIRST issue reference after a closing keyword on
 * a line. `Closes #12 #34 #56` closes ONLY #12 — #34/#56 stay open and must be
 * closed by hand (real recurrence: PR #1320 listed 9 issues on one `Closes` line,
 * 8 stayed open). To close N issues each ref needs its OWN keyword:
 *   `Closes #12`        ← one per line (correct)
 *   `Closes #34`
 * or inline `Closes #12, closes #34` (keyword repeated before each).
 *
 * GitHub closing keywords (case-insensitive): close/closes/closed, fix/fixes/fixed,
 * resolve/resolves/resolved. See
 * https://docs.github.com/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue
 *
 * DETECTION (conservative — flag only the unambiguous bug, never a valid body):
 * For each line, find a closing keyword immediately followed by an issue ref
 * (`keyword #N` or `keyword owner/repo#N`) that is itself immediately followed by
 * a SECOND issue ref separated only by list separators (space, comma, colon,
 * semicolon, `&`, or `and`). Those chained extra refs are exactly what GitHub
 * silently ignores. A ref that comes after a sentence boundary or real words
 * (e.g. `Closes #12. See also #99 for context`) is a genuine cross-reference,
 * NOT part of the chain → never flagged (false-positive guard). Bare `#N` not
 * governed by any keyword (e.g. `see #99`) is ignored.
 *
 * Returns { ok, violations }. Every violation carries `{ type, line, text,
 * message }`; multi-ref ones also carry `refs`, ineffective-keyword ones carry
 * `ref`, `keyword` and `suggestion` (the line to write instead).
 *
 * `message` is part of the contract: nanako's `scripts/ci/pr-body-contract.mjs`
 * renders `v.message` when present and falls back to its own wording otherwise,
 * so a new violation type reaches the sticky comment correctly the moment this
 * file mirrors down, with no change needed there.
 */

// An issue reference: optional `owner/repo` prefix, then `#<digits>`.
const REF = '(?:[\\w.-]+\\/[\\w.-]+)?#\\d+';
// Separators GitHub users put between chained refs (the ones it silently ignores):
// whitespace, comma, colon, semicolon, ampersand, or the word "and".
const SEP = '(?:\\s*(?:,|:|;|&|\\band\\b)?\\s*)';
// A closing keyword that governs the FIRST ref, then ≥1 MORE refs chained by
// separators only (no sentence boundary, no real words between). Each extra ref
// must NOT carry its own closing keyword (that would be the correct form).
const CHAIN = new RegExp(
  `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\b\\s*(${REF})((?:${SEP}${REF})+)`,
  'gi',
);
const ALL_REFS = new RegExp(REF, 'g');

/**
 * Detect a closing keyword followed by a chain of ≥2 refs (`kw #a #b ...`). Returns
 * the list of issue numbers in the chain, or null if the line is clean.
 */
function lineHasMultiCloseViolation(line) {
  // Guard: if the "extra" segment actually starts a NEW closing keyword for each
  // ref (e.g. `closes #1, closes #2`), the CHAIN regex won't match because a
  // keyword sits between the separator and the ref — SEP forbids word chars.
  CHAIN.lastIndex = 0;
  const m = CHAIN.exec(line);
  if (!m) return null;
  const chunk = m[0];
  const nums = [];
  for (const r of chunk.matchAll(ALL_REFS)) nums.push(r[0].match(/#(\d+)/)[1]);
  return nums.length >= 2 ? nums : null;
}

// ---------------------------------------------------------------------------
// Defect 2: closure intent expressed with a keyword GitHub does not honor.
// ---------------------------------------------------------------------------

// The ONLY tokens GitHub acts on. Note what is absent: the gerunds. `Closing
// #12` / `Fixing #12` read as closure to a human and do nothing at all.
const EFFECTIVE_KW = '(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)';
// `[\s:*_\`[]*` and not `[\s:]*[*_\`[]*`: the two classes interleave in real
// bodies (`**Closes** #12`, `*Chiude* #12`), where a space sits BETWEEN the
// closing emphasis and the ref. GitHub renders the emphasis away and honors the
// keyword, so a detector that stops there reads a closing body as not closing —
// and for INTENT_RE below it is a missed report, the expensive direction. None
// of the added characters is a letter, so no prose can bridge verb and ref.
const MD_GAP = '[\\s:*_`[]*';
const EFFECTIVE_RE = new RegExp(`\\b${EFFECTIVE_KW}\\b${MD_GAP}(${REF})`, 'gi');

// Tokens that state closure but are NOT GitHub keywords. Italian verbs (the
// measured recurrence) plus the English near-misses that share the failure
// mode. Deliberately NOT here: `addresses`, `see`, `related to`, `part of` —
// those mean "connected to", and flagging them would punish a correct body.
const INTENT_KW =
  '(?:chiud(?:e|ono|er[àa]|iamo)|chius[aoie]|risolv(?:e|ono|iamo)|risolt[aoie]|' +
  'fixa(?:ta|to)?|corregg(?:e|ono)|corrett[aoie]|' +
  'closing|fixing|resolving|solves|solved|completes|completed)';
// A PAST-TENSE report ("già chiusa da #66", "was fixed by #66") states that
// something ELSE already closed the ref — it is not this PR's closure intent,
// and flagging it would punish a body that is telling the truth.
const PAST_REPORT_RE = /\b(?:gi[àa]'?|already|was|were|sono\s+stat[ei]|[èe]'?\s+stat[ao])\s*$/i;
// A NEGATED report ("non chiusi: #849 resta aperta", "not fixed by #66") states
// the ref stays OPEN — the exact opposite of a closure intent. Without this the
// gate answers such a line with "write `Closes #849`", i.e. it asks the author
// to close an issue the same sentence declares still open: the very outcome the
// check exists to prevent, inverted. Bounded to two intervening words and
// stopped by any punctuation (`\w` never matches a comma), so a real intent a
// clause later — "questo non è un problema, chiude #12" — is still reported.
// `\p{L}` with the `u` flag, NOT `\w`: `\w` is ASCII, so `non è chiusa #849` —
// the commonest negated form in Italian — broke the chain at the accent and the
// guard never reached `\s*$`. The lookahead keeps `Non solo chiude #12`
// reportable: "non solo" concedes the closure, it does not deny it — and it has
// to list every synonym of that concession, not three of them: `Non solamente
// chiude #12, ma anche X` and `Not just closing #12` state the SAME concession
// and were silently swallowed, i.e. a missed closure, which is the expensive
// direction (a false positive gets discussed, a missed closure leaves an issue
// open with its fix already on `main`).
const CONCESSIVE =
  '(?:solo|soltanto|solamente|unicamente|esclusivamente|only|just|merely|simply)';
// `n(?:[éè]|e['’])` and not `n[éè]`: `ne'` is how `né` is typed on a keyboard
// without the accent, exactly as `PAST_REPORT_RE` already admits `gi[àa]'?` for
// `già`. The apostrophe is REQUIRED for the unaccented form — a bare `ne` is the
// Italian pronoun ("ne chiude tre"), and swallowing it would cost a missed
// closure, which is the expensive direction.
const NEG_REPORT_RE = new RegExp(
  `\\b(?:non|n(?:[éè]|e['’])|not|never|mai|senza|without)(?!\\s+${CONCESSIVE}\\b)(?:\\s+[\\p{L}\\p{N}_'’]+){0,2}\\s*$`,
  'iu',
);
// Markdown emphasis is not a word, and to a guard anchored to `\s*$` it looks
// like one: `**non** chiude #849` puts `**` between the negation and the verb,
// the chain breaks at the asterisks, and the false positive the guard exists to
// prevent comes back — in the exact form the bodies of this repo are written in.
// So both report guards read the prefix with the emphasis markers taken out.
// A run BETWEEN two word characters is deleted rather than spaced: it is an
// intra-word underscore (`skip_total`), and turning it into a space would split
// one word into two and eat the ≤2-word budget, which flips the guard off. A run
// anywhere else becomes a space, so `qualcosa**non** chiude #12` keeps the word
// boundary the `\b` needs.
const EMPHASIS_RUN_RE = /[*_`]+/g;
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;
function stripEmphasis(s) {
  return s.replace(EMPHASIS_RUN_RE, (run, at, whole) => {
    const prev = whole[at - 1];
    const next = whole[at + run.length];
    return prev && next && WORD_CHAR_RE.test(prev) && WORD_CHAR_RE.test(next) ? '' : ' ';
  });
}
// Filler tolerated between the verb and the ref: `Chiusa da #12`, `Risolve
// definitivamente #12`, `Closing the #12`. Bounded to a known word list so a
// sentence boundary or real prose can never bridge verb and ref.
const INTENT_FILLER = "(?:\\s+(?:da|by|the|la|il|lo|le|gli|l'|anche|definitivamente|finalmente|completamente|parzialmente))*";
// `[\s:]*` — the colon is TOLERATED between verb and ref, and that tolerance is
// what makes `chiusi: #849` reachable, i.e. what put the false positive above
// within reach at all. Measured before keeping it, over the 556 PR bodies of
// the corpus repo (2026-09-06): `<intento>: #N` occurs ONCE — inside PR #886,
// which is the body quoting that very false positive — and a real keyword with
// a colon (`Closes: #12`) occurs ZERO times. So dropping the colon would buy
// nothing measurable and would cost the detection of a genuine `Chiude: #12`,
// which is the expensive direction (a missed report leaves an issue open with
// its fix on `main`). It stays, and the negation guard below is what keeps it
// honest.
const INTENT_RE = new RegExp(`\\b(${INTENT_KW})\\b${INTENT_FILLER}${MD_GAP}(${REF})`, 'gi');

/** Every ref a real GitHub keyword governs → the ones that will actually close. */
function effectiveRefs(body) {
  const found = new Set();
  EFFECTIVE_RE.lastIndex = 0;
  for (const m of String(body || '').matchAll(EFFECTIVE_RE)) found.add(m[1].toLowerCase());
  return found;
}

/**
 * Refs a line claims to close with a token GitHub ignores.
 *
 * The two report guards read the WHOLE prefix, not a fixed window: both are
 * anchored to `\s*$` and bounded to ≤2 intervening words, so a longer prefix
 * cannot widen what they match — it can only stop truncating them. The old
 * 24-character slice was narrower than the two-word bound it was supposed to
 * serve, and Italian words are long enough to overflow it: `Il bug non ancora
 * completamente chiuso #849` was reported (`non ancora completamente ` = 25
 * chars, so `non` fell outside the slice) while `non ancora bene chiuso #849`
 * was not. Same sentence, opposite verdict, decided by spelling.
 *
 * `prev` is the previous body line, prepended because the guards are scoped to
 * a SENTENCE and a body is hard-wrapped by lines: `Il bug non è\nchiuso: #849
 * resta aperta.` is the same false positive the guard exists to prevent, split
 * across a soft wrap. Only one line back, and only joined by a space: the ≤2
 * word bound plus the letters-only class means any punctuation, list marker or
 * blank line between the negation and the verb still breaks the chain.
 *
 * The INTENT is matched on the masked line, the two guards read the UNMASKED
 * one (`raw`/`rawPrev`, same string when the caller has nothing better). The
 * asymmetry is the point: masking answers "is this claimed or merely quoted?",
 * which only the claim needs, while the guards answer "what does the sentence
 * around the claim say?" — and a word in an inline code span is still part of
 * that sentence. Without this ``​`non` chiuse #849`` reached the guard as
 * `      chiuse #849`, negation blanked out, and was reported: marking the
 * negated word as code deleted the negation. `maskQuoted` is length-preserving
 * character by character, so `m.index` addresses the same column in both.
 *
 * @returns {Array<{ keyword: string, ref: string }>}
 */
function lineIntentRefs(line, prev = '', raw = line, rawPrev = prev) {
  const s = String(line || '');
  const src = String(raw ?? '');
  const carry = String(rawPrev ?? '').trim();
  INTENT_RE.lastIndex = 0;
  return [...s.matchAll(INTENT_RE)]
    .filter((m) => {
      const before = stripEmphasis((carry ? `${carry} ` : '') + src.slice(0, m.index));
      return !PAST_REPORT_RE.test(before) && !NEG_REPORT_RE.test(before);
    })
    .map((m) => ({ keyword: m[1], ref: m[2] }));
}

/**
 * Blank out what is QUOTED rather than claimed: fenced blocks, inline code
 * spans and HTML comments. Every character becomes a space and every newline
 * survives, so line numbers and columns still line up with the original.
 *
 * Not cosmetic. A PR body that DOCUMENTS the rule ("don't write `Chiude #133`,
 * write `Closes #133`") and the PR template that warns about it both contain
 * the offending shape verbatim — and the template ships its guidance in HTML
 * comments, which stay in the body of every PR opened from it. Without this the
 * gate fires on the two bodies most likely to be right about it. Same reason
 * `pr-body-sections-check.mjs` strips the same three constructs before judging
 * section content.
 *
 * @param {string} body
 * @returns {string}
 */
export function maskQuoted(body) {
  return String(body || '')
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|<!--[\s\S]*?-->|`[^`\n]*`/g, (m) =>
      m.replace(/[^\n]/g, ' '),
    );
}

export function checkClosesLines(body = '') {
  const lines = maskQuoted(body).split(/\r?\n/);
  const rawLines = String(body || '').split(/\r?\n/);
  const violations = [];
  // Body-level, not line-level: `Chiude #133` two lines below a valid
  // `Closes #133` is redundant prose, not a missed closure. What matters is
  // whether SOME keyword in the body reaches that ref.
  const willClose = effectiveRefs(maskQuoted(body));
  // One report per REF, not per phrasing: PR #5368 said both "chiude #5331"
  // and "chiuso #5331", and the fix is a single line either way.
  const reported = new Set();

  for (let i = 0; i < lines.length; i++) {
    // Scan the masked line, but REPORT the original: the author has to find the
    // line in their own body, and a row of blanks is not a landmark.
    const text = (rawLines[i] ?? lines[i]).trim();
    const refs = lineHasMultiCloseViolation(lines[i]);
    if (refs) {
      violations.push({
        type: 'multi-ref-close',
        line: i + 1,
        text,
        refs,
        message:
          `\`${text}\` chiude **solo #${refs[0]}** — GitHub ignora i riferimenti successivi ` +
          'sulla stessa riga. Usa una keyword per issue, una per riga: ' +
          refs.map((r) => `\`Closes #${r}\``).join(' / ') + '.',
      });
    }
    for (const { keyword, ref } of lineIntentRefs(
      lines[i],
      lines[i - 1],
      rawLines[i] ?? lines[i],
      rawLines[i - 1] ?? lines[i - 1],
    )) {
      if (willClose.has(ref.toLowerCase())) continue; // già chiusa da una keyword vera altrove
      if (reported.has(ref.toLowerCase())) continue;
      reported.add(ref.toLowerCase());
      violations.push({
        type: 'ineffective-closing-keyword',
        line: i + 1,
        text,
        ref,
        keyword,
        suggestion: `Closes ${ref}`,
        message:
          `\`${keyword} ${ref}\` **non chiude niente**: GitHub riconosce solo ` +
          '`close/closes/closed`, `fix/fixes/fixed`, `resolve/resolves/resolved`. ' +
          `Tutto il resto è prosa, e ${ref} resterebbe aperta con la fix già su \`main\` ` +
          '(successo reale: PR #139 → issue #133). ' +
          `Scrivi invece: \`Closes ${ref}\``,
      });
    }
  }
  return { ok: violations.length === 0, violations };
}

// CLI mode: read body from arg or stdin, print JSON, exit 1 on violation.
if (process.argv[1] && process.argv[1].endsWith('pr-body-closes-check.mjs')) {
  const arg = process.argv[2];
  const run = (body) => {
    const res = checkClosesLines(body);
    process.stdout.write(JSON.stringify(res));
    if (!res.ok) process.exitCode = 1;
  };
  if (typeof arg === 'string') {
    run(arg);
  } else {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => run(buf));
  }
}
