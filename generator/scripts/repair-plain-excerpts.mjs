#!/usr/bin/env node

/**
 * Deterministic historical repair for reader-facing excerpts and SEO text.
 * It uses an existing sentence boundary, a complete sibling description for
 * the same record, or exact sentences from that article's body. Fields with
 * no safe source are left unchanged and reported.
 *
 * Usage:
 *   node scripts/repair-plain-excerpts.mjs          # report only
 *   node scripts/repair-plain-excerpts.mjs --write  # apply safe repairs
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportStrippedControlChars } from './lib/control-char-write-report.mjs';
import { sanitizeText } from '../../scripts/lib/sanitize-control-chars.mjs';
import { writeFileSnapshotAtomically } from '../../scripts/lib/write-file-pair-atomically.mjs';
import { assertNoExcerptCompletenessRegression } from '../../scripts/lib/excerpt-completeness-gate.mjs';
import {
  assertPlainExcerpt,
  endsWithFunctionWordBeforePeriod,
  endsWithSentenceAbbreviation,
  findDescriptionDefects,
  isCompleteSourceCandidate,
  isFinalTerminatorOnlyChange,
  isSemanticallyCompatibleSibling,
  maximumDescriptionLength,
  minimumDescriptionLength,
  repairExcerptFromOriginal,
  selectCompleteExcerptSource,
} from './lib/article-excerpt.mjs';
import {
  decodeTypeScriptString,
  escapeForSingleQuoteTS,
  unescapeForSingleQuoteTS,
} from './lib/article-meta-block.mjs';
import { readTsStringMap } from './lib/ts-string-map.mjs';
import { assertSeoDescriptionMinimum } from './lib/seo-description-contract.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const BASELINE_PATH = path.join(repoRoot, 'scripts/ci/excerpt-completeness-baseline.json');
const bodyMapCache = new Map();
const bodyTextCache = new Map();
const SIBLING_DESCRIPTION_FIELDS = new Set([
  'description',
  'excerpt',
  'ogDescription',
  'seoDescription',
  'structuredData.description',
]);
const allBodyRoots = readdirSync(path.join(repoRoot, 'content'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('blog-body'))
  .map((entry) => path.join('content', entry.name));

function decodeDoubleQuotedTS(value) {
  return decodeTypeScriptString(value, '"');
}

function atomicWrite(file, before, after) {
  const clean = sanitizeText(after);
  reportStrippedControlChars(file, after, clean);
  writeFileSnapshotAtomically(file, before, clean);
}

function structuredDataBlocks(source) {
  const blocks = [];
  for (const match of source.matchAll(/(?:^|[,{])[ \t]*(?:structuredData|["']structuredData["'])\s*:/gmu)) {
    let start = match.index + match[0].length;
    while (/\s/u.test(source[start] || '')) start += 1;
    const opening = source[start];
    if (opening !== '{' && opening !== '[') continue;
    const stack = [opening === '{' ? '}' : ']'];
    let quote = null;
    for (let index = start + 1; index < source.length; index += 1) {
      const character = source[index];
      if (quote) {
        if (character === '\\') index += 1;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'" || character === '`') {
        quote = character;
        continue;
      }
      if (character === '/' && source[index + 1] === '/') {
        const end = source.indexOf('\n', index + 2);
        index = end < 0 ? source.length : end;
        continue;
      }
      if (character === '/' && source[index + 1] === '*') {
        const end = source.indexOf('*/', index + 2);
        index = end < 0 ? source.length : end + 1;
        continue;
      }
      if (character === '{') stack.push('}');
      else if (character === '[') stack.push(']');
      else if (character === '}' || character === ']') {
        if (stack.at(-1) !== character) break;
        stack.pop();
        if (stack.length === 0) {
          blocks.push(source.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return blocks;
}

function assertDecodedStructuredDataIsSafe(file, source) {
  for (const block of structuredDataBlocks(source)) {
    for (const match of block.matchAll(/(")((?:[^"\\]|\\.)*)(")/gu)) {
      const decoded = decodeDoubleQuotedTS(match[2]);
      const clean = sanitizeText(decoded);
      reportStrippedControlChars(file, decoded, clean);
    }
  }
}

function sectionForMeta(file) {
  if (file.startsWith('blog-meta-canton-')) return 'cantonale';
  if (file.startsWith('blog-meta-ch-')) return 'svizzera';
  return 'frontaliere';
}

function localeForMeta(file) {
  return file.match(/-(it|en|de|fr)\.ts$/)?.[1] ?? 'unknown';
}

function addRecordSource(sourceMap, locale, id, source) {
  const key = locale + '\0' + id;
  sourceMap.set(key, [...(sourceMap.get(key) ?? []), source]);
}

function sourcesForRecord(sourceMap, locale, id) {
  return sourceMap.get(locale + '\0' + id) ?? [];
}

function buildRecordSourceMap({ allMetaFiles, seoFiles, cantonSeoFiles }) {
  const sourceMap = new Map();
  for (const relativeFile of allMetaFiles) {
    const locale = localeForMeta(path.basename(relativeFile));
    const fields = readTsStringMap(readFileSync(path.join(repoRoot, relativeFile), 'utf8'));
    for (const [key, value] of fields) {
      const match = key.match(/^blog\.article\.([^.]+)\.(title|excerpt|seoDescription|ogDescription)$/u);
      if (match) addRecordSource(sourceMap, locale, match[1], { file: relativeFile, field: match[2], value });
    }
  }

  for (const relativeFile of [...seoFiles, ...cantonSeoFiles]) {
    const source = readFileSync(path.join(repoRoot, relativeFile), 'utf8');
    const entries = [...source.matchAll(/^[ \t]*'blog-([^']+)':\s*\{/gmu)];
    const idForOffset = (offset) => {
      let id = entries[0]?.[1] ?? 'unknown';
      for (const entry of entries) {
        if (entry.index > offset) break;
        id = entry[1];
      }
      return id;
    };
    for (const match of source.matchAll(/^[ \t]*(description|ogDescription)(:\s*')((?:[^'\\]|\\.)*)(')/gmu)) {
      addRecordSource(sourceMap, 'it', idForOffset(match.index), {
        file: relativeFile,
        field: match[1],
        value: decodeTypeScriptString(match[3], "'"),
      });
    }
    for (const match of source.matchAll(/^[ \t]*"description"(\s*:\s*")((?:[^"\\]|\\.)*)(")/gmu)) {
      addRecordSource(sourceMap, 'it', idForOffset(match.index), {
        file: relativeFile,
        field: 'structuredData.description',
        value: decodeDoubleQuotedTS(match[2]),
      });
    }
  }
  return sourceMap;
}

function bodyRootsForSource(relativeFile) {
  const preferred = [];
  const cantonMeta = path.basename(relativeFile).match(/^blog-meta-canton-(.+)-(?:it|en|de|fr)\.ts$/);
  const cantonSeo = relativeFile.match(/^content\/cantons\/canton-([^/]+)\/seo\.ts$/);
  if (cantonMeta) preferred.push(`content/blog-body-canton-${cantonMeta[1]}`);
  if (cantonSeo) preferred.push(`content/blog-body-canton-${cantonSeo[1]}`);
  if (/blog-meta-ch-|seo-blog-ch/u.test(relativeFile)) preferred.push('content/blog-body-ch');
  preferred.push('content/blog-body');
  return [...new Set([...preferred, ...allBodyRoots])];
}

function articleBody(id, locale, relativeFile) {
  const roots = bodyRootsForSource(relativeFile);
  const cacheKey = `${roots[0]}\0${locale}\0${id}`;
  if (bodyTextCache.has(cacheKey)) return bodyTextCache.get(cacheKey);
  const prefix = `blog.article.${id}.`;
  for (const root of roots) {
    const relativeBodyFile = path.join(root, locale, `${id}.ts`);
    const absoluteBodyFile = path.join(repoRoot, relativeBodyFile);
    if (!existsSync(absoluteBodyFile)) continue;
    let fields = bodyMapCache.get(relativeBodyFile);
    if (!fields) {
      fields = readTsStringMap(readFileSync(absoluteBodyFile, 'utf8'));
      bodyMapCache.set(relativeBodyFile, fields);
    }
    const body = [...fields.entries()]
      .filter(([key]) => key.startsWith(prefix) && /^body\d+$/u.test(key.slice(prefix.length)))
      .sort(([left], [right]) => Number(left.slice(prefix.length + 4)) - Number(right.slice(prefix.length + 4)))
      .map(([, text]) => text);
    if (body.length > 0) {
      bodyTextCache.set(cacheKey, body);
      return body;
    }
  }
  bodyTextCache.set(cacheKey, []);
  return [];
}

function repairValue(value, context, recordSources = []) {
  const body = articleBody(context.id, context.locale, context.file);
  const title = context.title ?? recordSources.find((source) => source.field === 'title')?.value ?? '';
  const defects = findDescriptionDefects(value, {
    locale: context.locale,
    field: context.field,
    body,
  });
  if (defects.length === 0) return { value, changed: false, defects: [], strategy: null };
  const maxLength = maximumDescriptionLength(context.field);
  const minLength = minimumDescriptionLength(context.field);
  const result = repairExcerptFromOriginal(value, {
    body,
    field: context.field,
    locale: context.locale,
    title,
    maxLength,
    minLength,
    listOnlyBody: true,
  });
  let repaired = result.value;
  let strategy = result.strategy;
  let source = strategy === 'a'
    ? 'existing-sentence'
    : strategy === 'b'
      ? 'article-body'
      : strategy === 'd' ? 'terminal-punctuation' : null;

  if (['a', 'b', 'd'].includes(strategy) && !isCompleteSourceCandidate(repaired, {
    locale: context.locale,
    field: context.field,
    maxLength,
    minLength,
    body,
  })) {
    repaired = value;
    strategy = 'c';
    source = null;
  }
  if (strategy === 'c') {
    for (const recordSource of recordSources) {
      if (!SIBLING_DESCRIPTION_FIELDS.has(recordSource.field)) continue;
      if (recordSource.file === context.file && recordSource.field === context.field) continue;
      const candidate = selectCompleteExcerptSource(recordSource.value, {
        locale: context.locale,
        maxLength,
        minLength,
        body,
      });
      if (candidate === null) continue;
      if (!isSemanticallyCompatibleSibling(candidate, {
        target: value,
        title,
        body,
      })) continue;
      repaired = candidate;
      strategy = 'b';
      source = 'sibling-field';
      break;
    }
  }
  const changed = repaired !== value;
  if (changed) {
    assertPlainExcerpt(repaired, { ...context, body });
    if (['description', 'structuredData.description', 'seoDescription'].includes(context.field)) {
      assertSeoDescriptionMinimum(repaired, { id: context.id, sourceDescriptionLength: value.length });
    }
  }
  return { value: repaired, changed, defects, strategy, source };
}

function repairMetaFile(relativeFile, { writeMode = false, sourceMap } = {}) {
  const file = path.join(repoRoot, relativeFile);
  const before = readFileSync(file, 'utf8');
  let after = before;
  let changed = 0;
  const details = [];
  const section = sectionForMeta(path.basename(relativeFile));
  const locale = localeForMeta(path.basename(relativeFile));
  // The field name is inside the quoted object key: `...excerpt': '...`.
  // Keeping the closing quote in the match is essential; without it this
  // historical repair scans zero values and can report a false green.
  const re = /(^[ \t]*'blog\.article\.([^']+)\.(excerpt|seoDescription|ogDescription)'\s*:\s*')((?:[^'\\]|\\.)*)(')/gm;
  after = after.replace(re, (full, prefix, id, field, encoded, suffix) => {
    const value = unescapeForSingleQuoteTS(encoded);
    const result = repairValue(value, { file: relativeFile, field, id, locale }, sourcesForRecord(sourceMap, locale, id));
    if (!result.strategy) return full;
    if (result.changed) changed += 1;
    details.push({
      file: relativeFile,
      section,
      locale,
      id,
      field,
      strategy: result.strategy,
      source: result.source,
      defects: result.defects,
      before: value,
      after: result.value,
      removedChars: Math.max(0, value.length - result.value.length),
      addedChars: Math.max(0, result.value.length - value.length),
    });
    return result.changed ? `${prefix}${escapeForSingleQuoteTS(result.value)}${suffix}` : full;
  });
  if (after !== before && writeMode) atomicWrite(file, before, after);
  return { file: relativeFile, changed, details };
}

function repairSeoFile(relativeFile, { writeMode = false, sourceMap } = {}) {
  const file = path.join(repoRoot, relativeFile);
  const before = readFileSync(file, 'utf8');
  let after = before;
  let changed = 0;
  const details = [];
  const section = relativeFile.startsWith('content/cantons/')
    ? 'cantonale'
    : path.basename(relativeFile).includes('-ch') ? 'svizzera' : 'frontaliere';

  const entries = [...before.matchAll(/^[ \t]*'blog-([^']+)':\s*\{/gm)];
  const entryForOffset = (currentEntries, offset) => {
    let current = currentEntries[0]?.[1] ?? 'unknown';
    for (const entry of currentEntries) {
      if (entry.index > offset) break;
      current = entry[1];
    }
    return current;
  };
  const repair = (value, id, field) => {
    const result = repairValue(value, { file: relativeFile, field, id, locale: 'it' }, sourcesForRecord(sourceMap, 'it', id));
    if (result.strategy) {
      if (result.changed) changed += 1;
      details.push({
        file: relativeFile,
        section,
        locale: 'it',
        id,
        field,
        strategy: result.strategy,
        source: result.source,
        defects: result.defects,
        before: value,
        after: result.value,
        removedChars: Math.max(0, value.length - result.value.length),
        addedChars: Math.max(0, result.value.length - value.length),
      });
    }
    return result;
  };

  after = after.replace(/(^[ \t]*)(description|ogDescription)(:\s*')((?:[^'\\]|\\.)*)(')/gm, (full, indent, field, prefix, encoded, suffix, offset) => {
    const id = entryForOffset(entries, offset);
    const result = repair(unescapeForSingleQuoteTS(encoded), id, field);
    if (!result.changed) return full;
    return `${indent}${field}${prefix}${escapeForSingleQuoteTS(result.value)}${suffix}`;
  });

  const structuredEntries = [...after.matchAll(/^[ \t]*'blog-([^']+)':\s*\{/gm)];
  after = after.replace(/(^[ \t]*)"description"(\s*:\s*")((?:[^"\\]|\\.)*)(")/gm, (full, indent, prefix, encoded, suffix, offset) => {
    const id = entryForOffset(structuredEntries, offset);
    const result = repair(decodeDoubleQuotedTS(encoded), id, 'structuredData.description');
    if (!result.changed) return full;
    return `${indent}"description"${prefix}${JSON.stringify(result.value).slice(1, -1)}${suffix}`;
  });

  if (after !== before && writeMode) {
    assertDecodedStructuredDataIsSafe(file, after);
    atomicWrite(file, before, after);
  }
  return { file: relativeFile, changed, details };
}

function corpusSourceFiles() {
  const contentDir = path.join(repoRoot, 'content');
  const allMetaFiles = readdirSync(contentDir)
    .filter((name) => /^blog-meta-(?:canton-.+|ch-)?(?:it|en|de|fr)\.ts$/.test(name))
    .sort()
    .map((name) => path.join('content', name));
  const seoFiles = readdirSync(path.join(contentDir, 'seo'))
    .filter((name) => /^seo-blog(?:-ch)?(?:-\d+)?\.ts$/.test(name))
    .sort()
    .map((name) => path.join('content', 'seo', name));
  const cantonDir = path.join(contentDir, 'cantons');
  const cantonSeoFiles = existsSync(cantonDir)
    ? readdirSync(cantonDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join('content', 'cantons', entry.name, 'seo.ts'))
      .filter((relativeFile) => existsSync(path.join(repoRoot, relativeFile)))
      .sort()
    : [];
  return { allMetaFiles, seoFiles, cantonSeoFiles };
}

function summarize(results, mode) {
  const details = results.flatMap((result) => result.details);
  const repaired = details.filter((item) => ['a', 'b', 'd'].includes(item.strategy));
  const changedRepairs = repaired.filter((item) => item.before !== item.after);
  const samplePool = [...details];
  let randomState = 0x434f5250;
  const random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 0x100000000;
  };
  const sampleGroups = new Map();
  for (const item of samplePool) {
    const key = `${item.strategy}\0${item.locale}`;
    sampleGroups.set(key, [...(sampleGroups.get(key) ?? []), item]);
  }
  for (const group of sampleGroups.values()) {
    for (let index = group.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1));
      [group[index], group[other]] = [group[other], group[index]];
    }
  }
  const randomSamples = [];
  const strategies = ['a', 'b', 'c', 'd'];
  const locales = ['it', 'en', 'de', 'fr'];
  for (const strategy of strategies) {
    for (const locale of locales) {
      const group = sampleGroups.get(`${strategy}\0${locale}`);
      if (group?.length) randomSamples.push(group.shift());
    }
  }
  const fillOrder = strategies.flatMap((strategy) => locales.map((locale) => `${strategy}\0${locale}`));
  while (randomSamples.length < 20) {
    let added = false;
    for (const key of fillOrder) {
      const group = sampleGroups.get(key);
      if (!group?.length) continue;
      randomSamples.push(group.shift());
      added = true;
      if (randomSamples.length === 20) break;
    }
    if (!added) break;
  }
  return {
    mode,
    files: results.length,
    changedValues: changedRepairs.length,
    needsRepairValues: details.length,
    byStrategy: Object.fromEntries(['a', 'b', 'c', 'd'].map((strategy) => [
      strategy,
      details.filter((item) => item.strategy === strategy).length,
    ])),
    bySource: Object.fromEntries([...new Set(details.map((item) => item.source ?? 'unresolved'))].sort().map((source) => [
      source,
      details.filter((item) => (item.source ?? 'unresolved') === source).length,
    ])),
    removedChars: details.reduce((total, item) => total + item.removedChars, 0),
    addedChars: details.reduce((total, item) => total + item.addedChars, 0),
    dPunctuationOnlyViolations: changedRepairs.filter((item) => item.strategy === 'd'
      && !isFinalTerminatorOnlyChange(item.before, item.after)).length,
    functionWordPeriodViolations: changedRepairs.filter((item) => endsWithFunctionWordBeforePeriod(item.after, { locale: item.locale })).length,
    abbreviationEndingViolations: changedRepairs.filter((item) => endsWithSentenceAbbreviation(
      item.after,
      { locale: item.locale },
    )).length,
    minimumLengthViolations: changedRepairs.filter((item) =>
      item.after.trim().length < minimumDescriptionLength(item.field)).length,
    dBelowMinimumLength: changedRepairs.filter((item) => item.strategy === 'd'
      && item.after.trim().length < minimumDescriptionLength(item.field)).length,
    repairedLengthStats: (() => {
      const lengths = changedRepairs.map((item) => item.after.trim().length).sort((left, right) => left - right);
      return {
        count: lengths.length,
        minimum: lengths.length ? lengths[0] : null,
        percentile5: lengths.length ? lengths[Math.max(0, Math.ceil(lengths.length * 0.05) - 1)] : null,
      };
    })(),
    nonRepairable: details.filter((item) => item.strategy === 'c'),
    randomSamples: randomSamples.map(({ file, section, locale, id, field, strategy, before, after }) => ({
      file, section, locale, id, field, strategy, before, after,
    })),
    bySection: Object.fromEntries(['frontaliere', 'svizzera', 'cantonale'].map((section) => [
      section,
      details.filter((item) => item.section === section).length,
    ])),
    byField: Object.fromEntries([...new Set(details.map((item) => item.field))].sort().map((field) => [
      field,
      details.filter((item) => item.field === field).length,
    ])),
    details,
  };
}

/** Scan the full localized metadata and SEO surface without writing changes. */
export function inspectCorpusExcerptCompleteness({ writeMode = false } = {}) {
  const { allMetaFiles, seoFiles, cantonSeoFiles } = corpusSourceFiles();
  const sourceMap = buildRecordSourceMap({ allMetaFiles, seoFiles, cantonSeoFiles });
  const options = { writeMode, sourceMap };
  const results = [
    ...allMetaFiles.map((file) => repairMetaFile(file, options)),
    ...seoFiles.map((file) => repairSeoFile(file, options)),
    ...cantonSeoFiles.map((file) => repairSeoFile(file, options)),
  ];
  return summarize(results, writeMode ? 'write' : 'check');
}

function main(argv) {
  const writeMode = argv.includes('--write');
  const summary = inspectCorpusExcerptCompleteness({ writeMode });
  const printed = {
    ...summary,
    details: summary.details.slice(0, 20),
    detailsOmitted: Math.max(0, summary.details.length - 20),
  };
  console.log(JSON.stringify(printed, null, 2));
  if (!writeMode) {
    try {
      const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
      assertNoExcerptCompletenessRegression(summary.details, baseline);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
