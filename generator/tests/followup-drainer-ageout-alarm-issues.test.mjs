/**
 * followup-drainer — l'AGE-OUT non chiude gli allarmi che hanno un chiuditore.
 *
 * Porting adattato di `tests/followup-drainer-ageout-alarm-issues.test.ts` del
 * sito (valerielinc-ops/frontaliere-si-o-no#9833). Là il caso reale era #7918,
 * `CI Failure (build): Deploy to GitHub Pages`, RIAPERTA dal deploy rosso e
 * chiusa dal drainer undici minuti dopo come «nessun evento significativo».
 *
 * Qui la fixture è #1721 (`issue-1721.json`, dalla issue vera): un
 * `Workflow Failure:` che il reconciler ha chiuso due volte sul verde e il
 * reporter ha riaperto due volte sul rosso. Il replay proietta l'orologio a
 * quando il reporter ha smesso di parlare da 7 giorni: con queste date e queste
 * label il vecchio age-out l'avrebbe chiusa, mentre l'ultima run completata
 * poteva essere ancora rossa.
 *
 * Il contratto fissato qui:
 *  - un allarme la cui chiusura spetta al reconciler non è mai candidato
 *    all'age-out (con un follow-up gemello di controllo che invece resta
 *    eleggibile);
 *  - gli allarmi SENZA chiuditore in questo repo restano candidati, perché per
 *    loro l'age-out è l'unico chiuditore che esiste — comprese le famiglie con
 *    scope che il sito esclude e che qui nessuno apre né chiude;
 *  - la famiglia esclusa ha davvero un chiuditore nel repo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  isAgeOutCandidate,
  isAgeOutEligible,
  isOwnerClosedFailureAlarm,
  lastSignificantActivityAt,
} from '../../scripts/ci/followup-drainer.mjs';
import { scopedTitle } from '../../scripts/ci/scan-job-timeouts.mjs';
import { TITLE_RE, findCrawlerGroupWorkflow } from '../../scripts/ci/close-recovered-failure-issues.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const ISSUE_1721 = JSON.parse(read('generator/tests/fixtures/followup-drainer-ageout-alarm/issue-1721.json'));

// I default del drainer (AGEOUT_DAYS / AGEOUT_INACTIVE_DAYS).
const AGEOUT_DAYS = 10;
const INACTIVE_DAYS = 7;
const DAY = 86_400_000;

test("replay #1721: l'ultima ricorrenza firmata dal PAT è l'ultimo evento significativo", () => {
  // Da questo lato il reporter scrive col PAT del proprietario, che non è un
  // bot: la riapertura azzera l'inattività, mentre il ✅ del reconciler
  // (github-actions) non conta.
  assert.equal(
    lastSignificantActivityAt(ISSUE_1721, ISSUE_1721.comments),
    Date.parse('2026-09-26T05:27:53Z'),
  );
});

test("replay #1721: a reporter muto da 7 giorni il gemello follow-up è chiudibile, l'allarme no", () => {
  const significantAt = lastSignificantActivityAt(ISSUE_1721, ISSUE_1721.comments);
  const now = significantAt + INACTIVE_DAYS * DAY + 60_000;
  // Il controllo: un gemello identico in tutto tranne il titolo. Con queste
  // date e queste label l'age-out chiude davvero.
  const twin = { ...ISSUE_1721, title: 'follow-up(#1234): un item deferred' };
  assert.equal(isOwnerClosedFailureAlarm(twin), false);
  assert.equal(isAgeOutEligible(twin, {
    now, ageOutDays: AGEOUT_DAYS, inactiveDays: INACTIVE_DAYS, significantAt,
  }), true);
  // L'allarme vero non è più candidato: la sua chiusura spetta al reconciler.
  assert.equal(isOwnerClosedFailureAlarm(ISSUE_1721), true);
  assert.equal(isAgeOutCandidate(ISSUE_1721, { now, ageOutDays: AGEOUT_DAYS }), false);
  assert.equal(isAgeOutEligible(ISSUE_1721, {
    now, ageOutDays: AGEOUT_DAYS, inactiveDays: INACTIVE_DAYS, significantAt,
  }), false);
  // Nemmeno dopo mesi di silenzio: non è l'inattività a decidere.
  assert.equal(isAgeOutEligible(ISSUE_1721, {
    now: now + 90 * DAY, ageOutDays: AGEOUT_DAYS, inactiveDays: INACTIVE_DAYS, significantAt,
  }), false);
});

const old = (title) => ({
  title,
  labels: [{ name: 'bug' }, { name: 'agent:triaged' }],
  createdAt: new Date(Date.now() - 30 * DAY).toISOString(),
  updatedAt: new Date(Date.now() - 20 * DAY).toISOString(),
});
const candidate = (title) => isAgeOutCandidate(old(title), { now: Date.now(), ageOutDays: AGEOUT_DAYS });

test('le tre famiglie del reconciler non sono mai age-out', () => {
  for (const title of [
    'Workflow Failure: Post-merge follow-up triage',
    'CI Failure: Translate Pending Jobs (sparse cross-repo execution)',
    'Crawler Failure: Run tsmg',
  ]) {
    assert.equal(isOwnerClosedFailureAlarm({ title }), true, title);
    assert.equal(candidate(title), false, title);
  }
});

test('`CI Failure (<evento>)` di una run fuori da main resta age-out: il reconciler la ignora', () => {
  // È il titolo che `scan-job-timeouts.mjs` conia per un timeout su un branch
  // di PR: fuori dal `TITLE_RE` del reconciler per costruzione, nessuno lo
  // chiude.
  const prTitle = scopedTitle({ head_branch: 'fix/issue-1', event: 'pull_request', name: 'tests' });
  assert.equal(prTitle, 'CI Failure (pull_request): tests');
  assert.equal(isOwnerClosedFailureAlarm({ title: prTitle }), false);
  assert.equal(candidate(prTitle), true);
  // La stessa run su main ha il titolo del reconciler, quindi un chiuditore.
  const mainTitle = scopedTitle({ head_branch: 'main', event: 'push', name: 'tests' });
  assert.equal(isOwnerClosedFailureAlarm({ title: mainTitle }), true);
  assert.equal(candidate(mainTitle), false);
});

test('le famiglie con scope che il sito esclude qui restano age-out: nessuno le chiude', () => {
  for (const title of [
    'CI Failure (build): Deploy to GitHub Pages',
    'CI Failure (deploy): Publish to GitHub Pages (deploy + validate)',
    'Validation Failure (dist): post-deploy',
    'Validation Failure (live): post-deploy',
    'Campaign goal FAILED: alert_funnel_conversion',
  ]) {
    assert.equal(isOwnerClosedFailureAlarm({ title }), false, title);
    assert.equal(candidate(title), true, title);
  }
});

test('nessun codice del repo conia le famiglie con scope del sito', () => {
  // Il giorno in cui una di queste famiglie viene portata qui (un reporter del
  // deploy, un validatore post-deploy, un campaign check), questo test diventa
  // rosso: va deciso se ha un chiuditore e, se sì, aggiunto all'esclusione di
  // `isOwnerClosedFailureAlarm` insieme alla prova che quel chiuditore gira.
  const SCOPED_FAMILY_RE = /CI Failure \((?:build|deploy)\)|Validation Failure \(|Campaign goal FAILED/;
  const EXEMPT = new Set(['scripts/ci/followup-drainer.mjs']);
  const walk = (rel) => readdirSync(path.join(ROOT, rel), { withFileTypes: true }).flatMap((d) => {
    const child = `${rel}/${d.name}`;
    if (d.isDirectory()) return /(?:^|\/)(?:tests|node_modules|fixtures)$/.test(child) ? [] : walk(child);
    return /\.(?:mjs|js|ts|ya?ml|sh)$/.test(d.name) ? [child] : [];
  });
  const offenders = ['scripts', '.github', 'generator/scripts']
    .flatMap(walk)
    .filter((rel) => !EXEMPT.has(rel) && SCOPED_FAMILY_RE.test(read(rel)));
  assert.deepEqual(offenders, []);
});

test('`Loop drift:` resta age-out: loop-drift-check apre e aggiorna ma non chiude', () => {
  const src = read('scripts/ci/loop-drift-check.mjs');
  assert.match(src, /title: 'Loop drift: il ciclo autonomo diverge dal sito'/);
  assert.doesNotMatch(src, /resolveGithubIssue|'issue',\s*'close'/);
  const title = 'Loop drift: il ciclo autonomo diverge dal sito';
  assert.equal(isOwnerClosedFailureAlarm({ title }), false);
  assert.equal(candidate(title), true);
});

test('un follow-up normale non è toccato dalla fix', () => {
  assert.equal(isOwnerClosedFailureAlarm({ title: 'follow-up(#1): qualcosa' }), false);
  assert.equal(candidate('follow-up(#1): qualcosa'), true);
});

test('il verdetto è stabile su valutazioni ripetute (nessuna regex con stato)', () => {
  // Una regex con flag `g` o `y` porta `lastIndex` da una `.test()` all'altra
  // e alterna vero/falso sullo stesso titolo: il drainer valuta centinaia di
  // issue per tick.
  assert.equal(TITLE_RE.global || TITLE_RE.sticky, false);
  for (const title of ['Workflow Failure: X', 'CI Failure: X', 'Crawler Failure: Run x']) {
    const verdicts = Array.from({ length: 5 }, () => isOwnerClosedFailureAlarm({ title }));
    assert.deepEqual(verdicts, [true, true, true, true, true]);
  }
});

test("l'esclusione è il `TITLE_RE` del reconciler, importato e non ricopiato", () => {
  const src = read('scripts/ci/followup-drainer.mjs');
  assert.match(
    src,
    /import \{[^}]*\bTITLE_RE as RECONCILER_TITLE_RE\b[^}]*\} from '\.\/close-recovered-failure-issues\.mjs';/,
  );
  for (const title of ['Workflow Failure: tests', 'Workflow Failure:tests', 'workflow failure: tests', 'Validation Failure: x']) {
    assert.equal(isOwnerClosedFailureAlarm({ title }), TITLE_RE.test(title), title);
  }
});

test('il reconciler gira davvero: workflow schedulato che esegue lo script', () => {
  const wf = read('.github/workflows/close-recovered-failure-issues.yml');
  assert.match(wf, /^\s*schedule:\s*\n\s*- cron: '[^']+'/m);
  assert.match(wf, /node scripts\/ci\/close-recovered-failure-issues\.mjs/);
});

// Il «Known edge» del reconciler: un titolo della famiglia che il reconciler
// non sa risolvere non si chiude mai. Prima di questa fix l'age-out era la sua
// ultima uscita; ora non lo è più, quindi i nomi devono risolvere.
const WORKFLOWS_DIR = path.join(ROOT, '.github/workflows');
const workflowFiles = readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f));
const workflowSrc = new Map(workflowFiles.map((f) => [f, read(`.github/workflows/${f}`)]));

test('ogni `Workflow|CI Failure: <nome>` coniato nei workflow nomina un workflow esistente', () => {
  // Il reconciler cerca le run con `gh run list -w <nome>`: il nome deve essere
  // il `name:` di un workflow, oppure `${{ github.workflow }}`.
  const names = new Set([...workflowSrc.values()]
    .map((src) => src.match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1])
    .filter(Boolean));
  const MINT_RE = /(?:--title\s+|\btitle:\s*|ISSUE_TITLE:\s*)["']?((?:Workflow|CI) Failure: [^"'\n]+?)["']?\s*(?:\\\s*)?$/gm;
  const unresolved = [];
  let minted = 0;
  for (const [f, src] of workflowSrc) {
    for (const m of src.matchAll(MINT_RE)) {
      minted++;
      const subject = TITLE_RE.exec(m[1].trim())?.[1];
      if (subject?.includes('${{ github.workflow }}')) continue;
      if (!subject || !names.has(subject)) unresolved.push(`${f}: ${m[1].trim()}`);
    }
  }
  assert.ok(minted > 0, 'nessun titolo coniato trovato: il pattern di estrazione non vede più i workflow');
  assert.deepEqual(unresolved, []);
});

// Baseline che può solo restringersi. Due step dei gruppi crawler generati dal
// sito hanno il `name:` corto e l'`id:` lungo (`Run vf` → `crawler-vf-international-
// the-north-face-timberland`, `Run guess` → `crawler-guess-europe`), quindi
// `findCrawlerGroupWorkflow` non li trova e una `Crawler Failure: Run vf` aperta in
// questo repo (`scan-failed-runs.mjs`, titolo per-membro) resterebbe aperta. I
// reporter dei gruppi scrivono sul sito (`GH_REPO`), dove i file hanno l'id corto e
// il reconciler risolve; qui una issue del genere non è mai esistita. La
// correzione sta nel sito (generatore dei gruppi o reconciler, entrambi non
// modificabili da questo lato).
const KNOWN_UNRESOLVED_CRAWLER_STEPS = ['crawler-group-07.yml: Run guess', 'crawler-group-07.yml: Run vf'];

test('ogni step `Run <slug>` dei gruppi crawler è risolvibile dal reconciler (baseline che si restringe)', () => {
  // Il reconciler risolve `Crawler Failure: Run <slug>` cercando la riga ancorata
  // `id: crawler-<slug>` nei `crawler-group-*.yml`, nel loro ordine di directory.
  // Chiamare `findCrawlerGroupWorkflow` per ognuno dei ~600 step rilegge tutti i
  // gruppi ogni volta (~15s): qui si indicizzano le righe `id:` una volta, e la
  // funzione vera del reconciler fa da controprova sui casi che decidono.
  const groups = [...workflowSrc.keys()].filter((f) => /^crawler-group-\d+\.yml$/.test(f));
  const firstFileById = new Map();
  for (const f of groups) {
    for (const m of workflowSrc.get(f).matchAll(/^\s*id:\s*crawler-(\S+)\s*$/gm)) {
      if (!firstFileById.has(m[1])) firstFileById.set(m[1], f);
    }
  }
  const unresolved = [];
  const resolved = [];
  for (const f of groups) {
    for (const m of workflowSrc.get(f).matchAll(/^\s*- name: Run (\S+)\s*$/gm)) {
      (firstFileById.get(m[1]) === f ? resolved : unresolved).push({ f, slug: m[1] });
    }
  }
  assert.ok(resolved.length > 0, 'nessuno step crawler trovato: il pattern di estrazione non vede più i gruppi');
  for (const { f, slug } of [resolved[0], resolved.at(-1), ...unresolved]) {
    const expected = unresolved.some((u) => u.slug === slug && u.f === f) ? undefined : f;
    assert.equal(findCrawlerGroupWorkflow(slug, WORKFLOWS_DIR)?.filename, expected, `${f}: Run ${slug}`);
  }
  assert.deepEqual(unresolved.map(({ f, slug }) => `${f}: Run ${slug}`).sort(), KNOWN_UNRESOLVED_CRAWLER_STEPS);
});
