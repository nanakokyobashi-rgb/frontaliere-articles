import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.resolve(HERE, '../scripts/create-article.mjs'), 'utf8');

test('la selezione mantiene chosen nello scope del catch della stessa attempt', () => {
  const poolLoop = SOURCE.indexOf(
    'for (let poolIndex = 0; poolIndex < poolPlan.length; poolIndex++) {',
  );
  assert.notEqual(poolLoop, -1, 'loop del pool news non trovato');

  const attemptLoop = SOURCE.indexOf(
    'for (let attempt = 1; attempt <= MAX_DUPLICATE_RETRIES; attempt++) {',
    poolLoop,
  );
  assert.notEqual(attemptLoop, -1, 'loop attempt del pool news non trovato');

  const tryStart = SOURCE.indexOf('          try {', attemptLoop);
  const declaration = SOURCE.indexOf('          let chosen = null;', attemptLoop);
  const catchStart = SOURCE.indexOf(
    '          } catch (e) {\n            const isDuplicate = isDuplicateError(e);',
    tryStart,
  );
  assert.ok(tryStart > attemptLoop, 'try della selezione non trovato');
  assert.ok(declaration > attemptLoop && declaration < tryStart, 'chosen deve vivere fuori dal try');
  assert.ok(catchStart > declaration, 'catch della selezione non trovato');

  const catchBody = SOURCE.slice(catchStart, catchStart + 1_600);
  assert.match(
    catchBody,
    /safeSignalDiagnosticTextForLog\(duplicateCandidateDetail\(e\.message\), chosen\)/,
    'il catch deve poter redigere il candidato senza creare un ReferenceError',
  );
});
