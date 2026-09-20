#!/usr/bin/env node

/**
 * Parse the JSONL stream emitted by `codex exec --json` and expose only
 * aggregate, non-secret telemetry for the Codex review lane.
 *
 * The stream may be empty, interrupted, or contain stderr lines mixed with
 * JSON. Telemetry is diagnostic only: parsing errors never make the caller
 * fail, and no event text is copied to the output.
 *
 * CLI: node codex-usage-summary.mjs [diagnostics_file] [outcome] [duration_ms]
 */

import fs from 'node:fs';

const OUTCOMES = new Set(['success', 'failure', 'cancelled', 'skipped']);
const TOKEN_FIELDS = Object.freeze([
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
]);

function nonNegativeInteger(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function normalizedOutcome(value, invoked) {
  const outcome = String(value ?? '').trim().toLowerCase();
  if (OUTCOMES.has(outcome)) return outcome;
  return invoked ? 'unknown' : 'not_invoked';
}

function emptyMetrics(outcome = '', durationMs = null) {
  const duration = nonNegativeInteger(durationMs);
  return {
    codex_invocations: 0,
    usage_available: false,
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    duration_ms: duration ?? 0,
    outcome: normalizedOutcome(outcome, false),
    stream_status: 'not_invoked',
    malformed_lines: 0,
    usage_records: 0,
  };
}

function parseJsonLines(raw) {
  const text = String(raw ?? '');
  const lines = text.split(/\r?\n/u).filter((line) => line.trim() !== '');
  const events = [];
  let malformedLines = 0;

  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        malformedLines += 1;
      } else {
        events.push(value);
      }
    } catch {
      malformedLines += 1;
    }
  }

  return { events, malformedLines };
}

function eventType(event) {
  return String(event?.type ?? event?.event ?? '').trim().toLowerCase();
}

function usageRecord(event) {
  if (eventType(event) !== 'turn.completed' || !event.usage || typeof event.usage !== 'object') {
    return null;
  }
  const values = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, nonNegativeInteger(event.usage[field])]));
  return TOKEN_FIELDS.every((field) => values[field] !== null) ? values : null;
}

function eventDuration(event) {
  return nonNegativeInteger(event?.duration_ms ?? event?.durationMs);
}

/**
 * @param {string} raw JSONL diagnostics stream
 * @param {{outcome?: string, durationMs?: number|string|null}} options
 * @returns {{codex_invocations:number, usage_available:boolean, input_tokens:number,
 *   cached_input_tokens:number, output_tokens:number, duration_ms:number,
 *   outcome:string, stream_status:string, malformed_lines:number, usage_records:number}}
 */
export function parseCodexUsage(raw, options = {}) {
  const source = String(raw ?? '');
  if (source.trim() === '') return emptyMetrics(options.outcome, options.durationMs);

  const { events, malformedLines } = parseJsonLines(source);
  const invoked = events.some((event) => [
    'thread.started',
    'turn.started',
    'turn.completed',
    'turn.failed',
  ].includes(eventType(event)));
  const totals = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0]));
  let usageRecords = 0;
  for (const event of events) {
    const usage = usageRecord(event);
    if (!usage) continue;
    usageRecords += 1;
    for (const field of TOKEN_FIELDS) totals[field] += usage[field];
  }

  const explicitDuration = nonNegativeInteger(options.durationMs);
  const eventDurations = events.map(eventDuration).filter((value) => value !== null);
  const durationMs = explicitDuration
    ?? (eventDurations.length > 0 ? Math.max(...eventDurations) : 0);
  const status = malformedLines === 0
    ? (events.length > 0 ? 'complete' : 'malformed')
    : (events.length > 0 ? 'partial' : 'malformed');

  return {
    codex_invocations: invoked ? 1 : 0,
    usage_available: usageRecords > 0,
    ...totals,
    duration_ms: durationMs,
    outcome: normalizedOutcome(options.outcome, invoked),
    stream_status: status,
    malformed_lines: malformedLines,
    usage_records: usageRecords,
  };
}

function main() {
  const file = process.argv[2] || '';
  const outcome = process.argv[3] || '';
  const durationMs = process.argv[4] || null;
  let raw = '';
  let readError = false;

  if (file) {
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      readError = true;
    }
  }

  const metrics = parseCodexUsage(raw, { outcome, durationMs });
  if (readError) {
    metrics.stream_status = 'unavailable';
  }
  // Deliberately emit only the aggregate object. Never echo a raw diagnostics
  // line: Codex events can contain model/tool text even though auth is absent.
  process.stdout.write(`${JSON.stringify(metrics)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
