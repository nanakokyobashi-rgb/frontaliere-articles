import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redflagFindingsFingerprint } from '../../scripts/ci/redflag-findings-fingerprint.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github/workflows/pr-redflag-fixer.yml'), 'utf8');

test('lo stesso insieme di finding ha la stessa impronta anche con ordine e spazi diversi', () => {
  const a = '## Findings (Important: 2, Nit: 0)\n\n🔴 Important: uno\n🔴 **Important —** due';
  const b = '## Findings (Important: 2, Nit: 0)\n\n🔴  **Important —** due\n🔴 Important: uno';
  assert.equal(redflagFindingsFingerprint(a), redflagFindingsFingerprint(b));
  assert.notEqual(redflagFindingsFingerprint(a), redflagFindingsFingerprint(`${a}\n🔴 Important: tre`));
});

test('un corpo senza finding non diventa un fingerprint che blocca il round', () => {
  assert.equal(redflagFindingsFingerprint('## Findings (Important: 0, Nit: 1)\n\n## LGTM'), null);
});

test('il preflight richiede Findings e confronta il fingerprint prima di incrementare il round', () => {
  assert.match(WORKFLOW, /## Findings \(/);
  assert.match(WORKFLOW, /redflag-findings-fingerprint\.mjs/);
  assert.match(WORKFLOW, /REDFLAG_FINDINGS_FINGERPRINT: \[a-f0-9\]\{64\}/);
  assert.match(WORKFLOW, /\.body\|contains\("## Findings \("\)/);
  assert.ok(
    WORKFLOW.indexOf('INCOMING_FP') < WORKFLOW.indexOf('NEXT=$((ROUND + 1))'),
    'il duplicato va scartato prima di consumare il marker del round',
  );
});
