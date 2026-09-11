/**
 * Regressions for legacy per-PR follow-ups whose prose mixes a stale token with
 * the semantic replacement.  The strict shared token matcher must stay strict;
 * this adapted reconcile path is allowed to use only explicit Target file
 * metadata plus merged non-closing PR provenance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addressedMergedRows,
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

function semanticResult(issue, target, action, source) {
  const item = [
    `- Target file: ${target}`,
    `- Suggested action: ${action}`,
  ].join('\n');
  return legacyAddressEvidence(item, issue, {
    fileExists: (path) => path === target,
    readFile: () => source,
  }, [{
    number: issue + 1000,
    mergedAt: '2026-09-11T04:00:00Z',
    body: `## Implementato\n\nAddresses #${issue}`,
    files: [{ path: target }],
  }]);
}

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

test('la provenienza Addresses ricade sulla lista merged quando la search è vuota', () => {
  const rows = addressedMergedRows(1259, [], [
    { number: 1335, body: 'Addresses #1259' },
    { number: 1336, body: 'Closes #1259' },
    { number: 1335, body: 'Addresses #1259 (duplicato)' },
  ]);
  assert.deepEqual(rows.map((row) => row.number), [1335]);
});

test('legacy accetta un ordine esplicito solo se le dichiarazioni live lo rispettano', () => {
  const result = semanticResult(
    1075,
    'generator/tests/corpus-write-atomic.test.mjs',
    'asserire `missing` prima di `dead`.',
    'const missing = found.filter(Boolean);\nconst dead = excuses.filter(Boolean);',
  );
  assert.equal(result.resolved, true);
  assert.equal(result.evidence.find((entry) => entry.kind === 'legacy-semantic')?.rule, 'ordered-declarations');
  const blocked = semanticResult(
    1075,
    'generator/tests/corpus-write-atomic.test.mjs',
    'asserire `missing` prima di `dead`.',
    'const dead = excuses.filter(Boolean);\nconst missing = found.filter(Boolean);',
  );
  assert.equal(blocked.resolved, false);
});

test('legacy controlla il ramo di rientro nel ciclo, non una stringa vuota qualsiasi', () => {
  const result = semanticResult(
    1075,
    'generator/tests/lib/reachable-source.mjs',
    'far restituire `text: ownSource` invece di `text: \'\'` nel ramo di `ancestors.has(file)`.',
    'if (ancestors.has(file)) return { text: ownSource, cyclic: true };\nreturn { text: \'\', cyclic: false };',
  );
  assert.equal(result.resolved, true);
  assert.equal(result.evidence.find((entry) => entry.kind === 'legacy-semantic')?.rule, 'cycle-reentry-own-source');
});

test('legacy riconosce il guard positivo equivalente con prova strutturale completa', () => {
  const result = semanticResult(
    1076,
    'scripts/ci/reconcile-routing-labels.mjs',
    'validare l’argomento con `n > 0` prima di chiamare `fetchCandidates()`.',
    [
      "const only = Number(value);",
      "if (iOnly >= 0 && (!Number.isInteger(only) || only <= 0)) {",
      "  console.error('--issue');",
      '  process.exitCode = 1;',
      '}',
      'fetchCandidates(only);',
    ].join('\n'),
  );
  assert.equal(result.resolved, true);
  assert.equal(result.evidence.find((entry) => entry.kind === 'legacy-semantic')?.rule, 'positive-integer-issue-guard');
});

test('legacy richiede tutti i veto del rescue, non solo il nome del predicato', () => {
  const action = 'verificare `isDrainPromotable()` per `agent:fix` e `agent:fix-queued`.';
  const source = [
    'function isStuckFixRescueCandidate(iss) {',
    '  return isQueueManaged(iss)',
    '    && !has(iss, LBL_QUEUED)',
    '    && !has(iss, LBL_PARKED)',
    '    && !isDecomposedParent(iss);',
    '}',
  ].join('\n');
  const result = semanticResult(1076, 'scripts/ci/followup-drainer.mjs', action, source);
  assert.equal(result.resolved, true);
  assert.equal(result.evidence.find((entry) => entry.kind === 'legacy-semantic')?.rule, 'stuck-fix-rescue-predicate');
  assert.equal(
    semanticResult(1076, 'scripts/ci/followup-drainer.mjs', action, 'function isStuckFixRescueCandidate() {}').resolved,
    false,
  );
});

test('legacy verifica i frammenti letterali del warning con placeholder runtime', () => {
  const result = semanticResult(
    1076,
    'scripts/ci/reconcile-routing-labels.mjs',
    'stampare `::warning::reconcile: N falliti su M` separatamente.',
    'console.log(`::warning::reconcile: ${failed} falliti su ${todo.length}.`);',
  );
  assert.equal(result.resolved, true);
  assert.equal(result.evidence.find((entry) => entry.kind === 'legacy-semantic')?.rule, 'template-fragments');
});

test('legacy controlla che la transizione decompose sia un solo edit atomico', () => {
  const result = semanticResult(
    1076,
    '.github/workflows/issue-decompose.yml',
    'rendere atomica la transizione in `issue-decompose.yml:L154`.',
    'gh issue edit $ISSUE_NUMBER --add-label "decomposed:1" --remove-label agent:decompose',
  );
  assert.equal(result.resolved, true);
  assert.equal(result.evidence.find((entry) => entry.kind === 'legacy-semantic')?.rule, 'atomic-decompose-label-edit');
  assert.equal(
    semanticResult(1076, '.github/workflows/issue-decompose.yml', 'rendere atomica la transizione in `issue-decompose.yml:L154`.', 'gh issue edit --add-label only\ngh issue edit --remove-label later').resolved,
    false,
  );
});

test('legacy riconosce containment remoto solo con default branch e head della PR', () => {
  const result = semanticResult(
    1077,
    '.github/workflows/orphan-push-warn.yml',
    'usare `git merge-base --is-ancestor "$SHA" "$MERGE_COMMIT"`.',
    [
      'DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}',
      'MAIN_CONTAINMENT=$(gh api "repos/${REPO}/compare/${SHA}...${DEFAULT_BRANCH}")',
      'CONTAINMENT=$(gh api "repos/${REPO}/compare/${SHA}...${HEAD_OID}")',
      'if [ "$MAIN_CONTAINMENT" = "ahead" ] || [ "$MAIN_CONTAINMENT" = "identical" ]; then',
      'if [ "$CONTAINMENT" = "ahead" ] || [ "$CONTAINMENT" = "identical" ]; then',
    ].join('\n'),
  );
  assert.equal(result.resolved, true);
  assert.equal(result.evidence.find((entry) => entry.kind === 'legacy-semantic')?.rule, 'remote-containment-equivalent');
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

test('la provenienza dichiarativa da sola non risolve un item senza prova contenutistica', () => {
  const item = [
    '- Target file: scripts/ci/example.mjs',
    '- Rationale: il trasporto ufficiale dichiara il target corretto.',
  ].join('\n');
  const result = legacyAddressEvidence(item, 1249, io, addressed);
  assert.equal(result.resolved, false);
});

test('il trasporto richiede identità riconoscibile e target nei suoi files', () => {
  const item = [
    '- Target file: scripts/ci/example.mjs',
    '- Suggested action: sostituisci `oldThing.exec(r.text)` con `[...r.text.matchAll(...)]`.',
  ].join('\n');
  const transported = [{
    number: 1335,
    mergedAt: '2026-09-11T03:28:43Z',
    title: 'chore(loop): trasporto ufficiale',
    body: 'Addresses #1259',
    files: [],
    supportingPrs: [{
      number: 1333,
      mergedAt: '2026-09-11T03:14:48Z',
      title: 'Lockstep crawler workflows with the site',
      headRefName: 'crawler-workflows-lockstep-test',
      files: [{ path: TARGET }],
    }],
  }];
  const result = legacyAddressEvidence(item, 1259, io, transported);
  assert.equal(result.resolved, true);
  assert.equal(result.evidence.find((entry) => entry.kind === 'legacy-address').transportPr, 1333);
  assert.equal(legacyAddressEvidence(item, 1259, io, [{
    number: 1335,
    mergedAt: '2026-09-11T03:28:43Z',
    body: 'Addresses #1259 — sync',
    files: [],
  }]).resolved, false);
});

test('l’aggregata non promuove un item solo-prosa con Target file a item di gating', () => {
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
    legacyResolver: (item) => item.includes('Item senza token storico')
      ? { resolved: false, eligible: true }
      : legacyAddressEvidence(item, 1249, io, addressed),
  });
  assert.deepEqual(gate, { blocks: false, reason: null });
});
