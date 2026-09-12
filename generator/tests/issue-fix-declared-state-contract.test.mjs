import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const WORKFLOW = readFileSync(
  new URL('../../.github/workflows/issue-fix.yml', import.meta.url),
  'utf8',
);
const promptStart = WORKFLOW.indexOf('          prompt: |');
const promptEnd = WORKFLOW.indexOf('\n      - name: Salva il lavoro parziale', promptStart);
const PROMPT = WORKFLOW.slice(promptStart, promptEnd);

test('issue-fix legge qualunque PR d’origine e riconosce owner decision', () => {
  assert.ok(promptStart >= 0 && promptEnd > promptStart, 'prompt issue-fix non trovato');
  assert.match(
    PROMPT,
    /follow-up[\s\S]*Addresses.*da PR #N.*qualunque PR citata come origine nel body/i,
  );
  assert.match(PROMPT, /blocked: decisione del proprietario.*blocked: owner decision/i);
});

test('#8041 adapted: il workflow corpus non inietta un registro decisioni vuoto', () => {
  // Il difetto dell’item sul sito nasce da `steps.tier.outputs.decision_registry`.
  // Questa variante adattata non produce né inietta quell’output: la sua
  // assenza è il contratto che impedisce di presentare un heading vuoto al fixer.
  assert.doesNotMatch(WORKFLOW, /decision_registry/);
});
