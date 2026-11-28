import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cantonHubRefreshArtifactName,
  createCantonHubRefreshReceipt,
  isExpectedCantonHubRefreshWorkflowPath,
  resolveCantonHubRefreshReceiptCandidate,
  verifyCantonHubRefreshReceipt,
} from '../scripts/lib/canton-hubs/refresh-receipt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repository = 'nanakokyobashi-rgb/frontaliere-articles';
const sourceCommit = '0123456789abcdef0123456789abcdef01234567';
const hubCommit = '89abcdef0123456789abcdef0123456789abcdef';
const runId = '71002003';
const runAttempt = '2';
const sections = ['canton-gr', 'canton-ti'];
const changedPaths = ['content/cantons/canton-gr/hubs/eventi.json'];
const commitMessage = [
  'Refresh canton hubs',
  '',
  `Canton-Hub-Source-Commit: ${sourceCommit}`,
  'Canton-Hub-Source-Verified: true',
  `Canton-Hub-Receipt-Run-Id: ${runId}`,
  `Canton-Hub-Receipt-Run-Attempt: ${runAttempt}`,
  `Canton-Hub-Sections: ${sections.join(',')}`,
].join('\n');

function validReceipt() {
  return createCantonHubRefreshReceipt({
    repository,
    eventName: 'workflow_run',
    runId,
    runAttempt,
    sourceCommit,
    hubCommit,
    sections,
    sourceVerified: true,
  });
}

function validMetadata() {
  return {
    id: Number(runId),
    node_id: 'WFR_kwLOBxY8A84AAAAB',
    run_attempt: Number(runAttempt),
    run_number: 4821,
    name: 'Refresh Canton Hubs',
    path: '.github/workflows/refresh-canton-hubs.yml@main',
    event: 'workflow_run',
    status: 'completed',
    head_branch: 'main',
    head_sha: hubCommit,
    conclusion: 'success',
    workflow_id: 231005001,
    repository: { full_name: repository },
    artifacts_url: `https://api.github.com/repos/${repository}/actions/runs/${runId}/artifacts`,
  };
}

function verify(overrides = {}) {
  return verifyCantonHubRefreshReceipt({
    receipt: validReceipt(),
    runMetadata: validMetadata(),
    repository,
    runId,
    runAttempt,
    publisherSourceCommit: hubCommit,
    commitMessage,
    publisherChangedPaths: changedPaths,
    ...overrides,
  });
}

test('receipt candidate is only a hub-only workflow_run pointer and names run plus attempt', () => {
  const candidate = resolveCantonHubRefreshReceiptCandidate({
    eventName: 'workflow_run', changedPaths, commitMessage, publisherSourceCommit: hubCommit,
  });
  assert.equal(candidate.candidate, true);
  assert.equal(candidate.runId, runId);
  assert.equal(candidate.runAttempt, runAttempt);
  assert.equal(candidate.artifactName, `canton-hub-refresh-proof-${runId}-${runAttempt}`);
  assert.notEqual(cantonHubRefreshArtifactName(runId, '1'), candidate.artifactName);
  assert.notEqual(cantonHubRefreshArtifactName('71002004', runAttempt), candidate.artifactName);
  assert.equal(resolveCantonHubRefreshReceiptCandidate({
    eventName: 'workflow_run',
    changedPaths: ['content/blog-body-canton-ti/it/new.ts'],
    commitMessage,
    publisherSourceCommit: hubCommit,
  }).candidate, false);
  assert.equal(resolveCantonHubRefreshReceiptCandidate({
    eventName: 'push', changedPaths, commitMessage, publisherSourceCommit: hubCommit,
  }).candidate, false);
  assert.throws(() => cantonHubRefreshArtifactName('bad', runAttempt));
});

test('exact artifact receipt and exact GitHub run attempt authenticate the commit marker', () => {
  assert.deepEqual(verify(), { verified: true, reason: 'authenticated-run-artifact-and-commit' });
  assert.equal(isExpectedCantonHubRefreshWorkflowPath('.github/workflows/refresh-canton-hubs.yml@refs/heads/main'), true);
});

test('forged, stale, cross-run, and cross-attempt proof data all fail closed', () => {
  const receipt = validReceipt();
  const metadata = validMetadata();
  const mismatches = [
    { runMetadata: null },
    { runMetadata: { ...metadata, id: Number(runId) + 1 } },
    { runMetadata: { ...metadata, run_attempt: 1 } },
    { runMetadata: { ...metadata, repository: { full_name: 'attacker/other-repo' } } },
    { runMetadata: { ...metadata, name: 'Other workflow' } },
    { runMetadata: { ...metadata, path: '.github/workflows/other.yml@main' } },
    { runMetadata: { ...metadata, path: '.github/workflows/refresh-canton-hubs.yml@feature' } },
    { runMetadata: { ...metadata, path: '.github/workflows/refresh-canton-hubs.yml' } },
    { runMetadata: { ...metadata, event: 'push' } },
    { runMetadata: { ...metadata, head_branch: 'feature' } },
    { runMetadata: { ...metadata, conclusion: 'failure' } },
    { runMetadata: { ...metadata, conclusion: null } },
    { runId: String(Number(runId) + 1) },
    { runAttempt: '1' },
    { receipt: { ...receipt, runId: String(Number(runId) + 1) } },
    { receipt: { ...receipt, runAttempt: '1' } },
    { receipt: { ...receipt, repository: 'attacker/other-repo' } },
    { receipt: { ...receipt, workflowPath: '.github/workflows/other.yml' } },
    { receipt: { ...receipt, hubCommit: sourceCommit } },
    { receipt: { ...receipt, sourceCommit: hubCommit } },
    { receipt: { ...receipt, sections: ['canton-gr'] } },
    { receipt: { ...receipt, sourceVerified: false } },
    { receipt: { ...receipt, unexpected: 'forged' } },
    { publisherSourceCommit: sourceCommit },
    { publisherChangedPaths: ['content/cantons/canton-ti/hubs/eventi.json', 'generator/scripts/generate-canton-hubs.mjs'] },
    { commitMessage: commitMessage.replace(`Receipt-Run-Attempt: ${runAttempt}`, 'Receipt-Run-Attempt: 1') },
  ];
  for (const mismatch of mismatches) {
    assert.equal(verify(mismatch).verified, false, JSON.stringify(Object.keys(mismatch)));
  }
});

test('receipt cannot be created for unverified, malformed, or non-workflow-run sources', () => {
  const base = {
    repository,
    eventName: 'workflow_run',
    runId,
    runAttempt,
    sourceCommit,
    hubCommit,
    sections,
    sourceVerified: true,
  };
  assert.throws(() => createCantonHubRefreshReceipt({ ...base, sourceVerified: false }));
  assert.throws(() => createCantonHubRefreshReceipt({ ...base, eventName: 'push' }));
  assert.throws(() => createCantonHubRefreshReceipt({ ...base, runAttempt: '0' }));
  assert.throws(() => createCantonHubRefreshReceipt({ ...base, sections: ['canton-ti', 'canton-ti'] }));
});

test('receipt writer serializes the exact committed run attempt and source scope', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'canton-hub-refresh-receipt-writer-'));
  try {
    const outputPath = path.join(fixture, 'proof', 'receipt.json');
    execFileSync(process.execPath, [path.join(ROOT, 'generator/scripts/write-canton-hub-refresh-receipt.mjs')], {
      env: {
        ...process.env,
        GITHUB_REPOSITORY: repository,
        GITHUB_RUN_ID: runId,
        GITHUB_RUN_ATTEMPT: runAttempt,
        EVENT_NAME: 'workflow_run',
        HUB_REFRESH_SOURCE_COMMIT: sourceCommit,
        HUB_REFRESH_COMMIT: hubCommit,
        HUB_REFRESH_SECTIONS: sections.join(','),
        HUB_REFRESH_SOURCE_VERIFIED: 'true',
        RECEIPT_OUTPUT_PATH: outputPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), validReceipt());
    assert.throws(() => execFileSync(process.execPath, [path.join(ROOT, 'generator/scripts/write-canton-hub-refresh-receipt.mjs')], {
      env: {
        ...process.env,
        GITHUB_REPOSITORY: repository,
        GITHUB_RUN_ID: runId,
        GITHUB_RUN_ATTEMPT: '1',
        EVENT_NAME: 'workflow_run',
        HUB_REFRESH_SOURCE_COMMIT: sourceCommit,
        HUB_REFRESH_COMMIT: hubCommit,
        HUB_REFRESH_SECTIONS: sections.join(','),
        HUB_REFRESH_SOURCE_VERIFIED: 'true',
        RECEIPT_OUTPUT_PATH: outputPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('workflow uploads before push and downloads the proof by exact run and attempt-scoped name', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/refresh-canton-hubs.yml'), 'utf8');
  const testSource = fs.readFileSync(path.join(ROOT, 'generator/scripts/resolve-canton-hub-refresh-proof.mjs'), 'utf8');
  const stepNames = [...workflow.matchAll(/^      - name: (.+)$/gm)].map((match) => ({ name: match[1], index: match.index }));
  const stepIndex = (name) => stepNames.find((step) => step.name === name)?.index ?? -1;
  assert.ok(stepIndex('Commit canton hubs') < stepIndex('Upload authenticated hub refresh proof'));
  assert.ok(stepIndex('Upload authenticated hub refresh proof') < stepIndex('Push canton hubs'));
  assert.match(workflow, /name: canton-hub-refresh-proof-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(workflow, /name: \$\{\{ steps\.receipt_candidate\.outputs\.artifact_name \}\}/);
  assert.match(workflow, /run-id: \$\{\{ steps\.receipt_candidate\.outputs\.run_id \}\}/);
  assert.match(workflow, /RECEIPT_RUN_ATTEMPT: \$\{\{ steps\.receipt_candidate\.outputs\.run_attempt \}\}/);
  assert.match(workflow, /actions\/runs\/\$RECEIPT_RUN_ID\/attempts\/\$RECEIPT_RUN_ATTEMPT/);
  assert.match(workflow, /timeout 20s gh api --method GET/);
  assert.match(workflow, /HUB_RECEIPT_VERIFIED: \$\{\{ steps\.receipt_verification\.outputs\.verified \}\}/);
  assert.match(workflow, /retention-days: 90/);
  assert.match(testSource, /process\.exit\(0\)/);
  assert.doesNotMatch(workflow, /Canton-Hub-Receipt-Run-Attempt:[^\n]*github\.event\.workflow_run/);
  const pushBlock = workflow.slice(stepIndex('Push canton hubs'), stepIndex('Summary'));
  assert.match(pushBlock, /if ! bash scripts\/lib\/rebase-onto-remote\.sh/);
  assert.match(pushBlock, /HUB_REFRESH_SOURCE_VERIFIED.*?verify-canton-hub-proof-head\.mjs/s);
  assert.doesNotMatch(pushBlock, /rebase-onto-remote\.sh[\s\S]*\|\| true/);
});

test('non-fast-forward rebase changes the receipt-bound SHA and is rejected before retry push', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'canton-hub-proof-non-ff-'));
  try {
    const git = (args) => execFileSync('git', args, {
      cwd: fixture,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    git(['init', '--quiet', '-b', 'main']);
    git(['config', 'user.name', 'Workflow Fixture']);
    git(['config', 'user.email', 'workflow-fixture@example.invalid']);
    fs.writeFileSync(path.join(fixture, 'README.md'), 'base\n');
    git(['add', 'README.md']);
    git(['commit', '--quiet', '-m', 'base']);
    git(['branch', 'upstream/main']);

    const hubPath = 'content/cantons/canton-ti/hubs/eventi.json';
    fs.mkdirSync(path.dirname(path.join(fixture, hubPath)), { recursive: true });
    fs.writeFileSync(path.join(fixture, hubPath), '{"section":"canton-ti"}\n');
    git(['add', hubPath]);
    git(['commit', '--quiet', '-m', 'verified hub commit']);
    const receiptCommit = git(['rev-parse', 'HEAD']);

    git(['switch', '--quiet', 'upstream/main']);
    fs.writeFileSync(path.join(fixture, 'publisher-code.js'), 'export const value = 1;\n');
    git(['add', 'publisher-code.js']);
    git(['commit', '--quiet', '-m', 'remote main advance']);
    git(['switch', '--quiet', 'main']);
    git(['rebase', 'upstream/main']);
    const rebasedCommit = git(['rev-parse', 'HEAD']);
    assert.notEqual(rebasedCommit, receiptCommit, 'il rebase non-FF riscrive la SHA del commit con receipt');

    const headGate = path.join(ROOT, 'scripts/ci/verify-canton-hub-proof-head.mjs');
    assert.throws(() => execFileSync(process.execPath, [headGate], {
      cwd: fixture,
      env: { ...process.env, HUB_REFRESH_COMMIT: receiptCommit },
      stdio: ['ignore', 'pipe', 'pipe'],
    }), (error) => error.status === 1 && String(error.stderr).includes('diverso dal commit autenticato'));
    assert.doesNotThrow(() => execFileSync(process.execPath, [headGate], {
      cwd: fixture,
      env: { ...process.env, HUB_REFRESH_COMMIT: rebasedCommit },
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
