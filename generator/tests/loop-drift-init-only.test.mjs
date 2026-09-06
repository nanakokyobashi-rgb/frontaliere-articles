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
import { parseOnly, onlyArgError, forceArgError, resolveInitTargets, initWriteVerdict, initPassOutcome } from '../../scripts/ci/loop-drift-check.mjs';

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

// --- `--init` che seppellisce un drift aperto (issue #978) --------------------
//
// `--init` scrive `now` su entrambi i lati e `alignedAt` = oggi. Su una voce
// gia' allineata e' una registrazione; su una voce in `site-ahead` o
// `both-moved` e' la CHIUSURA di un drift che nessuno ha riconciliato — il
// file non e' stato portato, ma il giorno dopo il report lo dice `stable`.
// `--only` abbassa la frizione della registrazione singola, e con essa quella
// della sepoltura. Stesso guard per il caso simmetrico che prima usciva come
// un warning dentro un comando verde: registrare `identical` con i due lati
// diversi produce un `undeclared-drift` che il trasporto smette di copiare.

const H = { a: 'aaaa1111aaaa1111', b: 'bbbb2222bbbb2222', c: 'cccc3333cccc3333' };

test('initWriteVerdict: una voce allineata si riscrive senza attriti', () => {
  const v = initWriteVerdict(
    { mode: 'identical' },
    { site: H.a, corpus: H.a },
    { site: H.a, corpus: H.a },
    'stable',
  );
  assert.equal(v.blocked, false);
});

test('initWriteVerdict: un drift APERTO su una voce gia\' registrata blocca la riscrittura', () => {
  for (const state of ['site-ahead', 'both-moved', 'undeclared-drift']) {
    const v = initWriteVerdict(
      { mode: 'adapted' },
      { site: H.b, corpus: H.c },
      { site: H.a, corpus: H.c },
      state,
    );
    assert.equal(v.blocked, true, state);
    assert.match(v.why, /drift APERTO/);
    assert.match(v.why, new RegExp(state));
  }
});

test('initWriteVerdict: una voce NUOVA passa — anche `adapted`, che diverge per costruzione', () => {
  // E' il caso d'uso primario di `--only` (issue #653): se anche questo
  // fosse bloccato, la baseline tornerebbe a scriversi a mano, cioe'
  // tornerebbe la classe `ghost-baseline` che quella flag esiste per chiudere.
  const v = initWriteVerdict(
    { mode: 'adapted' },
    { site: H.a, corpus: H.b },
    { site: null, corpus: null },
    'both-moved',
  );
  assert.equal(v.blocked, false);
  assert.equal(initWriteVerdict({ mode: 'adapted' }, { site: H.a, corpus: H.b }, null, 'both-moved').blocked, false);
});

test('initWriteVerdict: registrare un `identical` con i due lati diversi e\' bloccato, non un warning', () => {
  // Anche da voce nuova: qui non c'e' nessun verdetto da seppellire, ma la
  // scrittura ne FABBRICA uno — `undeclared-drift`, che `transportVerdict()`
  // non copia. Il gemello uscirebbe dal trasporto senza che niente fallisca.
  const v = initWriteVerdict(
    { mode: 'identical' },
    { site: H.a, corpus: H.b },
    { site: null, corpus: null },
    'both-moved-converged',
  );
  assert.equal(v.blocked, true);
  assert.match(v.why, /due lati DIVERSI/);
});

test('initWriteVerdict: un lato assente non e\' una divergenza `identical`', () => {
  // `corpus-only*` e i 404: `now.site` null non e' «diverso», e bloccare qui
  // renderebbe impossibile registrare le voci senza gemello.
  assert.equal(initWriteVerdict({ mode: 'identical' }, { site: null, corpus: H.a }, null, 'stable').blocked, false);
  assert.equal(initWriteVerdict({ mode: 'corpus-only' }, { site: null, corpus: H.a }, null, 'corpus-only').blocked, false);
});

test('initWriteVerdict: gli stati non-drift di una voce registrata non bloccano', () => {
  // `corpus-ahead` e `both-moved-converged` sono i due casi che il report
  // stesso indica come «da ri-baselinare con --init»: bloccarli renderebbe la
  // flag inutilizzabile proprio dove serve.
  for (const state of ['stable', 'corpus-ahead', 'both-moved-converged', 'not-ported-stable']) {
    const v = initWriteVerdict({ mode: 'adapted' }, { site: H.a, corpus: H.b }, { site: H.a, corpus: H.c }, state);
    assert.equal(v.blocked, false, state);
  }
});

// --- granularita' del rifiuto (issue #978) -----------------------------------
//
// Il primo taglio del guard rifiutava ATOMICAMENTE: una voce bloccata e il
// manifest non veniva scritto affatto. Ma il manifest ha voci parcheggiate di
// proposito in `both-moved` — `generator/scripts/lib/ai-models.mjs` aspetta
// #787 — quindi `--init` globale, il comando documentato nell'header, non
// sarebbe potuto riuscire MAI PIU', e l'unico sblocco (`--force`) avrebbe
// riscritto anche quella: l'unico uso possibile del comando sarebbe stato
// esattamente la sepoltura che il guard esiste per impedire.

test('forceArgError: `--force` senza `--init` e\' un errore d\'uso', () => {
  assert.match(forceArgError(true, false, null), /solo con `--init`/);
});

test('forceArgError: `--force` va NOMINATO — senza `--only` non sblocca niente', () => {
  // E' il punto: la sepoltura di massa non deve essere raggiungibile con una
  // sola flag. Chi chiude un drift dice QUALE.
  assert.match(forceArgError(true, true, null), /--only/);
  assert.match(forceArgError(true, true, []), /--only/);
  assert.equal(forceArgError(true, true, ['scripts/ci/a.mjs']), null);
});

test('forceArgError: senza `--force` non c\'e\' niente da validare', () => {
  assert.equal(forceArgError(false, true, null), null);
  assert.equal(forceArgError(false, false, null), null);
});

test('initPassOutcome: una voce bloccata NON impedisce di registrare le altre', () => {
  const o = initPassOutcome({ written: 328, blocked: 1, targeted: false });
  assert.equal(o.write, true, 'le 328 passate si scrivono');
  assert.equal(o.exitCode, 1, 'ma la passata non e\' pulita');
  assert.equal(o.bumpAlignedAt, false, 'l\'allineamento non e\' stato integrale');
});

test('initPassOutcome: passata globale pulita → scrive e bumpa `alignedAt`', () => {
  assert.deepEqual(initPassOutcome({ written: 329, blocked: 0, targeted: false }), {
    write: true,
    bumpAlignedAt: true,
    exitCode: 0,
  });
});

test('initPassOutcome: con `--only` `alignedAt` globale non si bumpa mai', () => {
  // Bumparlo direbbe che trecento voci sono state rilette oggi quando non le
  // ha guardate nessuno.
  assert.equal(initPassOutcome({ written: 1, blocked: 0, targeted: true }).bumpAlignedAt, false);
  assert.equal(initPassOutcome({ written: 1, blocked: 0, targeted: true }).exitCode, 0);
});

test('initPassOutcome: se TUTTE le voci sono bloccate non si scrive niente', () => {
  // Riscrivere il manifest identico produrrebbe un commit vuoto che sembra un
  // `--init` andato a buon fine.
  assert.deepEqual(initPassOutcome({ written: 0, blocked: 2, targeted: true }), {
    write: false,
    bumpAlignedAt: false,
    exitCode: 1,
  });
});
