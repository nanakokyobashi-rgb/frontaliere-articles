/**
 * Regression cover for the 2026-07-30 → 2026-08-03 generation stall, when
 * article output fell from ~16/day to zero. Run with `node --test`.
 *
 * Three independent defects, none of which looked like a defect from the code:
 * every one of them made a gate UNSATISFIABLE rather than strict, so the retry
 * loop burned all six attempts on every evergreen slot and the workflow's
 * `timeout ... 2400s` SIGKILLed the process. Only the run logs showed it.
 *
 * These live here as well as in the site repo's vitest suite because this is
 * the repo that now generates, and `generator-ci.yml` is what gates it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSourceAnchors,
  renderAnchorForPrompt,
  matchedAnchors,
  checkSourceFidelity,
} from '../scripts/lib/article-factuality-gates.mjs';
import {
  isEvergreenRejected,
  strikeEvergreenKeyword,
  appendEvergreenRejected,
  loadEvergreenRejectedTracker,
  EVERGREEN_STRIKE_LIMIT,
} from '../scripts/lib/article-topic-selector.mjs';

// ── Defect 1: all-caps emphasis harvested as required "institutions" ──
//
// `[A-Z]{3,8}` minus a deny-list treats every all-caps word as an acronym, and
// an evergreen SEO brief is written in all-caps emphasis. On the frontalieri
// tax brief that produced eight permanently-missing "facts" — including the
// brief's own `[ARTICOLO EVERGREEN SEO]` header — which sat in the recall
// denominator forever and pinned it under the 50% gate.

const BRIEF = '[ARTICOLO EVERGREEN SEO]\n'
  + '- Aliquote svizzere: AVS/AI/IPG 5.3% dipendente, AD/AC 1.1%, LAINF 0.7–1.5%, LPP 7–18%.\n'
  + 'IRPEF italiana: 23% fino €28\'000, 35% €28\'001–50\'000, 43% oltre €50\'000.\n'
  + '- Imposta alla fonte: trattenuta SOLO in Svizzera (MAI "in entrambi i paesi").\n'
  + '- In vigore dal 1° GENNAIO 2024 (NON 2026). La Svizzera NON è membro UE/SEE.\n'
  + '- Acronimi/enti VALIDI: SECO, SEM, USTAT, UFSP/BAG, SUVA, INPS, MEF, BFS.';

test('real institutions stay required anchors', () => {
  const anchors = extractSourceAnchors(BRIEF);
  for (const org of ['SECO', 'SEM', 'USTAT', 'BAG', 'SUVA', 'INPS', 'MEF', 'BFS', 'AVS', 'IPG']) {
    assert.ok(anchors.has(`org:${org}`), `expected org:${org} to be required`);
  }
});

test('all-caps emphasis and prompt scaffolding are not required anchors', () => {
  const anchors = extractSourceAnchors(BRIEF);
  for (const junk of ['ARTICOLO', 'SEO', 'SOLO', 'MAI', 'NON', 'VALIDI', 'GENNAIO']) {
    assert.ok(!anchors.has(`org:${junk}`), `org:${junk} can never appear in an article — must not be required`);
  }
});

// ── Defect 2: the gate asked for a string it would then refuse ──
//
// renderAnchorForPrompt returned the raw dot-decimal key while matchedAnchors
// only credits the Italian comma form. So the source contract and every
// remediation asked for "5.3%" and the recall check rejected it. Invisible on
// whole numbers, which is why run 30784967708 recovered 18/23/35/43 across six
// attempts and never once recovered 5.3/1.1/1.5 — exactly the fractional ones.

test('percentages are requested in the form the recall check accepts', () => {
  assert.equal(renderAnchorForPrompt('pct:5.3'), '5,3%');
  assert.equal(renderAnchorForPrompt('pct:1.1'), '1,1%');
  assert.equal(renderAnchorForPrompt('pct:23'), '23%');
});

test('an article that obeys the contract literally passes the recall check', () => {
  const anchors = extractSourceAnchors(BRIEF);
  const pcts = [...anchors].filter((a) => a.startsWith('pct:'));
  const article = 'Le aliquote sono ' + pcts.map(renderAnchorForPrompt).join(', ')
    + '. Gli enti competenti: SECO, SEM, USTAT, BAG, SUVA, INPS, MEF, BFS. Contributi AVS/AI/IPG.';
  const found = matchedAnchors(article, anchors);
  for (const p of pcts) {
    assert.ok(found.has(p), `${renderAnchorForPrompt(p)} was requested in that exact form but not credited`);
  }
  const codes = checkSourceFidelity(article, BRIEF).map((i) => i.code);
  assert.ok(!codes.includes('source-key-rates-dropped'), `unexpected: ${codes.join(', ')}`);
  assert.ok(!codes.includes('source-fidelity-low'), `unexpected: ${codes.join(', ')}`);
});

test('a genuinely unfaithful article is still blocked', () => {
  const vague = 'Un articolo generico su tasse e contributi, senza citare aliquote né enti.';
  const codes = checkSourceFidelity(vague, BRIEF).map((i) => i.code);
  assert.ok(codes.includes('source-fidelity-low'), 'the gate must still block a draft that dropped the source');
});

test('the fidelity gate tells the writer how many more anchors it needs', () => {
  const vague = 'Un articolo generico su tasse e contributi, senza citare aliquote né enti.';
  const issue = checkSourceFidelity(vague, BRIEF).find((i) => i.code === 'source-fidelity-low');
  assert.ok(issue, 'expected source-fidelity-low');
  assert.match(issue.fix, /Ne mancano \d+ per superare il controllo/);
  assert.match(issue.fix, /ne servono \d+ su \d+, adesso ne hai \d+/);
  // The bullet LABELS name the anchors to reinstate, so they must be in the
  // form the recall check credits. Note the assertion is deliberately not
  // "the text contains no dot-decimal anywhere": each bullet also quotes the
  // source sentence verbatim, and this source writes "5.3%" — reproducing that
  // faithfully is the whole point of anchorEvidence.
  assert.match(issue.fix, /• 5,3% — la fonte dice:/);
  assert.ok(!/• \d+\.\d+%/.test(issue.fix), 'anchor labels must use the Italian comma form');
});

// ── Defect 3: nothing retired a keyword that failed every time ──
//
// Quality rejects were deliberately not recorded, because one bad draft is LLM
// variance. But that left no way to distinguish variance from a keyword whose
// gates never converge: it was re-picked on every cron slot and burned the run.

test('a keyword is not retired before the strike limit', () => {
  let t = { keywords: [], strikes: {} };
  for (let i = 1; i < EVERGREEN_STRIKE_LIMIT; i++) {
    t = strikeEvergreenKeyword(t, 'kw-flaky');
    assert.equal(isEvergreenRejected(t, 'kw-flaky'), false, `retired too early at strike ${i}`);
  }
  t = strikeEvergreenKeyword(t, 'kw-flaky');
  assert.equal(isEvergreenRejected(t, 'kw-flaky'), true);
});

test('strikes are per-keyword and do not disturb the permanent ban list', () => {
  let t = { keywords: [], strikes: {} };
  for (let i = 0; i < EVERGREEN_STRIKE_LIMIT; i++) t = strikeEvergreenKeyword(t, 'kw-doomed');
  t = strikeEvergreenKeyword(t, 'kw-unlucky');
  t = appendEvergreenRejected(t, 'kw-dup');
  assert.equal(isEvergreenRejected(t, 'kw-doomed'), true);
  assert.equal(isEvergreenRejected(t, 'kw-unlucky'), false);
  assert.deepEqual(t.keywords, ['kw-dup']);
  assert.equal(t.strikes['kw-doomed'], EVERGREEN_STRIKE_LIMIT);
});

test('a tracker file written before strikes existed still loads', () => {
  const legacy = loadEvergreenRejectedTracker({ path: 'generator/tests/fixtures/does-not-exist.json' });
  assert.deepEqual(legacy, { keywords: [], strikes: {} });
});
