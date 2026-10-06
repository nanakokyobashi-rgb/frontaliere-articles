// Pinna i filtri e le guardie che impediscono ai consumer `workflow_run` di
// `tests` di spendere una run per ogni push su `main` (~29% delle run `tests`
// il 2026-09-18/19), dove non esiste una PR su cui agire, senza escludere una
// PR da fork il cui branch sorgente si chiama `main`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

function triggerBlock(source, event) {
  const on = source.slice(source.indexOf('\non:\n'));
  const start = on.indexOf(`\n  ${event}:\n`);
  assert.ok(start >= 0, `trigger ${event} assente`);
  const rest = on.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z_]+:\n|\n[a-z]/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

for (const file of ['pr-redcheck-fixer.yml']) {
  test(`${file}: workflow_run di tests esclude main`, () => {
    const block = triggerBlock(read(`.github/workflows/${file}`), 'workflow_run');
    assert.match(block, /workflows: \[('?)tests\1\]/);
    assert.match(block, /\n {4}branches-ignore: \[main\]/);
    // Un filtro positivo `branches:` taglierebbe i branch delle PR.
    assert.doesNotMatch(block, /\n {4}branches:/);
  });
}

test('enable-native-automerge: la guardia distingue main dal branch di una PR', () => {
  const src = read('.github/workflows/enable-native-automerge.yml');
  const block = triggerBlock(src, 'workflow_run');
  assert.match(block, /workflows: \[tests\]/);
  assert.doesNotMatch(block, /\n {4}branches-ignore:/);
  assert.match(src, /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/);
  assert.match(src, /github\.event\.workflow_run\.head_repository\.full_name != ''/);
  assert.match(src, /github\.event\.workflow_run\.event == 'push'/);
  assert.match(src, /github\.event\.workflow_run\.event == 'workflow_dispatch'/);
  assert.match(src, /github\.event\.workflow_run\.head_branch == github\.event\.repository\.default_branch/);
});

test('review-quota-rescuer: niente filtro branches (i fixer sorgente girano su main)', () => {
  const src = read('.github/workflows/review-quota-rescuer.yml');
  const block = triggerBlock(src, 'workflow_run');
  assert.doesNotMatch(block, /branches/);
  assert.match(src, /\n {2}schedule:\n/);
});

test('review-quota-rescuer: salta tests su push e dispatch su main, non cron/dispatch utili', () => {
  const src = read('.github/workflows/review-quota-rescuer.yml');
  const job = src.slice(src.indexOf('\n  rescue:\n'));
  const cond = job.match(/\n {4}if: >-\n((?: {6}.+\n)+)/)[1].replace(/\s+/g, ' ').trim();
  assert.equal(cond,
    "github.event_name != 'workflow_run' || (github.event.workflow_run.conclusion != 'skipped' && "
    + "github.event.workflow_run.conclusion != 'cancelled' && "
    + "!(github.event.workflow_run.path == '.github/workflows/tests.yml' && (github.event.workflow_run.event == 'push' || "
    + "(github.event.workflow_run.event == 'workflow_dispatch' && "
    + "github.event.workflow_run.head_branch == 'main'))))");
});

test('review-quota-rescuer: il Follow-up drainer non e\' una sorgente (non libera slot di review)', () => {
  const block = triggerBlock(read('.github/workflows/review-quota-rescuer.yml'), 'workflow_run');
  assert.doesNotMatch(block, /\n {6}- Follow-up drainer/);
  assert.match(block, /\n {6}- Issue fix \(Codex Luna Max → PR\)\n/);
});

test('review-quota-rescuer: concurrency a livello di job, cosi\' un job saltato non sfratta la pending', () => {
  const src = read('.github/workflows/review-quota-rescuer.yml');
  assert.doesNotMatch(src, /^concurrency:/m);
  const job = src.slice(src.indexOf('\n  rescue:\n'));
  assert.match(job, /\n {4}concurrency:\n {6}group: review-quota-rescuer\n {6}cancel-in-progress: false\n/);
});

test('orphan-push-warn: push esclude main e i branch ledger dei bot', () => {
  const block = triggerBlock(read('.github/workflows/orphan-push-warn.yml'), 'push');
  assert.match(block, /branches-ignore: \[main, 'ledger\/\*\*'\]/);
});
