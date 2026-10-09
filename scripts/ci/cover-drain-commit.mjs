#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Commit messages emitted by the queued-cover drain are an orchestration
 * signal, not a second publication request.  Keep their prefixes here so the
 * drain recovery gate and both push-triggered publishers share one detector.
 */
export const COVER_DRAIN_COMMIT_PREFIX = 'chore(generator): drain queued article covers (';
export const COVER_PUBLISHER_ACK_COMMIT_PREFIX = 'chore(generator): acknowledge queued cover publishers (';

const COVER_DRAIN_COMMIT_PREFIXES = Object.freeze([
  COVER_DRAIN_COMMIT_PREFIX,
  COVER_PUBLISHER_ACK_COMMIT_PREFIX,
]);

function commitSubject(message) {
  return String(message ?? '').split(/\r?\n/u, 1)[0];
}

/** True when a commit was produced by the queued-cover orchestration. */
export function isCoverDrainCommit(message) {
  const subject = commitSubject(message);
  return COVER_DRAIN_COMMIT_PREFIXES.some((prefix) => subject.startsWith(prefix));
}

function countArgument(value) {
  const count = String(value ?? '').trim();
  if (!/^\d+$/u.test(count)) throw new Error(`drained count must be a non-negative integer: ${value}`);
  return count;
}

export function coverDrainCommitMessage(drained) {
  return `${COVER_DRAIN_COMMIT_PREFIX}${countArgument(drained)} drained)`;
}

export function coverPublisherAckCommitMessage() {
  return `${COVER_PUBLISHER_ACK_COMMIT_PREFIX}partial)`;
}

function main() {
  const command = process.argv[2];
  if (command === 'is-cover-drain') {
    console.log(isCoverDrainCommit(process.env.COVER_DRAIN_COMMIT_MESSAGE) ? 'true' : 'false');
    return;
  }
  if (command === 'drain-message') {
    console.log(coverDrainCommitMessage(process.argv[3]));
    return;
  }
  if (command === 'ack-message') {
    console.log(coverPublisherAckCommitMessage());
    return;
  }
  throw new Error('usage: cover-drain-commit.mjs is-cover-drain | drain-message <count> | ack-message');
}

if ((() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})()) {
  try {
    main();
  } catch (error) {
    console.error(`cover-drain-commit: ${error?.message ?? error}`);
    process.exit(1);
  }
}
