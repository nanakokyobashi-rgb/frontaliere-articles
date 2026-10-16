import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  EVERGREEN_REJECTED_SCHEMA_VERSION,
  appendEvergreenRejected,
  loadEvergreenRejectedTracker,
  persistEvergreenRejectedTrackerAtomically,
  recordTopicGateAbortedUrl,
  strikeEvergreenKeyword,
} from '../scripts/lib/article-topic-selector.mjs';

const CONTEXT = {
  section: 'frontaliere',
  pool: 'evergreen',
  poolEpoch: 'atomic-ledger-test',
};

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evergreen-ledger-atomic-'));
  return { directory, file: path.join(directory, 'tracker.json') };
}

function seededTracker(now = Date.now()) {
  let tracker = {
    schemaVersion: EVERGREEN_REJECTED_SCHEMA_VERSION,
    bans: [],
    strikes: [],
    legacy: [],
    topicGateUrls: {},
  };
  tracker = appendEvergreenRejected(tracker, 'seed-ban', { context: CONTEXT, now });
  tracker = strikeEvergreenKeyword(tracker, 'shared-strike', { context: CONTEXT, now });
  tracker = recordTopicGateAbortedUrl(tracker, 'https://example.test/seed', 'frontaliere', now);
  return tracker;
}

function startNode(script) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'inherit' });
  return { child, exit: once(child, 'exit') };
}

test('processi concorrenti serializzano gli aggiornamenti senza perdere ban, strike o memo', async () => {
  const { directory, file } = fixture();
  try {
    persistEvergreenRejectedTrackerAtomically(() => seededTracker(), { path: file });
    const moduleUrl = new URL('../scripts/lib/article-topic-selector.mjs', import.meta.url).href;
    const writerCount = 8;
    const children = Array.from({ length: writerCount }, (_, index) => {
      const keyword = `parallel-ban-${index}`;
      const script = `
        import * as ledger from ${JSON.stringify(moduleUrl)};
        const context = ${JSON.stringify(CONTEXT)};
        const result = ledger.persistEvergreenRejectedTrackerAtomically((tracker) => {
          const withBan = ledger.appendEvergreenRejected(tracker, ${JSON.stringify(keyword)}, {
            context,
            now: Date.now(),
          });
          return ledger.strikeEvergreenKeyword(withBan, 'shared-strike', {
            context,
            now: Date.now(),
          });
        }, { path: ${JSON.stringify(file)} });
        if (!result) process.exit(2);
      `;
      return startNode(script);
    });
    const exits = await Promise.all(children.map(({ exit }) => exit));
    assert.deepEqual(exits.map(([code, signal]) => ({ code, signal })),
      Array.from({ length: writerCount }, () => ({ code: 0, signal: null })));

    const tracker = loadEvergreenRejectedTracker({ path: file });
    const bans = new Set(tracker.bans.map((entry) => entry.keyword));
    assert.ok(bans.has('seed-ban'));
    for (let index = 0; index < writerCount; index++) assert.ok(bans.has(`parallel-ban-${index}`));
    assert.equal(
      tracker.strikes.find((entry) => entry.keyword === 'shared-strike')?.count,
      writerCount + 1,
    );
    const memo = tracker.topicGateUrls['frontaliere::https://example.test/seed'];
    assert.equal(memo.section, 'frontaliere');
    assert.equal(typeof memo.ts, 'number');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('un crash prima del rename lascia il ledger precedente intatto e il lock recuperabile', async () => {
  const { directory, file } = fixture();
  try {
    const initial = seededTracker();
    persistEvergreenRejectedTrackerAtomically(() => initial, { path: file });
    const originalBytes = fs.readFileSync(file);
    const moduleUrl = new URL('../scripts/lib/article-topic-selector.mjs', import.meta.url).href;
    const script = `
      import * as ledger from ${JSON.stringify(moduleUrl)};
      ledger.persistEvergreenRejectedTrackerAtomically((tracker) =>
        ledger.appendEvergreenRejected(tracker, 'crash-only-ban', {
          context: ${JSON.stringify(CONTEXT)},
          now: Date.now(),
        }), {
          path: ${JSON.stringify(file)},
          _beforeAtomicReplaceForTest() { process.exit(86); },
        });
      process.exit(0);
    `;
    const { exit } = startNode(script);
    const [code, signal] = await exit;
    assert.equal(signal, null);
    assert.equal(code, 86);
    assert.deepEqual(fs.readFileSync(file), originalBytes, 'il ledger valido non viene troncato o sostituito');

    const updated = persistEvergreenRejectedTrackerAtomically((tracker) =>
      appendEvergreenRejected(tracker, 'after-crash-ban', { context: CONTEXT, now: Date.now() }),
    { path: file });
    const keywords = new Set(updated.bans.map((entry) => entry.keyword));
    assert.ok(keywords.has('seed-ban'));
    assert.ok(keywords.has('after-crash-ban'));
    assert.ok(!keywords.has('crash-only-ban'));
    assert.equal(updated.strikes.find((entry) => entry.keyword === 'shared-strike')?.count, 1);
    assert.deepEqual(fs.readdirSync(directory), ['tracker.json']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('un reaper interrotto viene recuperato prima della prossima scrittura', async () => {
  const { directory, file } = fixture();
  try {
    const { child, exit } = startNode('process.exit(0);');
    const deadPid = child.pid;
    assert.ok(deadPid);
    await exit;

    const lockPath = `${file}.lock`;
    const reaperPath = `${lockPath}.reaper`;
    fs.mkdirSync(lockPath);
    fs.mkdirSync(reaperPath);
    fs.writeFileSync(lockPath + '/owner.json', JSON.stringify({ pid: deadPid, token: 'dead-ledger' }));
    fs.writeFileSync(reaperPath + '/owner.json', JSON.stringify({ pid: deadPid, token: 'dead-reaper' }));

    const updated = persistEvergreenRejectedTrackerAtomically(
      (tracker) => appendEvergreenRejected(tracker, 'after-reaper-crash', { context: CONTEXT }),
      { path: file },
    );
    assert.ok(updated.bans.some((entry) => entry.keyword === 'after-reaper-crash'));
    assert.deepEqual(fs.readdirSync(directory), ['tracker.json']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('un ledger non valido rifiuta la transazione e resta byte per byte invariato', (t) => {
  const { directory, file } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = '{"schemaVersion":2,"bans":[null],"strikes":[],"legacy":[],"topicGateUrls":{}}\n';
  fs.writeFileSync(file, original);

  assert.throws(
    () => persistEvergreenRejectedTrackerAtomically(
      (tracker) => appendEvergreenRejected(tracker, 'must-not-write', { context: CONTEXT }),
      { path: file },
    ),
    /invalid evergreen ledger/,
  );
  assert.equal(loadEvergreenRejectedTracker({ path: file }).invalid, true);
  assert.equal(fs.readFileSync(file, 'utf-8'), original);
});

test('create-article aggiorna ban, strike e memo tramite il mutator atomico', () => {
  const source = fs.readFileSync(new URL('../scripts/create-article.mjs', import.meta.url), 'utf-8');
  const migrationSource = fs.readFileSync(new URL('../scripts/migrate-evergreen-rejected-ledger.mjs', import.meta.url), 'utf-8');
  const resetSource = fs.readFileSync(new URL('../scripts/reset-evergreen-strikes.mjs', import.meta.url), 'utf-8');
  assert.match(source, /persistEvergreenRejectedTrackerAtomically as _persistEvergreenRejectedTrackerAt/);
  assert.match(source, /function _persistEvergreenRejectedTracker\(update\) \{ return _persistEvergreenRejectedTrackerAt\(update, sectionStateOpts\('evergreenRejected'\)\); \}/);
  assert.match(source, /evergreenRejectedTracker = _persistEvergreenRejectedTracker\(\s*\(tracker\) => _appendEvergreenRejected\(/);
  assert.match(source, /evergreenRejectedTracker = _persistEvergreenRejectedTracker\(\s*\(tracker\) => _strikeEvergreenKeyword\(/);
  assert.match(source, /_persistEvergreenRejectedTracker\(\(tracker\) => _recordTopicGateAbortedUrl\(/);
  assert.doesNotMatch(source, /_persistEvergreenRejectedTracker\(evergreenRejectedTracker\)/);
  assert.match(migrationSource, /persistEvergreenRejectedTrackerAtomically/);
  assert.doesNotMatch(migrationSource, /persistEvergreenRejectedTracker\(/);
  assert.match(resetSource, /persistEvergreenRejectedTrackerAtomically\(\(ledger\) =>/);
});
