import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  writeFilePairAtomically,
  writeFileSnapshotAtomically,
  recoverInterruptedRegistryPair,
} from '../../scripts/lib/write-file-pair-atomically.mjs';

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'file-pair-atomic-'));
}

function interruptAfterTargetRenames(first, second, exitAfter) {
  const helper = new URL('../../scripts/lib/write-file-pair-atomically.mjs', import.meta.url).href;
  const canonicalFirst = fs.realpathSync(first);
  const canonicalSecond = fs.realpathSync(second);
  const program = `
    import fs from 'node:fs';
    import { writeFilePairAtomically } from ${JSON.stringify(helper)};
    const targets = new Set([${JSON.stringify(canonicalFirst)}, ${JSON.stringify(canonicalSecond)}]);
    const renameSync = fs.renameSync.bind(fs);
    let targetRenames = 0;
    const fsImpl = { ...fs, renameSync(from, to) {
      renameSync(from, to);
      if (targets.has(to)) {
        targetRenames += 1;
        if (targetRenames === ${exitAfter}) process.exit(73);
      }
    } };
    writeFilePairAtomically([
      { file: ${JSON.stringify(first)}, before: 'first-before', after: 'first-after' },
      { file: ${JSON.stringify(second)}, before: 'second-before', after: 'second-after' },
    ], { fsImpl });
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8' });
}

function hasErrorCode(error, code) {
  return error?.code === code
    || (error instanceof AggregateError && error.errors.some((item) => hasErrorCode(item, code)));
}

test('ripristina il primo file quando il rename del secondo fallisce', () => {
  const root = fixture();
  try {
    const first = path.join(root, 'first.txt');
    const second = path.join(root, 'second.txt');
    fs.writeFileSync(first, 'first-before');
    fs.writeFileSync(second, 'second-before');
    const fsImpl = {
      ...fs,
      renameSync(from, to) {
        if (to === fs.realpathSync(second) && from.endsWith('.pair.tmp')) {
          const error = new Error('injected second rename failure');
          error.code = 'EIO';
          throw error;
        }
        fs.renameSync(from, to);
      },
    };

    assert.throws(() => writeFilePairAtomically([
      { file: first, before: 'first-before', after: 'first-after' },
      { file: second, before: 'second-before', after: 'second-after' },
    ], { fsImpl }), /injected second rename failure/u);

    assert.equal(fs.readFileSync(first, 'utf8'), 'first-before');
    assert.equal(fs.readFileSync(second, 'utf8'), 'second-before');
    assert.deepEqual(fs.readdirSync(root).filter((name) => name.endsWith('.pair.tmp')), []);
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.lock')), false);
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.journal.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('un writer concorrente non sovrascrive uno snapshot preparato prima del commit precedente', () => {
  const root = fixture();
  try {
    const first = path.join(root, 'first.txt');
    const second = path.join(root, 'second.txt');
    const initial = [
      { file: first, before: 'first-before', after: 'first-after' },
      { file: second, before: 'second-before', after: 'second-after' },
    ];
    fs.writeFileSync(first, 'first-before');
    fs.writeFileSync(second, 'second-before');

    writeFilePairAtomically(initial);
    assert.throws(() => writeFilePairAtomically(initial.map((change) => ({
      ...change,
      after: `${change.after}-stale`,
    }))), /snapshot obsoleto/u);

    assert.equal(fs.readFileSync(first, 'utf8'), 'first-after');
    assert.equal(fs.readFileSync(second, 'utf8'), 'second-after');
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.lock')), false);
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.journal.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('un writer singolo condivide lock e controllo snapshot con il writer di coppia', () => {
  const root = fixture();
  try {
    const file = path.join(root, 'registry.ts');
    fs.writeFileSync(file, 'before');

    writeFileSnapshotAtomically(file, 'before', 'single-after');
    assert.throws(() => writeFilePairAtomically([
      { file, before: 'before', after: 'pair-stale' },
    ]), /snapshot obsoleto/u);
    assert.equal(fs.readFileSync(file, 'utf8'), 'single-after');
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.lock')), false);
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.journal.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rifiuta una coppia mentre un altro writer detiene il lock della directory', () => {
  const root = fixture();
  try {
    const first = path.join(root, 'first.txt');
    const second = path.join(root, 'second.txt');
    fs.writeFileSync(first, 'first-before');
    fs.writeFileSync(second, 'second-before');
    const lock = path.join(root, '.registry-pair-write.lock');
    fs.writeFileSync(lock, 'pid=other-writer\n');

    assert.throws(() => writeFilePairAtomically([
      { file: first, before: 'first-before', after: 'first-after' },
      { file: second, before: 'second-before', after: 'second-after' },
    ]), /lock presente/u);
    assert.equal(fs.readFileSync(first, 'utf8'), 'first-before');
    assert.equal(fs.readFileSync(second, 'utf8'), 'second-before');
    assert.equal(fs.readFileSync(lock, 'utf8'), 'pid=other-writer\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('se il close del lock fallisce, lo lascia in posto e blocca i writer successivi', () => {
  const root = fixture();
  try {
    const first = path.join(root, 'first.txt');
    const second = path.join(root, 'second.txt');
    const changes = [
      { file: first, before: 'first-before', after: 'first-after' },
      { file: second, before: 'second-before', after: 'second-after' },
    ];
    fs.writeFileSync(first, 'first-before');
    fs.writeFileSync(second, 'second-before');
    let lockFd = null;
    const fsImpl = {
      ...fs,
      openSync(file, ...args) {
        const fd = fs.openSync(file, ...args);
        if (file.endsWith('.registry-pair-write.lock')) lockFd = fd;
        return fd;
      },
      closeSync(fd) {
        fs.closeSync(fd);
        if (fd !== lockFd) return;
        const error = new Error('lock close denied');
        error.code = 'EIO';
        throw error;
      },
    };

    assert.throws(() => writeFilePairAtomically(changes, { fsImpl }), (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(error.errors.some((item) => item.message === 'lock close denied'), true);
      return true;
    });
    assert.equal(fs.readFileSync(first, 'utf8'), 'first-after');
    assert.equal(fs.readFileSync(second, 'utf8'), 'second-after');
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.lock')), true);
    assert.throws(() => writeFilePairAtomically(changes.map((change) => ({
      ...change,
      before: change.after,
      after: `${change.after}-again`,
    }))), /lock presente|journal della coppia presente/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rifiuta target distinti solo per un alias symlink', () => {
  const root = fixture();
  try {
    const target = path.join(root, 'registry.ts');
    const alias = path.join(root, 'registry-alias.ts');
    fs.writeFileSync(target, 'before');
    fs.symlinkSync(path.basename(target), alias);

    assert.throws(() => writeFilePairAtomically([
      { file: target, before: 'before', after: 'after' },
      { file: alias, before: 'before', after: 'after' },
    ]), /file duplicato/u);
    assert.equal(fs.readFileSync(target, 'utf8'), 'before');
    assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('propaga i failure di cleanup e mantiene visibile il temporaneo residuo', () => {
  const root = fixture();
  try {
    const first = path.join(root, 'first.txt');
    const second = path.join(root, 'second.txt');
    fs.writeFileSync(first, 'first-before');
    fs.writeFileSync(second, 'second-before');
    const fsImpl = {
      ...fs,
      renameSync(from, to) {
        if (to === fs.realpathSync(second) && from.endsWith('.pair.tmp')) {
          const error = new Error('injected second rename failure');
          error.code = 'EIO';
          throw error;
        }
        fs.renameSync(from, to);
      },
      unlinkSync(file) {
        if (file.endsWith('.pair.tmp')) {
          const error = new Error('cleanup denied');
          error.code = 'EACCES';
          throw error;
        }
        fs.unlinkSync(file);
      },
    };

    assert.throws(() => writeFilePairAtomically([
      { file: first, before: 'first-before', after: 'first-after' },
      { file: second, before: 'second-before', after: 'second-after' },
    ], { fsImpl }), (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(hasErrorCode(error, 'EACCES'), true);
      return true;
    });

    assert.equal(fs.readFileSync(first, 'utf8'), 'first-before');
    assert.equal(fs.readFileSync(second, 'utf8'), 'second-before');
    assert.equal(fs.readdirSync(root).filter((name) => name.endsWith('.pair.tmp')).length, 1);
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.lock')), true);
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.journal.json')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('espone insieme il failure del secondo rename e quello del rollback', () => {
  const root = fixture();
  try {
    const first = path.join(root, 'first.txt');
    const second = path.join(root, 'second.txt');
    fs.writeFileSync(first, 'first-before');
    fs.writeFileSync(second, 'second-before');
    const fsImpl = {
      ...fs,
      renameSync(from, to) {
        if (to === fs.realpathSync(second) && from.endsWith('.pair.tmp')) {
          const error = new Error('commit denied');
          error.code = 'EIO';
          throw error;
        }
        if (to === fs.realpathSync(first) && from.endsWith('.pair-rollback.tmp')) {
          const error = new Error('rollback denied');
          error.code = 'EROFS';
          throw error;
        }
        fs.renameSync(from, to);
      },
    };

    assert.throws(() => writeFilePairAtomically([
      { file: first, before: 'first-before', after: 'first-after' },
      { file: second, before: 'second-before', after: 'second-after' },
    ], { fsImpl }), (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(error.errors.some((item) => item.message === 'commit denied'), true);
      assert.equal(error.errors.some((item) => item.message === 'rollback denied'), true);
      return true;
    });

    assert.equal(fs.readFileSync(first, 'utf8'), 'first-before');
    assert.equal(fs.readFileSync(second, 'utf8'), 'second-before');
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.lock')), false);
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.journal.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recoverInterruptedRegistryPair ripristina entrambi i registry dopo un arresto tra i rename', () => {
  const root = fixture();
  try {
    const first = path.join(root, 'first.txt');
    const second = path.join(root, 'second.txt');
    fs.writeFileSync(first, 'first-before');
    fs.writeFileSync(second, 'second-before');
    const child = interruptAfterTargetRenames(first, second, 1);

    assert.equal(child.status, 73, child.stderr);
    assert.equal(fs.readFileSync(first, 'utf8'), 'first-after');
    assert.equal(fs.readFileSync(second, 'utf8'), 'second-before');
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.lock')), true);
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.journal.json')), true);

    assert.deepEqual(recoverInterruptedRegistryPair(root), { recovered: true, state: 'restored-before' });
    assert.equal(fs.readFileSync(first, 'utf8'), 'first-before');
    assert.equal(fs.readFileSync(second, 'utf8'), 'second-before');
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.lock')), false);
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.journal.json')), false);
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-recovery.lock')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recovery si può ripetere dopo un errore al secondo rename di ripristino', () => {
  const root = fixture();
  try {
    const first = path.join(root, 'first.txt');
    const second = path.join(root, 'second.txt');
    fs.writeFileSync(first, 'first-before');
    fs.writeFileSync(second, 'second-before');
    const child = interruptAfterTargetRenames(first, second, 2);
    assert.equal(child.status, 73, child.stderr);
    assert.equal(fs.readFileSync(first, 'utf8'), 'first-after');
    assert.equal(fs.readFileSync(second, 'utf8'), 'second-after');

    const fsImpl = {
      ...fs,
      renameSync(from, to) {
        if (to === fs.realpathSync(second) && from.endsWith('.pair-recovery.tmp')) {
          const error = new Error('injected recovery rename failure');
          error.code = 'EIO';
          throw error;
        }
        fs.renameSync(from, to);
      },
    };
    assert.throws(() => recoverInterruptedRegistryPair(root, { fsImpl }), /injected recovery rename failure/u);
    assert.equal(fs.readFileSync(first, 'utf8'), 'first-before');
    assert.equal(fs.readFileSync(second, 'utf8'), 'second-after');
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.lock')), true);
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.journal.json')), true);
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-recovery.lock')), false);

    assert.deepEqual(recoverInterruptedRegistryPair(root), { recovered: true, state: 'restored-before' });
    assert.equal(fs.readFileSync(first, 'utf8'), 'first-before');
    assert.equal(fs.readFileSync(second, 'utf8'), 'second-before');
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.lock')), false);
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.journal.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recovery rifiuta un writer attivo e non modifica la coppia', () => {
  const root = fixture();
  try {
    const first = path.join(root, 'first.txt');
    const second = path.join(root, 'second.txt');
    fs.writeFileSync(first, 'first-before');
    fs.writeFileSync(second, 'second-before');
    const child = interruptAfterTargetRenames(first, second, 1);
    assert.equal(child.status, 73, child.stderr);

    const journalFile = path.join(root, '.registry-pair-write.journal.json');
    const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    const originalPid = journal.pid;
    journal.pid = process.pid;
    for (const entry of journal.entries) {
      if (entry.stagingFile) entry.stagingFile = entry.stagingFile.replace(`.${originalPid}.`, `.${process.pid}.`);
    }
    fs.writeFileSync(journalFile, `${JSON.stringify(journal)}\n`);
    fs.writeFileSync(path.join(root, '.registry-pair-write.lock'), `${JSON.stringify({
      version: 1,
      pid: process.pid,
      host: journal.host,
      transactionId: journal.transactionId,
    })}\n`);

    assert.throws(() => recoverInterruptedRegistryPair(root), /writer .*ancora attivo/u);
    assert.equal(fs.readFileSync(first, 'utf8'), 'first-after');
    assert.equal(fs.readFileSync(second, 'utf8'), 'second-before');
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.lock')), true);
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-recovery.lock')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recovery rifiuta versioni e snapshot journal incoerenti senza toccare i registry', () => {
  const root = fixture();
  try {
    const first = path.join(root, 'first.txt');
    const second = path.join(root, 'second.txt');
    fs.writeFileSync(first, 'first-before');
    fs.writeFileSync(second, 'second-before');
    const child = interruptAfterTargetRenames(first, second, 1);
    assert.equal(child.status, 73, child.stderr);

    const journalFile = path.join(root, '.registry-pair-write.journal.json');
    const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    journal.version = 2;
    fs.writeFileSync(journalFile, `${JSON.stringify(journal)}\n`);
    assert.throws(() => recoverInterruptedRegistryPair(root), /journal della coppia non verificabile/u);

    journal.version = 1;
    journal.entries[0].beforeSha256 = '0'.repeat(64);
    fs.writeFileSync(journalFile, `${JSON.stringify(journal)}\n`);
    assert.throws(() => recoverInterruptedRegistryPair(root), /snapshot journal non valido/u);
    assert.equal(fs.readFileSync(first, 'utf8'), 'first-after');
    assert.equal(fs.readFileSync(second, 'utf8'), 'second-before');
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.lock')), true);
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.journal.json')), true);
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-recovery.lock')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recovery non interpreta come interruzione uno snapshot misto con journal committed', () => {
  const root = fixture();
  try {
    const first = path.join(root, 'first.txt');
    const second = path.join(root, 'second.txt');
    fs.writeFileSync(first, 'first-before');
    fs.writeFileSync(second, 'second-before');
    const child = interruptAfterTargetRenames(first, second, 2);
    assert.equal(child.status, 73, child.stderr);

    const journalFile = path.join(root, '.registry-pair-write.journal.json');
    const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    journal.phase = 'committed';
    fs.writeFileSync(journalFile, `${JSON.stringify(journal)}\n`);
    fs.writeFileSync(second, 'second-before');

    assert.throws(() => recoverInterruptedRegistryPair(root), /journal committed con snapshot non coerente/u);
    assert.equal(fs.readFileSync(first, 'utf8'), 'first-after');
    assert.equal(fs.readFileSync(second, 'utf8'), 'second-before');
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.lock')), true);
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.journal.json')), true);
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-recovery.lock')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recovery rifiuta un target fuori dagli snapshot noti senza auto-ripararlo', () => {
  const root = fixture();
  try {
    const first = path.join(root, 'first.txt');
    const second = path.join(root, 'second.txt');
    fs.writeFileSync(first, 'first-before');
    fs.writeFileSync(second, 'second-before');
    const child = interruptAfterTargetRenames(first, second, 1);
    assert.equal(child.status, 73, child.stderr);
    fs.writeFileSync(first, 'external-third-state');

    assert.throws(() => recoverInterruptedRegistryPair(root), /stato ambiguo/u);
    assert.equal(fs.readFileSync(first, 'utf8'), 'external-third-state');
    assert.equal(fs.readFileSync(second, 'utf8'), 'second-before');
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.lock')), true);
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.journal.json')), true);
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-recovery.lock')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
