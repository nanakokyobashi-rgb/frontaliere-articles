#!/usr/bin/env node
/** Backfill `updatedAt` from real post-publication body commits. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARTICLE_SECTION_CORE_ALL } from '../../engine/shared/articleSectionCore.mjs';
import { sectionSourceSurfaces } from '../lib/corpus-sections.mjs';
import {
  applyRegistryUpdatedAt,
  enrichRegistriesFromHistory,
  parseContentHistory,
  readContentHistory,
  readRegistrySources,
} from '../lib/content-updated-at.mjs';
import { readTopLevelString, scanTopLevelArticleRecords } from '../lib/article-registry-reader.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const allSections = Object.keys(ARTICLE_SECTION_CORE_ALL)
  .map(sectionSourceSurfaces)
  .filter((section) => existsSync(path.join(ROOT, section.registryFile)));
const history = process.env.CONTENT_HISTORY_FROM_STDIN === '1'
  ? parseContentHistory(readFileSync(0, 'utf8'))
  : readContentHistory({ root: ROOT, sections: allSections });
const sources = readRegistrySources(ROOT, allSections);
const registries = {};
for (const section of allSections) {
  const source = sources[section.section];
  if (source === undefined) continue;
  registries[section.section] = scanTopLevelArticleRecords(source).map((record) => {
    const entry = { id: record.id };
    for (const key of ['date', 'updatedAt']) {
      const value = readTopLevelString(record, key);
      if (value !== null) entry[key] = value;
    }
    return entry;
  });
}

const enriched = enrichRegistriesFromHistory(registries, allSections, history);
const bySection = new Map(
  enriched.changed.map((change) => [
    change.section,
    enriched.changed.filter((entry) => entry.section === change.section),
  ]),
);
let total = 0;
for (const section of allSections) {
  const changes = bySection.get(section.section);
  if (!changes?.length) continue;
  const values = new Map(changes.map((change) => [change.id, change.updatedAt]));
  const current = sources[section.section];
  const { source } = applyRegistryUpdatedAt(current, values);
  if (source !== current) writeFileSync(path.join(ROOT, section.registryFile), source);
  total += changes.length;
  console.log(`[backfill-content-updated-at] ${section.section}: ${changes.length}`);
}
console.log(`[backfill-content-updated-at] updated=${total}`);
