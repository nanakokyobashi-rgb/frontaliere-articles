/**
 * github-issue-creator-exact-title.test.mjs — equivalente in node:test del
 * guard vitest del sito (`tests/github-issue-creator-exact-title.test.ts`).
 *
 * ## Il difetto, misurato in QUESTO repository
 *
 * Il dedup cercava per prefisso (`startsWith`) anche quando il titolo richiesto
 * era piu' corto del taglio a 60 caratteri. Un titolo corto e' allora il
 * prefisso di ogni titolo che lo estende: «Workflow Failure: Generate Blog
 * Article» e' l'inizio di 26 titoli «Workflow Failure: Generate Blog Article
 * (canton-xx)». Il 2026-10-06 la ricorrenza del workflow generale e' finita
 * sulla issue di un cantone (2272) invece che sulla 249, e il resolver poteva
 * chiudere la gemella sbagliata. Nel sito la collisione non esiste oggi (0
 * coppie), qui tocca 1 workflow su 107: per questo l'osservatore sta anche qui.
 *
 * ## La regola
 *
 * Un titolo che sta per intero dentro il taglio (<= 60 caratteri) si confronta
 * per uguaglianza. Il confronto per prefisso resta dove serve: titoli piu'
 * lunghi del taglio, e famiglie dichiarate con `dedupKey` (titolo che cambia a
 * ogni misura). `exactTitle: true` continua a restringere anche i titoli
 * lunghi.
 *
 * Il seam e' lo stesso di `github-issue-creator-reopen-default.test.mjs`: un
 * `gh` finto in testa a `PATH`, che registra l'argv e risponde per stato. Il
 * motivo per cui qui non si usa un mock del modulo e' spiegato in quel file.
 */
import './lib/stdout-off-runner-pipe.mjs'; // stdout e' la pipe dei frame di node:test (issue 1819)
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.resolve(HERE, '../../scripts/lib/github-issue-creator.mjs');

const { createGithubIssue, resolveGithubIssue } = await import(MODULE_PATH);

// `ghIssueList()` costruisce sempre `['issue','list','--state',<state>,…]`:
// lo stato sta in argv[3]. Dopo una chiusura il modulo rilegge lo stato della
// issue (`issue view … --json state`): il finto risponde CLOSED.
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
if (args[0] === 'issue' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({ state: 'CLOSED' }));
  process.exit(0);
}
process.exit(0);
`;

let tmpDir;
let scenarioFile;
let logFile;
let originalPath;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-exact-title-'));
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
const setScenario = (sc) => fs.writeFileSync(scenarioFile, JSON.stringify({ open: [], closed: [], ...sc }));

// Il caso reale: il titolo del workflow generale e quello di un cantone.
const SHORT_TITLE = 'Workflow Failure: Generate Blog Article';
const EXACT = { number: 249, title: SHORT_TITLE, url: 'https://github.com/o/r/issues/249', state: 'OPEN' };
const SIBLING = {
  number: 2272,
  title: `${SHORT_TITLE} (canton-nw)`,
  url: 'https://github.com/o/r/issues/2272',
  state: 'OPEN',
};

// Due titoli PIU' LUNGHI del taglio che condividono i primi 60 caratteri: qui
// il confronto per prefisso e' voluto, e `exactTitle` lo restringe.
const LONG_REGRESSION = 'it:/vivere-in-liechtenstein-lavorare-in-svizzera/ — information gain sotto il floor';
const LONG_OPPORTUNITY = 'it:/vivere-in-liechtenstein-lavorare-in-svizzera/ — information gain sotto il target del 40%';
const LONG_ISSUES = [
  { number: 72, title: LONG_REGRESSION, url: 'https://github.com/o/r/issues/72', state: 'OPEN' },
  { number: 71, title: LONG_OPPORTUNITY, url: 'https://github.com/o/r/issues/71', state: 'OPEN' },
];

test('le fixture misurano il caso giusto: titolo corto dentro il taglio, titoli lunghi con prefisso comune', () => {
  assert.ok(SHORT_TITLE.length <= 60, 'il titolo corto deve stare dentro il taglio a 60 caratteri');
  assert.ok(SIBLING.title.startsWith(SHORT_TITLE), 'la gemella deve estendere il titolo corto');
  assert.ok(LONG_REGRESSION.length > 60 && LONG_OPPORTUNITY.length > 60);
  assert.equal(LONG_REGRESSION.slice(0, 60), LONG_OPPORTUNITY.slice(0, 60));
  assert.notEqual(LONG_REGRESSION, LONG_OPPORTUNITY);
});

test('un titolo corto non e\' il prefisso della gemella piu\' lunga: la ricorrenza va sulla issue esatta', async () => {
  // La gemella e' piu' recente e viene PRIMA nel listing: col confronto per
  // prefisso vinceva lei.
  setScenario({ open: [SIBLING, EXACT] });

  const res = await createGithubIssue({ title: SHORT_TITLE, description: 'current workflow failure', labels: ['bug'] });

  assert.equal(res?.number, 249);
  assert.deepEqual(callsTo('comment').map((a) => a[2]), ['249']);
  assert.equal(callsTo('create').length, 0);
});

test('con la sola gemella piu\' lunga aperta nasce una issue nuova col titolo esatto', async () => {
  setScenario({ open: [SIBLING] });

  const res = await createGithubIssue({ title: SHORT_TITLE, description: 'current workflow failure', labels: ['bug'] });

  assert.equal(res?.number, 999);
  const created = callsTo('create');
  assert.equal(created.length, 1);
  assert.equal(created[0][created[0].indexOf('--title') + 1], SHORT_TITLE);
  assert.equal(callsTo('comment').length, 0, 'la gemella del cantone non deve ricevere la ricorrenza');
});

test('il resolver di un titolo corto lascia aperta la gemella piu\' lunga', () => {
  setScenario({ open: [SIBLING] });

  const res = resolveGithubIssue(SHORT_TITLE, { workflow: 'Generate Blog Article' });

  assert.equal(res, null);
  assert.equal(callsTo('close').length, 0);
  assert.equal(callsTo('comment').length, 0);
});

test('una gemella piu\' lunga chiusa di recente non viene riaperta per un titolo corto', async () => {
  setScenario({
    closed: [{
      ...SIBLING,
      state: 'CLOSED',
      stateReason: 'COMPLETED',
      closedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      labels: [{ name: 'bug' }],
    }],
  });

  const res = await createGithubIssue({ title: SHORT_TITLE, description: 'current workflow failure', labels: ['bug'] });

  assert.equal(res?.number, 999);
  assert.equal(callsTo('reopen').length, 0);
  assert.equal(callsTo('comment').length, 0);
});

test('un titolo oltre il taglio conserva il confronto per prefisso; exactTitle lo restringe', async () => {
  setScenario({ open: LONG_ISSUES });
  const byPrefix = await createGithubIssue({
    title: LONG_OPPORTUNITY,
    description: 'current opportunity measurement',
    labels: ['enhancement', 'seo'],
  });
  assert.equal(byPrefix?.number, 72, 'senza exactTitle un titolo troncato resta una famiglia per prefisso');

  fs.writeFileSync(logFile, '');
  const exact = await createGithubIssue({
    title: LONG_OPPORTUNITY,
    description: 'current opportunity measurement',
    labels: ['enhancement', 'seo'],
    exactTitle: true,
  });
  assert.equal(exact?.number, 71);
  assert.deepEqual(callsTo('comment').map((a) => a[2]), ['71']);
  assert.equal(callsTo('create').length, 0);
});

test('una famiglia con dedupKey conserva il confronto per prefisso e la migrazione del titolo', async () => {
  const title = 'Duplicate crawler companies: 0 groups';
  setScenario({
    open: [{
      number: 81,
      title: 'Duplicate crawler companies: 17 groups',
      url: 'https://github.com/o/r/issues/81',
      state: 'OPEN',
    }],
  });

  const res = await createGithubIssue({
    title,
    description: 'cold-start probe',
    labels: ['bug'],
    dedupKey: 'Duplicate crawler companies:',
  });

  assert.equal(res?.number, 81);
  const edit = callsTo('edit')[0] || [];
  assert.ok(edit.includes('--title') && edit.includes(title), 'il titolo della issue canonica segue la misura corrente');
  assert.equal(callsTo('create').length, 0);
  assert.equal(callsTo('comment')[0]?.[2], '81');
});

test('il resolver con exactTitle chiude solo la issue esatta, non la gemella dello stesso prefisso', () => {
  setScenario({ open: LONG_ISSUES });

  const res = resolveGithubIssue(LONG_OPPORTUNITY, { workflow: 'Information Gain Scan', exactTitle: true });

  assert.equal(res?.number, 71);
  assert.deepEqual(callsTo('close').map((a) => a[2]), ['71']);
  assert.equal(callsTo('comment')[0]?.[2], '71');
});
