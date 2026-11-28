/**
 * canton-generation-admit.mjs — l'ammissione di una sezione cantonale (P8,
 * D15/D16/D19 del piano «sezioni articoli per cantone»).
 * Run with `node --test generator/tests/canton-generation-admit.test.mjs`.
 *
 * Il difetto che questa suite tiene chiuso non produce errori: un cantone che
 * genera quando non deve (flag spento, Remote Config non caricato, budget
 * esaurito, quota sotto pressione) e' una run VERDE che spende quota e scrive
 * su main. Per questo ogni ramo e' eseguito, non cercato nel testo: la
 * decisione e' una funzione pura con le letture iniettate, e la CLI viene
 * lanciata davvero per i marcatori.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUDGET_WINDOW_HOURS,
  CANTON_WORKFLOW_PATH_RE,
  CANTON_GATE_RECEIPT_FILENAME,
  CORE_WORKFLOW_PATH,
  DEFAULT_MAX_PARALLEL,
  ALL_RUN_STATUSES,
  IN_FLIGHT_STATUSES,
  KNOWN_RUN_CONCLUSIONS,
  RUNS_PER_PAGE,
  RC_SENTINEL_ENV,
  articleCommitSubject,
  cadenceSlotHour,
  countSectionArticles,
  decideCantonAdmission,
  effectiveDailyBudget,
  filterInFlightRuns,
  flattenPaginatedInFlightRuns,
  olderCantonRuns,
  parseQuotaBeaconOutput,
  positiveInt,
  projectCantonGateReceipt,
  readInFlightRunsFromGitHub,
  remoteConfigLoaded,
} from '../../scripts/ci/canton-generation-admit.mjs';
import { callerWorkflowFile } from '../../scripts/ci/generate-canton-article-workflows.mjs';
import {
  CANTON_SECTION_DISABLED_MARKER,
  CANTON_SECTIONS_ENABLED_ENV,
  loadCantonSectionProfiles,
} from '../scripts/lib/canton-section-profile.mjs';
import { activeCorpusCoreMap } from '../../scripts/lib/corpus-sections.mjs';
import {
  CANTON_HIGH_CADENCE_ENV,
  HIGH_CADENCE_DAILY_BUDGET,
} from '../scripts/lib/canton-high-cadence.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts/ci/canton-generation-admit.mjs');
const CORE = readFileSync(path.join(ROOT, '.github/workflows/generate-article-core.yml'), 'utf8');

const SECTION = 'canton-ti';
const PROFILES = loadCantonSectionProfiles();
const DISABLED_PROFILES = {
  ...PROFILES,
  cantons: PROFILES.cantons.map((profile) => ({ ...profile, enabled: false })),
};
const DISABLED_SECTION = PROFILES.cantons.find((profile) => profile.enabled !== true)?.section ?? null;
const TI_BUDGET = PROFILES.cantons.find((c) => c.section === SECTION).dailyBudget;

/** Ambiente di un job in cui Remote Config e' arrivato e TI e' acceso. */
const ENV_ON = { [RC_SENTINEL_ENV]: '1', [CANTON_SECTIONS_ENABLED_ENV]: 'TI, GR' };

/** Letture che contano quante volte vengono chiamate. */
function readers({ subjects = [], runs = [], beacon = { active: false, resetsAt: null } } = {}) {
  const calls = { subjects: 0, runs: 0, beacon: 0 };
  return {
    calls,
    readArticleSubjects: () => { calls.subjects += 1; return subjects; },
    readInFlightRuns: () => { calls.runs += 1; return runs; },
    readQuotaBeacon: () => { calls.beacon += 1; return beacon; },
  };
}

function decide(over = {}, r = readers()) {
  return decideCantonAdmission({
    section: SECTION,
    env: ENV_ON,
    eventName: 'schedule',
    activeSections: { [SECTION]: {} },
    selfId: 100,
    ...r,
    ...over,
  });
}

const run = (id, file, createdAt) => ({ id, path: `.github/workflows/${file}`, created_at: createdAt });
const apiRun = (id, file, createdAt, status = 'queued') => ({
  ...run(id, file, createdAt),
  status,
  conclusion: null,
});

// ── 1. Il gate di Remote Config (D16) ────────────────────────────────────────

test('Remote Config non caricato: la sezione resta spenta, senza leggere niente', () => {
  const r = readers();
  assert.equal(RC_SENTINEL_ENV, 'RC_ENV_LOADED');
  // Il loader e' fail-open: esce 0 anche quando non carica. Senza il marker di
  // successo la lista dei cantoni accesi non e' leggibile — nemmeno se la
  // variabile c'e'.
  const v = decide({ env: { [CANTON_SECTIONS_ENABLED_ENV]: 'all' } }, r);
  assert.equal(v.proceed, false);
  assert.equal(v.reason, 'rc-unavailable');
  assert.deepEqual(r.calls, { subjects: 0, runs: 0, beacon: 0 });
  assert.equal(remoteConfigLoaded({ [RC_SENTINEL_ENV]: '   ' }), false, 'una sentinella vuota non prova niente');
  assert.equal(remoteConfigLoaded({ [RC_SENTINEL_ENV]: 'true' }), false, 'solo il marker emesso dal loader prova la lettura');
  assert.equal(remoteConfigLoaded({ [RC_SENTINEL_ENV]: '1' }), true);
});

test('flag assente o vuoto: nessun cantone genera', () => {
  for (const value of [undefined, '', '  ', 'GR, BE']) {
    const r = readers();
    const v = decide({
      env: { [RC_SENTINEL_ENV]: '1', [CANTON_SECTIONS_ENABLED_ENV]: value },
      profiles: DISABLED_PROFILES,
    }, r);
    assert.equal(v.proceed, false, `flag=${JSON.stringify(value)}`);
    assert.equal(v.reason, 'canton-disabled');
    assert.deepEqual(r.calls, { subjects: 0, runs: 0, beacon: 0 }, 'una sezione spenta non costa una chiamata');
  }
});

test('D22 enabled nel profilo non bypassa il gate D16 di Remote Config', () => {
  const r = readers();
  const v = decide({
    env: { [RC_SENTINEL_ENV]: '1', [CANTON_SECTIONS_ENABLED_ENV]: '' },
  }, r);
  assert.equal(v.proceed, false);
  assert.equal(v.reason, 'canton-disabled');
  assert.deepEqual(r.calls, { subjects: 0, runs: 0, beacon: 0 });
});

test('il profilo committato e il core bootstrap condividono l\'insieme dei cantoni accesi', () => {
  const profileSections = PROFILES.cantons.filter((c) => c.enabled === true).map((c) => c.section).sort();
  const coreSections = Object.keys(activeCorpusCoreMap()).filter((section) => section.startsWith('canton-')).sort();
  assert.deepEqual(coreSections, profileSections);
});

test('sezione accesa ma non attiva nel core: non genera', () => {
  // Rebase (--section-surfaces), unicita' dopo il rebase e pubblicazione
  // leggono le sezioni ATTIVE del core: fuori da li' un articolo non sarebbe
  // ne' protetto ne' pubblicato.
  const r = readers();
  const v = decide({ activeSections: { frontaliere: {}, svizzera: {} } }, r);
  assert.equal(v.proceed, false);
  assert.equal(v.reason, 'canton-inactive');
  assert.deepEqual(r.calls, { subjects: 0, runs: 0, beacon: 0 });
});

test('una sezione fuori dall\'insieme attivo non passa nemmeno col flag', () => {
  const v = decideCantonAdmission({
    section: SECTION,
    env: { [RC_SENTINEL_ENV]: '1', [CANTON_SECTIONS_ENABLED_ENV]: 'all' },
    activeSections: { frontaliere: {}, svizzera: {} },
    eventName: 'schedule',
    ...readers(),
  });
  assert.equal(v.proceed, false);
  assert.equal(v.reason, 'canton-inactive');
});

test('rollout pilot: canton-ti passa ma un sibling non nominato resta spento', () => {
  const env = { [RC_SENTINEL_ENV]: '1', [CANTON_SECTIONS_ENABLED_ENV]: 'canton-ti' };
  assert.equal(decide({ env }, readers()).proceed, true);

  const r = readers();
  const sibling = decideCantonAdmission({
    section: 'canton-gr',
    env,
    eventName: 'schedule',
    activeSections: activeCorpusCoreMap(),
    ...r,
  });
  assert.equal(sibling.proceed, false);
  assert.equal(sibling.reason, 'canton-disabled');
  assert.deepEqual(r.calls, { subjects: 0, runs: 0, beacon: 0 });
});

test('una sezione non cantonale e\' un errore d\'uso, non un salto', () => {
  assert.throws(() => decide({ section: 'svizzera' }), /non e' una sezione cantonale/);
});

// ── 2. Il budget giornaliero (D19) ───────────────────────────────────────────

test('budget: conta solo gli articoli della sezione, per subject esatto', () => {
  const subjects = [
    articleCommitSubject(SECTION),
    'Generate blog article (canton-gr)',
    'Generate blog article (frontaliere)',
    `Record rejected topic candidates (${SECTION} — no article generated)`,
    `${articleCommitSubject(SECTION)} extra`,
    `Revert "${articleCommitSubject(SECTION)}"`,
  ];
  assert.equal(countSectionArticles(subjects, SECTION), 1);
  assert.equal(articleCommitSubject(SECTION), 'Generate blog article (canton-ti)');
});

test('budget: a budget raggiunto salta, sotto procede', () => {
  const full = Array.from({ length: TI_BUDGET }, () => articleCommitSubject(SECTION));
  const r = readers({ subjects: full });
  const v = decide({}, r);
  assert.equal(v.proceed, false);
  assert.equal(v.reason, 'daily-budget');
  assert.match(v.detail, new RegExp(`${TI_BUDGET} articoli nelle ultime ${BUDGET_WINDOW_HOURS}h`));
  assert.deepEqual(r.calls, { subjects: 1, runs: 0, beacon: 0 }, 'a budget esaurito non serve guardare altro');

  assert.equal(decide({}, readers({ subjects: full.slice(1) })).proceed, true);
});

test('budget: vars.CANTON_DAILY_BUDGET_CAP abbassa il budget dichiarato, non lo alza', () => {
  const profile = { section: SECTION, dailyBudget: 4 };
  assert.equal(effectiveDailyBudget(profile, ''), 4);
  assert.equal(effectiveDailyBudget(profile, '3'), 3, 'il tetto di rollout riduce il budget dichiarato');
  assert.equal(effectiveDailyBudget(profile, '9'), 4);
  assert.equal(effectiveDailyBudget(profile, 'due'), 4, 'un valore illeggibile non cambia il budget');
  assert.throws(() => effectiveDailyBudget({ section: SECTION }, ''), /dailyBudget non valido/);

  const three = Array.from({ length: 3 }, () => articleCommitSubject(SECTION));
  const v = decide({ env: { ...ENV_ON, CANTON_DAILY_BUDGET_CAP: '3' } }, readers({ subjects: three }));
  assert.equal(v.reason, 'daily-budget');
});

test('budget: commit illeggibili = slot saltato (fail-closed)', () => {
  const r = readers({ subjects: null });
  const v = decide({}, r);
  assert.equal(v.proceed, false);
  assert.equal(v.reason, 'budget-unreadable');
});

// ── 3. Il tetto globale ──────────────────────────────────────────────────────

test('tetto globale: contano solo i chiamanti cantonali piu\' vecchi di questa run', () => {
  const runs = [
    run(100, 'generate-article-ti.yml', '2026-10-05T10:00:10Z'),
    run(90, 'generate-article-gr.yml', '2026-10-05T10:00:00Z'), // piu' vecchia
    run(91, 'generate-article-be.yml', '2026-10-05T10:00:10Z'), // stesso secondo, id minore
    run(101, 'generate-article-zh.yml', '2026-10-05T10:00:10Z'), // stesso secondo, id maggiore
    run(102, 'generate-article-vd.yml', '2026-10-05T10:00:20Z'), // piu' giovane
    run(103, 'generate-article-lu.yml@refs/heads/main', '2026-10-05T09:30:00Z'), // path REST con ref
    run(80, 'generate-article.yml', '2026-10-05T09:00:00Z'), // frontaliere/svizzera: non e' un cantone
    run(81, 'generate-article-core.yml', '2026-10-05T09:00:00Z'), // il riusabile non ha run sue
    run(82, 'generate-article-core.yml@refs/heads/main', '2026-10-05T09:00:00Z'), // anche il path REST del riusabile puo' avere un ref
    run(83, 'publish-api.yml', '2026-10-05T09:00:00Z'),
  ];
  assert.deepEqual(olderCantonRuns(runs, 100), { older: 3, total: 5, selfSeen: true });
  assert.equal(CANTON_WORKFLOW_PATH_RE.test(CORE_WORKFLOW_PATH), true, 'la regex da sola prenderebbe anche il core: va escluso per nome');
  assert.match('.github/workflows/generate-article-ti.yml@refs/heads/main', CANTON_WORKFLOW_PATH_RE);
  for (const c of PROFILES.cantons) {
    assert.match(`.github/workflows/${callerWorkflowFile(c.code)}`, CANTON_WORKFLOW_PATH_RE, c.code);
  }
});

test('le run in coda sono in volo quanto quelle gia\' in esecuzione', () => {
  assert.deepEqual(IN_FLIGHT_STATUSES, [
    'queued',
    'in_progress',
    'requested',
    'waiting',
    'pending',
  ]);

  const self = { ...run(100, 'generate-article-ti.yml', '2026-10-05T10:00:10Z'), status: 'in_progress' };
  const older = IN_FLIGHT_STATUSES.map((status, index) => ({
    ...run(10 + index, `generate-article-${['gr', 'be', 'zh', 'vd', 'ag'][index]}.yml`, '2026-10-05T09:00:00Z'),
    status,
  }));
  const completed = { ...run(999, 'generate-article-lu.yml', '2026-10-05T09:00:00Z'), status: 'completed' };
  const inFlight = filterInFlightRuns([self, ...older, completed]);

  assert.equal(inFlight.length, IN_FLIGHT_STATUSES.length + 1);
  assert.equal(olderCantonRuns(inFlight, 100).older, IN_FLIGHT_STATUSES.length);
  assert.equal(inFlight.some((candidate) => candidate.id === completed.id), false);
});

test('le run in volo uniscono tutte le pagine per stato solo se complete e non ambigue', () => {
  const firstPageRuns = Array.from({ length: 100 }, (_, index) => apiRun(
    100 + index,
    'generate-article-ti.yml',
    '2026-10-05T10:00:10Z',
  ));
  const finalPageRuns = [apiRun(1, 'generate-article-gr.yml', '2026-10-05T09:00:00Z', 'in_progress')];
  const firstPage = {
    total_count: 101,
    workflow_runs: firstPageRuns,
  };
  const secondPage = {
    total_count: 101,
    workflow_runs: finalPageRuns,
  };

  assert.deepEqual(flattenPaginatedInFlightRuns([firstPage, secondPage]), [
    ...firstPageRuns,
    ...finalPageRuns,
  ]);
  assert.deepEqual(flattenPaginatedInFlightRuns([{ total_count: 0, workflow_runs: [] }]), []);
  assert.equal(flattenPaginatedInFlightRuns([]), null, 'nessuna pagina non prova una lista vuota');
  assert.equal(flattenPaginatedInFlightRuns([{ total_count: 1 }]), null);
  assert.equal(flattenPaginatedInFlightRuns(null), null);

  assert.deepEqual(flattenPaginatedInFlightRuns([
    { total_count: 101, workflow_runs: firstPageRuns },
    { total_count: 102, workflow_runs: finalPageRuns },
  ]), [...firstPageRuns, ...finalPageRuns]);
  // Risposta osservata in produzione: 12 indicizzati, 11 restituiti.
  const visibleRuns = firstPageRuns.slice(0, 11);
  assert.deepEqual(flattenPaginatedInFlightRuns([
    { total_count: 12, workflow_runs: visibleRuns },
  ]), visibleRuns);
  assert.equal(flattenPaginatedInFlightRuns([
    { total_count: 2, workflow_runs: [apiRun(1, 'generate-article-ti.yml', '2026-10-05T10:00:10Z')] },
    { total_count: 2, workflow_runs: [apiRun(1, 'generate-article-ti.yml', '2026-10-05T10:00:10Z')] },
  ]), null, 'un id ripetuto puo\' nascondere una run mancante');
  assert.equal(flattenPaginatedInFlightRuns([
    { total_count: 1, workflow_runs: [{ ...apiRun(1, 'generate-article-ti.yml', '2026-10-05T10:00:10Z'), id: 0 }] },
  ]), null, 'una run senza id positivo non puo\' provare completezza');
  assert.equal(flattenPaginatedInFlightRuns([
    { total_count: 1, workflow_runs: [apiRun(1, 'generate-article-ti.yml', '2026/10/05 10:00:10')] },
  ]), null, 'una data parseable ma non ISO 8601 non prova l\'ordine temporale');
  assert.equal(flattenPaginatedInFlightRuns([
    { total_count: 1, workflow_runs: [apiRun(1, 'generate-article-ti.yml', '2026-02-30T10:00:10Z')] },
  ]), null, 'una data ISO con giorno inesistente non e\' valida');
});

test('il lettore GitHub delle run cantonali pagina e appiattisce il payload completo', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  const start = source.indexOf('function readInFlightRunsFromGitHub');
  const end = source.indexOf('\nfunction readQuotaBeaconFromScript', start);
  assert.ok(start >= 0 && end > start, 'lettore delle run non trovato');
  const reader = source.slice(start, end);
  assert.match(reader, /readGh\(\['api', '--paginate', '--slurp',/);
  assert.match(reader, /flattenPaginatedInFlightRuns\(JSON\.parse\(raw\),/);
});

const admissionPage = (...runs) => ({ total_count: runs.length, workflow_runs: runs });
const firstSnapshotRun = apiRun(41, 'generate-article-ti.yml', '2026-10-05T10:00:10Z');
const repeatSnapshotRun = apiRun(42, 'generate-article-nw.yml', '2026-10-05T10:00:20Z');
const ambiguousSnapshot = JSON.stringify([admissionPage(firstSnapshotRun), admissionPage(firstSnapshotRun)]);
const cleanSnapshot = JSON.stringify([admissionPage(repeatSnapshotRun)]);
const emptySnapshot = JSON.stringify([admissionPage()]);
const [firstStatus, secondStatus, thirdStatus] = IN_FLIGHT_STATUSES;

function readAdmissionSnapshots(requests, expectedRows, retriedStatuses = []) {
  const repo = 'owner/corpus';
  const calls = [];
  const warnings = [];
  const rows = readInFlightRunsFromGitHub(repo, {
    readGh: (args) => {
      const response = requests[calls.length]?.[1];
      calls.push(args);
      if (response instanceof Error) throw response;
      return response;
    },
    warn: (warning) => warnings.push(warning),
  });
  assert.deepEqual(calls, requests.map(([status]) => [
    'api', '--paginate', '--slurp',
    `repos/${repo}/actions/runs?status=${status}&per_page=${RUNS_PER_PAGE}`,
  ]));
  assert.deepEqual(rows, expectedRows);
  assert.deepEqual(warnings, retriedStatuses.map((status) =>
    `::warning::canton-admit: duplicate run ID, retrying status=${status}`));
}

test('il lettore scarta tutte le pagine ambigue e conserva la deduplicazione fra stati', () => {
  const laterStatusSnapshot = JSON.stringify([admissionPage({ ...repeatSnapshotRun, status: 'in_progress' })]);
  readAdmissionSnapshots([
    [firstStatus, emptySnapshot],
    [secondStatus, ambiguousSnapshot],
    [secondStatus, cleanSnapshot],
    [thirdStatus, laterStatusSnapshot],
    ...IN_FLIGHT_STATUSES.slice(3).map((status) => [status, emptySnapshot]),
  ], [repeatSnapshotRun], [secondStatus]);
});

test('il lettore riprova due volte una paginazione ambigua e poi chiude l’ammissione', () => {
  readAdmissionSnapshots([
    [firstStatus, ambiguousSnapshot],
    [firstStatus, ambiguousSnapshot],
    [firstStatus, ambiguousSnapshot],
  ], null, [firstStatus, firstStatus]);
});

test('il lettore chiude l’ammissione se un retry termina con errore', () => {
  for (const response of ['invalid JSON', JSON.stringify([{ total_count: 1 }]), null, new Error('transport failed')]) {
    readAdmissionSnapshots([
      [firstStatus, ambiguousSnapshot],
      [firstStatus, response],
    ], null, [firstStatus]);
  }
});

test('il lettore non riprova dopo un errore di parsing, schema o trasporto', () => {
  for (const response of ['invalid JSON', JSON.stringify([{ total_count: 1 }]), null, new Error('transport failed')]) {
    readAdmissionSnapshots([[firstStatus, response]], null);
  }
});

test('il lettore consuma al massimo due retry aggiuntivi fra tutti gli stati', () => {
  readAdmissionSnapshots([
    [firstStatus, ambiguousSnapshot],
    [firstStatus, cleanSnapshot],
    [secondStatus, ambiguousSnapshot],
    [secondStatus, cleanSnapshot],
    [thirdStatus, emptySnapshot],
    ...IN_FLIGHT_STATUSES.slice(3).map((status) => [status, emptySnapshot]),
  ], [repeatSnapshotRun], [firstStatus, secondStatus]);
});

test('il lettore puo usare entrambi i retry sullo stesso stato prima di fallire chiuso', () => {
  readAdmissionSnapshots([
    [firstStatus, ambiguousSnapshot],
    [firstStatus, ambiguousSnapshot],
    [firstStatus, cleanSnapshot],
    ...IN_FLIGHT_STATUSES.slice(1).map((status) => [status, emptySnapshot]),
  ], [repeatSnapshotRun], [firstStatus, firstStatus]);
});

test('il gate e il core condividono stati, conclusioni e dimensione pagina', () => {
  const inFlight = CORE.match(/IN_FLIGHT_STATUSES='(\[[^\n]+\])'/u);
  const statuses = CORE.match(/ALL_RUN_STATUSES='(\[[^\n]+\])'/u);
  const conclusions = CORE.match(/KNOWN_RUN_CONCLUSIONS='(\[[^\n]+\])'/u);
  const pageSize = CORE.match(/actions\/workflows\/\$CALLER_WORKFLOW\/runs\?per_page=(\d+)&created=/u);
  assert.ok(inFlight && statuses && conclusions && pageSize,
    'il core deve dichiarare stati, conclusioni e dimensione pagina in un solo punto testabile');
  assert.deepEqual(JSON.parse(inFlight[1]), [...IN_FLIGHT_STATUSES]);
  assert.deepEqual(JSON.parse(statuses[1]), [...ALL_RUN_STATUSES]);
  assert.deepEqual(JSON.parse(conclusions[1]), [...KNOWN_RUN_CONCLUSIONS]);
  assert.equal(Number(pageSize[1]), RUNS_PER_PAGE);
});

test('tetto globale: due arrivi simultanei non si fermano a vicenda', () => {
  const a = run(100, 'generate-article-ti.yml', '2026-10-05T10:00:10Z');
  const b = run(101, 'generate-article-gr.yml', '2026-10-05T10:00:10Z');
  assert.equal(olderCantonRuns([a, b], 100).older, 0);
  assert.equal(olderCantonRuns([a, b], 101).older, 1);
});

test('tetto globale: default 8, configurabile, fail-closed se illeggibile', () => {
  assert.equal(DEFAULT_MAX_PARALLEL, 8);
  assert.equal(positiveInt('', 3), 3);
  assert.equal(positiveInt('0', 3), 3);
  assert.equal(positiveInt('5', 3), 5);
  assert.equal(positiveInt('-1', 3), 3);

  const self = run(100, 'generate-article-ti.yml', '2026-10-05T10:00:10Z');
  const older = (n) => Array.from({ length: n }, (_, i) => {
    const section = PROFILES.cantons[i].section.replace(/^canton-/, '');
    return run(10 + i, `generate-article-${section}.yml`, '2026-10-05T09:00:00Z');
  });

  assert.equal(decide({}, readers({ runs: [self, ...older(7)] })).proceed, true);
  const capped = decide({}, readers({ runs: [self, ...older(8)] }));
  assert.equal(capped.proceed, false);
  assert.equal(capped.reason, 'parallel-cap');
  assert.equal(decide({ env: { ...ENV_ON, CANTON_GENERATION_MAX_PARALLEL: '9' } }, readers({ runs: [self, ...older(8)] })).proceed, true);
  assert.equal(decide({ env: { ...ENV_ON, CANTON_GENERATION_MAX_PARALLEL: '1' } }, readers({ runs: [self, ...older(1)] })).reason, 'parallel-cap');

  assert.equal(decide({}, readers({ runs: null })).reason, 'parallel-unreadable');
  // Questa run fuori dall'elenco: non c'e' un istante con cui confrontare, contano tutte.
  assert.deepEqual(olderCantonRuns(older(8), 100), { older: 8, total: 8, selfSeen: false });
});

// ── 4. Il beacon di quota ────────────────────────────────────────────────────

test('beacon attivo: il cantone cede, ed e\' l\'ultima domanda', () => {
  const r = readers({ beacon: { active: true, resetsAt: 1_800_000_000 } });
  const v = decide({}, r);
  assert.equal(v.proceed, false);
  assert.equal(v.reason, 'quota-beacon');
  assert.deepEqual(r.calls, { subjects: 1, runs: 1, beacon: 1 });
});

test('l\'output di check-quota-backoff.mjs si legge per resets_at, non per quota_blocked', () => {
  // Con CODEX_FALLBACK_MODE=1 un beacon attivo esce `quota_blocked=false`
  // (per il fixer Codex e' telemetria): per i cantoni e' comunque un «cedi».
  const active = parseQuotaBeaconOutput('quota_blocked=false\ncodex_fallback=true\nresets_at=2000\n', 1000);
  assert.deepEqual(active, { active: true, resetsAt: 2000 });
  assert.deepEqual(parseQuotaBeaconOutput('quota_blocked=false\ncodex_fallback=false\nresets_at=\n', 1000), { active: false, resetsAt: null });
  assert.equal(parseQuotaBeaconOutput('resets_at=500\n', 1000).active, false, 'una finestra gia\' chiusa non blocca');
  assert.equal(parseQuotaBeaconOutput('', 1000).active, false);
});

// ── Ammissione e dispatch manuale ────────────────────────────────────────────

test('tutto in ordine: ammessa, dopo aver fatto tutte e tre le letture', () => {
  const r = readers();
  const v = decide({}, r);
  assert.equal(v.proceed, true);
  assert.equal(v.reason, 'admitted');
  assert.deepEqual(r.calls, { subjects: 1, runs: 1, beacon: 1 });
});

test('un dispatch manuale salta budget, tetto e beacon — mai il flag', () => {
  const full = Array.from({ length: TI_BUDGET }, () => articleCommitSubject(SECTION));
  const r = readers({ subjects: full, beacon: { active: true, resetsAt: 1 } });
  const v = decide({ eventName: 'workflow_dispatch' }, r);
  assert.equal(v.proceed, true);
  assert.equal(v.reason, 'manual-dispatch');
  assert.deepEqual(r.calls, { subjects: 0, runs: 0, beacon: 0 });

  const off = decide({ eventName: 'workflow_dispatch', env: { [RC_SENTINEL_ENV]: '1' }, profiles: DISABLED_PROFILES });
  assert.equal(off.proceed, false);
  assert.equal(off.reason, 'canton-disabled');
});

test('un dispatch Cloud Scheduler rispetta budget e beacon del cantone', () => {
  const scheduled = { eventName: 'workflow_dispatch', dispatchOrigin: 'cloud_scheduler' };
  const subjects = Array.from({ length: TI_BUDGET }, () => articleCommitSubject(SECTION));
  assert.equal(decide(scheduled, readers({ subjects })).reason, 'daily-budget');
  assert.equal(decide(scheduled, readers({ beacon: { active: true, resetsAt: 1 } })).reason, 'quota-beacon');
  const healthy = readers();
  assert.equal(decide(scheduled, healthy).reason, 'admitted');
  assert.deepEqual(healthy.calls, { subjects: 1, runs: 1, beacon: 1 });
});

// ── La CLI: marcatori e output ───────────────────────────────────────────────

test('la ricevuta espone solo lo stato del gate cantonale', () => {
  for (const rcLoaded of [false, true]) {
    for (const profileEnabled of [false, true]) {
      for (const allowlist of [undefined, '', 'GR', 'gR;\u00a0CANTON-TI, sconosciuto']) {
        const profiles = profileEnabled ? PROFILES : DISABLED_PROFILES;
        const env = {
          [RC_SENTINEL_ENV]: rcLoaded ? '1' : undefined,
          [CANTON_SECTIONS_ENABLED_ENV]: allowlist,
        };
        const allowed = allowlist?.includes('CANTON-TI') === true;
        const gateEnabled = rcLoaded && profileEnabled && allowed;
        const verdict = decide({ env, profiles, eventName: 'workflow_dispatch' });
        assert.equal(verdict.proceed, gateEnabled);
        assert.deepEqual(projectCantonGateReceipt({ section: SECTION, runAttempt: '2', env, profiles }), {
          schemaVersion: 1,
          section: SECTION,
          runAttempt: 2,
          rcLoaded,
          profileEnabled,
          rcAllowsSection: rcLoaded ? allowed : null,
          gateEnabled,
        });
      }
    }
  }
  assert.equal(decide({}, readers({ beacon: { active: true } })).reason, 'quota-beacon');
  assert.equal(projectCantonGateReceipt({
    section: SECTION, runAttempt: 1, env: ENV_ON, profiles: PROFILES,
  }).gateEnabled, true);
});

test('la ricevuta richiede una sezione canonica e un tentativo intero positivo', () => {
  for (const section of ['frontaliere', 'canton-xx', 'CANTON-TI', [SECTION]]) {
    assert.equal(projectCantonGateReceipt({ section, runAttempt: 1 }), null);
  }
  for (const runAttempt of [undefined, '', 0, -1, '1.5', '2e1', '9007199254740992', [1]]) {
    assert.equal(projectCantonGateReceipt({ section: SECTION, runAttempt }), null);
  }
});

function runCli(env, { receipt = false, blocked = false, wrongPath = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'canton-admit-'));
  const out = path.join(dir, 'output');
  writeFileSync(out, '');
  const receiptPath = path.join(dir, CANTON_GATE_RECEIPT_FILENAME);
  const configuredPath = wrongPath ? path.join(dir, 'other.json') : receiptPath;
  if (blocked) mkdirSync(receiptPath);
  try {
    const clean = { PATH: process.env.PATH, HOME: dir, GITHUB_OUTPUT: out, ...env };
    if (receipt) Object.assign(clean, {
      RUNNER_TEMP: dir, CANTON_GATE_RECEIPT_PATH: configuredPath, GITHUB_RUN_ATTEMPT: '2',
    });
    const res = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: clean });
    return {
      status: res.status, stdout: res.stdout, stderr: res.stderr, output: readFileSync(out, 'utf8'),
      receipt: !blocked && existsSync(configuredPath) ? JSON.parse(readFileSync(configuredPath, 'utf8')) : null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('CLI: senza Remote Config esce 0 con il marcatore e proceed=false', () => {
  const res = runCli({ SECTION });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /GENERATION_OUTCOME kind=skipped reason=rc-unavailable section=canton-ti/);
  assert.match(res.output, /^proceed=false$/m);
  assert.match(res.output, /^reason=rc-unavailable$/m);
});

test('CLI: sezione spenta esce 0 con lo stesso marcatore di create-article.mjs', (t) => {
  if (!DISABLED_SECTION) {
    t.skip('il profilo di test non contiene una sezione spenta');
    return;
  }
  const res = runCli({ SECTION: DISABLED_SECTION, [RC_SENTINEL_ENV]: '1' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, new RegExp(`^${CANTON_SECTION_DISABLED_MARKER} section=${DISABLED_SECTION}$`, 'm'));
  assert.match(res.stdout, new RegExp(`GENERATION_OUTCOME kind=skipped reason=canton-disabled section=${DISABLED_SECTION}`));
  assert.match(res.output, /^proceed=false$/m);
});

test('CLI: una sezione non cantonale esce 2 e non scrive proceed', () => {
  const res = runCli({ SECTION: 'frontaliere', [RC_SENTINEL_ENV]: 'pat' }, { receipt: true });
  assert.equal(res.status, 2);
  assert.equal(res.output, '');
  assert.equal(res.receipt, null);
});

test('CLI: anche la decisione disabilitata produce una ricevuta facoltativa', () => {
  const env = { SECTION, [RC_SENTINEL_ENV]: '1' };
  const normal = runCli(env);
  assert.equal(normal.output, 'proceed=false\nreason=canton-disabled\n');
  const observed = runCli(env, { receipt: true });
  assert.deepEqual(observed, {
    ...normal,
    receipt: {
      schemaVersion: 1, section: SECTION, runAttempt: 2, rcLoaded: true,
      profileEnabled: true, rcAllowsSection: false, gateEnabled: false,
    },
  });
  assert.deepEqual(runCli(env, { receipt: true, blocked: true }), normal);
  assert.deepEqual(runCli(env, { receipt: true, wrongPath: true }), normal);
});

// ── Il legame col workflow ───────────────────────────────────────────────────

/** Il blocco di un job del core, dalla sua riga a quella del job successivo. */
function jobBlock(name) {
  const start = CORE.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `job ${name} non trovato nel core`);
  const rest = CORE.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z_]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

test('il gate gira DOPO load-rc-env e PRIMA che il job generate esista', () => {
  const gate = jobBlock('section_gate');
  const load = gate.indexOf('run: node generator/scripts/load-rc-env.mjs');
  const admit = gate.indexOf('run: node scripts/ci/canton-generation-admit.mjs');
  assert.ok(load !== -1 && admit !== -1, 'gli step del gate sono spariti');
  assert.ok(load < admit, 'il flag si legge da Remote Config: il loader deve precedere il gate');
  assert.doesNotMatch(gate, /npm-ci-retry|npm ci\b|create-article\.mjs|setup-claude-haiku-fallback/, 'il gate non installa dipendenze e non tocca il generatore');
  assert.doesNotMatch(gate, /\n {4}concurrency:/, 'il gate non deve entrare nella coda del writer e sfrattare un successore');

  const gen = jobBlock('generate');
  assert.match(gen, /\n {4}needs: \[admit, section_gate\]\n/);
  assert.match(gen, /\n {4}if: needs\.admit\.outputs\.proceed == 'true' && needs\.section_gate\.outputs\.proceed == 'true'\n/);
  assert.match(
    gen,
    /\n {4}concurrency:\n {6}group: \$\{\{ \(needs\.admit\.outputs\.run_mode == 'production' \|\| needs\.admit\.outputs\.run_mode == 'unknown'\) && format\('\{0\}-production', inputs\.concurrency_group\) \|\| format\('\{0\}-dry', inputs\.concurrency_group\) \}\}\n {6}queue: max\n {6}cancel-in-progress: false\n/,
    'il job writer usa un gruppo per sezione e lascia il dry separato',
  );
  assert.match(gate, /proceed: \$\{\{ inputs\.dispatch_origin != 'cloud_scheduler' && \(steps\.none\.outputs\.proceed \|\| steps\.canton\.outputs\.proceed\) \|\| steps\.claim\.outputs\.proceed \}\}/);
});

test('il gate legge il token del runner, non un PAT interpolato dal contesto env', () => {
  const gate = jobBlock('section_gate');
  assert.match(gate, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(gate, /\n {6}actions: read\n/, 'senza actions: read le run in volo non si leggono');
  assert.match(gate, /CANTON_GENERATION_MAX_PARALLEL: \$\{\{ vars\.CANTON_GENERATION_MAX_PARALLEL \}\}/);
  assert.match(gate, /CANTON_DAILY_BUDGET_CAP: \$\{\{ vars\.CANTON_DAILY_BUDGET_CAP \}\}/);
});

test('il gate carica solo la ricevuta cantonale subito dopo l’ammissione', () => {
  const gate = jobBlock('section_gate');
  const receiptPath = '${{ runner.temp }}/' + CANTON_GATE_RECEIPT_FILENAME;
  assert.ok(gate.includes([
    `          CANTON_GATE_RECEIPT_PATH: ${receiptPath}`,
    '        run: node scripts/ci/canton-generation-admit.mjs',
    '',
    '      - name: Upload canton section gate receipt',
    "        if: steps.canton.outcome == 'success'",
    '        continue-on-error: true',
    '        uses: actions/upload-artifact@v7',
    '        with:',
    '          name: canton-section-gate-${{ github.run_id }}-${{ github.run_attempt }}',
    `          path: ${receiptPath}`,
    '          retention-days: 3',
    '          if-no-files-found: ignore',
    '',
  ].join('\n')));
  assert.match(gate, /id: canton\n +if: inputs\.section_gate == 'canton'/);
});

/** Chiusura degli import relativi (statici e dinamici) a partire da un file. */
function importClosure(entry, seen = new Set()) {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  // Senza le righe di commento: i docblock citano import d'esempio.
  const src = readFileSync(path.join(ROOT, entry), 'utf8')
    .split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
  for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|^import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm)) {
    importClosure(path.posix.normalize(path.posix.join(path.posix.dirname(entry), m[1])), seen);
  }
  return seen;
}

test('lo sparse checkout del gate copre tutto cio\' che i suoi script importano', () => {
  const gate = jobBlock('section_gate');
  const sparse = /sparse-checkout: \|\n((?: {12}\S+\n)+)/.exec(gate);
  assert.ok(sparse, 'sparse-checkout non trovato nel gate');
  const dirs = sparse[1].split('\n').map((l) => l.trim()).filter(Boolean);
  const files = new Set();
  for (const entry of ['generator/scripts/load-rc-env.mjs', 'scripts/ci/canton-generation-admit.mjs', 'scripts/ci/check-quota-backoff.mjs']) {
    importClosure(entry, files);
  }
  // I dati letti a runtime dal profilo cantonale.
  files.add('generator/data/canton-sections.json');
  const uncovered = [...files].filter((f) => !dirs.some((d) => f.startsWith(`${d}/`)));
  assert.deepEqual(uncovered, [], `file fuori dallo sparse checkout (${dirs.join(', ')}): il gate morirebbe su un import`);
  assert.ok(files.size > 5, 'la chiusura degli import e\' sospettosamente piccola');
});


// ── F3.A: manopola CANTON_HIGH_CADENCE_SECTIONS, budget 24, admit-cadence ────

/**
 * Il calendario di PRIMA della manopola (generator/data/canton-generation-slots.json
 * su origin/main 1ed71abd6d, cadenceHours 6): le ore UTC dei 4 slot al giorno
 * di ogni cantone. E' la verita' di «oggi» contro cui si prova la lista vuota.
 */
const LEGACY_SLOT_HOURS = {
  'canton-ag': [0, 6, 12, 18], 'canton-appenzello': [0, 6, 12, 18], 'canton-basilea': [0, 6, 12, 18], 'canton-be': [0, 6, 12, 18],
  'canton-fr': [1, 7, 13, 19], 'canton-ge': [1, 7, 13, 19], 'canton-gl': [1, 7, 13, 19], 'canton-gr': [1, 7, 13, 19],
  'canton-ju': [2, 8, 14, 20], 'canton-lu': [2, 8, 14, 20], 'canton-ne': [2, 8, 14, 20], 'canton-nw': [2, 8, 14, 20],
  'canton-ow': [3, 9, 15, 21], 'canton-sg': [3, 9, 15, 21], 'canton-sh': [3, 9, 15, 21], 'canton-so': [3, 9, 15, 21],
  'canton-sz': [4, 10, 16, 22], 'canton-tg': [4, 10, 16, 22], 'canton-ti': [4, 10, 16, 22], 'canton-ur': [4, 10, 16, 22],
  'canton-vd': [5, 11, 17, 23], 'canton-vs': [5, 11, 17, 23], 'canton-zg': [5, 11, 17, 23], 'canton-zh': [5, 11, 17, 23],
};

const slotKey = (section, hour, minute = 19) => `generate-article/${section}/2026-11-28T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}Z`;
const envAll = (extra = {}) => ({ [RC_SENTINEL_ENV]: '1', [CANTON_SECTIONS_ENABLED_ENV]: 'all', ...extra });
const allActive = Object.fromEntries(PROFILES.cantons.map((c) => [c.section, {}]));

test('lista vuota = oggi: per tutti i 24 cantoni e tutte le 24 ore gli slot ammessi sono quelli del calendario di prima, slot per slot', () => {
  assert.deepEqual(Object.keys(LEGACY_SLOT_HOURS).sort(), PROFILES.cantons.map((c) => c.section).sort());
  let admitted = 0;
  let skipped = 0;
  for (const { section } of PROFILES.cantons) {
    for (const listValue of [undefined, '', '   ']) {
      for (let hour = 0; hour < 24; hour += 1) {
        const r = readers();
        const v = decideCantonAdmission({
          section,
          env: envAll(listValue === undefined ? {} : { [CANTON_HIGH_CADENCE_ENV]: listValue }),
          eventName: 'workflow_dispatch',
          dispatchOrigin: 'cloud_scheduler',
          activeSections: allActive,
          selfId: 100,
          slotHour: cadenceSlotHour({ DISPATCH_ORIGIN: 'cloud_scheduler', RECOVERY_SLOT: slotKey(section, hour) }),
          ...r,
        });
        const today = LEGACY_SLOT_HOURS[section].includes(hour);
        assert.equal(v.proceed, today, `${section} ${hour}:xx (${v.reason})`);
        if (today) {
          assert.equal(v.reason, 'admitted', `${section} ${hour}`);
          admitted += 1;
        } else {
          assert.equal(v.reason, 'admit-cadence', `${section} ${hour}`);
          assert.equal(v.consumeSlot, true);
          assert.deepEqual(r.calls, { subjects: 0, runs: 0, beacon: 0 }, 'il salto precede ogni lettura GitHub e ogni chiamata a un modello');
          skipped += 1;
        }
      }
    }
  }
  assert.equal(admitted, 24 * 4 * 3);
  assert.equal(skipped, 24 * 20 * 3);
});

test('admit-cadence: una sezione in lista ammette ogni slot orario, le altre no', () => {
  for (let hour = 0; hour < 24; hour += 1) {
    const decision = (list) => decideCantonAdmission({
      section: SECTION,
      env: envAll({ [CANTON_HIGH_CADENCE_ENV]: list }),
      eventName: 'workflow_dispatch',
      dispatchOrigin: 'cloud_scheduler',
      activeSections: allActive,
      slotHour: hour,
      ...readers(),
    });
    for (const list of ['canton-ti', 'TI', 'canton-gr, canton-ti', 'all']) {
      const v = decision(list);
      assert.equal(v.proceed, true, `${list} ${hour}`);
      assert.equal(v.reason, 'admitted');
    }
    // Una sezione che non e' in lista resta sulla cadenza di base, anche se ne sono in lista altre.
    assert.equal(decision('canton-gr').proceed, LEGACY_SLOT_HOURS[SECTION].includes(hour), `fuori lista ${hour}`);
  }
});

test('admit-cadence vale solo per gli slot: dispatch manuale, anelli e push non hanno un\'ora di calendario', () => {
  assert.equal(cadenceSlotHour({ DISPATCH_ORIGIN: 'manual', EVENT_NAME: 'workflow_dispatch' }), null);
  assert.equal(cadenceSlotHour({ DISPATCH_ORIGIN: 'chain', EVENT_NAME: 'workflow_dispatch', RECOVERY_SLOT: slotKey(SECTION, 3) }), null);
  assert.equal(cadenceSlotHour({ EVENT_NAME: 'push' }), null);
  assert.equal(cadenceSlotHour({ DISPATCH_ORIGIN: 'cloud_scheduler', RECOVERY_SLOT: 'non-uno-slot' }), null);
  assert.equal(cadenceSlotHour({ DISPATCH_ORIGIN: 'cloud_scheduler', RECOVERY_SLOT: slotKey(SECTION, 22, 7) }), 22);
  assert.equal(cadenceSlotHour({ EVENT_NAME: 'schedule' }, new Date('2026-11-28T17:30:00Z')), 17);
  // Un anello (origine chain, nessuna ora di slot) di una sezione fuori lista non e' mai saltato per cadenza.
  const v = decide({ env: envAll(), eventName: 'workflow_dispatch', dispatchOrigin: 'chain', slotHour: null }, readers());
  assert.equal(v.proceed, true);
  assert.equal(v.reason, 'admitted');
});

test('budget: 24 per le sezioni in lista, 4 per le altre, con vars.CANTON_DAILY_BUDGET_CAP come tetto inferiore', () => {
  assert.equal(HIGH_CADENCE_DAILY_BUDGET, 24);
  const profile = { section: SECTION, dailyBudget: 4 };
  assert.equal(effectiveDailyBudget(profile, ''), 4);
  assert.equal(effectiveDailyBudget(profile, '', { highCadence: true }), 24);
  assert.equal(effectiveDailyBudget(profile, '10', { highCadence: true }), 10, 'il tetto resta un limite inferiore');
  assert.equal(effectiveDailyBudget(profile, '99', { highCadence: true }), 24, 'un tetto piu\' alto non alza il budget');
  assert.equal(effectiveDailyBudget(profile, '3'), 3);

  const subjects = (n) => Array.from({ length: n }, () => articleCommitSubject(SECTION));
  const inList = { ...ENV_ON, [CANTON_HIGH_CADENCE_ENV]: 'canton-ti' };
  assert.equal(decide({ env: inList }, readers({ subjects: subjects(23) })).proceed, true);
  const full = decide({ env: inList }, readers({ subjects: subjects(24) }));
  assert.equal(full.proceed, false);
  assert.equal(full.reason, 'daily-budget', 'la catena si ferma da sola al budget');
  assert.match(full.detail, /24 articoli nelle ultime 24h su un budget di 24/);
  // Fuori lista restano 4, e 4 articoli bastano a chiudere il giorno.
  assert.equal(decide({}, readers({ subjects: subjects(4) })).reason, 'daily-budget');
  const capped = decide({ env: { ...inList, CANTON_DAILY_BUDGET_CAP: '10' } }, readers({ subjects: subjects(10) }));
  assert.equal(capped.reason, 'daily-budget');
  assert.match(capped.detail, /su un budget di 10/);
});

test('CLI: admit-cadence esce 0, scrive consume_slot=true e il marcatore, senza leggere GitHub', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'canton-admit-cadence-'));
  try {
    const out = path.join(dir, 'output');
    writeFileSync(out, '');
    const res = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH, HOME: dir, GITHUB_OUTPUT: out,
        SECTION, EVENT_NAME: 'workflow_dispatch', DISPATCH_ORIGIN: 'cloud_scheduler',
        RECOVERY_SLOT: slotKey(SECTION, 5), SELF_ID: '1',
        [RC_SENTINEL_ENV]: '1', [CANTON_SECTIONS_ENABLED_ENV]: 'TI',
      },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(readFileSync(out, 'utf8'), /^proceed=false\nreason=admit-cadence\nconsume_slot=true\n$/);
    assert.match(res.stdout, new RegExp(`GENERATION_OUTCOME kind=skipped reason=admit-cadence section=${SECTION}`));
    assert.doesNotMatch(res.stderr, /gh api|canton-admit: gh/);

    // Con la sezione in lista lo stesso slot va avanti (qui si ferma sul GitHub non raggiungibile: fail-closed).
    writeFileSync(out, '');
    const inList = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: {
        PATH: '/nonexistent', HOME: dir, GITHUB_OUTPUT: out,
        SECTION, EVENT_NAME: 'workflow_dispatch', DISPATCH_ORIGIN: 'cloud_scheduler',
        RECOVERY_SLOT: slotKey(SECTION, 5), SELF_ID: '1',
        [RC_SENTINEL_ENV]: '1', [CANTON_SECTIONS_ENABLED_ENV]: 'TI', [CANTON_HIGH_CADENCE_ENV]: 'TI',
      },
    });
    assert.equal(inList.status, 0, inList.stderr);
    assert.doesNotMatch(readFileSync(out, 'utf8'), /admit-cadence|consume_slot/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('section_gate: lo slot fuori cadenza viene consumato nel registro senza aprire il job generate', () => {
  const gate = jobBlock('section_gate');
  assert.match(gate, /RECOVERY_SLOT: \$\{\{ inputs\.recovery_slot \}\}\n {10}QUOTA_BEACON_PEER_REPO/, 'admit legge l\'ora dello slot');
  assert.match(gate, /id: claim\n {8}if: inputs\.dispatch_origin == 'cloud_scheduler' && \(steps\.canton\.outputs\.proceed == 'true' \|\| steps\.canton\.outputs\.consume_slot == 'true'\)/);
  assert.match(gate, /CONSUME_SLOT: \$\{\{ steps\.canton\.outputs\.consume_slot \}\}/);
  // Dopo la conferma, uno slot consumato esce proceed=false: il job generate non parte.
  assert.match(gate, /if \[ "\$CONSUME_SLOT" = 'true' \]; then\n[^\n]*\n {14}echo 'proceed=false' >> "\$GITHUB_OUTPUT"\n {12}else\n[^\n]*\n {14}echo 'proceed=true' >> "\$GITHUB_OUTPUT"/);
});
