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

function comparable(value) {
  if (Array.isArray(value)) return value.map(comparable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, comparable(value[key])]));
  }
  return value;
}

function sameRecord(left, right) {
  if (left == null || right == null) return left === right;
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

/**
 * Three-way union of the append-only generated-image ledgers.
 *
 * `base` is the registry at the parent of the commit being replayed. A record
 * that is unchanged there is not a new local update: if upstream replaced it
 * while the run was in flight (for example, the cover drain regenerated the
 * same asset), the upstream record must win. When both sides really changed a
 * record, the replayed commit wins, matching the per-section registry merge
 * and the image files that are kept from that commit.
 */
export function mergeGeneratedImageRegistries(
  upstream,
  replayed,
  base = { schema: 1, assets: [] },
) {
  const left = parseRegistry(upstream, 'upstream');
  const right = parseRegistry(replayed, 'replayed');
  const common = parseRegistry(base, 'base comune');
  const upstreamByAsset = new Map(left.assets.map((record) => [record.assetId, record]));
  const replayedByAsset = new Map(right.assets.map((record) => [record.assetId, record]));
  const baseByAsset = new Map(common.assets.map((record) => [record.assetId, record]));
  const assetIds = [...new Set([
    ...left.assets.map((record) => record.assetId),
    ...right.assets.map((record) => record.assetId),
  ])];

  const assets = assetIds.map((assetId) => {
    const baseRecord = baseByAsset.get(assetId);
    const upstreamRecord = upstreamByAsset.get(assetId);
    const replayedRecord = replayedByAsset.get(assetId);

    // This ledger is append-only: a missing record on one side is not a
    // deletion request. Preserve the record that exists, and only resolve the
    // stale-snapshot case when both sides contain the asset.
    if (!upstreamRecord) return replayedRecord;
    if (!replayedRecord) return upstreamRecord;
    if (sameRecord(upstreamRecord, replayedRecord)) return upstreamRecord;
    if (sameRecord(replayedRecord, baseRecord)) return upstreamRecord;
    return replayedRecord;
  });

  return { schema: 1, assetCount: assets.length, assets };
}

function main(argv) {
  if (argv.length !== 3) {
    console.error('usage: merge-generated-image-registry.mjs <target.json> <replayed-snapshot.json> <base.json>');
    return 2;
  }
  const [targetPath, replayedPath, basePath] = argv;
  try {
    const merged = mergeGeneratedImageRegistries(
      fs.readFileSync(targetPath, 'utf8'),
      fs.readFileSync(replayedPath, 'utf8'),
      fs.readFileSync(basePath, 'utf8'),
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
