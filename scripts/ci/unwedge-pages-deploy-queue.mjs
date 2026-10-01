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
 * FAIL DIRECTION
 *
 * Fails CLOSED: anything it cannot positively establish — unreadable
 * timestamp, unexpected status, API error — means "do not cancel". The harm of
 * a missed unwedge is fifteen more minutes of a stall that is already visible;
 * the harm of a wrong cancel is destroying a live publish.
 *
 * Exit code: 0 on every expected path, including "nothing wedged" and API
 * errors. Non-zero only on an unexpected crash, which turns the caller's run
 * red and therefore reaches workflow-failure-issues.yml.
 */

import { pathToFileURL } from 'node:url';
import { githubApiHeaders } from '../lib/githubApiHeaders.mjs';

const REPO = process.env.GITHUB_REPOSITORY || 'nanakokyobashi-rgb/frontaliere-articles';
const API = 'https://api.github.com';
// Addressed by filename rather than numeric id so a workflow rename/recreate
// surfaces as a 404 in the log instead of silently reaping nothing forever.
const WORKFLOW_FILE = 'publish-api.yml';
const DEFAULT_WEDGE_MINUTES = 45;

// ── Pure logic (unit-tested; NO network/IO) ─────────────────────────

/**
 * Pick the runs that are wedged at an environment gate and safe to cancel.
 *
 * `status === 'waiting'` is checked here and not delegated to the API's
 * `?status=waiting` filter alone: the filter is a convenience, this predicate
 * is the guarantee. If GitHub ever widens what that query returns, an
 * `in_progress` publish must still be untouchable.
 *
 * @param {Array<{status?: string, created_at?: string, id?: number}>} runs
 * @param {{ nowMs: number, thresholdMinutes?: number }} opts
 * @returns {Array<object>} runs to cancel (possibly empty)
 */
export function selectWedgedRuns(runs, { nowMs, thresholdMinutes = DEFAULT_WEDGE_MINUTES } = {}) {
  if (!Array.isArray(runs)) return [];
  return runs.filter((run) => {
    // Anything that is executing, queued, or already finished is off limits.
    if (run?.status !== 'waiting') return false;
    // `created_at` is when the run entered the gate: the push-driven publish
    // gates its only job immediately (run 36762664618: created 19:00:49Z,
    // deployment waiting 19:00:51Z), and a waiting job never advances either
    // field afterwards.
    const enteredMs = Date.parse(run.created_at ?? '');
    // Unparseable timestamp → we cannot prove the age → do not cancel.
    if (!Number.isFinite(enteredMs)) return false;
    return nowMs - enteredMs > thresholdMinutes * 60_000;
  });
}

/**
 * @param {object} run
 * @param {number} nowMs
 * @returns {number} whole minutes the run has been parked at the gate
 */
export function wedgeAgeMinutes(run, nowMs) {
  const enteredMs = Date.parse(run?.created_at ?? '');
  if (!Number.isFinite(enteredMs)) return 0;
  return Math.round((nowMs - enteredMs) / 60_000);
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
  // terminal state between the list and the cancel — the group is free either
  // way, which is the outcome we wanted.
  if (res.status === 202) return true;
  if (res.status === 409) {
    console.log(`  run ${runId}: already terminal (409) — group is free anyway`);
    return true;
  }
  console.log(`::warning::Could not cancel run ${runId} — HTTP ${res.status}`);
  return false;
}

// ── Orchestration ───────────────────────────────────────────────────

async function main() {
  const parsed = Number(process.env.WEDGE_MINUTES);
  const thresholdMinutes = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WEDGE_MINUTES;

  let runs;
  try {
    const body = await ghJson(
      `/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?status=waiting&per_page=50`,
    );
    runs = body.workflow_runs || [];
  } catch (err) {
    // Fail closed: an unreadable queue is not evidence of a wedge.
    console.log(`⚠️ Could not read ${WORKFLOW_FILE} runs: ${err.message} — not cancelling anything`);
    process.exit(0);
  }

  const nowMs = Date.now();
  const wedged = selectWedgedRuns(runs, { nowMs, thresholdMinutes });

  console.log('── publish-api queue unwedge ──');
  console.log(`Runs in status=waiting: ${runs.length} (threshold ${thresholdMinutes} min)`);

  if (wedged.length === 0) {
    // The common case, including "a run entered the gate a minute ago".
    console.log('✅ Nothing wedged past the threshold — publish-api is not blocked by a stuck gate.');
    process.exit(0);
  }

  for (const run of wedged) {
    const age = wedgeAgeMinutes(run, nowMs);
    console.log(
      `::warning::Run ${run.id} (${run.head_sha?.slice(0, 8) ?? '?'}) has been parked at the github-pages environment gate for ${age} min — cancelling to release the publish-api group.`,
    );
    await cancelRun(run.id);
  }

  // Never fails the caller: the next queued publish starting is the real
  // signal that the surface is moving again.
  console.log(`Cancelled ${wedged.length} wedged run(s). The newest pending publish can now acquire the group.`);
  process.exit(0);
}

const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (invokedDirectly) {
  main().catch((err) => {
    // ::error:: rather than a silent exit: the annotation names the crash in
    // the run that workflow-failure-issues.yml will report.
    console.log(`::error::[unwedge-pages-deploy-queue] Fatal: ${err.stack || err.message}`);
    process.exit(1);
  });
}
