/**
 * run-card-emission.test.mjs — l'osservatore della strumentazione condivisa di
 * #621 / #625 / #804 / #832 / #787.
 *
 * ## Il difetto che questi test impediscono di riportare
 *
 * La card serve a distinguere «l'evento non e' successo» da «non l'ho visto», e
 * ci sono esattamente due modi di riperdere quella distinzione:
 *
 *   1. NEL RIEPILOGO. Se l'aggregato mostra i flip senza mostrare quante
 *      cascate avessero davvero degli echi, uno zero torna a sembrare un
 *      verdetto. E' letteralmente successo il 2026-09-05 su #832: «flip 0/28»
 *      dove le 28 avevano tutte `echi=0`.
 *   2. NEL CABLAGGIO. Se la card viene scritta dove nessuno la carica, non
 *      esiste — e non lo dice nessuno, perche' un file non scritto non fa
 *      fallire niente. E' la stessa forma di difetto per cui il report di run
 *      esisteva da mesi in `.tmp/` senza che nessuno lo leggesse.
 *
 * ## Perche' la posizione dello step si vincola in ASSOLUTO
 *
 * Il test sul cablaggio NON confronta due step fra loro («l'upload viene dopo
 * la generazione»): una relazione fra due step si soddisfa anche inserendone un
 * terzo in mezzo che azzera lo stato. Vincola invece due fatti assoluti — la
 * cartella e' la stessa, e lo step di upload ha `if: always()` — che sono le
 * uniche due condizioni da cui dipende il fatto che la card esca dal runner
 * anche quando lo step di generazione e' ROSSO, che e' precisamente il caso in
 * cui la card serve.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRunCard, summariseRunCards, writeRunCard, RUN_CARD_SCHEMA } from '../scripts/lib/run-card.mjs';
import { readCards, ARTIFACT_GLOB } from '../../scripts/ci/run-card-report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── 1. La proiezione porta il denominatore, non solo il numeratore ──────────

test('buildRunCard porta `calls` accanto a `viaFallbackUnsat` (#621)', () => {
  const card = buildRunCard({
    runId: '42',
    section: 'frontaliere',
    status: 'deferred',
    endedAt: '2026-09-05T10:00:00.000Z',
    rareEvents: { rebracket: { calls: 7, viaFallbackUnsat: 2 }, quotaDeferral: null },
  });
  assert.equal(card.schema, RUN_CARD_SCHEMA);
  assert.equal(card.rebracket.calls, 7);
  assert.equal(card.rebracket.viaFallbackUnsat, 2);
  // Senza `calls`, «0 viaFallbackUnsat» non distingue «il ramo non si e' mai
  // acceso» da «il ri-bracketing non viene piu' eseguito»: e' la meta' che ai
  // cinque grep sui log del 2026-08/09 mancava.
  assert.ok(Object.hasOwn(card.rebracket, 'calls'));
});

test('buildRunCard non esplode su un report degenere', () => {
  // Gira nel percorso di finalizzazione, cioe' anche mentre la run muore: un
  // TypeError qui trasformerebbe una sonda diagnostica nella causa di un
  // esito perso.
  for (const bad of [null, undefined, {}, { rareEvents: 'no' }, { rareEvents: { rebracket: 5 } }]) {
    const card = buildRunCard(bad);
    assert.equal(card.rebracket.calls, 0);
    assert.equal(card.quotaDeferral, null);
  }
});

// ── 2. L'aggregato tiene separati «non e' successo» e «non l'ho visto» ──────

const cardWith = (echoTotal, total, transient, verdict) => ({
  schema: RUN_CARD_SCHEMA,
  runId: `r${echoTotal}-${total}`,
  section: 'frontaliere',
  status: 'error',
  endedAt: null,
  rebracket: { calls: 0, viaFallbackUnsat: 0 },
  quotaDeferral: {
    breakdown: { transient, persistent: total - transient, total, providerCooldownSkips: { total: echoTotal } },
    share: { transient, total, share: total > 0 ? transient / total : 0, required: 0.5 },
    verdict,
  },
});

test('summariseRunCards conta le cascate CON echi, non solo i flip (#832)', () => {
  // La finestra del 2026-09-05: 3 cascate confrontabili, tutte con echi=0.
  const senzaFenomeno = [cardWith(0, 106, 53, false), cardWith(0, 40, 30, true), cardWith(0, 12, 2, false)];
  const s = summariseRunCards(senzaFenomeno);
  assert.equal(s.deferralCascades, 3);
  // IL PUNTO. Le tre cascate non dicono niente sulla soglia `>` contro `>=`:
  // nessuna ha echi da togliere. Un riepilogo che mostrasse solo `deferralCascades`
  // farebbe leggere «3 campioni, nessun flip» dove i campioni utili sono ZERO.
  assert.equal(s.runsWithEchoes, 0);
  assert.equal(s.nearParity, 0);
  assert.deepEqual(s.samples, []);
});

test('summariseRunCards isola i campioni in cui la parita decide (#832 item 2)', () => {
  const cards = [
    cardWith(0, 106, 53, false),   // niente echi: inutile per la soglia
    cardWith(53, 106, 53, true),   // 53 tolti contro 53 rimaste: LA parita' esatta
    cardWith(54, 107, 53, true),   // 54 contro 53: dentro la tolleranza di uno
    cardWith(11, 106, 53, false),  // 11 contro 95: echi presenti ma lontani
  ];
  const s = summariseRunCards(cards);
  assert.equal(s.deferralCascades, 4);
  assert.equal(s.runsWithEchoes, 3);
  assert.equal(s.nearParity, 2);
  assert.equal(s.samples.length, 3);
  assert.deepEqual(
    s.samples.map((x) => [x.echoes, x.remaining]),
    [[53, 53], [54, 53], [11, 95]],
  );
});

test('summariseRunCards non fa sparire una card di schema ignoto', () => {
  const s = summariseRunCards([{ schema: 'run-card/99', rebracket: { calls: 3 } }, cardWith(0, 10, 5, true)]);
  assert.equal(s.unknownSchema, 1);
  // Non contata fra le buone: un produttore piu' nuovo del lettore deve
  // comparire come tale, non come uno zero.
  assert.equal(s.rebracketCalls, 0);
  assert.equal(s.deferralCascades, 1);
});

test('readCards legge le card da una cartella di artifact scaricati', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-card-test-'));
  fs.mkdirSync(path.join(dir, '123'), { recursive: true });
  fs.writeFileSync(path.join(dir, '123', 'run-card-frontaliere.json'), JSON.stringify(cardWith(2, 10, 5, true)));
  fs.writeFileSync(path.join(dir, '123', 'run-card-svizzera.json'), '{ rotta');
  fs.writeFileSync(path.join(dir, '123', 'attempt.log'), 'non e una card');
  const { cards, unreadable } = readCards(dir);
  assert.equal(cards.length, 1);
  // Una card corrotta si CONTA: farla sparire ricrea lo stesso difetto, un
  // denominatore che non dice cosa non ha visto.
  assert.equal(unreadable, 1);
});

// ── 2bis. La card atterra DOVE le si dice, non altrove ──────────────────────

test('writeRunCard scrive esattamente al path assoluto ricevuto', () => {
  // IL CASO CHE E' SFUGGITO ALLA PRIMA STESURA. La card usava il `write()` di
  // `create-article.mjs`, che passa da `corpusPath()` e presuppone un path
  // RELATIVO al repo: con `$RUNNER_TEMP/...` (assoluto) il file atterrava in
  // `<repo>/home/runner/...`. Muto due volte — `$diag_dir` vuota, quindi
  // artifact assente e strumentazione no-op, piu' un albero `home/` sotto il
  // workspace che il `git add -A` dello step di commit avrebbe portato su main.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'run-card-abs-'));
  const target = path.join(base, 'generate-diagnostics', 'run-card-frontaliere.json');
  const written = writeRunCard(target, {
    runId: '99', section: 'frontaliere', status: 'generated', endedAt: null,
    rareEvents: { rebracket: { calls: 1, viaFallbackUnsat: 1 }, quotaDeferral: null },
  });
  assert.equal(written, target, 'il path scritto deve essere quello ricevuto, non uno riscritto');
  assert.ok(fs.existsSync(target), 'la card non esiste al path richiesto');
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).rebracket.viaFallbackUnsat, 1);
  // E in nessun altro posto: nessun albero parassita sotto la radice del repo.
  assert.ok(!fs.existsSync(path.join(ROOT, target)), 'la card e finita anche sotto il repo');
});

// ── 3. Il cablaggio: la card esce dal runner ────────────────────────────────

test('il reporter filtra per NOME dell artifact, non per file interno', () => {
  // `gh run download -p` matcha i nomi degli artifact. Un pattern sui file
  // (`run-card-*.json`) non matcha nulla, `gh` esce non-zero e ogni run finisce
  // in `missing`: il report direbbe per sempre «card lette: 0» — un altro zero
  // che non distingue «non e successo» da «non l ho visto».
  assert.match(ARTIFACT_GLOB, /^generate-article-diagnostics-/);
  const uploadName = GA_RAW.match(/name:\s*(generate-article-diagnostics-[^\n]*)/);
  assert.ok(uploadName, 'lo step di upload deve nominare l artifact');
  // Il glob deve davvero coprire il nome che il workflow produce.
  const literal = ARTIFACT_GLOB.replace('*', '');
  assert.ok(uploadName[1].startsWith(literal), `il glob "${ARTIFACT_GLOB}" non copre "${uploadName[1]}"`);
});

const activeLines = (src) => src.split('\n').filter((l) => !l.trim().startsWith('#'));
const GA_RAW = read('.github/workflows/generate-article.yml');
const GA = activeLines(GA_RAW).join('\n');

test('create-article.mjs emette la card solo se RUN_CARD_FILE e definita', () => {
  const src = read('generator/scripts/create-article.mjs');
  assert.ok(src.includes('process.env.RUN_CARD_FILE'), 'la card deve leggere RUN_CARD_FILE');
  assert.ok(src.includes('writeRunCard(cardFile, RUN_REPORT)'), 'la card deve essere la proiezione del report gia esistente');
  // Mai il `write()` corpus-relative di questo file su un path assoluto: vedi
  // il commento di `writeRunCard` in lib/run-card.mjs.
  assert.ok(
    !/\bwrite\(cardFile\b/.test(src),
    'la card non deve passare dal write()/resolve() corpus-relative di create-article.mjs',
  );
  // Nessun default: in locale e nei test il comportamento resta identico a
  // prima della strumentazione.
  assert.ok(
    !/RUN_CARD_FILE\s*\|\|\s*['"]/.test(src),
    'RUN_CARD_FILE non deve avere un default: scriverebbe file nel workspace, che lo step di generazione porta in commit con `git add -A`',
  );
});

test('la card viene scritta dentro la cartella che l upload porta fuori', () => {
  const exported = GA.match(/export RUN_CARD_FILE="([^"]+)"/);
  assert.ok(exported, 'lo step di generazione deve esportare RUN_CARD_FILE');
  // La sezione nel nome: il loop gira fino a due volte per run, e un nome fisso
  // perderebbe in silenzio meta' del campione.
  assert.ok(exported[1].includes('$sec'), `il nome della card deve portare la sezione, non "${exported[1]}"`);
  assert.ok(exported[1].startsWith('$diag_dir/'), `la card deve stare in $diag_dir, non in "${exported[1]}"`);

  const diagDir = GA.match(/diag_dir="([^"]+)"/);
  assert.ok(diagDir, 'lo step di generazione deve definire diag_dir');
  // `$RUNNER_TEMP` e NON il workspace: lo step fa `git add -A`, quindi una card
  // scritta sotto il repo finirebbe in un commit e su main.
  assert.ok(diagDir[1].includes('RUNNER_TEMP'), 'diag_dir deve stare fuori dal workspace');
  assert.ok(diagDir[1].endsWith('/generate-diagnostics'), 'diag_dir deve essere generate-diagnostics');

  const uploadPath = GA.match(/path:\s*\$\{\{\s*runner\.temp\s*\}\}\/generate-diagnostics\s*\n/);
  assert.ok(uploadPath, 'lo step di upload deve caricare la stessa cartella generate-diagnostics');
});

test('lo step che porta fuori la card ha if: always()', () => {
  // ASSOLUTO, non relativo a un altro step. La card serve proprio quando lo
  // step di generazione e' ROSSO: senza `always()` l'unica volta che serve e'
  // l'unica volta che non verrebbe caricata. E la stessa riga difende
  // l'artifact dal `success()` implicito che ogni step senza status function
  // eredita.
  const stepIdx = GA_RAW.indexOf('- name: Upload wedge diagnostics');
  assert.ok(stepIdx > 0, 'lo step di upload deve esistere con questo nome');
  const block = GA_RAW.slice(stepIdx, stepIdx + 400);
  assert.match(block, /\n\s+if:\s*always\(\)\s*\n/, 'Upload wedge diagnostics deve avere if: always()');
  assert.match(block, /uses:\s*actions\/upload-artifact@v4/);
});

// ── 4. #625: la catena di push si misura da sola ────────────────────────────

test('gitCommitAndPush emette la durata reale della catena (#625)', () => {
  const src = read('generator/scripts/batch-add-faq-to-articles.mjs');
  assert.ok(src.includes('[git-push-chain]'), 'la catena deve emettere un marker greppabile');
  // Nel `finally`: il ramo che serve misurare e' quello che FALLISCE, cioe'
  // quello in cui la catena e' lunga ed e' la finestra di troncamento.
  // `lastIndexOf`: la prima occorrenza e' quella nel commento che DOCUMENTA il
  // formato, e cercare quella misurerebbe la prosa invece del codice.
  const idx = src.lastIndexOf('[git-push-chain]');
  const before = src.slice(Math.max(0, idx - 400), idx);
  assert.ok(before.includes('} finally {'), 'il marker deve stare nel finally, non in coda al ramo felice');
  assert.ok(src.includes('const chainStartedAt = Date.now();'));
});
