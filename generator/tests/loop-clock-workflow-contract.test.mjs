import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOWS = [
  '.github/workflows/issue-triage.yml',
  '.github/workflows/close-recovered-failure-issues.yml',
];

function workflowDispatchBlock(source) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => /^  workflow_dispatch:\s*(?:\{\})?\s*(?:#.*)?$/.test(line));
  assert.notEqual(start, -1, 'workflow_dispatch deve essere un trigger top-level');
  const block = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && /^\S/.test(line)) break;
    if (line.trim() !== '' && /^  \S/.test(line)) break;
    block.push(line);
  }
  return block.join('\n');
}

test('i workflow che il loop clock del sito presuppone restano dispatchabili senza input obbligatori', () => {
  for (const relative of WORKFLOWS) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    const dispatch = workflowDispatchBlock(source);
    assert.doesNotMatch(dispatch, /^\s+required:\s*true\s*$/m, `${relative}: input required=true`);
  }
});

// Il marcatore ha la forma che il dispatcher del sito invia e che il suo
// osservatore cerca (`functions/src/loopClockTable.js` nel repo del sito:
// input `loop_clock`, nome della run con `[loop-clock <voce>@<slot>]`). I due
// repo non possono importarsi: il legame sta in questo test e nel gemello del
// sito (`tests/loop-clock-dispatch.test.ts`), che fissa la stessa forma per i
// workflow di quel lato.
const LOOP_CLOCK_INPUT = 'loop_clock';
const LOOP_CLOCK_RUN_MARKER = '[loop-clock {0}]';

function dispatchInputBlock(dispatch, name) {
  const lines = dispatch.split('\n');
  const start = lines.findIndex((line) => line === `      ${name}:`);
  if (start === -1) return null;
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !/^ {8,}\S/.test(line)) break;
    block.push(line);
  }
  return block.join('\n');
}

function runNameLine(source) {
  return source.split('\n').find((line) => line.startsWith('run-name:')) ?? '';
}

function markerProblems(source) {
  const problems = [];
  const input = dispatchInputBlock(workflowDispatchBlock(source), LOOP_CLOCK_INPUT);
  // Un input non dichiarato fa rispondere 422 all'intero dispatch: il
  // workflow non parte affatto.
  if (input === null) problems.push(`input ${LOOP_CLOCK_INPUT} non dichiarato`);
  else {
    if (!/^\s+type:\s*string\s*$/m.test(input)) problems.push(`input ${LOOP_CLOCK_INPUT} non di tipo string`);
    if (!/^\s+required:\s*false\s*$/m.test(input)) problems.push(`input ${LOOP_CLOCK_INPUT} non facoltativo`);
  }
  // Senza il marcatore nel nome la run parte, ma per l'osservatore del sito
  // l'orologio risulta fermo su questa voce.
  const runName = runNameLine(source);
  if (!runName.includes(LOOP_CLOCK_RUN_MARKER)) problems.push('run-name senza il marcatore');
  if (!runName.includes(`inputs.${LOOP_CLOCK_INPUT}`)) problems.push('run-name non derivato dall\'input');
  if (!runName.includes("github.event_name == 'workflow_dispatch'")) problems.push('run-name non limitato ai dispatch');
  return problems;
}

test('i workflow mossi dal loop clock accettano il suo input e ne ricavano il nome della run', () => {
  for (const relative of WORKFLOWS) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.deepEqual(markerProblems(source), [], relative);
  }
});

test('il controllo del marcatore riconosce un workflow che non lo porta', () => {
  const bare = [
    'name: Esempio',
    'on:',
    '  workflow_dispatch:',
    '    inputs:',
    '      dry_run:',
    '        required: false',
    '        type: boolean',
    'jobs: {}',
  ].join('\n');
  assert.deepEqual(markerProblems(bare), [
    `input ${LOOP_CLOCK_INPUT} non dichiarato`,
    'run-name senza il marcatore',
    'run-name non derivato dall\'input',
    'run-name non limitato ai dispatch',
  ]);

  const marked = [
    'name: Esempio',
    "run-name: ${{ github.event_name == 'workflow_dispatch' && inputs.loop_clock != '' && format('Esempio [loop-clock {0}]', inputs.loop_clock) || 'Esempio' }}",
    'on:',
    '  workflow_dispatch:',
    '    inputs:',
    '      loop_clock:',
    '        required: false',
    '        type: string',
    "        default: ''",
    'jobs: {}',
  ].join('\n');
  assert.deepEqual(markerProblems(marked), []);
  assert.deepEqual(markerProblems(marked.replace('type: string', 'type: boolean')), [
    `input ${LOOP_CLOCK_INPUT} non di tipo string`,
  ]);
});
