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
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { reportDegradationAlarms, readPreviousSnapshot } from '../scripts/refresh-daily-brief-data.mjs';
import { MAX_CONSECUTIVE_DEGRADED_EDITIONS } from '../scripts/lib/daily-brief-data.mjs';

/** A snapshot whose jobs block has been degraded for `editions` runs. */
function briefWithStreak(editions, before = null) {
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

/** Run `fn` with console.error/warn captured, env patched, exitCode restored. */
function capture(fn, env = {}) {
  const lines = [];
  const { error, warn } = console;
  const before = process.exitCode;
  const restore = Object.entries(env).map(([k, v]) => [k, process.env[k], v]);
  for (const [k, , v] of restore) process.env[k] = v;
  console.error = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    fn();
    return { lines, exitCode: process.exitCode };
  } finally {
    console.error = error;
    console.warn = warn;
    process.exitCode = before;
    for (const [k, old] of restore) {
      if (old === undefined) delete process.env[k];
      else process.env[k] = old;
    }
  }
}

test('the alarm names the block, the streak and the reason, and reaches the step summary', () => {
  const summary = path.join(mkdtempSync(path.join(tmpdir(), 'daily-brief-')), 'summary.md');
  writeFileSync(summary, '');
  const { lines, exitCode } = capture(
    () => reportDegradationAlarms(briefWithStreak(MAX_CONSECUTIVE_DEGRADED_EDITIONS), { dryRun: false }),
    { GITHUB_STEP_SUMMARY: summary },
  );
  // The annotation: a run whose only trace is "3/4 blocks" is what let this go
  // unnoticed in the first place.
  assert.ok(lines.some((l) => l.startsWith('::error::') && l.includes('jobs') && l.includes(`${MAX_CONSECUTIVE_DEGRADED_EDITIONS} consecutive editions`)), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes('no history series')), 'the reason travels with the alarm');

  // The summary: the annotation scrolls away in the log, this does not.
  const written = readFileSync(summary, 'utf-8');
  assert.match(written, /degradazione persistente/);
  assert.match(written, /`jobs`/);
  assert.match(written, /degradedEditions/, 'it says where the counter lives');

  // And the exit code stays clean — see the next test for why that is the point.
  assert.equal(exitCode, undefined);
});

test('the alarm never fails the run, because failing here also skips the commit', () => {
  // The structural constraint, and the reason the first two drafts of this
  // alarm were wrong. This script is the FIRST step of generate-daily-brief.yml
  // and `Commit and push` sits behind its implicit `if: success()`. A non-zero
  // exit does not just skip today's edition: it skips the commit, so the
  // snapshot that carries the streak never leaves the runner. Tomorrow's
  // checkout restores the D-1 snapshot, the streak recomputes to the same
  // number, the crossing reads as new again — red every morning forever, with
  // the bulletin gone too. A `workflow_dispatch` reads the committed file, so
  // it cannot break the loop either.
  for (const [editions, before] of [[MAX_CONSECUTIVE_DEGRADED_EDITIONS, MAX_CONSECUTIVE_DEGRADED_EDITIONS - 1], [MAX_CONSECUTIVE_DEGRADED_EDITIONS + 7, MAX_CONSECUTIVE_DEGRADED_EDITIONS + 6]]) {
    const { lines, exitCode } = capture(() => reportDegradationAlarms(
      briefWithStreak(editions),
      { dryRun: false, previous: briefWithStreak(before) },
    ));
    assert.equal(exitCode, undefined, `streak ${editions} must not fail the step that owns the commit`);
    assert.ok(lines.some((l) => l.startsWith('::error::')), 'but it must still be announced');
  }
});

test('the crossing edition and the ones after it read differently', () => {
  const crossing = capture(() => reportDegradationAlarms(
    briefWithStreak(MAX_CONSECUTIVE_DEGRADED_EDITIONS),
    { dryRun: false, previous: briefWithStreak(MAX_CONSECUTIVE_DEGRADED_EDITIONS - 1) },
  ));
  assert.ok(crossing.lines.some((l) => l.includes('just reached')), crossing.lines.join('\n'));

  const after = capture(() => reportDegradationAlarms(
    briefWithStreak(MAX_CONSECUTIVE_DEGRADED_EDITIONS + 1),
    { dryRun: false, previous: briefWithStreak(MAX_CONSECUTIVE_DEGRADED_EDITIONS) },
  ));
  assert.ok(after.lines.some((l) => l.includes('still degraded past')), after.lines.join('\n'));
});

test('a streak that round-tripped to a string does not re-arm the alarm every day', () => {
  // The two readers used to disagree: the filter coerced with `Number()`, the
  // previous-streak reader demanded `Number.isFinite`. A snapshot carrying "3"
  // as a string therefore raised the alarm AND counted as a previous streak of
  // 0, so every edition looked like a fresh crossing.
  const stringy = briefWithStreak(String(MAX_CONSECUTIVE_DEGRADED_EDITIONS + 1));
  const { lines } = capture(() => reportDegradationAlarms(stringy, { dryRun: false, previous: stringy }));
  assert.deepEqual(lines, [], 'an unreadable streak is 0 on both sides, not alarm on one and 0 on the other');
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
