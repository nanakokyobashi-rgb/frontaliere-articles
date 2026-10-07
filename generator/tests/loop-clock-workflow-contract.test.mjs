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
