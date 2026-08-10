/**
 * Issue #113 — `applyPreSpendTopicGate` can reject 100% of the news pool
 * before generation, and nothing in the run said so in a way you could count.
 *
 * WHY THIS TEST EXISTS AS A TEST AND NOT AS A NOTE
 *
 * Answering the issue's question ("is the post-fallback pool empty in a
 * non-negligible fraction of runs?") required downloading 400 run logs and
 * reconstructing the state from three unrelated lines — `Pre-spend topic
 * gate: N candidates → K`, the presence or absence of `🛟 … backstop`, and
 * the commit subject the workflow chose. Measured that way over 224 real
 * generator runs (2026-08-06T22:40Z → 2026-08-10T07:10Z): the gate rejected
 * every candidate in 124 of them (55.4%), the anchor backstop restored
 * nothing in all 124, and no gate-emptied run ever published a news article
 * (0/124). What the measurement could NOT do cheaply is separate "gate
 * emptied the pool but the run still published" from "gate emptied the pool
 * and the run produced nothing" — the exact distinction the issue asks for.
 *
 * So the shipped change is the two records that make the question answerable
 * from the log alone, and this test pins both:
 *   - `PRESPEND_GATE_TOTAL_REJECTION …` at the gate, carrying
 *     `anchor_candidates` (why the backstop could not fire) and `restored`;
 *   - `PRESPEND_GATE_OUTCOME … recovered=news|evergreen|none` at the run's
 *     disposition, which is the numerator the issue named.
 *
 * ADAPTATION, same as blog-title-casing.test.mjs: `import`ing
 * create-article.mjs is impossible in this repo's CI (no node_modules — its
 * closure pulls sharp/undici/…). `applyPreSpendTopicGate` is self-contained
 * apart from a handful of module-scope names, so the test EXTRACTS the
 * function source and evaluates it with those names injected. If the
 * extraction delimiters move, the test throws instead of passing vacuously.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CREATE_ARTICLE = path.join(ROOT, 'generator', 'scripts', 'create-article.mjs');
const SRC = fs.readFileSync(CREATE_ARTICLE, 'utf-8');

// ── Sandbox extraction ─────────────────────────────────────────────────────

function extractFunctionSource(signature) {
  const start = SRC.indexOf(signature);
  if (start === -1) {
    throw new Error(`"${signature}" not found in create-article.mjs — aggiornare i delimitatori di questo test`);
  }
  // Closed by the first line that is exactly '}' at column 0: every brace
  // inside a function body is indented.
  const endRel = SRC.slice(start).search(/\n\}\n/);
  if (endRel === -1) throw new Error(`closing brace of "${signature}" not found`);
  return SRC.slice(start, start + endRel + 2);
}

const GATE_SRC = extractFunctionSource('async function applyPreSpendTopicGate(headlines, opts = {}) {');
const RECOVERY_SRC = extractFunctionSource('function resolveRunRecovery() {');

/**
 * Builds a fresh gate with stubbed module-scope dependencies.
 *
 * `topicalHits` is a stub on purpose: here it only has to make the section
 * backstop's RANKING legible ("the highest-scoring candidates come back").
 * That the real lexicon scores national headlines correctly is a different
 * claim, pinned in news-scan-section-gates.test.mjs against the actual
 * SVIZZERA_TOPICAL_KEYWORDS.
 *
 * @param {object} o
 * @param {(h: string) => boolean} o.relevant    - classifier verdict per headline
 * @param {(t: string) => (string|null)} [o.anchor] - strict-anchor matcher
 * @param {(t: string) => number} [o.topicalHits] - topical density scorer
 * @param {boolean} [o.isFrontaliere]
 */
function makeGate({ relevant, anchor = () => null, topicalHits = () => 0, isFrontaliere = true, section = 'frontaliere' }) {
  const logs = [];
  // Mirrors the initializer's defaults, so an assertion of `false` here means
  // the gate left the field alone rather than the stub never having had it.
  const runReport = {
    headlines: {
      preSpendGateRan: false,
      preSpendGateBefore: 0,
      preSpendGateKept: 0,
      preSpendGateAnchorCandidates: 0,
      preSpendGateBackstopRestored: 0,
      preSpendGateTotalRejection: false,
      preSpendGateRecovery: null,
    },
  };
  const fakeConsole = { error: (...a) => logs.push(a.join(' ')) };
  const gate = new Function(
    'IS_FRONTALIERE',
    'SECTION_NAME',
    'matchesFrontaliereAnchor',
    'matchesFrontaliereUnambiguousAnchor',
    'classifyFrontaliereRelevance',
    'countTopicalHits',
    'recordDiscardedHeadline',
    'RUN_REPORT',
    'console',
    `${GATE_SRC}\nreturn applyPreSpendTopicGate;`,
  )(
    isFrontaliere,
    section,
    anchor,
    () => false, // never bypass — every candidate must reach the classifier
    async (headline) => ({ relevant: relevant(headline), reason: relevant(headline) ? 'ok' : 'relevant=no; off-topic' }),
    topicalHits,
    () => {},
    runReport,
    fakeConsole,
  );
  return { gate, logs, runReport };
}

const hl = (...titles) => titles.map((headline) => ({ headline, url: `https://example.test/${encodeURIComponent(headline)}` }));

function totalRejectionLine(logs) {
  return logs.find((l) => l.startsWith('PRESPEND_GATE_TOTAL_REJECTION'));
}

// ── The failure the issue reports: 100% rejection, nothing to restore ──────
//
// This is the `svizzera` shape measured in production — 90 of its 110 runs in
// the window. Anchors are frontaliere-specific by construction
// (`IS_FRONTALIERE ? matchesFrontaliereAnchor(…) : ''`), so the D-backstop has
// nothing to work with.
//
// WHAT THIS TEST USED TO ASSERT, AND WHY THAT WAS WRONG
//
// Until 2026-08-10 the assertions here were `kept.length === 0` and
// `restored=0`, with the comment "svizzera has no anchor set — the backstop
// cannot fire, and the record must say it". Both readings were accurate about
// the code and wrong about what the code should do: they pinned a section that
// could not recover an emptied pool BY CONSTRUCTION as if that were the
// contract. Re-measured on 2026-08-10 across 11 sampled svizzera runs, ten
// ended `PRESPEND_GATE_OUTCOME emptied=1 recovered=none status=skipped` and
// the eleventh `deferred` — the national section published no news article in
// any of them. A test cannot both describe that and be the thing that would
// have caught it.
//
// So the shape is unchanged and the outcome is inverted: `anchor_candidates=0`
// still records why the D-backstop was silent (it is a diagnosis, not a
// verdict), and the new section backstop E answers in its place — hence
// `restored=3 backstop=topical kept_after=3`. `restored=0` on a national
// section is now a real failure, not the expected steady state.

test('svizzera: pool fully rejected, no anchor set → section backstop restores instead of shipping an empty pool', async () => {
  const { gate, logs, runReport } = makeGate({
    relevant: () => false,
    isFrontaliere: false,
    section: 'svizzera',
    // "Il franco sempre più forte" outscores the two cronaca items, exactly as
    // the national lexicon scores them in production.
    topicalHits: (t) => (/franco|prezzi/i.test(t) ? 2 : 0),
  });
  const kept = await gate(hl('Incidente sulla A2', 'Il franco sempre più forte', 'Nuovo ristorante a Lugano'));

  assert.equal(kept.length, 3, 'the section backstop restores the top-3 by topical density');
  assert.equal(kept[0].headline, 'Il franco sempre più forte', 'restore is ranked by topical hits, not pool order');

  const line = totalRejectionLine(logs);
  assert.ok(line, 'a rejection the section backstop repaired is still a total rejection and must be recorded');
  assert.match(line, /\bbefore=3\b/);
  assert.match(line, /\banchor_candidates=0\b/, 'the field still explains why the ANCHOR backstop was silent on this section');
  assert.match(line, /\brestored=3\b/, 'the national section must no longer reach generation with an empty pool');
  assert.match(line, /\bbackstop=topical\b/, 'and the record must name which backstop answered');
  assert.match(line, /\bkept_after=3\b/);
  assert.match(line, /\bsection=svizzera\b/);

  assert.equal(runReport.headlines.preSpendGateRan, true);
  assert.equal(runReport.headlines.preSpendGateTotalRejection, true);
  assert.equal(runReport.headlines.preSpendGateBefore, 3);
  assert.equal(runReport.headlines.preSpendGateKept, 3);
  assert.equal(runReport.headlines.preSpendGateBackstopRestored, 3);
});

// The section backstop is a floor for a section that has no anchors, NOT a
// second chance for the frontaliere branch. If it leaked there it would undo
// the D-backstop's precision: frontaliere restores only anchor-matched
// candidates, and REGOLA #0 is calibrated on that.
test('frontaliere: total rejection with no anchor candidate stays empty — the section backstop must not leak', async () => {
  const { gate, logs, runReport } = makeGate({
    relevant: () => false,
    isFrontaliere: true,
    topicalHits: () => 5,
  });
  const kept = await gate(hl('Festival del film di Locarno', 'Incidente sulla A2'));

  assert.equal(kept.length, 0);
  const line = totalRejectionLine(logs);
  assert.match(line, /\brestored=0\b/);
  assert.match(line, /\bbackstop=none\b/);
  assert.equal(runReport.headlines.preSpendGateBackstopRestored, 0);
});

// The stub above makes the ranking legible but would keep passing if the gate
// stopped ranking altogether. Pin the wiring against the source.
test('the section backstop ranks by countTopicalHits, not by pool order alone', () => {
  assert.match(GATE_SRC, /!IS_FRONTALIERE/, 'the section backstop must be gated on the section');
  assert.match(GATE_SRC, /countTopicalHits\(/, 'restoring the top-N requires scoring them');
});

// ── "Emptied but recovered" must not read like "emptied and empty-handed" ──

test('pool fully rejected but restored by the anchor backstop → same record, restored>0', async () => {
  const { gate, logs, runReport } = makeGate({
    relevant: () => false,
    anchor: (text) => (/frontalier/i.test(text) ? 'frontalier' : null),
  });
  const kept = await gate(hl(
    'Frontalieri, cambia il ristorno',
    'Frontalieri e permesso G',
    'Frontalieri: nuovo accordo',
    'Frontalieri in coda a Chiasso',
  ));

  assert.equal(kept.length, 3, 'the D-backstop restores the top-3 anchor-matched');
  const line = totalRejectionLine(logs);
  assert.ok(line, 'a rejection that the backstop repaired is still a total rejection and must be recorded');
  assert.match(line, /\bbefore=4\b/);
  assert.match(line, /\banchor_candidates=4\b/);
  assert.match(line, /\brestored=3\b/);
  assert.match(line, /\bbackstop=anchor\b/, 'on frontaliere the anchor backstop is the one that answers');
  assert.match(line, /\bkept_after=3\b/);

  assert.equal(runReport.headlines.preSpendGateTotalRejection, true);
  assert.equal(runReport.headlines.preSpendGateBackstopRestored, 3);
  assert.equal(runReport.headlines.preSpendGateKept, 3);
});

// ── No false positives: a gate that kept something is not a total rejection ─

test('gate keeps at least one candidate → no total-rejection record', async () => {
  const { gate, logs, runReport } = makeGate({ relevant: (h) => /ristorni/i.test(h) });
  const kept = await gate(hl('Ristorni, accordo vicino', 'Festival del film', 'Incidente in A2'));

  assert.equal(kept.length, 1);
  assert.equal(totalRejectionLine(logs), undefined);
  assert.equal(runReport.headlines.preSpendGateRan, true);
  assert.equal(runReport.headlines.preSpendGateTotalRejection, false);
  assert.equal(runReport.headlines.preSpendGateKept, 1);
});

// An empty pool is a scan failure, not a gate rejection: counting it as one
// would inflate exactly the fraction the issue asked to measure.
test('empty input pool → not counted as a rejection, and the gate is not marked as having run', async () => {
  const { gate, logs, runReport } = makeGate({ relevant: () => false });
  const kept = await gate([]);

  assert.deepEqual(kept, []);
  assert.equal(totalRejectionLine(logs), undefined);
  assert.equal(runReport.headlines.preSpendGateRan, false);
});

// ── The disposition half: "recovered" is derived, not bookkept ─────────────

function makeRecovery(runReport) {
  return new Function('RUN_REPORT', `${RECOVERY_SRC}\nreturn resolveRunRecovery;`)(runReport);
}

test('resolveRunRecovery separates the three outcomes the issue names', () => {
  assert.equal(makeRecovery({ article: { id: null }, selectedArticleType: null })(), 'none');
  assert.equal(makeRecovery({ article: { id: 'abc' }, selectedArticleType: 'news' })(), 'news');
  assert.equal(makeRecovery({ article: { id: 'abc' }, selectedArticleType: 'experimental' })(), 'news');
  assert.equal(makeRecovery({ article: { id: 'abc' }, selectedArticleType: 'evergreen_static' })(), 'evergreen');
  assert.equal(makeRecovery({ article: { id: 'abc' }, selectedArticleType: 'evergreen_dynamic' })(), 'evergreen');
  // A run killed before it recorded a type but after it registered an article
  // is still a publish — 'none' is reserved for "produced nothing".
  assert.equal(makeRecovery({ article: { id: 'abc' }, selectedArticleType: null })(), 'news');
});

// ── Wiring guard ───────────────────────────────────────────────────────────
//
// resolveRunRecovery being correct proves nothing if nobody calls it. The
// outcome line has to be emitted from finalizeRunReport, which every terminal
// path goes through — that is what makes `PRESPEND_GATE_OUTCOME` a usable
// denominator instead of a line that only appears on the happy path.

test('finalizeRunReport emits the outcome record, gated on the gate having run', () => {
  const finalize = extractFunctionSource('function finalizeRunReport(status, extra = {}) {');
  assert.match(finalize, /RUN_REPORT\?\.headlines\?\.preSpendGateRan/, 'the outcome line must be skipped when the gate never ran');
  assert.match(finalize, /PRESPEND_GATE_OUTCOME/);
  assert.match(finalize, /recovered=\$\{RUN_REPORT\.headlines\.preSpendGateRecovery\}/);
  assert.match(finalize, /resolveRunRecovery\(\)/, 'preSpendGateRecovery must be derived, not left null');
});

test('the run report declares the pre-spend gate fields instead of sprouting them', () => {
  for (const field of [
    'preSpendGateRan',
    'preSpendGateBefore',
    'preSpendGateKept',
    'preSpendGateAnchorCandidates',
    'preSpendGateBackstopRestored',
    'preSpendGateTotalRejection',
    'preSpendGateRecovery',
  ]) {
    assert.ok(
      new RegExp(`^\\s{4}${field}:`, 'm').test(SRC),
      `RUN_REPORT.headlines.${field} must be declared in the initializer`,
    );
  }
});
