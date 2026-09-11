#!/usr/bin/env node

/**
 * Decide whether the redcheck fixer is looking at a review-only failure.
 *
 * This is deliberately a pure predicate over data fetched by the workflow.
 * `Run Claude review=success` is not evidence by itself: that step has
 * `continue-on-error`, so an aborted action can still be reported as success.
 * A review posted by a reviewer bot on the exact HEAD, with a real Important
 * finding, is the stronger signal that the redflag fixer owns the failure.
 * An explicit transient-review abort is also distinguishable from a code
 * failure, but it is not assigned to either fixer: redcheck must not spend a
 * repair round when there is no code diagnosis to apply.
 */
import { pathToFileURL } from 'node:url';
import {
  CLAUDE_REVIEW_STEP_NAME,
  NON_GATING_REVIEW_STEPS,
  REVIEW_ABORT_STEP_NAME,
  REVIEW_DEATH_STEP_NAMES,
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
 * @returns {'important'|'transient'|''}
 */
export function reviewFailureKind(input) {
  const headSha = typeof input?.headSha === 'string' ? input.headSha : '';
  if (!headSha) return '';

  const jobs = rowsFromPages(input?.jobs, 'jobs');
  const testsJob = jobs.find((job) => job?.name === 'tests (node --test)');
  const steps = Array.isArray(testsJob?.steps) ? testsJob.steps : [];
  const failedSteps = steps
    .filter((step) => step?.conclusion === 'failure')
    .map((step) => String(step.name || ''));
  const codeFailures = failedSteps.filter((name) =>
    name !== REVIEW_GATE_STEP_NAME
    && !NON_GATING_REVIEW_STEPS.has(name)
    && !REVIEW_DEATH_STEP_NAMES.has(name));
  if (codeFailures.length > 0) return '';

  const gateFailed = failedSteps.includes(REVIEW_GATE_STEP_NAME);
  const reviewAborted = failedSteps.includes(REVIEW_ABORT_STEP_NAME);

  // A gate verdict with a real Important finding belongs to redflag-fixer.
  // Keep this branch fail-closed: the review must be present on the exact HEAD
  // and must contain the finding, not merely have a failed review step.
  if (gateFailed) {
    // Keep the topology check, but do not trust this step's conclusion: the
    // action has continue-on-error and can die without posting a review.
    if (!steps.some((step) => step?.name === CLAUDE_REVIEW_STEP_NAME)) return '';

    const reviews = rowsFromPages(input?.reviews, null);
    const lastOnHead = reviews
      .filter((review) =>
        review?.commit_id === headSha
        && review?.user?.type === 'Bot'
        && REVIEWER_BOT_LOGIN_RE.test(review.user.login ?? ''),
      )
      .at(-1);
    // The transient-abort step and the gate can both be red: the gate is an
    // `always()` consumer of the review result, so it fails after an aborted
    // action even though there is no verdict to repair. Keep that explicit
    // signal, but only after giving a real Important finding precedence.
    if (!lastOnHead) return reviewAborted ? 'transient' : '';

    // No 🔴 Important means the review can be a no-LGTM/nit-only review with
    // no owner capable of repairing the gate. Leave that case to redcheck.
    if (REDFLAG_IMPORTANT_RE.test(lastOnHead.body ?? '')) return 'important';
  }

  // The action explicitly reported a transient failure and no code step is
  // red. There is no safe patch for redcheck to derive, so avoid a pointless
  // Claude round. A gate failure without an Important review is transient only
  // when the same run also reports the explicit abort; otherwise it stays
  // fail-closed because it may be a real missing/ambiguous verdict.
  if (reviewAborted) return 'transient';
  return '';
}

/**
 * Backward-compatible boolean API for callers that only own Important review
 * findings.
 *
 * @param {{headSha?: string, jobs?: unknown, reviews?: unknown}} input
 * @returns {boolean}
 */
export function reviewOnlyFailure(input) {
  return reviewFailureKind(input) === 'important';
}

async function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  try {
    const kind = reviewFailureKind(JSON.parse(raw));
    process.stdout.write(process.argv.includes('--kind') ? `${kind || 'none'}\n` : `${kind === 'important'}\n`);
  } catch {
    // An unreadable or incomplete API response must not suppress the fixer.
    process.stdout.write(process.argv.includes('--kind') ? 'none\n' : 'false\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
