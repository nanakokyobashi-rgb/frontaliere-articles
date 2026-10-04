#!/usr/bin/env node
/**
 * Reporter strutturato per il gate `node --test`.
 *
 * Il reporter `spec` resta sullo stdout della run. Questo secondo reporter
 * raccoglie gli eventi `test:fail` e scrive un JSON stabile in un file del
 * runner, così il passo successivo può pubblicare sulla PR i test falliti.
 *
 * Raccoglie anche gli eventi `test:stdout` (`stdoutWriters`): byte che il
 * processo figlio di un file di test ha scritto su stdout FUORI dal protocollo
 * del runner. Con l'isolamento a processo il figlio serializza gli eventi
 * (frame V8) proprio su stdout, e su Node 22 il parser del padre perde il
 * primo byte di un header spezzato fra due letture della pipe quando davanti
 * c'e' testo non serializzato: il frame successivo viene letto disallineato e
 * il file intero fallisce con «Unable to deserialize cloned data due to
 * invalid or unsupported version» anche se tutti i suoi test sono verdi
 * (issue 1819 del corpus, run 37174186291 e 37194730172 su
 * `score-ledger-persistence.test.mjs`). `check-node-test-stdout.mjs` rende
 * deterministico quel prerequisito del flake.
 */

import path from 'node:path';
import { inspect } from 'node:util';

const MAX_FAILURES = 50;
const MAX_MESSAGE_LENGTH = 3000;
const MAX_STDOUT_SAMPLE_LENGTH = 300;

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

/**
 * Accumula un evento `test:stdout` per file: quanti eventi, quanti byte e il
 * primo frammento, abbastanza per sapere QUALE log sfugge senza copiare nel
 * report l'intero output.
 */
export function recordStdoutWrite(writers, data = {}) {
  const file = relativeTestFile(data.file);
  const message = String(data.message ?? '');
  const entry = writers.get(file) || { file, events: 0, bytes: 0, sample: '' };
  entry.events += 1;
  entry.bytes += Buffer.byteLength(message);
  if (entry.sample.length < MAX_STDOUT_SAMPLE_LENGTH) {
    entry.sample = trimMessage(`${entry.sample}${message}`).slice(0, MAX_STDOUT_SAMPLE_LENGTH);
  }
  writers.set(file, entry);
  return writers;
}

export function buildReport(failures = [], suiteFailures = [], stdoutWriters = []) {
  return {
    failedTests: failures.length,
    failedSuites: suiteFailures.length,
    failures: failures.slice(0, MAX_FAILURES),
    suiteFailures: suiteFailures.slice(0, MAX_FAILURES),
    stdoutWriters: [...stdoutWriters]
      .sort((a, b) => a.file.localeCompare(b.file))
      .slice(0, MAX_FAILURES),
  };
}

export default async function* nodeTestFailureReporter(source) {
  const failures = [];
  const suiteFailures = [];
  const stdoutWriters = new Map();
  for await (const event of source) {
    if (event?.type === 'test:stdout') {
      recordStdoutWrite(stdoutWriters, event.data);
      continue;
    }
    if (event?.type !== 'test:fail') continue;
    const failure = normalizeFailure(event.data);
    if (event.data?.type === 'suite') suiteFailures.push(failure);
    else failures.push(failure);
  }
  yield `${JSON.stringify(buildReport(failures, suiteFailures, stdoutWriters.values()))}\n`;
}
