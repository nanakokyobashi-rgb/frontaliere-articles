/**
 * ignore-list-semantics.test.mjs — `IGNORE_WORKFLOWS: ''` deve significare
 * "non ignorare niente".
 *
 * Trovato dalla review automatica al primo giro reale del ciclo (PR #15). Il
 * codice era:
 *
 *   process.env.IGNORE_WORKFLOWS || 'Claude token smoke'
 *
 * Con `||` la stringa vuota e' falsy, quindi impostare la variabile a `''` per
 * svuotare la lista otteneva in silenzio l'ESATTO CONTRARIO: la lista di
 * default. Nessun errore, nessun log — solo un workflow che continuava a
 * essere ignorato mentre la configurazione diceva di non ignorarne nessuno.
 *
 * E' la stessa classe di difetto che questo repo ha gia' incontrato piu' volte:
 * una configurazione che sembra applicata e non lo e'.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIgnoreList } from '../../scripts/ci/scan-failed-runs.mjs';

test('la stringa vuota svuota la lista, non ricade sul default', () => {
  assert.deepEqual([...parseIgnoreList('')], [], "`IGNORE_WORKFLOWS: ''` deve significare 'non ignorare niente'");
});

test('variabile non definita → lista vuota', () => {
  assert.deepEqual([...parseIgnoreList(undefined)], []);
  assert.deepEqual([...parseIgnoreList(null)], []);
});

test('lista con separatori e spazi', () => {
  assert.deepEqual([...parseIgnoreList('  uno ,due,  tre  ')], ['uno', 'due', 'tre']);
  // Le virgole vuote non devono produrre voci fantasma: una voce '' matcherebbe
  // un workflowName vuoto e sarebbe invisibile a chi legge la config.
  assert.deepEqual([...parseIgnoreList('uno,,due,')], ['uno', 'due']);
});

test('importare il modulo non esegue lo scanner', () => {
  // Senza guardia CLI, un `import` da un test farebbe girare main() — che apre
  // issue sul repo. Se questo test esiste ed e' verde, la guardia c'e'.
  assert.equal(typeof parseIgnoreList, 'function');
});
