/**
 * haiku-setup-resilient.test.mjs — issue #367: il setup del fallback Haiku
 * (OPZIONALE) non deve poter abbattere l'intero job `generate-article`.
 *
 * ## Perché uno step-scan dello YAML, e perché proprio qui
 *
 * `.github/actions/setup-claude-haiku-fallback/action.yml` è una composite
 * action, e gli step di una composite action NON supportano `continue-on-error`
 * (nulla lo assorbe dentro `action.yml` stesso, storicamente): il solo posto in
 * cui il flag può vivere ed essere onorato da GitHub è lo STEP CHIAMANTE in
 * `generate-article.yml`, quello con `uses: ./.github/actions/setup-claude-haiku-fallback`.
 * Prima della fix, zero occorrenze di `continue-on-error` in tutto il file: un
 * fallimento di rete su `npm install -g @anthropic-ai/claude-code` (step
 * "Setup Claude CLI Haiku fallback" dentro la composite action) abbatteva
 * l'intero job, incluso lo step "Generate the article" a valle — che NON
 * dipende dall'esito di questo step, solo da `steps.mode.outputs.dry`.
 *
 * Come `loop-workflow-triggers.test.mjs`: questo è YAML interpretato da
 * GitHub, non codice eseguibile — un source-scan è l'unica forma di test che
 * ha senso qui, e costa microsecondi.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workflowSteps } from './lib/workflow-steps.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const active = (src) =>
  src
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');

const GA_RAW = read('.github/workflows/generate-article.yml');
const GA = active(GA_RAW);

/**
 * Lo step chiamante che invoca la composite action. I confini si cercavano sul
 * `- name:` precedente e successivo: con uno step senza nome davanti, il blocco
 * partiva troppo indietro e il `continue-on-error` di un ALTRO step passava per
 * suo (#935 item 1).
 */
function callerStepBlock(src) {
  const step = workflowSteps(src)
    .find((s) => s.text.includes('uses: ./.github/actions/setup-claude-haiku-fallback'));
  assert.ok(step, 'lo step che invoca setup-claude-haiku-fallback non è stato trovato');
  return step.text;
}

test('generate-article: lo step che invoca setup-claude-haiku-fallback ha continue-on-error', () => {
  const step = callerStepBlock(GA);
  assert.match(
    step,
    /uses: \.\/\.github\/actions\/setup-claude-haiku-fallback/,
    'blocco trovato non contiene la `uses:` attesa — estrazione dello step sbagliata',
  );
  assert.match(
    step,
    /continue-on-error:\s*true/,
    'Lo step chiamante non ha `continue-on-error: true`. Gli step delle composite action non ' +
      'supportano questo flag al proprio interno, quindi deve stare QUI: senza, un fallimento di ' +
      'rete su `npm install -g @anthropic-ai/claude-code` (opzionale per costruzione) abbatte ' +
      'l\'intero job, incluso "Generate the article" a valle che non dipende dal suo esito.',
  );
});

test('generate-article: "Generate the article" non dipende dall\'esito dello step Haiku', () => {
  const step = workflowSteps(GA).find((s) => s.name === 'Generate the article');
  assert.ok(step, 'step "Generate the article" non trovato');
  const genStep = step.text;
  assert.ok(
    !/steps\.[\w-]*haiku[\w-]*\.(outcome|conclusion)/i.test(genStep),
    '"Generate the article" ha iniziato a leggere l\'outcome dello step Haiku: se lo fa, il ' +
      'continue-on-error smette di bastare a farlo girare comunque.',
  );
});

test('generate-article: continue-on-error non è finito, per errore, sull\'intero job', () => {
  // Non basta cercare la chiave a colonna 0 (lì non può stare in un workflow):
  // un flag a livello di job vive a 4 spazi sotto `generate:` e renderebbe
  // verde il job anche su un fallimento reale della generazione. L'invariante
  // vera è: OGNI occorrenza del flag nel file sta dentro lo step chiamante di
  // Haiku, e lì ce n'è una sola.
  const step = callerStepBlock(GA);
  const inStep = (step.match(/continue-on-error:/g) ?? []).length;
  const total = (GA.match(/continue-on-error:/g) ?? []).length;
  assert.equal(inStep, 1, 'lo step chiamante di Haiku deve avere esattamente un `continue-on-error`');
  assert.equal(
    total,
    inStep,
    'C\'è un `continue-on-error` fuori dallo step chiamante di Haiku (a livello di job, o su un ' +
      'altro step): renderebbe verdi fallimenti reali. Deve restare sullo step Haiku soltanto — ' +
      'se un altro step lo acquisisce di proposito, aggiorna questo test dichiarandolo.',
  );
});
