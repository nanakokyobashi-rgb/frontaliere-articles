import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  acquirePharmacyEvergreenRefresh,
  recoverPharmacyEvergreenRefresh,
} from '../scripts/lib/pharmacy-evergreen-refresh-transaction.mjs';

function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmacy-refresh-tx-'));
  fs.mkdirSync(path.join(root, 'generator', 'data'), { recursive: true });
  return root;
}

function file(root, relative) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  return target;
}

test('pharmacy refresh transaction: stage/read e commit coordinano più file', () => {
  const root = tempRepo();
  try {
    const first = file(root, 'content/first.ts');
    const second = file(root, 'content/second.ts');
    fs.writeFileSync(first, 'old first');
    fs.writeFileSync(second, 'old second');

    const tx = acquirePharmacyEvergreenRefresh(root, { log: () => {} });
    tx.stage(first, 'new first');
    tx.stage(second, 'new second');
    assert.equal(tx.read(first), 'new first');
    assert.equal(fs.readFileSync(first, 'utf8'), 'old first', 'lo staging non deve toccare il target');

    tx.commit();
    assert.equal(fs.readFileSync(first, 'utf8'), 'new first');
    assert.equal(fs.readFileSync(second, 'utf8'), 'new second');
    assert.equal(fs.existsSync(tx.paths.lockPath), false, 'il lock va rimosso dopo il commit');
    assert.equal(fs.existsSync(tx.paths.transactionRoot), false, 'lo staging va rimosso dopo il commit');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pharmacy refresh transaction: un journal interrotto ripristina i backup al run successivo', () => {
  const root = tempRepo();
  try {
    const first = file(root, 'content/first.ts');
    const second = file(root, 'content/second.ts');
    fs.writeFileSync(first, 'old first');
    fs.writeFileSync(second, 'old second');

    const tx = acquirePharmacyEvergreenRefresh(root, {
      pid: 2147483647,
      log: () => {},
    });
    tx.stage(first, 'new first');
    tx.stage(second, 'new second');
    tx.prepare();

    // Simulate SIGKILL after exactly one target rename. The stale lock uses a
    // dead PID, so the next producer must recover rather than publish a mixed
    // body/meta/registry state.
    fs.renameSync(path.join(tx.paths.stageRoot, 'content/first.ts'), first);
    const result = recoverPharmacyEvergreenRefresh(root, { log: () => {} });
    assert.equal(result.recovered, true);
    assert.equal(fs.readFileSync(first, 'utf8'), 'old first');
    assert.equal(fs.readFileSync(second, 'utf8'), 'old second');
    assert.equal(fs.existsSync(tx.paths.lockPath), false);
    assert.equal(fs.existsSync(tx.paths.transactionRoot), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pharmacy refresh transaction: rollback interrotto persiste il progresso e riprende senza backup', () => {
  const root = tempRepo();
  const originalRenameSync = fs.renameSync;
  let backupRenames = 0;
  try {
    const first = file(root, 'content/first.ts');
    const second = file(root, 'content/second.ts');
    fs.writeFileSync(first, 'old first');
    fs.writeFileSync(second, 'old second');

    const tx = acquirePharmacyEvergreenRefresh(root, {
      pid: 2147483647,
      log: () => {},
    });
    tx.stage(first, 'new first');
    tx.stage(second, 'new second');
    tx.prepare();
    fs.renameSync(path.join(tx.paths.stageRoot, 'content/first.ts'), first);
    fs.renameSync(path.join(tx.paths.stageRoot, 'content/second.ts'), second);

    fs.renameSync = (source, target) => {
      if (source.includes(`${path.sep}backup${path.sep}`)) {
        backupRenames += 1;
        if (backupRenames === 2) throw new Error('simulated rollback interruption');
      }
      return originalRenameSync(source, target);
    };

    assert.throws(
      () => recoverPharmacyEvergreenRefresh(root, { log: () => {} }),
      /rollback pharmacy refresh incompleto.*simulated rollback interruption/,
    );
    assert.equal(fs.readFileSync(first, 'utf8'), 'new first');
    assert.equal(fs.readFileSync(second, 'utf8'), 'old second');
    assert.equal(fs.existsSync(tx.paths.lockPath), true, 'il lock resta per consentire il recovery');
    const journal = JSON.parse(fs.readFileSync(tx.paths.journalPath, 'utf8'));
    assert.deepEqual(journal.restored, ['content/second.ts']);

    fs.renameSync = originalRenameSync;
    const result = recoverPharmacyEvergreenRefresh(root, { log: () => {} });
    assert.equal(result.recovered, true);
    assert.equal(fs.readFileSync(first, 'utf8'), 'old first');
    assert.equal(fs.readFileSync(second, 'utf8'), 'old second');
    assert.equal(fs.existsSync(tx.paths.lockPath), false);
    assert.equal(fs.existsSync(tx.paths.transactionRoot), false);
  } finally {
    fs.renameSync = originalRenameSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pharmacy refresh transaction: un lock attivo non viene cancellato', () => {
  const root = tempRepo();
  try {
    const tx = acquirePharmacyEvergreenRefresh(root, { log: () => {} });
    assert.throws(
      () => recoverPharmacyEvergreenRefresh(root),
      /pharmacy refresh: lock attivo/,
    );
    tx.rollback();
    assert.equal(fs.existsSync(tx.paths.lockPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
