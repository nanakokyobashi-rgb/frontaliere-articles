/**
 * scan-failed-runs-dedup.test.mjs — `alreadyReported()` deve usare
 * `searchSafePrefix()` (issue #663), non il `title.slice(0, 60)` grezzo che la
 * review della PR #661 ha segnalato come nit sul detector timeout gemello.
 *
 * Il taglio grezzo puo' spezzare una parola o lasciare una parentesi
 * sbilanciata: la ricerca `gh` su una frase cosi' rotta ritorna zero
 * risultati, la issue canonica esiste ma non si trova, e se ne apre una
 * doppia sulla stessa run. Le fixture qui sotto riusano il titolo lungo gia'
 * validato in `workflow-failure-timeout-monitor.test.mjs` (parentesi
 * sbilanciata dal taglio) e ne aggiungono uno che spezza a meta' parola.
 *
 * Il seam e' un eseguibile `gh` finto in testa a `PATH` (stessa tecnica di
 * `github-issue-creator-reopen-default.test.mjs`): `alreadyReported()` chiama
 * `gh` due volte — `issue list` per i candidati, `issue view` per il body —
 * ed e' quella seconda chiamata (dedup per run URL) che il test deve poter
 * osservare per verificare che la discriminazione fra run diverse resti
 * intatta.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchSafePrefix } from '../../scripts/lib/github-issue-creator.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.resolve(HERE, '../../scripts/ci/scan-failed-runs.mjs');
const { alreadyReported } = await import(MODULE_PATH);

// ── Il `gh` finto ───────────────────────────────────────────────────
//
// `issue list` ignora i filtri e ritorna sempre lo scenario intero — proprio
// come la ricerca reale di GitHub e' fuzzy e ritorna candidati che il codice
// filtra poi localmente con `startsWith(titlePrefix)`. Cosi' il test misura
// esattamente quel filtro, non un mock che lo aggira. `issue view` ritorna il
// body registrato per quel numero.
const FAKE_GH = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');
const sc = JSON.parse(fs.readFileSync(process.env.FAKE_GH_SCENARIO, 'utf8'));
if (args[0] === 'issue' && args[1] === 'list') {
  process.stdout.write(JSON.stringify(sc.open || []));
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'view') {
  const num = args[2];
  process.stdout.write(String((sc.bodies || {})[num] || ''));
  process.exit(0);
}
process.exit(0);
`;

let tmpDir;
let scenarioFile;
let logFile;
let originalPath;
let originalRepo;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-scan-failed-'));
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'gh'), FAKE_GH, { mode: 0o755 });
  scenarioFile = path.join(tmpDir, 'scenario.json');
  logFile = path.join(tmpDir, 'gh.log');
  originalPath = process.env.PATH;
  originalRepo = process.env.GITHUB_REPOSITORY;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
  process.env.FAKE_GH_SCENARIO = scenarioFile;
  process.env.FAKE_GH_LOG = logFile;
  process.env.GITHUB_REPOSITORY = 'o/r';
});

after(() => {
  process.env.PATH = originalPath;
  if (originalRepo === undefined) delete process.env.GITHUB_REPOSITORY;
  else process.env.GITHUB_REPOSITORY = originalRepo;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.writeFileSync(logFile, '');
});

const setScenario = (sc) => fs.writeFileSync(scenarioFile, JSON.stringify(sc));
const ghCalls = () =>
  fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// ── Fixture: parentesi sbilanciata dal taglio a 60 ────────────────────

const PAREN_TITLE = 'CI Failure: Crawler Group Very Long Name (Dedicated Regional Nightly Sequence)';

test('parentesi sbilanciata: il prefisso di ricerca non la contiene', () => {
  // `title.slice(0, 60)` lascerebbe `...(Dedicated Regional` — apertura senza
  // chiusura. Il fix deve passare per searchSafePrefix, che la toglie.
  const naive = PAREN_TITLE.slice(0, 60);
  assert.ok(naive.includes('(') && !naive.includes(')'), 'la fixture deve avere una parentesi aperta e non chiusa nel taglio grezzo');
  assert.equal(searchSafePrefix(PAREN_TITLE), 'CI Failure: Crawler Group Very Long Name');
});

test('parentesi sbilanciata: trova la issue canonica esistente ed evita il doppione', () => {
  setScenario({
    open: [{ number: 501, title: PAREN_TITLE }],
    bodies: { 501: 'vedi run https://github.com/o/r/actions/runs/111' },
  });
  const found = alreadyReported(PAREN_TITLE, 'https://github.com/o/r/actions/runs/111');
  assert.equal(found, true);
  const search = ghCalls().find((a) => a[0] === 'issue' && a[1] === 'list');
  assert.ok(search.some((a) => a.includes('in:title')), 'la query di ricerca deve usare in:title');
  assert.ok(!search.some((a) => a.includes('Dedicated Region')), 'la query non deve contenere il taglio grezzo spezzato');
});

// ── Fixture: taglio a meta' parola ────────────────────────────────────

const MIDWORD_TITLE =
  'Workflow Failure: articolo perso su a/very-long-path-segment-that-continues-past-sixty-characters-boundary/file.mjs';

test('taglio a meta\' parola: il prefisso sicuro si ferma sull\'ultimo token intero', () => {
  const naive = MIDWORD_TITLE.slice(0, 60);
  assert.notEqual(MIDWORD_TITLE[60], ' ', 'la fixture deve tagliare dentro una parola, non su uno spazio');
  const safe = searchSafePrefix(MIDWORD_TITLE);
  assert.ok(MIDWORD_TITLE.startsWith(safe));
  assert.notEqual(safe, naive);
});

test('taglio a meta\' parola: trova la issue canonica ed evita il doppione', () => {
  setScenario({
    open: [{ number: 502, title: MIDWORD_TITLE }],
    bodies: { 502: 'run https://github.com/o/r/actions/runs/222' },
  });
  const found = alreadyReported(MIDWORD_TITLE, 'https://github.com/o/r/actions/runs/222');
  assert.equal(found, true);
});

// ── Discriminazione: titoli distinti non collassano sullo stesso canonical ──

test('due titoli distinti restano distinti anche quando condividono il prefisso di ricerca', () => {
  const titleA = 'Workflow Failure: Generate Blog Article (svizzera locale run alpha branch)';
  const titleB = 'Workflow Failure: Generate Blog Article (frontaliera locale run beta branch)';
  setScenario({
    open: [{ number: 601, title: titleA }],
    bodies: { 601: 'run https://github.com/o/r/actions/runs/333' },
  });
  // titleB non e' mai stato riportato: nessuna issue aperta lo contiene, quindi
  // deve restare false anche se condivide il canonical con titleA a livello di
  // scansione (candidati filtrati per startsWith sul prefisso sicuro).
  const foundA = alreadyReported(titleA, 'https://github.com/o/r/actions/runs/333');
  const foundBOtherRun = alreadyReported(titleA, 'https://github.com/o/r/actions/runs/999');
  assert.equal(foundA, true);
  assert.equal(foundBOtherRun, false, 'una run URL diversa sulla stessa issue non deve leggersi come gia\' riportata');
});

// ── Dedup per run URL: stessa issue, run diverse ──────────────────────

test('dedup per run URL: la stessa run gia\' citata non riapre, una run nuova sì', () => {
  setScenario({
    open: [{ number: 701, title: PAREN_TITLE }],
    bodies: { 701: 'segnalato per https://github.com/o/r/actions/runs/aaa' },
  });
  assert.equal(alreadyReported(PAREN_TITLE, 'https://github.com/o/r/actions/runs/aaa'), true);
  assert.equal(alreadyReported(PAREN_TITLE, 'https://github.com/o/r/actions/runs/bbb'), false);
});
