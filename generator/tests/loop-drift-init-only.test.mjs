/**
 * loop-drift-init-only.test.mjs — pinna l'affordance che chiude la classe
 * `ghost-baseline` alla sorgente (issue #653).
 *
 * ## Perché le baseline fantasma si ricreano da sole
 *
 * `checkBaselineProvenance()` (issue #148) SCOPRE una baseline mai esistita,
 * ma solo al cron successivo, dopo il merge. La domanda che nessuno si era
 * posto è perché continuassero a nascerne: `--init` è tutto-o-niente, riscrive
 * le baseline di tutte e ~313 le voci del manifest. Chi ne deve registrare
 * UNA — il caso normale, si aggiunge un file e lo si dichiara — non può
 * usarlo, perché dichiarerebbe «allineate» trecento voci che nessuno ha letto,
 * incluse quelle in `site-ahead` che aspettano una decisione. Quindi
 * `baseline.corpus` viene scritta A MANO, e una stringa esadecimale scritta a
 * mano è plausibile ma non è un hash.
 *
 * La misura del 2026-09-04: 12 voci fantasma, di cui CINQUE nate dopo
 * l'apertura della issue che ne contava 7 — la classe si ricreava da sola,
 * quindi riparare i 12 dati senza dare un modo onesto di registrarne uno solo
 * avrebbe riportato lo stesso numero in due settimane.
 *
 * `--init --only <path>` è quel modo. Questi test coprono il pezzo PURO —
 * parsing degli argomenti e scelta dei bersagli — senza rete e senza scrivere
 * il manifest, con lo stesso schema di `loop-drift-check-provenance.test.mjs`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOnly, resolveInitTargets } from '../../scripts/ci/loop-drift-check.mjs';

test('senza --only il parsing restituisce null, non una lista vuota', () => {
  assert.equal(parseOnly(['--init']), null);
  assert.equal(parseOnly([]), null);
});

test('--only=a,b e --only a b sono la stessa cosa', () => {
  assert.deepEqual(parseOnly(['--init', '--only=x/a.mjs,x/b.mjs']), ['x/a.mjs', 'x/b.mjs']);
  assert.deepEqual(parseOnly(['--init', '--only', 'x/a.mjs', 'x/b.mjs']), ['x/a.mjs', 'x/b.mjs']);
});

test('--only nella forma separata si ferma alla flag successiva, non la inghiotte', () => {
  // Senza questa regola `--only x --json` registrerebbe una voce chiamata
  // "--json", che non esiste nel manifest: il fallimento sarebbe oscuro invece
  // che assente, ma resta un fallimento evitabile.
  assert.deepEqual(parseOnly(['--init', '--only', 'x/a.mjs', '--json']), ['x/a.mjs']);
});

test('nessun --only: `targets` null, cioe\' il comportamento storico di --init (tutte le voci)', () => {
  const r = resolveInitTargets(null, ['a', 'b', 'c']);
  assert.equal(r.targets, null, '`--init` senza filtro deve restare tutto-o-niente come prima');
  assert.deepEqual(r.unknown, []);
});

test('--only con path dichiarati: solo quelli finiscono nei bersagli', () => {
  const r = resolveInitTargets(['b'], ['a', 'b', 'c']);
  assert.deepEqual([...r.targets], ['b']);
  assert.deepEqual(r.unknown, []);
});

test('IL CASO #653: un path NON dichiarato viene segnalato, non ignorato', () => {
  // Un `--only` scritto male che non scrive niente e esce 0 riporterebbe
  // esattamente alla scrittura a mano che ha prodotto i fantasmi: il chiamante
  // crederebbe di aver registrato la baseline.
  const r = resolveInitTargets(['scripts/ci/typo.mjs'], ['a', 'b']);
  assert.deepEqual(r.unknown, ['scripts/ci/typo.mjs']);
});

test('i path chiesti a --only esistono davvero nel manifest reale', async () => {
  // Cordone fra la CLI documentata e il dato: se un giorno il manifest cambia
  // forma, questo test lo dice prima che `--only` diventi inutilizzabile.
  const { default: manifest } = await import('../../scripts/ci/loop-sync-manifest.json', { with: { type: 'json' } });
  const paths = manifest.files.map((f) => f.path);
  const r = resolveInitTargets(['scripts/ci/loop-drift-check.mjs'], paths);
  assert.deepEqual(r.unknown, [], '`scripts/ci/loop-drift-check.mjs` deve essere una voce del manifest');
  assert.equal(r.targets.size, 1);
});
