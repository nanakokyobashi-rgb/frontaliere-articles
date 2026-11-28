#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Choose follow-up sections only when no direct push Fast Publish owns them. */
export function decideApiOnlyDispatch({
  isPush = false,
  fastPushOwner = false,
  markedFastPublishRange = false,
  fastPushTargets = [],
  apiLocalTargets = [],
  reconciliationTargets = [],
} = {}) {
  for (const [name, value] of [
    ['fastPushTargets', fastPushTargets],
    ['apiLocalTargets', apiLocalTargets],
    ['reconciliationTargets', reconciliationTargets],
  ]) {
    if (!Array.isArray(value)) throw new Error(`${name} deve essere un array`);
  }

  if (markedFastPublishRange) {
    return { skip: true, reason: 'direct-fast-publish-marker', targets: [] };
  }
  if (!isPush) {
    return { skip: true, reason: 'non-push-api-event', targets: [] };
  }
  if (isPush && (fastPushOwner || fastPushTargets.length > 0)) {
    return { skip: true, reason: 'direct-push-fast-publish-owner', targets: [] };
  }
  const bySection = new Map();
  for (const target of reconciliationTargets) {
    if (typeof target?.section !== 'string' || !/^canton-[a-z0-9-]+$/u.test(target.section)) {
      throw new Error('target di riconciliazione senza sezione cantonale valida');
    }
    if (!bySection.has(target.section)) bySection.set(target.section, target);
  }
  if (isPush) {
    const cleanupTargets = [...bySection.values()].filter((target) => target.cleanupInactiveSurface === true);
    if (apiLocalTargets.length === 0 && cleanupTargets.length === 0) {
      return { skip: true, reason: 'no-r2-api-targets', targets: [] };
    }
    const reconciledBySection = new Map(bySection);
    const scopedTargets = new Map();
    for (const target of apiLocalTargets) {
      const reconciled = reconciledBySection.get(target?.section);
      if (!reconciled) {
        throw new Error(`target API locale assente dal piano edge: ${target?.section ?? '(vuoto)'}`);
      }
      scopedTargets.set(target.section, { ...reconciled, ...target });
    }
    for (const target of cleanupTargets) {
      if (scopedTargets.has(target.section)) {
        throw new Error(`target cleanup-only in conflitto con target API locale: ${target.section}`);
      }
      scopedTargets.set(target.section, target);
    }
    return {
      skip: false,
      reason: 'api-only-release',
      targets: [...scopedTargets.values()].sort((a, b) => a.section.localeCompare(b.section)),
    };
  }
  return {
    skip: false,
    reason: 'api-only-release',
    targets: [...bySection.values()].sort((a, b) => a.section.localeCompare(b.section)),
  };
}

export function globPathMatcher(pattern) {
  let regex = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        regex += '.*';
        index += 1;
      } else {
        regex += '[^/]*';
      }
    } else {
      regex += character.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
    }
  }
  return new RegExp(`${regex}$`, 'u');
}

export function matchesFastPublishPushPaths({ workflow, changedPaths }) {
  return matchesWorkflowPushPaths({ workflow, changedPaths });
}

export function matchesWorkflowPushPaths({ workflow, changedPaths }) {
  if (typeof workflow !== 'string' || !Array.isArray(changedPaths)) {
    throw new Error('workflow e changedPaths non validi per il filtro push');
  }
  const pushStart = workflow.indexOf('\n  push:\n');
  const dispatchStart = workflow.indexOf('\n  workflow_dispatch:', pushStart);
  if (pushStart < 0 || dispatchStart < 0) throw new Error('trigger push Fast Publish non trovato');
  const pushBlock = workflow.slice(pushStart, dispatchStart);
  const pathBlock = pushBlock.split(/^    paths:\n/m)[1];
  if (!pathBlock) throw new Error('paths del trigger push Fast Publish non trovati');
  const patterns = [...pathBlock.matchAll(/^      - '([^']+)'$/gmu)].map((match) => match[1]);
  if (patterns.length === 0) throw new Error('paths del trigger push Fast Publish vuoti');
  const matchers = patterns.map(globPathMatcher);
  return changedPaths.some((changedPath) => matchers.some((matcher) => matcher.test(changedPath)));
}

export function fastPublishPushTriggerForRange({ before, after, workflowPath }) {
  return workflowPushTriggerForRange({ before, after, workflowPath });
}

export function workflowPushTriggerForRange({ before, after, workflowPath }) {
  if (!/^[a-f0-9]{40}$/u.test(before ?? '') || !/^[a-f0-9]{40}$/u.test(after ?? '')) {
    throw new Error('before/after richiedono SHA Git complete');
  }
  const changedPaths = execFileSync('git', ['diff', '--no-renames', '--name-only', before, after], {
    encoding: 'utf8',
  }).split('\n').filter(Boolean);
  return matchesWorkflowPushPaths({
    workflow: readFileSync(workflowPath, 'utf8'),
    changedPaths,
  });
}

function main() {
  if (process.argv[2] === '--fast-push-trigger') {
    const before = process.argv[3];
    const after = process.argv[4];
    const workflowPath = process.argv[5];
    if (!before || !after || !workflowPath) {
      throw new Error('--fast-push-trigger richiede before, after e workflowPath');
    }
    process.stdout.write(`${fastPublishPushTriggerForRange({ before, after, workflowPath })}\n`);
    return;
  }
  if (process.argv[2] === '--push-trigger') {
    const before = process.argv[3];
    const after = process.argv[4];
    const workflowPath = process.argv[5];
    if (!before || !after || !workflowPath) {
      throw new Error('--push-trigger richiede before, after e workflowPath');
    }
    process.stdout.write(`${workflowPushTriggerForRange({ before, after, workflowPath })}\n`);
    return;
  }
  const input = JSON.parse(readFileSync(0, 'utf8'));
  process.stdout.write(`${JSON.stringify(decideApiOnlyDispatch(input))}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(`fast-publish-api-only-decision: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
