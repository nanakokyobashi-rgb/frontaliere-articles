/** Regressioni statiche per l'enrollment nell'auto-merge nativo. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = resolve(ROOT, '.github/workflows/enable-native-automerge.yml');
const GATE = resolve(ROOT, 'scripts/ci/native-automerge-gate.mjs');
const source = readFileSync(WORKFLOW, 'utf8');
const gateSource = readFileSync(GATE, 'utf8');

const VITEST_IMPORT_RE = /\bimport\s+(?:[^;\n]+\s+from\s+)?['"]\.\/lib\/vitestCheck\.mjs['"]/;

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
  assert.match(source, /contents\/\$\{path\}\?ref=main/);
  assert.match(source, /'scripts\/ci\/native-automerge-gate\.mjs' "\$gate_tmp"/);
  assert.match(source, /'scripts\/ci\/review-test-policy\.mjs' "\$policy_tmp"/);
  assert.match(source, /'scripts\/ci\/lib\/fetchPrFiles\.mjs' "\$files_tmp"/);
  assert.match(source, /GITHUB_PAT_NANAKO/);
  assert.doesNotMatch(source, /gh pr merge/);
});

test('il gate corrente non trascina vitestCheck come dipendenza hard', () => {
  assert.doesNotMatch(gateSource, VITEST_IMPORT_RE);
  assert.match(source, /gate_requires_vitest=unknown/);
  assert.match(source, /moduleRequests\?\.map\(\(\{ specifier \}\) => specifier\)/);
  assert.match(source, /requests\.includes\('\.\/lib\/vitestCheck\.mjs'\) \? 'true' : 'false'/);
  assert.match(source, /\[ "\$gate_requires_vitest" = false \] \|\| download_and_check/);
});

test('il gate locale accetta il nome review corrente senza import runtime da vitestCheck', async () => {
  const [{ REVIEW_GATE_STEP_NAME: nativeStep, REVIEW_GATE_STEP_NAMES: nativeSteps }, { REVIEW_GATE_STEP_NAME: reviewStep }] =
    await Promise.all([
      import('../../scripts/ci/native-automerge-gate.mjs'),
      import('../../scripts/ci/lib/vitestCheck.mjs'),
    ]);
  assert.ok(nativeSteps.includes(nativeStep));
  assert.ok(nativeSteps.includes(reviewStep));
});

test('un gate futuro con import reale abilita fetch, validazione e installazione della dipendenza', () => {
  const futureGate = `${gateSource}\nimport { REVIEW_GATE_STEP_NAME } from './lib/vitestCheck.mjs';\n`;
  assert.match(futureGate, VITEST_IMPORT_RE);
  assert.match(source, /'scripts\/ci\/lib\/vitestCheck\.mjs' "\$vitest_tmp"/);
  assert.match(source, /node --check "\$destination"/);
  assert.match(source, /if \[ "\$gate_requires_vitest" = true \]; then\s+mv "\$vitest_tmp" "\$helper_dir\/lib\/vitestCheck\.mjs"/);
});

test('la bootstrap resta no-op fail-closed se la dipendenza richiesta non è validabile', () => {
  assert.match(source, /if \{ \[ "\$gate_requires_vitest" = true \] \|\| \[ "\$gate_requires_vitest" = false \]; \}/);
  assert.match(source, /&& \{ \[ "\$gate_requires_vitest" = false \] \|\| download_and_check/);
  assert.match(source, /rm -f "\$gate_tmp" "\$policy_tmp" "\$files_tmp" "\$vitest_tmp"/);
  assert.match(source, /if: env\.NATIVE_AUTOMERGE_BOOTSTRAP_READY == 'true'/);
  assert.match(source, /NATIVE_AUTOMERGE_BOOTSTRAP_READY=false/);
  assert.match(source, /native-automerge-gate\.mjs/);
});

test('la bootstrap valida gli helper comuni prima del mv', () => {
  assert.match(source, /download_and_check \\\n\s+'scripts\/ci\/native-automerge-gate\.mjs' "\$gate_tmp"/);
  assert.match(source, /download_and_check \\\n\s+'scripts\/ci\/review-test-policy\.mjs' "\$policy_tmp"/);
  assert.match(source, /download_and_check \\\n\s+'scripts\/ci\/lib\/fetchPrFiles\.mjs' "\$files_tmp"/);
  assert.match(source, /node --check "\$destination"/);
  assert.match(source, /mv "\$vitest_tmp" "\$helper_dir\/lib\/vitestCheck\.mjs"/);
});
