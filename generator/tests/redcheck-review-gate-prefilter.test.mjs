/**
 * Redcheck deve scartare prima di Claude il rosso che appartiene solo al
 * verdetto della review. Il job `tests` porta quel segnale nei propri step:
 * non serve rileggere log o PR, e il fixer del codice non deve sovrapporsi al
 * redflag-fixer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = path.join(ROOT, '.github/workflows/pr-redcheck-fixer.yml');
const source = fs.readFileSync(WORKFLOW, 'utf8');

function preflightBlock() {
  const start = source.indexOf('- name: PR azionabile, e il rosso e\' ancora quello della HEAD?');
  const end = source.indexOf('\n\n  redcheck-fix:', start);
  assert.notEqual(start, -1, 'lo step preflight non e\' stato trovato');
  assert.notEqual(end, -1, 'il job redcheck-fix non e\' stato trovato');
  return source.slice(start, end);
}

test('redcheck filtra il rosso di sola review prima di spendere Claude', () => {
  const block = preflightBlock();

  assert.match(
    block,
    /actions\/runs\/\$RUN_ID\/jobs\?per_page=100/,
    'il preflight deve leggere gli step del run tests fallito, non solo il rollup dei check',
  );
  assert.match(
    block,
    /Require approving Claude review/,
    'il filtro deve riconoscere il gate che rende rosso il verdetto della review',
  );
  assert.match(
    block,
    /Run Claude review/,
    'il filtro deve distinguere una review realmente eseguita da una review saltata',
  );
  assert.match(
    block,
    /review_only.*true|true.*review_only/s,
    'il filtro deve produrre una decisione deterministica review-only',
  );
  assert.match(
    block,
    /review_only[^\n]*true[\s\S]*skip[\s\S]*(?:review|Claude)/,
    'un rosso di sola review deve uscire dal preflight senza invocare Claude del fixer',
  );
});
