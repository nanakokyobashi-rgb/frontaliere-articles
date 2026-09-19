import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ensureLabel,
  MAX_LABEL_DESCRIPTION_LENGTH,
  UNPARKED_LABEL_DESCRIPTION,
} from '../../scripts/ci/followup-drainer.mjs';

const LABEL = 'fu-unparked';
const COLOR = '0e8a16';
const DESCRIPTION = UNPARKED_LABEL_DESCRIPTION;

test('ensureLabel aggiorna la description di una label gia esistente', () => {
  const calls = [];
  const live = { color: COLOR, description: 'description obsoleta' };
  const run = (args) => {
    calls.push(args);
    if (args[1] === 'create') throw new Error('label already exists');
    assert.deepEqual(args.slice(0, 3), ['label', 'edit', LABEL]);
    live.color = args[args.indexOf('--color') + 1];
    live.description = args[args.indexOf('--description') + 1];
  };

  assert.equal(ensureLabel(LABEL, COLOR, DESCRIPTION, { run, dry: false }), 'updated');
  assert.equal(calls.length, 2);
  assert.equal(live.color, COLOR);
  assert.equal(live.description, DESCRIPTION);
});

test('ensureLabel crea una label mancante senza eseguire un edit', () => {
  const calls = [];
  const run = (args) => calls.push(args);

  assert.equal(ensureLabel(LABEL, COLOR, DESCRIPTION, { run, dry: false }), 'created');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ['label', 'create']);
  assert.equal(calls[0][calls[0].indexOf('--description') + 1], DESCRIPTION);
});

test('ensureLabel rifiuta una description oltre il limite senza truncarla', () => {
  const calls = [];
  const run = (args) => calls.push(args);
  const tooLong = 'x'.repeat(MAX_LABEL_DESCRIPTION_LENGTH + 1);

  assert.equal(ensureLabel(LABEL, COLOR, tooLong, { run, dry: false }), 'failed');
  assert.equal(ensureLabel(LABEL, COLOR, tooLong, { run, dry: true }), 'failed');
  assert.equal(calls.length, 0);
});

test('ensureLabel non memoizza un fallimento di create e fallback edit', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    throw new Error('API unavailable');
  };

  assert.equal(ensureLabel(LABEL, COLOR, DESCRIPTION, { run, dry: false }), 'failed');
  assert.equal(calls.length, 2);
});
