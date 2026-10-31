/**
 * Derive the article-registry freshness signal from the history of the body
 * files.
 *
 * `updatedAt` means that an article body changed.  It is deliberately not
 * inferred from the registry commit itself: the registry is often rewritten
 * by a batch writer after the body change, and the extraction commit copied
 * the old corpus without changing any article text.  Keeping the history
 * reader and the registry rewriter here gives the publisher and body-writing
 * workflows one definition of the signal.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { readTopLevelString, scanTopLevelArticleRecords } from './article-registry-reader.mjs';

/** The package extraction copied the corpus but was not an editorial edit. */
export const CONTENT_EXTRACTION_COMMIT = '046d940280245c0c587acb4872a74a6838c1b307c';

const LOCALE_RE = /^(?:it|en|de|fr)$/u;
const HISTORY_HEADER_RE = /^([0-9a-f]{7,40})\t(\S+)$/u;

function sectionId(section) {
  return section?.section ?? section?.id ?? '';
}

function sectionBodyDir(section) {
  const dir = String(section?.bodyDir ?? '');
  return dir.endsWith('/') ? dir.slice(0, -1) : dir;
}

function sectionRegistryFile(section) {
  return String(section?.registryFile ?? '').replace(/\/$/u, '');
}

/**
 * Parse `git log --format='%H%x09%cI' --name-only` output.
 *
 * Git emits newest commits first.  Therefore the first occurrence of a body
 * path is its latest content commit; a commit may own several paths and all
 * of them inherit the same timestamp.
 *
 * @param {string} text
 * @returns {Map<string, {commit: string, committedAt: string}>}
 */
export function parseContentHistory(text) {
  const latestByPath = new Map();
  let current = null;
  for (const rawLine of String(text ?? '').split(/\r?\n/u)) {
    const line = rawLine.trim();
    const header = HISTORY_HEADER_RE.exec(line);
    if (header) {
      current = {
        commit: header[1],
        committedAt: header[2],
        ignored: header[1] === CONTENT_EXTRACTION_COMMIT,
      };
      continue;
    }
    if (!current || current.ignored || line === '' || line.startsWith('(')) continue;
    if (!latestByPath.has(line)) {
      latestByPath.set(line, {
        commit: current.commit,
        committedAt: current.committedAt,
      });
    }
  }
  return latestByPath;
}

/** Build the command used by the publisher and the backfill CLI. */
export function contentHistoryCommand(sections) {
  const bodyDirs = [...new Set((sections ?? []).map(sectionBodyDir).filter(Boolean))].sort();
  if (bodyDirs.length === 0) throw new Error('content history: nessuna cartella body configurata');
  // Exclude the extraction and its ancestors before asking Git for path
  // names. Besides encoding the semantic exception, this avoids streaming the
  // one 29k-file extraction commit through every publisher run.
  return `git log HEAD --format=%H%x09%cI --name-only --diff-filter=AM --no-renames --not ${CONTENT_EXTRACTION_COMMIT} -- ${bodyDirs.join(' ')}`;
}

/**
 * Read the complete body history.  `runGit` is injectable so tests can prove
 * the parser without depending on a checkout or a large child-process buffer.
 */
export function readContentHistory({ root, sections, runGit } = {}) {
  const cwd = root ?? process.cwd();
  const run = runGit ?? ((command, commandRoot) => execSync(command, {
    cwd: commandRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  }));
  const output = run(contentHistoryCommand(sections), cwd);
  return parseContentHistory(output);
}

function bodyPathOwner(relPath, sections) {
  const candidates = (sections ?? [])
    .map((section) => ({ section, dir: sectionBodyDir(section) }))
    .filter(({ dir }) => dir && (relPath === dir || relPath.startsWith(`${dir}/`)))
    .sort((a, b) => b.dir.length - a.dir.length);
  const owner = candidates[0];
  if (!owner) return null;
  const match = new RegExp(`^${owner.dir.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/([^/]+)/([^/]+)\\.ts$`, 'u').exec(relPath);
  if (!match || !LOCALE_RE.test(match[1])) return null;
  return { section: owner.section, locale: match[1], id: match[2] };
}

function newer(left, right) {
  const leftMs = Date.parse(left?.committedAt ?? left ?? '');
  const rightMs = Date.parse(right?.committedAt ?? right ?? '');
  if (Number.isNaN(leftMs)) return right;
  if (Number.isNaN(rightMs)) return left;
  return leftMs >= rightMs ? left : right;
}

/**
 * Reduce per-locale body history to one latest commit per article and section.
 *
 * @param {Map<string, {commit: string, committedAt: string}>} history
 * @param {Array<{section?: string, bodyDir: string}>} sections
 * @returns {Map<string, Map<string, {commit: string, committedAt: string}>>}
 */
export function latestContentUpdatesBySection(history, sections) {
  const updates = new Map((sections ?? []).map((section) => [sectionId(section), new Map()]));
  for (const [relPath, commit] of history ?? []) {
    const owner = bodyPathOwner(relPath, sections);
    if (!owner) continue;
    const sectionUpdates = updates.get(sectionId(owner.section));
    if (!sectionUpdates) continue;
    sectionUpdates.set(owner.id, newer(sectionUpdates.get(owner.id), commit));
  }
  return updates;
}

function isPublishedBefore(candidate, published) {
  const candidateMs = Date.parse(candidate?.committedAt ?? '');
  const publishedMs = Date.parse(published ?? '');
  if (Number.isNaN(candidateMs) || Number.isNaN(publishedMs)) return false;
  // A generation commit is normally a few seconds after the registry date,
  // because the workflow commits the already-rendered article. Compare the
  // calendar day for the historical backfill so that first publication is not
  // misclassified as a later edit. Workflow stamps use the exact timestamp
  // below because they only receive already tracked body files.
  return new Date(candidateMs).toISOString().slice(0, 10)
    > new Date(publishedMs).toISOString().slice(0, 10);
}

function isTimestampAfter(candidate, published) {
  const candidateMs = Date.parse(candidate?.committedAt ?? '');
  const publishedMs = Date.parse(published ?? '');
  return !Number.isNaN(candidateMs) && !Number.isNaN(publishedMs) && candidateMs > publishedMs;
}

function shouldReplace(current, candidate) {
  if (!current) return true;
  const currentMs = Date.parse(current);
  const candidateMs = Date.parse(candidate);
  return Number.isNaN(currentMs) || (!Number.isNaN(candidateMs) && candidateMs > currentMs);
}

function calendarDay(value) {
  const ms = Date.parse(value ?? '');
  return Number.isNaN(ms) ? null : new Date(ms).toISOString().slice(0, 10);
}

/**
 * Enrich loaded registry arrays without mutating the TypeScript module values.
 * A candidate is accepted only when the body commit is strictly after the
 * publication timestamp; existing fresher values are preserved.
 */
export function enrichRegistriesFromHistory(registriesBySection, sections, history) {
  const latest = latestContentUpdatesBySection(history, sections);
  const enriched = { ...(registriesBySection ?? {}) };
  const changed = [];
  for (const section of sections ?? []) {
    const id = sectionId(section);
    const registry = Array.isArray(enriched[id]) ? enriched[id] : [];
    const sectionUpdates = latest.get(id) ?? new Map();
    enriched[id] = registry.map((article) => {
      const candidate = sectionUpdates.get(article?.id);
      if (!candidate || !isPublishedBefore(candidate, article?.date)) return article;
      const updatedAt = calendarDay(candidate.committedAt);
      if (!updatedAt || !shouldReplace(article?.updatedAt, updatedAt)) return article;
      changed.push({ section: id, id: article.id, updatedAt });
      return { ...article, updatedAt };
    });
  }
  return { registries: enriched, changed };
}

function escapeSingleQuoted(value) {
  return String(value).replace(/\\/gu, '\\\\').replace(/'/gu, "\\'");
}

function replaceTopLevelString(source, property, nextValue) {
  const raw = source.slice(property.valueStart, property.valueEnd);
  const leading = raw.match(/^\s*/u)?.[0] ?? '';
  const trailing = raw.match(/\s*$/u)?.[0] ?? '';
  return source.slice(0, property.valueStart)
    + leading
    + `'${escapeSingleQuoted(nextValue)}'`
    + trailing
    + source.slice(property.valueEnd);
}

function insertUpdatedAt(source, record, dateProperty, value) {
  const close = record.end - 1;
  const newline = source.indexOf('\n', dateProperty.valueEnd);
  const lineStart = source.lastIndexOf('\n', dateProperty.valueStart - 1) + 1;
  const indent = source.slice(lineStart, dateProperty.valueStart).match(/^[ \t]*/u)?.[0] ?? '';
  if (newline >= 0 && newline < close) {
    return source.slice(0, newline + 1)
      + `${indent}updatedAt: '${escapeSingleQuoted(value)}',\n`
      + source.slice(newline + 1);
  }
  const trailing = source.slice(0, close).match(/[ \t]*$/u)?.[0] ?? '';
  const insertAt = close - trailing.length;
  return source.slice(0, insertAt)
    + `, updatedAt: '${escapeSingleQuoted(value)}'`
    + source.slice(insertAt);
}

/** Apply only newer `updatedAt` values to registry TypeScript source. */
export function applyRegistryUpdatedAt(source, valuesById) {
  const text = String(source ?? '');
  let out = '';
  let last = 0;
  let changed = 0;
  const changedIds = [];
  for (const record of scanTopLevelArticleRecords(text)) {
    const candidate = valuesById?.get(record.id);
    if (!candidate) continue;
    const current = readTopLevelString(record, 'updatedAt');
    if (!shouldReplace(current, candidate)) continue;
    const updatedAtProperty = record.properties.get('updatedAt');
    const next = updatedAtProperty
      ? replaceTopLevelString(text.slice(record.start, record.end), {
        ...updatedAtProperty,
        valueStart: updatedAtProperty.valueStart - record.start,
        valueEnd: updatedAtProperty.valueEnd - record.start,
      }, candidate)
      : (() => {
        const dateProperty = record.properties.get('date');
        if (!dateProperty) throw new Error(`registry ${record.id}: campo date mancante`);
        return insertUpdatedAt(text.slice(record.start, record.end), {
          ...record,
          start: 0,
          end: record.end - record.start,
        }, {
          ...dateProperty,
          valueStart: dateProperty.valueStart - record.start,
          valueEnd: dateProperty.valueEnd - record.start,
        }, candidate);
      })();
    out += text.slice(last, record.start) + next;
    last = record.end;
    changed += 1;
    changedIds.push(record.id);
  }
  out += text.slice(last);
  return { source: out, changed, changedIds };
}

/** Parse `git status --porcelain=v1 --untracked-files=all` body paths. */
export function parseChangedBodyPaths(statusText) {
  const changes = [];
  for (const line of String(statusText ?? '').split(/\r?\n/u)) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    let relPath = line.slice(3).trim();
    if (!relPath) continue;
    if (code.includes('R') && relPath.includes(' -> ')) relPath = relPath.split(' -> ').at(-1);
    changes.push({ code, path: relPath });
  }
  return changes;
}

/**
 * Stamp existing body files changed in the current working tree. Added body
 * files are intentionally skipped: their publication date already describes
 * their first publication and `updatedAt` is reserved for later text edits.
 *
 * @param {{sections: Array, statusText: string, registrySources: Record<string,string>, stamp?: string}} input
 */
export function stampChangedBodyFiles({ sections, statusText, registrySources, stamp = new Date().toISOString() }) {
  const bodyChanges = parseChangedBodyPaths(statusText)
    .filter(({ code }) => !code.includes('A') && !code.includes('?') && code.includes('M'));
  const idsBySection = new Map();
  const stampTimestamp = String(stamp);
  const stampDay = calendarDay(stamp);
  if (!stampDay) throw new Error(`stamp updatedAt non valido: ${JSON.stringify(stamp)}`);
  for (const change of bodyChanges) {
    const owner = bodyPathOwner(change.path, sections);
    if (!owner) continue;
    const id = sectionId(owner.section);
    if (!idsBySection.has(id)) idsBySection.set(id, new Map());
    idsBySection.get(id).set(owner.id, stampTimestamp);
  }

  const sources = { ...(registrySources ?? {}) };
  const changed = [];
  for (const section of sections ?? []) {
    const id = sectionId(section);
    const values = idsBySection.get(id);
    if (!values) continue;
    const source = sources[id];
    if (typeof source !== 'string') throw new Error(`${id}: registry source mancante per lo stamp del body`);
    const records = new Map(scanTopLevelArticleRecords(source).map((record) => [record.id, record]));
    const eligible = new Map();
    for (const [articleId, candidate] of values) {
      const record = records.get(articleId);
      if (!record) throw new Error(`${id}/${articleId}: body modificato senza voce nel registry`);
      const published = readTopLevelString(record, 'date');
      if (isTimestampAfter({ committedAt: candidate }, published)) eligible.set(articleId, stampDay);
    }
    if (eligible.size === 0) continue;
    const applied = applyRegistryUpdatedAt(source, eligible);
    sources[id] = applied.source;
    for (const articleId of applied.changedIds) changed.push({ section: id, id: articleId, updatedAt: stampDay });
  }
  return { sources, changed, considered: bodyChanges.length };
}

/** Read registry files for a set of section descriptors. */
export function readRegistrySources(root, sections) {
  const sources = {};
  for (const section of sections ?? []) {
    const file = sectionRegistryFile(section);
    if (!file) continue;
    const absolute = path.join(root ?? process.cwd(), file);
    try {
      sources[sectionId(section)] = readFileSync(absolute, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
  }
  return sources;
}
