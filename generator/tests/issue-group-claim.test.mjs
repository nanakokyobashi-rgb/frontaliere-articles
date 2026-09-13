/**
 * Contract tests for the B19 claim boundary in issue-fix.yml.
 * Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github/workflows/issue-fix.yml'), 'utf8');
const SCRIPT = path.join(ROOT, 'scripts/ci/claim-issue-group-in-flight.mjs');

test('issue-fix carica il contesto B19 prima del claim e rilascia solo i numeri reclamati', () => {
  const groupIndex = WORKFLOW.indexOf('- name: Load issue group context (B19, zero-Claude)');
  const claimIndex = WORKFLOW.indexOf('- name: Pre-flight — in-progress claim gate (zero-Claude, mutex)');
  assert.ok(groupIndex >= 0);
  assert.ok(claimIndex > groupIndex, 'il claim deve arrivare dopo il contesto del gruppo');
  assert.match(WORKFLOW.slice(claimIndex, claimIndex + 900), /ISSUE_NUMBERS: \$\{\{ steps\.group\.outputs\.group_numbers \}\}/);
  assert.match(WORKFLOW.slice(claimIndex, claimIndex + 1200), /claim-issue-group-in-flight\.mjs/);
  assert.match(WORKFLOW, /CLAIMED_NUMBERS: \$\{\{ steps\.claim\.outputs\.claimed_numbers \}\}/);
  assert.match(WORKFLOW, /steps\.claim\.outputs\.claim_acquired == 'true'/);
  assert.match(WORKFLOW, /SKIP_GROUP_MEMBER: \$\{\{ steps\.group\.outputs\.skip_member \|\| 'false' \}\}/);
  assert.match(WORKFLOW, /CLAIM_ACTION: release[\s\S]*CLAIM_OWNER: remote/);
  assert.match(WORKFLOW, /run: node scripts\/ci\/claim-issue-group-in-flight\.mjs/);
});

test('un membro B19 non reclama il proprio issue-fix per non correre col leader', () => {
  const run = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      GH_REPO: 'owner/repo',
      ISSUE_NUMBER: '2',
      ISSUE_NUMBERS: '1,2',
      SKIP_GROUP_MEMBER: 'true',
    },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /membro non-leader B19/);
  assert.match(run.stdout, /in_flight=true/);
  assert.match(run.stdout, /claim_acquired=false/);
  assert.match(run.stdout, /claim_owner=group-member/);
});

test('il claim di gruppo è all-or-nothing rispetto a una label già presente', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-group-claim-test-'));
  try {
    const fakeGh = path.join(temp, 'gh');
    const stateFile = path.join(temp, 'state.json');
    const outputFile = path.join(temp, 'output.txt');
    fs.writeFileSync(stateFile, JSON.stringify({
      '1': { labels: [] },
      '2': { labels: [] },
      calls: [],
    }));
    fs.writeFileSync(fakeGh, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = process.env.FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
state.calls.push(args);
if (args[0] === 'issue' && args[1] === 'view') {
  const issue = args[2];
  process.stdout.write(JSON.stringify({ labels: (state[issue] || { labels: [] }).labels.map((name) => ({ name })) }));
} else if (args[0] === 'issue' && args[1] === 'edit') {
  const issue = args[2];
  const labels = state[issue].labels;
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--add-label' && !labels.includes(args[i + 1])) labels.push(args[i + 1]);
    if (args[i] === '--remove-label') state[issue].labels = state[issue].labels.filter((name) => name !== args[i + 1]);
  }
}
fs.writeFileSync(file, JSON.stringify(state));
`);
    fs.chmodSync(fakeGh, 0o755);

    const run = () => spawnSync(process.execPath, [SCRIPT], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${temp}:${process.env.PATH || ''}`,
        FAKE_GH_STATE: stateFile,
        GH_REPO: 'owner/repo',
        ISSUE_NUMBER: '1',
        ISSUE_NUMBERS: '1,2',
        GITHUB_OUTPUT: outputFile,
      },
    });

    const first = run();
    assert.equal(first.status, 0, first.stderr);
    let state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.deepEqual(state['1'].labels, ['agent:in-progress', 'agent:remote']);
    assert.deepEqual(state['2'].labels, ['agent:in-progress', 'agent:remote']);
    assert.match(first.stdout, /in_flight=false/);
    assert.match(first.stdout, /claimed_numbers=1,2/);
    assert.match(first.stdout, /claim_acquired=true/);
    assert.match(first.stdout, /claim_owner=remote/);
    assert.match(first.stdout, /claim_error=false/);

    const second = run();
    assert.equal(second.status, 0, second.stderr);
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.match(second.stdout, /in_flight=true/);
    assert.match(second.stdout, /claimed_numbers=\n/);
    assert.equal(state['1'].labels[0], 'agent:in-progress');
    assert.equal(state['1'].labels[1], 'agent:remote');
    assert.equal(state['2'].labels[0], 'agent:in-progress');
    assert.equal(state['2'].labels[1], 'agent:remote');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('il release remoto rimuove solo il proprio owner e il mutex, non un claim locale', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-group-release-test-'));
  try {
    const fakeGh = path.join(temp, 'gh');
    const stateFile = path.join(temp, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      '1': { labels: ['agent:in-progress', 'agent:remote'] },
      '2': { labels: ['agent:in-progress', 'agent:local'] },
      calls: [],
    }));
    fs.writeFileSync(fakeGh, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = process.env.FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
if (args[0] === 'issue' && args[1] === 'view') {
  const issue = args[2];
  process.stdout.write(JSON.stringify({ labels: state[issue].labels.map((name) => ({ name })) }));
} else if (args[0] === 'issue' && args[1] === 'edit') {
  const issue = args[2];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--remove-label') state[issue].labels = state[issue].labels.filter((name) => name !== args[i + 1]);
  }
}
fs.writeFileSync(file, JSON.stringify(state));
`);
    fs.chmodSync(fakeGh, 0o755);
    const run = spawnSync(process.execPath, [SCRIPT], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${temp}:${process.env.PATH || ''}`,
        FAKE_GH_STATE: stateFile,
        GH_REPO: 'owner/repo',
        ISSUE_NUMBER: '',
        ISSUE_NUMBERS: '',
        CLAIMED_NUMBERS: '1,2',
        CLAIM_ACTION: 'release',
        CLAIM_OWNER: 'remote',
      },
    });
    assert.equal(run.status, 0, run.stderr);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.deepEqual(state['1'].labels, []);
    assert.deepEqual(state['2'].labels, ['agent:in-progress', 'agent:local']);
    assert.match(run.stdout, /claim_owner=remote/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('il workflow del fixer marca la provenienza autonoma della PR', () => {
  assert.match(WORKFLOW, /name: Mark autonomous PR provenance/);
  assert.match(WORKFLOW, /gh pr edit "\$PR_NUMBER" --repo "\$REPO" --add-label agent:autofix/);
  assert.match(WORKFLOW, /CLAIM_ACTION: release[\s\S]*CLAIM_OWNER: remote/);
});
