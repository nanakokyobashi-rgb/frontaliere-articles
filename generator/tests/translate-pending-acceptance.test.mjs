import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_PATH = path.join(ROOT, '.github/workflows/translate-pending.yml');

const WORKFLOW = fs.readFileSync(WORKFLOW_PATH, 'utf8');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function workflowStep(name) {
  const heading = new RegExp(`^      - name: ["']?${escapeRegExp(name)}["']?$`, 'm');
  const match = heading.exec(WORKFLOW);
  assert.ok(match, `step non trovato: ${name}`);
  const nextStep = WORKFLOW.indexOf('\n      - name: ', match.index + match[0].length);
  return WORKFLOW.slice(match.index, nextStep === -1 ? WORKFLOW.length : nextStep);
}

test('translate-pending mantiene full la popolazione usata da baseline e cascade', () => {
  assert.doesNotMatch(WORKFLOW, /--no-summaries/);

  for (const name of [
    'Assemble dataset',
    'Re-assemble dataset after Argos bulk',
    'Re-assemble true-final translation dataset',
  ]) {
    assert.match(workflowStep(name), /run: node scripts\/assemble-jobs-dataset\.mjs/);
  }

  assert.match(
    workflowStep('Capture translation observability baseline'),
    /--mode start --jobs data\/jobs\.json/,
  );
});

test('translate-pending non abilita il lease Firestore per il proprio mutex GitHub', () => {
  assert.doesNotMatch(WORKFLOW, /^\s+DATA_PIPELINE_LEASE:/m);
});

test('translate-pending documenta il confine di scrittura isolato dopo la rimozione della lease', () => {
  assert.match(WORKFLOW, /isolated `--slice-only`/);
  assert.match(WORKFLOW, /private index from the\s+# current `origin\/main`/);
  assert.match(WORKFLOW, /3-way-merges touched JSON/);
  assert.match(WORKFLOW, /retries the atomic ref push after contention/);
});
