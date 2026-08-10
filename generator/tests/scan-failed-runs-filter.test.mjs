/**
 * scan-failed-runs-filter.test.mjs — un push fallito su un branch non-main dei
 * gate pre-merge (`tests`, `Generator CI`) non deve aprire una "Workflow
 * Failure": è un'anteprima del `pull_request` che la stessa PR rigirerà, non
 * un segnale nuovo. Misurato: #112, #135, #178 — tre issue fantasma aperte da
 * push su branch (fixer WIP o sviluppo) mai ancora diventati PR.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReportableRun } from '../../scripts/ci/scan-failed-runs.mjs';

const base = { conclusion: 'failure', createdAt: '2026-08-10T00:00:00Z', updatedAt: '2026-08-10T00:00:00Z' };

test('push fallito su tests/Generator CI in preview di una PR non ancora aperta è escluso', () => {
  assert.equal(isReportableRun({ ...base, workflowName: 'tests', event: 'push', headBranch: 'fix/issue-166' }), false);
  assert.equal(
    isReportableRun({ ...base, workflowName: 'Generator CI', event: 'push', headBranch: 'fix/whatever' }),
    false,
  );
});

test('pull_request resta escluso per qualunque workflow (invariante preesistente)', () => {
  assert.equal(isReportableRun({ ...base, workflowName: 'tests', event: 'pull_request', headBranch: 'main' }), false);
});

test('push fallito su un workflow SENZA trigger pull_request gemello resta segnalato', () => {
  assert.equal(
    isReportableRun({ ...base, workflowName: 'batch-faq-articles', event: 'push', headBranch: 'main' }),
    true,
  );
});

test('IGNORE_WORKFLOWS esclude anche un push senza pull_request gemello (parametro ignore rispettato)', () => {
  assert.equal(
    isReportableRun(
      { ...base, workflowName: 'batch-faq-articles', event: 'push', headBranch: 'main' },
      { ignore: new Set(['batch-faq-articles']) },
    ),
    false,
  );
});

test('run non-failure o fuori dalla finestra restano esclusi (invarianti preesistenti)', () => {
  assert.equal(isReportableRun({ ...base, conclusion: 'cancelled', workflowName: 'x', event: 'schedule' }), false);
  assert.equal(
    isReportableRun(
      { ...base, workflowName: 'x', event: 'schedule', updatedAt: '2026-08-09T00:00:00Z' },
      { since: '2026-08-10T00:00:00Z' },
    ),
    false,
  );
});
