/** Regressioni statiche per l'enrollment nell'auto-merge nativo. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = resolve(ROOT, '.github/workflows/enable-native-automerge.yml');
const source = readFileSync(WORKFLOW, 'utf8');

test('riattiva il gate sugli eventi che possono cambiare review, check o HEAD', () => {
  assert.match(source, /types: \[opened, reopened, ready_for_review, synchronize\]/);
  assert.match(source, /pull_request_review:/);
  assert.match(source, /types: \[submitted, edited, dismissed\]/);
  assert.match(source, /workflow_run:/);
  assert.match(source, /workflows: \[tests\]/);
  assert.match(source, /NATIVE_AUTOMERGE_BOOTSTRAP_READY=false/);
});

test('scarica helper affidabili dal main del corpus e usa il PAT corretto', () => {
  assert.match(source, /generator\/scripts\/load-rc-env\.mjs\?ref=main/);
  assert.match(source, /generator\/scripts\/lib\/google-service-account-token\.mjs\?ref=main/);
  assert.match(source, /scripts\/ci\/native-automerge-gate\.mjs\?ref=main/);
  assert.match(source, /scripts\/ci\/review-test-policy\.mjs\?ref=main/);
  assert.match(source, /scripts\/ci\/lib\/fetchPrFiles\.mjs\?ref=main/);
  assert.match(source, /GITHUB_PAT_NANAKO/);
  assert.doesNotMatch(source, /gh pr merge/);
});

test('la bootstrap incompleta è un no-op, mentre il gate mantiene il fail-closed', () => {
  assert.match(source, /node --check "\$gate_tmp"/);
  assert.match(source, /node --check "\$policy_tmp"/);
  assert.match(source, /node --check "\$files_tmp"/);
  assert.match(source, /if: env\.NATIVE_AUTOMERGE_BOOTSTRAP_READY == 'true'/);
  assert.match(source, /native-automerge-gate\.mjs/);
});
