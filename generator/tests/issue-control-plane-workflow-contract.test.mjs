import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const WORKFLOWS = {
  triage: '.github/workflows/issue-triage.yml',
  fix: '.github/workflows/issue-fix.yml',
  decompose: '.github/workflows/issue-decompose.yml',
};

function source(name) {
  return fs.readFileSync(path.join(ROOT, WORKFLOWS[name]), 'utf8');
}

function assertContract(name, fragments) {
  const workflow = source(name);
  for (const fragment of fragments) {
    assert.match(workflow, fragment, `${name}: manca il contratto ${fragment}`);
  }
}

test('il triage mantiene routing bounded e identità di mutazione verificabile', () => {
  assertContract('triage', [
    /group: issue-triage-\$\{\{ github\.event\.issue\.number \|\| 'sweep' \}\}/,
    /cancel-in-progress: false/,
    /ensure-loop-labels\.mjs/,
    /L11_ISSUE_CONTRACT/,
    /GITHUB_PAT_NANAKO/,
    /agent:fix-queued/,
  ]);
});

test('il fixer conserva i cancelli stale, claim, lease e telemetria del verdetto', () => {
  assertContract('fix', [
    /group: issue-fix-\$\{\{ github\.event\.issue\.number \|\| github\.run_id \}\}/,
    /cancel-in-progress: false/,
    /check-stale-issue-dispatch\.mjs/,
    /claim-issue-(?:group-)?in-flight\.mjs/,
    /quota_lease/,
    /pr-delivery-evidence\.mjs/,
    /FIX_OUTCOME:/,
    /GITHUB_PAT_NANAKO/,
  ]);
});

test('il decomposer serializza l issue e riporta sempre un esito riarmabile', () => {
  assertContract('decompose', [
    /group: issue-decompose-\$\{\{ github\.event\.issue\.number \|\| github\.run_id \}\}/,
    /cancel-in-progress: false/,
    /check-stale-issue-dispatch\.mjs/,
    /quota_lease/,
    /DECOMPOSE_OUTCOME:/,
    /agent:decompose-queued/,
    /GITHUB_PAT_NANAKO/,
  ]);
});

test('i tre entrypoint condividono il fail-closed sul dispatch e non usano il token implicito per il routing', () => {
  for (const name of Object.keys(WORKFLOWS)) {
    const workflow = source(name);
    assert.match(workflow, /cancel-in-progress: false/, `${name}: concorrenza non fail-closed`);
    assert.match(workflow, /GITHUB_PAT_NANAKO/, `${name}: identità runtime assente`);
  }
});
