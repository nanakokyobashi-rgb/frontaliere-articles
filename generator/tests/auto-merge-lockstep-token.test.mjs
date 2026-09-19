/**
 * Fissa QUALE credenziale mergia la PR del mirror, su quale perimetro e con
 * quale verdetto required-check.
 * Run with `node --test`.
 *
 * Non è un test di stile: entrambe le cose che verifica falliscono in SILENZIO.
 *
 * 1. Il token. In Remote Config ci sono due PAT e non sono intercambiabili —
 *    `GITHUB_PAT` è un token integration senza Actions write (403 su dispatch,
 *    vedi l'intestazione di generate-article.yml), `GITHUB_PAT_NANAKO` è un PAT
 *    classico con scope `repo` + `workflow`. Peggio ancora sarebbe ricadere su
 *    `GITHUB_TOKEN`: un merge autenticato con quello NON fa scattare
 *    `publish-api.yml` (regola anti-ricorsione), quindi la PR risulterebbe
 *    mergiata e la superficie dati resterebbe vecchia. Nessuna CI diventerebbe
 *    rossa: si vedrebbe solo, settimane dopo, come pagine renderizzate da un
 *    engine che non è quello su main.
 *
 * 2. Il perimetro. `engine-lockstep-auto` è un branch che il mirror possiede in
 *    esclusiva e force-pusha; allargare il filtro a `--state open` senza `--head`
 *    farebbe auto-mergiare qualunque PR aperta di questo repo.
 * 3. Il check. Un output vuoto, non-array, senza il check principale o con uno
 *    stato non sicuro non è un verdetto: il lockstep deve restare fermo e
 *    riprovare. Gli opzionali `SKIPPED`/`NEUTRAL` restano esplicitamente leciti.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  allChecksDecision,
  allCheckRunsDecision,
  exactCheckRunSnapshot,
  requiredCheckDecision,
  requiredCheckRunsDecision,
} from '../../scripts/ci/native-automerge-sweep-policy.mjs';
import { VITEST_CHECK_NAME } from '../../scripts/ci/lib/constants.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = resolve(here, '../../.github/workflows/auto-merge-engine-lockstep.yml');
const wf = readFileSync(WORKFLOW, 'utf8');

test('mergia con GITHUB_PAT_NANAKO, non con l\'altro PAT', () => {
  assert.match(wf, /GITHUB_PAT_NANAKO/, 'deve usare il PAT che ha Actions write');
  // `GITHUB_PAT` può comparire solo in prosa esplicativa, mai come valore usato.
  const righeAttive = wf
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
  assert.ok(
    !/\$\{?GITHUB_PAT\}?[^_]/.test(righeAttive),
    'non deve consumare GITHUB_PAT: è un token integration senza Actions write',
  );
});

test('non ricade MAI su GITHUB_TOKEN per il merge', () => {
  // Asserisce sull'USO, non sulla menzione: il messaggio d'errore del workflow nomina
  // GITHUB_TOKEN in prosa per spiegare perché non lo usa, ed è giusto che lo faccia.
  // Quello che non deve esistere è un RIFERIMENTO alla variabile.
  assert.ok(
    !/\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/.test(wf),
    'non deve ricevere secrets.GITHUB_TOKEN',
  );
  assert.ok(
    !/\$\{?GITHUB_TOKEN\}?\b/.test(wf),
    'non deve leggere $GITHUB_TOKEN: un merge autenticato così non fa scattare publish-api.yml',
  );
  // E il caso "PAT assente" deve essere un errore esplicito, non un ripiego silenzioso.
  assert.match(
    wf,
    /GITHUB_PAT_NANAKO:-\}" \]; then[\s\S]{0,400}exit 1/,
    'senza il PAT deve fallire, non mergiare in un modo che non pubblica',
  );
});

test('è ristretto al branch che il mirror possiede', () => {
  assert.match(wf, /--head engine-lockstep-auto/,
    'senza --head l\'auto-merge prenderebbe qualunque PR aperta del repo');
});

test('usa --merge e non --squash, per non perdere la provenienza', () => {
  // Il commit del mirror porta il SHA del sito da cui l'engine è stato copiato:
  // è l'unico legame fra i due repo, e uno squash lo sostituirebbe col titolo.
  assert.match(wf, /gh pr merge "\$PR" --merge\b/);
  // Solo sulle righe attive: il commento sopra il comando cita --squash per dire
  // perché NON si usa, e asserire sul file intero lo scambierebbe per un uso.
  const attive = wf.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.ok(!/--squash/.test(attive));
});

test('il lockstep legge tutti i check e resta fail-closed', () => {
  assert.match(wf, /gh pr checks "\$PR" --required --json name/);
  assert.doesNotMatch(wf, /gh pr checks "\$PR" --json name,state,bucket/,
    'gli stati non devono provenire da uno snapshot PR non legato alla HEAD');
  assert.match(wf, /gh api --paginate --slurp[\s\S]+commits\/\$\{HEAD_SHA\}\/check-runs\?per_page=100/);
  assert.match(wf, /native-automerge-sweep-policy\.mjs/);
  assert.match(wf, /--required-check-runs "\$CHECK_RUNS_FILE" "\$REQUIRED_NAMES_FILE" "\$HEAD_SHA"/);
  assert.match(wf, /--all-check-runs "\$CHECK_RUNS_FILE" "\$REQUIRED_NAMES_FILE" "\$HEAD_SHA"/);
  assert.match(wf, /REQUIRED_NAMES_EXIT=/);
  assert.match(wf, /CHECK_RUNS_EXIT=/);
  assert.match(wf, /--merge --delete-branch=false/);
});

test('il merge è vincolato alla HEAD catturata prima dei check', () => {
  const headCapture = wf.indexOf('HEAD_SHA=$(gh pr view "$PR" --json headRefOid');
  const checks = wf.indexOf('REQUIRED_NAMES_FILE=', headCapture);
  const runs = wf.indexOf('CHECK_RUNS_FILE=', checks);
  const merge = wf.indexOf('gh pr merge "$PR" --merge --delete-branch=false');
  assert.ok(headCapture >= 0, 'deve catturare headRefOid prima della valutazione');
  assert.ok(checks > headCapture, 'i check devono seguire lo snapshot HEAD');
  assert.ok(runs > checks && merge > runs, 'il merge deve seguire entrambi i gate');
  assert.match(
    wf.slice(merge, merge + 180),
    /--match-head-commit "\$HEAD_SHA"/,
    'il merge deve rifiutare un force-push fra check e merge',
  );
  assert.match(wf, /HEAD_SHA.*\^\[0-9a-fA-F\]\{40\}/s,
    'HEAD non valida deve restare fail-closed');
});

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const requiredNames = [{ name: VITEST_CHECK_NAME }, { name: 'generator-ci' }];

function checkRun(id, name, state, head = HEAD_A, time = `2026-09-19T${String(id % 24).padStart(2, '0')}:00:00Z`) {
  const normalized = state.toLowerCase();
  const active = ['queued', 'in_progress', 'requested', 'waiting', 'pending'].includes(normalized);
  return {
    id,
    name,
    head_sha: head,
    status: active ? normalized : 'completed',
    conclusion: active ? null : normalized,
    created_at: time,
    started_at: time,
    completed_at: active ? null : time,
  };
}

function checkPages(...runs) {
  return [{ check_runs: runs }];
}

test('i check-run sono vincolati alla HEAD e impediscono ABA', () => {
  const aSuccess = checkPages(
    checkRun(101, VITEST_CHECK_NAME, 'SUCCESS', HEAD_A, '2026-09-19T01:00:00Z'),
    checkRun(102, 'generator-ci', 'SUCCESS', HEAD_A, '2026-09-19T01:01:00Z'),
  );
  assert.equal(requiredCheckRunsDecision(aSuccess, requiredNames, HEAD_A).allow, true);
  assert.equal(allCheckRunsDecision(aSuccess, requiredNames, HEAD_A).allow, true);

  // A→B→A: stati osservati sulla commit B non sono un verdetto per A, anche
  // se il branch torna poi alla SHA A prima del --match-head-commit finale.
  const bChecks = checkPages(
    checkRun(201, VITEST_CHECK_NAME, 'SUCCESS', HEAD_B, '2026-09-19T02:00:00Z'),
    checkRun(202, 'generator-ci', 'FAILURE', HEAD_B, '2026-09-19T02:01:00Z'),
  );
  assert.equal(requiredCheckRunsDecision(bChecks, requiredNames, HEAD_A).allow, false);
  assert.equal(allCheckRunsDecision(bChecks, requiredNames, HEAD_A).allow, false);

  const aFailure = checkPages(
    checkRun(301, VITEST_CHECK_NAME, 'FAILURE', HEAD_A, '2026-09-19T03:00:00Z'),
    checkRun(302, 'generator-ci', 'SUCCESS', HEAD_A, '2026-09-19T03:01:00Z'),
  );
  assert.equal(requiredCheckRunsDecision(aFailure, requiredNames, HEAD_A).allow, false);
});

test('check-run snapshot seleziona l ultimo run per nome e fail-closes malformed/unknown', () => {
  const rerun = checkPages(
    checkRun(401, VITEST_CHECK_NAME, 'FAILURE', HEAD_A, '2026-09-19T04:00:00Z'),
    checkRun(402, VITEST_CHECK_NAME, 'SUCCESS', HEAD_A, '2026-09-19T04:01:00Z'),
    checkRun(403, 'generator-ci', 'NEUTRAL', HEAD_A, '2026-09-19T04:02:00Z'),
  );
  const snapshot = exactCheckRunSnapshot(rerun, HEAD_A);
  assert.equal(snapshot.allow, true);
  assert.equal(snapshot.checks.find((check) => check.name === VITEST_CHECK_NAME)?.state, 'SUCCESS');
  assert.equal(allCheckRunsDecision(rerun, requiredNames, HEAD_A).allow, true);

  const malformed = [
    ['empty', [], HEAD_A],
    ['non-array', null, HEAD_A],
    ['page non-object', [{}], HEAD_A],
    ['wrong head', checkPages(checkRun(404, VITEST_CHECK_NAME, 'SUCCESS', HEAD_B)), HEAD_A],
    ['missing required', checkPages(checkRun(405, VITEST_CHECK_NAME, 'SUCCESS')), [{ name: 'missing' }]],
  ];
  for (const [name, pages, names] of malformed) {
    const required = Array.isArray(names) ? names : requiredNames;
    assert.equal(requiredCheckRunsDecision(pages, required, HEAD_A).allow, false, name);
  }
  assert.equal(
    allCheckRunsDecision(checkPages(
      checkRun(406, VITEST_CHECK_NAME, 'SUCCESS'),
      checkRun(407, 'optional', 'UNKNOWN'),
    ), requiredNames, HEAD_A).allow,
    false,
    'stato unknown',
  );
  assert.equal(
    exactCheckRunSnapshot(checkPages(
      checkRun(408, VITEST_CHECK_NAME, 'SUCCESS'),
      checkRun(408, 'duplicate-id', 'SUCCESS'),
    ), HEAD_A).allow,
    false,
    'id duplicato nelle pagine',
  );
});

const required = (state, overrides = {}) => ({
  name: VITEST_CHECK_NAME,
  state,
  bucket: state === 'SUCCESS' ? 'pass' : 'pending',
  ...overrides,
});

test('la decisione check è table-driven e richiede SUCCESS esplicito', () => {
  const cases = [
    ['SUCCESS', true],
    ['SKIPPED', false],
    ['NEUTRAL', false],
    ['EXPECTED', false],
    ['ACTION_REQUIRED', false],
    ['STALE', false],
    ['PENDING', false],
    ['QUEUED', false],
    ['IN_PROGRESS', false],
    ['FAILURE', false],
    ['ERROR', false],
    ['CANCELLED', false],
    ['UNKNOWN', false],
    ['', false],
  ];
  for (const [state, expected] of cases) {
    assert.equal(requiredCheckDecision([required(state)]).allow, expected, state || '<empty>');
  }
  assert.equal(requiredCheckDecision([required('success')]).allow, true, 'state case-insensitive');
  assert.equal(requiredCheckDecision([required('SUCCESS'), required('SUCCESS')]).allow, false, 'duplicate required ambiguo');
  assert.equal(requiredCheckDecision([
    required('SUCCESS'),
    { name: 'generator-ci', state: 'FAILURE', bucket: 'fail' },
  ]).allow, false, 'altro check rosso');
  assert.equal(requiredCheckDecision([
    required('SUCCESS'),
    { name: 'generator-ci', state: 'UNKNOWN', bucket: 'pending' },
  ]).allow, false, 'altro check sconosciuto');
  assert.equal(requiredCheckDecision([
    required('SUCCESS'),
    { name: 'generator-ci', state: 'SKIPPED', bucket: 'skipping' },
  ]).allow, false, 'required secondario saltato');
  assert.equal(requiredCheckDecision([
    required('SUCCESS'),
    { name: 'generator-ci', state: 'NEUTRAL', bucket: 'pass' },
  ]).allow, false, 'required secondario neutrale');
  assert.equal(requiredCheckDecision([
    required('SUCCESS'),
    { name: 'generator-ci', state: 'SUCCESS', bucket: 'pass' },
  ]).allow, true, 'altri check verdi');
  const optionalCases = [
    ['SUCCESS', true],
    ['SKIPPED', true],
    ['NEUTRAL', true],
    ['EXPECTED', false],
    ['ACTION_REQUIRED', false],
    ['STALE', false],
    ['PENDING', false],
    ['QUEUED', false],
    ['IN_PROGRESS', false],
    ['FAILURE', false],
    ['ERROR', false],
    ['CANCELLED', false],
    ['UNKNOWN', false],
  ];
  for (const [state, expected] of optionalCases) {
    assert.equal(allChecksDecision([
      required('SUCCESS'),
      { name: 'optional-docs', state, bucket: state === 'SUCCESS' ? 'pass' : 'pending' },
    ]).allow, expected, `check opzionale ${state}`);
  }
});

test('payload vuoto, non-array o senza required check non autorizza il merge', () => {
  const cases = [
    ['empty', []],
    ['null', null],
    ['object', {}],
    ['required missing', [{ name: 'unrelated', state: 'SUCCESS', bucket: 'pass' }]],
    ['required malformed', [{ name: VITEST_CHECK_NAME }]],
  ];
  for (const [name, payload] of cases) {
    assert.equal(requiredCheckDecision(payload).allow, false, name);
    assert.equal(allChecksDecision(payload).allow, false, 'all checks: ' + name);
  }
});
