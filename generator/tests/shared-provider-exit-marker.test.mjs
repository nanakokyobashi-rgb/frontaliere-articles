import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { EXIT_AI_PROVIDER_ROSTER_UNAVAILABLE } from '../scripts/lib/exhaustion-disposition.mjs';
import {
  RUN_CARD_SCHEMA,
  RUN_CARD_SHARED_PROVIDER_EXIT_DISPOSITION,
} from '../scripts/lib/run-card.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VALIDATOR = path.join(REPO, 'scripts/ci/validate-shared-provider-exit.mjs');
const VALID_CARD = {
  schema: RUN_CARD_SCHEMA,
  section: 'svizzera',
  status: 'deferred',
  exitCode: EXIT_AI_PROVIDER_ROSTER_UNAVAILABLE,
  exitDisposition: RUN_CARD_SHARED_PROVIDER_EXIT_DISPOSITION,
};

function validate(card) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'shared-provider-exit-'));
  try {
    const cardPath = path.join(dir, 'run-card.json');
    if (card !== undefined) writeFileSync(cardPath, typeof card === 'string' ? card : JSON.stringify(card));
    return spawnSync(process.execPath, [VALIDATOR, cardPath, 'svizzera'], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the validator accepts only a producer run card for this section and exit', () => {
  assert.equal(validate(VALID_CARD).status, 0);
  assert.notEqual(validate(undefined).status, 0, 'a missing card cannot attest exit 5');
  assert.notEqual(validate('{invalid json').status, 0, 'invalid JSON cannot attest exit 5');
  assert.notEqual(validate(null).status, 0, 'a JSON null cannot attest exit 5');
  assert.notEqual(validate([]).status, 0, 'a JSON array cannot attest exit 5');
  assert.notEqual(validate({ ...VALID_CARD, section: 'frontaliere' }).status, 0);
  assert.notEqual(validate({ ...VALID_CARD, status: 'error' }).status, 0);
  assert.notEqual(validate({ ...VALID_CARD, exitCode: 4 }).status, 0);
  assert.notEqual(validate({ ...VALID_CARD, exitDisposition: 'unclassified' }).status, 0);
});
