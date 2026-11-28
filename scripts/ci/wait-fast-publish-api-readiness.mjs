#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { reconcile } from '../reconcile-section-pages.mjs';

const SHA_RE = /^[a-f0-9]{40}$/u;
// Tetto dello slot di sezione: oltre 90 minuti il finalize fallisce con un
// esito dichiarato invece di tenere lo slot fino al timeout del job.
const DEFAULT_WAIT_MS = 90 * 60 * 1000;
const DEFAULT_ATTEMPT_BUDGET_MS = 60 * 1000;
const DEFAULT_RETRY_DELAY_MS = 30 * 1000;

function positiveInteger(value, name, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} deve essere un intero positivo`);
  }
  return parsed;
}

/**
 * True se `actual` coincide con `expected` o ne e' discendente: publish-api
 * puo' saltare il commit atteso e pubblicare una HEAD successiva che lo
 * contiene, e la release servita copre comunque gli input attesi.
 */
export function isCommitDescendantOf(actual, expected, { cwd = process.cwd() } = {}) {
  if (!SHA_RE.test(actual ?? '') || !SHA_RE.test(expected ?? '')) return false;
  if (actual === expected) return true;
  const git = (...args) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000 });
  for (const sha of [expected, actual]) {
    if (git('cat-file', '-e', `${sha}^{commit}`).status !== 0
      && git('fetch', '--quiet', '--no-tags', 'origin', sha).status !== 0) {
      return false;
    }
  }
  return git('merge-base', '--is-ancestor', expected, actual).status === 0;
}

export function fastPublishReadiness(report, {
  section,
  sections,
  expectedCommit,
  isDescendant = () => false,
}) {
  const covers = (actual) => actual === expectedCommit || isDescendant(actual, expectedCommit) === true;
  const targets = sections ?? (section ? [section] : []);
  if (!Array.isArray(targets) || targets.length === 0 || targets.some((id) => typeof id !== 'string' || !id)) {
    return { ready: false, reason: 'nessuna sezione R2 richiesta per la readiness' };
  }
  if (report?.skipped) return { ready: false, reason: report.skipped };
  if (!covers(report?.apiCommit)) {
    return { ready: false, reason: `manifest API non ancora sul commit ${expectedCommit} o su un suo discendente (osservato ${report?.apiCommit ?? 'assente'})` };
  }
  if (!covers(report?.edgeCommit) || report?.pendingEdgeFlip === true) {
    return { ready: false, reason: `registro edge non ancora sul commit ${expectedCommit} o su un suo discendente (osservato ${report?.edgeCommit ?? 'assente'})` };
  }
  if (targets.every((targetSection) => report?.sectionStatuses?.[targetSection] === 'draft')) {
    return {
      ready: true,
      reason: targets.length === 1
        ? 'sezione draft sulla release verificata'
        : `sezioni draft sulla release verificata (${targets.length})`,
    };
  }

  const retiredTargets = [];
  const liveTargets = [];
  for (const targetSection of targets) {
    const status = report?.sectionStatuses?.[targetSection];
    if (status === 'draft') continue;
    if (status === 'retired') {
      retiredTargets.push(targetSection);
      continue;
    }
    if (status !== 'live') {
      return { ready: false, reason: `stato live della sezione ${targetSection} non verificato (${status ?? 'assente'})` };
    }
    liveTargets.push(targetSection);

    const target = report.sections?.find((entry) => entry.section === targetSection);
    if (!target) return { ready: false, reason: `sitemap della sezione ${targetSection} non verificata` };
    if (target.pageManifest !== 'ok') {
      return { ready: false, reason: `manifest pagine R2 della sezione ${targetSection} non verificato` };
    }
    const missingPages = target.expectedMissingPagePaths?.length ?? 0;
    const missingArticles = (target.missingIds?.length ?? 0) + (target.leftover?.length ?? 0);
    const unknownPages = target.unknown?.length ?? 0;
    if (missingPages || missingArticles || unknownPages || target.dispatch === true) {
      return {
        ready: false,
        reason: `copertura ${targetSection} incompleta (pagine=${missingPages}, articoli=${missingArticles}, unknown=${unknownPages})`,
      };
    }
  }
  if (liveTargets.length === 0 && retiredTargets.length > 0) {
    return {
      ready: true,
      reason: retiredTargets.length === 1
        ? `release API verificata; la superficie ritirata ${retiredTargets[0]} non richiede copertura pagine`
        : `release API verificata; ${retiredTargets.length} superfici ritirate non richiedono copertura pagine`,
    };
  }
  return {
    ready: true,
    reason: retiredTargets.length === 0
      ? (targets.length === 1
        ? `release API e pagine ${targets[0]} verificate`
        : `release API e pagine ${liveTargets.length} sezioni verificate`)
      : `release API e pagine ${liveTargets.length} sezioni live verificate; ${retiredTargets.length} superfici ritirate escluse dalla copertura pagine`,
  };
}

export async function probeFastPublishApiReadiness({
  sections,
  expectedCommit,
  attemptBudgetMs = DEFAULT_ATTEMPT_BUDGET_MS,
  reconcileImpl = reconcile,
  isDescendant = isCommitDescendantOf,
} = {}) {
  const targets = sections ?? [];
  if (!Array.isArray(targets) || targets.length === 0 || targets.some((id) => typeof id !== 'string' || !id)) {
    throw new Error('sections deve contenere almeno una sezione R2');
  }
  if (!SHA_RE.test(expectedCommit ?? '')) throw new Error('expectedCommit richiede una SHA completa');
  if (!Number.isSafeInteger(attemptBudgetMs) || attemptBudgetMs <= 0) {
    throw new Error('attemptBudgetMs deve essere un intero positivo');
  }
  const report = await reconcileImpl({
    sectionIds: targets,
    checkLandingContent: false,
    budgetMs: attemptBudgetMs,
  });
  const result = fastPublishReadiness(report, { sections: targets, expectedCommit, isDescendant });
  return { ready: result.ready, reason: result.reason };
}

export async function waitForFastPublishApiReadiness({
  section,
  sections,
  expectedCommit,
  waitMs = DEFAULT_WAIT_MS,
  attemptBudgetMs = DEFAULT_ATTEMPT_BUDGET_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  reconcileImpl = reconcile,
  isDescendant = isCommitDescendantOf,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  log = console.log,
} = {}) {
  const targets = sections ?? (section ? [section] : []);
  if (!Array.isArray(targets) || targets.length === 0 || targets.some((id) => typeof id !== 'string' || !id)) {
    throw new Error('sections deve contenere almeno una sezione R2');
  }
  if (!SHA_RE.test(expectedCommit ?? '')) throw new Error('expectedCommit richiede una SHA completa');
  for (const [name, value] of [['waitMs', waitMs], ['attemptBudgetMs', attemptBudgetMs], ['retryDelayMs', retryDelayMs]]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} deve essere un intero positivo`);
  }

  const deadline = now() + waitMs;
  if (!Number.isFinite(deadline)) throw new Error('deadline della readiness non valida');
  let lastReason = 'nessuna osservazione HTTP';
  let attempt = 0;
  while (now() < deadline) {
    const remainingMs = deadline - now();
    const budgetMs = Math.min(attemptBudgetMs, remainingMs);
    attempt += 1;
    try {
      const report = await reconcileImpl({
        sectionIds: targets,
        checkLandingContent: false,
        budgetMs,
      });
      const result = fastPublishReadiness(report, { sections: targets, expectedCommit, isDescendant });
      if (result.ready) {
        log(`::notice::readiness API Fast Publish verificata al tentativo ${attempt}: ${result.reason}`);
        return { ...result, attempts: attempt, report };
      }
      lastReason = result.reason;
    } catch (error) {
      lastReason = error?.message ?? String(error);
    }
    const remainingAfterAttemptMs = deadline - now();
    if (remainingAfterAttemptMs <= 0) break;
    const delayMs = Math.min(retryDelayMs, remainingAfterAttemptMs);
    log(`::notice::readiness API Fast Publish in attesa (${attempt}): ${lastReason}; nuovo controllo tra ${delayMs}ms`);
    await sleepImpl(delayMs);
  }
  throw new Error(`esito=readiness-timeout: readiness API Fast Publish non verificata entro ${waitMs}ms (sezioni ${targets.join(',')}, atteso ${expectedCommit}): ${lastReason}`);
}

export async function main(env = process.env, argv = process.argv.slice(2)) {
  const sections = env.SECTIONS_JSON ? JSON.parse(env.SECTIONS_JSON) : [env.SECTION].filter(Boolean);
  const expectedCommit = env.EXPECTED_API_COMMIT;
  if (argv.includes('--probe-once')) {
    const result = await probeFastPublishApiReadiness({
      sections,
      expectedCommit,
      attemptBudgetMs: positiveInteger(env.FAST_PUBLISH_API_ATTEMPT_BUDGET_MS, 'FAST_PUBLISH_API_ATTEMPT_BUDGET_MS', DEFAULT_ATTEMPT_BUDGET_MS),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }
  const result = await waitForFastPublishApiReadiness({
    sections,
    expectedCommit,
    waitMs: positiveInteger(env.FAST_PUBLISH_API_WAIT_MS, 'FAST_PUBLISH_API_WAIT_MS', DEFAULT_WAIT_MS),
    attemptBudgetMs: positiveInteger(env.FAST_PUBLISH_API_ATTEMPT_BUDGET_MS, 'FAST_PUBLISH_API_ATTEMPT_BUDGET_MS', DEFAULT_ATTEMPT_BUDGET_MS),
    retryDelayMs: positiveInteger(env.FAST_PUBLISH_API_RETRY_DELAY_MS, 'FAST_PUBLISH_API_RETRY_DELAY_MS', DEFAULT_RETRY_DELAY_MS),
  });
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`::error::${error?.message ?? String(error)}`);
    process.exitCode = 1;
  });
}
