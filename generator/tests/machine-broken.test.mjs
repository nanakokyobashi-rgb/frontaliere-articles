import test from 'node:test';
import assert from 'node:assert/strict';
import { citedPaths, machineAdmission } from '../../scripts/ci/lib/machine-broken.mjs';

test('#8040: citedPaths ignora i path presenti solo nella citazione Original text', () => {
  const body = [
    '- Target file: `functions/src/lib/jobEmailRankingStore.js`',
    '- Original text:',
    '  Il gate citato usa `scripts/ci/lib/machine-broken.mjs`.',
    '  - Suggested action: correggi `scripts/ci/lib/machine-broken.mjs`.',
    '- Suggested action: sposta il probe fuori dalla transazione in `functions/src/lib/jobEmailRankingStore.js`.',
  ].join('\n');

  assert.deepEqual(citedPaths(body), ['functions/src/lib/jobEmailRankingStore.js']);
  assert.equal(machineAdmission(body, {
    getRuns: () => { throw new Error('non deve interrogare lo storico della macchina'); },
  }), 'not-machine');
});

test('#8040: un item che cita solo path machine nei campi operativi resta machine', () => {
  const body = [
    '- Target file: `.github/workflows/issue-fix.yml`',
    '- Suggested action: correggi `scripts/ci/needs-human-prepass.mjs`.',
  ].join('\n');
  assert.deepEqual(citedPaths(body), [
    '.github/workflows/issue-fix.yml',
    'scripts/ci/needs-human-prepass.mjs',
  ]);
});
