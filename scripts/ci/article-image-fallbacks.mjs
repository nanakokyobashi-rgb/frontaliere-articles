#!/usr/bin/env node

/** Convert the observer issue ledger into the aggregate-render fallback map. */
import fs from 'node:fs';
import { parseDegradationLedger, releasedArticleFallbacks } from '../lib/article-image-degradation-ledger.mjs';

const file = process.argv[2];
const body = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
const { items } = parseDegradationLedger(body);
process.stdout.write(`${JSON.stringify({ schema: 1, releasedArticles: releasedArticleFallbacks(items) }, null, 2)}\n`);
