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

function readJson(file) {
  if (!file) throw new Error('file JSON mancante');
  return JSON.parse(readFileSync(resolve(file), 'utf8'));
}

function main() {
  const [mode, file] = process.argv.slice(2);
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
