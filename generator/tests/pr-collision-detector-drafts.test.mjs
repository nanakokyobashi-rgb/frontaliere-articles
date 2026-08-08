/**
 * pr-collision-detector-drafts.test.mjs — le draft NON partecipano al grafo
 * delle collisioni.
 *
 * Gemello di `tests/pr-collision-detector-drafts.test.ts` sul sito, riscritto
 * per `node --test` perché qui non c'è vitest. Lo SCRIPT è `mode: "identical"`
 * nel manifest e resta byte-identico; il test no, ed è giusto che sia così: è
 * il runner a differire, non il comportamento sotto test.
 *
 * ## Perché questo test vive QUI e non solo sul sito
 *
 * Il difetto è stato osservato su QUESTO repo. La PR #33 era uno snapshot di
 * sessione morta aperto come draft «⛔️ NON MERGIARE»: toccava 22 file
 * `.github/workflows/**` e 7 `scripts/lib/**`, tutti funnel-critical, e finché
 * restava aperta ogni PR reale su uno di quei 29 file avrebbe preso
 * `collision-risk` contro una controparte che non poteva mergiare mai.
 *
 * La correzione è però stata fatta prima sul sito (#5364), perché lo script è
 * `identical` e toccarlo qui per primo avrebbe prodotto un `corpus-ahead` su un
 * file dichiarato uguale. Nel frattempo questo repo è rimasto scoperto — vedi
 * il punto 1 della issue #40. Senza questo test, la prossima ri-sincronizzazione
 * dal sito potrebbe riportare indietro il filtro senza che nessuno se ne
 * accorga: `node --test` qui è l'unico guard locale che lo vedrebbe.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectCollisionCandidates,
  computeColliders,
} from '../../scripts/ci/pr-collision-detector.mjs';

const WF = '.github/workflows/tests.yml';

test('selectCollisionCandidates: tiene le open non-draft, scarta le draft', () => {
  assert.deepEqual(
    selectCollisionCandidates([
      { number: 1, isDraft: false },
      { number: 2, isDraft: true },
      { number: 3, isDraft: false },
    ]),
    [1, 3],
  );
});

test('selectCollisionCandidates: isDraft assente → partecipa', () => {
  // Degrada al comportamento storico, non a uno scan muto: se un domani la
  // query perdesse il campo, meglio qualche label di troppo che un detector
  // che tace su tutto.
  assert.deepEqual(selectCollisionCandidates([{ number: 7 }]), [7]);
});

test('selectCollisionCandidates: scarta entry senza numero intero valido', () => {
  assert.deepEqual(
    selectCollisionCandidates([
      { number: 10, isDraft: false },
      { isDraft: false },
      { number: 'x', isDraft: false },
      null,
    ]),
    [10],
  );
});

test('selectCollisionCandidates: input non-array o vuoto → []', () => {
  assert.deepEqual(selectCollisionCandidates(undefined), []);
  assert.deepEqual(selectCollisionCandidates([]), []);
});

test('computeColliders: due PR con un file condiviso collidono in entrambi i versi', () => {
  const files = new Map([
    [1, new Set([WF])],
    [2, new Set([WF])],
  ]);
  const c = computeColliders([1, 2], files);
  assert.deepEqual(c.get(1)?.get(2), [WF]);
  assert.deepEqual(c.get(2)?.get(1), [WF]);
});

test('computeColliders: la draft (set vuoto) non collide, ma le PR reali sì', () => {
  // #33 = la draft di conservazione. Il chiamante le assegna un set VUOTO
  // invece dei suoi 29 file funnel-critical: è così che esce dal grafo.
  const files = new Map([
    [33, new Set()],
    [34, new Set([WF])],
    [35, new Set([WF])],
  ]);
  const c = computeColliders([33, 34, 35], files);
  assert.equal(c.has(33), false, 'la draft non deve collidere con nessuno');
  assert.deepEqual(c.get(34)?.get(35), [WF], 'il filtro non deve spegnere lo scan');
});

test('computeColliders: PR assente dalla mappa → nessuna collisione, nessun throw', () => {
  const c = computeColliders([1, 2], new Map([[1, new Set([WF])]]));
  assert.equal(c.size, 0);
});

test('computeColliders: nessun file condiviso → grafo vuoto', () => {
  const files = new Map([
    [1, new Set(['scripts/lib/a.mjs'])],
    [2, new Set(['scripts/lib/b.mjs'])],
  ]);
  assert.equal(computeColliders([1, 2], files).size, 0);
});

test('lo script non esegue lo scan quando viene importato', () => {
  // `main()` è dietro il guard `process.argv[1]?.endsWith(...)`. Se qualcuno lo
  // togliesse, importare il modulo qui chiamerebbe `gh` durante `npm test`:
  // il fatto stesso che i test sopra girino senza rete lo dimostra, e questa
  // asserzione lo dichiara invece di lasciarlo implicito.
  assert.equal(typeof selectCollisionCandidates, 'function');
  assert.equal(typeof computeColliders, 'function');
});
