import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = readFileSync(path.join(ROOT, '.github/workflows/followup-drainer.yml'), 'utf8');

test('il drainer non riapre il gate su un Issue fix skipped', () => {
  assert.match(workflow, /workflow_run:[\s\S]*workflows: \['Issue fix \(Codex Luna Max → PR\)'\][\s\S]*types: \[completed\]/);
  assert.match(workflow, /github\.event\.workflow_run\.conclusion != 'skipped'/);
});

test('il job del drainer usa lo stesso mutex daily dei writer e non sfratta una run attiva', () => {
  assert.match(workflow, /concurrency:\n\s+group: followup-daily-\$\{\{ github\.repository \}\}\n\s+cancel-in-progress: false/);
  assert.ok(
    workflow.indexOf("if: >-") < workflow.indexOf('concurrency:\n      group: followup-daily-'),
    'il filtro degli eventi irrilevanti deve precedere l’ingresso nel mutex',
  );
});

test('il burst di label, workflow_run e cron è recuperabile e non annulla il pending utile', () => {
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /issues:\n\s+types: \[labeled\]/);
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /il cron resta il recupero durevole/i);
});
