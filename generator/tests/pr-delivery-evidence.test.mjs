import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  DELIVERY_STATUS,
  classifyWorkflowOutcome,
  createDeliveryBaseline,
  evaluatePrDelivery,
  normalizeDeliveryEvidence,
  normalizePrList,
} from '../../scripts/ci/lib/pr-delivery-evidence.mjs';

const REPO = 'nanakokyobashi-rgb/frontaliere-articles';
const BRANCH = 'fix/issue-42';
const RUN = {
  repo: REPO,
  issue: 42,
  branch: BRANCH,
  runId: '35440000000',
  runAttempt: '1',
  runStartedAt: '2026-09-19T10:00:00Z',
};

function pr(overrides = {}) {
  return {
    number: 700,
    state: 'OPEN',
    headRefName: BRANCH,
    headRefOid: 'sha-before',
    headRepository: { nameWithOwner: REPO },
    createdAt: '2026-09-19T09:00:00Z',
    updatedAt: '2026-09-19T09:30:00Z',
    mergedAt: null,
    ...overrides,
  };
}

function baseline(prs = [pr()]) {
  const result = createDeliveryBaseline({ ...RUN, prs });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(result.reason);
  return result.baseline;
}

function evaluate(base, currentPrs, runAttempt = RUN.runAttempt) {
  return evaluatePrDelivery({
    baseline: base,
    currentPrs,
    ...RUN,
    runAttempt,
  });
}

describe('pr-delivery-evidence', () => {
  it('non riporta la vecchia PR merged come delivery del run corrente', () => {
    const oldMergedPr = pr({
      state: 'MERGED',
      headRefOid: 'sha-old',
      updatedAt: '2026-09-19T10:15:00Z',
      mergedAt: '2026-09-18T12:00:00Z',
    });
    const delivery = evaluate(baseline([oldMergedPr]), [oldMergedPr]);
    assert.deepEqual(delivery, {
      status: DELIVERY_STATUS.NONE,
      reason: 'no-current-delivery-evidence',
      prNumber: null,
    });
    assert.deepEqual(classifyWorkflowOutcome({
      actionOutcome: 'failure',
      delivery,
    }), {
      classification: 'non-delivery',
      exitCode: 1,
      reason: 'no-current-delivery-evidence',
    });
  });

  it('prova una nuova PR soltanto se createdAt appartiene al tentativo', () => {
    const current = pr({
      number: 701,
      createdAt: '2026-09-19T10:04:00Z',
      updatedAt: '2026-09-19T10:04:00Z',
    });
    assert.deepEqual(evaluate(baseline(), [current]), {
      status: DELIVERY_STATUS.DELIVERED,
      reason: 'new-pr-this-attempt',
      prNumber: 701,
    });
    const beforeRun = { ...current, createdAt: '2026-09-19T09:59:00Z' };
    assert.equal(evaluate(baseline(), [beforeRun]).status, DELIVERY_STATUS.UNAVAILABLE);
  });

  it('non considera delivery una nuova PR chiusa senza merge', () => {
    const closed = pr({
      number: 702,
      state: 'CLOSED',
      createdAt: '2026-09-19T10:04:00Z',
      updatedAt: '2026-09-19T10:05:00Z',
    });
    assert.deepEqual(evaluate(baseline(), [closed]), {
      status: DELIVERY_STATUS.NONE,
      reason: 'no-current-delivery-evidence',
      prNumber: null,
    });
  });

  it('rifiuta una PR omonima proveniente da un fork', () => {
    const forkPr = pr({
      number: 703,
      headRepository: { nameWithOwner: 'fork-owner/frontaliere-articles' },
      createdAt: '2026-09-19T10:04:00Z',
      updatedAt: '2026-09-19T10:04:00Z',
    });
    assert.deepEqual(evaluate(baseline(), [forkPr]), {
      status: DELIVERY_STATUS.UNAVAILABLE,
      reason: 'pr-head-repository-mismatch',
      prNumber: null,
    });
  });

  it('lega la delivery al cambio di HEAD, non a updatedAt da solo', () => {
    const unchangedHead = pr({ updatedAt: '2026-09-19T10:20:00Z' });
    assert.equal(evaluate(baseline(), [unchangedHead]).status, DELIVERY_STATUS.NONE);
    assert.deepEqual(evaluate(baseline(), [{ ...unchangedHead, headRefOid: 'sha-after' }]), {
      status: DELIVERY_STATUS.DELIVERED,
      reason: 'open-head-changed-this-attempt',
      prNumber: 700,
    });
  });

  it('prova la transizione OPEN -> MERGED solo se mergedAt è nel run', () => {
    const current = pr({
      state: 'MERGED',
      mergedAt: '2026-09-19T10:12:00Z',
      updatedAt: '2026-09-19T10:12:00Z',
    });
    assert.deepEqual(evaluate(baseline(), [current]), {
      status: DELIVERY_STATUS.DELIVERED,
      reason: 'open-to-merged-this-attempt',
      prNumber: 700,
    });
  });

  it('rifiuta un baseline di un attempt diverso', () => {
    assert.deepEqual(evaluate(baseline(), [pr()], '2'), {
      status: DELIVERY_STATUS.UNAVAILABLE,
      reason: 'baseline-runAttempt-mismatch',
      prNumber: null,
    });
  });

  it('non trasforma record malformed o una lista cap in verified-none', () => {
    assert.equal(evaluate(baseline(), [{}]).status, DELIVERY_STATUS.UNAVAILABLE);
    assert.equal(
      normalizePrList(Array.from({ length: 100 }, () => pr()), { branch: BRANCH }).reason,
      'pr-list-capped',
    );
  });

  it('preserva skipped, cancelled e no-op success', () => {
    assert.deepEqual(classifyWorkflowOutcome({
      actionOutcome: 'skipped',
      delivery: { status: DELIVERY_STATUS.UNAVAILABLE },
    }), {
      classification: 'skipped',
      exitCode: 0,
      reason: 'intentional-or-preflight-skip',
    });
    assert.deepEqual(classifyWorkflowOutcome({
      actionOutcome: 'cancelled',
      delivery: { status: DELIVERY_STATUS.UNAVAILABLE },
    }), {
      classification: 'cancelled',
      exitCode: 0,
      reason: 'post-steps-not-guaranteed',
    });
    assert.equal(classifyWorkflowOutcome({
      actionOutcome: 'success',
      delivery: { status: DELIVERY_STATUS.NONE },
    }).exitCode, 0);
    assert.deepEqual(classifyWorkflowOutcome({
      actionOutcome: 'success',
      delivery: {},
    }), {
      classification: 'unknown',
      exitCode: 1,
      reason: 'evidence-status-invalid',
    });
    assert.deepEqual(classifyWorkflowOutcome({
      actionOutcome: 'success',
      delivery: { status: 'future-status' },
    }), {
      classification: 'unknown',
      exitCode: 1,
      reason: 'evidence-status-invalid',
    });
    assert.deepEqual(classifyWorkflowOutcome({
      actionOutcome: 'success',
      delivery: { status: DELIVERY_STATUS.DELIVERED },
    }), {
      classification: 'unknown',
      exitCode: 1,
      reason: 'evidence-pr-number-missing',
    });
  });

  it('rifiuta prNumber coercibili ma non interi espliciti nel sidecar', () => {
    for (const prNumber of [true, [1], 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.deepEqual(normalizeDeliveryEvidence({
        status: DELIVERY_STATUS.DELIVERED,
        prNumber,
      }), {
        status: DELIVERY_STATUS.UNAVAILABLE,
        reason: 'evidence-pr-number-invalid',
        prNumber: null,
      });
    }
    assert.deepEqual(normalizeDeliveryEvidence({
      status: DELIVERY_STATUS.DELIVERED,
      prNumber: '701',
    }), {
      status: DELIVERY_STATUS.DELIVERED,
      reason: null,
      prNumber: 701,
    });
  });

  it('un lookup gh fallito è unavailable, non una lista vuota', () => {
    const temp = mkdtempSync(path.join(tmpdir(), 'pr-delivery-gh-'));
    const baselineFile = path.join(temp, 'baseline.json');
    const fakeGh = path.join(temp, 'gh');
    const helper = fileURLToPath(new URL('../../scripts/ci/lib/pr-delivery-evidence.mjs', import.meta.url));
    try {
      writeFileSync(baselineFile, `${JSON.stringify(baseline())}\n`);
      writeFileSync(fakeGh, '#!/usr/bin/env node\nprocess.exit(42);\n');
      chmodSync(fakeGh, 0o755);
      const output = execFileSync(process.execPath, [helper, 'evaluate',
        '--baseline', baselineFile,
        '--repo', REPO,
        '--issue', '42',
        '--branch', BRANCH,
        '--run-id', RUN.runId,
        '--run-attempt', RUN.runAttempt,
      ], {
        env: { ...process.env, PATH: `${temp}:${process.env.PATH || ''}` },
        encoding: 'utf8',
      });
      assert.deepEqual(JSON.parse(output), {
        status: DELIVERY_STATUS.UNAVAILABLE,
        reason: 'github-read-failed',
        prNumber: null,
      });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('il marker terminale non riusa una PR storica quando la delivery è unavailable', () => {
    const temp = mkdtempSync(path.join(tmpdir(), 'pr-delivery-marker-'));
    const baselineFile = path.join(temp, 'baseline.json');
    const executionFile = path.join(temp, 'execution.json');
    const fakeGh = path.join(temp, 'gh');
    const marker = fileURLToPath(new URL('../../scripts/ci/mark-claude-terminal-outcome.mjs', import.meta.url));
    try {
      writeFileSync(baselineFile, `${JSON.stringify(baseline())}\n`);
      writeFileSync(executionFile, JSON.stringify([{ type: 'result', subtype: 'error_max_turns' }]));
      writeFileSync(fakeGh, '#!/usr/bin/env node\\nprocess.exit(42);\\n');
      chmodSync(fakeGh, 0o755);
      const output = execFileSync(process.execPath, [marker], {
        env: {
          ...process.env,
          PATH: `${temp}:${process.env.PATH || ''}`,
          ISSUE: '42',
          EXEC_FILE: executionFile,
          GH_REPO: REPO,
          GITHUB_RUN_ID: RUN.runId,
          GITHUB_RUN_ATTEMPT: RUN.runAttempt,
          PR_DELIVERY_BASELINE_FILE: baselineFile,
        },
        encoding: 'utf8',
      });
      assert.match(output, /delivery non verificabile/);
      assert.doesNotMatch(output, /marker.*pr-created/);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
