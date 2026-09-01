#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROBE_SCHEMA = 'translate-queue-rerun-preservation-probe/v1';
export const PROBE_SCHEDULE = '*/5 16-20 1 9 *';
export const PROBE_WINDOW_START_MS = Date.parse('2026-09-01T16:00:00.000Z');
export const PROBE_SCHEDULE_CUTOFF_MS = Date.parse('2026-09-01T21:15:00.000Z');
export const MAX_HOLD_SECONDS = 900;
export const MAX_RECORD_BYTES = 2 * 1024;

const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RUN_ID_RE = /^[1-9][0-9]{0,19}$/;
const ATTEMPT_RE = /^[1-9][0-9]{0,2}$/;
const HOLD_RE = /^(?:0|[1-9][0-9]{0,2})$/;
const SHA_RE = /^[a-f0-9]{40}$/;
const ROLES = new Set(['candidate', 'blocker']);
const EVENTS = new Set(['workflow_dispatch', 'schedule']);

function fail(code) {
  throw new TypeError(code);
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
}

function parseBoundedInteger(raw, pattern, maximum, code) {
  const text = String(raw ?? '');
  if (!pattern.test(text)) fail(code);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value > maximum) fail(code);
  return value;
}

/** Every original attempt expires; reruns remain observable after the probe window. */
export function validateProbeCutoff(attempt, now = Date.now()) {
  if (!Number.isFinite(now)) fail('invalid_probe_now');
  if (attempt === 1 && now > PROBE_SCHEDULE_CUTOFF_MS) fail('probe_window_closed');
}

/** Scheduled originals are additionally rejected before the calendar-bound opening. */
export function validateScheduleWindow({ attempt, schedule }, now = Date.now()) {
  if (schedule !== PROBE_SCHEDULE) fail('invalid_schedule');
  validateProbeCutoff(attempt, now);
  if (attempt === 1 && now < PROBE_WINDOW_START_MS) {
    fail('schedule_probe_window_closed');
  }
}

/** Build the bounded, token-redacted observation written by the probe. */
export function buildProbeRecord(environment, now = Date.now()) {
  const eventName = String(environment.GITHUB_EVENT_NAME ?? '');
  if (!EVENTS.has(eventName)) fail('invalid_event_name');

  const runId = String(environment.GITHUB_RUN_ID ?? '');
  if (!RUN_ID_RE.test(runId)) fail('invalid_run_id');
  const attempt = parseBoundedInteger(
    environment.GITHUB_RUN_ATTEMPT,
    ATTEMPT_RE,
    999,
    'invalid_run_attempt',
  );
  const headSha = String(environment.GITHUB_SHA ?? '');
  if (!SHA_RE.test(headSha)) fail('invalid_head_sha');

  const probeToken = String(environment.PROBE_TOKEN ?? '');
  const role = String(environment.PROBE_ROLE ?? '');
  const holdSecondsRaw = String(environment.PROBE_HOLD_SECONDS ?? '');
  const schedule = String(environment.PROBE_SCHEDULE ?? '');

  if (eventName === 'schedule') {
    validateScheduleWindow({ attempt, schedule }, now);
    if (probeToken !== `schedule-${runId}`) fail('invalid_schedule_token');
    if (role !== 'candidate' || holdSecondsRaw !== '0') fail('invalid_schedule_mode');
  } else {
    validateProbeCutoff(attempt, now);
    if (schedule !== '') fail('unexpected_manual_schedule');
  }

  if (!TOKEN_RE.test(probeToken)) fail('invalid_probe_token');
  if (!ROLES.has(role)) fail('invalid_probe_role');
  const holdSeconds = parseBoundedInteger(
    holdSecondsRaw,
    HOLD_RE,
    MAX_HOLD_SECONDS,
    'invalid_hold_seconds',
  );
  if ((role === 'candidate' && holdSeconds !== 0)
      || (role === 'blocker' && holdSeconds === 0)) {
    fail('invalid_role_hold_binding');
  }

  const record = {
    attempt,
    eventName,
    headSha,
    holdSeconds,
    role,
    runId,
    schedule: eventName === 'schedule' ? schedule : null,
    schema: PROBE_SCHEMA,
    tokenSha256: `sha256:${createHash('sha256').update(probeToken, 'utf8').digest('hex')}`,
  };
  const json = `${canonicalJson(record)}\n`;
  if (Buffer.byteLength(json, 'utf8') > MAX_RECORD_BYTES) fail('probe_record_too_large');
  return { record, json };
}

/** Resolve only the fixed output below RUNNER_TEMP; no caller-selected path is accepted. */
export function resolveProbeOutput(environment) {
  const runnerTempRaw = String(environment.RUNNER_TEMP ?? '');
  if (!path.isAbsolute(runnerTempRaw) || path.normalize(runnerTempRaw) !== runnerTempRaw) {
    fail('invalid_runner_temp');
  }
  const runnerTemp = path.resolve(runnerTempRaw);
  const expected = path.join(runnerTemp, 'translate-queue-rerun-probe', 'record.json');
  const requested = String(environment.PROBE_OUTPUT ?? '');
  if (requested !== expected || path.resolve(requested) !== expected) fail('invalid_probe_output');
  return { runnerTemp, output: expected };
}

function resolveStepSummary(environment, runnerTemp) {
  const requested = String(environment.GITHUB_STEP_SUMMARY ?? '');
  if (!path.isAbsolute(requested)) fail('invalid_step_summary');
  const resolved = path.resolve(requested);
  if (!resolved.startsWith(`${runnerTemp}${path.sep}`)) fail('invalid_step_summary');
  return resolved;
}

/** Persist first, then optionally hold the blocker so another run remains pending. */
export async function runProbe(environment = process.env, sleep = (milliseconds) => (
  new Promise((resolve) => setTimeout(resolve, milliseconds))
), log = (text) => process.stdout.write(text), now = Date.now()) {
  const { record, json } = buildProbeRecord(environment, now);
  const { runnerTemp, output } = resolveProbeOutput(environment);
  const stepSummary = resolveStepSummary(environment, runnerTemp);
  const outputDirectory = path.dirname(output);
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });

  const runnerReal = realpathSync(runnerTemp);
  const outputDirectoryReal = realpathSync(outputDirectory);
  if (outputDirectoryReal !== path.join(runnerReal, 'translate-queue-rerun-probe')) {
    fail('unsafe_probe_output_directory');
  }
  if (existsSync(output) && (!lstatSync(output).isFile() || lstatSync(output).isSymbolicLink())) {
    fail('unsafe_existing_probe_output');
  }

  const temporary = path.join(outputDirectory, `.record-${process.pid}.tmp`);
  writeFileSync(temporary, json, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  renameSync(temporary, output);

  // This redacted copy survives as evidence even if upload-artifact later fails.
  log(json);
  appendFileSync(
    stepSummary,
    `### NON-PRODUCTION rerun-preservation record\n\n\`\`\`json\n${json}\`\`\`\n`,
    { encoding: 'utf8' },
  );

  if (record.holdSeconds > 0) await sleep(record.holdSeconds * 1000);
  return { json, output, record, stepSummary };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runProbe().catch((error) => {
    console.error(`translate_queue_rerun_probe_error:${error?.message || 'unknown'}`);
    process.exitCode = 1;
  });
}
