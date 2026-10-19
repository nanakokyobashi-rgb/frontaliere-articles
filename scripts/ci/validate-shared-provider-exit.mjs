import { readFileSync } from 'node:fs';

import { EXIT_AI_PROVIDER_ROSTER_UNAVAILABLE } from '../../generator/scripts/lib/exhaustion-disposition.mjs';
import {
  RUN_CARD_SCHEMA,
  RUN_CARD_SHARED_PROVIDER_EXIT_DISPOSITION,
} from '../../generator/scripts/lib/run-card.mjs';

const [cardPath, expectedSection, expectedRunId, expectedRunAttempt] = process.argv.slice(2);

function reject(reason) {
  console.error(`shared-provider exit marker rejected: ${reason}`);
  process.exitCode = 1;
}

if (!cardPath || !expectedSection || !expectedRunId || !expectedRunAttempt) {
  reject('usage: validate-shared-provider-exit.mjs <run-card> <section> <run-id> <run-attempt>');
} else {
  let card;
  let readable = false;
  try {
    card = JSON.parse(readFileSync(cardPath, 'utf8'));
    readable = true;
  } catch {
    reject('run card is missing or invalid JSON');
  }

  if (readable && (!card || typeof card !== 'object' || Array.isArray(card)
    || card.schema !== RUN_CARD_SCHEMA
    || card.section !== expectedSection
    || String(card.runId) !== String(expectedRunId)
    || String(card.runAttempt) !== String(expectedRunAttempt)
    || card.status !== 'deferred'
    || card.exitCode !== EXIT_AI_PROVIDER_ROSTER_UNAVAILABLE
    || card.exitDisposition !== RUN_CARD_SHARED_PROVIDER_EXIT_DISPOSITION)) {
    reject('run card does not attest the expected declared exit');
  }
}
