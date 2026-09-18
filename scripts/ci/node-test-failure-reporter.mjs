#!/usr/bin/env node
/**
 * Reporter strutturato per il gate `node --test`.
 *
 * Il reporter `spec` resta sullo stdout della run. Questo secondo reporter
 * raccoglie gli eventi `test:fail` e scrive un JSON stabile in un file del
 * runner, così il passo successivo può pubblicare sulla PR i test falliti.
 */

import path from 'node:path';

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

function errorMessage(error) {
  if (!error) return 'errore senza messaggio nel report node:test';
  if (typeof error === 'string') return trimMessage(error);
  return trimMessage(error.stack || error.message || String(error));
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
