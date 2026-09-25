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

import { extractFactCheckJson, factCheckRawSnippet } from '../scripts/lib/fact-check-response.mjs';
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

test('the log snippet shows head and tail of a long reply, on one line', () => {
  const long = `inizio ${'x'.repeat(500)}\n fine`;
  const snippet = factCheckRawSnippet(long);
  assert.ok(snippet.startsWith('inizio '));
  assert.ok(snippet.includes(' … '));
  assert.ok(snippet.endsWith(`(${long.replace(/\s+/g, ' ').trim().length} char)`));
  assert.ok(!snippet.includes('\n'));
  assert.equal(factCheckRawSnippet(''), '<vuota>');
});
