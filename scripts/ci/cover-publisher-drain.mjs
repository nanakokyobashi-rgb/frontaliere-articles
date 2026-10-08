#!/usr/bin/env node

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PUBLISH_OUTBOX_SCHEMA = 1;
export const RUN_LOOKUP_ATTEMPTS = 20;
export const RUN_LOOKUP_INTERVAL_MS = 2_000;

const PUBLISH_WORKFLOW_FOR_SECTION = {
  frontaliere: 'fast-publish-article.yml',
  svizzera: 'fast-publish-article.yml',
};

function workflowForSection(section) {
  return PUBLISH_WORKFLOW_FOR_SECTION[section] || 'fast-publish-section.yml';
}

function textError(error) {
  const detail = error?.stderr ? `${error?.message || 'command failed'}: ${String(error.stderr)}` : error?.message || error;
  return String(detail || 'unknown error')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 320) || 'unknown error';
}

function commandEnvironment(token) {
  return token ? { ...process.env, GH_TOKEN: token } : { ...process.env };
}

function deadlineError(message) {
  const error = new Error(message);
  error.code = 'DEADLINE_EXCEEDED';
  return error;
}

function isDeadlineError(error) {
  return error?.code === 'DEADLINE_EXCEEDED';
}

function terminateChild(child, signal) {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      /* The process may have exited between the timeout and the kill. */
    }
  }
  child.kill(signal);
}

function runGh(args, { token, deadlineAt, now = Date.now } = {}) {
  return new Promise((resolve, reject) => {
    const remaining = Number.isFinite(deadlineAt) ? deadlineAt - now() : null;
    if (remaining !== null && remaining <= 0) {
      reject(deadlineError(`deadline reached before gh ${args.join(' ')}`));
      return;
    }

    const child = spawn('gh', args, {
      detached: process.platform !== 'win32',
      env: commandEnvironment(token),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let deadlineTimer;
    let killTimer;

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (killTimer) clearTimeout(killTimer);
      callback();
    };

    const failForDeadline = () => finish(() => reject(deadlineError(
      `deadline reached while running gh ${args.join(' ')}`,
    )));

    if (remaining !== null) {
      deadlineTimer = setTimeout(() => {
        timedOut = true;
        terminateChild(child, 'SIGTERM');
        killTimer = setTimeout(() => {
          terminateChild(child, 'SIGKILL');
          failForDeadline();
        }, 1_000);
      }, Math.max(1, remaining));
    }

    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code, signal) => {
      if (timedOut) {
        failForDeadline();
      } else if (code === 0) {
        finish(() => resolve(stdout));
      } else {
        const error = new Error(`gh ${args.join(' ')} exited with ${signal || `code ${code}`}`);
        error.stderr = stderr || stdout;
        finish(() => reject(error));
      }
    });
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseJsonFile(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label}: ${textError(error)}`);
  }
}

function validateOutbox(outbox) {
  if (!outbox || outbox.schema !== PUBLISH_OUTBOX_SCHEMA || !Array.isArray(outbox.items)) {
    throw new Error('publisher outbox must contain schema 1 and an items array');
  }
  for (const [index, item] of outbox.items.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || !String(item.articleId || '').trim() || !String(item.section || '').trim()) {
      throw new Error(`publisher outbox items[${index}] must contain articleId and section`);
    }
  }
  return outbox;
}

export function readPublisherOutbox(filePath) {
  if (!fs.existsSync(filePath)) return { schema: PUBLISH_OUTBOX_SCHEMA, items: [] };
  return validateOutbox(parseJsonFile(filePath, filePath));
}

export function groupPublisherOutbox(outbox) {
  validateOutbox(outbox);
  const groups = [];
  const bySection = new Map();
  for (const item of outbox.items) {
    let group = bySection.get(item.section);
    if (!group) {
      group = {
        section: item.section,
        articleIds: [],
        workflow: workflowForSection(item.section),
      };
      bySection.set(item.section, group);
      groups.push(group);
    }
    group.articleIds.push(String(item.articleId));
  }
  return groups;
}

function normalizeStatus(status) {
  if (status && Array.isArray(status.sections)) return status;
  return { sections: [] };
}

export function ackSuccessfulPublisherSections(outbox, publisherStatus) {
  validateOutbox(outbox);
  const successful = new Set(
    normalizeStatus(publisherStatus).sections
      .filter((section) => section?.status === 'success')
      .map((section) => String(section.section || '')),
  );
  const acknowledgedSections = groupPublisherOutbox(outbox)
    .map((group) => group.section)
    .filter((section) => successful.has(section));
  const acknowledgedSet = new Set(acknowledgedSections);
  return {
    outbox: {
      schema: PUBLISH_OUTBOX_SCHEMA,
      items: outbox.items.filter((item) => !acknowledgedSet.has(item.section)),
    },
    acknowledgedSections,
  };
}

function dispatchArguments({ workflow, section, articleIds, repo, dispatchNonce }) {
  if (workflow === 'fast-publish-article.yml') {
    return [
      'workflow', 'run', workflow,
      '--repo', repo,
      '--ref', 'main',
      '--field', `article_ids=${JSON.stringify(articleIds)}`,
      '--field', `section=${section}`,
      '--field', 'dry_run=false',
      '--field', `dispatch_nonce=${dispatchNonce}`,
    ];
  }
  return [
    'workflow', 'run', workflow,
    '--repo', repo,
    '--ref', 'main',
    '--field', `section=${section}`,
    '--field', `article_ids=${JSON.stringify(articleIds)}`,
    '--field', 'bootstrap=false',
    '--field', 'dry_run=false',
    '--field', `dispatch_nonce=${dispatchNonce}`,
  ];
}

async function listRunIds({ repo, workflow, token, deadlineAt, now }) {
  const output = await runGh([
    'run', 'list',
    '--repo', repo,
    '--workflow', workflow,
    '--event', 'workflow_dispatch',
    '--branch', 'main',
    '--limit', '100',
    '--json', 'databaseId,createdAt,displayTitle',
  ], { token, deadlineAt, now });
  const runs = JSON.parse(output || '[]');
  return Array.isArray(runs) ? runs : [];
}

export function selectNewRunId(runs, { beforeIds, dispatchNonce }) {
  return runs
    .filter((run) => run?.databaseId != null)
    .filter((run) => !beforeIds.has(String(run.databaseId)))
    .filter((run) => String(run.displayTitle || '').includes(`nonce=${dispatchNonce}`))
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))[0] || null;
}

async function findNewRunId({ repo, workflow, beforeIds, dispatchNonce, token, deadlineAt, now = Date.now }) {
  for (let attempt = 0; attempt < RUN_LOOKUP_ATTEMPTS; attempt += 1) {
    if (now() >= deadlineAt) return null;
    const runs = await listRunIds({ repo, workflow, token, deadlineAt, now });
    const candidate = selectNewRunId(runs, { beforeIds, dispatchNonce });
    if (candidate) return String(candidate.databaseId);
    if (attempt + 1 < RUN_LOOKUP_ATTEMPTS) {
      const remaining = Math.max(0, deadlineAt - now());
      if (remaining <= 0) return null;
      await sleep(Math.min(RUN_LOOKUP_INTERVAL_MS, remaining));
    }
  }
  return null;
}

async function defaultDispatch({ repo, workflow, section, articleIds, token, deadlineAt, now = Date.now }) {
  const dispatchNonce = `cover-${section}-${now()}-${randomUUID()}`;
  const beforeIds = new Set((await listRunIds({ repo, workflow, token, deadlineAt, now })).map((run) => String(run.databaseId)));
  await runGh(dispatchArguments({ workflow, section, articleIds, repo, dispatchNonce }), { token, deadlineAt, now });
  const runId = await findNewRunId({
    repo,
    workflow,
    beforeIds,
    dispatchNonce,
    token,
    deadlineAt,
    now,
  });
  if (!runId) {
    if (now() >= deadlineAt) throw deadlineError(`deadline reached while locating publisher run for ${section}`);
    throw new Error(`publisher dispatch accepted for ${section}, but its nonce-tagged run id was not observable`);
  }
  return { runId, dispatchAccepted: true, dispatchNonce };
}

function appendOutput(current, chunk) {
  const next = `${current}${chunk}`;
  return next.length > 8_000 ? next.slice(-8_000) : next;
}

function defaultWatch({ repo, runId, token, deadlineAt, now = Date.now }) {
  return new Promise((resolve) => {
    const child = spawn('gh', ['run', 'watch', runId, '--repo', repo, '--exit-status'], {
      env: commandEnvironment(token),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    let settled = false;
    let killTimer;
    const remaining = Math.max(0, deadlineAt - now());
    const deadlineTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
    }, remaining);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };

    child.stdout?.on('data', (chunk) => { output = appendOutput(output, chunk); });
    child.stderr?.on('data', (chunk) => { output = appendOutput(output, chunk); });
    child.on('error', (error) => finish({ status: timedOut ? 'in-progress' : 'failed', error: textError(error) }));
    child.on('close', (code, signal) => {
      if (timedOut) {
        finish({ status: 'in-progress', error: `deadline reached while watching run ${runId}` });
      } else if (code === 0) {
        finish({ status: 'success' });
      } else {
        finish({
          status: 'failed',
          error: textError(output || `gh run watch exited with ${signal || `code ${code}`}`),
        });
      }
    });
  });
}

function resultCounts(sections) {
  return sections.reduce((counts, section) => {
    if (section.dispatchAccepted) counts.started += 1;
    if (section.status === 'success') counts.succeeded += 1;
    else if (section.status === 'failed') counts.failed += 1;
    else if (section.status === 'in-progress') counts.inProgress += 1;
    else if (section.status === 'not-started') counts.notStarted += 1;
    return counts;
  }, { started: 0, succeeded: 0, failed: 0, inProgress: 0, notStarted: 0 });
}

export function publisherStatusIsComplete(status) {
  return Array.isArray(status?.sections)
    && status.sections.every((section) => section?.status === 'success');
}

export async function drainCoverPublishers({
  outbox,
  repo,
  deadlineAt,
  now = Date.now,
  dispatch = defaultDispatch,
  watch = defaultWatch,
  token,
} = {}) {
  const groups = groupPublisherOutbox(outbox);
  const sections = groups.map((group) => ({
    ...group,
    runId: null,
    dispatchAccepted: false,
    status: 'not-started',
    error: null,
  }));

  await Promise.all(sections.map(async (section) => {
    if (now() >= deadlineAt) {
      section.error = 'deadline reached before dispatch';
      return;
    }
    try {
      const result = await dispatch({
        repo,
        workflow: section.workflow,
        section: section.section,
        articleIds: section.articleIds,
        token,
        deadlineAt,
        now,
      });
      section.dispatchAccepted = result?.dispatchAccepted !== false;
      section.runId = result?.runId ? String(result.runId) : null;
      if (!section.runId) throw new Error('publisher dispatch returned no run id');
    } catch (error) {
      section.status = isDeadlineError(error) ? 'in-progress' : 'failed';
      section.error = textError(error);
    }
  }));

  const watchable = sections.filter((section) => section.runId && section.status === 'not-started');
  if (now() >= deadlineAt) {
    for (const section of watchable) {
      section.status = 'in-progress';
      section.error = `deadline reached before watching run ${section.runId}`;
    }
  } else {
    await Promise.all(watchable.map(async (section) => {
      try {
        const result = await watch({
          repo,
          runId: section.runId,
          section: section.section,
          token,
          deadlineAt,
          now,
        });
        section.status = result?.status === 'success' ? 'success'
          : result?.status === 'in-progress' ? 'in-progress' : 'failed';
        section.error = section.status === 'success' ? null : textError(result?.error || `publisher ${section.status}`);
      } catch (error) {
        section.status = 'failed';
        section.error = textError(error);
      }
    }));
  }

  return {
    schema: 1,
    generatedAt: new Date(now()).toISOString(),
    deadlineAt,
    sections,
    counts: resultCounts(sections),
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function parseArgs(argv) {
  const options = {
    mode: 'run',
    outbox: 'data/image-regeneration-publish-outbox.json',
    status: null,
    repo: process.env.GITHUB_REPOSITORY || '',
    deadlineAt: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mode') options.mode = argv[++index];
    else if (arg === '--outbox') options.outbox = argv[++index];
    else if (arg === '--status') options.status = argv[++index];
    else if (arg === '--repo') options.repo = argv[++index];
    else if (arg === '--deadline-at') options.deadlineAt = Number(argv[++index]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.status) throw new Error('--status requires a file path');
  if (options.mode === 'run' && (!options.repo || !Number.isFinite(options.deadlineAt))) {
    throw new Error('--repo and a finite --deadline-at are required in run mode');
  }
  if (!['run', 'ack'].includes(options.mode)) throw new Error(`unknown mode: ${options.mode}`);
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outbox = readPublisherOutbox(options.outbox);
  if (options.mode === 'ack') {
    if (outbox.items.length === 0) {
      console.log(JSON.stringify({ acknowledgedSections: [], residual: 0 }));
      return;
    }
    if (!fs.existsSync(options.status)) throw new Error(`publisher status is missing: ${options.status}`);
    const status = parseJsonFile(options.status, options.status);
    if (!Array.isArray(status?.sections)) throw new Error(`publisher status is malformed: ${options.status}`);
    const acknowledged = ackSuccessfulPublisherSections(outbox, status);
    if (acknowledged.outbox.items.length === 0) fs.rmSync(options.outbox, { force: true });
    else writeJson(options.outbox, acknowledged.outbox);
    console.log(JSON.stringify({
      acknowledgedSections: acknowledged.acknowledgedSections,
      residual: acknowledged.outbox.items.length,
    }));
    return;
  }

  const status = await drainCoverPublishers({
    outbox,
    repo: options.repo,
    deadlineAt: options.deadlineAt,
    token: process.env.GH_TOKEN || process.env.GITHUB_PAT_NANAKO,
  });
  writeJson(options.status, status);
  console.log(JSON.stringify(status.counts));
  if (!publisherStatusIsComplete(status)) process.exitCode = 1;
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`❌ Cover publisher drain failed: ${textError(error)}`);
    process.exit(1);
  });
}
