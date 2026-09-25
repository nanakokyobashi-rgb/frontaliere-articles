/**
 * fact-check-response.test.mjs — reading the fact-checker's verdict.
 *
 * Run 36096755072 (2026-09-25): an article Codex had written was discarded as
 * "not verified" because every fact-check reply was logged as "risposta non
 * JSON". The verifiers were NVIDIA reasoning models answering without
 * response_format; the parser took first-`{`-to-last-`}` and gave up. These
 * tests pin the replacement parser and the reasoning strip in ai-models.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { addIndependentVote, extractFactCheckJson, factCheckRawSnippet } from '../scripts/lib/fact-check-response.mjs';
import { stripThinkTags } from '../scripts/lib/ai-models.mjs';

const VERDICT = { verdict: 'PASS', confidence: 0.9, issues: [] };

test('a bare JSON verdict is read as is', () => {
  const { result, error } = extractFactCheckJson(JSON.stringify(VERDICT));
  assert.equal(error, null);
  assert.deepEqual(result, VERDICT);
});

test('prose around the verdict does not hide it', () => {
  const raw = `Ecco la verifica richiesta.\n${JSON.stringify(VERDICT)}\nFine della verifica.`;
  assert.deepEqual(extractFactCheckJson(raw).result, VERDICT);
});

test('a stray brace in the prose no longer turns a valid answer into invalid JSON', () => {
  // The old first-`{`-to-last-`}` span would start at "{sic}" and fail.
  const raw = `Il testo cita la regola {sic} più volte.\n${JSON.stringify(VERDICT)}`;
  const { result, error } = extractFactCheckJson(raw);
  assert.equal(error, null);
  assert.equal(result.verdict, 'PASS');
});

test('a brace inside a quoted claim does not close the object early', () => {
  const withBraces = {
    verdict: 'FAIL',
    confidence: 0.8,
    issues: [{ claim: 'la formula {x} è errata', reason: 'non in fonte', severity: 'major', category: 'fatti_inventati' }],
  };
  assert.deepEqual(extractFactCheckJson(JSON.stringify(withBraces)).result, withBraces);
});

test('the object that carries a verdict wins over an earlier unrelated one', () => {
  const raw = `{"nota":"bozza"}\n${JSON.stringify(VERDICT)}`;
  assert.equal(extractFactCheckJson(raw).result.verdict, 'PASS');
});

test('no brace at all is reported as no-json, a broken object as invalid-json', () => {
  assert.deepEqual(extractFactCheckJson('Il testo mi sembra corretto.'), { result: null, error: 'no-json' });
  assert.deepEqual(extractFactCheckJson('{"verdict": "PASS", "issues": [}'), { result: null, error: 'invalid-json' });
  assert.deepEqual(extractFactCheckJson(undefined), { result: null, error: 'no-json' });
  // A reply cut off before its closing brace is broken JSON, not prose.
  assert.deepEqual(extractFactCheckJson('{"verdict": "PASS", "issues": ['), { result: null, error: 'invalid-json' });
});

test('JSON without a PASS/FAIL verdict is not a vote', () => {
  // Review of PR #1848: the first draft of this parser fell back to the first
  // parseable object, so `{"nota":"bozza"}` came back as a result with no
  // verdict and no issues, and the consensus would have counted it.
  const noVerdict = { result: null, error: 'no-verdict' };
  assert.deepEqual(extractFactCheckJson('{"nota":"bozza"}'), noVerdict);
  assert.deepEqual(extractFactCheckJson('{"issues": []}'), noVerdict);
  assert.deepEqual(extractFactCheckJson('{"verdict": "OK", "issues": []}'), noVerdict);
  assert.deepEqual(extractFactCheckJson('{"verdict": true}'), noVerdict);
  assert.deepEqual(extractFactCheckJson('{"verdict": "PASS", "issues": "nessuno"}'), noVerdict);
  // The prompt's own schema line, echoed back, is not an answer either.
  assert.deepEqual(extractFactCheckJson('{ "verdict": "PASS|FAIL", "confidence": 0.0, "issues": [] }'), noVerdict);
});

test('a verdict nested inside another object is not a top-level verdict', () => {
  // Second review of PR #1848: every balanced span used to be a candidate, so
  // once the outer object failed the check its inner object was accepted.
  assert.deepEqual(extractFactCheckJson('{"result": {"verdict": "PASS", "issues": []}}'), { result: null, error: 'no-verdict' });
  // The real answer is the outer FAIL; the nested PASS must never stand in for it.
  const both = { analisi: { verdict: 'PASS', issues: [] }, verdict: 'FAIL', confidence: 0.9, issues: [] };
  assert.equal(extractFactCheckJson(JSON.stringify(both)).result.verdict, 'FAIL');
});

test('a reply cut off inside its object yields nothing, not the object nested in it', () => {
  const truncated = '{"analisi": {"verdict": "PASS", "issues": []}, "verdict": "FAIL", "issues": [{"claim": "la data';
  assert.deepEqual(extractFactCheckJson(truncated), { result: null, error: 'invalid-json' });
  // Same for an unclosed brace in prose ahead of the answer: fail-closed.
  assert.deepEqual(extractFactCheckJson(`Nota { aperta\n${JSON.stringify(VERDICT)}`), { result: null, error: 'invalid-json' });
});

test('a brace-heavy reply is scanned in one pass', () => {
  // One root object holding 20k nested braces: the old scan restarted from
  // every `{` and re-read the same suffix each time.
  const deep = `${'{"a":'.repeat(20_000)}1${'}'.repeat(20_000)}`;
  const started = process.hrtime.bigint();
  assert.equal(extractFactCheckJson(deep).result, null);
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 2_000, 'scansione non lineare');
});

test('the verdict is read in any case, and a malformed object does not hide a valid one after it', () => {
  assert.equal(extractFactCheckJson('{"verdict": "fail", "issues": []}').result.verdict, 'fail');
  const raw = `{"verdict": "PASS", "issues": "nessuno"}\n${JSON.stringify(VERDICT)}`;
  assert.deepEqual(extractFactCheckJson(raw).result, VERDICT);
});

test('two verifiers answered by the same model count as one vote', () => {
  // Review of PR #1848: callLLM re-sorts the cascade and falls through it, so
  // a verifier asked of gemma and one asked of nemotron-ultra can both be
  // served by nemotron-super — one opinion, not a consensus.
  const votes = [];
  const first = { verdict: 'FAIL', confidence: 0.9, issues: [], servedBy: 'nvidia/nvidia/nemotron-3-super-120b-a12b' };
  const second = { verdict: 'FAIL', confidence: 0.8, issues: [], servedBy: 'nvidia/nvidia/nemotron-3-super-120b-a12b' };
  assert.equal(addIndependentVote(votes, 'nvidia/google/gemma-4-31b-it', first), null);
  const earlier = addIndependentVote(votes, 'nvidia/nvidia/nemotron-3-ultra-550b-a55b', second);
  assert.equal(votes.length, 1);
  assert.equal(earlier, votes[0]);
  assert.equal(votes[0].requested, 'nvidia/google/gemma-4-31b-it');
  assert.equal(votes[0].model, 'nvidia/nvidia/nemotron-3-super-120b-a12b', 'il log deve nominare chi ha risposto');
});

test('two verifiers answered by two models are two votes; an unknown server counts as the one asked', () => {
  const votes = [];
  assert.equal(addIndependentVote(votes, 'a', { verdict: 'PASS', confidence: 1, issues: [], servedBy: 'a' }), null);
  assert.equal(addIndependentVote(votes, 'b', { verdict: 'PASS', confidence: 1, issues: [], servedBy: 'c' }), null);
  assert.equal(addIndependentVote(votes, 'd', { verdict: 'PASS', confidence: 1, issues: [], servedBy: null }), null);
  assert.deepEqual(votes.map((v) => v.servedBy), ['a', 'c', 'd']);
  assert.notEqual(addIndependentVote(votes, 'c', { verdict: 'PASS', confidence: 1, issues: [] }), null);
  assert.equal(votes.length, 3);
});

test('reasoning that only carries the closing </think> tag is stripped', () => {
  const reply = `Devo verificare le aliquote e le date... ok, tutto torna.</think>\n${JSON.stringify(VERDICT)}`;
  const answer = stripThinkTags(reply);
  assert.equal(answer, JSON.stringify(VERDICT));
  assert.deepEqual(extractFactCheckJson(answer).result, VERDICT);
});

test('paired <think> blocks are still stripped, and an answer without tags is untouched', () => {
  assert.equal(stripThinkTags(`<think>ragiono</think>\n${JSON.stringify(VERDICT)}`), JSON.stringify(VERDICT));
  assert.equal(stripThinkTags(JSON.stringify(VERDICT)), JSON.stringify(VERDICT));
});

test('the reasoning tags are stripped in any case', () => {
  assert.equal(stripThinkTags(`ragiono ancora</THINK>\n${JSON.stringify(VERDICT)}`), JSON.stringify(VERDICT));
  assert.equal(stripThinkTags(`<Think>ragiono</Think>\n${JSON.stringify(VERDICT)}`), JSON.stringify(VERDICT));
});

test('the log snippet shows head and tail of a long reply, on one line', () => {
  const long = `inizio ${'x'.repeat(500)}\n fine`;
  const snippet = factCheckRawSnippet(long);
  assert.ok(snippet.startsWith('inizio '));
  assert.ok(snippet.includes(' … '));
  assert.ok(snippet.endsWith(`(${long.replace(/\s+/g, ' ').trim().length} char)`));
  assert.ok(!snippet.includes('\n'));
  assert.equal(factCheckRawSnippet(''), '<vuota>');
});

test('the log snippet carries no control characters', () => {
  const snippet = factCheckRawSnippet('\u001b[2Jrisposta\u001b[31m rossa\r\u0007fine\u0085');
  assert.doesNotMatch(snippet, /[\u0000-\u001f\u007f-\u009f]/);
  assert.equal(snippet, '[2Jrisposta [31m rossa fine');
});
