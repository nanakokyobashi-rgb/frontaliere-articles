#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function parseRegistry(value, label) {
  let parsed;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  } catch (error) {
    throw new Error(`${label}: JSON illeggibile (${error.message})`);
  }
  if (parsed?.schema !== 1 || !Array.isArray(parsed.assets)) {
    throw new Error(`${label}: atteso schema 1 con assets[]`);
  }
  for (const record of parsed.assets) {
    if (!record || typeof record !== 'object' || !String(record.assetId || '').trim()) {
      throw new Error(`${label}: record senza assetId valido`);
    }
  }
  return parsed;
}

/**
 * Union of the append-only generated-image ledgers. `replayed` is the commit
 * being kept by the rebase, so it wins for a duplicate assetId; this is the
 * same side that wins the per-section article registry merge.
 */
export function mergeGeneratedImageRegistries(upstream, replayed) {
  const left = parseRegistry(upstream, 'upstream');
  const right = parseRegistry(replayed, 'replayed');
  const byAsset = new Map(left.assets.map((record) => [record.assetId, record]));
  for (const record of right.assets) byAsset.set(record.assetId, record);
  // Map#set replaces a duplicate without moving it: preserve upstream order
  // and append only records that are genuinely new on the replayed side.
  const assets = [...byAsset.values()];
  return { schema: 1, assetCount: assets.length, assets };
}

function main(argv) {
  if (argv.length !== 2) {
    console.error('usage: merge-generated-image-registry.mjs <target.json> <replayed-snapshot.json>');
    return 2;
  }
  const [targetPath, replayedPath] = argv;
  try {
    const merged = mergeGeneratedImageRegistries(
      fs.readFileSync(targetPath, 'utf8'),
      fs.readFileSync(replayedPath, 'utf8'),
    );
    fs.writeFileSync(targetPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    return 0;
  } catch (error) {
    console.error(`::error::generated image registry merge refused — ${error.message}`);
    return 1;
  }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
