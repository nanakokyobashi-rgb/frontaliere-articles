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

// 2026-08-18 — il gate non e' piu' un `for…await` seriale: le classificazioni
// partono a gruppi via `mapWithConcurrency`, e il cap del classifier ha un
// default di modulo (`DEFAULT_MAX_CLASSIFIER_CALLS`, 12) che prima era
// `headlines.length` e quindi non era un nome libero. Tre dipendenze in piu' da
// iniettare, e `mapWithConcurrency` viene estratta dallo stesso sorgente invece
// di essere riscritta qui: una copia divergente farebbe passare questo test su
// un ordinamento che la produzione non ha.
const MAP_CONCURRENCY_SRC = extractFunctionSource('async function mapWithConcurrency(items, limit, fn) {');
const mapWithConcurrency = new Function(`${MAP_CONCURRENCY_SRC}\nreturn mapWithConcurrency;`)();

/**
 * Il valore di `DEFAULT_MAX_CLASSIFIER_CALLS` che il MODULO calcolerebbe con un
 * dato `process.env`, estratto dalla dichiarazione reale invece di essere
 * riscritto qui.
 *
 * Serve perche' il default del tetto e' esattamente cio' che e' regredito il
 * 2026-08-18: un numero comodo scritto a mano in questo file renderebbe verde
 * un gate che in produzione classifica un numero diverso di candidate. Il
 * `process` finto e' passato come argomento, cosi' il test non tocca l'ambiente
 * reale e i due casi (variabile assente / variabile impostata) sono entrambi
 * verificabili nello stesso processo.
 */
const CAP_RESOLVER_SRC = extractFunctionSource('function resolvePreSpendClassifierCap(raw) {');
const resolvePreSpendClassifierCap = new Function(
  `${CAP_RESOLVER_SRC}\nreturn resolvePreSpendClassifierCap;`,
)();

/** Il tetto che il modulo calcolerebbe con quel valore di `PRESPEND_GATE_MAX_CLASSIFIER`. */
function moduleDefaultMaxClassifier(env = {}) {
  // Pinna anche il WIRING: che il resolver sia corretto non serve a niente se
  // la costante non lo usa.
  assert.match(
    SRC,
    /const DEFAULT_MAX_CLASSIFIER_CALLS = resolvePreSpendClassifierCap\(process\.env\.PRESPEND_GATE_MAX_CLASSIFIER\);/,
    'DEFAULT_MAX_CLASSIFIER_CALLS deve venire dal resolver, altrimenti questo test misura una funzione che nessuno chiama',
  );
  return resolvePreSpendClassifierCap(env.PRESPEND_GATE_MAX_CLASSIFIER);
}

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
function makeGate({
  relevant,
  anchor = () => null,
  topicalHits = () => 0,
  isFrontaliere = true,
  section = 'frontaliere',
  // Il default di PRODUZIONE con `PRESPEND_GATE_MAX_CLASSIFIER` non impostata,
  // letto dal sorgente. Un test che vuole misurare il comportamento COL tetto
  // lo passa esplicito, esattamente come farebbe chi imposta la variabile.
  maxClassifierDefault = moduleDefaultMaxClassifier({}),
}) {
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
    'mapWithConcurrency',
    'DEFAULT_MAX_CLASSIFIER_CALLS',
    'PRESPEND_GATE_CONCURRENCY',
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
    mapWithConcurrency,
    // I valori di produzione, non valori comodi: un cap piu' largo qui
    // renderebbe verde un gate che in produzione smette di classificare.
    maxClassifierDefault,
    5,
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

// ── Il tetto del classifier su un pool piu' grande del tetto (2026-08-18) ──
//
// LA LACUNA CHE HA FATTO PASSARE LA REGRESSIONE.
//
// Fino a oggi nessun caso di questo file usava un pool sopra le 12 headline: il
// piu' grande ne aveva 4. Il ramo «budget esaurito» del gate era quindi l'unico
// comportamento non coperto, ed e' esattamente quello che #416 ha attivato per
// default nel pomeriggio del 2026-08-18. Con un pool piccolo il tetto non morde
// mai e la suite resta verde qualunque cosa faccia il default: la copertura
// c'era in apparenza e mancava nel punto che conta.
//
// LA MISURA. Simulando il gate su 20 headline TUTTE fuori tema:
//
//   |                              | tetto a 12 | senza tetto |
//   | tenute                       |          8 |           3 |
//   | PRESPEND_GATE_REJECTED       |         12 |          20 |
//   | PRESPEND_GATE_TOTAL_REJECTION|          0 |           1 |
//   | backstop E (countTopicalHits)|        mai |     restored=3 |
//
// Le 8 tenute sono candidate MAI classificate, consegnate alla generazione in
// ordine di pool: ognuna brucia un tentativo di generazione completo (~5-7k
// token) prima che REGOLA #0 la abortisca, contro le ~10 chiamate flash-lite
// che il tetto risparmia. Sulla telemetria `PRESPEND_GATE_OUTCOME` di 22 run
// reali dello stesso giorno il caso non e' teorico: `section=frontaliere` ha
// `before=` fra 20 e 23 in tutte e 10 le righe, `section=svizzera` fra 4 e 8 in
// tutte e 12 — il tetto agisce quasi solo sulla sezione a secco.

const BIG_POOL_SIZE = 20;

// 20 titoli fuori tema in ordine di pool (recency). Il piu' pertinente per il
// lessico e' in fondo, DENTRO la fascia che un tetto a 12 non classifica mai:
// se il restore lo trova, sta ordinando per densita' topica e non per posizione.
const bigPool = () => hl(
  ...Array.from({ length: BIG_POOL_SIZE - 1 }, (_, i) => `Cronaca locale numero ${i + 1}`),
  'Frontalieri e ristorni: il nodo del rinnovo',
);

test('pool sopra il tetto: il default non impone un tetto e ogni candidata viene classificata', async () => {
  const { gate, logs, runReport } = makeGate({
    relevant: () => false,
    topicalHits: (t) => (/frontalier|ristorn/i.test(t) ? 2 : 0),
  });
  const kept = await gate(bigPool());

  // Col tetto a 12 questa e' 8: le 12 classificate sono tutte rigettate e le 8
  // residue entrano per fail-open senza verdetto.
  assert.equal(
    kept.length,
    3,
    'un pool interamente fuori tema deve arrivare alla generazione con le 3 migliori per densita\' topica, '
    + `non con le ${BIG_POOL_SIZE - 12} residue non classificate`,
  );
  assert.equal(
    kept[0].headline,
    'Frontalieri e ristorni: il nodo del rinnovo',
    'il restore ordina per countTopicalHits: la candidata migliore e\' l\'ultima del pool, che un tetto a 12 non raggiungerebbe mai',
  );

  assert.equal(
    rejectedLines(logs).length,
    BIG_POOL_SIZE,
    'senza tetto ogni candidata riceve un verdetto, quindi ogni rigetto e\' attribuibile',
  );

  const line = totalRejectionLine(logs);
  assert.ok(
    line,
    'PRESPEND_GATE_TOTAL_REJECTION e\' il marker che questo stesso file cita come base di prova degli incidenti '
    + 'del 2026-08-10 e del 2026-08-11: un pool interamente rigettato deve continuare a emetterlo',
  );
  assert.match(line, new RegExp(`\\bbefore=${BIG_POOL_SIZE}\\b`));
  assert.match(line, new RegExp(`\\bclassifier_calls=${BIG_POOL_SIZE}\\b`), 'nessuna candidata resta senza classificazione col default');
  assert.match(line, /\brestored=3\b/);
  assert.match(line, /\bbackstop=topical\b/);
  assert.match(line, /\bkept_after=3\b/);
  assert.match(line, /\bunclassified=0\b/, 'col default nessuna candidata entra per esaurimento del budget');

  assert.equal(runReport.headlines.preSpendGateTotalRejection, true);
  assert.equal(runReport.headlines.preSpendGateKept, 3);
  assert.equal(runReport.headlines.preSpendGateBackstopRestored, 3);
});

test('pool sopra un tetto ESPLICITO: le keep per budget esaurito non mascherano la rejection totale', async () => {
  const { gate, logs, runReport } = makeGate({
    relevant: () => false,
    topicalHits: (t) => (/frontalier|ristorn/i.test(t) ? 2 : 0),
    // Chi accende il tetto lo accende cosi': PRESPEND_GATE_MAX_CLASSIFIER=12.
    // Il valore passa dalla dichiarazione reale del modulo, non da un 12 scritto qui.
    maxClassifierDefault: moduleDefaultMaxClassifier({ PRESPEND_GATE_MAX_CLASSIFIER: '12' }),
  });
  const kept = await gate(bigPool());

  assert.equal(
    rejectedLines(logs).length,
    12,
    'il tetto esplicito deve davvero risparmiare le classificazioni: e\' l\'unica cosa che deve fare',
  );

  assert.equal(
    kept.length,
    3,
    'le 8 candidate oltre il budget non hanno un verdetto: non possono valere come «tenute dal gate» '
    + 'e finire in generazione al posto delle 3 migliori per densita\' topica',
  );
  assert.equal(
    kept[0].headline,
    'Frontalieri e ristorni: il nodo del rinnovo',
    'anche col tetto, il restore sceglie per pertinenza sull\'INTERO pool, non fra le sole non classificate',
  );

  const line = totalRejectionLine(logs);
  assert.ok(
    line,
    'un tetto attivo non deve spegnere PRESPEND_GATE_TOTAL_REJECTION: il classifier ha detto no a tutto '
    + 'cio\' che ha visto, e il marker e\' l\'osservabilita\' che ha motivato l\'esistenza del gate',
  );
  assert.match(line, new RegExp(`\\bbefore=${BIG_POOL_SIZE}\\b`));
  assert.match(line, /\bclassifier_calls=12\b/);
  assert.match(line, /\brestored=3\b/);
  assert.match(line, /\bbackstop=topical\b/);
  assert.match(line, /\bkept_after=3\b/);
  assert.match(line, /\bunclassified=8\b/, 'il record deve dire quante candidate il tetto ha lasciato senza verdetto');

  assert.equal(runReport.headlines.preSpendGateTotalRejection, true);
  assert.equal(runReport.headlines.preSpendGateKept, 3);
});

test('un tetto esplicito che NON morde lascia il gate identico a se stesso', async () => {
  // Il contrappeso ai due test sopra: la fix non deve trasformare ogni keep in
  // sospetto. Con 4 headline e tetto 12 nessuna resta senza verdetto, quindi il
  // percorso e' quello di sempre — e la candidata pertinente viene tenuta.
  const { gate, logs, runReport } = makeGate({
    relevant: (h) => /ristorn/i.test(h),
    maxClassifierDefault: moduleDefaultMaxClassifier({ PRESPEND_GATE_MAX_CLASSIFIER: '12' }),
  });
  const kept = await gate(hl(
    'Incidente sulla A2',
    'Frontalieri e ristorni: il nodo del rinnovo',
    'Nuovo ristorante a Lugano',
    'Festival del film di Locarno',
  ));

  assert.equal(kept.length, 1);
  assert.equal(kept[0].headline, 'Frontalieri e ristorni: il nodo del rinnovo');
  assert.equal(totalRejectionLine(logs), undefined, 'una tenuta con verdetto non e\' una rejection totale');
  assert.equal(runReport.headlines.preSpendGateTotalRejection, false);
});

// Il guard di forma. I tre test sopra descrivono il comportamento; questo pinna
// la ragione per cui e' quello: il default del modulo e' «nessun tetto», e un
// tetto esiste solo se qualcuno lo chiede. Rimetterci un numero e' una modifica
// visibile a questa riga, non un cambio silenzioso di regime su una sezione.
test('il tetto del classifier e\' opt-in: nessun tetto se PRESPEND_GATE_MAX_CLASSIFIER non e\' impostata', () => {
  assert.equal(
    moduleDefaultMaxClassifier({}),
    null,
    'un tetto per default classifica solo le prime N candidate e consegna le residue alla generazione senza verdetto: '
    + 'su `frontaliere` (pool 20-23) e\' il regime misurato il 2026-08-18, su `svizzera` (pool 4-8) non cambia nulla — '
    + 'cioe\' il costo cade tutto sulla sezione a secco',
  );
  assert.equal(
    moduleDefaultMaxClassifier({ PRESPEND_GATE_MAX_CLASSIFIER: '5' }),
    5,
    'chi lo chiede esplicitamente lo deve ottenere',
  );
  assert.equal(
    moduleDefaultMaxClassifier({ PRESPEND_GATE_MAX_CLASSIFIER: '0' }),
    1,
    'un tetto a 0 spegnerebbe il classifier: resta il minimo di 1, non un 12 arrivato da un `|| 12`',
  );
  assert.equal(
    moduleDefaultMaxClassifier({ PRESPEND_GATE_MAX_CLASSIFIER: 'dodici' }),
    null,
    'un valore illeggibile non e\' una richiesta di tetto: si torna al default, non a un numero scelto dal fallback',
  );
});

// E il guard sul consumo: `kept` da solo non basta piu' a decidere se il pool e'
// stato svuotato, perche' un keep per budget esaurito non e' un verdetto. Se
// questa distinzione sparisce, i backstop tornano a non partire.
test('la rejection totale si misura sulle candidate CON verdetto, non su kept.length', () => {
  assert.match(
    GATE_SRC,
    /const totalRejection = evidencedKept === 0 && headlines\.length > 0;/,
    'la condizione deve escludere le keep senza verdetto: contarle rende `totalRejection` falso, '
    + 'spegne PRESPEND_GATE_TOTAL_REJECTION e impedisce ai backstop D ed E di partire',
  );
  assert.match(
    GATE_SRC,
    /unclassified: true/,
    'il ramo «budget esaurito» deve marcare la candidata, altrimenti a valle e\' indistinguibile da un keep per anchor',
  );
});
