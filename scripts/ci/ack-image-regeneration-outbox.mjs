#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readImageRegenerationPublishOutbox,
  writeImageRegenerationPublishOutbox,
} from '../../generator/scripts/lib/image-regeneration-publish-outbox.mjs';

function parseArgs(argv) {
  const options = { root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..') };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') options.root = path.resolve(argv[++index]);
    else if (arg === '--section') options.section = String(argv[++index] || '').trim();
    else if (arg === '--article-ids') options.articleIds = JSON.parse(argv[++index]);
    else if (arg === '--request-id') options.requestId = String(argv[++index] || '').trim();
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.section) throw new Error('--section requires a section');
  if (!Array.isArray(options.articleIds) || options.articleIds.length === 0
      || options.articleIds.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new Error('--article-ids must be a non-empty JSON array of article ids');
  }
  if (!options.requestId) throw new Error('--request-id requires the publisher correlation id');
  options.articleIds = [...new Set(options.articleIds.map((id) => id.trim()))];
  return options;
}

export function acknowledgeImageRegenerationOutbox({ root, section, articleIds, requestId }) {
  const ids = new Set(articleIds);
  const outbox = readImageRegenerationPublishOutbox(root);
  const remaining = outbox.items.filter((item) => !(item.section === section && ids.has(item.articleId)));
  const acknowledged = outbox.items.length - remaining.length;
  if (acknowledged > 0) {
    writeImageRegenerationPublishOutbox(root, { ...outbox, items: remaining });
  }
  console.log(JSON.stringify({ requestId, section, requested: ids.size, acknowledged }));
  return acknowledged;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  acknowledgeImageRegenerationOutbox(options);
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`❌ Publisher outbox acknowledgement failed: ${error.message || error}`);
    process.exit(1);
  }
}
