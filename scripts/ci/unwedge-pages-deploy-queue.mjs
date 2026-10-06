/**
 * unwedge-pages-deploy-queue.mjs — free the `publish-api` concurrency group
 * when a publish run is wedged at the `github-pages` environment gate.
 *
 * Adapted twin of the site's scripts/ci/unwedge-pages-deploy-queue.mjs: same
 * selection rule and fail direction, pointed at this repo's publisher
 * (`publish-api.yml`) instead of the site's `deploy-publish.yml`.
 *
 * WHY THIS EXISTS
 *
 * `publish-api.yml` holds the workflow-level `concurrency` group `publish-api`
 * with `cancel-in-progress: false`. That `false` is load-bearing: the same job
 * runs `actions/deploy-pages` and the push of the sitemaps/blog index to the
 * edge, and a half-written data surface is worse than a slightly stale one.
 * The cost of it is that GitHub will never evict the group's holder, however
 * long it holds.
 *
 * The `publish` job declares `environment: github-pages` — mandatory, because
 * actions/deploy-pages binds the Pages deployment to the run through that
 * environment's OIDC identity. A job parked at an environment gate is not
 * "running", so no Actions-side deadline applies to it: not the job's
 * `timeout-minutes: 20`, not the 360-minute default. Measured on
 * nanakokyobashi-rgb/frontaliere-articles run 36762664618:
 *
 *   - `publish` entered `waiting` at 2026-09-30T19:00:51Z and never left it.
 *   - `/actions/runs/36762664618/pending_deployments` → `wait_timer: 0`,
 *     `reviewers: []`, `current_user_can_approve: false`: nothing to approve
 *     and nothing to expire.
 *   - Its github-pages deployment 6767709717 never left state=waiting, while
 *     the deployments right before it cleared the same gate in ~1 s
 *     (6767624510: waiting 18:56:28Z → queued 18:56:29Z; 6767323407: 18:41:18Z
 *     → 18:41:19Z).
 *   - Every later push queued behind it and was evicted by the next arrival:
 *     30+ runs ended `cancelled` without starting a job, and the published
 *     surface stayed at the 18:59Z build.
 *
 * The site measured the same wedge on 2026-08-06 (its run 31118787881, 14 h at
 * the gate with an empty protection-rule list) and ships this reaper for it.
 *
 * WHAT IT CANCELS, AND WHAT IT DELIBERATELY WILL NOT
 *
 * ONLY runs whose status is literally `waiting` — i.e. runs that have not begun
 * executing anything. Never `in_progress`, never `queued`. This is the whole
 * safety argument: a `waiting` run has no half-finished Pages upload or edge
 * push to interrupt. A publish that fails, times out, or dies half-way reaches
 * a terminal conclusion on its own and releases the group without this
 * script's help. Cancelling loses nothing either: the newest pending publish
 * rebuilds the surface from `main`, which carries every earlier commit.
 *
 * The alternative — rejecting the pending deployment via
 * `POST /actions/runs/{id}/pending_deployments` with `state: rejected` — is not
 * usable here: that call requires the caller to be a listed environment
 * reviewer, and the gate reports `reviewers: []` / `current_user_can_approve:
 * false`. Cancelling the run is the only lever available to a workflow token.
 *
 * THRESHOLD
 *
 * A healthy run clears the gate in about a second here (see above), and the
 * whole publish job takes a few minutes. The 45-minute default is the site's
 * value, kept so the two reapers judge the same way; the caller
 * (publish-api-unwedge.yml) runs every 15 minutes, so a wedge is cleared within
 * 45-60 minutes rather than indefinitely.
 *
 * WHAT MUST BE PROVEN BEFORE A CANCEL
 *
 * The run listing only nominates candidates. Each candidate is re-read right
 * before the cancel, and `cancelVerdict()` cancels only when all of these hold
 * on the fresh data:
 *
 *   - the run is still `waiting`: between the listing and the cancel it may
 *     have left the gate and started uploading, and a cancel then would be the
 *     exact interruption `cancel-in-progress: false` exists to prevent;
 *   - it is a run of `main`: the newest pending publish rebuilds `main`, so
 *     cancelling a waiting run of it loses nothing, while a run dispatched from
 *     another ref carries content no later publish reproduces;
 *   - GitHub lists a pending `github-pages` deployment for it: positive
 *     evidence that the environment gate is what holds it, not a runner queue;
 *   - its job parked at the gate (status `waiting`) was created more than the
 *     threshold ago. That job's `created_at` is when the run reached the gate;
 *     the run's own `created_at` is not, because a run can sit queued behind
 *     the concurrency group or for a runner long before the gated job exists.
 *
 * GitHub offers no compare-and-cancel, so a run can still leave the gate in
 * the single round trip between the re-read and the POST; against a 45-minute
 * minimum at the gate that window is the residual risk, and it is accepted.
 *
 * FAIL DIRECTION
 *
 * Fails CLOSED on every decision: anything it cannot positively establish —
 * unreadable timestamp, unexpected status, missing pending deployment, API
 * error — means "do not cancel". The harm of a missed unwedge is one more cycle
 * of a stall that is already visible; the harm of a wrong cancel is destroying
 * a live publish.
 *
 * Fails LOUD on what it could not do: an unreadable or malformed run listing,
 * a candidate it could not re-read, or a cancel GitHub refused all set exit
 * code 1 with an `::error::` annotation, because each of them can leave the
 * `publish-api` group jammed with nothing else reporting it. "Nothing wedged" and
 * "candidate re-read and found healthy" exit 0.
 *
 * Here the step is the only one of publish-api-unwedge.yml, so an exit 1 turns
 * that run red and reaches workflow-failure-issues.yml.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { githubApiHeaders } from '../lib/githubApiHeaders.mjs';

const REPO = process.env.GITHUB_REPOSITORY || 'nanakokyobashi-rgb/frontaliere-articles';
const API = 'https://api.github.com';
// Addressed by filename rather than numeric id so a workflow rename/recreate
// surfaces as a 404 in the log instead of silently reaping nothing forever.
const WORKFLOW_FILE = 'publish-api.yml';
const DEFAULT_WEDGE_MINUTES = 45;
// See WHAT MUST BE PROVEN: only a run of this branch may be reaped.
const PUBLISH_BRANCH = 'main';
const PAGES_ENVIRONMENT = 'github-pages';

// ── Pure logic (unit-tested; NO network/IO) ─────────────────────────

/**
 * First pass over the run listing: the runs worth re-reading.
 *
 * `status === 'waiting'` is checked here and not delegated to the API's
 * `?status=waiting` filter alone: the filter is a convenience, this predicate
 * is the guarantee. If GitHub ever widens what that query returns, an
 * `in_progress` publish must still be untouchable.
 *
 * The run's `created_at` is only a lower bound on how long it can have been at
 * the gate, so a run younger than the threshold is dropped without further
 * calls. The gate-entry time that decides comes from the jobs, in
 * `cancelVerdict()`.
 *
 * @param {Array<{status?: string, head_branch?: string, created_at?: string, id?: number}>} runs
 * @param {{ nowMs: number, thresholdMinutes?: number, branch?: string }} opts
 * @returns {Array<object>} candidate runs (possibly empty)
 */
export function selectWedgedRuns(runs, { nowMs, thresholdMinutes = DEFAULT_WEDGE_MINUTES, branch = PUBLISH_BRANCH } = {}) {
  if (!Array.isArray(runs)) return [];
  return runs.filter((run) => {
    // Anything that is executing, queued, or already finished is off limits.
    if (run?.status !== 'waiting') return false;
    if (run.head_branch !== branch) return false;
    const createdMs = Date.parse(run.created_at ?? '');
    // Unparseable timestamp → we cannot bound the age → do not cancel.
    if (!Number.isFinite(createdMs)) return false;
    return nowMs - createdMs > thresholdMinutes * 60_000;
  });
}

/**
 * When the run reached the environment gate: the `created_at` of its job parked
 * there (status `waiting`). With several waiting jobs the LATEST entry counts.
 * No waiting job, or an unreadable timestamp on one of them → NaN.
 *
 * @param {Array<{status?: string, created_at?: string}>} jobs
 * @returns {number} epoch ms, or NaN when it cannot be established
 */
export function gateEntryMs(jobs) {
  if (!Array.isArray(jobs)) return NaN;
  let latest = NaN;
  for (const job of jobs) {
    if (job?.status !== 'waiting') continue;
    const ms = Date.parse(job.created_at ?? '');
    if (!Number.isFinite(ms)) return NaN;
    if (!Number.isFinite(latest) || ms > latest) latest = ms;
  }
  return latest;
}

/**
 * @param {Array<{environment?: {name?: string}}>} pendingDeployments
 * @returns {boolean} true when GitHub reports a pending github-pages deployment
 */
export function parkedAtPagesGate(pendingDeployments) {
  return Array.isArray(pendingDeployments)
    && pendingDeployments.some((p) => p?.environment?.name === PAGES_ENVIRONMENT);
}

/**
 * @param {number} enteredMs gate entry (see gateEntryMs)
 * @param {number} nowMs
 * @returns {number} whole minutes parked at the gate (0 when unknown)
 */
export function wedgeAgeMinutes(enteredMs, nowMs) {
  if (!Number.isFinite(enteredMs)) return 0;
  return Math.round((nowMs - enteredMs) / 60_000);
}

/**
 * Final decision on ONE run, from data re-read right before the cancel. Every
 * condition in WHAT MUST BE PROVEN has to hold; anything else is "do not
 * cancel", with the reason for the log.
 *
 * @returns {{ cancel: boolean, reason: string, ageMinutes: number }}
 */
export function cancelVerdict({
  run,
  jobs,
  pendingDeployments,
  nowMs,
  thresholdMinutes = DEFAULT_WEDGE_MINUTES,
  branch = PUBLISH_BRANCH,
} = {}) {
  const keep = (reason, ageMinutes = 0) => ({ cancel: false, reason, ageMinutes });
  if (run?.status !== 'waiting') return keep(`status is now ${run?.status ?? 'unknown'}`);
  if (run.head_branch !== branch) return keep(`head_branch ${run.head_branch ?? 'unknown'} is not ${branch}`);
  if (!parkedAtPagesGate(pendingDeployments)) return keep(`no pending ${PAGES_ENVIRONMENT} deployment`);
  const enteredMs = gateEntryMs(jobs);
  if (!Number.isFinite(enteredMs)) return keep('no waiting job with a readable created_at');
  const ageMinutes = wedgeAgeMinutes(enteredMs, nowMs);
  if (nowMs - enteredMs <= thresholdMinutes * 60_000) {
    return keep(`at the gate for ${ageMinutes} min, within the ${thresholdMinutes}-min threshold`, ageMinutes);
  }
  return { cancel: true, reason: `parked at the ${PAGES_ENVIRONMENT} environment gate for ${ageMinutes} min`, ageMinutes };
}

// ── Network (not unit-tested; exercised live) ───────────────────────

function authToken() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN required');
  return token;
}

async function ghJson(urlPath) {
  const res = await fetch(`${API}${urlPath}`, { headers: githubApiHeaders(authToken()) });
  if (!res.ok) throw new Error(`GitHub API ${urlPath} → HTTP ${res.status}`);
  return res.json();
}

/** @returns {Promise<boolean>} true when GitHub accepted the cancellation */
async function cancelRun(runId) {
  const res = await fetch(`${API}/repos/${REPO}/actions/runs/${runId}/cancel`, {
    method: 'POST',
    headers: githubApiHeaders(authToken()),
  });
  // 202 Accepted is the documented success. 409 means the run already reached a
  // terminal state between the re-read and the cancel — the group is free
  // either way, which is the outcome we wanted.
  if (res.status === 202) return true;
  if (res.status === 409) {
    console.log(`  run ${runId}: already terminal (409) — group is free anyway`);
    return true;
  }
  return false;
}

/** Fresh run, jobs and pending deployments of one candidate, read together. */
async function rereadCandidate(runId) {
  const [run, jobsBody, pendingDeployments] = await Promise.all([
    ghJson(`/repos/${REPO}/actions/runs/${runId}`),
    ghJson(`/repos/${REPO}/actions/runs/${runId}/jobs?filter=latest&per_page=100`),
    ghJson(`/repos/${REPO}/actions/runs/${runId}/pending_deployments`),
  ]);
  if (!Array.isArray(jobsBody?.jobs)) throw new Error('jobs response has no jobs array');
  if (!Array.isArray(pendingDeployments)) throw new Error('pending_deployments response is not an array');
  return { run, jobs: jobsBody.jobs, pendingDeployments };
}

// ── Orchestration ───────────────────────────────────────────────────

async function main() {
  const parsed = Number(process.env.WEDGE_MINUTES);
  const thresholdMinutes = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WEDGE_MINUTES;

  console.log('── publish-api queue unwedge ──');

  let runs;
  try {
    const body = await ghJson(
      `/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?status=waiting&per_page=50`,
    );
    if (!Array.isArray(body?.workflow_runs)) throw new Error('response has no workflow_runs array');
    runs = body.workflow_runs;
  } catch (err) {
    // Nothing is cancelled, but an unreadable queue may be hiding the very
    // wedge this exists for: say so and exit 1.
    console.log(`::error::Could not read ${WORKFLOW_FILE} runs: ${err.message} — not cancelling anything`);
    process.exitCode = 1;
    return;
  }

  const candidates = selectWedgedRuns(runs, { nowMs: Date.now(), thresholdMinutes });
  console.log(`Runs in status=waiting: ${runs.length} (threshold ${thresholdMinutes} min)`);

  if (candidates.length === 0) {
    // The common case, including "a run entered the gate a minute ago".
    console.log('✅ Nothing wedged past the threshold — publish-api is not blocked by a stuck gate.');
    return;
  }

  const failures = [];
  let cancelled = 0;
  for (const listed of candidates) {
    let fresh;
    try {
      fresh = await rereadCandidate(listed.id);
    } catch (err) {
      failures.push(`run ${listed.id}: could not re-read it (${err.message})`);
      continue;
    }
    const verdict = cancelVerdict({ ...fresh, nowMs: Date.now(), thresholdMinutes });
    if (!verdict.cancel) {
      console.log(`  run ${listed.id}: left alone — ${verdict.reason}`);
      continue;
    }
    console.log(
      `::warning::Run ${fresh.run.id} (${fresh.run.head_sha?.slice(0, 8) ?? '?'}) has been ${verdict.reason} — cancelling to release the publish-api group.`,
    );
    if (await cancelRun(fresh.run.id)) cancelled += 1;
    else failures.push(`run ${fresh.run.id}: GitHub refused the cancel`);
  }

  // The next queued publish starting is the real signal that the surface is
  // moving again.
  console.log(`Cancelled ${cancelled} wedged run(s).`);
  if (failures.length > 0) {
    console.log(`::error::The publish-api queue may still be jammed: ${failures.join('; ')}`);
    process.exitCode = 1;
  }
}

const invokedDirectly = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] || '');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    // ::error:: rather than a silent exit: the annotation names the crash in
    // the run that workflow-failure-issues.yml will report.
    console.log(`::error::[unwedge-pages-deploy-queue] Fatal: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
