import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { writeFilePairAtomically } from '../../scripts/lib/write-file-pair-atomically.mjs';

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'file-pair-atomic-'));
}

test('ripristina il primo file quando il rename del secondo fallisce', () => {
  const root = fixture();
  try {
    const first = path.join(root, 'first.txt');
    const secondDirectory = path.join(root, 'second.txt');
    fs.writeFileSync(first, 'first-before');
    fs.mkdirSync(secondDirectory);

    assert.throws(() => writeFilePairAtomically([
      { file: first, before: 'first-before', after: 'first-after' },
      { file: secondDirectory, before: 'second-before', after: 'second-after' },
    ]), /EISDIR|EEXIST|directory/u);

    assert.equal(fs.readFileSync(first, 'utf8'), 'first-before');
    assert.deepEqual(fs.readdirSync(root).filter((name) => name.endsWith('.pair.tmp')), []);
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
    const secondDirectory = path.join(root, 'second.txt');
    fs.writeFileSync(first, 'first-before');
    fs.mkdirSync(secondDirectory);
    const fsImpl = {
      ...fs,
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
      { file: secondDirectory, before: 'second-before', after: 'second-after' },
    ], { fsImpl }), (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(error.errors.some((item) => item.code === 'EACCES'), true);
      return true;
    });

    assert.equal(fs.readFileSync(first, 'utf8'), 'first-before');
    assert.equal(fs.readdirSync(root).filter((name) => name.endsWith('.pair.tmp')).length, 1);
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
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
