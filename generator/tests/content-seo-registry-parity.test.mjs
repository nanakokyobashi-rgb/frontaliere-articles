/**
 * Content gate: every active article registry id has exactly one SEO entry,
 * and every SEO entry belongs to the active registry of the same section.
 *
 * This reads the real `content/` tree on purpose.  A sparse checkout is not a
 * valid green state for this gate: the content-gates preflight is responsible
 * for rejecting it before this test can report an empty corpus.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECTIONS, seoFilesFor } from '../../scripts/lib/article-surfaces.mjs';
import { scanTopLevelArticleRecords } from '../../scripts/lib/article-registry-reader.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readIfPresent(rel) {
  const file = path.join(ROOT, rel);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function registryIds(source) {
  return scanTopLevelArticleRecords(source).map(({ id }) => id);
}

function seoIdCounts(sources) {
  const counts = new Map();
  for (const source of sources) {
    for (const match of source.matchAll(/^\s*'blog-([^']+)'\s*:\s*\{/gm)) {
      counts.set(match[1], (counts.get(match[1]) || 0) + 1);
    }
  }
  return counts;
}

function sectionReport(section, surface) {
  const registry = registryIds(readIfPresent(surface.registryFile));
  const seoFiles = seoFilesFor(section, ROOT);
  const seo = seoIdCounts(seoFiles.map(readIfPresent));
  const registrySet = new Set(registry);
  const seoSet = new Set(seo.keys());
  return {
    section,
    registryCount: registry.length,
    seoCount: [...seo.values()].reduce((sum, count) => sum + count, 0),
    missing: registry.filter((id) => !seoSet.has(id)),
    extra: [...seo.keys()].filter((id) => !registrySet.has(id)),
    duplicateRegistry: [...registrySet].filter((id) => registry.filter((candidate) => candidate === id).length > 1),
    duplicateSeo: [...seo].filter(([, count]) => count > 1).map(([id, count]) => `${id} (${count})`),
  };
}

test('registry e SEO sono allineati in entrambe le direzioni per ogni sezione attiva', () => {
  const reports = Object.entries(SECTIONS).map(([section, surface]) => sectionReport(section, surface));
  const failures = reports.flatMap((report) => [
    ...report.missing.map((id) => `${report.section}: SEO mancante per ${id}`),
    ...report.extra.map((id) => `${report.section}: SEO senza registro per ${id}`),
  ]);
  const measures = reports.map((report) => ({
    section: report.section,
    registryIds: report.registryCount,
    seoEntries: report.seoCount,
    missingIds: report.missing.length,
    extraIds: report.extra.length,
    duplicateRegistryIds: report.duplicateRegistry.length,
    duplicateSeoIds: report.duplicateSeo.length,
  }));

  assert.deepEqual(
    failures,
    [],
    `Parità registry/SEO violata. Misure per sezione: ${JSON.stringify(measures)}\n` +
      `Prime violazioni: ${failures.slice(0, 12).join('; ')}`,
  );
});
