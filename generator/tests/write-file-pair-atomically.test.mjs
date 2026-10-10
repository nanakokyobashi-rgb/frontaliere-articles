import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  writeFilePairAtomically,
  writeFileSnapshotAtomically,
} from '../../scripts/lib/write-file-pair-atomically.mjs';

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'file-pair-atomic-'));
}

test('ripristina il primo file quando il rename del secondo fallisce', () => {
  const root = fixture();
  try {
    const first = path.join(root, 'first.txt');
    const second = path.join(root, 'second.txt');
    fs.writeFileSync(first, 'first-before');
    fs.writeFileSync(second, 'second-before');
    let renames = 0;
    const fsImpl = {
      ...fs,
      renameSync(from, to) {
        renames += 1;
        if (renames === 2) {
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
    const fsImpl = {
      ...fs,
      closeSync(fd) {
        fs.closeSync(fd);
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
    }))), /lock presente/u);
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
    let renames = 0;
    const fsImpl = {
      ...fs,
      renameSync(from, to) {
        renames += 1;
        if (renames === 2) {
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
      assert.equal(error.errors.some((item) => item.code === 'EACCES'), true);
      return true;
    });

    assert.equal(fs.readFileSync(first, 'utf8'), 'first-before');
    assert.equal(fs.readFileSync(second, 'utf8'), 'second-before');
    assert.equal(fs.readdirSync(root).filter((name) => name.endsWith('.pair.tmp')).length, 1);
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.lock')), false);
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
    let renames = 0;
    const fsImpl = {
      ...fs,
      renameSync(from, to) {
        renames += 1;
        if (renames === 2 || renames === 3) {
          const error = new Error(renames === 2 ? 'commit denied' : 'rollback denied');
          error.code = renames === 2 ? 'EIO' : 'EROFS';
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

    assert.equal(fs.readFileSync(first, 'utf8'), 'first-after');
    assert.equal(fs.readFileSync(second, 'utf8'), 'second-before');
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.lock')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('un arresto del processo tra i rename lascia la finestra crash non transazionale dichiarata', () => {
  const root = fixture();
  try {
    const first = path.join(root, 'first.txt');
    const second = path.join(root, 'second.txt');
    fs.writeFileSync(first, 'first-before');
    fs.writeFileSync(second, 'second-before');
    const helper = new URL('../../scripts/lib/write-file-pair-atomically.mjs', import.meta.url).href;
    const program = `
      import fs from 'node:fs';
      import { writeFilePairAtomically } from ${JSON.stringify(helper)};
      const renameSync = fs.renameSync.bind(fs);
      let renameCount = 0;
      const fsImpl = { ...fs, renameSync(from, to) {
        renameSync(from, to);
        renameCount += 1;
        if (renameCount === 1) process.exit(73);
      } };
      writeFilePairAtomically([
        { file: ${JSON.stringify(first)}, before: 'first-before', after: 'first-after' },
        { file: ${JSON.stringify(second)}, before: 'second-before', after: 'second-after' },
      ], { fsImpl });
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8' });

    assert.equal(child.status, 73, child.stderr);
    assert.equal(fs.readFileSync(first, 'utf8'), 'first-after');
    assert.equal(fs.readFileSync(second, 'utf8'), 'second-before');
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.lock')), true);
    assert.throws(() => writeFilePairAtomically([
      { file: first, before: 'first-before', after: 'retry-first' },
      { file: second, before: 'second-before', after: 'retry-second' },
    ]), /lock presente/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
