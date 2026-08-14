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
 * WHAT THE FILE ALSO PINS SINCE 2026-08-11
 *
 * The telemetry was the point; the invariant is what the telemetry then
 * exposed. Twice now a section has reached generation with a fully rejected
 * pool because the only backstop able to answer had been written for the other
 * section — svizzera (fixed 2026-08-10, no anchors to restore) and frontaliere
 * (fixed 2026-08-11, anchors existed in principle and were absent in 27 of 30
 * measured runs). Both times a test in this file asserted the broken state as
 * the contract. So the last-resort restore is now pinned per-section, over the
 * sections declared in ARTICLE_SECTION_CONFIGS rather than a hardcoded pair,
 * plus a source guard that the condition carries no section predicate at all.
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

// ── The same failure on the frontaliere section (2026-08-11) ───────────────
//
// WHAT THIS TEST USED TO ASSERT, AND WHY THAT WAS WRONG
//
// Until 2026-08-11 this read `frontaliere: total rejection with no anchor
// candidate stays empty — the section backstop must not leak`, and asserted
// `kept.length === 0 / restored=0 / backstop=none`. The reasoning was that
// frontaliere already has backstop D, so E would only dilute it. That holds
// only where `anchor_candidates > 0`, and production said otherwise: over the
// 24h to 2026-08-11, 27 of 30 frontaliere gate runs printed
// `anchor_candidates=0 restored=0 backstop=none kept_after=0` — D silent in
// every one, for the same "nothing to work with" reason it is silent on
// svizzera. Section quotas over the same window: svizzera 37 news out of 38
// published (97.4%), frontaliere 2 out of 42 (4.8%).
//
// It is the same shape as the svizzera inversion above and the same lesson: a
// test asserting the exact state the incident consists of cannot also be the
// thing that catches it. `restored=0 backstop=none` is now a failure on BOTH
// sections, which is what makes it one alertable predicate instead of two.
test('frontaliere: total rejection with no anchor candidate → the last-resort backstop restores instead of shipping an empty pool', async () => {
  const { gate, logs, runReport } = makeGate({
    relevant: () => false,
    isFrontaliere: true,
    // Real candidates named in the gate logs of those 27 runs: rejected because
    // the classifier prompt is scoped ESCLUSIVAMENTE to Ticino-Italia and lists
    // "frontalieri italiani specifici di un altro cantone svizzero non-Ticino"
    // as a non-relevance rule, which the Grigioni story matches.
    topicalHits: (t) => (/frontalier/i.test(t) ? 2 : 0),
  });
  const kept = await gate(hl(
    'Festival del film di Locarno',
    'Grigioni: scende ancora il numero di frontalieri',
    'Incidente sulla A2',
  ));

  assert.equal(kept.length, 3, 'the last-resort backstop must restore on frontaliere too');
  assert.equal(
    kept[0].headline,
    'Grigioni: scende ancora il numero di frontalieri',
    'restore is ranked by topical hits, not pool order',
  );

  const line = totalRejectionLine(logs);
  assert.ok(line, 'a rejection the backstop repaired is still a total rejection and must be recorded');
  assert.match(line, /\banchor_candidates=0\b/, 'the field still explains why the ANCHOR backstop was silent');
  assert.match(line, /\brestored=3\b/, 'the frontaliere section must no longer reach generation with an empty pool');
  assert.match(line, /\bbackstop=topical\b/, 'and the record must name which backstop answered');
  assert.match(line, /\bkept_after=3\b/);
  assert.match(line, /\bsection=frontaliere\b/);
  assert.equal(runReport.headlines.preSpendGateBackstopRestored, 3);
});

// ── The invariant: no section may be excluded from the last-resort restore ──
//
// This is the point of the 2026-08-11 change, and the reason it is a test and
// not a one-line diff. Both incidents so far were the SAME defect discovered
// twice — a section reaching generation with an empty pool because the only
// backstop that could have answered was written for the other section — and
// both times the gate that should have caught it was a test asserting the
// broken state as the contract.
//
// Sections are read from ARTICLE_SECTION_CONFIGS rather than hardcoded, so a
// third section joins this loop the day it is declared instead of shipping
// uncovered.

function configuredSections() {
  const marker = 'export const ARTICLE_SECTION_CONFIGS = {';
  const start = SRC.indexOf(marker);
  if (start === -1) {
    throw new Error(`"${marker}" non trovato in create-article.mjs — aggiornare i delimitatori di questo test`);
  }
  const end = SRC.indexOf('\n};', start);
  if (end === -1) throw new Error('chiusura di ARTICLE_SECTION_CONFIGS non trovata');
  const names = [...SRC.slice(start, end).matchAll(/^ {2}(\w+): \{$/gm)].map((m) => m[1]);
  // Two sections exist today. A count below that means the extraction broke and
  // the loop below would pass vacuously — the exact failure mode this file
  // guards against everywhere else.
  if (names.length < 2) {
    throw new Error(`estratte ${names.length} sezioni da ARTICLE_SECTION_CONFIGS (attese >= 2) — aggiornare questo test`);
  }
  if (!names.includes('frontaliere')) {
    throw new Error(`la sezione "frontaliere" non compare fra ${JSON.stringify(names)} — estrazione rotta`);
  }
  return names;
}

for (const section of configuredSections()) {
  test(`${section}: a fully rejected pool with no anchor candidate is never handed to generation empty`, async () => {
    const { gate, logs } = makeGate({
      relevant: () => false,           // classifier rejects everything
      anchor: () => null,              // …and backstop D has nothing to restore
      isFrontaliere: section === 'frontaliere',
      section,
      topicalHits: (t) => (/rilevante/i.test(t) ? 2 : 0),
    });
    const kept = await gate(hl('Titolo rilevante per la sezione', 'Cronaca qualunque'));

    assert.ok(
      kept.length > 0,
      `la sezione "${section}" è esclusa dal restore di ultima istanza: `
      + 'il pool arriva vuoto alla generazione e la sezione non pubblica notizie. '
      + 'Vedi il blocco "E — Last-resort section backstop" in create-article.mjs.',
    );
    const line = totalRejectionLine(logs);
    assert.ok(line, 'la rejection totale va comunque registrata');
    assert.doesNotMatch(
      line,
      /\brestored=0\b/,
      `"restored=0" sulla sezione "${section}" significa che nessun backstop ha risposto`,
    );
    assert.doesNotMatch(
      line,
      /\bbackstop=none\b/,
      `"backstop=none" sulla sezione "${section}" significa che nessun backstop ha risposto`,
    );
  });
}

// The behavioural loop above proves the sections that exist today are covered.
// This pins the SHAPE that keeps it true: the condition itself must carry no
// section predicate, so re-excluding a section is a visible edit to this line
// rather than a new branch the loop happens not to reach. Read the condition
// alone and not the block — the comment above it discusses IS_FRONTALIERE at
// length, and matching prose would make this guard unfalsifiable.
function sectionBackstopCondition() {
  const anchor = GATE_SRC.indexOf('PRESPEND_GATE_SECTION_RESTORE_N');
  if (anchor === -1) {
    throw new Error('PRESPEND_GATE_SECTION_RESTORE_N non trovato nel gate — aggiornare i delimitatori di questo test');
  }
  const ifStart = GATE_SRC.lastIndexOf('\n  if (', anchor);
  if (ifStart === -1) throw new Error('condizione del backstop di sezione non trovata');
  const lineEnd = GATE_SRC.indexOf('\n', ifStart + 1);
  return GATE_SRC.slice(ifStart + 1, lineEnd);
}

test('the last-resort backstop condition carries no section predicate', () => {
  const cond = sectionBackstopCondition();
  assert.match(cond, /kept\.length === 0/, 'resta un last-resort: entra solo a pool svuotato');
  assert.match(cond, /headlines\.length > 0/, 'un pool vuoto in ingresso non è una rejection');
  assert.doesNotMatch(
    cond,
    /IS_FRONTALIERE|SECTION_NAME|SECTION\./,
    `la condizione del backstop di ultima istanza è tornata a dipendere dalla sezione: ${cond.trim()} — `
    + 'è esattamente la forma che ha tolto il ramo notizie prima alla svizzera (2026-08-10) e poi alla frontaliere (2026-08-11)',
  );
});

// The stub in makeGate makes the ranking legible but would keep passing if the
// gate stopped ranking altogether. Pin the wiring against the source.
test('the section backstop ranks by countTopicalHits, not by pool order alone', () => {
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

// ── Per-candidate attribution (#346, follow-up to #337) ────────────────────
//
// PRESPEND_GATE_TOTAL_REJECTION and PRESPEND_GATE_OUTCOME are per-RUN
// aggregates (counts). Retuning the classifier prompt with real data needs
// every individual "no" tied to the section that produced it — this is the
// record that makes that attributable instead of a per-run signal.

function rejectedLines(logs) {
  return logs.filter((l) => l.startsWith('PRESPEND_GATE_REJECTED'));
}

test('every classifier rejection emits its own attributable record — section, headline, reason', async () => {
  const { gate, logs } = makeGate({
    relevant: (h) => /ristorni/i.test(h),
    section: 'frontaliere',
  });
  await gate(hl('Ristorni, accordo vicino', 'Festival del film di Locarno'));

  const lines = rejectedLines(logs);
  assert.equal(lines.length, 1, 'one record per rejected candidate, not one per run');
  assert.match(lines[0], /\bsection=frontaliere\b/);
  assert.match(lines[0], new RegExp(`\\bheadline=${encodeURIComponent('Festival del film di Locarno')}\\b`));
  // The stub reason ('relevant=no; off-topic') has a space and a semicolon —
  // proof the value is encoded and stays a single \S+ token, matching what
  // parseMarkerRecords requires of every other marker in this file.
  assert.match(lines[0], new RegExp(`\\breason=${encodeURIComponent('relevant=no; off-topic')}\\b`));
  for (const line of lines) {
    for (const m of line.matchAll(/([A-Za-z_]+)=(\S+)/g)) {
      assert.doesNotMatch(m[2], /\s/, `field "${m[1]}" must not contain whitespace: ${JSON.stringify(m[2])}`);
    }
  }
});

test('a kept candidate emits no rejection record', async () => {
  const { gate, logs } = makeGate({ relevant: (h) => /ristorni/i.test(h) });
  await gate(hl('Ristorni, accordo vicino'));

  assert.equal(rejectedLines(logs).length, 0);
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
