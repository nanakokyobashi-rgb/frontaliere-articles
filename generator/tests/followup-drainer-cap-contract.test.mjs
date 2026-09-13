import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function workflowEnv(yaml, name) {
  const line = yaml.split('\n').find((candidate) => new RegExp(`^\\s+${name}:`).test(candidate));
  const match = line && new RegExp(`^\\s+${name}:\\s*['"]([^'"]+)['"]\\s*$`).exec(line);
  assert.ok(match, `${name} non configurato nel workflow`);
  return match[1];
}

test('il pool remoto del corpus usa sette fixer e sette lease', () => {
  const workflow = readFileSync(path.join(ROOT, '.github/workflows/followup-drainer.yml'), 'utf8');
  assert.equal(workflowEnv(workflow, 'FOLLOWUP_MAX_INFLIGHT_FIX'), '7');
  assert.equal(workflowEnv(workflow, 'QUOTA_LEASE_MAX_INFLIGHT_FIX'), '7');
});

test('il lease del workflow issue-fix è allineato al cap del drainer', () => {
  const workflow = readFileSync(path.join(ROOT, '.github/workflows/issue-fix.yml'), 'utf8');
  assert.equal(workflowEnv(workflow, 'QUOTA_LEASE_MAX_INFLIGHT_FIX'), '7');
});
