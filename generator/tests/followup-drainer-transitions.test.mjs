import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  ensureLabel,
  MAX_LABEL_DESCRIPTION_LENGTH,
  UNPARKED_LABEL_DESCRIPTION,
} from '../../scripts/ci/followup-drainer.mjs';

const DRAINER_SRC = new URL('../../scripts/ci/followup-drainer.mjs', import.meta.url);
const src = readFileSync(DRAINER_SRC, 'utf8');

/** Simula le due mutazioni non atomiche del close senza chiamare GitHub. */
function simulateClose({ closeSucceeds, cleanupSucceeds = true }) {
  const issue = { open: true, labels: new Set(['fu-parked']), events: [] };
  issue.labels.add('fu-resolved-auto');
  issue.events.push('add resolved-auto');
  if (!closeSucceeds) {
    issue.events.push('close failed');
    return issue;
  }
  issue.open = false;
  issue.events.push('close');
  if (cleanupSucceeds) {
    issue.labels.delete('fu-parked');
    issue.events.push('remove parked');
  } else {
    issue.events.push('cleanup failed');
  }
  issue.events.push('comment');
  return issue;
}

const selectedByVerdictExit = (issue) => issue.open && issue.labels.has('fu-parked');

test('la descrizione UNPARKED resta entro il limite GitHub', () => {
  assert.ok(UNPARKED_LABEL_DESCRIPTION.length <= MAX_LABEL_DESCRIPTION_LENGTH);
});

test('UNPARK verifica provisioning/edit prima di memo, successo e commento', () => {
  const branch = src.slice(
    src.indexOf('if ((outcome === null || deliveredParked) && !isUnparkedOnce(iss)) {'),
    src.indexOf('const d = verdictExitDecision(outcome, {'),
  );
  assert.match(branch, /if \(labelStatus === 'failed'\)/);
  assert.ok(branch.indexOf("if (labelStatus === 'failed')") < branch.indexOf('unparkLabelEnsured = true'));
  assert.ok(branch.indexOf('edit(iss.number') < branch.lastIndexOf('succeeded++'));
  assert.ok(branch.lastIndexOf('succeeded++') < branch.indexOf('commentIssue('));
  assert.match(branch, /attempted\+\+/);
});

test('close, flag ed escalate commentano solo dopo edit confermato', () => {
  const verdict = src.slice(
    src.indexOf('const d = verdictExitDecision(outcome, {'),
    src.indexOf('// --- TOO-LARGE ESCALATION'),
  );
  const branchEnds = ["if (d.action === 'flag')", '// escalate', 'if (succeeded) console.log'];
  for (const [index, marker] of ["if (d.action === 'close')", "if (d.action === 'flag')", '// escalate'].entries()) {
    const start = verdict.indexOf(marker);
    assert.ok(start >= 0, `branch ${marker} non trovato`);
    const branch = verdict.slice(start, verdict.indexOf(branchEnds[index], start));
    const edit = branch.indexOf('edit(iss.number');
    const comment = branch.indexOf("gh(['issue', 'comment'");
    assert.ok(edit >= 0, `edit del branch ${marker} non trovato`);
    if (comment >= 0) assert.ok(edit < comment, `commento anticipato nel branch ${marker}`);
  }
});

test('close mantiene fu-parked se fallisce e commenta solo dopo la close', () => {
  const closeBranch = src.slice(
    src.indexOf("if (d.action === 'close')"),
    src.indexOf("if (d.action === 'flag')"),
  );
  const addResolved = closeBranch.indexOf("edit(iss.number, { add: [LBL_RESOLVED_AUTO], remove: [] })");
  const close = closeBranch.indexOf('closeIssue(iss.number');
  const cleanup = closeBranch.indexOf('const parkedCleanup');
  const comment = closeBranch.indexOf('commentIssue(iss.number');
  assert.ok(addResolved >= 0);
  assert.ok(addResolved < close);
  assert.ok(close < cleanup);
  assert.ok(cleanup < comment);
  assert.match(closeBranch, /cleanup \$\{LBL_PARKED\} fallito/);
  assert.match(closeBranch, /'fu-parked fallito'/);

  const failed = simulateClose({ closeSucceeds: false });
  assert.equal(failed.open, true);
  assert.equal(failed.labels.has('fu-parked'), true);
  assert.equal(selectedByVerdictExit(failed), true);
  assert.equal(failed.events.includes('comment'), false);

  const happy = simulateClose({ closeSucceeds: true });
  assert.equal(happy.open, false);
  assert.equal(happy.labels.has('fu-parked'), false);
  assert.deepEqual(happy.events, ['add resolved-auto', 'close', 'remove parked', 'comment']);
});

test('sibling-debt e data-pending non memoizzano provisioning fallito', () => {
  const grouping = src.slice(src.indexOf('function prepareIssueGroup'), src.indexOf('/** Instrada una issue allo stadio di decomposizione'));
  assert.match(grouping, /ensureLabel\(label, '5319e7'/);
  assert.match(grouping, /=== 'failed'\) return null/);

  const sibling = src.slice(
    src.lastIndexOf('// --- SIBLING-DEBT:'),
    src.lastIndexOf('// --- PARKED-RETRY:'),
  );
  assert.match(sibling, /if \(labelStatus === 'failed'\)/);
  assert.ok(sibling.indexOf("if (labelStatus === 'failed')") < sibling.indexOf('ensured = true'));
  assert.match(sibling, /if \(!edit\(iss\.number/);
  assert.ok(sibling.indexOf('edit(iss.number') < sibling.indexOf('commentIssue('));
  assert.match(sibling, /if \(attempted >= SIBLING_DEBT_MAX_PER_RUN\)/);
  assert.match(sibling, /else if \(attempted\) console\.log/);

  const pendingStart = src.indexOf('const dataPending = detectDataPending');
  const dataPending = src.slice(pendingStart, src.indexOf('// Check: secrets-scoped category', pendingStart));
  assert.match(dataPending, /ensureLabel\(LBL_DATA_PENDING/);
  assert.ok(dataPending.indexOf('ensureLabel') < dataPending.indexOf('edit(cand.number'));
  assert.ok(dataPending.indexOf('edit(cand.number') < dataPending.indexOf('commentIssue('));
});

test('VERDICT-EXIT usa attempted per il cap e succeeded per mutazioni riuscite', () => {
  const verdict = src.slice(
    src.indexOf('const parked = listIssues(LBL_PARKED)'),
    src.indexOf('// --- TOO-LARGE ESCALATION'),
  );
  assert.match(verdict, /let attempted = 0;/);
  assert.match(verdict, /let succeeded = 0;/);
  assert.match(verdict, /if \(attempted >= VERDICT_EXIT_MAX_PER_RUN\)/);
  assert.match(verdict, /if \(succeeded\) console\.log/);
  assert.match(verdict, /nessuna transizione confermata dopo \$\{attempted\} tentativi/);
});

test('ensureLabel accetta una description esattamente al limite', () => {
  const calls = [];
  const description = 'x'.repeat(MAX_LABEL_DESCRIPTION_LENGTH);
  const run = (args) => calls.push(args);

  assert.equal(ensureLabel('fu-test', '0e8a16', description, { run, dry: false }), 'created');
  assert.equal(calls.length, 1);
});
