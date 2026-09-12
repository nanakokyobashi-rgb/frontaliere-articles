#!/usr/bin/env node
/**
 * Claim the leader and every B19 group member before issue-fix starts.
 *
 * The group context is resolved by issue-fix.yml before this step and passed
 * as ISSUE_NUMBERS. A single-issue run passes only ISSUE_NUMBER. The claim is
 * fail-closed: a pre-existing claim on any member stops the whole run, and a
 * GitHub/API/parse failure does the same. A leader must not race a member's
 * single-issue fixer and open a second PR for the same work.
 *
 * Output (GITHUB_OUTPUT): `in_flight=true|false`, `claimed_numbers=<csv>`,
 * `claim_acquired=true|false`, `claim_owner=local|remote|unknown|contended|''`,
 * `claim_error=true|false`.
 *
 * Env:
 *   GH_TOKEN          required for gh reads/writes.
 *   GH_REPO          optional owner/repo.
 *   ISSUE_NUMBER     required current issue.
 *   ISSUE_NUMBERS    optional comma/space-separated group members.
 *   DRY_RUN          "1" -> inspect only, no label/comment writes.
 *   CLAIM_ACTION     "acquire" (default) or "release".
 *   CLAIM_OWNER      "remote" (default) or "local".
 *   CLAIMED_NUMBERS  optional numbers to release (takes precedence on release).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DRY_RUN = process.env.DRY_RUN === '1';
const ISSUE = process.env.ISSUE_NUMBER;
const CLAIM_LABEL = 'agent:in-progress';
const OWNER_LABELS = Object.freeze({ local: 'agent:local', remote: 'agent:remote' });
const CLAIM_ACTION = process.env.CLAIM_ACTION === 'release' ? 'release' : 'acquire';
const CLAIM_OWNER = process.env.CLAIM_OWNER === 'local' ? 'local' : 'remote';
const OWNER_LABEL = OWNER_LABELS[CLAIM_OWNER];
const repoArgs = process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : [];
const SKIP_GROUP_MEMBER = process.env.SKIP_GROUP_MEMBER === 'true';

function gh(args, { allowFail = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    if (allowFail) return '';
    throw error;
  }
}

function issueNumbers() {
  const releaseNumbers = (process.env.CLAIMED_NUMBERS || '').trim();
  const values = [
    ...(CLAIM_ACTION === 'release' && releaseNumbers ? [] : [ISSUE]),
    ...(releaseNumbers && CLAIM_ACTION === 'release' ? releaseNumbers.split(/[\s,]+/) : []),
    ...(process.env.ISSUE_NUMBERS || '').split(/[\s,]+/),
  ]
    .map((value) => String(value || '').trim())
    .filter((value) => /^\d+$/.test(value));
  return [...new Set(values)];
}

function writeOutputs(inFlight, claimedNumbers, owner = '', claimAcquired = false, claimError = false) {
  const claimed = claimedNumbers.join(',');
  const output = [
    `in_flight=${inFlight}`,
    `claimed_numbers=${claimed}`,
    `claim_acquired=${claimAcquired}`,
    `claim_owner=${owner}`,
    `claim_error=${claimError}`,
  ].join('\n') + '\n';
  process.stdout.write(output);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, output);
}

function claimOwner(labels) {
  const owners = Object.entries(OWNER_LABELS)
    .filter(([, label]) => labels.includes(label))
    .map(([owner]) => owner);
  if (owners.length > 1) return 'contended';
  return owners[0] || (labels.includes(CLAIM_LABEL) ? 'unknown' : '');
}

function isOccupied(labels) {
  return labels.includes(CLAIM_LABEL) || Object.values(OWNER_LABELS).some((label) => labels.includes(label));
}

function readLabels(number) {
  const raw = gh(['issue', 'view', number, ...repoArgs, '--json', 'labels']);
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed?.labels)) throw new Error(`invalid labels response for #${number}`);
  return parsed.labels.map((label) => String(label?.name || '')).filter(Boolean);
}

function release(numbers) {
  for (const number of numbers) {
    let labels;
    try {
      labels = readLabels(number);
    } catch {
      continue;
    }
    if (claimOwner(labels) !== CLAIM_OWNER) continue;
    const remove = [OWNER_LABEL];
    const otherOwner = Object.entries(OWNER_LABELS)
      .filter(([name]) => name !== CLAIM_OWNER)
      .some(([, label]) => labels.includes(label));
    if (!otherOwner && labels.includes(CLAIM_LABEL)) remove.push(CLAIM_LABEL);
    const removeArgs = remove.flatMap((label) => ['--remove-label', label]);
    gh(['issue', 'edit', number, ...repoArgs, ...removeArgs], { allowFail: true });
  }
}

function main() {
  const numbers = issueNumbers();
  if (CLAIM_ACTION === 'release') {
    if (numbers.length === 0) {
      console.log('No valid issue number — nothing to release.');
      writeOutputs(false, []);
      return;
    }
    if (!DRY_RUN) release(numbers);
    console.log(`Released claim where owned on ${numbers.map((number) => `#${number}`).join(', ')}.`);
    writeOutputs(false, [], CLAIM_OWNER);
    return;
  }

  // The B19 label is armed on every member so the group is visible, but only
  // the deterministic leader may start issue-fix. A member event has its own
  // per-issue Actions concurrency key; letting it fall back to a single-issue
  // claim would race the leader's group claim. Report it as occupied without
  // writing labels, so every downstream step already gated by `in_flight`
  // exits before spending quota.
  if (SKIP_GROUP_MEMBER) {
    console.log(`Issue #${ISSUE}: membro non-leader B19 — skip senza claim concorrente.`);
    writeOutputs(true, [], 'group-member', false, false);
    return;
  }

  if (!/^\d+$/.test(String(ISSUE || '')) || numbers.length === 0) {
    console.log('No valid issue number — fail-closed (no group claim possible).');
    writeOutputs(true, [], 'unknown', false, true);
    return;
  }

  const alreadyClaimed = [];
  const owners = new Set();
  for (const number of numbers) {
    let labels;
    try {
      labels = readLabels(number);
    } catch (error) {
      console.log(`Issue #${number} label fetch failed — fail-closed: ${error.message || error}`);
      writeOutputs(true, [], 'unknown', false, true);
      return;
    }
    const owner = claimOwner(labels);
    if (owner) owners.add(owner);
    if (isOccupied(labels)) alreadyClaimed.push(number);
  }

  if (alreadyClaimed.length > 0) {
    const owner = owners.size === 1 ? [...owners][0] : 'contended';
    console.log(`Group ${numbers.map((number) => `#${number}`).join(', ')}: claim already present on ${alreadyClaimed.map((number) => `#${number}`).join(', ')} (owner=${owner}) → skipping the fixer.`);
    if (!DRY_RUN) {
      const comment = `⏭️ **Pre-flight (auto, zero-Claude)**: questa issue/gruppo porta già il claim \`${CLAIM_LABEL}\` su ${alreadyClaimed.map((number) => `#${number}`).join(', ')} (owner: \`${owner}\`) — un'altra sessione l'ha reclamata per prima. Salto il fixer per evitare PR duplicate/in conflitto.\n\n<!-- FIX_OUTCOME: overlap-skip -->`;
      gh(['issue', 'comment', ISSUE, ...repoArgs, '--body', comment], { allowFail: true });
    }
    writeOutputs(true, [], owner);
    return;
  }

  console.log(`No existing claim on ${numbers.map((number) => `#${number}`).join(', ')} — claiming the group now.`);
  if (DRY_RUN) {
    writeOutputs(false, [], CLAIM_OWNER);
    return;
  }

  const claimed = [];
  try {
    gh([
      'label', 'create', CLAIM_LABEL,
      '--color', 'fbca04',
      '--description', 'Un fixer (CI o sessione interattiva) sta lavorando questa issue ORA — mutex anti-doppione (#4788/#4793)',
      ...repoArgs,
    ], { allowFail: true });
    gh([
      'label', 'create', OWNER_LABEL,
      '--color', CLAIM_OWNER === 'local' ? '1d76db' : '5319e7',
      '--description', `Claim ${CLAIM_OWNER}: indica chi sta lavorando la issue; accompagna ${CLAIM_LABEL}`,
      ...repoArgs,
    ], { allowFail: true });
    for (const number of numbers) {
      gh(['issue', 'edit', number, ...repoArgs, '--add-label', CLAIM_LABEL, '--add-label', OWNER_LABEL]);
      claimed.push(number);
    }
    for (const number of claimed) {
      const after = readLabels(number);
      if (claimOwner(after) !== CLAIM_OWNER || !after.includes(CLAIM_LABEL)) {
        throw new Error(`claim verification failed on #${number}`);
      }
    }
  } catch (error) {
    release(claimed);
    console.log(`Group claim failed — fail-closed after rollback: ${error.message || error}`);
    writeOutputs(true, [], 'unknown', false, true);
    return;
  }
  writeOutputs(false, claimed, CLAIM_OWNER, true);
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    main();
  } catch (error) {
    console.error('Group claim gate error — fail-closed (fixer skipped):', error?.message || error);
    writeOutputs(true, [], 'unknown', false, true);
    process.exit(0);
  }
}
