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
 * @returns {{cause: 'max_turns'|'rate_limit'|'server_error'|'cancelled'|'non_retryable'|'none', numTurns: number|null, source: 'structured'|'text'|'outcome'|'none', readError?: string}}
 */

import fs from 'node:fs';

export const CODEX_REVIEW_FAILURE_CAUSE = Object.freeze({
  MAX_TURNS: 'max_turns',
  RATE_LIMIT: 'rate_limit',
  SERVER_ERROR: 'server_error',
  CANCELLED: 'cancelled',
  NON_RETRYABLE: 'non_retryable',
  NONE: 'none',
});

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

function isFailureEvent(event) {
  return /(?:error|fail|abort|cancel)/i.test(eventType(event))
    || event?.is_error === true
    || event?.error != null;
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
    numTurns: null,
  };
  for (const event of events) {
    const failure = isFailureEvent(event);
    if (eventType(event) === 'rate_limit_event' || eventType(event) === 'rate_limit_error') {
      signals.rateLimit = true;
    }
    if (eventType(event) === 'rate_limit_event'
        && String(event?.rate_limit_info?.status || '').toLowerCase() === 'rejected') {
      signals.rateLimit = true;
    }
    walk(event, (object) => {
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
 * @param {{outcome?: string, raw?: string}} input
 */
export function classifyCodexReviewFailure({ outcome = '', raw = '' } = {}) {
  const normalizedOutcome = String(outcome || '').toLowerCase();
  const events = parseJsonEvents(raw);
  const structured = structuredSignals(events);
  const text = textSignals(raw, events);

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
  if (normalizedOutcome === 'cancelled') {
    return { cause: CODEX_REVIEW_FAILURE_CAUSE.CANCELLED, numTurns: structured.numTurns, source: 'outcome' };
  }
  if (normalizedOutcome === 'failure') {
    return { cause: CODEX_REVIEW_FAILURE_CAUSE.NON_RETRYABLE, numTurns: structured.numTurns, source: 'none' };
  }
  return { cause: CODEX_REVIEW_FAILURE_CAUSE.NONE, numTurns: structured.numTurns, source: 'none' };
}

function main() {
  const file = process.argv[2] || process.env.CODEX_DIAGNOSTICS_FILE || '';
  const outcome = process.argv[3] || process.env.REVIEW_OUTCOME || '';
  let raw = '';
  let readError = '';
  if (file) {
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
      readError = String(error?.message || error);
    }
  }
  const result = classifyCodexReviewFailure({ outcome, raw });
  const output = readError ? { ...result, readError } : result;
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
