#!/usr/bin/env node

/**
 * Produce only bounded, non-secret diagnostics for one Codex primary run.
 *
 * The JSONL stream and stderr remain private runner files. This module exposes
 * event counts, a safe stderr signature, and the startup-failure predicate;
 * it never returns an event payload or an unrecognised stderr line.
 */

import fs, { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Codex setup and the bridge are complete before `codex exec` starts. A
// non-zero exit with no events inside this window is still a startup failure;
// longer failures may have begun real review work and remain terminal unless
// another already-approved transient rule applies.
export const STARTUP_FAILURE_MAX_DURATION_MS = 60_000;

export const CODEX_CAUSE_CLASSES = Object.freeze([
  'startup-failure',
  'http-5xx',
  'http-4xx',
  'usage-limit',
  'model-not-found',
  'config-error',
  'argument-error',
  'stream-disconnected',
  'error-code',
  'unknown',
]);

const CAUSE_CLASS_SET = new Set(CODEX_CAUSE_CLASSES);
const SAFE_EVENT_TYPE_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/iu;
const HTTP_STATUS_RE = /\bHTTP(?:\/[0-9.]+)?\s+(?<status>[45][0-9]{2})\b/iu;
const NAMED_STATUS_RE = /\b(?:api_error_status|http_status|status_code|status)\s*[:=]\s*(?<status>[45][0-9]{2})\b/iu;

function booleanValue(value, fallback = false) {
  if (value === true || String(value ?? '').trim().toLowerCase() === 'true') return true;
  if (value === false || String(value ?? '').trim().toLowerCase() === 'false') return false;
  return fallback;
}

function integerValue(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

export function isKnownCauseClass(value) {
  return CAUSE_CLASS_SET.has(String(value ?? '').trim().toLowerCase());
}

export function normalizeCauseClass(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return isKnownCauseClass(normalized) ? normalized : 'unknown';
}

function parseJsonLines(raw) {
  const events = [];
  for (const line of String(raw ?? '').split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) events.push(value);
    } catch {
      // The stream can be partial or contain non-JSON stderr. It is not an
      // event and must not be copied into diagnostics.
    }
  }
  return events;
}

function eventType(event) {
  const value = event?.type ?? event?.event;
  const type = String(value ?? '').trim().toLowerCase();
  return SAFE_EVENT_TYPE_RE.test(type) ? type : 'unknown';
}

function eventCounts(events) {
  const counts = new Map();
  for (const event of events) {
    const type = eventType(event);
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function safeMatch(match) {
  return String(match || '')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 96);
}

function statusMatch(line) {
  const match = String(line).match(HTTP_STATUS_RE) || String(line).match(NAMED_STATUS_RE);
  if (!match) return null;
  const status = Number(match.groups?.status);
  if (!Number.isInteger(status)) return null;
  return {
    causeClass: status === 429 ? 'usage-limit' : status >= 500 ? 'http-5xx' : 'http-4xx',
    stderrMatch: `HTTP ${status}`,
  };
}

// Only the matched phrase is returned. This prevents a line such as
// "stream disconnected; token=..." from leaking anything after the phrase.
function allowlistedStderrMatch(line) {
  const text = String(line || '');
  const status = statusMatch(text);
  if (status) return status;

  const patterns = [
    ['usage-limit', /\b(?:usage|rate)[ _-]?limit\b/iu],
    ['usage-limit', /\b(?:too many requests|quota[ _-]?(?:exceeded|exhausted|limit))\b/iu],
    ['model-not-found', /\b(?:model|engine)\s+(?:not found|unavailable)\b/iu],
    ['model-not-found', /\bno such model\b/iu],
    ['config-error', /\b(?:invalid|malformed|unsupported)\s+(?:user\s+)?config(?:uration)?\b/iu],
    ['config-error', /\bconfig(?:uration)?\s+(?:error|failed|invalid)\b/iu],
    ['argument-error', /\b(?:invalid|unknown|unrecognized|unsupported)\s+(?:command[- ]line\s+)?(?:argument|option|flag)\b/iu],
    ['argument-error', /\bmissing required (?:argument|option|flag)\b/iu],
    ['stream-disconnected', /\bstream\s+disconnected\b/iu],
    ['startup-failure', /\b(?:failed|unable|could not)\s+to\s+(?:start|spawn|initialize|connect)\b/iu],
    ['startup-failure', /\bstartup\s+(?:failure|error)\b/iu],
    ['error-code', /\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EPIPE|EAI_AGAIN|EINVAL|ENOENT)\b/iu],
  ];
  for (const [causeClass, pattern] of patterns) {
    const match = text.match(pattern);
    if (match) return { causeClass, stderrMatch: safeMatch(match[0]) };
  }
  return null;
}

export function firstAllowlistedStderr(stderr) {
  for (const line of String(stderr ?? '').split(/\r?\n/u)) {
    const match = allowlistedStderrMatch(line);
    if (match) return match;
  }
  return { causeClass: 'unknown', stderrMatch: '' };
}

export function isStartupFailure({
  exitCode,
  eventTotal,
  reviewPosted = false,
  sideEffectDetected = false,
  durationMs,
} = {}) {
  const exit = integerValue(exitCode);
  const events = integerValue(eventTotal);
  const duration = integerValue(durationMs);
  return exit !== null
    && exit !== 0
    && events === 0
    && !booleanValue(reviewPosted)
    && booleanValue(sideEffectDetected) === false
    && duration !== null
    && duration >= 0
    && duration < STARTUP_FAILURE_MAX_DURATION_MS;
}

/**
 * @returns {{event_counts: Record<string, number>, event_total: number,
 *   stderr_match: string, cause_class: string, startup_failure: boolean}}
 */
export function parseCodexPrimaryDiagnostics(raw, stderr = '', options = {}) {
  const events = parseJsonLines(raw);
  const counts = eventCounts(events);
  const eventTotal = events.length;
  const stderrResult = firstAllowlistedStderr(stderr);
  const startupFailure = isStartupFailure({
    exitCode: options.exitCode,
    eventTotal,
    reviewPosted: options.reviewPosted,
    sideEffectDetected: options.sideEffectDetected,
    durationMs: options.durationMs,
  });
  return {
    event_counts: counts,
    event_total: eventTotal,
    stderr_match: stderrResult.stderrMatch,
    cause_class: startupFailure && stderrResult.causeClass === 'unknown'
      ? 'startup-failure'
      : normalizeCauseClass(stderrResult.causeClass),
    startup_failure: startupFailure,
  };
}

function readText(file) {
  if (!file) return '';
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  const diagnosticsFile = process.argv[2] || '';
  const stderrFile = process.argv[3] || '';
  const result = parseCodexPrimaryDiagnostics(readText(diagnosticsFile), readText(stderrFile), {
    exitCode: process.argv[4],
    durationMs: process.argv[5],
    reviewPosted: process.argv[6],
    sideEffectDetected: process.argv[7],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

let invokedDirectly = false;
if (process.argv[1]) {
  try {
    invokedDirectly = realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    invokedDirectly = false;
  }
}
if (invokedDirectly) main();
