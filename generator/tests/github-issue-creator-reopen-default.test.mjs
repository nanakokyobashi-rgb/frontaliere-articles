/**
 * github-issue-creator-reopen-default.test.mjs — equivalente in node:test del
 * guard vitest del sito (`tests/github-issue-creator-reopen-default.test.ts`).
 *
 * ## Perche' esiste QUI, e non basta quello del sito
 *
 * `scripts/lib/github-issue-creator.mjs` e' dichiarato `mode: identical` in
 * `scripts/ci/loop-sync-manifest.json`, e il file e' sceso allineato con la PR
 * #343 (2026-08-14T10:26Z, byte per byte). Ma il `loop-drift-check` confronta i
 * file del manifest UNO PER UNO: **non vede l'assenza di un test da un lato**.
 * Il guard del sito e' un `.ts` sotto `tests/`, gira in vitest, e non e' nel
 * manifest — quindi su questo repo il ramo di riapertura e' arrivato con zero
 * osservatori, e ci sarebbe restato senza che nulla lo segnalasse. E' la stessa
 * forma di `SiteShellContract`: un contratto che non ha forma di import non e'
 * coperto dai guard che seguono gli import.
 *
 * ## Il difetto che il codice ripara, misurato
 *
 * Il dedup cercava solo fra le issue APERTE (`findOpenIssueByTitlePrefix`). Un
 * monitor che ritrova la stessa condizione DOPO che la issue precedente e'
 * stata chiusa non vede la gemella chiusa e conia un numero nuovo. Misurato il
 * 2026-08-14 sui due repo:
 *
 *   comm -12 <(gh issue list -R <r> --state open   --limit 300 --json title -q '.[].title[0:60]'|sort -u) \
 *            <(gh issue list -R <r> --state closed --limit 500 --json title -q '.[].title[0:60]'|sort -u)
 *
 * → 11 prefissi condivisi fra aperte e chiuse, di cui 8 ricorrenze vere (sito
 * #5427←#5039, #5480←#4357, #5670←#4677, #5691←#5136/#4947; corpus
 * #311←#271/#250/#240, #312←#273, #313←#266/#206) e 3 tracker rotolanti (sito
 * #1951/#5198, corpus #25) che invece NON vanno toccati.
 *
 * ## Perche' il prefisso da solo non basta
 *
 * `searchSafePrefix()` taglia a 60 caratteri e BUTTA il token spezzato dal
 * taglio: le tre fixture qui sotto collassano tutte su `escalation(harvester)`
 * (21 char) pur nominando condizioni diverse — il test
 * `le tre fixture condividono il prefisso di ricerca` lo verifica invece di
 * darlo per buono. Riaprire sul solo prefisso resusciterebbe la issue
 * SBAGLIATA, che e' peggio che aprirne una nuova: una issue spuria viene
 * triagiata e chiusa, una riaperta a torto mette una misura sotto un titolo che
 * non la descrive. Il discriminante e' la *firma della condizione*: cifre
 * normalizzate (il conteggio cambia a ogni run), parole no.
 *
 * ## Il seam: `gh` finto sul PATH, non un mock del modulo
 *
 * Il test del sito fa `vi.mock('node:child_process')`. Qui non si puo': con
 * `node --test` il binding ESM `import { execFileSync } from 'node:child_process'`
 * NON e' raggiungibile da `mock.method(cp, 'execFileSync', …)` — verificato,
 * la chiamata reale passa comunque. Quindi il seam e' un eseguibile `gh` finto
 * messo in testa a `PATH`, che registra l'argv su file e risponde per stato.
 * E' piu' forte del mock: esercita `execFileSync` vero e l'argv vero che il
 * modulo costruisce, `--json`/`--limit`/`--search` compresi.
 *
 * ## Come si mantiene onesto questo test (provato per mutazione)
 *
 * Le mutazioni provate e il loro esito stanno nel body della PR che introduce
 * questo file. Regola: una mutazione della logica di riapertura DEVE produrre
 * un rosso qui, un commento innocuo NO.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.resolve(HERE, '../../scripts/lib/github-issue-creator.mjs');

const { createGithubIssue, conditionSignature } = await import(MODULE_PATH);

// ── Il `gh` finto ───────────────────────────────────────────────────
//
// Legge lo scenario da $FAKE_GH_SCENARIO, appende l'argv su $FAKE_GH_LOG e
// risponde a `issue list` in base allo STATO. `ghIssueList()` costruisce sempre
// `['issue','list','--state',<state>,…]`, quindi lo stato sta in argv[3] — la
// stessa assunzione del test del sito, qui pero' verificata contro l'argv reale.
const FAKE_GH = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');
const sc = JSON.parse(fs.readFileSync(process.env.FAKE_GH_SCENARIO, 'utf8'));
if (args[0] === 'issue' && args[1] === 'list') {
  process.stdout.write(JSON.stringify(sc[args[3]] || []));
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'create') {
  process.stdout.write('https://github.com/o/r/issues/999\\n');
  process.exit(0);
}
process.exit(0);
`;

let tmpDir;
let scenarioFile;
let logFile;
let originalPath;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-reopen-'));
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'gh'), FAKE_GH, { mode: 0o755 });
  scenarioFile = path.join(tmpDir, 'scenario.json');
  logFile = path.join(tmpDir, 'gh.log');
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
  process.env.FAKE_GH_SCENARIO = scenarioFile;
  process.env.FAKE_GH_LOG = logFile;
  // Deterministico: senza, `repoFlag()` dipende dal remote git della cwd.
  process.env.GH_REPO = 'o/r';
  delete process.env.ENABLE_FAILURE_REPORT;
  delete process.env.GITHUB_STEP_SUMMARY;
});

after(() => {
  process.env.PATH = originalPath;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.writeFileSync(logFile, '');
  fs.writeFileSync(scenarioFile, JSON.stringify({ open: [], closed: [] }));
  delete process.env.GITHUB_STEP_SUMMARY;
});

/** Ogni invocazione di `gh`, come array di argomenti. */
const ghCalls = () =>
  fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const callsTo = (sub) => ghCalls().filter((a) => a[0] === 'issue' && a[1] === sub);
const listsFor = (state) =>
  ghCalls().filter((a) => a[0] === 'issue' && a[1] === 'list' && a[3] === state);

const setScenario = (sc) => fs.writeFileSync(scenarioFile, JSON.stringify(sc));
const withClosedTwins = (twins) => setScenario({ open: [], closed: twins });

const ISO = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString();

// Le tre condividono lo stesso prefisso di ricerca, per costruzione — e il
// primo test qui sotto lo dimostra invece di assumerlo.
const TITLE_NOW = 'escalation(harvester): fix-outcome/fix-outcome:blocked-secrets ricorre 12 volte';
const TITLE_TWIN = 'escalation(harvester): fix-outcome/fix-outcome:blocked-secrets ricorre 47 volte';
const TITLE_OTHER = 'escalation(harvester): fix-outcome/fix-outcome:blocked-secrets-workflows ricorre 4 volte';

const twin = (over = {}) => ({
  number: 5039,
  title: TITLE_TWIN,
  url: 'https://github.com/o/r/issues/5039',
  closedAt: ISO(24 * 9), // chiusa 9 giorni fa: dentro la finestra di default (30gg)
  state: 'CLOSED',
  stateReason: 'COMPLETED',
  labels: [{ name: 'bug' }],
  ...over,
});

// ── Le fixture reggono? ─────────────────────────────────────────────

test('le tre fixture condividono il prefisso di ricerca ma non la firma', () => {
  // `searchSafePrefix` non e' esportata: si verifica la proprieta' che conta,
  // cioe' che il taglio a 60 char non separi le tre. Se questa assert cade, i
  // test del discriminante qui sotto stanno misurando un caso piu' facile di
  // quello reale e passerebbero per il motivo sbagliato.
  const cut = (s) => s.slice(0, 60);
  assert.equal(cut(TITLE_NOW), cut(TITLE_TWIN));
  assert.equal(cut(TITLE_NOW), cut(TITLE_OTHER));

  assert.equal(
    conditionSignature(TITLE_NOW),
    conditionSignature(TITLE_TWIN),
    'gemella vera: le cifre si normalizzano, la condizione e\' la stessa',
  );
  assert.notEqual(
    conditionSignature(TITLE_NOW),
    conditionSignature(TITLE_OTHER),
    'condizione diversa: la firma DEVE separarle, il prefisso da solo non lo fa',
  );
});

// ── L'invariante ────────────────────────────────────────────────────

test('senza opzioni: riapre la gemella chiusa invece di creare (invariante)', async () => {
  withClosedTwins([twin()]);

  // NIENTE reopenWithinHours: e' il punto. Il comportamento deve valere per
  // default, altrimenti resta il ramo opt-in che nessun monitor passava — che
  // e' esattamente lo stato in cui questo repo era: 1 ricorrenza con gemella
  // chiusa e 0 eventi `reopened` nella finestra 2026-08-06..13.
  const res = await createGithubIssue({
    title: TITLE_NOW,
    description: 'blocked-secrets: 12 occorrenze nelle ultime 24h',
    priority: 2,
    labels: ['bug'],
  });

  assert.deepEqual(callsTo('reopen').map((a) => a[2]), ['5039']);
  assert.equal(callsTo('create').length, 0, 'ha coniato un numero nuovo: la riapertura non e\' attiva');
  assert.equal(res?.number, 5039);
  assert.equal(res?.reopened, true);
});

test('costa 1 sola chiamata sulle chiuse, e chiede una pagina piu\' larga di 10', async () => {
  // A 244 issue/settimana aperte da monitor sui due repo, il costo per tentativo
  // e' load-bearing: la ricerca fra le chiuse non deve paginare. E la pagina
  // dev'essere piu' larga del ramo APERTE: di canonical aperti con lo stesso
  // prefisso ce n'e' uno, di chiusi se ne accumulano quanti i giri passati (la
  // famiglia `escalation(harvester)` ne ha 8).
  withClosedTwins([twin()]);

  await createGithubIssue({ title: TITLE_NOW, description: 'misura', priority: 2 });

  const closed = listsFor('closed');
  assert.equal(closed.length, 1, 'l\'indice ha risposto: nessun ripiego deve partire');
  assert.ok(!closed[0].includes('--paginate'));
  const limit = Number(closed[0][closed[0].indexOf('--limit') + 1]);
  assert.ok(limit > 10, `--limit ${limit} non e' piu' largo del ramo aperte`);
  // I due campi che i tre filtri leggono devono essere CHIESTI: senza, arrivano
  // undefined e il guard sui tracker/NOT_PLANNED passa sempre.
  const json = closed[0][closed[0].indexOf('--json') + 1];
  assert.ok(json.includes('stateReason'), '--json senza stateReason: il filtro NOT_PLANNED e\' cieco');
  assert.ok(json.includes('labels'), '--json senza labels: il filtro sui tracker e\' cieco');
  assert.ok(json.includes('closedAt'), '--json senza closedAt: la finestra dei 30gg e\' cieca');
});

test('il commento di ricorrenza porta la data e la misura corrente', async () => {
  withClosedTwins([twin()]);

  await createGithubIssue({
    title: TITLE_NOW,
    description: 'blocked-secrets: 12 occorrenze nelle ultime 24h',
    priority: 2,
  });

  const comment = callsTo('comment').find((a) => a[2] === '5039');
  assert.ok(comment, 'riaperta senza commento: la issue si legge come se nulla fosse cambiato');
  const body = comment[comment.indexOf('--body') + 1];
  assert.match(body, /ricorrenza il \d{4}-\d{2}-\d{2}T/);
  assert.ok(body.includes('blocked-secrets: 12 occorrenze nelle ultime 24h'));
  // Il marker 🔁 e' portante: countRecentFailureEvents conta i commenti che lo
  // hanno per far avanzare il gate delle failure consecutive.
  assert.ok(body.startsWith('🔁'), 'senza marker il gate delle failure consecutive non conta l\'evento');
});

// ── I tre filtri anti-falso-positivo ────────────────────────────────

test('condivide il prefisso di ricerca ma non la condizione → NON riapre, crea', async () => {
  withClosedTwins([twin({ number: 4357, title: TITLE_OTHER })]);

  await createGithubIssue({ title: TITLE_NOW, description: 'misura', priority: 2 });

  assert.equal(callsTo('reopen').length, 0, 'ha resuscitato la issue sbagliata sul solo prefisso');
  assert.equal(callsTo('create').length, 1);
});

test('la gemella con agent:no-age-out (tracker rotolante) resta chiusa', async () => {
  withClosedTwins([twin({ labels: [{ name: 'agent:no-age-out' }, { name: 'bug' }] })]);

  await createGithubIssue({ title: TITLE_NOW, description: 'misura', priority: 2 });

  assert.equal(callsTo('reopen').length, 0);
  assert.equal(callsTo('create').length, 1);
});

test('il ledger singleton non si riapre nemmeno SENZA agent:no-age-out', async () => {
  // Il label da solo non regge, ed e' su QUESTO repo che si vede: misurato il
  // 2026-08-14, il ledger crawler-transient ha `agent:no-age-out` sul sito
  // (#5198) ma NON qui (#25, ne' le sue chiuse #24/#21). Un guard solo-label
  // avrebbe giudicato #21 riapribile. Il secondo segnale e' il titolo singleton
  // del modulo stesso.
  const LEDGER = 'Crawler transient failures (rolling ledger)';
  withClosedTwins([twin({ number: 21, title: LEDGER, labels: [{ name: 'crawler-transient' }] })]);

  await createGithubIssue({ title: LEDGER, description: 'misura', priority: 4 });

  assert.equal(callsTo('reopen').length, 0);
});

test('saltare un tracker lascia una traccia nello step summary', async () => {
  // Un'astensione SILENZIOSA e' indistinguibile da un riaprire rotto — che e' il
  // difetto stesso che questo modulo ripara. La traccia e' comportamento, non
  // decorazione, e passa da fs (non da `gh`, che qui puo' fallire in silenzio).
  const summary = path.join(tmpDir, 'summary.md');
  fs.writeFileSync(summary, '');
  process.env.GITHUB_STEP_SUMMARY = summary;
  withClosedTwins([twin({ labels: [{ name: 'agent:no-age-out' }] })]);

  await createGithubIssue({ title: TITLE_NOW, description: 'misura', priority: 2 });

  assert.match(fs.readFileSync(summary, 'utf8'), /Riapertura saltata/);
});

test('chiusa come NOT_PLANNED → non si resuscita una decisione umana', async () => {
  withClosedTwins([twin({ stateReason: 'NOT_PLANNED' })]);

  await createGithubIssue({ title: TITLE_NOW, description: 'misura', priority: 2 });

  assert.equal(callsTo('reopen').length, 0);
  assert.equal(callsTo('create').length, 1);
});

// ── La finestra, l'opt-out, la precedenza ───────────────────────────

test('chiusa fuori finestra (60 giorni fa) → issue nuova', async () => {
  withClosedTwins([twin({ closedAt: ISO(24 * 60) })]);

  await createGithubIssue({ title: TITLE_NOW, description: 'misura', priority: 2 });

  assert.equal(callsTo('reopen').length, 0);
  assert.equal(callsTo('create').length, 1);
});

test('reopenWithinHours: 0 esplicito → opt-out, torna al comportamento vecchio', async () => {
  withClosedTwins([twin()]);

  await createGithubIssue({
    title: TITLE_NOW,
    description: 'misura',
    priority: 2,
    reopenWithinHours: 0,
  });

  assert.equal(callsTo('reopen').length, 0);
  assert.equal(callsTo('create').length, 1);
  // E la lista delle chiuse non viene nemmeno interrogata: l'opt-out e' un ramo
  // saltato, non un risultato scartato.
  assert.equal(listsFor('closed').length, 0);
});

test('una gemella APERTA vince sulla chiusa: commento, nessuna riapertura', async () => {
  setScenario({
    open: [{ number: 5427, title: TITLE_TWIN, url: 'u', closedAt: null, state: 'OPEN' }],
    closed: [twin()],
  });

  const res = await createGithubIssue({ title: TITLE_NOW, description: 'misura', priority: 2 });

  assert.equal(callsTo('reopen').length, 0);
  assert.equal(callsTo('create').length, 0);
  assert.equal(res?.number, 5427);
});

test('fra due gemelle valide riapre la piu\' recente', async () => {
  withClosedTwins([
    twin({ number: 4947, closedAt: ISO(24 * 20) }),
    twin({ number: 5136, closedAt: ISO(24 * 2) }),
  ]);

  await createGithubIssue({ title: TITLE_NOW, description: 'misura', priority: 2 });

  assert.deepEqual(callsTo('reopen').map((a) => a[2]), ['5136']);
});

// ── Il livello a cui il difetto si nasconde: il CALL SITE ───────────
//
// Chiamare `createGithubIssue()` a mano prova la funzione, non il percorso che
// gira in produzione. Su questo repo NESSUNO dei 22 chiamanti passa
// `--reopen-within-hours` (misurato il 2026-08-14): tutti dipendono
// interamente dal default. Se il default tornasse opt-in, i test qui sopra che
// passano opzioni esplicite potrebbero restare verdi mentre ogni workflow del
// repo continua a coniare numeri nuovi — la forma classica del gate vacuo.
// Questi due test legano il default ai chiamanti reali.

test('CLI senza flag: un chiamante reale riapre, non conia (end-to-end)', async () => {
  // Il form esatto delle 10 invocazioni nei workflow: nessun --reopen-within-hours.
  const { spawnSync } = await import('node:child_process');
  withClosedTwins([twin()]);

  const r = spawnSync(process.execPath, [
    path.resolve(HERE, '../../scripts/lib/github-issue-creator.mjs'),
    '--title', TITLE_NOW,
    '--description', 'blocked-secrets: 12 occorrenze nelle ultime 24h',
    '--priority', '2',
    '--label', 'bug',
    '--workflow', 'Loop drift check',
  ], { encoding: 'utf8', env: process.env });

  assert.equal(r.status, 0, `la CLI e' uscita ${r.status}: ${r.stderr}`);
  assert.deepEqual(
    callsTo('reopen').map((a) => a[2]),
    ['5039'],
    'la CLI senza flag NON ha riaperto: il default non raggiunge i chiamanti '
    + '(e\' esattamente lo stato che ha prodotto 0 eventi `reopened` su questo repo)',
  );
  assert.equal(callsTo('create').length, 0);
});

test('CLI con --no-reopen: l\'opt-out esplicito resta possibile', async () => {
  const { spawnSync } = await import('node:child_process');
  withClosedTwins([twin()]);

  const r = spawnSync(process.execPath, [
    path.resolve(HERE, '../../scripts/lib/github-issue-creator.mjs'),
    '--title', TITLE_NOW, '--description', 'misura', '--priority', '2', '--no-reopen',
  ], { encoding: 'utf8', env: process.env });

  assert.equal(r.status, 0);
  assert.equal(callsTo('reopen').length, 0);
  assert.equal(callsTo('create').length, 1);
});

test('i chiamanti di questo repo dipendono tutti dal default (anti-vacuita\')', () => {
  // Se questa asserzione cade perche' i chiamanti hanno smesso di esistere, il
  // test sopra sta esercitando un percorso che nessuno usa. Se cade perche' il
  // default e' tornato 0, i chiamanti sono tornati tutti a coniare.
  const wfDir = path.resolve(HERE, '../../.github/workflows');
  const invocations = fs.readdirSync(wfDir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .flatMap((f) => fs.readFileSync(path.join(wfDir, f), 'utf8')
      .split(/\n(?=\s*-?\s*name:|\s{6}run:)/)
      .filter((block) => block.includes('github-issue-creator.mjs') && !block.includes('--resolve'))
      .map((block) => ({ file: f, usesDefault: !/--reopen-within-hours|--no-reopen/.test(block) })));

  assert.ok(invocations.length > 0, 'nessun workflow invoca piu\' il reporter: il test end-to-end sopra e\' vacuo');
  const onDefault = invocations.filter((i) => i.usesDefault);
  assert.ok(
    onDefault.length > 0,
    'nessun chiamante dipende dal default: il flip default-on non produce piu\' alcun effetto qui',
  );

  // E il default deve essere una finestra vera, non 0.
  const src = fs.readFileSync(MODULE_PATH, 'utf8');
  const m = src.match(/const DEFAULT_REOPEN_WITHIN_HOURS = ([^;]+);/);
  assert.ok(m, 'DEFAULT_REOPEN_WITHIN_HOURS non trovata: il default e\' sparito');
  // eslint-disable-next-line no-eval
  const hours = eval(m[1]);
  assert.ok(
    hours > 0,
    `DEFAULT_REOPEN_WITHIN_HOURS = ${hours}: ${onDefault.length} invocazioni di workflow `
    + 'tornerebbero a coniare una issue nuova a ogni ricorrenza',
  );
});
