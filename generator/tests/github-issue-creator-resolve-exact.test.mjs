/**
 * github-issue-creator-resolve-exact.test.mjs — chi apre per uguaglianza non
 * puo' chiudere per prefisso, e un close respinto non puo' essere silenzioso.
 *
 * Tre difetti misurati sul digest `needs-human` di `recycle-stale-prs.yml`
 * (issue #920, follow-up di #906), tutti e tre nella libreria che quel digest
 * usa:
 *
 *  1. lo step esclude se stesso dalla propria lista per UGUAGLIANZA esatta
 *     (`select(.title != env.DEDUP_TITLE)`), ma `resolveGithubIssue` chiudeva
 *     la prima issue aperta il cui titolo faceva `startsWith` del prefisso a
 *     60 caratteri. Una issue aperta il cui titolo COMINCIA con la chiave ma
 *     prosegue non viene esclusa dalla lista (quindi non impedisce la
 *     condizione «liste vuote») e verrebbe chiusa al posto del digest;
 *  2. sul dedup e sulla RIAPERTURA il corpo restava quello pre-chiusura: per
 *     un digest il corpo e' un elenco, e un elenco mai riscritto e' falso;
 *  3. il close respinto (permessi, rate-limit, 5xx) tornava `null`, cioe' la
 *     stessa forma del no-op «niente da chiudere»: run verde, una riga di log,
 *     issue aperta senza ritentativo.
 *
 * Il seam e' lo stesso di `github-issue-creator-reopen-default.test.mjs`: un
 * `gh` finto in testa a PATH, non un mock del modulo — con `node --test` il
 * binding ESM `import { execFileSync }` non e' raggiungibile da `mock.method`.
 * Qui il finto sa anche FALLIRE su richiesta, che e' il caso di cui parla il
 * terzo difetto.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.resolve(HERE, '../../scripts/lib/github-issue-creator.mjs');

const { createGithubIssue, resolveGithubIssue } = await import(MODULE_PATH);

// `sc.fail` elenca i sottocomandi che devono uscire non-zero (`["close"]`).
const FAKE_GH = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');
const sc = JSON.parse(fs.readFileSync(process.env.FAKE_GH_SCENARIO, 'utf8'));
if (Array.isArray(sc.fail) && sc.fail.includes(args[1])) {
  process.stderr.write('gh: rifiutato (finto)\\n');
  process.exit(1);
}
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
let summaryFile;
let originalPath;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-resolve-'));
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'gh'), FAKE_GH, { mode: 0o755 });
  scenarioFile = path.join(tmpDir, 'scenario.json');
  logFile = path.join(tmpDir, 'gh.log');
  summaryFile = path.join(tmpDir, 'summary.md');
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
  process.env.FAKE_GH_SCENARIO = scenarioFile;
  process.env.FAKE_GH_LOG = logFile;
  process.env.GH_REPO = 'o/r';
  delete process.env.ENABLE_FAILURE_REPORT;
});

after(() => {
  process.env.PATH = originalPath;
  delete process.env.GITHUB_STEP_SUMMARY;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.writeFileSync(logFile, '');
  fs.writeFileSync(scenarioFile, JSON.stringify({ open: [], closed: [] }));
  fs.writeFileSync(summaryFile, '');
  delete process.env.GITHUB_STEP_SUMMARY;
});

const ghCalls = () =>
  fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const callsTo = (sub) => ghCalls().filter((a) => a[0] === 'issue' && a[1] === sub);
const setScenario = (sc) => fs.writeFileSync(scenarioFile, JSON.stringify(sc));

// La chiave letterale del digest, e la sua impostora: un titolo che COMINCIA
// per la chiave e prosegue. Il taglio a 60 char non le separa, l'uguaglianza si.
const DEDUP_TITLE = 'needs-human: PR bloccate in attesa di revisione umana';
const IMPOSTOR_TITLE = `${DEDUP_TITLE} — nota aggiunta a mano`;

const issue = (number, title) => ({
  number,
  title,
  url: `https://github.com/o/r/issues/${number}`,
  state: 'OPEN',
  labels: [],
});

test('la fixture impostora e un bersaglio REALE del match di prefisso', () => {
  // Se questa cade, i test qui sotto misurano un caso piu' facile del reale:
  // proverebbero che `exactTitle` non chiude una issue che il prefisso non
  // avrebbe comunque scelto. Qui si dimostra il contrario, dal comportamento —
  // `searchSafePrefix` non e' esportata, e la proprieta' che conta e' cosa
  // sceglie il resolve, non come e' fatto il taglio.
  assert.ok(IMPOSTOR_TITLE.startsWith(DEDUP_TITLE));
  assert.notEqual(IMPOSTOR_TITLE, DEDUP_TITLE);

  setScenario({ open: [issue(801, IMPOSTOR_TITLE)], closed: [] });
  const res = resolveGithubIssue(DEDUP_TITLE, { workflow: 'w' });
  assert.deepEqual(callsTo('close').map((a) => a[2]), ['801'],
    'senza exactTitle il prefisso chiude l impostora: e questo il difetto di #920');
  assert.equal(res?.number, 801);
});

test('exactTitle: NON chiude la issue che comincia per la chiave ma prosegue', () => {
  setScenario({ open: [issue(801, IMPOSTOR_TITLE)], closed: [] });

  const res = resolveGithubIssue(DEDUP_TITLE, { workflow: 'Recycle stale PRs', exactTitle: true });

  assert.equal(res, null, 'niente da chiudere: nessun titolo identico e aperto');
  assert.equal(callsTo('close').length, 0, 'ha chiuso una issue che non e il digest');
  assert.equal(callsTo('comment').length, 0, 'ha commentato sulla issue sbagliata');
});

test('exactTitle: chiude la gemella dal titolo identico anche se e seconda in lista', () => {
  setScenario({ open: [issue(801, IMPOSTOR_TITLE), issue(733, DEDUP_TITLE)], closed: [] });

  const res = resolveGithubIssue(DEDUP_TITLE, { workflow: 'Recycle stale PRs', exactTitle: true });

  assert.deepEqual(callsTo('close').map((a) => a[2]), ['733']);
  assert.equal(res?.number, 733);
  assert.equal(res?.resolved, true);
});

test('senza exactTitle il prefisso resta, ma la corrispondenza esatta ha precedenza', () => {
  setScenario({ open: [issue(801, IMPOSTOR_TITLE), issue(733, DEDUP_TITLE)], closed: [] });

  const res = resolveGithubIssue(DEDUP_TITLE, { workflow: 'w' });

  assert.deepEqual(callsTo('close').map((a) => a[2]), ['733'],
    'con una gemella dal titolo identico in lista, il prefisso non deve vincere');
  assert.equal(res?.resolved, true);
});

test('close respinto: ritenta, esce dal silenzio e lo dice nel risultato', () => {
  process.env.GITHUB_STEP_SUMMARY = summaryFile;
  setScenario({ open: [issue(733, DEDUP_TITLE)], closed: [], fail: ['close'] });

  const res = resolveGithubIssue(DEDUP_TITLE, { workflow: 'Recycle stale PRs', exactTitle: true });

  assert.equal(callsTo('close').length, 3, 'un close respinto va ritentato, non assorbito al primo colpo');
  assert.equal(res?.number, 733);
  assert.equal(res?.resolved, false,
    'un fallimento con la stessa forma del no-op e indistinguibile da «niente da chiudere»');
  assert.match(fs.readFileSync(summaryFile, 'utf8'), /Close respinto/);
});

test('niente da chiudere resta il no-op verde: null, nessun ritentativo', () => {
  setScenario({ open: [], closed: [], fail: ['close'] });

  const res = resolveGithubIssue(DEDUP_TITLE, { workflow: 'w', exactTitle: true });

  assert.equal(res, null);
  assert.equal(callsTo('close').length, 0);
});

test('refreshBody: sul dedup di una issue APERTA il corpo viene riscritto', async () => {
  setScenario({ open: [issue(733, DEDUP_TITLE)], closed: [] });

  await createGithubIssue({
    title: DEDUP_TITLE,
    description: 'elenco di OGGI',
    labels: ['automation'],
    refreshBody: true,
  });

  const edits = callsTo('edit').filter((a) => a.includes('--body'));
  assert.equal(edits.length, 1, 'il corpo del digest non e stato riscritto');
  assert.equal(edits[0][2], '733');
  assert.match(edits[0][edits[0].indexOf('--body') + 1], /elenco di OGGI/);
});

test('refreshBody: alla RIAPERTURA il corpo non resta quello pre-chiusura', async () => {
  setScenario({
    open: [],
    closed: [{
      ...issue(733, DEDUP_TITLE),
      state: 'CLOSED',
      stateReason: 'COMPLETED',
      closedAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
    }],
  });

  const res = await createGithubIssue({
    title: DEDUP_TITLE,
    description: 'elenco di OGGI',
    labels: ['automation'],
    refreshBody: true,
  });

  assert.equal(res?.reopened, true, 'la fixture non ha esercitato il percorso di riapertura');
  const edits = callsTo('edit').filter((a) => a.includes('--body'));
  assert.equal(edits.length, 1, 'riaperta con il corpo del giorno prima della chiusura');
  assert.match(edits[0][edits[0].indexOf('--body') + 1], /elenco di OGGI/);
});

test('senza refreshBody il corpo resta intatto: i reporter di guasto non cambiano', async () => {
  setScenario({ open: [issue(733, DEDUP_TITLE)], closed: [] });

  await createGithubIssue({ title: DEDUP_TITLE, description: 'x', labels: ['bug'] });

  assert.equal(callsTo('edit').filter((a) => a.includes('--body')).length, 0);
  assert.equal(callsTo('comment').length, 1, 'la ricorrenza resta un commento');
});
