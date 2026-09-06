/**
 * loop-drift-init-only.test.mjs — `--init --only <path>` registra la baseline
 * di quelle sole voci (issue #653).
 *
 * ## Perché esiste
 *
 * `--init` è tutto-o-niente: riscrive la baseline di TUTTE le voci del
 * manifest. Chi ne deve registrare una sola — il caso normale, si aggiunge un
 * file e lo si dichiara — non può usarlo, perché dichiarerebbe «allineate»
 * trecento voci che nessuno ha letto, comprese quelle in `site-ahead` che
 * aspettano una decisione. Quindi quell'unica baseline veniva scritta A MANO,
 * e una stringa esadecimale scritta a mano è plausibile ma non è un hash: è il
 * `ghost-baseline` che `checkBaselineProvenance()` scopre solo al cron
 * successivo, a merge avvenuto. Misurate 13 voci fantasma il 2026-09-05, di
 * cui 6 dichiarate DOPO l'apertura della issue che ne contava 7 — la classe si
 * ricreava da sola finché registrarne una sola restava impossibile.
 *
 * ## Perché testa le funzioni pure e non la CLI
 *
 * `main()` fa rete (`siteHash`) e scrive il manifest reale: eseguirla in un
 * test la farebbe parlare con GitHub e riscrivere un file versionato.
 * `parseOnly` e `resolveInitTargets` sono pure per la stessa ragione per cui
 * lo sono `ghostVerdict` e `classify` — è ciò che le rende verificabili
 * offline, che è il modo in cui questa suite gira.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOnly, onlyArgError, resolveInitTargets } from '../../scripts/ci/loop-drift-check.mjs';

test('parseOnly: senza --only non filtra niente', () => {
  assert.equal(parseOnly(['--init']), null);
  assert.equal(parseOnly([]), null);
});

test('parseOnly: forma `--only=a,b`', () => {
  assert.deepEqual(parseOnly(['--init', '--only=scripts/ci/a.mjs,scripts/ci/b.mjs']), [
    'scripts/ci/a.mjs',
    'scripts/ci/b.mjs',
  ]);
});

test('parseOnly: forma separata `--only a b`, e si ferma alla flag successiva', () => {
  assert.deepEqual(parseOnly(['--init', '--only', 'a.mjs', 'b.mjs', '--json']), ['a.mjs', 'b.mjs']);
});

// --- `--only` che risolve vuoto (issue #978) ---------------------------------
//
// `[]` e `null` erano la stessa cosa, e `null` significa «nessun filtro»:
// `--init --only` in coda, `--only=`, o `--only "$VAR"` con la variabile non
// settata riscrivevano TUTTE le voci del manifest e bumpavano `alignedAt`.
// Scrivere la flag otteneva l'atto tutto-o-niente che la flag esiste per
// evitare, con exit 0. Ora la flag presente torna sempre un array, e un array
// vuoto e' un errore d'uso.

test('parseOnly: `--only` senza valori NON vale come assente', () => {
  assert.deepEqual(parseOnly(['--init', '--only', '--json']), []);
  assert.deepEqual(parseOnly(['--init', '--only']), []);
});

test('parseOnly: `--only=` vuoto o di soli separatori risolve a []', () => {
  assert.deepEqual(parseOnly(['--init', '--only=']), []);
  assert.deepEqual(parseOnly(['--init', '--only=,']), []);
  assert.deepEqual(parseOnly(['--init', '--only', '  ']), []);
});

test('onlyArgError: la flag assente non e\' un errore', () => {
  assert.equal(onlyArgError(null, true), null);
  assert.equal(onlyArgError(null, false), null);
});

test('onlyArgError: `--only` risolto vuoto e\' un errore, con o senza --init', () => {
  assert.match(onlyArgError([], true), /non ha risolto nessun path/);
  assert.match(onlyArgError([], false), /non ha risolto nessun path/);
});

test('onlyArgError: `--only` senza `--init` resta un errore d\'uso', () => {
  assert.match(onlyArgError(['a.mjs'], false), /ha senso solo con `--init`/);
  assert.equal(onlyArgError(['a.mjs'], true), null);
});

test('resolveInitTargets: nessun filtro → tutte le voci, come `--init` storico', () => {
  const { targets, unknown } = resolveInitTargets(null, ['a.mjs', 'b.mjs']);
  assert.equal(targets, null);
  assert.deepEqual(unknown, []);
});

test('resolveInitTargets: filtra alle sole voci chieste', () => {
  const { targets, unknown } = resolveInitTargets(['b.mjs'], ['a.mjs', 'b.mjs', 'c.mjs']);
  assert.deepEqual([...targets], ['b.mjs']);
  assert.deepEqual(unknown, []);
  assert.equal(targets.has('a.mjs'), false);
});

test('resolveInitTargets: `[]` non degrada a «tutte» — non tocca NIENTE', () => {
  // La difesa in profondita' dietro `onlyArgError`: la funzione pura non deve
  // fail-open da sola se un chiamante futuro dimentica il guard.
  const { targets, unknown } = resolveInitTargets([], ['a.mjs', 'b.mjs']);
  assert.notEqual(targets, null);
  assert.equal(targets.size, 0);
  assert.deepEqual(unknown, []);
});

test('resolveInitTargets: un path non dichiarato viene riportato, non ignorato', () => {
  // Silenziarlo scriverebbe un manifest che NON contiene la voce che si
  // voleva registrare: il refuso resterebbe invisibile fino al cron.
  const { unknown } = resolveInitTargets(['scripts/ci/refuso.mjs'], ['a.mjs']);
  assert.deepEqual(unknown, ['scripts/ci/refuso.mjs']);
});
