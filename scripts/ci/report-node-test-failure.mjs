#!/usr/bin/env node
/** Pubblica sulla PR i test `node:test` falliti dal gate `tests`. */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MARKER = '<!-- node-test-failure-report -->';
const MAX_FAILURES = 30;
const MAX_BODY_LENGTH = 60_000;

function readReport(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function runGh(args) {
  try {
    const stdout = execFileSync('gh', args, {
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout };
  } catch (err) {
    const reason = String(err?.stderr || err?.message || 'errore sconosciuto').trim().split('\n')[0];
    return { ok: false, error: reason || 'errore sconosciuto' };
  }
}

function ghOutput(args) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch {
    return '';
  }
}

function buildFailureLines(failure) {
  const location = failure.line ? `${failure.file}:${failure.line}` : failure.file;
  return [
    `- **${location}** — \`${failure.test}\``,
    '  ```text',
    `  ${String(failure.error || 'errore senza messaggio').replaceAll('\n', '\n  ')}`,
    '  ```',
  ];
}

export function buildComment(report, {
  runUrl = '',
  runId = '',
  headSha = '',
} = {}) {
  const failures = Array.isArray(report?.failures) ? report.failures : [];
  const suiteFailures = Array.isArray(report?.suiteFailures) ? report.suiteFailures : [];
  const lines = [
    MARKER,
    '## ❌ Test `node:test` falliti',
    '',
    'Il gate `tests` è fallito. Dettaglio estratto dagli eventi del test runner:',
    '',
    `- Test falliti: **${report?.failedTests ?? failures.length}**`,
    `- Suite/file falliti: **${report?.failedSuites ?? suiteFailures.length}**`,
  ];

  for (const failure of failures.slice(0, MAX_FAILURES)) lines.push(...buildFailureLines(failure));
  const totalFailures = Number(report?.failedTests ?? failures.length);
  if (totalFailures > MAX_FAILURES) {
    lines.push(`- … e altri ${totalFailures - MAX_FAILURES} test falliti nel report.`);
  }
  if (failures.length === 0 && suiteFailures.length > 0) {
    lines.push('', 'Dettaglio suite/file fallite:');
    for (const failure of suiteFailures.slice(0, MAX_FAILURES)) lines.push(...buildFailureLines(failure));
  }
  if (failures.length === 0 && suiteFailures.length === 0) {
    lines.push('- Il runner non ha prodotto eventi strutturati; consultare il log della run.');
  }
  if (runUrl) lines.push('', `Run: ${runUrl}`);
  if (runId) lines.push(`Run ID: \`${runId}\``);
  if (headSha) lines.push(`HEAD verificata: \`${headSha.slice(0, 12)}\``);
  return lines.join('\n').slice(0, MAX_BODY_LENGTH);
}

function publishComment(repo, prNumber, body) {
  const raw = ghOutput(['api', `repos/${repo}/issues/${prNumber}/comments?per_page=100`]);
  let comments = [];
  try { comments = JSON.parse(raw); } catch { /* best-effort: create a new comment */ }
  const previous = comments.find((comment) => String(comment.body || '').includes(MARKER));
  if (previous?.id) {
    return runGh([
      'api',
      '--method', 'PATCH',
      `repos/${repo}/issues/comments/${previous.id}`,
      '-f', `body=${body}`,
    ]);
  }
  return runGh(['pr', 'comment', prNumber, '--repo', repo, '--body', body]);
}

function writeStepSummary(body) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY || '';
  if (!summaryPath) return;
  try {
    fs.appendFileSync(summaryPath, `\n${body}\n`);
  } catch (err) {
    console.log(`::warning title=node:test failure report::Impossibile scrivere GITHUB_STEP_SUMMARY: ${String(err?.message || err)}`);
  }
}

function main() {
  const prNumber = process.env.PR_NUMBER || '';
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
  if (!prNumber || !repo) {
    console.log('node:test report: PR/repository non disponibili.');
    return;
  }
  const report = readReport(process.env.NODE_TEST_REPORT_FILE || '');
  const body = buildComment(report, {
    runUrl: process.env.RUN_URL || '',
    runId: process.env.RUN_ID || '',
    headSha: process.env.HEAD_SHA || '',
  });
  const result = publishComment(repo, prNumber, body);
  if (result.ok) {
    console.log(`Commento failure node:test pubblicato/aggiornato sulla PR #${prNumber}.`);
    return;
  }
  console.log(`::warning title=node:test failure report::Impossibile pubblicare il commento sticky node:test sulla PR #${prNumber} (repo ${repo}): ${result.error}`);
  writeStepSummary(body);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main();
