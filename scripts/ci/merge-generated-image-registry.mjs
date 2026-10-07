#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const SUPPORTED_KEYS = new Set(['assetId', 'cover']);

function parseRegistry(value, label, key) {
  let parsed;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  } catch (error) {
    throw new Error(`${label}: JSON illeggibile (${error.message})`);
  }
  if (parsed?.schema !== 1 || !Array.isArray(parsed.assets)) {
    throw new Error(`${label}: atteso schema 1 con assets[]`);
  }
  const seen = new Set();
  for (const record of parsed.assets) {
    const value = record?.[key];
    if (!record || typeof record !== 'object' || !String(value || '').trim()) {
      throw new Error(`${label}: record senza ${key} valido`);
    }
    if (seen.has(value)) throw new Error(`${label}: ${key} duplicato (${value})`);
    seen.add(value);
  }
  return parsed;
}

/**
 * Apply only the records changed by this run between `base` and `replayed`.
 * A complete replayed snapshot is unsafe: it also contains old records and
 * would overwrite fresher metadata written upstream while this run was alive.
 */
export function mergeImageRegistryDelta(upstream, base, replayed, { key = 'assetId' } = {}) {
  if (!SUPPORTED_KEYS.has(key)) throw new Error(`chiave registro non supportata: ${key}`);
  const left = parseRegistry(upstream, 'upstream', key);
  const before = parseRegistry(base, 'base', key);
  const after = parseRegistry(replayed, 'replayed', key);
  const baseByKey = new Map(before.assets.map((record) => [record[key], record]));
  const changed = after.assets.filter((record) => !isDeepStrictEqual(baseByKey.get(record[key]), record));
  const merged = new Map(left.assets.map((record) => [record[key], record]));
  for (const record of changed) merged.set(record[key], record);
  // Map#set replaces without moving an existing key: upstream order is stable,
  // while genuinely new local records are appended in replay order.
  const assets = [...merged.values()];
  return { schema: 1, assetCount: assets.length, assets };
}

function main(argv) {
  if (argv.length < 3 || argv.length > 4) {
    console.error('usage: merge-generated-image-registry.mjs <target.json> <base-snapshot.json> <replayed-snapshot.json> [assetId|cover]');
    return 2;
  }
  const [targetPath, basePath, replayedPath, key = 'assetId'] = argv;
  try {
    const target = fs.existsSync(targetPath)
      ? fs.readFileSync(targetPath, 'utf8')
      : { schema: 1, assetCount: 0, assets: [] };
    const merged = mergeImageRegistryDelta(
      target,
      fs.readFileSync(basePath, 'utf8'),
      fs.readFileSync(replayedPath, 'utf8'),
      { key },
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
