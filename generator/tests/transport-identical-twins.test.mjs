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
import crypto from 'node:crypto';
import {
  closeTransportSet,
  couplingBlockers,
  fetchFailureVerdict,
  isFixture,
  localCouplings,
  parseRatio,
  permanentBlock,
  realignFromCommitted,
  transportVerdict,
  unsafeTarget,
} from '../../scripts/ci/transport-identical-twins.mjs';
import { classify } from '../../scripts/ci/loop-drift-check.mjs';
import { parsePositiveNum } from '../../scripts/ci/scan-failed-runs.mjs';

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

// ---------------------------------------------------------------------------
// Il tetto per passata, e il BUIO che restava verde (issue #819, follow-up #766)
//
// Tre modi in cui una passata "riuscita" non era una passata: il tetto che
// separa una metà dall'altra (in ENTRAMBI i versi), un accoppiamento escluso
// prima ancora del tetto, e un fallimento di massa delle fetch che stampava
// «0 da portare» ed usciva 0.
// ---------------------------------------------------------------------------

const cand = (rel, couplings = []) => ({ path: rel, couplings });

test('il tetto non separa un fixture dal file che pinna (verso fixture → codice)', () => {
  const candidates = [
    cand('host/tests/x.golden.json', [{ path: 'host/x.ts', mode: 'identical' }]),
    cand('host/x.ts'),
  ];
  const { chosen, capped } = closeTransportSet(candidates, { maxFiles: 1 });
  assert.deepEqual(chosen.map((c) => c.path), [], 'il golden da solo mette rossa la PR di trasporto');
  assert.equal(capped, 2, 'un conteggio solo: i candidati non copiati oggi');
});

test('il tetto non separa il file dal fixture che lo pinna (verso inverso)', () => {
  // Il verso che il guard non copriva: se cade il FIXTURE e resta il codice, il
  // golden LOCALE descrive codice appena cambiato — stessa PR rossa, stesso
  // canale spento dal guard «una PR alla volta».
  const candidates = [
    cand('host/x.ts'),
    cand('host/tests/x.golden.json', [{ path: 'host/x.ts', mode: 'identical' }]),
  ];
  const { chosen } = closeTransportSet(candidates, { maxFiles: 1 });
  assert.deepEqual(chosen.map((c) => c.path), []);
});

test('la mappa inversa arriva anche da un fixture che non è candidato', () => {
  // Il candidato non fixture ha `couplings: []` e da solo non sa di essere
  // pinnato: l'arco arriva dal `couplingGraph`, raccolto per OGNI fixture.
  const candidates = [cand('host/x.ts')];
  const graph = [{ path: 'host/tests/x.golden.json', couplings: [{ path: 'host/x.ts', mode: 'identical' }] }];
  const { chosen } = closeTransportSet(candidates, { maxFiles: 25, couplingGraph: graph });
  assert.deepEqual(chosen.map((c) => c.path), [], 'il fixture è rimasto indietro: copiare il codice da solo lo rompe');
});

test('un accoppiamento VERIFICATO allineato non blocca', () => {
  // `stable` = i due lati sono lo stesso byte: non c'è nessuna metà indietro.
  const candidates = [cand('host/x.ts')];
  const graph = [{ path: 'host/tests/x.golden.json', couplings: [{ path: 'host/x.ts', mode: 'identical' }] }];
  const { chosen } = closeTransportSet(candidates, {
    maxFiles: 25,
    couplingGraph: graph,
    alignedPaths: new Set(['host/tests/x.golden.json']),
  });
  assert.deepEqual(chosen.map((c) => c.path), ['host/x.ts']);
});

test('sotto il tetto e con entrambe le metà presenti si copia tutto', () => {
  const candidates = [
    cand('host/tests/x.golden.json', [{ path: 'host/x.ts', mode: 'identical' }]),
    cand('host/x.ts'),
  ];
  const { chosen, capped } = closeTransportSet(candidates, { maxFiles: 25 });
  assert.deepEqual(chosen.map((c) => c.path), ['host/tests/x.golden.json', 'host/x.ts']);
  assert.equal(capped, 0);
});

test('un accoppiamento non `identical` non diventa un arco: sarebbe un no permanente', () => {
  // Quel caso blocca già in `transportVerdict`; come arco renderebbe il suo
  // vicino non copiabile per sempre, travestito da tetto.
  const candidates = [cand('host/x.ts', [{ path: 'scripts/ci/auto-merge-eval.mjs', mode: 'adapted' }])];
  const { chosen } = closeTransportSet(candidates, { maxFiles: 25 });
  assert.deepEqual(chosen.map((c) => c.path), ['host/x.ts']);
});

test('la chiusura è un punto fisso: scartare A può separare B da A', () => {
  const candidates = [
    cand('a.golden.json', [{ path: 'b.golden.json', mode: 'identical' }]),
    cand('b.golden.json', [{ path: 'c.ts', mode: 'identical' }]),
    cand('c.ts'),
  ];
  const { chosen } = closeTransportSet(candidates, { maxFiles: 2 });
  assert.deepEqual(chosen.map((c) => c.path), [], 'c cade fuori dal tetto, quindi cade b, quindi cade a');
});

test('un fallimento di massa delle fetch è ROSSO, non «0 da portare»', () => {
  // Il canale al buio: 429/5xx su tutti i path stampava «0 da portare, 159 non
  // verificati» e usciva verde — il trasporto si spegneva come il mirror
  // disabilitato per tre settimane, col log giornaliero come unica traccia.
  assert.equal(fetchFailureVerdict(159, 159).red, true);
  assert.equal(fetchFailureVerdict(159, 100).red, true);
  assert.equal(fetchFailureVerdict(2, 2).red, true, 'tutte fallite è buio anche su pochi path');
});

test('un transiente isolato resta verde: la soglia non è «una qualsiasi»', () => {
  assert.equal(fetchFailureVerdict(159, 1).red, false);
  assert.equal(fetchFailureVerdict(159, 2).red, false);
  assert.equal(fetchFailureVerdict(159, 39).red, false, 'sotto il 25%: la passata ha verificato tutto il resto');
  assert.equal(fetchFailureVerdict(159, 0).red, false);
  assert.equal(fetchFailureVerdict(0, 0).red, false, 'manifest senza `identical`: niente da verificare, non un buio');
});

test('TRANSPORT_MAX_FILES malformato non fa SPARIRE il tetto', () => {
  // `Number('venticinque')` è `NaN`, e `length >= NaN` è sempre falso: il tetto
  // si disattivava invece di fallire (stessa classe degli override di #797/#811).
  const warn = () => {};
  assert.equal(parsePositiveNum('venticinque', 25, { label: 'TRANSPORT_MAX_FILES', warn }), 25);
  assert.equal(parsePositiveNum('0', 25, { label: 'TRANSPORT_MAX_FILES', warn }), 25);
  assert.equal(parsePositiveNum('-5', 25, { label: 'TRANSPORT_MAX_FILES', warn }), 25);
  assert.equal(parsePositiveNum('3', 25, { label: 'TRANSPORT_MAX_FILES', warn }), 3);

  let msg = '';
  parsePositiveNum('venticinque', 25, {
    label: 'TRANSPORT_MAX_FILES',
    tool: 'transport-identical-twins',
    warn: (m) => { msg = m; },
  });
  assert.match(msg, /\[transport-identical-twins\]/, 'il warning deve nominare chi ha ignorato l\'override');
});

// ---------------------------------------------------------------------------
// Il rinvio che non scade. Il tetto rimanda l'altra metà «al giro in cui ci
// stanno insieme»: vero per un vicino che domani torna candidato, FALSO per uno
// che `permanentBlock` esclude sempre — e lì il rinvio diventa un no
// permanente, con la passata verde e nessuno che lo legge.
// ---------------------------------------------------------------------------

test('permanentBlock separa il no che scade da quello che non scade', () => {
  const fixture = {
    path: 'generator/tests/crawler-cross-repo-artifacts.test.mjs',
    mode: 'identical',
    baseline: { site: 'aaaa', corpus: 'aaaa' },
  };
  // Accoppiato a una voce `corpus-only`, che non diventerà mai `identical`.
  const couplings = [{ path: 'scripts/ci/loop-sync-manifest.json', mode: 'corpus-only' }];
  assert.match(permanentBlock(fixture, { couplings }) || '', /non `identical`/);
  assert.equal(permanentBlock(fixture, { couplings: [] }), null, 'senza bloccanti il no non è permanente');
  assert.match(permanentBlock(twin({ mode: 'adapted' })) || '', /mode `adapted`/);
  assert.match(permanentBlock(twin({ path: '../fuori.mjs' })) || '', /non scrivibile/);
  assert.match(permanentBlock(twin({ path: '.github/workflows/tests.yml' })) || '', /workflows/);
  // Lo STATO invece scade: non è mai una ragione permanente.
  const v = transportVerdict(twin(), { site: 'aaaa', corpus: 'cccc' }, { site: 'aaaa', corpus: 'aaaa' });
  assert.equal(v.transport, false);
  assert.equal(v.permanent, false, '`corpus-ahead` oggi può essere `site-ahead` domani');
});

test('un vicino bloccato per SEMPRE non è «aspetta il prossimo giro»', () => {
  // Caso reale del manifest: il fixture è bloccato per costruzione dai suoi
  // `couplingBlockers`, ma i suoi archi `identical` pinnano due file che senza
  // questa distinzione verrebbero scartati a ogni giro, in silenzio.
  const candidates = [cand('scripts/ci/close-recovered-failure-issues.mjs')];
  const graph = [{
    path: 'generator/tests/crawler-cross-repo-artifacts.test.mjs',
    couplings: [{ path: 'scripts/ci/close-recovered-failure-issues.mjs', mode: 'identical' }],
  }];
  const { chosen, dropped } = closeTransportSet(candidates, {
    maxFiles: 25,
    couplingGraph: graph,
    blockedForever: new Set(['generator/tests/crawler-cross-repo-artifacts.test.mjs']),
  });
  assert.deepEqual(chosen.map((c) => c.path), [], 'copiare una metà sola mette comunque rossa la PR');
  assert.equal(dropped[0].permanent, true);
  assert.match(dropped[0].reason, /copia a mano/, 'la ragione deve nominare l\'unica azione che sblocca');
  assert.doesNotMatch(dropped[0].reason, /aspetta il giro/, 'quel giro non arriva mai');
});

test('un vicino bloccato SOLO dal tetto resta un rinvio', () => {
  const candidates = [
    cand('host/tests/x.golden.json', [{ path: 'host/x.ts', mode: 'identical' }]),
    cand('host/x.ts'),
  ];
  const { dropped } = closeTransportSet(candidates, { maxFiles: 1 });
  assert.equal(dropped.every((d) => d.permanent === false), true);
  assert.match(dropped[0].reason, /aspetta il giro/);
});

test('la permanenza si propaga lungo la catena', () => {
  const candidates = [
    cand('a.golden.json', [{ path: 'b.golden.json', mode: 'identical' }]),
    cand('b.golden.json', [{ path: 'c.ts', mode: 'identical' }]),
  ];
  const { chosen, dropped } = closeTransportSet(candidates, {
    maxFiles: 25,
    blockedForever: new Set(['c.ts']),
  });
  assert.deepEqual(chosen.map((c) => c.path), []);
  assert.equal(dropped.every((d) => d.permanent), true, 'chi cade per colpa di un caduto-per-sempre cade per sempre');
});

test('un 404 di massa è BUIO, non 158 rimozioni simultanee', () => {
  // Il modo più probabile di perdere il canale: `SITE_REF` rinominato o repo
  // reso privato → `raw.githubusercontent` risponde 404, `siteFile` ritorna
  // `null` senza lanciare, `failed` resta 0 e la passata usciva VERDE con
  // «0 da portare, 0 non verificati».
  assert.equal(fetchFailureVerdict(158, 0, { missing: 158 }).red, true);
  assert.match(fetchFailureVerdict(158, 0, { missing: 158 }).reason, /ref/);
  assert.equal(fetchFailureVerdict(158, 0, { missing: 100 }).red, true);
  assert.equal(fetchFailureVerdict(158, 40, { missing: 40 }).red, true, 'le due metà del buio si sommano');
});

test('una rimozione vera resta verde: la soglia non è «una qualsiasi»', () => {
  assert.equal(fetchFailureVerdict(158, 0, { missing: 1 }).red, false);
  assert.equal(fetchFailureVerdict(158, 0, { missing: 2 }).red, false);
  assert.equal(fetchFailureVerdict(158, 1, { missing: 1 }).red, false);
  assert.equal(fetchFailureVerdict(158, 0, { missing: 39 }).red, false, 'sotto il 25%: il resto è verificato');
  assert.equal(fetchFailureVerdict(158, 0).red, false);
});

test('TRANSPORT_MAX_FAILURE_RATIO è una frazione, non una percentuale', () => {
  // `25` (chi pensa in percentuale) rendeva `ratio > maxRatio` sempre falso: la
  // difesa dal buio SPARIVA invece di fallire — la stessa classe del tetto.
  const warn = () => {};
  assert.equal(parseRatio('25', 0.25, { label: 'TRANSPORT_MAX_FAILURE_RATIO', warn }), 0.25);
  assert.equal(parseRatio('1.5', 0.25, { label: 'TRANSPORT_MAX_FAILURE_RATIO', warn }), 0.25);
  assert.equal(parseRatio('venticinque', 0.25, { label: 'TRANSPORT_MAX_FAILURE_RATIO', warn }), 0.25);
  assert.equal(parseRatio('0.5', 0.25, { label: 'TRANSPORT_MAX_FAILURE_RATIO', warn }), 0.5);
  assert.equal(parseRatio('1', 0.25, { label: 'TRANSPORT_MAX_FAILURE_RATIO', warn }), 1, '«tutte fallite» è un limite legittimo');

  let msg = '';
  parseRatio('25', 0.25, { label: 'TRANSPORT_MAX_FAILURE_RATIO', warn: (m) => { msg = m; } });
  assert.match(msg, /\[transport-identical-twins\] TRANSPORT_MAX_FAILURE_RATIO=25/);
});

// ── La baseline registra i byte COMMITTATI, non quelli scaricati (#852) ──────
//
// `--apply` scrive `baseline.corpus` con l'hash dei byte SCARICATI, prima che
// il commit esista. Se i byte committati differiscono — normalizzazione di
// line ending, filtro `clean`, staging incompleto — il manifest atterra su
// `main` con una baseline che non descrive nessuno dei due lati, e il giorno
// dopo il drift check legge `corpus-ahead` su un file che nessuno ha toccato:
// una riga actionable permanente, cioe' il modo in cui un report smette di
// essere letto.
//
// La meta' meno ovvia: su un `identical` la correzione DA SOLA non chiude
// niente. Scrivere `baseline.corpus = committed` con `committed !== base.site`
// sposta solo la riga actionable — da `corpus-ahead` a `undeclared-drift`, che
// e' piu' in alto nel report e per giunta esclude quella voce dal trasporto.
// Quindi il caso «i byte committati non sono quelli del sito» esce ROSSO, e la
// correzione silenziosa resta ai casi in cui ricostruisce davvero `stable`.

const hash16 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

/** Un manifest con una sola voce, gia' "trasportata" con l'hash dei byte scaricati. */
const transported = (over = {}) => ({
  files: [{
    path: 'scripts/ci/alert-pat-down.mjs',
    mode: 'identical',
    baseline: { site: hash16('scaricato\r\n'), corpus: hash16('scaricato\r\n'), alignedAt: '2026-09-05' },
    ...over,
  }],
});

test('byte committati diversi da quelli del sito: la voce esce ROSSA, la baseline non si tocca', () => {
  // Il gemello non e' byte-identico. Registrare qui `baseline.corpus` non lo
  // renderebbe tale: lo consegnerebbe al drift check come divergenza.
  const manifest = transported();
  const committed = Buffer.from('scaricato\n'); // normalizzato al commit
  const { corrections, mismatched, unreadable } = realignFromCommitted(manifest, ['scripts/ci/alert-pat-down.mjs'], () => committed);

  assert.deepEqual(unreadable, []);
  assert.deepEqual(corrections, []);
  assert.equal(mismatched.length, 1);
  assert.equal(mismatched[0].committed, hash16(committed));
  assert.equal(mismatched[0].site, hash16('scaricato\r\n'));
  assert.deepEqual(manifest.files[0].baseline, transported().files[0].baseline, 'baseline intatta: la decisione non e\' di questo passaggio');
});

test('la baseline rifiutata sarebbe `undeclared-drift` permanente, non `stable`', () => {
  // Il motivo per cui il caso sopra e' rosso invece che corretto in silenzio.
  // Si simula la scrittura che NON si fa e la si passa a `classify()`: nessuno
  // dei due lati si e' mosso dalla baseline, ma gli hash non coincidono.
  const site = hash16('scaricato\r\n');
  const committed = hash16('scaricato\n');
  const entry = { path: 'scripts/ci/alert-pat-down.mjs', mode: 'identical' };
  const base = { site, corpus: committed };
  const verdict = classify(entry, { site, corpus: committed }, base);

  assert.equal(verdict.state, 'undeclared-drift');
  assert.equal(verdict.actionable, true, 'la riga actionable di #852 non sparirebbe: cambierebbe solo nome');
  // E una voce in `undeclared-drift` non si copia piu': il gemello smetterebbe
  // di aggiornarsi senza che niente fallisca.
  assert.equal(transportVerdict(entry, { site, corpus: committed }, base).transport, false);
});

test('correzione: `baseline.corpus` stale ma byte committati uguali a quelli del sito → `stable`', () => {
  // L'unico caso in cui riscrivere la baseline ricostruisce l'invariante vero.
  const manifest = transported({ baseline: { site: hash16('scaricato\r\n'), corpus: 'stale00000000000', alignedAt: '2026-09-05' } });
  const siteBefore = manifest.files[0].baseline.site;
  const { corrections, mismatched } = realignFromCommitted(manifest, ['scripts/ci/alert-pat-down.mjs'], () => Buffer.from('scaricato\r\n'));

  assert.deepEqual(mismatched, []);
  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].from, 'stale00000000000');
  assert.equal(corrections[0].to, hash16('scaricato\r\n'));
  // Sovrascrivere anche `baseline.site` con un hash locale fabbricherebbe
  // esattamente la `ghost-baseline` che `checkBaselineProvenance()` esiste per
  // intercettare (#148): un hash registrato che non e' mai stato reale.
  assert.equal(manifest.files[0].baseline.site, siteBefore);
  assert.equal(manifest.files[0].baseline.alignedAt, '2026-09-05', 'la data dell\'allineamento non cambia: e\' lo stesso atto');

  const base = manifest.files[0].baseline;
  assert.equal(classify(manifest.files[0], { site: base.site, corpus: base.corpus }, base).state, 'stable');
});

test('su una voce `adapted` i due lati POSSONO differire: la correzione resta lecita', () => {
  // La regola del rosso e' sul modo, non sul path: un `adapted` con
  // `baseline.site !== baseline.corpus` e' `stable` per `classify()`.
  const manifest = transported({ mode: 'adapted', reason: 'gate in piu\' qui', baseline: { site: hash16('sito\n'), corpus: hash16('vecchio\n'), alignedAt: '2026-09-05' } });
  const { corrections, mismatched } = realignFromCommitted(manifest, ['scripts/ci/alert-pat-down.mjs'], () => Buffer.from('adattato\n'));

  assert.deepEqual(mismatched, []);
  assert.equal(corrections.length, 1);
  assert.equal(manifest.files[0].baseline.corpus, hash16('adattato\n'));
});

test('byte committati identici a quelli scaricati: nessuna correzione, nessuna riscrittura', () => {
  const manifest = transported();
  const { corrections, unreadable } = realignFromCommitted(manifest, ['scripts/ci/alert-pat-down.mjs'], () => Buffer.from('scaricato\r\n'));
  assert.deepEqual(corrections, []);
  assert.deepEqual(unreadable, []);
});

test('una voce NON trasportata non si tocca, per quanto divergente', () => {
  // Il caso pericoloso: `corpus-ahead` legittimo. Riallinearlo cancellerebbe
  // una divergenza vera che va letta a mano, cioe' il contrario del fix.
  const manifest = transported();
  const { corrections } = realignFromCommitted(manifest, [], () => Buffer.from('tutt\'altro'));
  assert.deepEqual(corrections, []);
  assert.equal(manifest.files[0].baseline.corpus, hash16('scaricato\r\n'));
});

test('un path trasportato non leggibile dal commit e\' un errore, non un silenzio', () => {
  // La meta' peggiore del buco: la baseline lo dichiara allineato e il file nel
  // commit non c'e'. Verde qui significa manifest rotto su `main`.
  const manifest = transported();
  const { corrections, unreadable } = realignFromCommitted(manifest, ['scripts/ci/alert-pat-down.mjs'], () => {
    throw new Error("fatal: path 'scripts/ci/alert-pat-down.mjs' does not exist in 'HEAD'");
  });
  assert.deepEqual(corrections, []);
  assert.equal(unreadable.length, 1);
  assert.match(unreadable[0].reason, /does not exist/);
});

test('un path trasportato assente dal manifest non passa in silenzio', () => {
  const manifest = transported();
  const { unreadable } = realignFromCommitted(manifest, ['host/mai-registrato.ts'], () => Buffer.from('x'));
  assert.deepEqual(unreadable.map((u) => u.path), ['host/mai-registrato.ts']);
});
