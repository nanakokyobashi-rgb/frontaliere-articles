#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import {
  resolveCantonHubRefreshReceiptCandidate,
  verifyCantonHubRefreshReceipt,
} from './lib/canton-hubs/refresh-receipt.mjs';

async function readStdin() {
  let value = '';
  for await (const chunk of process.stdin) value += chunk;
  return value.split('\n').filter(Boolean);
}

function output(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  else process.stdout.write(`${lines.join('\n')}\n`);
}

function gitCommitMessage(commit) {
  try {
    return execFileSync('git', ['show', '-s', '--format=%B', commit], { encoding: 'utf8' });
  } catch {
    return '';
  }
}

const mode = process.argv[2];
const publisherSourceCommit = process.env.PUBLISHER_SOURCE_COMMIT || '';
const changedPaths = await readStdin();
const commitMessage = gitCommitMessage(publisherSourceCommit);

if (mode === 'candidate') {
  const candidate = resolveCantonHubRefreshReceiptCandidate({
    eventName: process.env.EVENT_NAME,
    changedPaths,
    commitMessage,
    publisherSourceCommit,
  });
  if (!candidate.candidate) {
    output({ candidate: 'false' });
  } else {
    output({
      candidate: 'true',
      run_id: candidate.runId,
      run_attempt: candidate.runAttempt,
      artifact_name: candidate.artifactName,
    });
  }
  process.exit(0);
}

if (mode !== 'verify') {
  process.stderr.write('uso: resolve-canton-hub-refresh-proof.mjs candidate|verify\n');
  process.exit(2);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

const result = verifyCantonHubRefreshReceipt({
  receipt: readJson(process.env.RECEIPT_PATH || ''),
  runMetadata: readJson(process.env.RUN_METADATA_PATH || ''),
  repository: process.env.GITHUB_REPOSITORY || '',
  runId: process.env.RECEIPT_RUN_ID || '',
  runAttempt: process.env.RECEIPT_RUN_ATTEMPT || '',
  publisherSourceCommit,
  commitMessage,
  publisherChangedPaths: changedPaths,
});
if (!result.verified) process.stderr.write(`[canton-hubs] proof artifact non autenticato: ${result.reason}\n`);
output({ verified: String(result.verified) });
