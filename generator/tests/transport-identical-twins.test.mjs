/**
 * transport-identical-twins.test.mjs — pinna l'invariante «il trasporto copia
 * SOLO i gemelli `identical` fermi in `site-ahead`» (issue #331).
 *
 * ## Cosa può andare storto, e perché un test lo deve dire
 *
 * Questo è il primo script del repo che SCRIVE sull'albero copiando da un altro
 * repo. La strada alternativa — allargare l'allowlist di
 * `mirror-articles-engine.yml` sul sito oltre `engine/` — è bloccata proprio da
 * questo rischio: quell'allowlist copia DIRECTORY intere, e sotto
 * `scripts/**`/`host/**` vivono decine di voci `adapted`, diverse apposta.
 * Sovrascriverle sarebbe la metà distruttiva del vecchio mirror.
 *
 * Il trasporto tirato non ha quel problema per COSTRUZIONE — enumera i path
 * `identical` del manifest, mai una directory — ma «per costruzione» è
 * un'affermazione sul codice di oggi. Questi casi la rendono un guard:
 *
 *   - un `adapted` non si copia MAI, qualunque sia il suo stato;
 *   - un `identical` che questo lato ha toccato (`corpus-ahead`, `both-moved`,
 *     `undeclared-drift`) non si copia: è una divergenza a due direzioni, cioè
 *     una decisione, e questo script non ha il contesto per prenderla — la
 *     stessa riga che `loop-drift-check.mjs` traccia su di sé;
 *   - un path che uscirebbe dal checkout (`..`, assoluto) non è una
 *     destinazione: è l'unico punto dello script che scrive, quindi è l'unico
 *     dove un path del manifest diventa pericoloso;
 *   - `.github/workflows/` resta fuori finché il token del ciclo non ha lo
 *     scope `workflows`: copiarlo produrrebbe un push rifiutato DOPO aver
 *     scritto, cioè una passata che fallisce in fondo invece che all'inizio.
 *
 * ## Perché gira offline
 *
 * `transportVerdict()` è pura come `classify()`: prende gli hash già calcolati
 * invece di andarli a prendere. Il sito qui è un valore, non una richiesta di
 * rete — la stessa scelta di `loop-drift-check-classify.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transportVerdict, unsafeTarget } from '../../scripts/ci/transport-identical-twins.mjs';

/** Una voce `identical` con la baseline allineata su entrambi i lati. */
const twin = (over = {}) => ({
  path: 'scripts/ci/alert-pat-down.mjs',
  mode: 'identical',
  baseline: { site: 'aaaa', corpus: 'aaaa' },
  ...over,
});
const BASE = { site: 'aaaa', corpus: 'aaaa' };

test('site-ahead su un `identical`: è il solo caso che si copia', () => {
  const v = transportVerdict(twin(), { site: 'bbbb', corpus: 'aaaa' }, BASE);
  assert.equal(v.state, 'site-ahead');
  assert.equal(v.transport, true);
});

test('stable: niente da portare, e non è un errore', () => {
  const v = transportVerdict(twin(), { site: 'aaaa', corpus: 'aaaa' }, BASE);
  assert.equal(v.state, 'stable');
  assert.equal(v.transport, false);
});

test('un `adapted` non si copia MAI, nemmeno quando il sito è avanti', () => {
  // È la classe che ha tenuto bloccato l'allargamento dell'allowlist del
  // mirror: `auto-merge-eval.mjs` diverge in DUE direzioni, e una copia
  // cancellerebbe il gate `generator-ci` che sul sito non esiste.
  const entry = twin({ path: 'scripts/ci/auto-merge-eval.mjs', mode: 'adapted', reason: 'gate in piu\' qui' });
  const v = transportVerdict(entry, { site: 'bbbb', corpus: 'cccc' }, { site: 'aaaa', corpus: 'cccc' });
  assert.equal(v.transport, false);
  assert.match(v.reason, /identical/);
});

test('corpus-ahead: modificato QUI, fermo sul sito → non si tocca', () => {
  const v = transportVerdict(twin(), { site: 'aaaa', corpus: 'cccc' }, BASE);
  assert.equal(v.state, 'corpus-ahead');
  assert.equal(v.transport, false, 'copiare qui cancellerebbe una modifica locale che il sito non ha');
});

test('both-moved: divergenza a due direzioni → decisione, non meccanica', () => {
  const v = transportVerdict(twin(), { site: 'bbbb', corpus: 'cccc' }, BASE);
  assert.equal(v.state, 'both-moved');
  assert.equal(v.transport, false);
});

test('undeclared-drift: fermi entrambi ma diversi → non si copia in silenzio', () => {
  const v = transportVerdict(twin({ baseline: { site: 'aaaa', corpus: 'cccc' } }), { site: 'aaaa', corpus: 'cccc' }, { site: 'aaaa', corpus: 'cccc' });
  assert.equal(v.state, 'undeclared-drift');
  assert.equal(v.transport, false);
});

test('sparito dal sito: una fetch che torna null non diventa una copia vuota', () => {
  const v = transportVerdict(twin(), { site: null, corpus: 'aaaa' }, BASE);
  assert.equal(v.state, 'removed-on-site');
  assert.equal(v.transport, false);
});

test('assente qui: il trasporto NON crea un file che nessuno ha mai censito qui', () => {
  // `missing-here` è actionable nel drift check, ma la creazione di un file
  // nuovo è una decisione (dove va, serve davvero?), non una copia.
  const v = transportVerdict(twin(), { site: 'bbbb', corpus: null }, BASE);
  assert.equal(v.state, 'missing-here');
  assert.equal(v.transport, false);
});

test('outOfScope: un path che ha già il suo trasporto non ne prende un secondo', () => {
  const v = transportVerdict(
    twin({ path: 'engine/siteShell.ts' }),
    { site: 'bbbb', corpus: 'aaaa' },
    BASE,
    { outOfScopePrefixes: ['content/', 'engine/'] },
  );
  assert.equal(v.transport, false, 'engine/ ha il mirror: due canali sullo stesso path sono un conflitto');
  assert.match(v.reason, /outOfScope/);
});

test('.github/workflows/ resta fuori: il token del ciclo non ha quello scope', () => {
  const v = transportVerdict(
    twin({ path: '.github/workflows/tests.yml' }),
    { site: 'bbbb', corpus: 'aaaa' },
    BASE,
  );
  assert.equal(v.transport, false, 'un push rifiutato DOPO la scrittura fallisce in fondo invece che all\'inizio');
  assert.match(v.reason, /workflows/);
});

test('un path del manifest non è una destinazione fidata', () => {
  for (const bad of ['../../etc/passwd', '/etc/passwd', 'host\\shared\\x.ts', '', 'a/../../b']) {
    assert.ok(unsafeTarget(bad), `${JSON.stringify(bad)} deve essere rifiutato come destinazione`);
  }
  assert.equal(unsafeTarget('host/shared/localeEmitFilter.ts'), null);
  // Il rifiuto deve valere anche DENTRO il verdetto, non solo nell'helper:
  // è lì che decide se si scrive.
  const v = transportVerdict(twin({ path: '../fuori.mjs' }), { site: 'bbbb', corpus: 'aaaa' }, BASE);
  assert.equal(v.transport, false);
});
