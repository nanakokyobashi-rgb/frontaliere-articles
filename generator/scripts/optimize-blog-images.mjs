#!/usr/bin/env node
/**
 * Re-encode selected committed article heroes to the shared byte policy.
 *
 * Usage:
 *   node generator/scripts/optimize-blog-images.mjs --check
 *   node generator/scripts/optimize-blog-images.mjs --write slug.webp ...
 *
 * With no paths, --check scans every hero. --write still changes only heroes
 * above the target, so a maintenance run cannot create binary churn for
 * already-compliant assets. The script is deliberately separate from article
 * generation so an existing published corpus can be repaired deterministically.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {
  BLOG_IMAGE_TARGET_MAX_BYTES,
  BLOG_IMAGE_WIDTH,
  BLOG_IMAGE_HEIGHT,
  BLOG_IMAGE_QUALITY_PASSES,
} from './lib/blog-image-policy.mjs';

const ROOT = process.cwd();
const HERO_DIR = path.resolve(ROOT, 'public/images/blog');
const args = process.argv.slice(2);
const write = args.includes('--write');
const check = args.includes('--check') || !write;
const requested = args.filter((arg) => !arg.startsWith('--'));

async function heroNames() {
  if (requested.length > 0) {
    return requested.map((name) => path.basename(name)).filter((name) => name.endsWith('.webp'));
  }
  return (await fs.readdir(HERO_DIR)).filter((name) => name.endsWith('.webp')).sort();
}

async function encodeAtQuality(input, quality) {
  return sharp(input)
    .rotate()
    .resize({ width: BLOG_IMAGE_WIDTH, height: BLOG_IMAGE_HEIGHT, fit: 'cover', position: 'attention' })
    .webp({ quality, effort: 6 })
    .toBuffer();
}

async function optimize(name) {
  const input = path.join(HERO_DIR, name);
  const original = await fs.stat(input);
  if (original.size <= BLOG_IMAGE_TARGET_MAX_BYTES) return { name, before: original.size, after: original.size, changed: false };

  let best = null;
  for (const quality of BLOG_IMAGE_QUALITY_PASSES) {
    const candidate = await encodeAtQuality(input, quality);
    best = { candidate, quality };
    if (candidate.byteLength <= BLOG_IMAGE_TARGET_MAX_BYTES) break;
  }

  if (write && best && best.candidate.byteLength < original.size) {
    const temp = `${input}.tmp-${process.pid}`;
    await fs.writeFile(temp, best.candidate);
    await fs.rename(temp, input);
  }
  return {
    name,
    before: original.size,
    after: best?.candidate.byteLength ?? original.size,
    quality: best?.quality,
    changed: Boolean(write && best && best.candidate.byteLength < original.size),
  };
}

const names = await heroNames();
const results = [];
for (const name of names) {
  try {
    results.push(await optimize(name));
  } catch (error) {
    console.error(`[blog-images] ${name}: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

const over = results.filter((result) => result.after > BLOG_IMAGE_TARGET_MAX_BYTES);
for (const result of results.filter((result) => result.changed || result.after > BLOG_IMAGE_TARGET_MAX_BYTES)) {
  const mode = result.changed ? 'rewritten' : 'over-target';
  console.log(`[blog-images] ${mode} ${result.name}: ${result.before} -> ${result.after} bytes${result.quality ? ` (q${result.quality})` : ''}`);
}
console.log(`[blog-images] checked=${results.length} target=${BLOG_IMAGE_TARGET_MAX_BYTES} bytes rewritten=${results.filter((r) => r.changed).length} over=${over.length}`);

if (check && over.length > 0) process.exitCode = 2;
