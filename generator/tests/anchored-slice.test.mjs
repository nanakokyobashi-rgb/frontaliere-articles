/**
 * Il ritaglio ancorato deve FALLIRE quando l'ancora non c'e'.
 *
 * #974 item 2: un `src.slice(src.indexOf(ancora), …)` con l'ancora sparita non
 * lancia — restituisce una regione degenere (vuota, o di un carattere, o quasi
 * tutto il file), e su una regione degenere ogni `assert.doesNotMatch` /
 * `assert.ok(!…)` passa. Il test resta verde proprio nel caso che deve
 * prendere. Questi casi pinnano il comportamento opposto per ciascuna delle
 * tre forme, perche' e' l'unica cosa che rende il helper migliore della riga
 * che sostituisce.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { anchorIndex, sliceFrom, sliceUntil, sliceBetween } from './lib/anchored-slice.mjs';

const SRC = 'alfa\nfunction bravo() {}\ncharlie\ndelta\n';

test('anchorIndex trova l\'ancora e la cerca dall\'offset richiesto', () => {
  assert.equal(anchorIndex(SRC, 'bravo'), SRC.indexOf('bravo'));
  assert.equal(anchorIndex('aXbXc', 'X', { from: 2 }), 3);
});

test('anchorIndex lancia sull\'ancora assente, e il messaggio la nomina', () => {
  assert.throws(
    () => anchorIndex(SRC, 'echo'),
    (err) => err instanceof Error && err.message.includes('"echo"'),
  );
  // Con label, il messaggio dice QUALE ritaglio si e' rotto.
  assert.throws(() => anchorIndex(SRC, 'echo', { label: 'corpo di bravo' }), /corpo di bravo/);
  // Presente ma prima dell'offset: e' comunque assente per questo ritaglio.
  assert.throws(() => anchorIndex(SRC, 'alfa', { from: 3 }), /non compare/);
});

test('sliceFrom parte dall\'ancora, e l\'offset negativo non diventa un indice dalla fine', () => {
  assert.ok(sliceFrom(SRC, 'function bravo').startsWith('function bravo'));
  assert.equal(sliceFrom(SRC, 'alfa', { offset: -100 }), SRC);
  // Il difetto: src.slice(-1) tornerebbe un carattere e ogni assertion
  // negativa su di esso passerebbe.
  assert.throws(() => sliceFrom(SRC, 'echo'), /ancora assente/);
});

test('sliceUntil si ferma all\'ancora invece di togliere un carattere solo', () => {
  assert.equal(sliceUntil(SRC, 'charlie'), 'alfa\nfunction bravo() {}\n');
  // src.slice(0, -1) restituirebbe quasi tutto il file: il ritaglio annullato
  // piu' silenzioso di tutti.
  assert.throws(() => sliceUntil(SRC, 'echo'), /ancora assente/);
});

test('sliceBetween pretende entrambe le ancore, nell\'ordine giusto', () => {
  assert.equal(sliceBetween(SRC, 'function', 'charlie'), 'function bravo() {}\n');
  assert.throws(() => sliceBetween(SRC, 'echo', 'charlie'), /"echo"/);
  assert.throws(() => sliceBetween(SRC, 'function', 'echo'), /"echo"/);
  // L'ancora finale si cerca DOPO quella iniziale: se compare solo prima,
  // `slice` darebbe la stringa vuota invece di dire che l'ordine e' sbagliato.
  assert.throws(() => sliceBetween(SRC, 'charlie', 'alfa'), /dopo l'offset/);
});

test('l\'ancora finale ripetuta e\' quella che segue l\'iniziale, non la prima del file', () => {
  const src = 'FINE\nINIZIO\nx\nFINE\n';
  assert.equal(sliceBetween(src, 'INIZIO', 'FINE'), 'INIZIO\nx\n');
});
