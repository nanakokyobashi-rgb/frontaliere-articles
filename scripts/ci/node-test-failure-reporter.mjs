#!/usr/bin/env node
/**
 * Reporter strutturato per il gate `node --test`.
 *
 * Il reporter `spec` resta sullo stdout della run. Questo secondo reporter
 * raccoglie gli eventi `test:fail` e scrive un JSON stabile in un file del
 * runner, così il passo successivo può pubblicare sulla PR i test falliti.
 */

import path from 'node:path';
import { inspect } from 'node:util';

const MAX_FAILURES = 50;
const MAX_MESSAGE_LENGTH = 3000;

function trimMessage(message) {
  const text = String(message || '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').trim();
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  return `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}

function relativeTestFile(file) {
  const raw = String(file || '').replaceAll('\\', '/');
  const relative = path.isAbsolute(raw)
    ? path.relative(process.cwd(), raw).replaceAll('\\', '/')
    : raw;
  return relative || '(file non disponibile)';
}

// `node:test` avvolge ogni eccezione in un Error `ERR_TEST_FAILURE` il cui
// stack e' solo `Error [ERR_TEST_FAILURE]: <messaggio>`: il file e la riga
// dell'asserzione vivono nel `cause`. Profondita' limitata: un `cause` ciclico
// non deve bloccare il reporter.
const MAX_CAUSE_DEPTH = 3;

function textField(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Descrizione leggibile di cio' che un test ha lanciato. Mai `String(error)`
 * su un oggetto: un `details.error = {}` (o un valore lanciato che non e' un
 * Error) diventerebbe `[object Object]`, che al lettore del commento sulla PR
 * non dice ne' cosa e' fallito ne' dove.
 */
export function describeError(error, depth = 0) {
  if (error === undefined || error === null) return 'errore senza messaggio nel report node:test';
  if (typeof error === 'string') return error.trim() || 'errore con messaggio vuoto nel report node:test';
  if (typeof error !== 'object' && typeof error !== 'function') {
    return `valore non-Error lanciato (${typeof error}): ${inspect(error)}`;
  }
  if (error.code === 'ERR_TEST_FAILURE' && error.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    return describeError(error.cause, depth + 1);
  }
  const stack = textField(error.stack);
  if (stack) return stack;
  const message = textField(error.message);
  if (message) return message;
  const kind = error.constructor?.name || 'Object';
  const shape = inspect(error, { depth: 4, breakLength: Infinity, compact: 3 });
  return `errore senza stack ne' message (${kind}): ${shape}`;
}

function errorMessage(error) {
  return trimMessage(describeError(error));
}

export function normalizeFailure(data = {}) {
  const details = data.details || {};
  return {
    file: relativeTestFile(data.file),
    line: Number.isInteger(data.line) ? data.line : null,
    test: data.name || '(test senza nome)',
    error: errorMessage(details.error || data.error),
  };
}

export function buildReport(failures = [], suiteFailures = []) {
  return {
    failedTests: failures.length,
    failedSuites: suiteFailures.length,
    failures: failures.slice(0, MAX_FAILURES),
    suiteFailures: suiteFailures.slice(0, MAX_FAILURES),
  };
}

export default async function* nodeTestFailureReporter(source) {
  const failures = [];
  const suiteFailures = [];
  for await (const event of source) {
    if (event?.type !== 'test:fail') continue;
    const failure = normalizeFailure(event.data);
    if (event.data?.type === 'suite') suiteFailures.push(failure);
    else failures.push(failure);
  }
  yield `${JSON.stringify(buildReport(failures, suiteFailures))}\n`;
}
