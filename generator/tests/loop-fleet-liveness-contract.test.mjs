import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const readWorkflow = (name) => fs.readFileSync(path.join(ROOT, '.github/workflows', name), 'utf8');

test('L11 triage legge il contratto machine-readable prima del classificatore generico', () => {
  const workflow = readWorkflow('issue-triage.yml');
  const normalizeAt = workflow.indexOf('Normalize L11 issue contracts');
  const sweepAt = workflow.indexOf('Triage sweep (recover orphaned issues');

  assert.ok(normalizeAt >= 0, 'manca la normalizzazione L11');
  assert.ok(sweepAt >= 0 && normalizeAt < sweepAt, 'L11 deve essere normalizzato prima dello sweep');
  assert.match(workflow, /candidateId/);
  assert.match(workflow, /sourceRecordId/);
  assert.match(workflow, /candidateTtlHours/);
  assert.ok(
    workflow.includes('const marker = /<!-- L11_ISSUE_CONTRACT:\\s*(\\{.*\\})\\s*-->/m.exec(body);'),
    'il lettore deve chiudere il JSON esterno anche con ttl annidato',
  );
  assert.match(workflow, /expires > Date\.now\(\)/);
  assert.match(workflow, /contract\.route === 'bounded-fix-queue'/);
  assert.match(workflow, /c\.remediationPr === null/);
  assert.match(workflow, /--add-label operations-audit-review/);
  assert.doesNotMatch(workflow, /--add-label\s+needs-human/);
  assert.doesNotMatch(workflow, /id-token:\s+write/);
});

test('issue-fix richiede il contratto L11 eleggibile e pubblica la prova PR dopo la consegna', () => {
  const workflow = readWorkflow('issue-fix.yml');

  assert.match(workflow, /l11_contract:/);
  assert.match(workflow, /needs: l11_contract/);
  assert.match(workflow, /needs\.l11_contract\.outputs\.allowed == 'true'/);
  assert.match(workflow, /L11_REMEDIATION_PR/);
  assert.match(workflow, /candidateId: contract\.candidateId/);
  assert.match(workflow, /sourceRecordId: contract\.sourceRecordId/);
  assert.match(workflow, /c\.remediationPr === null/);
  assert.match(workflow, /--remove-label agent:fix --remove-label agent:fix-queued/);
  assert.doesNotMatch(workflow, /id-token:\s+write/);
});
