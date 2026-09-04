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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  couplingBlockers,
  isFixture,
  localCouplings,
  transportVerdict,
  unsafeTarget,
} from '../../scripts/ci/transport-identical-twins.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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

// ---------------------------------------------------------------------------
// L'insieme trasportabile dev'essere CHIUSO, non solo enumerato.
//
// `host/tests/shell-contract-functions.golden.json` è `identical`, ma pinna le
// funzioni di `host/siteShellBootstrap.ts` (`corpus-only`, composto sopra
// `host/htmlTemplate.ts`, `host/constants.ts`, `host/shared/seoContentTokens.ts`
// — tutti `adapted`). Copiarlo da solo mette rosso
// `host/tests/shell-contract-functions.test.mjs` su una PR di trasporto che
// nessuno può mergiare, e il guard «una PR alla volta» del workflow spegne da lì
// ogni passata successiva: il canale si ferma SENZA che nulla fallisca.
// ---------------------------------------------------------------------------

test('un fixture accoppiato a un file non `identical` non si copia da solo', () => {
  const entry = twin({ path: 'host/tests/shell-contract-functions.golden.json' });
  const v = transportVerdict(entry, { site: 'bbbb', corpus: 'aaaa' }, BASE, {
    couplings: [{ path: 'host/tests/shell-contract-functions.test.mjs', mode: 'corpus-only' }],
  });
  assert.equal(v.state, 'site-ahead');
  assert.equal(v.transport, false, 'il golden da solo mette rossa la PR di trasporto, che poi spegne il canale');
  assert.match(v.reason, /fixture/);
});

test('un fixture i cui accoppiamenti sono tutti `identical` resta copiabile', () => {
  const entry = twin({ path: 'host/tests/shell-contract-functions.golden.json' });
  const v = transportVerdict(entry, { site: 'bbbb', corpus: 'aaaa' }, BASE, {
    couplings: [{ path: 'host/tests/shell-contract-functions.test.mjs', mode: 'identical' }],
  });
  assert.equal(v.transport, true, 'la chiusura è la condizione, non un divieto sui fixture');
});

test('un accoppiamento non registrato nel manifest vale come un no', () => {
  // Non registrato = nessun gemello dichiarato sul sito = locale per
  // definizione. Trattarlo come «sconosciuto, quindi ok» riaprirebbe il buco.
  assert.deepEqual(couplingBlockers([{ path: 'host/tests/x.test.mjs', mode: 'non registrato' }]), ['host/tests/x.test.mjs']);
  assert.deepEqual(couplingBlockers([{ path: 'host/shared/safeTruncate.ts', mode: 'identical' }]), []);
});

test('gli accoppiamenti non bloccano una sorgente normale, solo i fixture', () => {
  // Ogni sorgente è accoppiata a qualcosa: estendere la regola oltre i fixture
  // trasformerebbe il trasporto in un no permanente.
  assert.equal(isFixture('host/tests/shell-contract-functions.golden.json'), true);
  assert.equal(isFixture('generator/tests/loop-labels.test.mjs'), true);
  assert.equal(isFixture('scripts/ci/x.golden.json'), true);
  assert.equal(isFixture('host/shared/localeEmitFilter.ts'), false);
  assert.equal(isFixture('scripts/ci/close-recovered-failure-issues.mjs'), false);

  const v = transportVerdict(twin(), { site: 'bbbb', corpus: 'aaaa' }, BASE, {
    couplings: [{ path: 'scripts/ci/auto-merge-eval.mjs', mode: 'adapted' }],
  });
  assert.equal(v.transport, true);
});

test("nell'albero di oggi il golden del contratto NON è trasportabile", () => {
  // Guard sul repo reale, offline: se un giorno il test che legge il golden
  // diventasse `identical`, questo caso lo direbbe invece di lasciarlo passare
  // in silenzio.
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/ci/loop-sync-manifest.json'), 'utf8'));
  const modeOf = new Map(manifest.files.map((e) => [e.path, e.mode]));
  const rel = 'host/tests/shell-contract-functions.golden.json';
  assert.equal(modeOf.get(rel), 'identical', 'il golden è dichiarato `identical`: è per questo che serve il guard');

  const couplings = localCouplings(rel, modeOf);
  assert.ok(
    couplings.some((c) => c.path === 'host/tests/shell-contract-functions.test.mjs'),
    'il test che legge il golden dev\'essere visto come accoppiamento',
  );
  const entry = manifest.files.find((e) => e.path === rel);
  const v = transportVerdict(entry, { site: 'bbbb', corpus: entry.baseline.corpus }, entry.baseline, { couplings });
  assert.equal(v.transport, false);
});
