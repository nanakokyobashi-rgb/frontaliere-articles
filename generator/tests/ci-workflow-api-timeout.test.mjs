import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOWS = [
  '.github/workflows/issue-fix.yml',
  '.github/workflows/tests.yml',
  '.github/workflows/orphan-push-warn.yml',
  '.github/workflows/auto-merge-engine-lockstep.yml',
  '.github/workflows/publish-api.yml',
];

test('le letture GitHub dei workflow CI hanno un limite di 60 secondi', () => {
  const sources = WORKFLOWS.map((relativePath) => readFileSync(path.join(ROOT, relativePath), 'utf8'));
  const source = sources.join('\n');
  assert.equal(
    (source.match(/timeout --kill-after=1s 60s gh api/g) || []).length,
    21,
    'tutte le ventuno chiamate gh api del gruppo devono essere bounded',
  );
  assert.doesNotMatch(
    source,
    /(?:=\(gh api\b|if ! gh api\b|^\s*gh api\b)/m,
    'nessuna chiamata shell deve bypassare il timeout',
  );
});
