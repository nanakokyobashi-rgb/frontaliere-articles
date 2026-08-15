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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const active = (src) =>
  src
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');

const GA_RAW = read('.github/workflows/generate-article.yml');
const GA = active(GA_RAW);

/** Lo step chiamante che invoca la composite action, fino allo step successivo. */
function callerStepBlock(src) {
  const idx = src.indexOf('uses: ./.github/actions/setup-claude-haiku-fallback');
  assert.ok(idx !== -1, 'lo step che invoca setup-claude-haiku-fallback non è stato trovato');
  // Risali all'inizio dello step (la riga `- name:`), poi scendi fino al
  // prossimo step a pari livello di indentazione (`\n      - name:`).
  const before = src.slice(0, idx);
  const stepStart = before.lastIndexOf('\n      - name:');
  assert.ok(stepStart !== -1, 'inizio dello step chiamante non trovato');
  const rest = src.slice(stepStart + 1);
  const next = rest.indexOf('\n      - name:', 1);
  return next === -1 ? rest : rest.slice(0, next);
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
  const idx = GA.indexOf('- name: Generate the article');
  assert.ok(idx !== -1, 'step "Generate the article" non trovato');
  const rest = GA.slice(idx);
  const next = rest.indexOf('\n      - name:', 1);
  const genStep = next === -1 ? rest : rest.slice(0, next);
  assert.ok(
    !/steps\.[\w-]*haiku[\w-]*\.(outcome|conclusion)/i.test(genStep),
    '"Generate the article" ha iniziato a leggere l\'outcome dello step Haiku: se lo fa, il ' +
      'continue-on-error smette di bastare a farlo girare comunque.',
  );
});

test('generate-article: continue-on-error non è finito, per errore, sull\'intero job', () => {
  assert.ok(
    !/^continue-on-error:/m.test(GA),
    'Un `continue-on-error` a livello di job renderebbe verde l\'intero job anche su un fallimento ' +
      'reale della generazione — troppo largo. Deve restare sullo step chiamante di Haiku soltanto.',
  );
});
