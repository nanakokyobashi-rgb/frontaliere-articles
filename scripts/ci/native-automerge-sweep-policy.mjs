/**
 * Pure policy shared by the scheduled enrollment sweep and the lockstep
 * safety gate.
 *
 * The sweep itself must hand every eligible PR to native-automerge-gate.mjs;
 * this module only validates the paginated listing before that hand-off and
 * provides the small, fail-closed check-state decision used by the lockstep
 * workflow. Keeping both decisions pure makes malformed API responses
 * executable test fixtures instead of static YAML assertions.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { VITEST_CHECK_NAME } from './lib/constants.mjs';

export const LOCKSTEP_HEAD_REF = 'engine-lockstep-auto';
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;
const REPOSITORY_RE = /^[^/]+\/[^/]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function deny(reason) {
  return { allow: false, reason };
}

/**
 * Select exactly the trusted lockstep PR from either `gh pr list` (array) or
 * the immediate pre-merge `gh pr view` (single object). A branch name alone
 * is not an identity: a fork can publish the same ref, and a PR to another
 * base must never be accepted by this corpus merge workflow.
 *
 * @param {unknown} payload list/object returned by gh
 * @param {string} repository expected base repository `owner/name`
 * @param {string|number|null} expectedNumber optional PR number to revalidate
 * @param {string|null} expectedHead optional frozen HEAD SHA to revalidate
 */
export function lockstepPullRequestDecision(
  payload,
  repository,
  expectedNumber = null,
  expectedHead = null,
) {
  const isList = Array.isArray(payload);
  if (!isList && (expectedNumber === null || expectedNumber === undefined
      || !payload || typeof payload !== 'object')) {
    return deny('payload PR lockstep non verificabile');
  }
  const candidates = isList ? payload : [payload];
  if (candidates.length !== 1) {
    return deny(`candidati PR lockstep ambigui (${candidates.length})`);
  }
  if (typeof repository !== 'string' || !/^[^/]+\/[^/]+$/.test(repository)) {
    return deny('repository PR lockstep non verificabile');
  }

  const pr = candidates[0];
  if (!pr || typeof pr !== 'object' || Array.isArray(pr)
      || !Number.isSafeInteger(pr.number) || pr.number <= 0
      || typeof pr.state !== 'string' || pr.state.toUpperCase() !== 'OPEN'
      || pr.baseRefName !== 'main'
      || pr.headRefName !== LOCKSTEP_HEAD_REF
      || !pr.headRepository || typeof pr.headRepository !== 'object'
      || Array.isArray(pr.headRepository)
      || pr.headRepository.nameWithOwner !== repository) {
    return deny('metadata PR lockstep non autorizzata o incompleta');
  }

  if (expectedNumber !== null && expectedNumber !== undefined) {
    const number = typeof expectedNumber === 'number'
      ? expectedNumber
      : /^\d+$/.test(String(expectedNumber)) ? Number(expectedNumber) : NaN;
    if (!Number.isSafeInteger(number) || number !== pr.number) {
      return deny('numero PR lockstep cambiato o non verificabile');
    }
  }
  if (expectedHead !== null && expectedHead !== undefined) {
    if (!COMMIT_SHA_RE.test(typeof expectedHead === 'string' ? expectedHead : '')
        || pr.headRefOid !== expectedHead) {
      return deny('HEAD PR lockstep cambiata o non verificabile');
    }
  }
  return { allow: true, number: pr.number, reason: `PR lockstep #${pr.number} autorizzata` };
}

/**
 * Validate and select PR numbers from the exact shape returned by
 * `gh api --paginate --slurp`. Missing shape fields are not treated as
 * harmless defaults: an incomplete response must never enlarge the merge
 * candidate set.
 */
export function enrollablePullRequestNumbers(pages) {
  if (!Array.isArray(pages)) {
    throw new TypeError('payload REST paginato non è un array di pagine');
  }

  const numbers = [];
  const seen = new Set();
  for (const [pageIndex, page] of pages.entries()) {
    if (!Array.isArray(page)) {
      throw new TypeError(`pagina REST ${pageIndex} non è un array`);
    }
    for (const [entryIndex, pr] of page.entries()) {
      if (!pr || typeof pr !== 'object' || Array.isArray(pr)
          || !Number.isSafeInteger(pr.number) || pr.number <= 0
          || typeof pr.draft !== 'boolean'
          || !Object.hasOwn(pr, 'auto_merge')
          || !pr.base || typeof pr.base.ref !== 'string'
          || !pr.head || typeof pr.head.ref !== 'string') {
        throw new TypeError(`elemento PR REST non verificabile (${pageIndex}:${entryIndex})`);
      }

      // The native helper repeats these checks from a fresh PR read. These
      // filters keep the sweep from even attempting unrelated/non-main PRs;
      // the final decision, including current HEAD binding, remains there.
      if (pr.draft === false
          && pr.auto_merge === null
          && pr.base.ref === 'main'
          && pr.head.ref !== LOCKSTEP_HEAD_REF
          && !seen.has(pr.number)) {
        numbers.push(pr.number);
        seen.add(pr.number);
      }
    }
  }
  return numbers;
}

/**
 * Decide the required-only snapshot from gh pr checks --required.
 *
 * Every item in this snapshot is required, so all checks must be SUCCESS and
 * the named primary check must occur exactly once. The complete snapshot is
 * evaluated separately by allChecksDecision because it does not expose which
 * checks are required by branch protection.
 */
export function requiredCheckDecision(checks, requiredName = VITEST_CHECK_NAME) {
  if (!Array.isArray(checks)) return deny('check payload non è un array');
  if (checks.length === 0) return deny('nessun check riportato');
  if (typeof requiredName !== 'string' || !requiredName) {
    return deny('nome del check principale non verificabile');
  }

  const normalized = checks.map((check) => ({
    name: typeof check?.name === 'string' ? check.name : '',
    state: typeof check?.state === 'string'
      ? check.state.trim().toUpperCase()
      : '',
  }));
  const malformed = normalized.find((check) => !check.name || !check.state);
  if (malformed) return deny('check con nome/stato non verificabile');

  const required = normalized.filter((check) => check.name === requiredName);
  if (required.length === 0) return deny(`check principale ${requiredName} assente`);
  if (required.length !== 1) return deny(`check principale ${requiredName} ambiguo`);
  if (required[0].state !== 'SUCCESS') {
    return deny(`check principale ${requiredName} state=${required[0].state}`);
  }

  // This snapshot comes from the required-only query: every returned item is
  // required, so a secondary required check in SKIPPED/NEUTRAL is not optional.
  const nonGreenRequired = normalized.find((check) => check.state !== 'SUCCESS');
  if (nonGreenRequired) {
    return deny('check required ' + nonGreenRequired.name
      + ' state=' + nonGreenRequired.state);
  }

  return { allow: true, reason: 'check required ' + requiredName + ' SUCCESS' };
}

// Evaluate the complete check snapshot. The required-only snapshot is checked
// separately because this payload does not identify branch-protection status.
export function allChecksDecision(checks, requiredName = VITEST_CHECK_NAME) {
  if (!Array.isArray(checks)) return deny('check payload non è un array');
  if (checks.length === 0) return deny('nessun check riportato');
  if (typeof requiredName !== 'string' || !requiredName) {
    return deny('nome del check principale non verificabile');
  }

  const normalized = checks.map((check) => ({
    name: typeof check?.name === 'string' ? check.name : '',
    state: typeof check?.state === 'string'
      ? check.state.trim().toUpperCase()
      : '',
  }));
  if (normalized.some((check) => !check.name || !check.state)) {
    return deny('check con nome/stato non verificabile');
  }

  const required = normalized.filter((check) => check.name === requiredName);
  if (required.length === 0) return deny('check principale ' + requiredName + ' assente');
  if (required.length !== 1) return deny('check principale ' + requiredName + ' ambiguo');
  if (required[0].state !== 'SUCCESS') {
    return deny('check principale ' + requiredName + ' state=' + required[0].state);
  }

  const safeOptionalStates = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);
  const veto = normalized.find((check) => check.name !== requiredName
    && !safeOptionalStates.has(check.state));
  if (veto) return deny('check non principale ' + veto.name + ' state=' + veto.state);
  return { allow: true, reason: 'check principale ' + requiredName + ' SUCCESS' };
}

function checkRunState(run) {
  const status = run.status.trim().toUpperCase();
  if (status === 'COMPLETED') {
    return typeof run.conclusion === 'string' && run.conclusion.trim()
      ? run.conclusion.trim().toUpperCase() : '';
  }
  return status;
}

function workflowRunIdentity(detailsUrl, repository) {
  if (typeof detailsUrl !== 'string' || !REPOSITORY_RE.test(repository || '')) return null;
  let url;
  try {
    url = new URL(detailsUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 7 || `${parts[0]}/${parts[1]}` !== repository
      || parts[2] !== 'actions' || parts[3] !== 'runs' || parts[5] !== 'job'
      || !/^[1-9]\d*$/.test(parts[4]) || !/^[1-9]\d*$/.test(parts[6])) {
    return null;
  }
  return { workflowRunId: parts[4], jobId: parts[6] };
}

function compareDecimalIds(left, right) {
  const a = String(left).replace(/^0+(?=\d)/, '');
  const b = String(right).replace(/^0+(?=\d)/, '');
  if (a.length !== b.length) return a.length > b.length ? 1 : -1;
  if (a === b) return 0;
  return a > b ? 1 : -1;
}

function checkRunGeneration(run, repository) {
  // `completed_at` describes when a runner happened to finish, not which
  // rerun is the current generation. The check-runs REST payload has no
  // top-level generation stamp on every API shape: use an explicit
  // `created_at`, or correlate the authoritative workflow-run/job URL.
  // `started_at`/`run_started_at` are deliberately NOT fallbacks: a delayed
  // queued runner can start after a newer rerun and would recreate the ABA
  // bug this snapshot is meant to close.
  let createdAt;
  let generationId = run.id;
  let source = 'timestamp';
  const suite = run.check_suite;
  if (suite !== undefined) {
    if (!suite || typeof suite !== 'object' || Array.isArray(suite)
        || !Number.isSafeInteger(suite.id) || suite.id <= 0) {
      return null;
    }
    if (Object.hasOwn(suite, 'head_sha')) {
      if (typeof suite.head_sha !== 'string'
          || !COMMIT_SHA_RE.test(suite.head_sha)
          || suite.head_sha.toLowerCase() !== run.head_sha.toLowerCase()) {
        return null;
      }
    }
    // Some endpoints include suite.created_at while the commit/check-runs
    // response observed in production does not. Validate it when supplied,
    // but never require or order by it: the workflow-run URL is the source
    // of generation identity for the timestamp-less shape.
    if (Object.hasOwn(suite, 'created_at') && suite.created_at !== null
        && (typeof suite.created_at !== 'string'
          || !Number.isFinite(Date.parse(suite.created_at)))) {
      return null;
    }
  }
  if (Object.hasOwn(run, 'created_at') && run.created_at !== null) {
    if (typeof run.created_at !== 'string') return null;
    createdAt = Date.parse(run.created_at);
    if (!Number.isFinite(createdAt)) return null;
  }

  // `run_attempt` is not present on every check-run API shape. When present,
  // it is authoritative for same-timestamp reruns and must be a real attempt;
  // a malformed present value is not silently downgraded to the id fallback.
  let runAttempt = 0;
  if (Object.hasOwn(run, 'run_attempt')) {
    if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) return null;
    runAttempt = run.run_attempt;
  }
  if (!Number.isFinite(createdAt)) {
    // The Check Run REST response's nested `check_suite` example contains an
    // id but not suite timestamps. Its Actions details URL is the authoritative
    // workflow-run/job correlation available in this response; without that
    // identity, selection would be a guess and must remain fail-closed.
    if (suite === undefined) return null;
    const workflow = workflowRunIdentity(run.details_url, repository);
    if (!workflow) return null;
    if (typeof run.external_id !== 'string' || !UUID_RE.test(run.external_id.trim())) {
      return null;
    }
    source = 'workflow-run';
    // `workflowRunId` proves which Actions run the URL belongs to; the
    // check-run id is the generation order/tie-break within that run.
    return { source, createdAt: null, runAttempt, generationId: run.id, ...workflow };
  }
  return { source, createdAt, runAttempt, generationId };
}

function checkRunVerdictMetadata(run) {
  if (run.status.trim().toUpperCase() !== 'COMPLETED') return true;
  return typeof run.conclusion === 'string'
    && run.conclusion.trim()
    && Number.isFinite(Date.parse(typeof run.completed_at === 'string' ? run.completed_at : ''));
}

function checkRunBucket(state) {
  if (state === 'SUCCESS') return 'pass';
  if (state === 'SKIPPED' || state === 'NEUTRAL') return 'skipping';
  if (['QUEUED', 'IN_PROGRESS', 'REQUESTED', 'WAITING', 'PENDING'].includes(state)) {
    return 'pending';
  }
  return 'fail';
}

/**
 * Flatten the exact commit/check-runs response and select the latest run per
 * check name. The endpoint is commit-pinned, but every run is still required
 * to repeat that SHA: a mixed or malformed response is never a verdict. The
 * latest generation is selected by creation timestamp, or by validated
 * workflow-run/check-run identity when the REST shape has no timestamp. For
 * the latter, the numeric workflow-run id is the generation and the
 * check-run id is the tie-break within that workflow run; completion order
 * is deliberately not a generation signal because an old runner can finish
 * after a newer rerun.
 *
 * @param {unknown} pages result of `gh api --paginate --slurp` on check-runs
 * @param {string} headSha frozen PR HEAD
 * @returns {{allow: boolean, reason: string, checks?: Array<object>}}
 */
export function exactCheckRunSnapshot(pages, headSha, repository = null) {
  if (!COMMIT_SHA_RE.test(typeof headSha === 'string' ? headSha : '')) {
    return deny('HEAD SHA non verificabile per i check-run');
  }
  if (!Array.isArray(pages) || pages.length === 0) {
    return deny('payload check-run paginato non è un array non vuoto');
  }

  const latest = new Map();
  const seenIds = new Set();
  for (const [pageIndex, page] of pages.entries()) {
    if (!page || typeof page !== 'object' || Array.isArray(page)
        || !Array.isArray(page.check_runs)) {
      return deny(`pagina check-run ${pageIndex} non verificabile`);
    }
    for (const [runIndex, run] of page.check_runs.entries()) {
      if (!run || typeof run !== 'object' || Array.isArray(run)
          || !Number.isSafeInteger(run.id) || run.id <= 0
          || typeof run.name !== 'string' || !run.name
          || typeof run.head_sha !== 'string' || !COMMIT_SHA_RE.test(run.head_sha)
          || run.head_sha.toLowerCase() !== headSha.toLowerCase()
          || typeof run.status !== 'string' || !run.status.trim()) {
        return deny(`check-run ${pageIndex}:${runIndex} non verificabile o fuori HEAD`);
      }
      if (seenIds.has(run.id)) return deny(`check-run ${run.id} duplicato nel payload paginato`);
      seenIds.add(run.id);
      const state = checkRunState(run);
      const generation = checkRunGeneration(run, repository);
      if (!state || !generation || !checkRunVerdictMetadata(run)) {
        return deny(`check-run ${run.name} senza generazione/stato verificabile`);
      }
      const candidate = {
        name: run.name,
        state,
        bucket: checkRunBucket(state),
        id: run.id,
        ...generation,
      };
      const previous = latest.get(run.name);
      if (previous && candidate.source !== previous.source) {
        return deny(`check-run ${run.name} con generazioni non correlabili`);
      }
      let newer = !previous;
      if (previous) {
        if (candidate.source === 'timestamp') {
          newer = candidate.createdAt > previous.createdAt
            || (candidate.createdAt === previous.createdAt
              && (candidate.runAttempt > previous.runAttempt
                || (candidate.runAttempt === previous.runAttempt
                  && candidate.generationId > previous.generationId)));
        } else {
          const workflowOrder = compareDecimalIds(
            candidate.workflowRunId,
            previous.workflowRunId,
          );
          newer = workflowOrder > 0
            || (workflowOrder === 0 && candidate.id > previous.id);
        }
      }
      if (newer) {
        latest.set(run.name, candidate);
      }
    }
  }
  if (latest.size === 0) return deny('nessun check-run sulla HEAD verificata');
  return {
    allow: true,
    reason: `check-run sulla HEAD ${headSha} verificati`,
    checks: [...latest.values()].map(({ name, state, bucket }) => ({ name, state, bucket })),
  };
}

function requiredCheckNames(payload) {
  if (!Array.isArray(payload) || payload.length === 0) {
    return deny('payload dei nomi required non è un array non vuoto');
  }
  const names = [];
  const seen = new Set();
  for (const [index, item] of payload.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
        || typeof item.name !== 'string' || !item.name || seen.has(item.name)) {
      return deny(`nome required ${index} non verificabile o duplicato`);
    }
    seen.add(item.name);
    names.push(item.name);
  }
  return { allow: true, names };
}

function commitCheckDecision(mode, pages, requiredNames, headSha, requiredName, repository) {
  const snapshot = exactCheckRunSnapshot(pages, headSha, repository);
  if (!snapshot.allow) return snapshot;
  const names = requiredCheckNames(requiredNames);
  if (!names.allow) return names;
  const requiredSet = new Set(names.names);
  const missing = names.names.find((name) => !snapshot.checks.some((check) => check.name === name));
  if (missing) return deny(`check required ${missing} assente sulla HEAD ${headSha}`);
  if (mode === 'required') {
    return requiredCheckDecision(
      snapshot.checks.filter((check) => requiredSet.has(check.name)),
      requiredName,
    );
  }
  if (mode === 'all') return allChecksDecision(snapshot.checks, requiredName);
  return deny('modalità check-run sconosciuta');
}

export function requiredCheckRunsDecision(
  pages,
  requiredNames,
  headSha,
  requiredName = VITEST_CHECK_NAME,
  repository = null,
) {
  return commitCheckDecision('required', pages, requiredNames, headSha, requiredName, repository);
}

export function allCheckRunsDecision(
  pages,
  requiredNames,
  headSha,
  requiredName = VITEST_CHECK_NAME,
  repository = null,
) {
  return commitCheckDecision('all', pages, requiredNames, headSha, requiredName, repository);
}

function readJson(file) {
  if (!file) throw new Error('file JSON mancante');
  return JSON.parse(readFileSync(resolve(file), 'utf8'));
}

function main() {
  const [mode, file, requiredFile, headSha, contextArg] = process.argv.slice(2);
  const payload = readJson(file);
  if (mode === '--enroll') {
    const numbers = enrollablePullRequestNumbers(payload);
    if (numbers.length > 0) process.stdout.write(`${numbers.join('\n')}\n`);
    return;
  }
  if (mode === '--lockstep-pr') {
    const decision = lockstepPullRequestDecision(payload, requiredFile, headSha, contextArg);
    if (!decision.allow) {
      console.error(decision.reason);
      process.exitCode = 1;
      return;
    }
    console.log(decision.number);
    return;
  }
  if (mode === '--all-checks') {
    const decision = allChecksDecision(payload);
    if (!decision.allow) {
      console.error(decision.reason);
      process.exitCode = 1;
      return;
    }
    console.log(decision.reason);
    return;
  }
  if (mode === '--required-check') {
    const decision = requiredCheckDecision(payload);
    if (!decision.allow) {
      console.error(decision.reason);
      process.exitCode = 1;
      return;
    }
    console.log(decision.reason);
    return;
  }
  if (mode === '--required-check-runs' || mode === '--all-check-runs') {
    const required = readJson(requiredFile);
    const decision = mode === '--required-check-runs'
      ? requiredCheckRunsDecision(payload, required, headSha, VITEST_CHECK_NAME, contextArg)
      : allCheckRunsDecision(payload, required, headSha, VITEST_CHECK_NAME, contextArg);
    if (!decision.allow) {
      console.error(decision.reason);
      process.exitCode = 1;
      return;
    }
    console.log(decision.reason);
    return;
  }
  throw new Error(`modalità sconosciuta: ${mode || '<none>'}`);
}

const isDirectRun = (() => {
  try {
    return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) main();
