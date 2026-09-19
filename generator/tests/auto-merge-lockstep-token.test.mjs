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
  lockstepPullRequestDecision,
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
  assert.match(wf, /gh pr list --repo "\$GH_REPO" --head "\$LOCKSTEP_HEAD_REF" --base main/,
    'senza --head l\'auto-merge prenderebbe qualunque PR aperta del repo');
  assert.match(wf, /LOCKSTEP_HEAD_REF=\$\(node scripts\/ci\/native-automerge-sweep-policy\.mjs --lockstep-head-ref\)/,
    'il nome del branch viene dalla stessa policy che autorizza il candidato, non da un letterale duplicato');
  assert.doesNotMatch(wf, /--head engine-lockstep-auto/);
  assert.match(wf, /--json number,state,baseRefName,headRefName,headRepository/);
  assert.match(wf, /--lockstep-pr "\$PR_CANDIDATES_FILE" "\$GH_REPO"/);
});

test('il lockstep non espone un dispatch manuale da un ref arbitrario', () => {
  assert.doesNotMatch(wf, /^\s*workflow_dispatch:/m,
    'il dispatch manuale potrebbe eseguire una revisione non trusted prima dei gate');
  assert.match(wf, /check_suite:\n\s+types: \[completed\]/,
    'il trigger check_suite deve restare disponibile sul workflow trusted');
  assert.match(wf, /schedule:\n\s+- cron:/,
    'il trigger schedule deve restare disponibile sul workflow trusted');
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
  assert.match(wf, /gh pr checks "\$PR" --repo "\$GH_REPO" --required --json name/);
  assert.doesNotMatch(wf, /gh pr checks "\$PR" --json name,state,bucket/,
    'gli stati non devono provenire da uno snapshot PR non legato alla HEAD');
  assert.match(wf, /gh api --paginate --slurp[\s\S]+commits\/\$\{HEAD_SHA\}\/check-runs\?filter=all&per_page=100/,
    'senza filter=all l\'API rende solo l\'ultima generazione e nasconde quelle da confrontare');
  assert.match(wf, /native-automerge-sweep-policy\.mjs/);
  assert.match(wf, /--required-check-runs "\$CHECK_RUNS_FILE" "\$REQUIRED_NAMES_FILE" "\$HEAD_SHA" "\$GH_REPO"/);
  assert.match(wf, /--all-check-runs "\$CHECK_RUNS_FILE" "\$REQUIRED_NAMES_FILE" "\$HEAD_SHA" "\$GH_REPO"/);
  assert.match(wf, /REQUIRED_NAMES_EXIT=/);
  assert.match(wf, /CHECK_RUNS_EXIT=/);
  assert.match(wf, /--merge --delete-branch=false/);
});

test('il merge è vincolato alla HEAD catturata prima dei check', () => {
  const headCapture = wf.indexOf('HEAD_SHA=$(gh pr view "$PR" --repo "$GH_REPO" --json headRefOid');
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
  const finalMetadata = wf.indexOf('FINAL_PR_FILE=');
  assert.ok(finalMetadata > runs && finalMetadata < merge,
    'la metadata PR deve essere riletta subito prima del merge');
  assert.match(wf, /--json number,state,baseRefName,headRefName,headRepository,headRefOid/);
  assert.match(wf, /--lockstep-pr "\$FINAL_PR_FILE" "\$GH_REPO" "\$PR" "\$HEAD_SHA"/);
});

const LOCKSTEP_REPO = 'nanakokyobashi-rgb/frontaliere-articles';
const LOCKSTEP_HEAD = 'c'.repeat(40);
const validLockstepPr = {
  number: 1597,
  state: 'OPEN',
  baseRefName: 'main',
  headRefName: 'engine-lockstep-auto',
  headRepository: { nameWithOwner: LOCKSTEP_REPO },
  headRefOid: LOCKSTEP_HEAD,
};

test('la selezione lockstep richiede candidato unico, base, ref e repository trusted', () => {
  const cases = [
    ['candidato valido', [validLockstepPr], true],
    ['nessun candidato', [], false],
    ['candidati multipli', [validLockstepPr, { ...validLockstepPr, number: 1598 }], false],
    ['fork', [{ ...validLockstepPr, headRepository: { nameWithOwner: 'fork/frontaliere-articles' } }], false],
    ['base diversa', [{ ...validLockstepPr, baseRefName: 'develop' }], false],
    ['ref diverso', [{ ...validLockstepPr, headRefName: 'engine-lockstep-other' }], false],
    ['repository vuoto', [{ ...validLockstepPr, headRepository: { nameWithOwner: '' } }], false],
    ['base vuota', [{ ...validLockstepPr, baseRefName: '' }], false],
    ['ref vuoto', [{ ...validLockstepPr, headRefName: '' }], false],
    ['stato chiuso', [{ ...validLockstepPr, state: 'CLOSED' }], false],
    ['metadata incompleta', [{ ...validLockstepPr, headRepository: null }], false],
  ];
  for (const [name, payload, expected] of cases) {
    assert.equal(lockstepPullRequestDecision(payload, LOCKSTEP_REPO).allow, expected, name);
  }
  assert.equal(
    lockstepPullRequestDecision(validLockstepPr, LOCKSTEP_REPO).allow,
    false,
    'un oggetto singolo non può mascherare una risposta list malformata',
  );
  assert.equal(
    lockstepPullRequestDecision(validLockstepPr, LOCKSTEP_REPO, '1597', LOCKSTEP_HEAD).allow,
    true,
    'la rilettura finale deve riconfermare numero e HEAD',
  );
  assert.equal(
    lockstepPullRequestDecision(validLockstepPr, LOCKSTEP_REPO, '1597', 'd'.repeat(40)).allow,
    false,
    'la rilettura finale deve negare una HEAD cambiata',
  );
});

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const requiredNames = [{ name: VITEST_CHECK_NAME }, { name: 'generator-ci' }];

function checkRun(
  id,
  name,
  state,
  head = HEAD_A,
  time = `2026-09-19T${String(id % 24).padStart(2, '0')}:00:00Z`,
  options = {},
) {
  const normalized = state.toLowerCase();
  const active = ['queued', 'in_progress', 'requested', 'waiting', 'pending'].includes(normalized);
  const run = {
    id,
    name,
    head_sha: head,
    status: active ? normalized : 'completed',
    conclusion: active ? null : normalized,
    created_at: options.createdAt ?? time,
    started_at: time,
    completed_at: active ? null : options.completedAt ?? time,
  };
  if (options.startedAt !== undefined) run.started_at = options.startedAt;
  if (options.omitCreatedAt) delete run.created_at;
  if (options.runAttempt !== undefined) run.run_attempt = options.runAttempt;
  if (options.apiShape) {
    // Shape observed from /commits/{sha}/check-runs: no generation timestamp
    // or run_attempt, and check_suite contains only its id in this response.
    run.created_at = null;
    delete run.run_attempt;
    run.check_suite = { id: options.checkSuiteId ?? id };
    if (options.omitCheckSuite) delete run.check_suite;
    if (!options.omitDetailsUrl) {
      const detailsRepository = options.detailsRepository ?? LOCKSTEP_REPO;
      const workflowRunId = options.workflowRunId ?? String(35442617310 + id);
      const jobId = options.jobId ?? String(105895961099 + id);
      run.details_url = `https://github.com/${detailsRepository}/actions/runs/${workflowRunId}/job/${jobId}`;
    }
    if (!options.omitExternalId) {
      run.external_id = options.externalId
        ?? `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
    }
  }
  return run;
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

test('la generazione vince sul completamento fuori ordine e sui tie-break', () => {
  const outOfOrder = checkPages(
    // È la generazione PIÙ NUOVA e deve vincere anche se termina prima.
    checkRun(501, VITEST_CHECK_NAME, 'SUCCESS', HEAD_A, '2026-09-19T06:01:00Z', {
      completedAt: '2026-09-19T06:02:00Z',
      runAttempt: 2,
    }),
    // Rerun più vecchio: finisce dopo e non deve sovrascrivere il successo.
    checkRun(500, VITEST_CHECK_NAME, 'FAILURE', HEAD_A, '2026-09-19T06:00:00Z', {
      completedAt: '2026-09-19T06:03:00Z',
      runAttempt: 1,
    }),
  );
  const snapshot = exactCheckRunSnapshot(outOfOrder, HEAD_A);
  assert.equal(snapshot.allow, true);
  assert.equal(snapshot.checks.find((check) => check.name === VITEST_CHECK_NAME)?.state, 'SUCCESS');

  const sameGenerationTime = checkPages(
    checkRun(601, VITEST_CHECK_NAME, 'FAILURE', HEAD_A, '2026-09-19T07:00:00Z', {
      completedAt: '2026-09-19T07:02:00Z', runAttempt: 1,
    }),
    checkRun(602, VITEST_CHECK_NAME, 'SUCCESS', HEAD_A, '2026-09-19T07:00:00Z', {
      completedAt: '2026-09-19T07:01:00Z', runAttempt: 2,
    }),
  );
  assert.equal(
    exactCheckRunSnapshot(sameGenerationTime, HEAD_A).checks
      .find((check) => check.name === VITEST_CHECK_NAME)?.state,
    'SUCCESS',
    'run_attempt deve precedere il tie-break sull id',
  );

  const malformedGeneration = [
    ['timestamp mancante', checkPages(checkRun(603, VITEST_CHECK_NAME, 'SUCCESS', HEAD_A, '2026-09-19T08:00:00Z', {
      omitCreatedAt: true, startedAt: null,
    }))],
    ['run_attempt non numerico', checkPages(checkRun(604, VITEST_CHECK_NAME, 'SUCCESS', HEAD_A, '2026-09-19T08:00:00Z', {
      runAttempt: '2',
    }))],
  ];
  for (const [name, pages] of malformedGeneration) {
    assert.equal(exactCheckRunSnapshot(pages, HEAD_A).allow, false, name);
  }

  const apiShapedOutOfOrder = checkPages(
    // Shape reale: niente created_at/run_attempt top-level. Il queued vecchio
    // ha uno started_at più recente, ma non deve oscurare la generazione nuova;
    // l'id workflow più alto identifica il rerun nuovo anche quando il check-run
    // id è più basso.
    checkRun(799, VITEST_CHECK_NAME, 'IN_PROGRESS', HEAD_A, '2026-09-19T10:30:00Z', {
      apiShape: true, checkSuiteId: 799, workflowRunId: '35442617310',
    }),
    checkRun(701, VITEST_CHECK_NAME, 'SUCCESS', HEAD_A, '2026-09-19T10:01:00Z', {
      apiShape: true, checkSuiteId: 701, workflowRunId: '35442617311',
      completedAt: '2026-09-19T10:02:00Z',
    }),
  );
  assert.equal(apiShapedOutOfOrder[0].check_runs[0].created_at, null);
  assert.deepEqual(apiShapedOutOfOrder[0].check_runs[0].check_suite, { id: 799 });
  const apiSnapshot = exactCheckRunSnapshot(apiShapedOutOfOrder, HEAD_A, LOCKSTEP_REPO);
  assert.equal(apiSnapshot.allow, true, 'la shape reale usa il workflow-run URL per la generazione');
  assert.equal(
    apiSnapshot.checks.find((check) => check.name === VITEST_CHECK_NAME)?.state,
    'SUCCESS',
    'un queued vecchio non deve sovrascrivere il rerun nuovo',
  );
  assert.equal(
    exactCheckRunSnapshot(checkPages(checkRun(703, VITEST_CHECK_NAME, 'SUCCESS', HEAD_A, '2026-09-19T10:00:00Z', {
      omitCreatedAt: true, startedAt: '2026-09-19T10:30:00Z',
    })), HEAD_A).allow,
    false,
    'senza created_at né check_suite la generazione è inconcludente',
  );

  const sameWorkflowRun = checkPages(
    checkRun(801, VITEST_CHECK_NAME, 'FAILURE', HEAD_A, '2026-09-19T10:00:00Z', {
      apiShape: true, workflowRunId: '35442617312',
    }),
    checkRun(802, VITEST_CHECK_NAME, 'SUCCESS', HEAD_A, '2026-09-19T10:01:00Z', {
      apiShape: true, workflowRunId: '35442617312',
    }),
  );
  assert.equal(
    exactCheckRunSnapshot(sameWorkflowRun, HEAD_A, LOCKSTEP_REPO)
      .checks.find((check) => check.name === VITEST_CHECK_NAME)?.state,
    'SUCCESS',
    'nello stesso workflow-run il check-run id è il tie-break',
  );
  const malformedApiShape = [
    ['details URL assente', checkPages(checkRun(804, VITEST_CHECK_NAME, 'SUCCESS', HEAD_A, undefined, {
      apiShape: true, omitDetailsUrl: true,
    }))],
    ['external id assente', checkPages(checkRun(805, VITEST_CHECK_NAME, 'SUCCESS', HEAD_A, undefined, {
      apiShape: true, omitExternalId: true,
    }))],
    ['external id non UUID', checkPages(checkRun(806, VITEST_CHECK_NAME, 'SUCCESS', HEAD_A, undefined, {
      apiShape: true, externalId: 'not-a-workflow-id',
    }))],
    ['check suite assente', checkPages(checkRun(807, VITEST_CHECK_NAME, 'SUCCESS', HEAD_A, undefined, {
      apiShape: true, omitCheckSuite: true,
    }))],
    ['repository details non trusted', checkPages(checkRun(808, VITEST_CHECK_NAME, 'SUCCESS', HEAD_A, undefined, {
      apiShape: true, detailsRepository: 'fork/frontaliere-articles',
    }))],
    ['workflow run id non positivo', checkPages(checkRun(809, VITEST_CHECK_NAME, 'SUCCESS', HEAD_A, undefined, {
      apiShape: true, workflowRunId: '0',
    }))],
    ['job id non numerico', checkPages(checkRun(810, VITEST_CHECK_NAME, 'SUCCESS', HEAD_A, undefined, {
      apiShape: true, jobId: 'not-a-job',
    }))],
  ];
  for (const [name, pages] of malformedApiShape) {
    assert.equal(exactCheckRunSnapshot(pages, HEAD_A, LOCKSTEP_REPO).allow, false, name);
  }
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

test('un payload check-run troncato rispetto a total_count non autorizza', () => {
  const complete = [{
    total_count: 2,
    check_runs: [
      checkRun(901, VITEST_CHECK_NAME, 'SUCCESS', HEAD_A, '2026-09-19T01:00:00Z'),
      checkRun(902, 'generator-ci', 'SUCCESS', HEAD_A, '2026-09-19T01:01:00Z'),
    ],
  }];
  assert.equal(exactCheckRunSnapshot(complete, HEAD_A).allow, true);

  // Una generazione nuova FAILURE persa dalla risposta: resta solo il vecchio
  // SUCCESS, ma total_count dichiara 3 run.
  const truncated = [{ ...complete[0], total_count: 3 }];
  const decision = exactCheckRunSnapshot(truncated, HEAD_A);
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /incompleto: 2 ricevuti su 3/);

  const inconsistent = [
    { total_count: 2, check_runs: [complete[0].check_runs[0]] },
    { total_count: 5, check_runs: [complete[0].check_runs[1]] },
  ];
  assert.equal(exactCheckRunSnapshot(inconsistent, HEAD_A).allow, false);
  assert.equal(exactCheckRunSnapshot([{ total_count: 'x', check_runs: [] }], HEAD_A).allow, false);
});

test('la policy espone il nome del branch lockstep per il workflow', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, [
    resolve(here, '../../scripts/ci/native-automerge-sweep-policy.mjs'), '--lockstep-head-ref',
  ], { encoding: 'utf8' });
  assert.equal(out.trim(), 'engine-lockstep-auto');
});
