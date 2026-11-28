#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sectionApiSurfaces } from '../../scripts/lib/corpus-sections.mjs';
import { REWIRE_FETCH_HEADERS } from './lib/rewire-fetch.mjs';
import { resolveStagedCantonSitemap, sitemapContainsUrls, waitForSitemapReadiness } from './lib/canton-hubs/sitemap-readiness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const verifier = path.join(ROOT, 'generator/scripts/verify-canton-hub-links.mjs');

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

const sections = option('--section', '');
const timeoutSeconds = Number(option('--timeout-seconds', '600'));
const intervalSeconds = Number(option('--interval-seconds', '20'));
if (!sections) throw new Error('--section e\' obbligatorio');
if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) throw new Error('--timeout-seconds deve essere un intero positivo');
if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1) throw new Error('--interval-seconds deve essere un intero positivo');

const siteOrigin = (process.env.SITE_ORIGIN || 'https://frontaliereticino.ch').replace(/\/$/, '');

function loadPublisherSitemaps() {
  const artifactDir = process.env.PUBLISH_API_ARTIFACT_DIR;
  if (!artifactDir) throw new Error('PUBLISH_API_ARTIFACT_DIR assente: serve l\'artefatto del publisher');
  const manifest = JSON.parse(readFileSync(path.join(artifactDir, 'manifest.json'), 'utf8'));
  const edgeRegistryPath = path.join(artifactDir, 'edge/sections/registry.json');
  const edgeRegistryText = existsSync(edgeRegistryPath) ? readFileSync(edgeRegistryPath, 'utf8') : null;
  const staged = sections.split(',').map((section) => section.trim()).filter(Boolean).map((section) => {
    const sitemapFile = sectionApiSurfaces(section).sitemap;
    const sitemapPath = path.join(artifactDir, sitemapFile);
    const sitemapXml = existsSync(sitemapPath) ? readFileSync(sitemapPath, 'utf8') : null;
    return resolveStagedCantonSitemap({ section, manifest, edgeRegistryText, sitemapFile, sitemapXml });
  });
  const live = staged.filter((entry) => entry.status === 'live');
  const liveSections = live.map((entry) => entry.section);
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error('GITHUB_OUTPUT assente: impossibile passare le sezioni live al verifier');
  appendFileSync(output, `live-sections=${liveSections.join(',')}\nlive-count=${liveSections.length}\n`);
  console.log(`[sitemap-readiness] release publisher: ${liveSections.length} live, ${staged.length - liveSections.length} intenzionalmente non pubbliche`);
  return live;
}

async function readPublicSitemap(file, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(timeoutMs, 30_000)));
  try {
    const response = await fetch(`${siteOrigin}/${file}`, {
      headers: { ...REWIRE_FETCH_HEADERS, accept: 'application/xml,text/xml,*/*' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function stagedSitemapsArePublished(stagedSitemaps, remainingMs) {
  const results = await Promise.all(stagedSitemaps.map(async ({ section, sitemapFile, urls }) => {
    const xml = await readPublicSitemap(sitemapFile, remainingMs);
    const result = sitemapContainsUrls(xml, urls);
    return result.ready
      ? null
      : `${section}/${sitemapFile}: URL publisher ancora assenti (${result.missing.slice(0, 8).join(', ')})`;
  }));
  const missing = results.filter(Boolean);
  return missing.length > 0 ? { ready: false, reason: missing.join('; ') } : { ready: true };
}

try {
  const stagedSitemaps = loadPublisherSitemaps();
  if (stagedSitemaps.length === 0) {
    console.log(`[sitemap-readiness] tutte le sezioni target sono draft/retired nell'artefatto publisher; nessuna URL pubblica attesa`);
    process.exit(0);
  }
  console.log(`[sitemap-readiness] ${stagedSitemaps.reduce((count, entry) => count + entry.urls.length, 0)} URL canoniche da artefatto publisher in ${stagedSitemaps.length} sitemap live`);
  const deadline = Date.now() + timeoutSeconds * 1000;
  const result = await waitForSitemapReadiness({
    timeoutMs: timeoutSeconds * 1000,
    intervalMs: intervalSeconds * 1000,
    probe: async ({ remainingMs, attempt }) => {
      console.log(`[sitemap-readiness] verifica ${attempt}, budget residuo ${Math.ceil(remainingMs / 1000)}s`);
      const liveRemainingMs = Math.max(0, deadline - Date.now());
      if (liveRemainingMs <= 0) return { ready: false, reason: 'deadline esaurita' };
      const sitemapReadiness = await stagedSitemapsArePublished(stagedSitemaps, liveRemainingMs);
      if (!sitemapReadiness.ready) return sitemapReadiness;
      const liveSections = stagedSitemaps.map((entry) => entry.section).join(',');
      const run = spawnSync(process.execPath, [verifier, '--section', liveSections], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        timeout: Math.max(1, deadline - Date.now()),
      });
      if (run.stdout) process.stdout.write(run.stdout);
      if (run.stderr) process.stderr.write(run.stderr);
      if (run.error) return { ready: false, reason: run.error.message };
      if (run.status === 0) return { ready: true };
      return { ready: false, reason: `verify-canton-hub-links exit=${run.status ?? run.signal ?? 'unknown'}` };
    },
  });
  console.log(`[sitemap-readiness] ready=1 attempts=${result.attempts} sections=${stagedSitemaps.map((entry) => entry.section).join(',')}`);
} catch (error) {
  console.error(`::error::[sitemap-readiness] ${error.message}`);
  process.exitCode = 1;
}
