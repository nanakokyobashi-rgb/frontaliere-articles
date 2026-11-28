#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  hasCompleteCantonHubRefreshCoverage,
  isCantonHubOutputPath,
  parseCantonHubRefreshMarker,
  resolveCantonTargetSections,
} from './lib/canton-hubs/publish-gate.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;

const enabledSections = (process.env.ENABLED_SECTIONS || '').split('\n').filter(Boolean);
const changedPaths = input.split('\n').filter(Boolean);
if (process.env.EVENT_NAME === 'workflow_run') {
  let alreadyCovered = false;
  const publisherSourceCommit = process.env.PUBLISHER_SOURCE_COMMIT || '';
  if (/^[0-9a-f]{40}$/.test(publisherSourceCommit) &&
      changedPaths.length > 0 && changedPaths.every(isCantonHubOutputPath)) {
    try {
      const commitMessage = execFileSync('git', ['show', '-s', '--format=%B', publisherSourceCommit], { encoding: 'utf8' });
      const marker = parseCantonHubRefreshMarker(commitMessage);
      const sourceCommit = marker?.sourceCommit || '';
      let sourceCommitIsAncestor = false;
      let sourceChangedPaths = null;
      if (sourceCommit) {
        try {
          execFileSync('git', ['merge-base', '--is-ancestor', sourceCommit, publisherSourceCommit], { stdio: 'ignore' });
          sourceCommitIsAncestor = true;
          sourceChangedPaths = sourceCommit === publisherSourceCommit
            ? []
            : execFileSync('git', ['diff', '--no-renames', '--name-only', sourceCommit, publisherSourceCommit], { encoding: 'utf8' })
              .split('\n').filter(Boolean);
        } catch {
          sourceCommitIsAncestor = false;
        }
      }
      alreadyCovered = hasCompleteCantonHubRefreshCoverage({
        enabledSections,
        publisherChangedPaths: changedPaths,
        publisherSourceCommit,
        commitMessage,
        receiptSourceCommit: sourceCommit,
        receiptAuthenticated: process.env.HUB_RECEIPT_VERIFIED === 'true',
        sourceCommitIsAncestor,
        sourceChangedPaths,
      });
    } catch {
      // Artifact o metadata mancanti, mismatch o Git illeggibile allargano a tutti i cantoni.
      alreadyCovered = false;
    }
  }
  if (alreadyCovered) console.error('[canton-hubs] range hub-only coperta dal receipt: skip sicuro');
  else console.error('[canton-hubs] workflow_run: refresh completo per coprire range senza receipt completo');
  console.log(alreadyCovered ? '' : resolveCantonTargetSections(enabledSections, changedPaths, { includeAll: true }).join(','));
} else {
  console.log(resolveCantonTargetSections(enabledSections, changedPaths).join(','));
}
