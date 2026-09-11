/**
 * Regressions for legacy per-PR follow-ups whose prose mixes a stale token with
 * the semantic replacement.  The strict shared token matcher must stay strict;
 * this adapted reconcile path is allowed to use only explicit Target file
 * metadata plus merged non-closing PR provenance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateCloseGate,
  declaredTargetFiles,
  legacyAddressEvidence,
  negativeAcceptanceTokens,
  stripJavaScriptComments,
} from '../../scripts/ci/reconcile-followups.mjs';
import { detectAlreadyResolved } from '../../scripts/ci/followup-resolution-match.mjs';

const TARGET = 'scripts/ci/example.mjs';
const io = {
  fileExists: (path) => path === TARGET,
  readFile: () => [
    '// oldThing.exec(r.text) remains only as historical documentation',
    'const rows = [...r.text.matchAll(/row/g)];',
  ].join('\n'),
};
const addressed = [{
  number: 1332,
  mergedAt: '2026-09-11T02:43:33Z',
  body: '## Implementato\n\nAddresses #1249',
  files: [{ path: TARGET }],
}];

test('Target file è metadata live, non una citazione protetta', () => {
  const body = [
    '- Target file: scripts/ci/example.mjs',
    '- Original text:',
    '  > - Target file: scripts/ci/not-live.mjs',
  ].join('\n');
  assert.deepEqual(declaredTargetFiles(body, io.fileExists), [TARGET]);
});

test('negative acceptance marca solo la forma sostituita, non la forma nuova', () => {
  const item = [
    '- Target file: scripts/ci/example.mjs',
    '- Suggested action: sostituisci `oldThing.exec(r.text)` con `[...r.text.matchAll(...)]`.',
  ].join('\n');
  assert.deepEqual(negativeAcceptanceTokens(item), ['oldThing.exec(r.text)']);
});

test('absence check ignora commenti ma conserva stringhe eseguibili', () => {
  const stripped = stripJavaScriptComments([
    '// `--jq`, `length`',
    'const args = ["--jq", "length"];',
  ].join('\n'));
  assert.doesNotMatch(stripped, /`--jq`, `length`/);
  assert.match(stripped, /"--jq", "length"/);
});

test('legacy acceptance richiede Addresses + Target file e registra la negativa assente', () => {
  const item = [
    '- Target file: scripts/ci/example.mjs',
    '- Suggested action: sostituisci `oldThing.exec(r.text)` con `[...r.text.matchAll(...)]`.',
  ].join('\n');
  const result = legacyAddressEvidence(item, 1249, io, addressed);
  assert.equal(detectAlreadyResolved(item, io).resolved, false);
  assert.equal(result.resolved, true);
  assert.deepEqual(result.negativeTokens, ['oldThing.exec(r.text)']);
  assert.equal(result.evidence.some((entry) => entry.kind === 'legacy-address'), true);
  assert.equal(legacyAddressEvidence(item, 1249, io, []).resolved, false);
});

test('l’aggregata non ignora un item legacy privo di token ma con Target file', () => {
  const body = [
    '### 1. Forma sostituita',
    '- Target file: scripts/ci/example.mjs',
    '- Suggested action: sostituisci `oldThing.exec(r.text)` con `[...r.text.matchAll(...)]`.',
    '',
    '### 2. Item senza token storico',
    '- Target file: scripts/ci/example.mjs',
    '- Rationale: il PR già trasportato copre il target dichiarato.',
  ].join('\n');
  const gate = aggregateCloseGate(body, io, {
    legacyResolver: (item) => legacyAddressEvidence(item, 1249, io, addressed),
  });
  assert.deepEqual(gate, { blocks: false, reason: null });
});
