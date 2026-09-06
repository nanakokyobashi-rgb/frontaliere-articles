/**
 * review-step-names.test.mjs — i due nomi di step su cui pr-autorebase decide.
 *
 * ## Perche' esiste
 *
 * `pr-autorebase.mjs` non legge il log del job: legge la lista degli step dalla
 * jobs API e decide su DUE nomi, che vivono in due posti che non possono
 * importarsi a vicenda — const JS in `scripts/ci/lib/vitestCheck.mjs` e `name:`
 * di uno step in `.github/workflows/tests.yml` (AGENTS.md #6).
 *
 *   · `REVIEW_GATE_STEP_NAME` — se e' `failure`, il rosso del check richiesto e'
 *     il review gate e non i test (`vitestFailureIsReviewGate`).
 *   · `CLAUDE_REVIEW_STEP_NAME` — se e' `skipped`, su quella run la review NON
 *     e' girata: l'ha saltata il `Re-review guard` (`reviewSkippedByGuard`).
 *
 * Un rename di uno step e' esattamente il tipo di modifica che sembra innocua.
 * Se si separano non esplode niente: `vitestFailureIsReviewGate` smette di
 * riconoscere il gate e il messaggio all'operatore torna a dire «far passare i
 * test» a una PR coi test verdi; `reviewSkippedByGuard` smette di riconoscere
 * lo skip e il one-shot torna a essere speso in un close+reopen che, con la
 * review saltata, e' un no-op per costruzione. Entrambi in silenzio, dietro una
 * CI verde.
 *
 * Si pinna anche l'`if:` di `Run Claude review`, perche' e' la PREMESSA del
 * segnale: lo step risulta `skipped` per il guard solo finche' la sua
 * condizione dipende da `steps.guard.outputs.skip`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = path.join(ROOT, '.github/workflows/tests.yml');
const yaml = fs.readFileSync(WORKFLOW, 'utf8');

/** Tutti i `- name:` di step del workflow, senza un parser YAML (nessuna dep). */
function stepNames(src) {
  return src
    .split('\n')
    .map((l) => l.match(/^\s*-\s+name:\s*(.+?)\s*$/))
    .filter(Boolean)
    .map((m) => m[1].replace(/^['"]|['"]$/g, ''));
}

/** Il blocco di uno step, dal suo `- name:` al `- name:` successivo. */
function stepBlock(src, name) {
  const lines = src.split('\n');
  const at = lines.findIndex((l) => new RegExp(`^\\s*-\\s+name:\\s*['"]?${name}['"]?\\s*$`).test(l));
  assert.notEqual(at, -1, `tests.yml non ha uno step \`${name}\``);
  const out = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (/^\s*-\s+name:\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

test('REVIEW_GATE_STEP_NAME e CLAUDE_REVIEW_STEP_NAME combaciano con tests.yml', async () => {
  const { REVIEW_GATE_STEP_NAME, CLAUDE_REVIEW_STEP_NAME } = await import(
    '../../scripts/ci/lib/vitestCheck.mjs'
  );
  const names = stepNames(yaml);
  for (const [constName, value] of [
    ['REVIEW_GATE_STEP_NAME', REVIEW_GATE_STEP_NAME],
    ['CLAUDE_REVIEW_STEP_NAME', CLAUDE_REVIEW_STEP_NAME],
  ]) {
    assert.ok(
      names.includes(value),
      `${constName} vale "${value}", ma nessuno step di tests.yml si chiama cosi'. ` +
        'pr-autorebase decide sulla lista degli step: con il nome sbagliato non trova niente ' +
        'e sbaglia il verdetto in silenzio. Step presenti:\n  ' + names.join('\n  '),
    );
  }
});

test('lo step della review e\' `skipped` PER il guard: la sua condizione lo dice', async () => {
  const { CLAUDE_REVIEW_STEP_NAME } = await import('../../scripts/ci/lib/vitestCheck.mjs');
  const block = stepBlock(yaml, CLAUDE_REVIEW_STEP_NAME);
  const cond = block.match(/^\s*if:\s*(.+)$/m);
  assert.ok(cond, `lo step \`${CLAUDE_REVIEW_STEP_NAME}\` non ha un \`if:\``);
  assert.match(
    cond[1],
    /steps\.guard\.outputs\.skip/,
    'la condizione di `Run Claude review` non dipende piu\' dal `Re-review guard`. ' +
      '`reviewSkippedByGuard` legge `skipped` su quello step per dedurre che il guard ha ' +
      'saltato Claude: senza questa dipendenza il segnale diventa un\'altra cosa, e il ' +
      'one-shot verrebbe negato (o concesso) su una premessa che non vale piu\'.',
  );
});

test('il review gate gira anche a review saltata, altrimenti il segnale non esisterebbe', async () => {
  const { REVIEW_GATE_STEP_NAME } = await import('../../scripts/ci/lib/vitestCheck.mjs');
  const block = stepBlock(yaml, REVIEW_GATE_STEP_NAME);
  const cond = block.match(/^\s*if:\s*(.+)$/m);
  assert.ok(cond, `lo step \`${REVIEW_GATE_STEP_NAME}\` non ha un \`if:\``);
  // `always()` e nessuna dipendenza dal guard: e' cio' che rende possibile lo
  // stato «gate rosso + review saltata», cioe' proprio quello che
  // `reviewSkippedByGuard` riconosce.
  assert.match(cond[1], /always\(\)/, 'il review gate non gira piu\' con `always()`');
  assert.doesNotMatch(
    cond[1],
    /steps\.guard\.outputs\.skip/,
    'il review gate ora si salta insieme alla review: lo stato «gate rosso su verdetti ' +
      'gia\' postati» sparisce, e con esso il caso che `reviewSkippedByGuard` distingue.',
  );
});
