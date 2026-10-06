#!/usr/bin/env node

/**
 * Classifica il fallimento della review Codex usando lo stream JSONL prodotto
 * da `codex exec --json`.
 *
 * Il file è un artefatto effimero della singola run: non contiene token o
 * prompt, ma solo gli eventi diagnostici del processo. La classificazione è
 * volutamente conservativa e usa prima i campi strutturati; il testo libero è
 * considerato solo quando arriva da un evento esplicitamente fallito/errato.
 *
 * @returns {{cause: 'max_turns'|'rate_limit'|'server_error'|'cancelled'|'non_retryable'|'none', numTurns: number|null, source: 'structured'|'text'|'outcome'|'watchdog'|'none', readError?: string}}
 */

import fs from 'node:fs';

export const CODEX_REVIEW_FAILURE_CAUSE = Object.freeze({
  MAX_TURNS: 'max_turns',
  RATE_LIMIT: 'rate_limit',
  SERVER_ERROR: 'server_error',
  CANCELLED: 'cancelled',
  STARTUP_FAILURE: 'startup_failure',
  NON_RETRYABLE: 'non_retryable',
  NONE: 'none',
});

export const CODEX_REVIEW_WATCHDOG_TIMEOUT_MS = 1_800_000;
// A provider process that dies before the first turn is materially different
// from a review that ran and failed. Keep this window short and explicit: it is
// a bounded one-shot recovery signal, not a general retry permission.
export const CODEX_REVIEW_STARTUP_FAILURE_THRESHOLD_MS = 30_000;

function parseJsonEvents(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [value];
  } catch {
    return text.split(/\r?\n/).flatMap((line) => {
      try {
        const value = JSON.parse(line);
        return value && typeof value === 'object' ? [value] : [];
      } catch {
        return [];
      }
    });
  }
}

function walk(value, visit) {
  if (!value || typeof value !== 'object') return;
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  for (const child of Object.values(value)) walk(child, visit);
}

function eventType(event) {
  return String(event?.type || event?.event || '').toLowerCase();
}

function eventCounts(events) {
  const counts = {};
  for (const event of events) {
    const type = eventType(event) || 'unknown';
    counts[type] = (counts[type] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function turnEventCount(events) {
  return events.filter((event) => /^turn(?:\.|$)/u.test(eventType(event))).length;
}

/**
 * Return only a canonical, non-secret description of a known stderr shape.
 * The raw line can contain a prompt, model output, a token, or a file path, so
 * it must never cross into a summary, output, or claim comment.
 */
export function firstAllowedCodexDiagnostic(raw) {
  const lines = String(raw || '').split(/\r?\n/u);
  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    try {
      JSON.parse(text);
      continue;
    } catch {
      // Non-JSON lines are the stderr side of the mixed Codex stream.
    }
    const status = text.match(/\b(?:HTTP\s*|status(?:[_ -]?code)?\s*[:= ]+|api[_ -]?error[_ -]?status\s*[:= ]+)([45]\d{2})\b/iu);
    if (status) return `http_status=${status[1]}`;
    if (/stream\s+disconnected/iu.test(text)) return 'stream_disconnected';
    if (/(?:usage|rate)[ _-]?limit|too many requests/iu.test(text)) return 'usage_limit';
    if (/model\s+not\s+found/iu.test(text)) return 'model_not_found';
    if (/(?:401\s+unauthorized|token[_ -]?expired|refresh\s+token)/iu.test(text)) return 'authentication_error';
    if (/(?:invalid|unknown|unrecognized|malformed|missing)[^\r\n]{0,80}(?:config|argument|option|parameter)/iu.test(text)) {
      return 'configuration_or_arguments_error';
    }
    if (/(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|network\s+error|connection\s+(?:reset|refused))/iu.test(text)) {
      return 'network_error';
    }
  }
  return '';
}

/** Non-secret telemetry shared by the action finalizer and the classifier. */
export function summarizeCodexDiagnostics(raw) {
  const events = parseJsonEvents(raw);
  return {
    eventCounts: eventCounts(events),
    turnEventCount: turnEventCount(events),
    diagnostic: firstAllowedCodexDiagnostic(raw),
  };
}

function isFailureEvent(event) {
  return /(?:error|fail|abort|cancel)/i.test(eventType(event))
    || event?.is_error === true
    || event?.error != null;
}

/**
 * Marker strutturato di quota, a qualunque profondita' dell'evento. Una sola
 * regola per il top level e per gli oggetti annidati: un `rate_limit_event`
 * incapsulato in un evento contenitore (`{type:'event', payload:{...}}`) o un
 * `rate_limit_info.status: rejected` senza `type` cadevano nel ramo
 * `non_retryable` e congelavano il gate senza retry (follow-up sito #8334,
 * FU-2026-09-12-011).
 */
function isRateLimitMarker(object) {
  const type = eventType(object);
  if (type === 'rate_limit_event' || type === 'rate_limit_error') return true;
  return String(object?.rate_limit_info?.status || '').toLowerCase() === 'rejected';
}

function statusCode(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function structuredSignals(events) {
  const signals = {
    maxTurns: false,
    rateLimit: false,
    serverError: false,
    cancelled: false,
    numTurns: null,
  };
  for (const event of events) {
    const failure = isFailureEvent(event);
    if (eventType(event) === 'codex_timeout'
        || event?.codex_timeout === true
        || eventType(event) === 'codex_no_review'
        || event?.codex_no_review === true) {
      signals.cancelled = true;
    }
    walk(event, (object) => {
      if (isRateLimitMarker(object)) signals.rateLimit = true;
      for (const [key, value] of Object.entries(object)) {
        const normalizedKey = key.replace(/[-_]/g, '').toLowerCase();
        const text = String(value ?? '').toLowerCase();
        if (['numturns', 'turns'].includes(normalizedKey) && Number.isFinite(Number(value))) {
          signals.numTurns = Math.max(signals.numTurns ?? 0, Number(value));
        }
        if (['terminalreason', 'terminationreason', 'reason', 'subtype', 'code'].includes(normalizedKey)
            && /(?:^|[_ -])(?:error_)?max[_ -]?turns$|^max[_ -]?turns$/.test(text)) {
          signals.maxTurns = true;
        }
        if (['apierrorstatus', 'statuscode', 'httpstatus', 'status'].includes(normalizedKey)) {
          const status = statusCode(value);
          if (status === 429) signals.rateLimit = true;
          if (status !== null && status >= 500 && status <= 599) signals.serverError = true;
        }
        if (normalizedKey === 'ratelimitevent' || normalizedKey === 'ratelimiterror') {
          signals.rateLimit = true;
        }
        if (normalizedKey === 'error' && /rate[_ -]?limit|too many requests/.test(text)) {
          signals.rateLimit = true;
        }
        if (failure && /overloaded|server[_ -]?error|internal server error/.test(text)) {
          signals.serverError = true;
        }
      }
    });

    if (failure) {
      const serialized = JSON.stringify(event);
      if (/(?:maximum|exceeded|limit).*turns|turns.*(?:maximum|exceeded|limit)|max[_ -]?turns/i.test(serialized)) {
        signals.maxTurns = true;
      }
      if (/(?:http|status|error)[ _-]*(?:code|status)?[^0-9]{0,12}429\b|rate[_ -]?limit|too many requests/i.test(serialized)) {
        signals.rateLimit = true;
      }
      if (/\b5[0-9]{2}\b|overloaded|server[_ -]?error|internal server error|api error:?[ ]*5/i.test(serialized)) {
        signals.serverError = true;
      }
    }
  }
  return signals;
}

function nonJsonRemainder(raw) {
  return String(raw || '')
    .split(/\r?\n/u)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      try {
        JSON.parse(trimmed);
        return false;
      } catch {
        return true;
      }
    })
    .join('\n');
}

function textSignals(raw, events) {
  const failedEvents = events
    .filter(isFailureEvent)
    .map((event) => JSON.stringify(event))
    .join('\n');
  // When --json produced valid non-error events, do not scan model text as if
  // it were a transport error: a review can legitimately mention "429" or
  // "rate_limit" in its prompt/output. Non-JSON remainder (stderr) still
  // carries transport errors and must not collapse a retryable failure into
  // `non_retryable`.
  const remainder = events.length === 0 ? String(raw || '') : nonJsonRemainder(raw);
  const text = [failedEvents, remainder].filter(Boolean).join('\n');
  return {
    maxTurns: /(?:terminal[_ -]?reason|termination[_ -]?reason|error[_ -]?code|subtype|reason)[^\n:=]*[:=][^\n]*(?:max[_ -]?turns|error[_ -]?max[_ -]?turns)|(?:maximum|exceeded).*turns/i.test(text),
    rateLimit: /(?:api[_ -]?error[_ -]?status|http|status)[^\n:=]*[:= ]+[^\n]*429\b[^\n]*(?:rate[_ -]?limit|too many requests)|rate[_ -]?limit(?:[_ -]?event|[_ -]?error)|too many requests/i.test(text),
    serverError: /(?:api[_ -]?error[_ -]?status|http[_ -]?status|status[_ -]?code)[^\n:=]*[:= ]+[^\n]*\b5[0-9]{2}\b|overloaded|server[_ -]?error|internal server error|api error[^\n]*\b5[0-9]{2}\b/i.test(text),
  };
}

/**
 * @param {{outcome?: string, raw?: string, timedOut?: boolean, durationMs?: number|string}} input
 */
export function classifyCodexReviewFailure({
  outcome = '',
  raw = '',
  timedOut = false,
  durationMs = null,
  reviewPosted = false,
  sideEffectDetected = null,
} = {}) {
  const normalizedOutcome = String(outcome || '').toLowerCase();
  const telemetry = summarizeCodexDiagnostics(raw);
  const events = parseJsonEvents(raw);
  const structured = structuredSignals(events);
  const text = textSignals(raw, events);
  const measuredDurationMs = Number(durationMs);
  const watchdogExpired = timedOut === true
    || (Number.isFinite(measuredDurationMs) && measuredDurationMs >= CODEX_REVIEW_WATCHDOG_TIMEOUT_MS);

  if (watchdogExpired) {
    return { cause: CODEX_REVIEW_FAILURE_CAUSE.CANCELLED, numTurns: structured.numTurns, source: 'watchdog' };
  }

  if (structured.maxTurns || text.maxTurns) {
    return {
      cause: CODEX_REVIEW_FAILURE_CAUSE.MAX_TURNS,
      numTurns: structured.numTurns,
      source: structured.maxTurns ? 'structured' : 'text',
    };
  }
  if (structured.rateLimit || text.rateLimit) {
    return {
      cause: CODEX_REVIEW_FAILURE_CAUSE.RATE_LIMIT,
      numTurns: structured.numTurns,
      source: structured.rateLimit ? 'structured' : 'text',
    };
  }
  if (structured.serverError || text.serverError) {
    return {
      cause: CODEX_REVIEW_FAILURE_CAUSE.SERVER_ERROR,
      numTurns: structured.numTurns,
      source: structured.serverError ? 'structured' : 'text',
    };
  }
  if (structured.cancelled) {
    return { cause: CODEX_REVIEW_FAILURE_CAUSE.CANCELLED, numTurns: structured.numTurns, source: 'structured' };
  }
  if (normalizedOutcome === 'cancelled') {
    return { cause: CODEX_REVIEW_FAILURE_CAUSE.CANCELLED, numTurns: structured.numTurns, source: 'outcome' };
  }
  const startupFailure = normalizedOutcome === 'failure'
    && Number.isFinite(measuredDurationMs)
    && measuredDurationMs >= 0
    && measuredDurationMs < CODEX_REVIEW_STARTUP_FAILURE_THRESHOLD_MS
    && telemetry.turnEventCount === 0
    && reviewPosted !== true
    && reviewPosted !== 'true'
    && (sideEffectDetected === false || sideEffectDetected === 'false');
  if (startupFailure) {
    return {
      cause: CODEX_REVIEW_FAILURE_CAUSE.STARTUP_FAILURE,
      numTurns: structured.numTurns,
      source: 'startup',
    };
  }
  if (normalizedOutcome === 'failure') {
    return { cause: CODEX_REVIEW_FAILURE_CAUSE.NON_RETRYABLE, numTurns: structured.numTurns, source: 'none' };
  }
  return { cause: CODEX_REVIEW_FAILURE_CAUSE.NONE, numTurns: structured.numTurns, source: 'none' };
}

function main() {
  const file = process.argv[2] || process.env.CODEX_DIAGNOSTICS_FILE || '';
  const outcome = process.argv[3] || process.env.REVIEW_OUTCOME || '';
  const timedOut = String(process.env.CODEX_TIMED_OUT || '').toLowerCase() === 'true';
  const durationMs = process.env.CODEX_DURATION_MS || null;
  const reviewPosted = String(process.env.CODEX_REVIEW_POSTED || '').toLowerCase() === 'true';
  const sideEffectDetected = process.env.CODEX_SIDE_EFFECT_DETECTED || null;
  let raw = '';
  let readError = '';
  if (file) {
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
      readError = String(error?.message || error);
    }
  }
  const result = classifyCodexReviewFailure({
    outcome,
    raw,
    timedOut,
    durationMs,
    reviewPosted,
    sideEffectDetected,
  });
  const telemetry = summarizeCodexDiagnostics(raw);
  const output = {
    ...result,
    eventCounts: telemetry.eventCounts,
    turnEventCount: telemetry.turnEventCount,
    diagnostic: telemetry.diagnostic,
    ...(readError ? { readError } : {}),
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
