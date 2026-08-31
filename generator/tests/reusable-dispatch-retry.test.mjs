import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { classifyReusableDispatchFailure } from '../../scripts/ci/classify-reusable-dispatch-failure.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');

test('ritenta quando GitHub non crea nemmeno il job del reusable workflow', () => {
  assert.deepEqual(classifyReusableDispatchFailure([], 'translate'), {
    beforeLogic: true,
    reason: 'job-record-absent',
  });
});

test('ritenta quando il reusable workflow fallisce nel solo Set up job', () => {
  const jobs = [{
    name: 'translate / translate',
    conclusion: 'failure',
    steps: [{ name: 'Set up job', conclusion: 'failure' }],
  }];
  assert.deepEqual(classifyReusableDispatchFailure(jobs, 'translate'), {
    beforeLogic: true,
    reason: 'runner-setup-only',
  });
});

test('non ritenta quando almeno uno step della logica remota e partito', () => {
  const jobs = [{
    name: 'crawler_group_22 / crawler_group_22',
    conclusion: 'failure',
    steps: [
      { name: 'Set up job', conclusion: 'success' },
      { name: 'Checkout frontaliere-si-o-no (public, read-only)', conclusion: 'success' },
      { name: 'Run fust', conclusion: 'failure' },
    ],
  }];
  assert.deepEqual(classifyReusableDispatchFailure(jobs, 'crawler_group_22'), {
    beforeLogic: false,
    reason: 'logic-started:Checkout frontaliere-si-o-no (public, read-only)',
  });
});

test('il prefisso primario non cattura per errore il job di retry', () => {
  const jobs = [{
    name: 'crawler_group_04_retry / crawler_group_04',
    steps: [{ name: 'Run equans', conclusion: 'failure' }],
  }];
  assert.deepEqual(classifyReusableDispatchFailure(jobs, 'crawler_group_04'), {
    beforeLogic: true,
    reason: 'job-record-absent',
  });
});

test('tutti i 23 crawler group usano classificazione fail-safe e backoff', () => {
  const files = fs.readdirSync(WORKFLOWS)
    .filter((file) => /^crawler-group-\d+\.yml$/.test(file))
    .sort();
  assert.equal(files.length, 23);

  for (const file of files) {
    const nn = /crawler-group-(\d+)\.yml/.exec(file)[1];
    const key = `crawler_group_${nn}`;
    const text = fs.readFileSync(path.join(WORKFLOWS, file), 'utf8');
    assert.match(text, new RegExp(`\\n  ${key}_retry_gate:\\n`), file);
    assert.match(text, new RegExp(`--job-prefix "${key}"[\\s\\S]*--wait-seconds 60`), file);
    assert.match(text, new RegExp(`needs: ${key}_retry_gate\\n    if: always\\(\\) && needs\\.${key}_retry_gate\\.outputs\\.before_logic == 'true'`), file);
    assert.match(text, new RegExp(`--job-prefix "${key}_retry"`), file);
    assert.match(text, /if: steps\.classify\.outputs\.before_logic == 'true'/, file);
  }
});

test('translate-pending applica lo stesso contratto di retry', () => {
  const text = fs.readFileSync(path.join(WORKFLOWS, 'translate-pending.yml'), 'utf8');
  assert.match(text, /\n  translate_retry_gate:\n/);
  assert.match(text, /--job-prefix "translate"[\s\S]*--wait-seconds 60/);
  assert.match(text, /needs: translate_retry_gate\n    if: always\(\) && needs\.translate_retry_gate\.outputs\.before_logic == 'true'/);
  assert.match(text, /--job-prefix "translate_retry"/);
  assert.match(text, /if: steps\.classify\.outputs\.before_logic == 'true'/);
});
