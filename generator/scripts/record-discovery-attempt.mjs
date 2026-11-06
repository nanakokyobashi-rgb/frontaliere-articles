#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import {
  loadDiscoveryAttemptState,
  recordDiscoveryAttempt,
  saveDiscoveryAttemptState,
} from './lib/scheduler/discoveryAttemptState.mjs';

const markerPaths = process.argv.slice(2);
if (markerPaths.length === 0) {
  console.error('usage: node generator/scripts/record-discovery-attempt.mjs <marker> [...]');
  process.exit(2);
}

let state = loadDiscoveryAttemptState();
let recorded = 0;
let notAttempted = 0;
for (const markerPath of markerPaths) {
  let marker;
  try {
    marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  } catch (err) {
    console.error(`[discovery-attempt] invalid marker ${markerPath}: ${err?.message || err}`);
    process.exit(1);
  }
  if (!marker || marker.schemaVersion !== 1 || marker.recoveryEligible !== true
    || !['frontaliere', 'svizzera'].includes(marker.section)
    || !['proven', 'discovery'].includes(marker.poolKind)) {
    console.error(`[discovery-attempt] unsupported marker ${markerPath}`);
    process.exit(1);
  }
  const candidateAttempted = marker.candidateAttempted !== false;
  state = recordDiscoveryAttempt(state, {
    section: marker.section,
    poolKind: marker.poolKind,
    generated: false,
    candidateAttempted,
  });
  if (candidateAttempted) recorded += 1;
  else notAttempted += 1;
}

if (recorded > 0 && !saveDiscoveryAttemptState(state)) process.exit(1);
console.log(`[discovery-attempt] recovered ${recorded} candidate attempt(s); preserved debt for ${notAttempted} unattempted slot(s)`);
