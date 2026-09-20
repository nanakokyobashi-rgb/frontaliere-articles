import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = fs.readFileSync(
  path.join(ROOT, '.github/workflows/pr-redflag-fixer.yml'),
  'utf8',
);

test('il redflag fixer tratta il BODY-only come esito deterministico e idempotente', () => {
  assert.match(WORKFLOW, /body_only: \$\{\{ steps\.classify\.outputs\.body_only \}\}/u);
  assert.match(WORKFLOW, /body_only=\$\(printf '[^\n]+\.bodyOnly/u,
    'lo scope deve propagare il flag bodyOnly del classificatore');
  assert.match(WORKFLOW, /REDFLAG_BODY_DECLASSIFIED/u);
  assert.match(WORKFLOW, /sha256sum/u);
  assert.match(WORKFLOW, /nessun round, nessun Claude/u);
  assert.match(WORKFLOW, /nessun fix automatico o follow-up necessario/u);
});

test('il job Claude resta riservato ai finding bloccanti o non verificabili', () => {
  const start = WORKFLOW.indexOf('  redflag-fix:');
  const relativeEnd = WORKFLOW.slice(start + 3).search(/\n  [a-z][a-z-]+:\n/u);
  const end = relativeEnd === -1 ? -1 : start + 3 + relativeEnd;
  const job = WORKFLOW.slice(start, end === -1 ? WORKFLOW.length : end);
  assert.match(job, /needs\.scope\.outputs\.blocking == 'true'/u);
  assert.match(job, /needs\.scope\.outputs\.error == 'true'/u);
  assert.doesNotMatch(job, /body_only/u);
});
