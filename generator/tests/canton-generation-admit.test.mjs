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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUDGET_WINDOW_HOURS,
  CANTON_WORKFLOW_PATH_RE,
  CORE_WORKFLOW_PATH,
  DEFAULT_MAX_PARALLEL,
  RC_SENTINEL_ENV,
  articleCommitSubject,
  countSectionArticles,
  decideCantonAdmission,
  effectiveDailyBudget,
  olderCantonRuns,
  parseQuotaBeaconOutput,
  positiveInt,
  remoteConfigLoaded,
} from '../../scripts/ci/canton-generation-admit.mjs';
import { callerWorkflowFile } from '../../scripts/ci/generate-canton-article-workflows.mjs';
import {
  CANTON_SECTION_DISABLED_MARKER,
  CANTON_SECTIONS_ENABLED_ENV,
  loadCantonSectionProfiles,
} from '../scripts/lib/canton-section-profile.mjs';
import { activeCorpusCoreMap } from '../../scripts/lib/corpus-sections.mjs';

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
const ENV_ON = { [RC_SENTINEL_ENV]: 'pat', [CANTON_SECTIONS_ENABLED_ENV]: 'TI, GR' };

/** Letture che contano quante volte vengono chiamate. */
function readers({ subjects = [], runs = [], beacon = { active: false, resetsAt: null } } = {}) {
  const calls = { subjects: 0, runs: 0, beacon: 0 };
  return {
    calls,
    readArticleSubjects: () => { calls.subjects += 1; return subjects; },
    readInProgressRuns: () => { calls.runs += 1; return runs; },
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

// ── 1. Il gate di Remote Config (D16) ────────────────────────────────────────

test('Remote Config non caricato: la sezione resta spenta, senza leggere niente', () => {
  const r = readers();
  // Il loader e' fail-open: esce 0 anche quando non carica. Senza la sentinella
  // la lista dei cantoni accesi non e' leggibile — nemmeno se la variabile c'e'.
  const v = decide({ env: { [CANTON_SECTIONS_ENABLED_ENV]: 'all' } }, r);
  assert.equal(v.proceed, false);
  assert.equal(v.reason, 'rc-unavailable');
  assert.deepEqual(r.calls, { subjects: 0, runs: 0, beacon: 0 });
  assert.equal(remoteConfigLoaded({ [RC_SENTINEL_ENV]: '   ' }), false, 'una sentinella vuota non prova niente');
});

test('flag assente o vuoto: nessun cantone genera', () => {
  for (const value of [undefined, '', '  ', 'GR, BE']) {
    const r = readers();
    const v = decide({
      env: { [RC_SENTINEL_ENV]: 'pat', [CANTON_SECTIONS_ENABLED_ENV]: value },
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
    env: { [RC_SENTINEL_ENV]: 'pat', [CANTON_SECTIONS_ENABLED_ENV]: '' },
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
    env: { [RC_SENTINEL_ENV]: 'pat', [CANTON_SECTIONS_ENABLED_ENV]: 'all' },
    activeSections: { frontaliere: {}, svizzera: {} },
    eventName: 'schedule',
    ...readers(),
  });
  assert.equal(v.proceed, false);
  assert.equal(v.reason, 'canton-inactive');
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

test('budget: vars.CANTON_DAILY_BUDGET_CAP abbassa il budget, non lo alza', () => {
  const profile = { section: SECTION, dailyBudget: 4 };
  assert.equal(effectiveDailyBudget(profile, ''), 4);
  assert.equal(effectiveDailyBudget(profile, '2'), 2, 'il pilota a <=2/giorno (D19)');
  assert.equal(effectiveDailyBudget(profile, '9'), 4);
  assert.equal(effectiveDailyBudget(profile, 'due'), 4, 'un valore illeggibile non cambia il budget');
  assert.throws(() => effectiveDailyBudget({ section: SECTION }, ''), /dailyBudget non valido/);

  const two = [articleCommitSubject(SECTION), articleCommitSubject(SECTION)];
  const v = decide({ env: { ...ENV_ON, CANTON_DAILY_BUDGET_CAP: '2' } }, readers({ subjects: two }));
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
    run(80, 'generate-article.yml', '2026-10-05T09:00:00Z'), // frontaliere/svizzera: non e' un cantone
    run(81, 'generate-article-core.yml', '2026-10-05T09:00:00Z'), // il riusabile non ha run sue
    run(82, 'publish-api.yml', '2026-10-05T09:00:00Z'),
  ];
  assert.deepEqual(olderCantonRuns(runs, 100), { older: 2, total: 4, selfSeen: true });
  assert.equal(CANTON_WORKFLOW_PATH_RE.test(CORE_WORKFLOW_PATH), true, 'la regex da sola prenderebbe anche il core: va escluso per nome');
  for (const c of PROFILES.cantons) {
    assert.match(`.github/workflows/${callerWorkflowFile(c.code)}`, CANTON_WORKFLOW_PATH_RE, c.code);
  }
});

test('tetto globale: due arrivi simultanei non si fermano a vicenda', () => {
  const a = run(100, 'generate-article-ti.yml', '2026-10-05T10:00:10Z');
  const b = run(101, 'generate-article-gr.yml', '2026-10-05T10:00:10Z');
  assert.equal(olderCantonRuns([a, b], 100).older, 0);
  assert.equal(olderCantonRuns([a, b], 101).older, 1);
});

test('tetto globale: default 3, configurabile, fail-closed se illeggibile', () => {
  assert.equal(DEFAULT_MAX_PARALLEL, 3);
  assert.equal(positiveInt('', 3), 3);
  assert.equal(positiveInt('0', 3), 3);
  assert.equal(positiveInt('5', 3), 5);
  assert.equal(positiveInt('-1', 3), 3);

  const self = run(100, 'generate-article-ti.yml', '2026-10-05T10:00:10Z');
  const older = (n) => Array.from({ length: n }, (_, i) => run(10 + i, `generate-article-${['gr', 'be', 'zh', 'vd'][i]}.yml`, '2026-10-05T09:00:00Z'));

  assert.equal(decide({}, readers({ runs: [self, ...older(2)] })).proceed, true);
  const capped = decide({}, readers({ runs: [self, ...older(3)] }));
  assert.equal(capped.proceed, false);
  assert.equal(capped.reason, 'parallel-cap');
  assert.equal(decide({ env: { ...ENV_ON, CANTON_GENERATION_MAX_PARALLEL: '4' } }, readers({ runs: [self, ...older(3)] })).proceed, true);
  assert.equal(decide({ env: { ...ENV_ON, CANTON_GENERATION_MAX_PARALLEL: '1' } }, readers({ runs: [self, ...older(1)] })).reason, 'parallel-cap');

  assert.equal(decide({}, readers({ runs: null })).reason, 'parallel-unreadable');
  // Questa run fuori dall'elenco: non c'e' un istante con cui confrontare, contano tutte.
  assert.deepEqual(olderCantonRuns(older(3), 100), { older: 3, total: 3, selfSeen: false });
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

  const off = decide({ eventName: 'workflow_dispatch', env: { [RC_SENTINEL_ENV]: 'pat' }, profiles: DISABLED_PROFILES });
  assert.equal(off.proceed, false);
  assert.equal(off.reason, 'canton-disabled');
});

// ── La CLI: marcatori e output ───────────────────────────────────────────────

function runCli(env) {
  const dir = mkdtempSync(path.join(tmpdir(), 'canton-admit-'));
  const out = path.join(dir, 'output');
  writeFileSync(out, '');
  try {
    const clean = { PATH: process.env.PATH, HOME: dir, GITHUB_OUTPUT: out, ...env };
    const res = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: clean });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr, output: readFileSync(out, 'utf8') };
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
  const res = runCli({ SECTION: DISABLED_SECTION, [RC_SENTINEL_ENV]: 'pat' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, new RegExp(`^${CANTON_SECTION_DISABLED_MARKER} section=${DISABLED_SECTION}$`, 'm'));
  assert.match(res.stdout, new RegExp(`GENERATION_OUTCOME kind=skipped reason=canton-disabled section=${DISABLED_SECTION}`));
  assert.match(res.output, /^proceed=false$/m);
});

test('CLI: una sezione non cantonale esce 2 e non scrive proceed', () => {
  const res = runCli({ SECTION: 'frontaliere', [RC_SENTINEL_ENV]: 'pat' });
  assert.equal(res.status, 2);
  assert.equal(res.output, '');
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
    /\n {4}concurrency:\n {6}group: \$\{\{ \(needs\.admit\.outputs\.run_mode == 'production' \|\| needs\.admit\.outputs\.run_mode == 'unknown'\) && 'generate-article' \|\| format\('\{0\}-dry', inputs\.concurrency_group\) \}\}\n {6}cancel-in-progress: false\n/,
    'il solo job writer serializza tutti i producer production e unknown e lascia il dry separato',
  );
  assert.match(gate, /proceed: \$\{\{ steps\.none\.outputs\.proceed \|\| steps\.canton\.outputs\.proceed \}\}/);
});

test('il gate legge il token del runner, non un PAT interpolato dal contesto env', () => {
  const gate = jobBlock('section_gate');
  assert.match(gate, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(gate, /\n {6}actions: read\n/, 'senza actions: read le run in_progress non si leggono');
  assert.match(gate, /CANTON_GENERATION_MAX_PARALLEL: \$\{\{ vars\.CANTON_GENERATION_MAX_PARALLEL \}\}/);
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
