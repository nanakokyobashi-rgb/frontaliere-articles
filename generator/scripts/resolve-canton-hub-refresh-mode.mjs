#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { apiTriggerInputsDifferBetween } from '../../scripts/lib/publish-api-input-range.mjs';
import { parsePublishApiRange, resolvePublisherArtifactState, resolveRefreshMode } from './lib/canton-hubs/publish-gate.mjs';

const eventName = process.env.EVENT_NAME || '';
const pushBefore = process.env.PUSH_BEFORE || '';
const pushAfter = process.env.PUSH_AFTER || '';
const upstreamEvent = process.env.UPSTREAM_EVENT || '';
const upstreamBranch = process.env.UPSTREAM_BRANCH || '';
const upstreamConclusion = process.env.UPSTREAM_CONCLUSION || '';
const upstreamTitle = process.env.UPSTREAM_TITLE || '';
const upstreamHeadSha = process.env.UPSTREAM_HEAD_SHA || '';
const artifactDownloadState = process.env.PUBLISH_API_ARTIFACT_STATE || '';
const artifactDir = process.env.PUBLISH_API_ARTIFACT_DIR || '';

let before = pushBefore;
let after = pushAfter || 'HEAD';
let publisherStatus = 'published';
let publisherSourceCommit = '';
if (eventName === 'workflow_run'
  && upstreamEvent === 'push'
  && upstreamBranch === 'main'
  && upstreamConclusion === 'success') {
  const range = parsePublishApiRange(upstreamTitle);
  if (!range) throw new Error('run-name Publish article data API senza range before..after');
  before = range.before;
  const checkedOutHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['merge-base', '--is-ancestor', upstreamHeadSha, checkedOutHead]);

  if (artifactDownloadState === 'available') {
    if (!artifactDir) throw new Error('Pages artifact disponibile senza directory');
    const manifest = JSON.parse(readFileSync(`${artifactDir}/manifest.json`, 'utf8'));
    const outcome = resolvePublisherArtifactState({
      artifactAvailable: true,
      publisherCommit: manifest.commit,
      workflowHeadSha: upstreamHeadSha,
      mainHeadSha: checkedOutHead,
    });
    if (checkedOutHead !== outcome.sourceCommit) throw new Error('checkout non corrisponde al commit del Pages artifact publisher');
    publisherStatus = outcome.status;
    publisherSourceCommit = outcome.sourceCommit;
    after = publisherSourceCommit;
  } else if (artifactDownloadState === 'missing') {
    const newerPublisherInputs = checkedOutHead !== upstreamHeadSha
      && apiTriggerInputsDifferBetween({ before: upstreamHeadSha, after: checkedOutHead });
    const outcome = resolvePublisherArtifactState({
      artifactAvailable: false,
      workflowHeadSha: upstreamHeadSha,
      mainHeadSha: checkedOutHead,
      newerPublisherInputs,
    });
    publisherStatus = outcome.status;
    after = range.after;
  } else {
    throw new Error(`stato download Pages artifact non verificabile (${artifactDownloadState || 'assente'})`);
  }
}

let changedPaths = [];
if (eventName === 'workflow_run' && publisherStatus === 'skipped') {
  changedPaths = [];
} else if (eventName === 'workflow_run' && before === 'none') {
  // Initial publisher ranges have no base SHA. Treat the scope as unknown:
  // all enabled sections are refreshed and the staged publisher sitemap is
  // still the public-readiness oracle.
  before = '';
  changedPaths = ['content/initial-publisher-range'];
} else if ((eventName === 'push' && before)
  || (eventName === 'workflow_run' && before && after)) {
  changedPaths = execFileSync('git', ['diff', '--no-renames', '--name-only', before, after], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

const mode = resolveRefreshMode({
  eventName,
  pushBefore: before,
  pushAfter: after,
  upstreamEvent,
  upstreamBranch,
  upstreamConclusion,
  upstreamTitle,
  upstreamHeadSha,
  publisherStatus,
  publisherSourceCommit,
  changedPaths,
  dryRunInput: process.env.DRY_RUN_INPUT === 'true',
});
const output = process.env.GITHUB_OUTPUT;
if (!output) throw new Error('GITHUB_OUTPUT assente');
appendFileSync(output, [
  `run=${mode.run}`,
  `dry=${mode.dry}`,
  `before=${mode.before}`,
  `after=${mode.after}`,
  `event=${eventName}`,
  `reason=${mode.reason}`,
].join('\n') + '\n');
console.log(`event=${eventName} run=${mode.run} dry_run=${mode.dry} reason=${mode.reason}`);
