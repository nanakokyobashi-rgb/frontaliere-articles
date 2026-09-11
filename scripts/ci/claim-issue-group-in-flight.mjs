#!/usr/bin/env node
/**
 * Claim the leader and every B19 group member before issue-fix starts.
 *
 * The group context is resolved by issue-fix.yml before this step and passed
 * as ISSUE_NUMBERS. A single-issue run passes only ISSUE_NUMBER. The claim is
 * deliberately best-effort like claim-issue-in-flight.mjs, but a pre-existing
 * claim on any member stops the whole run: a leader must not race a member's
 * single-issue fixer and open a second PR for the same work.
 *
 * Output (GITHUB_OUTPUT): `in_flight=true|false`, `claimed_numbers=<csv>`.
 *
 * Env:
 *   GH_TOKEN      required for gh reads/writes.
 *   GH_REPO      optional owner/repo.
 *   ISSUE_NUMBER  required current issue.
 *   ISSUE_NUMBERS optional comma/space-separated group members.
 *   DRY_RUN      "1" -> inspect only, no label/comment writes.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DRY_RUN = process.env.DRY_RUN === '1';
const ISSUE = process.env.ISSUE_NUMBER;
const CLAIM_LABEL = 'agent:in-progress';
const repoArgs = process.env.GH_REPO ? ['--repo', process.env.GH_REPO] : [];

function gh(args, { allowFail = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    if (allowFail) return '';
    throw error;
  }
}

function issueNumbers() {
  const values = [ISSUE, ...(process.env.ISSUE_NUMBERS || '').split(/[\s,]+/)]
    .map((value) => String(value || '').trim())
    .filter((value) => /^\d+$/.test(value));
  return [...new Set(values)];
}

function writeOutputs(inFlight, claimedNumbers) {
  const claimed = claimedNumbers.join(',');
  const output = `in_flight=${inFlight}\nclaimed_numbers=${claimed}\n`;
  process.stdout.write(`in_flight=${inFlight}\nclaimed_numbers=${claimed}\n`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, output);
}

function release(numbers) {
  for (const number of numbers) {
    gh(['issue', 'edit', number, ...repoArgs, '--remove-label', CLAIM_LABEL], { allowFail: true });
  }
}

function readLabels(number) {
  const raw = gh(['issue', 'view', number, ...repoArgs, '--json', 'labels']);
  const parsed = JSON.parse(raw);
  return (parsed.labels || []).map((label) => label.name).filter(Boolean);
}

function main() {
  if (!ISSUE) {
    console.log('ISSUE_NUMBER not set — proceeding (no group claim possible).');
    writeOutputs(false, []);
    return;
  }

  const numbers = issueNumbers();
  if (numbers.length === 0) {
    console.log('No valid issue number — proceeding (no group claim possible).');
    writeOutputs(false, []);
    return;
  }

  const alreadyClaimed = [];
  for (const number of numbers) {
    let labels;
    try {
      labels = readLabels(number);
    } catch (error) {
      console.log(`Issue #${number} label fetch failed — proceeding (proceed-safe): ${error.message || error}`);
      writeOutputs(false, []);
      return;
    }
    if (labels.includes(CLAIM_LABEL)) alreadyClaimed.push(number);
  }

  if (alreadyClaimed.length > 0) {
    console.log(`Group ${numbers.map((number) => `#${number}`).join(', ')}: claim already present on ${alreadyClaimed.map((number) => `#${number}`).join(', ')} → skipping the fixer.`);
    if (!DRY_RUN) {
      const comment = `⏭️ **Pre-flight (auto, zero-Claude)**: questa issue/gruppo porta già la label \`${CLAIM_LABEL}\` su ${alreadyClaimed.map((number) => `#${number}`).join(', ')} — un'altra sessione l'ha reclamata per prima. Salto il fixer autonomo per evitare PR duplicate/in conflitto. Se il claim è stale (run morta senza rilascio), rimuovi \`${CLAIM_LABEL}\` e ri-labella \`agent:fix\`.\n\n<!-- FIX_OUTCOME: overlap-skip -->`;
      gh(['issue', 'comment', ISSUE, ...repoArgs, '--body', comment], { allowFail: true });
    }
    writeOutputs(true, []);
    return;
  }

  console.log(`No existing claim on ${numbers.map((number) => `#${number}`).join(', ')} — claiming the group now.`);
  if (DRY_RUN) {
    writeOutputs(false, []);
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
    for (const number of numbers) {
      gh(['issue', 'edit', number, ...repoArgs, '--add-label', CLAIM_LABEL]);
      claimed.push(number);
    }
  } catch (error) {
    release(claimed);
    console.log(`Group claim failed — proceeding after rollback: ${error.message || error}`);
    writeOutputs(false, []);
    return;
  }
  writeOutputs(false, claimed);
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    main();
  } catch (error) {
    console.error('Group claim gate error — proceeding (normal fixer runs):', error?.message || error);
    writeOutputs(false, []);
    process.exit(0);
  }
}
