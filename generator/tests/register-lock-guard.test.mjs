import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  REGISTER_LOCK_FILE_RE,
  checkRegistrationLocks,
  findRegistrationLocks,
  formatRegistrationLockError,
} from '../../scripts/ci/check-registration-locks.mjs';

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'registration-lock-guard-'));
}

test('la regex copre legacy, frontaliere e tutti i lock cantonali', () => {
  for (const file of [
    'register-in-progress.json',
    'register-in-progress-frontaliere.json',
    'register-in-progress-svizzera.json',
    'register-in-progress-canton-ti.json',
    'register-in-progress-canton-appenzello.json',
  ]) {
    assert.match(file, REGISTER_LOCK_FILE_RE);
  }
  assert.doesNotMatch('register-in-progress-.json', REGISTER_LOCK_FILE_RE);
  assert.doesNotMatch('register-in-progress-frontaliere.tmp', REGISTER_LOCK_FILE_RE);
});

test('un lock orfano nomina sezione e run invece di un errore generico', () => {
  const root = sandbox();
  fs.writeFileSync(
    path.join(root, 'register-in-progress-canton-ti.json'),
    JSON.stringify({ section: 'canton-ti', runId: '37615236890', workflow: 'Generate canton TI' }),
  );
  const [lock] = findRegistrationLocks(root);
  assert.equal(formatRegistrationLockError(lock),
    'lock orfano di canton-ti dalla run 37615236890: register-in-progress-canton-ti.json (workflow=Generate canton TI)');
  assert.equal(checkRegistrationLocks(root), 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('un lock illeggibile resta un errore attribuibile al nome della sezione', () => {
  const root = sandbox();
  fs.writeFileSync(path.join(root, 'register-in-progress-frontaliere.json'), '{broken');
  const [lock] = findRegistrationLocks(root);
  assert.equal(lock.section, 'frontaliere');
  assert.equal(lock.runId, 'non-identificata');
  assert.match(formatRegistrationLockError(lock), /lock orfano di frontaliere dalla run non-identificata/);
  fs.rmSync(root, { recursive: true, force: true });
});
