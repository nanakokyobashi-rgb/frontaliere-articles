#!/usr/bin/env node

/**
 * Decide whether the redcheck fixer is looking at a review-only failure.
 *
 * This is deliberately a pure predicate over data fetched by the workflow.
 * `Run Claude review=success` is not evidence by itself: that step has
 * `continue-on-error`, so an aborted action can still be reported as success.
 * A review posted by a reviewer bot on the exact HEAD, with a real Important
 * finding, is the stronger signal that the redflag fixer owns the failure.
 */
import { pathToFileURL } from 'node:url';
import {
  CLAUDE_REVIEW_STEP_NAME,
  NON_GATING_REVIEW_STEPS,
  REVIEW_GATE_STEP_NAME,
} from './lib/vitestCheck.mjs';
import {
  REDFLAG_IMPORTANT_RE,
  REVIEWER_BOT_LOGIN_RE,
} from './lib/constants.mjs';

function rowsFromPages(value, key) {
  const pages = Array.isArray(value) ? value : [value];
  return pages.flatMap((page) => {
    if (Array.isArray(page)) return page;
    return Array.isArray(page?.[key]) ? page[key] : [];
  });
}

/**
 * @param {{headSha?: string, jobs?: unknown, reviews?: unknown}} input
 * @returns {boolean}
 */
export function reviewOnlyFailure(input) {
  const headSha = typeof input?.headSha === 'string' ? input.headSha : '';
  if (!headSha) return false;

  const jobs = rowsFromPages(input?.jobs, 'jobs');
  const testsJob = jobs.find((job) => job?.name === 'tests (node --test)');
  const steps = Array.isArray(testsJob?.steps) ? testsJob.steps : [];
  const failures = steps
    .filter((step) => step?.conclusion === 'failure'
      && !NON_GATING_REVIEW_STEPS.has(String(step.name || '')))
    .map((step) => step.name);
  if (failures.length !== 1 || failures[0] !== REVIEW_GATE_STEP_NAME) return false;

  // Keep the topology check, but do not trust this step's conclusion: the
  // action has continue-on-error and can die without posting a review.
  if (!steps.some((step) => step?.name === CLAUDE_REVIEW_STEP_NAME)) return false;

  const reviews = rowsFromPages(input?.reviews, null);
  const lastOnHead = reviews
    .filter((review) =>
      review?.commit_id === headSha
      && review?.user?.type === 'Bot'
      && REVIEWER_BOT_LOGIN_RE.test(review.user.login ?? ''),
    )
    .at(-1);
  if (!lastOnHead) return false;

  // No 🔴 Important means the review can be a no-LGTM/nit-only review with no
  // owner capable of repairing the gate. Leave that case to redcheck.
  return REDFLAG_IMPORTANT_RE.test(lastOnHead.body ?? '');
}

async function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  try {
    process.stdout.write(`${reviewOnlyFailure(JSON.parse(raw))}\n`);
  } catch {
    // An unreadable or incomplete API response must not suppress the fixer.
    process.stdout.write('false\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
