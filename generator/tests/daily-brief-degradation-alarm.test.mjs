// generator/tests/daily-brief-degradation-alarm.test.mjs
//
// The observer for the failure mode this whole cluster is about: a payload
// that changes shape upstream degrades one block of the Bollettino FOREVER,
// the edition keeps publishing on the remaining three, and every run is green.
// "Less content, no error" is the one shape the per-block degradation rules
// cannot see on their own, because none of them remembers yesterday.
//
// `degradationAlarms` (pure, in daily-brief-data.mjs) decides; this file pins
// that the refresh script actually ACTS on the decision — a red run — because
// an alarm nobody is made to read is the same silence with extra JSON.
//
// Importing the script is safe: it runs `main()` only when it is argv[1].

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { reportDegradationAlarms, readPreviousSnapshot } from '../scripts/refresh-daily-brief-data.mjs';
import { MAX_CONSECUTIVE_DEGRADED_EDITIONS } from '../scripts/lib/daily-brief-data.mjs';

/** A snapshot whose jobs block has been degraded for `editions` runs. */
function briefWithStreak(editions) {
  return {
    dateIso: '2026-09-05',
    counts: { availableBlocks: 3 },
    blocks: {
      borderWait: { available: true, degradedEditions: 0 },
      fuel: { available: true, degradedEditions: 0 },
      exchange: { available: true, degradedEditions: 0 },
      jobs: { available: false, reason: 'jobs-stats.json carries no history series', degradedEditions: editions },
    },
  };
}

/** Run `fn` with console.error/warn captured and `process.exitCode` restored. */
function capture(fn) {
  const lines = [];
  const { error, warn } = console;
  const before = process.exitCode;
  console.error = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    fn();
    return { lines, exitCode: process.exitCode };
  } finally {
    console.error = error;
    console.warn = warn;
    process.exitCode = before;
  }
}

test('a block degraded past the threshold turns the run red', () => {
  const { lines, exitCode } = capture(() => reportDegradationAlarms(briefWithStreak(MAX_CONSECUTIVE_DEGRADED_EDITIONS), { dryRun: false }));
  assert.equal(exitCode, 1, 'a permanent silent degradation must not exit green');
  // The annotation names the block and the streak: a run summary that says
  // only "3/4 blocks" is what let this go unnoticed in the first place.
  assert.ok(lines.some((l) => l.startsWith('::error::') && l.includes('jobs') && l.includes(`${MAX_CONSECUTIVE_DEGRADED_EDITIONS} consecutive editions`)), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes('no history series')), 'the reason travels with the alarm');
});

test('a source having a bad morning stays green', () => {
  for (const editions of [1, MAX_CONSECUTIVE_DEGRADED_EDITIONS - 1]) {
    const { lines, exitCode } = capture(() => reportDegradationAlarms(briefWithStreak(editions), { dryRun: false }));
    assert.equal(exitCode, undefined, `streak ${editions} must not fail the cron`);
    assert.deepEqual(lines, [], `streak ${editions} must not shout`);
  }
});

test('the dry self-test reports the alarm without inheriting production red', () => {
  // The on-push run renders against live data. A block that is broken in
  // production is a real alarm, but it is not this push's fault: it gets a
  // warning, not an error annotation and not a failing exit code.
  const { lines, exitCode } = capture(() => reportDegradationAlarms(briefWithStreak(MAX_CONSECUTIVE_DEGRADED_EDITIONS + 4), { dryRun: true }));
  assert.equal(exitCode, undefined);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith('⚠️'), lines[0]);
});

test('an unreadable previous snapshot restarts the count instead of stopping the refresh', () => {
  // The streak's only storage is the committed snapshot. If it is missing or
  // corrupt the count restarts — losing an alarm is recoverable, refusing to
  // refresh over it would take the bulletin down for a bookkeeping file.
  const dir = mkdtempSync(path.join(tmpdir(), 'daily-brief-'));
  assert.equal(readPreviousSnapshot(path.join(dir, 'absent.json')), null);

  const garbage = path.join(dir, 'garbage.json');
  writeFileSync(garbage, '{ not json');
  assert.equal(readPreviousSnapshot(garbage), null);

  const good = path.join(dir, 'good.json');
  writeFileSync(good, JSON.stringify(briefWithStreak(2)));
  assert.equal(readPreviousSnapshot(good).blocks.jobs.degradedEditions, 2);
});
