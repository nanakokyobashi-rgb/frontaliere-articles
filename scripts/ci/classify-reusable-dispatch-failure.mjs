#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const RUNNER_ONLY_STEPS = new Set(['Set up job', 'Complete job']);

/**
 * Distingue un errore di risoluzione/download del reusable workflow da un
 * fallimento avvenuto dopo l'inizio della sua logica. In dubbio non ritenta:
 * ripetere crawl o scritture parziali e' piu' rischioso che perdere un giro.
 */
export function classifyReusableDispatchFailure(jobs, jobPrefix) {
  const prefix = String(jobPrefix || '').trim();
  if (!prefix) throw new Error('jobPrefix obbligatorio');

  const matches = (Array.isArray(jobs) ? jobs : []).filter((job) => {
    const name = String(job?.name || '');
    return name === prefix || name.startsWith(`${prefix} /`);
  });

  if (matches.length === 0) {
    return { beforeLogic: true, reason: 'job-record-absent' };
  }

  const logicSteps = matches.flatMap((job) => (Array.isArray(job?.steps) ? job.steps : []))
    .filter((step) => !RUNNER_ONLY_STEPS.has(String(step?.name || '')));
  if (logicSteps.length === 0) {
    return { beforeLogic: true, reason: 'runner-setup-only' };
  }

  return {
    beforeLogic: false,
    reason: `logic-started:${String(logicSteps[0]?.name || 'unknown')}`,
  };
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`argomento inatteso: ${arg}`);
    const key = arg.slice(2);
    const value = argv[++i];
    if (value === undefined) throw new Error(`valore mancante per --${key}`);
    opts[key] = value;
  }
  return opts;
}

function fetchRunJobs(repository, runId) {
  const out = execFileSync(
    'gh',
    ['api', `repos/${repository}/actions/runs/${runId}/jobs?per_page=100`],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  const parsed = JSON.parse(out);
  if (!Array.isArray(parsed?.jobs)) throw new Error('Jobs API senza array jobs');
  return parsed.jobs;
}

function writeGithubOutput(file, verdict) {
  if (!file) return;
  fs.appendFileSync(
    file,
    `before_logic=${verdict.beforeLogic ? 'true' : 'false'}\nreason=${verdict.reason}\n`,
  );
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const opts = parseArgs(argv);
  const repository = opts.repository || env.GITHUB_REPOSITORY;
  const runId = opts['run-id'] || env.GITHUB_RUN_ID;
  const jobPrefix = opts['job-prefix'];
  const outputFile = opts['github-output'] || env.GITHUB_OUTPUT;
  const waitSeconds = Number(opts['wait-seconds'] || 0);

  if (!repository) throw new Error('repository mancante');
  if (!runId) throw new Error('run-id mancante');
  if (!jobPrefix) throw new Error('job-prefix mancante');
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 600) {
    throw new Error('wait-seconds deve essere fra 0 e 600');
  }

  const verdict = classifyReusableDispatchFailure(fetchRunJobs(repository, runId), jobPrefix);
  console.log(`[reusable-dispatch] ${jobPrefix}: ${verdict.reason}; before_logic=${verdict.beforeLogic}`);

  if (verdict.beforeLogic && waitSeconds > 0) {
    console.log(`[reusable-dispatch] backoff ${waitSeconds}s prima del retry`);
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
  }
  writeGithubOutput(outputFile, verdict);
  return verdict;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[reusable-dispatch] ${err.message}`);
    process.exitCode = 1;
  });
}
