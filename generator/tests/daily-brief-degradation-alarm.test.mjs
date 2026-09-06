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
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  reportDegradationAlarms,
  readPreviousSnapshot,
  readDegradationState,
  writeDegradationState,
  DEGRADATION_CROSSED_OUTPUT,
  DEGRADATION_BLOCKS_OUTPUT,
  DEGRADATION_STATE_PATH,
} from '../scripts/refresh-daily-brief-data.mjs';
import {
  MAX_CONSECUTIVE_DEGRADED_EDITIONS,
  buildDailyBrief,
  degradationAlarms,
  degradationState,
  isDegradationCarrier,
} from '../scripts/lib/daily-brief-data.mjs';
import { sliceBetween, sliceFrom, sliceUntil } from './lib/anchored-slice.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'generate-daily-brief.yml');

/** Alternatives the commit-step grep must treat as a permanent push rejection. */
const PERMANENT_REJECTION_SIGNS = [
  'denied',
  'HTTP 403',
  'error: 403',
  'remote:.*403',
  'forbidden',
  'protected branch',
  'not found',
  'authentication failed',
  'invalid username or password',
  'could not read username',
  'support for password authentication',
  'remote rejected',
  'declined',
  'rule violations',
  'GH0[0-9]{2}',
];

function permanentRejectionGrepPattern(yml = readFileSync(WORKFLOW_PATH, 'utf-8')) {
  const commitStep = sliceBetween(yml, '- name: Commit and push', '- name: Push hero');
  const permanent = sliceBetween(commitStep, '\n          done', 'if [ "$LEDGER_ONLY" = true ]');
  const grepHit = permanent.match(/grep -qiE '([^']+)' "\$PUSH_LOG"/);
  assert.ok(grepHit, 'commit step must classify the push log');
  return { commitStep, permanent, pattern: grepHit[1] };
}

function pushLogMatchesPermanent(pattern, text) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'push-log-')), 'push.log');
  writeFileSync(file, text);
  try {
    execFileSync('grep', ['-qiE', pattern, file], { stdio: 'pipe' });
    return true;
  } catch (err) {
    if (err.status === 1) return false;
    throw err;
  }
}

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

test('the workflow spends the red on that verdict, and only as the LAST step', () => {
  // Non-negotiable #6: the key lives in the script and is read in YAML, which
  // cannot import it. This is the test that keeps the two ends tied — including
  // the POSITION, which is the whole fix and has been wrong twice.
  const yml = readFileSync(WORKFLOW_PATH, 'utf-8');
  assert.ok(yml.includes(`steps.refresh.outputs.${DEGRADATION_CROSSED_OUTPUT}`), 'the gate must read the verdict this script publishes');
  assert.ok(yml.includes(`steps.refresh.outputs.${DEGRADATION_BLOCKS_OUTPUT}`), 'the summary names the blocks from the same source');
  assert.match(yml, /^\s+id: refresh$/m, 'the refresh step must keep the id the gate refers to');

  const steps = [...yml.matchAll(/^ {6}- name: (.+)$/gm)].map((m) => ({ name: m[1].trim(), at: m.index }));
  const gateAt = yml.indexOf(`steps.refresh.outputs.${DEGRADATION_CROSSED_OUTPUT}`);
  const gate = [...steps].reverse().find((step) => step.at < gateAt);
  assert.ok(gate, 'the gate must live inside a named step');

  // AFTER the commit: the streak is durable only once `git add` has run, so a
  // gate before it would kill the very snapshot that proves the alarm.
  const commit = steps.find((step) => step.name.startsWith('Commit and push'));
  assert.ok(commit && gate.at > commit.at, 'the gate must run AFTER the commit, or the streak dies on the runner');

  // And LAST, full stop. `exit 1` skips every later step whose `if:` carries no
  // status function — which is every step here. That already cost the CDN warm
  // in `Push hero + thumbnail to the CDN`: the hero is the og:image Discover
  // fetches, and skipping it leaves a 404 at the edge that no later run repairs,
  // because that step only ever handles the current day's id. Asserting "last"
  // rather than "after the commit" is the form that survives the next step
  // somebody drops into the middle of this job.
  const last = steps[steps.length - 1];
  assert.equal(
    gate.name,
    last.name,
    `the degradation gate must be the LAST step of the job; "${last.name}" comes after it and its exit 1 would skip it`,
  );
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


// ── The streak ledger, `data/daily-brief-degradation.json` (issue #885) ──────
//
// The streak used to live ONLY inside the snapshot, and the 0/4-blocks branch
// deliberately does not write the snapshot: yesterday's copy stays on disk so
// nothing downstream reads a fabricated empty day. So a total blackout re-read
// the same `previous` every morning, recomputed the same streak of 1, and the
// threshold was never reached — the one outage shape the alarm exists for was
// the one it could not see. The streaks now ride in a sidecar that IS written
// on that branch.

/** A blackout day: every source down, so 0/4 blocks. */
function blackout(todayIso, previous) {
  return buildDailyBrief({
    todayIso,
    nowMs: Date.parse(`${todayIso}T05:05:00Z`),
    borderWaitDocs: null,
    fuelMetadata: null,
    exchangeDoc: null,
    jobsStats: null,
    previous,
  });
}

test('a total blackout advances the streak day after day and reaches the threshold', () => {
  // The regression itself. Only the LEDGER survives each day (the snapshot is
  // not written), so the loop feeds back exactly what production would read.
  let state = null;
  const streaks = [];
  for (const day of ['2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08']) {
    const brief = blackout(day, state);
    assert.equal(brief.counts.availableBlocks, 0, `${day} must be a 0/4 day`);
    streaks.push(brief.blocks.jobs.degradedEditions);
    state = degradationState(brief);
  }
  assert.deepEqual(streaks, [1, 2, 3, 4], 'the count must move, not stick at 1 forever');
});

test('the blackout crossing is a verdict exactly once, on the day it crosses', () => {
  let state = null;
  const crossings = [];
  for (const day of ['2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08']) {
    const brief = blackout(day, state);
    const alarms = degradationAlarms(brief, state);
    crossings.push(alarms.filter((a) => a.crossed).length);
    state = degradationState(brief);
  }
  assert.deepEqual(
    crossings,
    [0, 0, 4, 0],
    'silence, silence, all four blocks cross together, then the alarm keeps talking without re-arming the red',
  );
});

test('a same-day rerun of a blackout inherits the streak instead of adding to it', () => {
  // The ledger carries `dateIso` for exactly this: a workflow_dispatch rerun is
  // not another edition, and without the date it would double-count.
  const first = blackout('2026-09-05', { dateIso: '2026-09-04', blocks: { jobs: { degradedEditions: 2 } } });
  assert.equal(first.blocks.jobs.degradedEditions, 3);
  const rerun = blackout('2026-09-05', degradationState(first));
  assert.equal(rerun.blocks.jobs.degradedEditions, 3, 'a rerun of the same day must not count twice');
});

test('the ledger carries only what the readers read, for every block', () => {
  const state = degradationState(blackout('2026-09-05', null));
  assert.equal(state.dateIso, '2026-09-05');
  assert.deepEqual(Object.keys(state.blocks).sort(), ['borderWait', 'exchange', 'fuel', 'jobs']);
  for (const [name, b] of Object.entries(state.blocks)) {
    assert.deepEqual(b, { degradedEditions: 1 }, `${name} must carry its streak and nothing else`);
  }
});

test('the ledger wins over the snapshot, and an absent or corrupt one falls back to it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'daily-brief-state-'));
  const snapshot = path.join(dir, 'daily-brief.json');
  const ledger = path.join(dir, 'degradation.json');
  writeFileSync(snapshot, JSON.stringify(briefWithStreak(2)));

  // No ledger yet — the first run after this landed must inherit the snapshot's
  // count rather than restart every streak from zero.
  assert.equal(readDegradationState(ledger, snapshot).blocks.jobs.degradedEditions, 2);

  writeFileSync(ledger, '{ not json');
  assert.equal(readDegradationState(ledger, snapshot).blocks.jobs.degradedEditions, 2, 'a corrupt ledger falls back, it does not stop the refresh');

  writeDegradationState(briefWithStreak(5), ledger);
  assert.equal(readDegradationState(ledger, snapshot).blocks.jobs.degradedEditions, 5, 'the ledger is the source once it exists');
  assert.equal(readDegradationState(ledger, path.join(dir, 'absent.json')).blocks.jobs.degradedEditions, 5);
  assert.equal(readDegradationState(path.join(dir, 'absent.json'), path.join(dir, 'absent.json')), null);
});

test('the workflow commits the ledger, or the streak dies on the runner', () => {
  // Non-negotiable #6 again: the path lives in the script and is staged in
  // YAML, which cannot import it. Without this `git add` the 0/4 branch writes
  // the ledger to a runner that is thrown away, and the fix is a no-op.
  const yml = readFileSync(WORKFLOW_PATH, 'utf-8');
  const rel = path.relative(REPO_ROOT, DEGRADATION_STATE_PATH).split(path.sep).join('/');
  assert.equal(rel, 'data/daily-brief-degradation.json');
  const commitStep = yml.slice(yml.indexOf('- name: Commit and push'));
  assert.ok(commitStep.includes(`git add public/data/daily-brief.json`), 'the snapshot is still staged');
  assert.ok(
    commitStep.slice(0, commitStep.indexOf('git diff --cached')).includes(rel),
    'the streak ledger must be staged by the commit step',
  );
});


// ── Un registro con JSON valido ma di forma sbagliata (#927) ─────────────────
//
// Il fallback allo snapshot copriva "assente" e "illeggibile". Non copriva il
// caso peggiore: un file che si parsa e non e' un registro. Tutti i lettori
// dello streak sono indulgenti per costruzione (quello che non capiscono vale
// 0), quindi un `[]` o un `{"blocks": 5}` non falliscono: azzerano OGNI
// conteggio in silenzio, e una degradazione permanente non riattraversa mai
// piu' la soglia. E' #885 con un altro file.

test('a ledger that parses but is not a ledger falls back to the snapshot instead of zeroing every streak', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'daily-brief-shape-'));
  const snapshot = path.join(dir, 'daily-brief.json');
  const ledger = path.join(dir, 'degradation.json');
  writeFileSync(snapshot, JSON.stringify(briefWithStreak(2)));

  const wrongShapes = {
    'an array': [],
    'a scalar blocks': { schemaVersion: 1, dateIso: '2026-09-05', blocks: 5 },
    'a blocks array': { schemaVersion: 1, dateIso: '2026-09-05', blocks: [] },
    'an empty blocks map': { schemaVersion: 1, dateIso: '2026-09-05', blocks: {} },
    'a block that is not an object': { schemaVersion: 1, dateIso: '2026-09-05', blocks: { jobs: 3 } },
    'no dateIso at all': { schemaVersion: 1, blocks: { jobs: { degradedEditions: 4 } } },
    'a dateIso that is not a day': { schemaVersion: 1, dateIso: '2026-02-31', blocks: { jobs: { degradedEditions: 4 } } },
  };
  for (const [label, value] of Object.entries(wrongShapes)) {
    writeFileSync(ledger, JSON.stringify(value));
    assert.equal(isDegradationCarrier(value), false, `${label} must not pass as a carrier`);
    const { lines } = capture(() => {
      assert.equal(
        readDegradationState(ledger, snapshot).blocks.jobs.degradedEditions,
        2,
        `${label}: the snapshot's streak must survive it`,
      );
    });
    assert.ok(lines.some((l) => l.includes('wrong shape')), `${label} must not be silent: ${lines.join('\n')}`);
  }
});

test('a wrong-shaped snapshot is not a carrier either, on both read paths', () => {
  // The fallback is the same forgiving reader: if it accepted the wrong shape,
  // the guard on the ledger would just move the silent zeroing one file down.
  const dir = mkdtempSync(path.join(tmpdir(), 'daily-brief-shape-snap-'));
  const snapshot = path.join(dir, 'daily-brief.json');
  const ledger = path.join(dir, 'degradation.json');
  writeFileSync(snapshot, JSON.stringify([{ blocks: { jobs: { degradedEditions: 9 } } }]));
  writeFileSync(ledger, '{ not json');
  capture(() => {
    assert.equal(readPreviousSnapshot(snapshot), null, 'an array is not a snapshot');
    assert.equal(readDegradationState(ledger, snapshot), null, 'no usable carrier anywhere → null, never a fake zero one');
  });
  // And what a real ledger writes still passes, or the guard would be a wall.
  writeDegradationState(blackout('2026-09-05', null), ledger);
  assert.equal(readDegradationState(ledger, snapshot).blocks.jobs.degradedEditions, 1);
});

// ── Il registro non cambia se non cambia niente (#927) ───────────────────────

test('the ledger carries no per-run timestamp and is not rewritten when nothing moved', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'daily-brief-churn-'));
  const ledger = path.join(dir, 'degradation.json');
  const brief = blackout('2026-09-05', null);

  assert.equal(Object.hasOwn(degradationState(brief), 'generatedAt'), false, 'a per-run clock makes every run a commit');
  assert.equal(writeDegradationState(brief, ledger), true, 'the first write lands');
  const first = readFileSync(ledger, 'utf-8');
  const mtime = statSync(ledger).mtimeMs;

  // A `workflow_dispatch` rerun of the same day: same streaks, same date.
  const rerun = blackout('2026-09-05', readDegradationState(ledger, path.join(dir, 'absent.json')));
  assert.equal(writeDegradationState(rerun, ledger), false, 'an identical ledger must not be rewritten');
  assert.equal(readFileSync(ledger, 'utf-8'), first);
  assert.equal(statSync(ledger).mtimeMs, mtime, 'not even the mtime moves, or the commit step stages it');

  // The next day the streak does move, and then it must be written.
  const tomorrow = blackout('2026-09-06', readDegradationState(ledger, path.join(dir, 'absent.json')));
  assert.equal(writeDegradationState(tomorrow, ledger), true);
  assert.equal(readDegradationState(ledger, path.join(dir, 'absent.json')).blocks.jobs.degradedEditions, 2);
});

// ── Il rosso del giorno di blackout (#927) ──────────────────────────────────

test('a day that stages only the ledger cannot turn a lost push into a permanent red', () => {
  // Con il registro in stage, la giornata 0/4 raggiunge per la prima volta
  // l'`exit 1` del push fallito: l'attraversamento resta sul runner e lo
  // STESSO giorno rifa' rosso ogni mattina — il loop che #882 dichiara
  // inaccettabile. Vale solo per quel percorso, che e' transitorio: un PAT
  // mancante si ripete identico e degradarlo terrebbe lo streak fisso sotto
  // la soglia per sempre (#885 riaperto sotto una run verde).
  const yml = readFileSync(WORKFLOW_PATH, 'utf-8');
  const rel = path.relative(REPO_ROOT, DEGRADATION_STATE_PATH).split(path.sep).join('/');
  const commitStep = sliceBetween(yml, '- name: Commit and push', '- name: Push hero');

  // Il path e' scritto due volte nello YAML (add e confronto) e una volta nello
  // script: nessuno dei tre puo' importare gli altri (non-negoziabile #6).
  assert.ok(
    commitStep.includes(`git diff --cached --name-only)" = "${rel}"`),
    'the ledger-only case must be recognised by comparing the staged set to the ledger path itself',
  );
  const branches = commitStep.split('LEDGER_ONLY" = true');
  assert.equal(branches.length, 2, 'only the retry-exhausted exit — a transient cause — may be degraded');
  const head = branches[1].slice(0, branches[1].indexOf('fi'));
  assert.match(head, /::warning::/, 'the degraded branch warns');
  assert.match(head, /pushed=ledger-lost/, 'and says so on the step output');
  assert.match(head, /exit 0/, 'and stays green');

  // Il PAT mancante e' una config rotta che si ripete identica ogni mattina:
  // degradarla renderebbe l'allarme muto per sempre, non "in ritardo".
  const patGuard = sliceFrom(commitStep, 'if [ -z "${GITHUB_PAT:-}" ]; then');
  const patBranch = sliceUntil(patGuard, '\n          fi');
  assert.doesNotMatch(patBranch, /LEDGER_ONLY/, 'a missing PAT must be fatal even on a ledger-only day');
  assert.match(patBranch, /exit 1/, 'and it must be red');

  // Un rifiuto permanente (PAT scaduto/revocato, ref protetto, repo non
  // raggiungibile, ruleset GH013) supera il `-z` del guard, arriva al push
  // e si ripete identico ogni mattina: degradarlo terrebbe lo streak sotto
  // la soglia per sempre, come il PAT assente. Deve restare rosso PRIMA del
  // ramo degradato, e per farlo il push deve catturare il proprio output.
  assert.match(commitStep, /git push "\$REMOTE" "HEAD:\$TARGET" 2>&1 \| tee "\$PUSH_LOG"/,
    'the push must capture its output, or the cause of the failure cannot be classified');
  const { permanent, pattern } = permanentRejectionGrepPattern(yml);
  const signs = pattern.split('|');
  for (const sign of PERMANENT_REJECTION_SIGNS) {
    assert.ok(signs.includes(sign), `permanent-rejection grep must include ${JSON.stringify(sign)}`);
  }
  assert.equal(signs.includes('403'), false, 'naked 403 matches git progress "403 bytes" and would reopen loop #882');
  assert.equal(signs.includes('rejected'), false, 'bare rejected swallows ! [rejected] ...(fetch first) races');
  assert.match(permanent, /::error::/, 'and it is an error');
  assert.match(permanent, /exit 1/, 'and it is red');
  assert.doesNotMatch(permanent, /LEDGER_ONLY/, 'a permanent rejection is fatal even on a ledger-only day');

  // L'edizione, invece, resta rossa: dopo il `fi` del ramo degradato la coda
  // dello step e' ancora l'errore del push perso. Contare gli `exit 1` non lo
  // proverebbe: il totale resterebbe uguale se il rosso si spostasse altrove.
  const tail = branches[1].slice(branches[1].indexOf('fi') + 2);
  assert.match(tail, /::error::push failed after 3 attempts/, 'a lost EDITION must still be red');
  assert.match(tail, /exit 1/, 'and it must exit non-zero');
});

test('the permanent-rejection grep fires on ruleset/HTTP 403 and not on progress or a fetch-first race', () => {
  const { pattern } = permanentRejectionGrepPattern();
  assert.equal(
    pushLogMatchesPermanent(pattern, [
      'Enumerating objects: 3, done.',
      'Counting objects: 100% (3/3), done.',
      'Writing objects: 100% (3/3), 403 bytes | 403.00 KiB/s, done.',
      'Total 3 (delta 0), reused 0 (delta 0), pack-reused 0',
      "error: failed to push some refs to 'https://github.com/nanakokyobashi-rgb/frontaliere-articles.git'",
    ].join('\n')),
    false,
    'git progress "403 bytes" on a network-failed ledger-only push must stay ledger-lost',
  );
  assert.equal(
    pushLogMatchesPermanent(pattern, [
      '! [rejected] HEAD -> main (fetch first)',
      "error: failed to push some refs to 'https://github.com/nanakokyobashi-rgb/frontaliere-articles.git'",
      'hint: Updates were rejected because the remote contains work that you do',
    ].join('\n')),
    false,
    'a non-fast-forward race is transient and must stay ledger-lost',
  );
  assert.equal(
    pushLogMatchesPermanent(pattern, [
      'remote: error: GH013: Repository rule violations found for refs/heads/main',
      '! [remote rejected] HEAD -> main (push declined due to repository rule violations)',
      "error: failed to push some refs to 'https://github.com/nanakokyobashi-rgb/frontaliere-articles.git'",
    ].join('\n')),
    true,
    'a ruleset rejection has no denied/403 and must still stay red',
  );
  assert.equal(
    pushLogMatchesPermanent(pattern, [
      'remote: Permission to nanakokyobashi-rgb/frontaliere-articles.git denied to user.',
      "fatal: unable to access 'https://github.com/nanakokyobashi-rgb/frontaliere-articles.git/': The requested URL returned error: 403",
    ].join('\n')),
    true,
    'an anchored HTTP 403 is a permanent rejection',
  );
});

test('the crossing verdict is not spent on a run whose ledger never reached main', () => {
  // Il rosso del verdetto vale una volta sola perche' domani rilegge lo streak
  // committato. Se il registro e' morto sul runner, domani rilegge il valore
  // vecchio e riattraversa la stessa soglia: rosso ogni mattina.
  const yml = readFileSync(WORKFLOW_PATH, 'utf-8');
  const verdict = yml.slice(yml.indexOf('- name: Degradation alarm'));
  const cond = verdict.slice(verdict.indexOf('if:'), verdict.indexOf('run:'));
  assert.match(cond, /steps\.refresh\.outputs\.degradation_crossed == 'true'/);
  assert.match(cond, /steps\.commit\.outputs\.pushed != 'ledger-lost'/);
});
