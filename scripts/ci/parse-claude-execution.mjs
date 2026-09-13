#!/usr/bin/env node

import fs from 'node:fs';

import { parseExecutionMessages } from './claude-rate-limit.mjs';

const input = process.argv[2];
const raw = input && input !== '-' ? fs.readFileSync(input, 'utf8') : fs.readFileSync(0, 'utf8');

for (const message of parseExecutionMessages(raw)) {
  if (!message || typeof message !== 'object') continue;
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
