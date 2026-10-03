/**
 * scan-failed-runs-member-grain.test.mjs — la GRANA del verdetto dello scanner
 * sui gruppi crawler.
 *
 * ## Il difetto che questo file tiene chiuso
 *
 * Il gate di ricorrenza conta per TITOLO. Finché un gruppo con più membri
 * falliti usava il titolo aggregato `Workflow Failure: Crawler Group NN`, il
 * gate contava «il gruppo è rosso» e arrivava a 3 su 3 in 48 ore con membri che
 * ruotavano, senza che nessuno fosse cronico. Misurato sul gruppo 23:
 * artificialy e fachkraft il 09-30, capri-holdings il 10-01, fachkraft,
 * capri-holdings e confederazione il 10-02, fust e capri-holdings il 10-03.
 * Ne uscivano issue di gruppo aperte per settimane nel corpus, dove i crawler
 * non sono riparabili.
 *
 * ## Le due metà, perché una senza l'altra è un regresso
 *
 * - un rosso di SOLI membri in minoranza va legato a ogni membro
 *   (`Crawler Failure: Run <slug>`), così tre membri diversi restano tre
 *   briciole e solo un membro che ricade tre volte apre la sua issue;
 * - un guasto CONDIVISO (lease, push, exit 143, stato mancante), metà flotta a
 *   terra o un log che non dice quanti membri ha il gruppo restano sul titolo
 *   di gruppo: spezzarli per membro attribuirebbe la radice alle foglie.
 *
 * ## Le fixture
 *
 * `fixtures/scan-failed-runs/crawler-group-23-run-37112917183.txt` è un
 * estratto del log vero di quella run (`gh run view … --log-failed`): prefisso
 * `job\tstep\ttimestamp`, ANSI in forma caret, eco dello shell trace e riga di
 * verdetto dell'aggregatore compresi. I casi che il log vero non contiene
 * (maggioranza, exit 143, lease) sono costruiti con le STESSE forme di riga.
 *
 * `single-member-report-main-5e0c1cfd9.json` è il report che il codice di
 * `main` (ultimo commit sul file: 5e0c1cfd9) produceva per la stessa fixture
 * ridotta a un solo membro: il ramo a un membro non deve cambiare di un byte.
 *
 * ## Il seam
 *
 * Un `gh` finto CON STATO in testa a `PATH` (stessa tecnica di
 * scan-failed-runs-dedup.test.mjs): tiene issue e commenti in un file, così il
 * ledger scritto da `createGithubIssue` VERO viene riletto dalla deduplica e
 * dal gate veri. Niente mock dei moduli.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'scan-failed-runs');
const REAL_LOG = fs.readFileSync(path.join(FIXTURES, 'crawler-group-23-run-37112917183.txt'), 'utf8');
const SINGLE_MEMBER_GOLDEN = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'single-member-report-main-5e0c1cfd9.json'), 'utf8'),
);

const OBSERVER_FAILURE = 'Scanner del corpus: un rosso di soli membri è tornato sul titolo di gruppo, '
  + 'o un guasto condiviso è stato spezzato per membro';

const GROUP = 'Crawler Group 23 (sparse cross-repo execution)';
const GROUP_TITLE = `Workflow Failure: ${GROUP}`;
const LEDGER_TITLE = 'Crawler transient failures (rolling ledger)';
const LEDGER_NUMBER = 25;
const JOB_LINES = '- `crawler_group_23` — step fallito: `Fail crawler group after all member outcomes`';

// ── Il `gh` finto con stato ─────────────────────────────────────────
//
// `issue list` ignora `--search` e rende tutte le issue dello stato chiesto
// (filtrate solo per `--label`): come la ricerca vera, che e' fuzzy, lascia al
// codice il filtro `startsWith(prefisso)`. `issue view … --jq` rende body e
// commenti concatenati (la forma che legge `alreadyReported`); senza `--jq`
// rende il JSON. `issue comment` e `issue create` SCRIVONO nello stato.
const FAKE_GH = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');
const file = process.env.FAKE_GH_STATE;
const st = JSON.parse(fs.readFileSync(file, 'utf8'));
const save = () => fs.writeFileSync(file, JSON.stringify(st));
const opt = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };
const all = (n) => args.flatMap((a, i) => (a === n ? [args[i + 1]] : []));
const url = (n) => 'https://github.com/o/r/issues/' + n;
if (args[0] === 'issue') {
  const issue = st.issues.find((i) => String(i.number) === args[2]);
  if (args[1] === 'list') {
    const state = (opt('--state') || 'open').toLowerCase();
    const label = opt('--label');
    process.stdout.write(JSON.stringify(st.issues
      .filter((i) => i.state.toLowerCase() === state && (!label || i.labels.includes(label)))
      .map((i) => ({
        number: i.number, title: i.title, url: url(i.number), closedAt: null,
        state: i.state, stateReason: null, labels: i.labels.map((name) => ({ name })),
      }))));
    process.exit(0);
  }
  if (args[1] === 'view') {
    if (!issue) process.exit(1);
    if (args.includes('--jq')) {
      process.stdout.write(issue.body + issue.comments.map((c) => c.body).join('\\n'));
    } else {
      process.stdout.write(JSON.stringify({
        body: issue.body, createdAt: issue.createdAt, comments: issue.comments,
      }));
    }
    process.exit(0);
  }
  if (args[1] === 'comment') {
    if (!issue) process.exit(1);
    issue.comments.push({ body: opt('--body'), createdAt: new Date().toISOString() });
    save();
    process.stdout.write(url(issue.number) + '#issuecomment-1\\n');
    process.exit(0);
  }
  if (args[1] === 'create') {
    const number = st.next++;
    st.issues.push({
      number, title: opt('--title'), body: opt('--body'), state: 'OPEN',
      labels: all('--label'), createdAt: new Date().toISOString(), comments: [],
    });
    save();
    process.stdout.write(url(number) + '\\n');
    process.exit(0);
  }
}
process.exit(0);
`;

let tmpDir;
let stateFile;
let logFile;
const savedEnv = {};
const ENV_KEYS = [
  'PATH', 'GITHUB_REPOSITORY', 'GH_REPO', 'FAKE_GH_STATE', 'FAKE_GH_LOG',
  'ENABLE_FAILURE_REPORT', 'GITHUB_STEP_SUMMARY', 'TRUSTED_GH_BIN',
];

// L'ambiente va preparato PRIMA dell'import: lo scanner legge
// `GITHUB_REPOSITORY` una volta sola, a livello di modulo.
tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-member-grain-'));
fs.mkdirSync(path.join(tmpDir, 'bin'));
fs.writeFileSync(path.join(tmpDir, 'bin', 'gh'), FAKE_GH, { mode: 0o755 });
stateFile = path.join(tmpDir, 'state.json');
logFile = path.join(tmpDir, 'gh.log');
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
process.env.PATH = `${path.join(tmpDir, 'bin')}${path.delimiter}${savedEnv.PATH}`;
process.env.GITHUB_REPOSITORY = 'o/r';
process.env.GH_REPO = 'o/r';
process.env.FAKE_GH_STATE = stateFile;
process.env.FAKE_GH_LOG = logFile;
delete process.env.ENABLE_FAILURE_REPORT;
delete process.env.GITHUB_STEP_SUMMARY;
delete process.env.TRUSTED_GH_BIN;

const {
  buildCrawlerFailureReports,
  crawlerGroupVerdictFromLog,
  crawlerReportGrain,
  deliverRunReports,
  capUnitsForRun,
  capReached,
  gateForWorkflow,
  ledgerEntryCountsRun,
  transientLedgerMarker,
  ALWAYS_ESCALATE_WORKFLOWS,
} = await import(path.resolve(HERE, '../../scripts/ci/scan-failed-runs.mjs'));

const emptyLedger = () => ({
  next: 9000,
  issues: [{
    number: LEDGER_NUMBER,
    title: LEDGER_TITLE,
    body: 'Rolling log of sub-threshold crawler failures.',
    state: 'OPEN',
    labels: ['crawler-transient', 'priority:low'],
    createdAt: '2026-08-05T00:00:00Z',
    comments: [],
  }],
});
const setState = (state) => fs.writeFileSync(stateFile, JSON.stringify(state));
const readState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const ghCalls = () =>
  fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const writes = () => ghCalls().filter((a) => a[0] === 'issue' && (a[1] === 'comment' || a[1] === 'create'));
const created = () => ghCalls()
  .filter((a) => a[0] === 'issue' && a[1] === 'create')
  .map((a) => a[a.indexOf('--title') + 1]);
const ledgerComments = () => readState().issues.find((i) => i.number === LEDGER_NUMBER).comments;

before(() => {
  setState(emptyLedger());
  fs.writeFileSync(logFile, '');
});

beforeEach(() => {
  setState(emptyLedger());
  fs.writeFileSync(logFile, '');
});

after(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Costruttori di log, con le forme di riga del log vero ───────────

const runOf = (id) => ({
  databaseId: id,
  url: `https://github.com/o/r/actions/runs/${id}`,
  headBranch: 'crawler-generation-shadow-37111567883-1',
  event: 'workflow_dispatch',
  updatedAt: '2026-10-03T10:12:45Z',
});
const REAL_RUN = {
  ...runOf(37112917183),
  url: 'https://github.com/nanakokyobashi-rgb/frontaliere-articles/actions/runs/37112917183',
};
const logLine = (text) => `crawler_group_23\tUNKNOWN STEP\t2026-10-03T10:08:52.4887979Z ${text}`;
const exitLine = (slug, code = 1) => logLine(`##[error]${slug}: crawler exited with status ${code}`);
const verdictLine = ({ succeeded, failed, missing = 0, systemic = 0 }) => logLine(
  `##[error]crawler group completed with ${succeeded} succeeded, ${failed} failed, ${missing} missing, ${systemic} systemic; `
    + 'healthy siblings were preserved, but the group remains failed until incomplete crawlers are recovered',
);
/** Log di una run di `members` membri in cui falliscono (exit 1) gli `slugs`. */
const groupLog = (slugs, members) => [
  ...slugs.map((slug) => exitLine(slug)),
  verdictLine({ succeeded: members - slugs.length, failed: slugs.length }),
].join('\n');
const withoutVerdict = (log) => log.split('\n').filter((l) => !/crawler group completed with/.test(l)).join('\n');
const titlesOf = (reports) => reports.map((r) => r.title);
const reportsFor = (log, run = REAL_RUN) => buildCrawlerFailureReports({
  log, run, workflowName: GROUP, jobLines: JOB_LINES,
});

// ── La riga di verdetto ─────────────────────────────────────────────

test('il verdetto dell\'aggregatore si legge dal log vero e dà il numero dei membri', () => {
  const verdict = crawlerGroupVerdictFromLog(REAL_LOG);
  assert.deepEqual(verdict, { succeeded: 21, failed: 2, missing: 0, systemic: 0, members: 23 });
});

test('l\'eco dello shell trace e due verdetti discordi non sono un verdetto', () => {
  const echoOnly = logLine('^[[36;1m  echo "::error::crawler group completed with $success_count succeeded, $failure_count failed, $missing_count missing, $systemic_count systemic; healthy siblings were preserved"^[[0m');
  assert.equal(crawlerGroupVerdictFromLog(echoOnly), null);
  // Anche con cifre vere, una riga che e' il sorgente di un `echo` non conta.
  assert.equal(
    crawlerGroupVerdictFromLog(logLine('  echo "::error::crawler group completed with 21 succeeded, 2 failed, 0 missing, 0 systemic"')),
    null,
  );
  assert.equal(
    crawlerGroupVerdictFromLog([
      verdictLine({ succeeded: 21, failed: 2 }),
      verdictLine({ succeeded: 20, failed: 3 }),
    ].join('\n')),
    null,
  );
  assert.equal(crawlerGroupVerdictFromLog(''), null);
});

// ── La grana dei report ─────────────────────────────────────────────

test('log vero, 2 membri falliti su 23 senza guasto condiviso → 2 report per membro, nessun report di gruppo', () => {
  const reports = reportsFor(REAL_LOG);
  assert.deepEqual(
    titlesOf(reports),
    ['Crawler Failure: Run fust', 'Crawler Failure: Run capri-holdings'],
    OBSERVER_FAILURE,
  );
  assert.ok(reports.every((r) => !r.groupLevel), OBSERVER_FAILURE);

  const [fust, capri] = reports;
  // Ogni membro porta la SUA causa e la propria riga di exit, non quelle
  // dell'altro: un report che le mescola rimanda il triage al crawler sbagliato.
  assert.match(fust.description, /Fust workplace invariant failed: enriched 58\/100 canonical details/);
  assert.match(fust.description, /##\[error\]fust: crawler exited with status 1/);
  assert.doesNotMatch(fust.description, /Capri Holdings crawler failed|capri-holdings: crawler exited/);
  assert.match(capri.description, /Workday Versace Switzerland search returned a malformed page at offset 0/);
  assert.match(capri.description, /##\[error\]capri-holdings: crawler exited with status 1/);
  assert.doesNotMatch(capri.description, /Fust crawler failed|fust: crawler exited/);
  for (const report of reports) {
    // L'URL della run e' la chiave di deduplica: deve stare in ogni corpo.
    assert.ok(report.description.includes(REAL_RUN.url));
    assert.match(report.description, new RegExp(`step \`Run ${report.slug}\``));
  }
});

test('una causa che non si sa attribuire a un membro resta nel report di tutti', () => {
  const log = [
    logLine('❌ Some Unknown Brand crawler failed: upstream returned an empty catalogue'),
    REAL_LOG,
  ].join('\n');
  const reports = reportsFor(log);
  assert.equal(reports.length, crawlerGroupVerdictFromLog(REAL_LOG).failed);
  for (const report of reports) {
    assert.match(report.description, /Some Unknown Brand crawler failed: upstream returned an empty catalogue/);
  }
});

test('1 membro fallito → 1 report per membro, identico a quello che produceva main', () => {
  const single = REAL_LOG.split('\n')
    .filter((line) => !/capri|Capri|Versace/.test(line))
    .map((line) => line.replace('21 succeeded, 2 failed', '22 succeeded, 1 failed'))
    .join('\n');
  const reports = reportsFor(single);
  assert.deepEqual(reports, [SINGLE_MEMBER_GOLDEN]);
});

test('1 membro fallito resta per-membro anche senza riga di verdetto (ramo preesistente, non ristretto)', () => {
  const reports = reportsFor(exitLine('fust'));
  assert.deepEqual(titlesOf(reports), ['Crawler Failure: Run fust']);
});

test('metà o più dei membri falliti → 1 report di gruppo; un membro in meno → report per membro', () => {
  const members = 26;
  const slugs = Array.from({ length: members / 2 }, (_, i) => `member-${String(i).padStart(2, '0')}`);

  const half = reportsFor(groupLog(slugs, members));
  assert.deepEqual(titlesOf(half), [GROUP_TITLE], OBSERVER_FAILURE);
  assert.equal(half[0].groupLevel, true);
  assert.equal(half[0].grainReason, 'majority-failed');
  assert.equal(half[0].failures.length, slugs.length);

  const minority = slugs.slice(1);
  const below = reportsFor(groupLog(minority, members));
  assert.deepEqual(titlesOf(below), minority.map((slug) => `Crawler Failure: Run ${slug}`), OBSERVER_FAILURE);
});

test('2 membri falliti e un exit 143 → 1 report di gruppo (invariato)', () => {
  const log = [
    REAL_LOG,
    logLine('##[warning]lidl: runner shutdown interrupted the crawler (exit 143)'),
    exitLine('lidl', 143),
  ].join('\n');
  const reports = reportsFor(log);
  assert.deepEqual(titlesOf(reports), [GROUP_TITLE], OBSERVER_FAILURE);
  assert.equal(reports[0].groupLevel, true);
  assert.equal(reports[0].grainReason, 'shared-failure');
  assert.match(reports[0].description, /`143`/);
  assert.match(reports[0].description, /Il titolo resta aggregato/);
});

test('2 membri falliti e una riga di lease → 1 report di gruppo (invariato)', () => {
  const log = [
    REAL_LOG,
    logLine('##[warning]lidl: global data-pipeline lease is busy (exit 44); retrying'),
  ].join('\n');
  const reports = reportsFor(log);
  assert.deepEqual(titlesOf(reports), [GROUP_TITLE], OBSERVER_FAILURE);
  assert.equal(reports[0].grainReason, 'shared-failure');
  assert.match(reports[0].description, /lease is busy/);
});

test('2 membri falliti ma senza riga di verdetto → 1 report di gruppo (numero dei membri ignoto)', () => {
  const reports = reportsFor(withoutVerdict(REAL_LOG));
  assert.deepEqual(titlesOf(reports), [GROUP_TITLE], OBSERVER_FAILURE);
  assert.equal(reports[0].grainReason, 'member-count-unknown');
  assert.match(reports[0].description, /`fust`/);
  assert.match(reports[0].description, /`capri-holdings`/);
});

test('il verdetto che smentisce i membri attribuiti tiene la grana di gruppo', () => {
  // Timeout (124) e stati invalidi contano fra i `failed` dell'aggregatore ma
  // non stampano `crawler exited with status`: i report per membro farebbero
  // sparire il terzo fallito.
  const hiddenThird = withoutVerdict(REAL_LOG) + '\n' + verdictLine({ succeeded: 20, failed: 3 });
  assert.equal(reportsFor(hiddenThird)[0].grainReason, 'verdict-mismatch');
  assert.deepEqual(titlesOf(reportsFor(hiddenThird)), [GROUP_TITLE]);

  // Un membro senza stato terminale o interrotto dal runner e' un guasto di
  // gruppo anche quando la sua riga non e' fra gli estratti.
  for (const extra of [{ missing: 1 }, { systemic: 1 }]) {
    assert.deepEqual(
      crawlerReportGrain({
        failures: [{ slug: 'a' }, { slug: 'b' }],
        hasSharedFailure: false,
        verdict: { succeeded: 20, failed: 2, missing: 0, systemic: 0, members: 23, ...extra },
      }),
      { grain: 'group', reason: 'shared-failure' },
    );
  }
});

// ── Il chiamante: scritture, deduplica, cap ─────────────────────────

const THREE = ['fust', 'capri-holdings', 'lidl'];
const threeMemberReports = (run) => reportsFor(groupLog(THREE, 23), run);

test('3 membri falliti nella stessa run → 3 creazioni con titoli diversi, il cap sale di 1; seconda scansione → 0', async () => {
  const run = runOf(5001);
  const reports = threeMemberReports(run);
  assert.equal(reports.length, THREE.length);

  const calls = [];
  const first = await deliverRunReports({
    name: GROUP,
    run,
    reports,
    dryRun: false,
    createIssue: async (args) => {
      calls.push(args);
      return { number: LEDGER_NUMBER, ledger: true, persisted: true };
    },
  });
  assert.deepEqual(calls.map((c) => c.title), THREE.map((slug) => `Crawler Failure: Run ${slug}`));
  assert.equal(new Set(calls.map((c) => c.title)).size, THREE.length, 'titoli diversi: il gate conta per titolo');
  for (const call of calls) {
    assert.equal(call.workflow, GROUP);
    assert.equal(call.consecutiveGate, gateForWorkflow(GROUP), 'il gate di ricorrenza resta quello dei gruppi');
    assert.ok(call.consecutiveGate > 0);
  }
  assert.deepEqual(first, { delivered: THREE.length, skipped: 0, undelivered: [] });
  assert.equal(capUnitsForRun({ name: GROUP, delivered: first.delivered }), 1, 'una run pesa una volta sola sul cap');
});

test('con createGithubIssue vero: una briciola per membro nel ledger, e la ri-scansione non ne scrive altre', async () => {
  const run = runOf(5002);
  const first = await deliverRunReports({ name: GROUP, run, reports: threeMemberReports(run), dryRun: false });
  assert.deepEqual(first, { delivered: THREE.length, skipped: 0, undelivered: [] });
  assert.deepEqual(created(), [], 'sotto soglia non nasce nessuna issue: solo briciole');

  const comments = ledgerComments();
  assert.equal(comments.length, THREE.length);
  for (const slug of THREE) {
    const title = `Crawler Failure: Run ${slug}`;
    const mine = comments.filter((c) => ledgerEntryCountsRun(c.body, run.url, [title]));
    // Il marcatore che la deduplica cerca e' quello che il reporter scrive
    // davvero: se `github-issue-creator.mjs` cambia chiave o lunghezza del
    // prefisso, questa riga diventa rossa prima che la deduplica diventi cieca.
    assert.equal(mine.length, 1, `una e una sola briciola per ${slug}, firmata ${transientLedgerMarker(title)}`);
  }
  assert.ok(!comments.some((c) => c.body.includes(transientLedgerMarker(GROUP_TITLE))), OBSERVER_FAILURE);

  fs.writeFileSync(logFile, '');
  const second = await deliverRunReports({ name: GROUP, run, reports: threeMemberReports(run), dryRun: false });
  assert.deepEqual(second, { delivered: 0, skipped: THREE.length, undelivered: [] });
  assert.deepEqual(writes(), [], 'stessa run, stessi titoli: zero scritture');
  assert.equal(ledgerComments().length, THREE.length);
  assert.equal(capUnitsForRun({ name: GROUP, delivered: second.delivered }), 0);
});

test('consegna parziale: la ri-scansione riprova SOLO il membro non scritto', async () => {
  // La trappola: il controllo del ledger di `alreadyReported` guarda il solo
  // URL della run. Dopo la prima briciola quell'URL e' gia' nel ledger, e ogni
  // altro membro della stessa run risulterebbe «gia' segnalato» per sempre.
  const run = runOf(5003);
  const { createGithubIssue } = await import(path.resolve(HERE, '../../scripts/lib/github-issue-creator.mjs'));
  const failing = 'Crawler Failure: Run capri-holdings';
  const first = await deliverRunReports({
    name: GROUP,
    run,
    reports: threeMemberReports(run),
    dryRun: false,
    createIssue: (args) => (args.title === failing ? null : createGithubIssue(args)),
  });
  assert.equal(first.delivered, THREE.length - 1);
  assert.deepEqual(first.undelivered.map((u) => u.title), [failing]);
  assert.equal(capUnitsForRun({ name: GROUP, delivered: first.delivered }), 1);

  const retried = [];
  const second = await deliverRunReports({
    name: GROUP,
    run,
    reports: threeMemberReports(run),
    dryRun: false,
    createIssue: (args) => {
      retried.push(args.title);
      return createGithubIssue(args);
    },
  });
  assert.deepEqual(retried, [failing]);
  assert.deepEqual(second, { delivered: 1, skipped: THREE.length - 1, undelivered: [] });
  assert.equal(ledgerComments().length, THREE.length);
});

test('una run già contata a grana di gruppo non viene ricontata per membro', async () => {
  const run = runOf(5004);
  const inLedger = emptyLedger();
  inLedger.issues[0].comments.push({
    createdAt: new Date().toISOString(),
    body: `🔁 **${GROUP_TITLE.slice(0, 60)}** — transient failure 1/3 in the rolling window.\n\n\`transient-key: ${GROUP_TITLE.slice(0, 60)}\`\n\n- Run: ${run.url}`,
  });
  setState(inLedger);
  const fromLedger = await deliverRunReports({ name: GROUP, run, reports: threeMemberReports(run), dryRun: false });
  assert.deepEqual(fromLedger, { delivered: 0, skipped: THREE.length, undelivered: [] });

  const inIssue = emptyLedger();
  inIssue.issues.push({
    number: 1753, title: GROUP_TITLE, body: 'issue di gruppo', state: 'OPEN', labels: ['Bug'],
    createdAt: '2026-09-30T00:00:00Z', comments: [{ createdAt: new Date().toISOString(), body: `🔁 Recurrence on workflow run.\n\n- Run: ${run.url}` }],
  });
  setState(inIssue);
  fs.writeFileSync(logFile, '');
  const fromIssue = await deliverRunReports({ name: GROUP, run, reports: threeMemberReports(run), dryRun: false });
  assert.deepEqual(fromIssue, { delivered: 0, skipped: THREE.length, undelivered: [] });
  assert.deepEqual(writes(), []);
});

test('la briciola di un membro non spegne quella di un membro col nome che la prolunga', () => {
  const url = runOf(5005).url;
  const entry = `\`transient-key: Crawler Failure: Run fust-ch\`\n\n- Run: ${url}`;
  assert.equal(ledgerEntryCountsRun(entry, url, ['Crawler Failure: Run fust-ch']), true);
  assert.equal(ledgerEntryCountsRun(entry, url, ['Crawler Failure: Run fust']), false);
  assert.equal(ledgerEntryCountsRun(entry, runOf(5006).url, ['Crawler Failure: Run fust-ch']), false);
});

test('il report di gruppo percorre la deduplica di prima: un solo titolo, una sola scrittura', async () => {
  const run = runOf(5007);
  const reports = reportsFor(withoutVerdict(groupLog(THREE, 23)), run);
  assert.deepEqual(titlesOf(reports), [GROUP_TITLE]);
  const first = await deliverRunReports({ name: GROUP, run, reports, dryRun: false });
  assert.deepEqual(first, { delivered: 1, skipped: 0, undelivered: [] });
  assert.equal(ledgerComments().length, 1);
  const second = await deliverRunReports({ name: GROUP, run, reports, dryRun: false });
  assert.deepEqual(second, { delivered: 0, skipped: 1, undelivered: [] });
  assert.equal(ledgerComments().length, 1);
});

test('il cap conta le run, non i membri, e i sorvegliati non pesano', () => {
  assert.equal(capUnitsForRun({ name: GROUP, delivered: 5 }), 1);
  assert.equal(capUnitsForRun({ name: GROUP, delivered: 0 }), 0);
  const [surveillance] = [...ALWAYS_ESCALATE_WORKFLOWS];
  assert.equal(capUnitsForRun({ name: surveillance, delivered: 1 }), 0);
  // Quattro gruppi con cinque membri rossi ciascuno non esauriscono un cap di 5.
  let capped = 0;
  for (let i = 0; i < 4; i += 1) capped += capUnitsForRun({ name: GROUP, delivered: 5 });
  assert.equal(capReached({ name: GROUP, cappedOpened: capped, maxIssues: 5 }), false);
});

test('dry-run: un «aprirei» per membro, nessuna scrittura', async () => {
  const run = runOf(5008);
  const outcome = await deliverRunReports({
    name: GROUP,
    run,
    reports: threeMemberReports(run),
    dryRun: true,
    createIssue: () => assert.fail('il dry-run non deve creare niente'),
  });
  assert.deepEqual(outcome, { delivered: THREE.length, skipped: 0, undelivered: [] });
  assert.deepEqual(writes(), []);
});

// ── Il gate di ricorrenza, ora per membro ───────────────────────────

test('lo stesso membro rosso in 3 run entro la finestra → escalation di QUEL titolo, e solo di quello', async () => {
  // fust ricade a ogni run; il compagno ruota (come nel gruppo 23).
  const waves = [['fust', 'capri-holdings'], ['fust', 'fachkraft'], ['fust', 'confederazione']];
  for (const [index, slugs] of waves.entries()) {
    const run = runOf(6001 + index);
    const outcome = await deliverRunReports({
      name: GROUP, run, reports: reportsFor(groupLog(slugs, 23), run), dryRun: false,
    });
    assert.deepEqual(outcome, { delivered: slugs.length, skipped: 0, undelivered: [] });
  }
  assert.deepEqual(created(), ['Crawler Failure: Run fust'], OBSERVER_FAILURE);
  const issue = readState().issues.find((i) => i.title === 'Crawler Failure: Run fust');
  assert.ok(issue.labels.includes('priority:high'), 'alla terza ricaduta la issue nasce a priorità piena');
  assert.ok(!issue.labels.includes('crawler-transient'));
});

test('tre membri diversi in 3 run → tre briciole, nessuna escalation', async () => {
  const waves = [['artificialy', 'fachkraft'], ['capri-holdings', 'confederazione'], ['fust', 'lidl']];
  for (const [index, slugs] of waves.entries()) {
    const run = runOf(6101 + index);
    await deliverRunReports({
      name: GROUP, run, reports: reportsFor(groupLog(slugs, 23), run), dryRun: false,
    });
  }
  // Prima di questa regola le stesse tre run scrivevano tre volte la chiave del
  // gruppo e la terza apriva `Workflow Failure: Crawler Group 23`.
  assert.deepEqual(created(), [], OBSERVER_FAILURE);
  const comments = ledgerComments();
  assert.equal(comments.length, waves.flat().length);
  assert.ok(comments.every((c) => /transient failure 1\/\d+ in the rolling window/.test(c.body)));
});
