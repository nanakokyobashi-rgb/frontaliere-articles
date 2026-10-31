#!/usr/bin/env node
/**
 * Keep `updatedAt` in the same commit as an edit to an existing article body.
 *
 * The body writers intentionally have different pipelines (FAQ batches,
 * evergreen refreshes, journalist imports, and the generated-article lane),
 * so the workflow boundary calls this one small, fail-closed stamp instead of
 * copying the registry rewrite into each producer.
 */
import '../../host/cantonSectionsBootstrap.mjs';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARTICLE_SECTION_CORE_ALL } from '../../engine/shared/articleSectionCore.mjs';
import { sectionSourceSurfaces } from '../lib/corpus-sections.mjs';
import {
  readRegistrySources,
  stampChangedBodyFiles,
} from '../lib/content-updated-at.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const allSections = Object.keys(ARTICLE_SECTION_CORE_ALL).map(sectionSourceSurfaces);
const statusText = execSync('git status --porcelain=v1 --untracked-files=all', {
  cwd: ROOT,
  encoding: 'utf8',
});
const registrySources = readRegistrySources(ROOT, allSections);
const result = stampChangedBodyFiles({
  sections: allSections,
  statusText,
  registrySources,
});

for (const section of allSections) {
  const id = section.section;
  const source = result.sources[id];
  if (source === undefined || source === registrySources[id]) continue;
  writeFileSync(path.join(ROOT, section.registryFile), source);
}

console.log(
  `[stamp-content-updated-at] considered=${result.considered} changed=${result.changed.length}`,
);
for (const change of result.changed) {
  console.log(`[stamp-content-updated-at] ${change.section}/${change.id} -> ${change.updatedAt}`);
}
