import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  canMintQueueLabel,
  isValidRawIssueLabels,
  parseIssueJson,
  parseOpenFollowupPages,
} from '../../scripts/ci/gate-minted-followups.mjs';

const DAY = '2026-09-19';
const TITLE = `follow-up(daily:${DAY}): 1 item — owner/repo`;
const ITEM = [
  `### FU-${DAY}-001 — queue candidate`,
  '- State: open',
  '- Target repository: owner/repo',
  '- Target file: scripts/example.mjs',
  '- Sources: PR #123',
  '- Suggested action: verificare `firstGuard()` in scripts/example.mjs',
  '- Acceptance token: `firstGuard()`',
].join('\n');
const SEALED_BODY = ['State: sealed', '', '## Origine', '- PR: #123', '', '## Item', ITEM, ''].join('\n');
const COLLECTING_BODY = SEALED_BODY.replace('State: sealed', 'State: collecting');
const DEMOTE_BODY = [
  'State: collecting',
  '',
  '## Origine',
  '- PR: #123',
  '',
  '## Item',
  ITEM,
  '',
  `### FU-${DAY}-002 — missing acceptance`,
  '- State: open',
  '- Target repository: owner/repo',
  '- Target file: scripts/example.mjs',
  '- Sources: PR #123',
  '- Suggested action: controllare scripts/example.mjs',
  '',
].join('\n');

const FOLLOWUP = { name: 'follow-up', color: '0366d6' };
const NEEDS_HUMAN = { name: 'needs-human', color: 'b60205' };

test('il parser dei label conserva il raw ma rifiuta metadata mancanti/malformati', () => {
  const valid = { number: 1, title: 'x', body: 'y', labels: [FOLLOWUP, 'custom'] };
  assert.equal(isValidRawIssueLabels(valid.labels), true);
  assert.deepEqual(parseIssueJson(JSON.stringify(valid)).labels, valid.labels);
  assert.equal(parseIssueJson(JSON.stringify({ ...valid, number: 0 })), null);
  assert.equal(parseIssueJson(JSON.stringify({ ...valid, number: -1 })), null);
  assert.equal(parseIssueJson(JSON.stringify({ ...valid, number: 1.5 })), null);
  assert.equal(parseIssueJson(JSON.stringify({ ...valid, number: undefined })), null);
  assert.equal(parseIssueJson(JSON.stringify({ ...valid, labels: undefined })), null);
  assert.equal(parseIssueJson(JSON.stringify({ ...valid, labels: [{}] })), null);
  assert.equal(parseIssueJson(JSON.stringify({ ...valid, labels: [null] })), null);
  assert.equal(parseIssueJson(JSON.stringify({ ...valid, labels: ['  '] })), null);
  assert.equal(canMintQueueLabel(valid), true);
  assert.equal(canMintQueueLabel({ ...valid, labels: [FOLLOWUP, NEEDS_HUMAN] }), false);
  assert.equal(canMintQueueLabel({ ...valid, labels: [FOLLOWUP, { name: 'Needs-Human' }] }), false);
  assert.equal(canMintQueueLabel({ ...valid, labels: [{}] }), false);
  assert.equal(canMintQueueLabel({ ...valid, labels: [''] }), false);
  assert.equal(parseOpenFollowupPages(JSON.stringify([[{ ...valid, state: 'open' }]])).at(0).labels[0].name, 'follow-up');
  assert.equal(parseOpenFollowupPages(JSON.stringify([[{ ...valid, state: 'open', labels: [{}] }]])), null);
});

function runGate({
  body,
  listLabels,
  viewLabels = listLabels,
  viewMode = 'same',
  triageComplete = 'true',
  collectionOk = 'false',
}) {
  const root = mkdtempSync(join(tmpdir(), 'followup-mint-queue-label-'));
  const calls = join(root, 'calls');
  const views = join(root, 'views');
  const state = join(root, 'state.json');
  const shim = join(root, 'gh');
  const issue = { number: 8944, title: TITLE, body, createdAt: '2026-09-19T06:36:00Z' };
  writeFileSync(calls, '');
  writeFileSync(views, '0');
  writeFileSync(state, JSON.stringify({ ...issue, ...(viewLabels === null ? {} : { labels: viewLabels }) }));
  writeFileSync(shim, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const issue = ${JSON.stringify(issue)};
const listLabels = ${JSON.stringify(listLabels)};
const viewLabels = ${JSON.stringify(viewLabels)};
const viewMode = ${JSON.stringify(viewMode)};
const statePath = process.env.TEST_GH_STATE;
const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const writeState = (value) => fs.writeFileSync(statePath, JSON.stringify(value));
fs.appendFileSync(process.env.TEST_GH_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'api') {
  console.log(JSON.stringify([[{ number: issue.number, title: issue.title, state: 'open', labels: listLabels }]]));
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'view') {
  const viewCount = Number(fs.readFileSync(process.env.TEST_GH_VIEWS, 'utf8') || '0');
  fs.writeFileSync(process.env.TEST_GH_VIEWS, String(viewCount + 1));
  const response = readState();
  if ((viewMode === 'missing-on-second' && viewCount > 0)
      || (viewMode === 'missing-on-third' && viewCount > 1)) delete response.labels;
  else if ((viewMode === 'missing-number-on-second' && viewCount > 0)
      || (viewMode === 'missing-number-on-third' && viewCount > 1)) delete response.number;
  else if ((viewMode === 'zero-number-on-second' && viewCount > 0)
      || (viewMode === 'zero-number-on-third' && viewCount > 1)) response.number = 0;
  else if ((viewMode === 'mismatch-number-on-second' && viewCount > 0)
      || (viewMode === 'mismatch-number-on-third' && viewCount > 1)) response.number = 8945;
  else if ((viewMode === 'malformed-on-second' && viewCount > 0)
      || (viewMode === 'malformed-on-third' && viewCount > 1)) response.labels = [{}];
  else if (viewMode === 'changed-on-third' && viewCount > 1) response.labels = [...viewLabels, { name: 'agent:fix-queued' }];
  else if (viewMode === 'mutate-after-decision' && viewCount > 0) response.labels = [...viewLabels, { name: 'needs-human' }];
  else if (viewMode === 'remove-followup-after-decision' && viewCount > 0) response.labels = [];
  else if (viewLabels === null) delete response.labels;
  else if (viewMode !== 'mutate-after-body') response.labels = viewLabels;
  console.log(JSON.stringify(response));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'view') {
  console.log(JSON.stringify({ comments: [{ body: '## Post-merge follow-up triage\\n- Daily bucket: #8944' }] }));
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'edit' && args.includes('--body-file')) {
  const updated = readState();
  const bodyIndex = args.indexOf('--body-file');
  const titleIndex = args.indexOf('--title');
  updated.body = fs.readFileSync(args[bodyIndex + 1], 'utf8');
  if (titleIndex >= 0) updated.title = args[titleIndex + 1];
  if (viewMode === 'mutate-after-body') updated.labels = [...(updated.labels || []), { name: 'needs-human' }];
  writeState(updated);
  process.exit(0);
}
if ((args[0] === 'issue' || args[0] === 'pr') && (args[1] === 'edit' || args[1] === 'comment')) process.exit(0);
process.exit(66);
`);
  chmodSync(shim, 0o755);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/ci/gate-minted-followups.mjs', import.meta.url))], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      GH_REPO: 'owner/repo',
      GATE_PR_REPO: 'owner/repo',
      TEST_GH_CALLS: calls,
      TEST_GH_VIEWS: views,
      TEST_GH_STATE: state,
      BATCH_PRS: '',
      TRIAGE_COMPLETE: triageComplete,
      COLLECTION_OK: collectionOk,
      DRY_RUN: '',
      GITHUB_STEP_SUMMARY: '',
    },
  });
  const recorded = readFileSync(calls, 'utf8').trim();
  const parsedCalls = recorded ? recorded.split('\n').map((line) => JSON.parse(line)) : [];
  return { result, calls: parsedCalls, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function hasQueueMutation(calls) {
  return calls.some((args) => args.includes('--add-label') && args.includes('agent:fix-queued'));
}

function hasBodyMutation(calls) {
  return calls.some((args) => args[0] === 'issue' && args[1] === 'edit' && args.includes('--body-file'));
}

test('il ramo keep accoda solo con label raw verificabili e senza needs-human', () => {
  const allowed = runGate({ body: SEALED_BODY, listLabels: [FOLLOWUP] });
  try {
    assert.equal(allowed.result.status, 0, allowed.result.stdout + allowed.result.stderr);
    assert.equal(hasQueueMutation(allowed.calls), true);
  } finally {
    allowed.cleanup();
  }

  const vetoed = runGate({ body: SEALED_BODY, listLabels: [FOLLOWUP, NEEDS_HUMAN] });
  try {
    assert.equal(vetoed.result.status, 0, vetoed.result.stdout + vetoed.result.stderr);
    assert.equal(hasQueueMutation(vetoed.calls), false);
    assert.match(vetoed.result.stdout, /needs-human-veto/);
  } finally {
    vetoed.cleanup();
  }

  const malformed = runGate({ body: SEALED_BODY, listLabels: [FOLLOWUP], viewLabels: [{}] });
  try {
    assert.equal(malformed.result.status, 0, malformed.result.stdout + malformed.result.stderr);
    assert.equal(hasQueueMutation(malformed.calls), false);
    assert.doesNotMatch(malformed.result.stdout, /queue label negata/);
  } finally {
    malformed.cleanup();
  }
});

test('il sealing non riusa lo snapshot quando la lettura latest perde labels', () => {
  const missing = runGate({
    body: COLLECTING_BODY,
    listLabels: [FOLLOWUP],
    viewLabels: [FOLLOWUP],
    viewMode: 'missing-on-third',
    collectionOk: 'true',
  });
  try {
    assert.equal(missing.result.status, 0, missing.result.stdout + missing.result.stderr);
    assert.equal(hasQueueMutation(missing.calls), false);
    assert.equal(missing.calls.some((args) => args[0] === 'issue' && args[1] === 'edit' && args.includes('--body-file')), false);
    assert.match(missing.result.stdout, /body cambiato\/non leggibile prima del sealing/);
  } finally {
    missing.cleanup();
  }

  const malformed = runGate({
    body: COLLECTING_BODY,
    listLabels: [FOLLOWUP],
    viewLabels: [FOLLOWUP],
    viewMode: 'malformed-on-third',
    collectionOk: 'true',
  });
  try {
    assert.equal(malformed.result.status, 0, malformed.result.stdout + malformed.result.stderr);
    assert.equal(hasQueueMutation(malformed.calls), false);
    assert.equal(malformed.calls.some((args) => args[0] === 'issue' && args[1] === 'edit' && args.includes('--body-file')), false);
  } finally {
    malformed.cleanup();
  }

  const changed = runGate({
    body: COLLECTING_BODY,
    listLabels: [FOLLOWUP],
    viewLabels: [FOLLOWUP],
    viewMode: 'changed-on-third',
    collectionOk: 'true',
  });
  try {
    assert.equal(changed.result.status, 0, changed.result.stdout + changed.result.stderr);
    assert.equal(hasQueueMutation(changed.calls), false);
    assert.equal(changed.calls.some((args) => args[0] === 'issue' && args[1] === 'edit' && args.includes('--body-file')), false);
    assert.match(changed.result.stdout, /body cambiato\/non leggibile prima del sealing/);
  } finally {
    changed.cleanup();
  }
});

test('il ramo demote conserva la scrittura ma nega la sola coda a needs-human', () => {
  const result = runGate({ body: DEMOTE_BODY, listLabels: [FOLLOWUP, NEEDS_HUMAN], collectionOk: 'true' });
  try {
    assert.equal(result.result.status, 0, result.result.stdout + result.result.stderr);
    assert.equal(hasQueueMutation(result.calls), false);
    assert.equal(result.calls.some((args) => args[0] === 'pr' && args[1] === 'comment'), true);
    assert.match(result.result.stdout, /needs-human-veto/);
  } finally {
    result.cleanup();
  }
});

test('la rilettura finale scarta una mutazione fra decisione/body-write e queue in tutti i rami', () => {
  const keep = runGate({
    body: SEALED_BODY,
    listLabels: [FOLLOWUP],
    viewLabels: [FOLLOWUP],
    viewMode: 'mutate-after-decision',
  });
  try {
    assert.equal(keep.result.status, 0, keep.result.stdout + keep.result.stderr);
    assert.equal(hasQueueMutation(keep.calls), false);
    assert.equal(hasBodyMutation(keep.calls), false);
    assert.match(keep.result.stdout, /latest-snapshot-stale/);
  } finally {
    keep.cleanup();
  }

  const seal = runGate({
    body: COLLECTING_BODY,
    listLabels: [FOLLOWUP],
    viewLabels: [FOLLOWUP],
    viewMode: 'mutate-after-body',
    collectionOk: 'true',
  });
  try {
    assert.equal(seal.result.status, 0, seal.result.stdout + seal.result.stderr);
    assert.equal(hasQueueMutation(seal.calls), false);
    assert.equal(hasBodyMutation(seal.calls), true);
    assert.match(seal.result.stdout, /latest-snapshot-stale/);
  } finally {
    seal.cleanup();
  }

  const demote = runGate({
    body: DEMOTE_BODY,
    listLabels: [FOLLOWUP],
    viewLabels: [FOLLOWUP],
    viewMode: 'mutate-after-body',
    collectionOk: 'true',
  });
  try {
    assert.equal(demote.result.status, 0, demote.result.stdout + demote.result.stderr);
    assert.equal(hasQueueMutation(demote.calls), false);
    assert.equal(hasBodyMutation(demote.calls), true);
    assert.match(demote.result.stdout, /latest-snapshot-stale/);
  } finally {
    demote.cleanup();
  }
});

test('una follow-up rimossa fra decisione e rilettura finale non viene riaccodata', () => {
  const result = runGate({
    body: SEALED_BODY,
    listLabels: [FOLLOWUP],
    viewLabels: [FOLLOWUP],
    viewMode: 'remove-followup-after-decision',
  });
  try {
    assert.equal(result.result.status, 0, result.result.stdout + result.result.stderr);
    assert.equal(hasQueueMutation(result.calls), false);
    assert.match(result.result.stdout, /latest-snapshot-stale/);
  } finally {
    result.cleanup();
  }
});

test('la rilettura finale rifiuta numero issue mancante, nullo o diverso', () => {
  for (const viewMode of ['missing-number-on-second', 'zero-number-on-second', 'mismatch-number-on-second']) {
    const result = runGate({
      body: SEALED_BODY,
      listLabels: [FOLLOWUP],
      viewLabels: [FOLLOWUP],
      viewMode,
    });
    try {
      assert.equal(result.result.status, 0, result.result.stdout + result.result.stderr);
      assert.equal(hasQueueMutation(result.calls), false);
      if (viewMode === 'mismatch-number-on-second') {
        assert.match(result.result.stdout, /latest-snapshot-stale/);
      } else {
        assert.match(result.result.stdout, /latest-snapshot-unverifiable/);
      }
    } finally {
      result.cleanup();
    }
  }
});
