import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/recycle-stale-prs.yml', import.meta.url), 'utf8');

function recycleStep() {
  const start = workflow.indexOf('- name: Recycle deeply-stale stale-review PRs');
  assert.notEqual(start, -1, 'step stale-review non trovato');
  const rest = workflow.slice(start);
  const next = rest.indexOf('\n      - name: Flag parked draft PRs');
  return next === -1 ? rest : rest.slice(0, next);
}

test('lo scan stale cattura gh --paginate prima di poter chiudere una PR', () => {
  const step = recycleStep();
  const fetchAt = step.indexOf('prs_lines=$(gh api --paginate');
  const rcAt = step.indexOf('PRS_RC=$?', fetchAt);
  const closeAt = step.indexOf('if ! gh pr close');
  assert.ok(fetchAt >= 0 && rcAt > fetchAt && closeAt > rcAt);
  assert.match(step, /if \[ \"\$PRS_RC\" -ne 0 \]; then[\s\S]*?exit 1/);
  assert.match(step, /if ! prs=\$\(printf[\s\S]*?jq -s/);
});

test('il close+re-queue ha un cap misurato e ripartibile', () => {
  const step = recycleStep();
  const capAt = step.indexOf('if [ \"$RECYCLE_ATTEMPTS\" -ge \"$MAX_RECYCLES\" ]');
  const closeAt = step.indexOf('if ! gh pr close');
  assert.ok(capAt >= 0 && capAt < closeAt, 'il cap deve precedere gh pr close --delete-branch');
  const guarded = step.slice(capAt, closeAt);
  assert.match(guarded, /RECYCLE_ATTEMPTS=\$\(\(RECYCLE_ATTEMPTS \+ 1\)\)/);
  assert.match(step, /MAX_RECYCLES_PER_RUN:.*max_recycles/);
  assert.match(workflow, /max_recycles:[\s\S]*default: '5'/);
});
