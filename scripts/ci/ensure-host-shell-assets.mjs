#!/usr/bin/env node
/**
 * Publisher step: the shell files `host/` carries the bytes of are on the CDN
 * before any page that references them is pushed (site issue 12270).
 *
 * The pages rendered here take their chrome from `host/`, a transported copy of
 * the site's shell. One of its references is content-addressed —
 * `/assets/gtag-init-<hash>.js`, named after GTAG_INIT_CONTENT — so its name
 * changes whenever the site changes those bytes, and the object reaches the
 * CDN only with a full deploy of the site, hours after the contract can land
 * here. On 2026-10-07 the site's own fast emitters published that reference
 * before the file existed: every re-rendered article page loaded a 404 in
 * place of its static GA4 page_view for 2 h 40 min.
 *
 * This repository can publish exactly the files whose content it holds: today
 * the GA4 producer and derived byte-exact Ads/Partnerize snapshots exported by
 * scripts/ci/export-third-party-shell-assets.ts on the site. New HTML names their
 * hashes; the site's stable aliases remain available for older documents.
 * The decision itself — ask the CDN, read R2 only for a file it did not serve,
 * upload what R2 does not hold, never replace an object, stop when it cannot
 * tell — lives in scripts/lib/cdn-shell-assets.mjs, an identical twin of the
 * site's.
 *
 * Usage:
 *   npx -y tsx@4.23.15 scripts/ci/ensure-host-shell-assets.mjs
 *
 * Env: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_S3_ENDPOINT, R2_BUCKET — read
 *   by scripts/lib/upload-cdn-file.sh, and only for a file the CDN did not serve.
 * Exit: 0 when every file is available, 1 otherwise (nothing may be pushed).
 */
import { realpathSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { URL as NodeURL } from 'node:url';
import { fileURLToPath } from 'node:url';

import { ADSENSE_LOADER_FILENAME, PARTNERIZE_TAG_FILENAME, GTAG_INIT_CONTENT, GTAG_INIT_VERSIONED_FILENAME } from '../../host/constants.ts';
import { ensureCdnShellAssets, shellAssetsFromStaticScripts } from '../lib/cdn-shell-assets.mjs';

/** [name, content] of every shell file whose bytes `host/` holds. */
export function hostShellFiles(snapshot = JSON.parse(readFileSync(new NodeURL('../../host/third-party-shell-assets.json', import.meta.url), 'utf8'))) {
  // Bind availability to the very filenames used by the HTML, not to whatever
  // subset or alternate names an otherwise hash-valid snapshot happens to hold.
  const required = new Set([ADSENSE_LOADER_FILENAME, PARTNERIZE_TAG_FILENAME]);
  if (!Array.isArray(snapshot?.assets)) throw new Error('Transported asset set mismatch');
  const names = new Set(snapshot.assets.map((asset) => asset?.name));
  if (snapshot.assets.length !== required.size || names.size !== required.size || [...required].some((name) => !names.has(name))) {
    throw new Error('Transported asset set mismatch');
  }
  const assets = snapshot.assets.map(({ name, content, sha256 }) => {
    const actual = createHash('sha256').update(content).digest('hex');
    if (actual !== sha256 || !name.includes(actual.slice(0, 12))) throw new Error(`Transported asset hash mismatch: ${name}`);
    return [name, content];
  });
  return [[GTAG_INIT_VERSIONED_FILENAME, GTAG_INIT_CONTENT], ...assets];
}

export async function main({ ensure = ensureCdnShellAssets, listFiles = hostShellFiles } = {}) {
  return ensure({ assets: shellAssetsFromStaticScripts(listFiles()) });
}

const invokedDirectly = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] || '');
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`::error::[host-shell-assets] ${error.message}`);
    process.exit(1);
  });
}
