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
// WHERE the red is spent is the other half: never from this step, which owns
// the commit, but from a gate step in `generate-daily-brief.yml` that runs
// AFTER it and reads the crossing off `$GITHUB_OUTPUT`. The streak only becomes
// durable once the snapshot is committed, so a red before the commit would
// re-cross the threshold every morning — bulletin gone, forever.
//
// Importing the script is safe: it runs `main()` only when it is argv[1].

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  reportDegradationAlarms,
  readPreviousSnapshot,
  DEGRADATION_CROSSED_OUTPUT,
  DEGRADATION_BLOCKS_OUTPUT,
} from '../scripts/refresh-daily-brief-data.mjs';
import { MAX_CONSECUTIVE_DEGRADED_EDITIONS } from '../scripts/lib/daily-brief-data.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'generate-daily-brief.yml');

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

/**
 * Run `fn` with console.error/warn captured, env patched, exitCode restored,
 * and a scratch `$GITHUB_OUTPUT` — the verdict the workflow gate reads lands
 * there, so it is asserted the same way the run would see it.
 */
function capture(fn, env = {}) {
  const lines = [];
  const { error, warn } = console;
  const before = process.exitCode;
  const outputFile = path.join(mkdtempSync(path.join(tmpdir(), 'daily-brief-out-')), 'output.txt');
  writeFileSync(outputFile, '');
  const restore = Object.entries({ GITHUB_OUTPUT: outputFile, ...env }).map(([k, v]) => [k, process.env[k], v]);
  for (const [k, , v] of restore) process.env[k] = v;
  console.error = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    fn();
    return { lines, exitCode: process.exitCode, outputs: parseOutputs(readFileSync(outputFile, 'utf-8')) };
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

/** `key=value` lines, the shape Actions reads back as `steps.<id>.outputs.*`. */
function parseOutputs(text) {
  return Object.fromEntries(text.split('\n').filter(Boolean).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i), l.slice(i + 1)];
  }));
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

test('the verdict for the workflow gate is published once, on the crossing edition', () => {
  // The gate step after `Commit and push` reads exactly this. It is what makes
  // the run red without costing the edition: the snapshot with the advanced
  // streak is committed first, so tomorrow reads `previous >= threshold`, does
  // not cross, and the cron is green again.
  const crossing = capture(() => reportDegradationAlarms(
    briefWithStreak(MAX_CONSECUTIVE_DEGRADED_EDITIONS),
    { dryRun: false, previous: briefWithStreak(MAX_CONSECUTIVE_DEGRADED_EDITIONS - 1) },
  ));
  assert.equal(crossing.outputs[DEGRADATION_CROSSED_OUTPUT], 'true');
  assert.equal(crossing.outputs[DEGRADATION_BLOCKS_OUTPUT], 'jobs', 'the gate names the blocks in its summary');

  for (const [editions, before] of [
    [MAX_CONSECUTIVE_DEGRADED_EDITIONS + 1, MAX_CONSECUTIVE_DEGRADED_EDITIONS],
    [MAX_CONSECUTIVE_DEGRADED_EDITIONS, MAX_CONSECUTIVE_DEGRADED_EDITIONS],
  ]) {
    const later = capture(() => reportDegradationAlarms(
      briefWithStreak(editions),
      { dryRun: false, previous: briefWithStreak(before) },
    ));
    assert.equal(later.outputs[DEGRADATION_CROSSED_OUTPUT], undefined, `streak ${editions} over ${before} must not re-arm the gate`);
    assert.ok(later.lines.some((l) => l.startsWith('::error::')), 'the announcement still goes out');
  }
});

test('a crossing on a run that writes no snapshot is announced, never a verdict', () => {
  // The 0/4-blocks branch deliberately leaves yesterday's snapshot in place and
  // the dry self-test writes nothing at all: today's streak is not recorded, so
  // a verdict would fire again tomorrow on the same crossing, forever.
  const { lines, outputs } = capture(() => reportDegradationAlarms(
    briefWithStreak(MAX_CONSECUTIVE_DEGRADED_EDITIONS),
    { dryRun: false, previous: briefWithStreak(MAX_CONSECUTIVE_DEGRADED_EDITIONS - 1), persisted: false },
  ));
  assert.equal(outputs[DEGRADATION_CROSSED_OUTPUT], undefined);
  assert.ok(lines.some((l) => l.startsWith('::error::') && l.includes('jobs')), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes('not recorded')), lines.join('\n'));
});

test('the workflow spends the red on that verdict, after the commit step', () => {
  // Non-negotiable #6: the key lives in the script and is read in YAML, which
  // cannot import it. This is the test that keeps the two ends tied — including
  // the ORDER, which is the whole fix: a gate before the commit would skip it.
  const yml = readFileSync(WORKFLOW_PATH, 'utf-8');
  assert.ok(yml.includes(`steps.refresh.outputs.${DEGRADATION_CROSSED_OUTPUT}`), 'the gate must read the verdict this script publishes');
  assert.ok(yml.includes(`steps.refresh.outputs.${DEGRADATION_BLOCKS_OUTPUT}`), 'the summary names the blocks from the same source');
  assert.match(yml, /^\s+id: refresh$/m, 'the refresh step must keep the id the gate refers to');

  const commitAt = yml.indexOf('name: Commit and push');
  const gateAt = yml.indexOf(`steps.refresh.outputs.${DEGRADATION_CROSSED_OUTPUT}`);
  assert.ok(commitAt > 0 && gateAt > commitAt, 'the degradation gate must run AFTER the commit, or the streak dies on the runner');
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
