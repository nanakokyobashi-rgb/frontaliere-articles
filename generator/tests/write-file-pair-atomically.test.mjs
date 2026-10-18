import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

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

function failAfterUncertainStaging(file) {
  const helper = new URL('../../scripts/lib/write-file-pair-atomically.mjs', import.meta.url).href;
  const canonicalFile = fs.realpathSync(file);
  const program = `
    import fs from 'node:fs';
    import { writeFilePairAtomically } from ${JSON.stringify(helper)};
    const target = ${JSON.stringify(canonicalFile)};
    let stagingFile = null;
    const fsImpl = {
      ...fs,
      writeFileSync(file, ...args) {
        if (stagingFile === null && typeof file === 'string' && file.endsWith('.pair.tmp')) {
          stagingFile = file;
          fs.writeFileSync(file, 'partial', { encoding: 'utf8', flag: 'wx' });
          const error = new Error('injected ENOSPC after partial staging write');
          error.code = 'ENOSPC';
          throw error;
        }
        return fs.writeFileSync(file, ...args);
      },
      lstatSync(file, ...args) {
        if (file === stagingFile) {
          const error = new Error('injected EIO during staging ownership probe');
          error.code = 'EIO';
          throw error;
        }
        return fs.lstatSync(file, ...args);
      },
    };
    function errorCodes(error) {
      return [
        error?.code,
        ...(error instanceof AggregateError ? error.errors.flatMap(errorCodes) : []),
      ].filter(Boolean);
    }
    try {
      writeFilePairAtomically([
        { file: target, before: 'before', after: 'after' },
      ], { fsImpl });
    } catch (error) {
      console.error(error.stack);
      console.error('error codes: ' + errorCodes(error).join(','));
      process.exitCode = 73;
    }
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8' });
}

function spawnPairWriter(first, second, firstAfter, secondAfter, { holdMarker = null, releaseMarker = null } = {}) {
  const helper = new URL('../../scripts/lib/write-file-pair-atomically.mjs', import.meta.url).href;
  const canonicalFirst = fs.realpathSync(first);
  const canonicalSecond = fs.realpathSync(second);
  const program = `
    import fs from 'node:fs';
    import { writeFilePairAtomically } from ${JSON.stringify(helper)};
    const first = ${JSON.stringify(canonicalFirst)};
    const second = ${JSON.stringify(canonicalSecond)};
    const holdMarker = ${JSON.stringify(holdMarker)};
    const releaseMarker = ${JSON.stringify(releaseMarker)};
    const renameSync = fs.renameSync.bind(fs);
    const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
    const fsImpl = { ...fs, renameSync(from, to) {
      renameSync(from, to);
      if (holdMarker && to === first) {
        fs.writeFileSync(holdMarker, 'held', { flag: 'wx' });
        while (!fs.existsSync(releaseMarker)) Atomics.wait(waitBuffer, 0, 0, 10);
      }
    } };
    try {
      writeFilePairAtomically([
        { file: first, before: 'before', after: ${JSON.stringify(firstAfter)} },
        { file: second, before: 'before', after: ${JSON.stringify(secondAfter)} },
      ], { fsImpl });
    } catch (error) {
      console.error(error.stack);
      process.exitCode = 1;
    }
  `;
  return spawn(process.execPath, ['--input-type=module', '-e', program], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function waitForChild(child) {
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stderr }));
  });
}

async function waitForFile(file) {
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(file) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(file), true, `file sentinella non creato: ${file}`);
}

function hasErrorCode(error, code) {
  return error?.code === code
    || (error instanceof AggregateError && error.errors.some((item) => hasErrorCode(item, code)));
}

test('una collisione del temporaneo journal conserva il file dell’altra operazione', () => {
  const root = fixture();
  try {
    const first = path.join(root, 'first.txt');
    fs.writeFileSync(first, 'before');
    let foreignTemporary = null;
    const fsImpl = {
      ...fs,
      openSync(file, ...args) {
        const name = path.basename(file);
        if (!foreignTemporary
            && name.startsWith('.registry-pair-write.journal.json.')
            && name.endsWith('.tmp')) {
          foreignTemporary = file;
          fs.writeFileSync(file, 'foreign journal temporary', { flag: 'wx' });
        }
        return fs.openSync(file, ...args);
      },
    };

    assert.throws(() => writeFilePairAtomically([
      { file: first, before: 'before', after: 'after' },
    ], { fsImpl }), (error) => hasErrorCode(error, 'EEXIST'));

    assert.ok(foreignTemporary);
    assert.equal(fs.readFileSync(foreignTemporary, 'utf8'), 'foreign journal temporary');
    assert.equal(fs.readFileSync(first, 'utf8'), 'before');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('una collisione dello staging conserva il file dell’altra operazione', () => {
  const root = fixture();
  try {
    const first = path.join(root, 'first.txt');
    fs.writeFileSync(first, 'before');
    let foreignTemporary = null;
    const fsImpl = {
      ...fs,
      writeFileSync(file, ...args) {
        if (!foreignTemporary
            && typeof file === 'string'
            && path.basename(file).startsWith('first.txt.')
            && file.endsWith('.pair.tmp')) {
          foreignTemporary = file;
          fs.writeFileSync(file, 'foreign staging temporary', { flag: 'wx' });
        }
        return fs.writeFileSync(file, ...args);
      },
    };

    assert.throws(() => writeFilePairAtomically([
      { file: first, before: 'before', after: 'after' },
    ], { fsImpl }), (error) => hasErrorCode(error, 'EEXIST'));

    assert.ok(foreignTemporary);
    assert.equal(fs.readFileSync(foreignTemporary, 'utf8'), 'foreign staging temporary');
    assert.equal(fs.readFileSync(first, 'utf8'), 'before');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writer concorrenti non pubblicano una coppia mista mentre il primo commit è in corso', async () => {
  const root = fixture();
  let firstWriterResult;
  let contenderResult;
  try {
    const first = path.join(root, 'first.txt');
    const second = path.join(root, 'second.txt');
    const holdMarker = path.join(root, 'writer-a-held');
    const releaseMarker = path.join(root, 'writer-a-release');
    fs.writeFileSync(first, 'before');
    fs.writeFileSync(second, 'before');

    const firstWriter = spawnPairWriter(first, second, 'writer-a-first', 'writer-a-second', {
      holdMarker,
      releaseMarker,
    });
    firstWriterResult = waitForChild(firstWriter);
    await waitForFile(holdMarker);

    const contender = spawnPairWriter(first, second, 'writer-b-first', 'writer-b-second');
    contenderResult = waitForChild(contender);
    const contenderOutcome = await contenderResult;
    assert.notEqual(contenderOutcome.code, 0, contenderOutcome.stderr);
    assert.match(contenderOutcome.stderr, /journal della coppia presente|lock presente/u);

    fs.writeFileSync(releaseMarker, 'release');
    const firstWriterOutcome = await firstWriterResult;
    assert.equal(firstWriterOutcome.code, 0, firstWriterOutcome.stderr);
    assert.equal(fs.readFileSync(first, 'utf8'), 'writer-a-first');
    assert.equal(fs.readFileSync(second, 'utf8'), 'writer-a-second');
    assert.deepEqual(fs.readdirSync(root).filter((name) => name.endsWith('.pair.tmp')), []);
  } finally {
    if (!fs.existsSync(path.join(root, 'writer-a-release'))) {
      fs.writeFileSync(path.join(root, 'writer-a-release'), 'release');
    }
    if (firstWriterResult) await firstWriterResult;
    if (contenderResult) await contenderResult;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('un errore dopo la creazione dello staging rimuove solo il temporaneo della transazione', () => {
  const root = fixture();
  try {
    const first = path.join(root, 'first.txt');
    fs.writeFileSync(first, 'before');
    let injected = false;
    const fsImpl = {
      ...fs,
      writeFileSync(file, ...args) {
        if (!injected && typeof file === 'string' && file.endsWith('.pair.tmp')) {
          injected = true;
          fs.writeFileSync(file, 'partial', { encoding: 'utf8', flag: 'wx' });
          const error = new Error('injected ENOSPC after partial staging write');
          error.code = 'ENOSPC';
          throw error;
        }
        return fs.writeFileSync(file, ...args);
      },
    };

    assert.throws(() => writeFilePairAtomically([
      { file: first, before: 'before', after: 'after' },
    ], { fsImpl }), (error) => {
      assert.equal(injected, true);
      assert.equal(hasErrorCode(error, 'ENOSPC'), true);
      return true;
    });
    assert.equal(fs.readFileSync(first, 'utf8'), 'before');
    assert.deepEqual(fs.readdirSync(root).filter((name) => name.endsWith('.pair.tmp')), []);
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.lock')), false);
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.journal.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('una probe ownership incerta conserva target, marker, journal e lock per recovery', () => {
  const root = fixture();
  try {
    const first = path.join(root, 'first.txt');
    fs.writeFileSync(first, 'before');
    const child = failAfterUncertainStaging(first);
    assert.equal(child.status, 73, child.stderr);
    assert.match(child.stderr, /error codes:.*ENOSPC/u);
    assert.match(child.stderr, /error codes:.*EIO/u);
    assert.equal(fs.readFileSync(first, 'utf8'), 'before');

    const stagingFiles = fs.readdirSync(root).filter((name) => name.endsWith('.pair.tmp'));
    assert.deepEqual(stagingFiles.length, 1);
    const stagingFile = path.join(root, stagingFiles[0]);
    assert.equal(fs.readFileSync(stagingFile, 'utf8'), 'partial');
    const journalFile = path.join(root, '.registry-pair-write.journal.json');
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.lock')), true);
    assert.equal(fs.existsSync(journalFile), true);
    assert.equal(JSON.parse(fs.readFileSync(journalFile, 'utf8')).phase, 'prepared');

    assert.deepEqual(recoverInterruptedRegistryPair(root), { recovered: true, state: 'restored-before' });
    assert.equal(fs.readFileSync(first, 'utf8'), 'before');
    assert.deepEqual(fs.readdirSync(root).filter((name) => name.endsWith('.pair.tmp')), []);
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.lock')), false);
    assert.equal(fs.existsSync(journalFile), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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

test('un writer non ripristina il journal committed di un writer precedente', () => {
  const root = fixture();
  try {
    const first = path.join(root, 'first.txt');
    const second = path.join(root, 'second.txt');
    const lockFile = path.join(root, '.registry-pair-write.lock');
    const journalFile = path.join(root, '.registry-pair-write.journal.json');
    fs.writeFileSync(first, 'first-before');
    fs.writeFileSync(second, 'second-before');

    let committedJournal = null;
    const captureCommittedJournal = {
      ...fs,
      renameSync(from, to) {
        fs.renameSync(from, to);
        if (path.basename(to) === path.basename(journalFile)) {
          const journal = JSON.parse(fs.readFileSync(to, 'utf8'));
          if (journal.phase === 'committed') committedJournal = fs.readFileSync(to, 'utf8');
        }
      },
    };
    writeFilePairAtomically([
      { file: first, before: 'first-before', after: 'first-committed' },
      { file: second, before: 'second-before', after: 'second-committed' },
    ], { fsImpl: captureCommittedJournal });
    assert.equal(typeof committedJournal, 'string');

    let injected = false;
    const previousCommitAppearsAfterLock = {
      ...fs,
      openSync(file, ...args) {
        const fd = fs.openSync(file, ...args);
        if (path.basename(file) === path.basename(lockFile) && !injected) {
          fs.writeFileSync(path.join(path.dirname(file), path.basename(journalFile)), committedJournal, 'utf8');
          injected = true;
        }
        return fd;
      },
    };

    assert.throws(() => writeFilePairAtomically([
      { file: first, before: 'first-committed', after: 'first-next' },
      { file: second, before: 'second-committed', after: 'second-next' },
    ], { fsImpl: previousCommitAppearsAfterLock }), /journal della coppia presente/u);

    assert.equal(injected, true);
    assert.equal(fs.readFileSync(first, 'utf8'), 'first-committed');
    assert.equal(fs.readFileSync(second, 'utf8'), 'second-committed');
    assert.equal(fs.readFileSync(journalFile, 'utf8'), committedJournal);
    assert.equal(fs.existsSync(lockFile), false);
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

test('recovery ripetibile dopo una scrittura parziale del temporaneo di ripristino', () => {
  const root = fixture();
  try {
    const first = path.join(root, 'first.txt');
    const second = path.join(root, 'second.txt');
    fs.writeFileSync(first, 'first-before');
    fs.writeFileSync(second, 'second-before');
    const child = interruptAfterTargetRenames(first, second, 1);
    assert.equal(child.status, 73, child.stderr);

    const openFiles = new Map();
    let injected = false;
    let partialWritten = false;
    const fsImpl = {
      ...fs,
      openSync(file, ...args) {
        const fd = fs.openSync(file, ...args);
        if (typeof file === 'string' && file.endsWith('.pair-recovery.tmp')) {
          openFiles.set(fd, file);
        }
        return fd;
      },
      writeFileSync(file, ...args) {
        if (typeof file === 'number' && openFiles.has(file) && !injected) {
          injected = true;
          fs.writeFileSync(file, String(args[0]).slice(0, 4), args[1]);
          partialWritten = true;
          const error = new Error('injected ENOSPC after partial recovery write');
          error.code = 'ENOSPC';
          throw error;
        }
        return fs.writeFileSync(file, ...args);
      },
      closeSync(fd) {
        openFiles.delete(fd);
        return fs.closeSync(fd);
      },
    };

    assert.throws(() => recoverInterruptedRegistryPair(root, { fsImpl }), (error) => {
      assert.equal(injected, true);
      assert.equal(partialWritten, true);
      assert.equal(hasErrorCode(error, 'ENOSPC'), true);
      return true;
    });
    assert.equal(fs.readFileSync(first, 'utf8'), 'first-after');
    assert.equal(fs.readFileSync(second, 'utf8'), 'second-before');
    assert.deepEqual(fs.readdirSync(root).filter((name) => name.endsWith('.pair-recovery.tmp')), []);
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

test('recovery conserva staging legacy PID.sequence senza identità di transazione', () => {
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
    const secondEntry = journal.entries.find((entry) => entry.file === fs.realpathSync(second));
    fs.unlinkSync(secondEntry.stagingFile);
    const legacyStaging = `${secondEntry.file}.${journal.pid}.0.pair.tmp`;
    secondEntry.stagingFile = legacyStaging;
    fs.writeFileSync(journalFile, `${JSON.stringify(journal)}\n`);
    fs.writeFileSync(legacyStaging, 'second-after', { flag: 'wx' });

    assert.deepEqual(recoverInterruptedRegistryPair(root), { recovered: true, state: 'restored-before' });
    assert.equal(fs.readFileSync(first, 'utf8'), 'first-before');
    assert.equal(fs.readFileSync(second, 'utf8'), 'second-before');
    assert.equal(fs.readFileSync(legacyStaging, 'utf8'), 'second-after');
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.lock')), false);
    assert.equal(fs.existsSync(journalFile), false);
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

test('recovery non rimuove un journal committed senza lock mentre il writer è ancora vivo', () => {
  const root = fixture();
  try {
    const first = path.join(root, 'first.txt');
    const second = path.join(root, 'second.txt');
    fs.writeFileSync(first, 'first-before');
    fs.writeFileSync(second, 'second-before');
    const writerLock = path.join(fs.realpathSync(root), '.registry-pair-write.lock');
    let recoveryError;
    const fsImpl = {
      ...fs,
      unlinkSync(file) {
        fs.unlinkSync(file);
        if (file === writerLock) {
          try {
            recoverInterruptedRegistryPair(root);
          } catch (error) {
            recoveryError = error;
          }
        }
      },
    };

    assert.doesNotThrow(() => writeFilePairAtomically([
      { file: first, before: 'first-before', after: 'first-after' },
      { file: second, before: 'second-before', after: 'second-after' },
    ], { fsImpl }));

    assert.match(recoveryError?.message ?? '', /writer .*ancora attivo/u);
    assert.equal(fs.readFileSync(first, 'utf8'), 'first-after');
    assert.equal(fs.readFileSync(second, 'utf8'), 'second-after');
    assert.equal(fs.existsSync(writerLock), false);
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.journal.json')), false);
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-recovery.lock')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recovery pulisce un journal committed senza lock dopo la terminazione del writer', () => {
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
    fs.unlinkSync(path.join(root, '.registry-pair-write.lock'));

    assert.deepEqual(recoverInterruptedRegistryPair(root), { recovered: true, state: 'kept-committed' });
    assert.equal(fs.readFileSync(first, 'utf8'), 'first-after');
    assert.equal(fs.readFileSync(second, 'utf8'), 'second-after');
    assert.equal(fs.existsSync(path.join(root, '.registry-pair-write.lock')), false);
    assert.equal(fs.existsSync(journalFile), false);
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
