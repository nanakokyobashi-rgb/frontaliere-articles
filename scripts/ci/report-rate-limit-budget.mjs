#!/usr/bin/env node
/**
 * Print a grep-able snapshot of the authenticated GitHub rate-limit buckets.
 * `rate_limit` is the quota endpoint and does not spend the bucket it reports.
 * The workflow owns token selection; this helper never prints token material.
 */
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const MAX_BUFFER = 4 * 1024 * 1024;

function safeName(value, fallback) {
  const text = String(value || '').trim();
  return /^[A-Za-z0-9_.:-]+$/.test(text) ? text : fallback;
}

function numberOrUnknown(value) {
  if (value === null || value === undefined || value === '') return 'unknown';
  return Number.isSafeInteger(Number(value)) ? String(Number(value)) : 'unknown';
}

export function rateLimitBuckets(raw) {
  let payload;
  try {
    payload = JSON.parse(String(raw));
  } catch {
    return null;
  }
  const resources = payload?.resources;
  return resources && typeof resources === 'object' ? resources : null;
}

export function formatRateLimitBudget({ workflow, token, resource, bucket }) {
  const state = bucket && typeof bucket === 'object' ? bucket : {};
  return `RATE_LIMIT_BUDGET workflow=${safeName(workflow, 'unknown')} `
    + `used=${numberOrUnknown(state.used)} remaining=${numberOrUnknown(state.remaining)} `
    + `limit=${numberOrUnknown(state.limit)} token=${safeName(token, 'unknown')} `
    + `resource=${safeName(resource, 'core')} reset=${numberOrUnknown(state.reset)}`;
}

function publish(line) {
  process.stdout.write(`${line}\n`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  try {
    appendFileSync(summary, `- ${line}\n`);
  } catch (error) {
    process.stderr.write(`::warning::rate-limit summary non scrivibile: ${error.message}\n`);
  }
}

export function reportRateLimitBudget({
  ghBin = process.env.TRUSTED_GH_BIN || 'gh',
  raw,
  workflow = process.env.RATE_LIMIT_WORKFLOW || process.env.GITHUB_WORKFLOW || 'unknown',
  token = process.env.RATE_LIMIT_TOKEN_NAME || 'unknown',
  resources = process.env.RATE_LIMIT_RESOURCES || 'core',
} = {}) {
  let payload = rateLimitBuckets(raw);
  if (!payload && raw === undefined) {
    try {
      raw = execFileSync(ghBin, ['api', 'rate_limit'], {
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      payload = rateLimitBuckets(raw);
    } catch {
      payload = null;
    }
  }

  const names = String(resources).split(',').map((name) => name.trim()).filter(Boolean);
  const selected = names.length ? names : ['core'];
  for (const resource of selected) {
    publish(formatRateLimitBudget({
      workflow,
      token,
      resource,
      bucket: payload?.[resource],
    }));
  }
  return payload;
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).pathname === new URL(import.meta.url).pathname) {
  reportRateLimitBudget();
}
