#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createCantonHubRefreshReceipt } from './lib/canton-hubs/refresh-receipt.mjs';

const receipt = createCantonHubRefreshReceipt({
  repository: process.env.GITHUB_REPOSITORY,
  eventName: process.env.EVENT_NAME,
  runId: process.env.GITHUB_RUN_ID,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  sourceCommit: process.env.HUB_REFRESH_SOURCE_COMMIT,
  hubCommit: process.env.HUB_REFRESH_COMMIT,
  sections: (process.env.HUB_REFRESH_SECTIONS || '').split(',').filter(Boolean),
  sourceVerified: process.env.HUB_REFRESH_SOURCE_VERIFIED === 'true',
});
const outputPath = process.env.RECEIPT_OUTPUT_PATH;
if (!outputPath) throw new Error('RECEIPT_OUTPUT_PATH assente');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
