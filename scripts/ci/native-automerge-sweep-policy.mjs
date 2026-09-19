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

function deny(reason) {
  return { allow: false, reason };
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

const COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;

function checkRunState(run) {
  const status = run.status.trim().toUpperCase();
  if (status === 'COMPLETED') {
    return typeof run.conclusion === 'string' && run.conclusion.trim()
      ? run.conclusion.trim().toUpperCase() : '';
  }
  return status;
}

function checkRunTime(run) {
  const status = run.status.trim().toUpperCase();
  const raw = status === 'COMPLETED'
    ? run.completed_at
    : run.started_at || run.created_at;
  const value = Date.parse(typeof raw === 'string' ? raw : '');
  return Number.isFinite(value) ? value : null;
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
 * to repeat that SHA: a mixed or malformed response is never a verdict.
 *
 * @param {unknown} pages result of `gh api --paginate --slurp` on check-runs
 * @param {string} headSha frozen PR HEAD
 * @returns {{allow: boolean, reason: string, checks?: Array<object>}}
 */
export function exactCheckRunSnapshot(pages, headSha) {
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
      const time = checkRunTime(run);
      if (!state || time === null) {
        return deny(`check-run ${run.name} senza stato/tempo verificabile`);
      }
      const candidate = {
        name: run.name,
        state,
        bucket: checkRunBucket(state),
        id: run.id,
        time,
      };
      const previous = latest.get(run.name);
      if (!previous || candidate.time > previous.time
          || (candidate.time === previous.time && candidate.id > previous.id)) {
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

function commitCheckDecision(mode, pages, requiredNames, headSha, requiredName) {
  const snapshot = exactCheckRunSnapshot(pages, headSha);
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

export function requiredCheckRunsDecision(pages, requiredNames, headSha, requiredName = VITEST_CHECK_NAME) {
  return commitCheckDecision('required', pages, requiredNames, headSha, requiredName);
}

export function allCheckRunsDecision(pages, requiredNames, headSha, requiredName = VITEST_CHECK_NAME) {
  return commitCheckDecision('all', pages, requiredNames, headSha, requiredName);
}

function readJson(file) {
  if (!file) throw new Error('file JSON mancante');
  return JSON.parse(readFileSync(resolve(file), 'utf8'));
}

function main() {
  const [mode, file, requiredFile, headSha] = process.argv.slice(2);
  const payload = readJson(file);
  if (mode === '--enroll') {
    const numbers = enrollablePullRequestNumbers(payload);
    if (numbers.length > 0) process.stdout.write(`${numbers.join('\n')}\n`);
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
      ? requiredCheckRunsDecision(payload, required, headSha)
      : allCheckRunsDecision(payload, required, headSha);
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
