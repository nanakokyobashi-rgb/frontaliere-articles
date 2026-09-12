import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ensureLabel } from '../../scripts/ci/followup-drainer.mjs';

const LABEL = 'fu-unparked';
const COLOR = '0e8a16';
const DESCRIPTION = 'Ri-accodata dal drainer: era parked per un addebito falso (nessun verdetto, oppure una consegna letta come run morta)';

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
