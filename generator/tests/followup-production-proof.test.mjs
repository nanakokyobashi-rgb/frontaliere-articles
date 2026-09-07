/**
 * followup-production-proof.test.mjs — `awaiting-production-proof` letto e
 * rimosso (issue #973, item 4).
 *
 * La label sospende la chiusura di una issue il cui fix è mergiato ma
 * dimostrabile solo da una run reale su `main` (`ISSUES.md` → "Fix flow",
 * `REVIEW.md` §8, incidente #151). Fino a questa fix NESSUNO stadio la
 * leggeva: la issue restava aperta, il ramo DELIVERED la ri-accodava e il DRAIN
 * la promuoveva al primo slot libero, mandando il fixer a riscoprire che il fix
 * è già mergiato — un run Claude a testa, sulla quota condivisa col sito.
 *
 * L'item era dichiarato `needs triage` per una ragione precisa: escludere la
 * label dalla promozione, DA SOLA, la rende uno stato ASSORBENTE — nessun
 * automatismo la toglie, quindi la issue non verrebbe promossa mai più. Le due
 * metà (sospensione + rimuovitore) stanno insieme o nessuna è corretta, ed è
 * quello che questi test asseriscono: ogni stato di `productionProofDecision`
 * che non sia `hold` termina con la rimozione della label, e `hold` stesso è
 * bounded da `PROOF_MAX_HOLD_DAYS`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROOF_MAX_HOLD_DAYS,
  productionProofDecision,
  workflowFilesOf,
} from '../../scripts/ci/followup-drainer.mjs';

const DRAINER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../scripts/ci/followup-drainer.mjs',
);
const DAY = 86_400_000;
const T0 = Date.parse('2026-09-01T00:00:00Z');
const RUN = { url: 'https://github.com/o/r/actions/runs/1', createdAt: '2026-09-01T06:00:00Z', workflow: 'issue-fix' };

test('workflowFilesOf tiene solo i file di workflow, e per intero', () => {
  assert.deepEqual(
    workflowFilesOf([
      '.github/workflows/issue-fix.yml',
      '.github/workflows/publish-api.yaml',
      'scripts/ci/followup-drainer.mjs',
      '.github/workflows/nested/dir.yml', // sotto-cartella: non è un workflow eseguibile
      '.github/ISSUE_TEMPLATE/bug.yml',
      '',
    ]),
    ['.github/workflows/issue-fix.yml', '.github/workflows/publish-api.yaml'],
  );
  assert.deepEqual(workflowFilesOf(undefined), []);
});

test('run verde su `main` creata DOPO il merge = prova', () => {
  const d = productionProofDecision({
    labeledAt: T0, mergedAt: T0 + 3600_000, workflows: ['.github/workflows/issue-fix.yml'],
    proofRun: RUN, now: T0 + 2 * DAY,
  });
  assert.equal(d.action, 'proof');
  assert.equal(d.run, RUN);
});

test('nessuna run verde ancora, dentro la finestra → hold (la label resta)', () => {
  const d = productionProofDecision({
    labeledAt: T0, mergedAt: T0, workflows: ['.github/workflows/issue-fix.yml'],
    proofRun: null, now: T0 + DAY,
  });
  assert.equal(d.action, 'hold');
});

test('PR non ancora mergiata → hold: la prova non può esistere prima del merge', () => {
  // La label la applica il fixer subito DOPO `gh pr create`, quindi questo è lo
  // stato normale dei primi minuti: non deve valere «prova indeterminabile».
  const d = productionProofDecision({
    labeledAt: T0, mergedAt: null, workflows: [], proofRun: null, now: T0 + 60_000,
  });
  assert.equal(d.action, 'hold');
});

test('PR mai mergiata oltre la finestra → timeout, la label non resta appesa', () => {
  const d = productionProofDecision({
    labeledAt: T0, mergedAt: null, workflows: [], proofRun: null,
    now: T0 + (PROOF_MAX_HOLD_DAYS + 1) * DAY,
  });
  assert.equal(d.action, 'timeout');
});

test('merge senza file di workflow → prova indeterminabile, label rimossa', () => {
  // La label è stata applicata fuori dalla sua regola (REVIEW.md §8 la lega a
  // `.github/workflows/**`): non esiste una run di cui la prova sia la misura,
  // quindi la sospensione non potrebbe MAI risolversi da sola.
  const d = productionProofDecision({
    labeledAt: T0, mergedAt: T0, workflows: [], proofRun: null, now: T0 + DAY,
  });
  assert.equal(d.action, 'undeterminable');
});

test('nessuna prova oltre PROOF_MAX_HOLD_DAYS → timeout', () => {
  const d = productionProofDecision({
    labeledAt: T0, mergedAt: T0, workflows: ['.github/workflows/issue-fix.yml'],
    proofRun: null, now: T0 + (PROOF_MAX_HOLD_DAYS + 1) * DAY,
  });
  assert.equal(d.action, 'timeout');
  assert.match(d.reason, /issue-fix\.yml/);
});

test('la finestra si misura dal merge, non dall apposizione della label', () => {
  // Label vecchia, merge di ieri: la prova ha ancora tempo di arrivare.
  const d = productionProofDecision({
    labeledAt: T0, mergedAt: T0 + 10 * DAY, workflows: ['.github/workflows/issue-fix.yml'],
    proofRun: null, now: T0 + 11 * DAY, maxHoldMs: 7 * DAY,
  });
  assert.equal(d.action, 'hold');
});

test('timestamp illeggibili (glitch gh) → skip: nessuna decisione, si riprova al tick dopo', () => {
  const d = productionProofDecision({ labeledAt: null, mergedAt: null, workflows: [], proofRun: null });
  assert.equal(d.action, 'skip');
});

test('nessuno stato che non sia `hold`/`skip` lascia la label appesa: la sospensione è bounded', () => {
  // La proprietà che rende la sospensione del DRAIN non-assorbente. Con
  // `now` oltre la finestra restano solo esiti che rimuovono la label.
  const late = T0 + (PROOF_MAX_HOLD_DAYS + 1) * DAY;
  for (const args of [
    { labeledAt: T0, mergedAt: null, workflows: [], proofRun: null },
    { labeledAt: T0, mergedAt: T0, workflows: [], proofRun: null },
    { labeledAt: T0, mergedAt: T0, workflows: ['.github/workflows/a.yml'], proofRun: null },
    { labeledAt: T0, mergedAt: T0, workflows: ['.github/workflows/a.yml'], proofRun: RUN },
  ]) {
    const d = productionProofDecision({ ...args, now: late });
    assert.ok(['proof', 'timeout', 'undeterminable'].includes(d.action), `atteso un esito che rimuove la label, non ${d.action}`);
  }
});

test('il DRAIN sospende la promozione, e il pass PRODUCTION-PROOF toglie la label', () => {
  const src = fs.readFileSync(DRAINER, 'utf8');
  assert.match(src, /if \(has\(cand, LBL_PROOF\)\) \{/, 'il DRAIN salta il candidato in attesa di prova');
  assert.ok(
    src.indexOf('if (has(cand, LBL_PROOF)) {') < src.indexOf("budget.take(`#${cand.number} (drain)`"),
    'il check è label-only: deve stare PRIMA del budget (non costa una `gh`)',
  );
  const skip = src.slice(src.indexOf('if (has(cand, LBL_PROOF)) {'), src.indexOf("budget.take(`#${cand.number} (drain)`"));
  assert.doesNotMatch(skip, /LBL_PARKED/, 'la sospensione non parcheggia: la coda non deve perdere la issue');
  const pass = src.slice(src.indexOf('// --- PRODUCTION-PROOF: constata la prova'));
  assert.match(pass.slice(0, 6000), /edit\(iss\.number, \{ remove: \[LBL_PROOF\] \}\)/, 'il pass rimuove la label');
  assert.match(pass.slice(0, 6000), /no silent cap/, 'il cap per run va dichiarato nel log');
});

// --- nit della review su PR #1111 (stessa issue, ciclo successivo) ----------

test('lista dei file illeggibile ≠ «nessun workflow»: skip, non undeterminable', () => {
  // `gh pr list --json files` risolve `files(first: 100)`: una PR con >100 file
  // o un glitch sul campo dà una lista vuota o troncata. Leggerla come «la PR
  // non tocca `.github/workflows/**`» toglierebbe la label SUBITO, con un
  // commento che afferma una cosa falsa, e rimetterebbe la issue in promozione.
  const d = productionProofDecision({
    labeledAt: T0, mergedAt: T0, workflows: [], filesKnown: false, proofRun: null, now: T0 + DAY,
  });
  assert.equal(d.action, 'skip');
  assert.match(d.reason, /files\(first: 100\)/);
});

test('lista dei file illeggibile oltre la finestra → timeout: nemmeno lo skip è assorbente', () => {
  const d = productionProofDecision({
    labeledAt: T0, mergedAt: T0, workflows: [], filesKnown: false, proofRun: null,
    now: T0 + (PROOF_MAX_HOLD_DAYS + 1) * DAY,
  });
  assert.equal(d.action, 'timeout');
});

test('la prova è ancorata al SHA del merge, non al solo orologio', () => {
  // `createdAt > mergedAt` non dimostra che la run CONTENESSE il fix: una run
  // accodata prima del merge e creata dopo, un `workflow_dispatch` su un ref
  // precedente o una re-run sono `success` su `main` senza il commit dentro —
  // prova falsa, label rimossa, ed è la forma nuova di #151.
  const src = fs.readFileSync(DRAINER, 'utf8');
  const fn = src.slice(src.indexOf('function successMainRunAfter('), src.indexOf('// --- PRODUCTION-PROOF: constata la prova'));
  assert.match(fn, /createdAt,url,workflowName,headSha/, 'la run va letta col suo headSha');
  assert.match(fn, /runContainsCommit\(headSha, mergeSha\)/, 'il headSha va confrontato col commit di merge');
  assert.match(fn, /if \(contains !== true\) continue;/, 'containment non decidibile ≠ prova');
  assert.match(src, /compare\/\$\{base\}\.\.\.\$\{head\}/, 'il containment si misura con `compare`');
  assert.match(src, /'mergedAt,files,mergeCommit'/, 'il SHA del merge viene dalla stessa `gh pr list`');
});

test('il pass esamina prima le issue più VECCHIE, quelle vicine al timeout', () => {
  // `gh issue list` ordina dalle più recenti: sommato al cap per run, le più
  // vecchie — cioè quelle per cui il `timeout` deve scattare — non verrebbero
  // mai esaminate. Stessa classe già misurata su `ISSUE_LIST_LIMIT`.
  const src = fs.readFileSync(DRAINER, 'utf8');
  const pass = src.slice(src.indexOf('// --- PRODUCTION-PROOF: constata la prova'));
  assert.match(pass.slice(0, 2000), /listIssues\(LBL_PROOF\)\s*\n\s*\.slice\(\)\s*\n\s*\.sort\(/, 'il pool va riordinato prima del cap');
  assert.match(pass.slice(0, 2000), /Date\.parse\(a\?\.createdAt\) \|\| 0\) - \(Date\.parse\(b\?\.createdAt\)/, 'ordine ascendente per apertura');
});

test('il commento arriva solo se la label è stata davvero rimossa', () => {
  // `edit` degrada l'errore a `::warning::`: commentando PRIMA, una `gh issue
  // edit` fallita lascia la label appesa e il tick successivo ri-posta lo stesso
  // commento — uno per tick, indefinitamente per gli esiti che non evolvono più.
  const src = fs.readFileSync(DRAINER, 'utf8');
  const pass = src.slice(src.indexOf('// --- PRODUCTION-PROOF: constata la prova'));
  const iEdit = pass.indexOf('if (!edit(iss.number, { remove: [LBL_PROOF] }))');
  const iComment = pass.indexOf("gh(['issue', 'comment', String(iss.number)");
  assert.ok(iEdit > -1 && iComment > -1 && iEdit < iComment, 'la rimozione della label precede il commento');
  assert.match(pass.slice(iEdit, iComment), /continue;/, 'rimozione fallita → nessun commento, si riprova al tick dopo');
});

test('`edit` è osservabile: ritorna l esito invece di inghiottirlo', () => {
  const src = fs.readFileSync(DRAINER, 'utf8');
  const fn = src.slice(src.indexOf('function edit(num, { add = [], remove = [] })'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /try \{ gh\(args, \{ json: false \}\); return true; \}/);
  assert.match(body, /catch \(e\) \{/);
  assert.match(body, /return false; \}/, 'un edit fallito è visibile al chiamante');
});

test('una sola `gh run list` dopo la prima prova trovata (for/break, non map)', () => {
  const src = fs.readFileSync(DRAINER, 'utf8');
  const pass = src.slice(src.indexOf('// --- PRODUCTION-PROOF: constata la prova'));
  assert.doesNotMatch(pass.slice(0, 3000), /workflows\.map\(/, '`map` non corto-circuita: valuta tutti i workflow');
  assert.match(pass.slice(0, 3000), /if \(proofRun\) break;/);
  assert.match(pass.slice(0, 3000), /merged \? null : labelAddedAt\(iss\.number, LBL_PROOF\)/, '`labeledAt` è letto solo dal ramo che lo usa');
});
