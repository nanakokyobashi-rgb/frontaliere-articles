#!/usr/bin/env node
/**
 * backfill-image-credits.mjs — the credit records of the Commons covers that
 * existed before the generator started writing them (P14, data PR C2), and the
 * check that keeps them right afterwards.
 *
 * About 1,470 live articles carry a Wikimedia Commons cover whose ImageObject
 * says «© … Frontaliere Ticino. Tutti i diritti riservati». The generator now
 * credits every NEW Commons cover (`generator/scripts/lib/commons-credit.mjs`);
 * this script does the same, once, for the old ones — reviewably and
 * reproducibly, so a rebase can simply re-run it:
 *
 *   --fetch  ONLINE, and the only network step. Every Commons file behind a
 *            live cover of either usage map (plus every file a record already
 *            names), ≤50 titles per GET, serial, 1.5 s apart, `maxlag=5`, a
 *            descriptive User-Agent, Retry-After honoured
 *            (https://www.mediawiki.org/wiki/API:Etiquette). Writes
 *            `data/commons-credit-snapshot.json`. The probe measured the full
 *            run at 11 requests, about 19 s.
 *   --build  OFFLINE and deterministic. Snapshot + `data/image-credit-overrides.json`
 *            (human curation) + usage maps + registries + cover sizes →
 *            `content/image-credits/blog/<id>.json`; then removes the five
 *            rights fields from every SEO literal of a credited cover, and
 *            repoints the covers whose Commons file must be replaced. Exits 1
 *            while any file still needs a human (listed), without hiding the
 *            records it could build.
 *   --check  OFFLINE. The content gate's checks on the records on disk, the
 *            overrides file well-formed and applied, no credited cover's
 *            literal still claiming the photo, and — once the snapshot exists —
 *            a rebuild in memory identical to the tree.
 *
 * The overrides file (`data/image-credit-overrides.json`), schema 1:
 *
 *   { "schema": 1,
 *     "files": { "<Commons title>": {
 *         "decision": "replace" | "accept-restriction",   (optional)
 *         "replacement": "/images/…",                     (with replace: the new cover path)
 *         "author": { "text"?, "name"?, "url"?, "type"? },  (optional, merged)
 *         "attribution": "…" | null,                      (optional)
 *         "licence": { "name"?, "url"?, "family"?, "attributionRequired"? },  (optional, merged)
 *         "curation": { "by", "at", "note" } } },         (required with any of the above)
 *     "covers": { "<cover key>": { "modified": "cropped" | "resized" } } }
 *
 * `covers` carries the crop/resize verdict of the site-era covers, whose webp
 * files are not in this repository (computed once from the site's git blobs).
 * A file the rule sends to review becomes `ok` only when the overrides answer
 * every reason: a restriction needs `accept-restriction` (owner, Q1), a
 * licence needs `licence`, an author problem needs `author` or `attribution`.
 *
 * Usage: node scripts/backfill-image-credits.mjs --fetch|--build|--check [--root <dir>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMMONS_API,
  COMMONS_IMAGEINFO_PARAMS,
  COMMONS_USAGE_MAPS,
  COMMONS_USER_AGENT,
  assessCommonsFile,
  creditRecordPath,
  creditTemplate,
  finalizeCreditRecord,
  modifiedFor,
  readCommonsPage,
  titleFromCommonsUrl,
  utcDate,
  webpDimensions,
  writeCreditRecord,
} from '../generator/scripts/lib/commons-credit.mjs';
import {
  IMAGE_CREDIT_RECORDS_DIR,
  auditCreditRecords,
  canonicalJson,
  findCreditedRightsClaims,
  readCreditRecords,
  scanSeoImageBlocks,
  seoLiteralFiles,
  stripCreditedImageRights,
} from './lib/image-credit-records.mjs';
import {
  coverKey,
  isAllowedAuthorUrl,
  normaliseLicenceUrl,
  validateImageCreditRecord,
} from '../engine/shared/imageCredits.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SNAPSHOT_FILE = 'data/commons-credit-snapshot.json';
export const OVERRIDES_FILE = 'data/image-credit-overrides.json';
export const REGISTRY_FILES = Object.freeze(['content/blog-articles-data.ts', 'content/swiss-articles-data.ts']);
const COVERS_DIR = 'public/images/blog';
const BATCH_SIZE = 50;
const PAUSE_MS = 1500;
const MAX_RETRIES = 3;

// ── Inputs ─────────────────────────────────────────────────────────────────

function readJsonIfPresent(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

/** Writes a text file through temp + rename, so an interrupted run never leaves half a registry. */
function writeTextAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text, 'utf-8');
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * `id → image` of every registry row, read the way build-blog-index.mjs
 * reads them (a regex over the generator's own literal shape, no TS import).
 */
export function readRegistryImages(root) {
  /** @type {Map<string, string>} */
  const images = new Map();
  for (const rel of REGISTRY_FILES) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, 'utf-8');
    for (const m of src.matchAll(/\{\s*id:\s*'([^']+)'([\s\S]*?)\}/g)) {
      const image = m[2].match(/\bimage:\s*'([^']*)'/)?.[1];
      if (image && !images.has(m[1])) images.set(m[1], image);
    }
  }
  return images;
}

/**
 * The live Commons covers: an id of either usage map whose cover
 * `/images/blog/<id>.webp` some registry row shows — its own article, or
 * another one that reuses it (retirement keeps the webp, so a reused cover can
 * outlive the article it was made for, and its page still needs the credit).
 * The corpus map is read first, so it wins if an id ever appears in both.
 *
 * @returns {{ id: string, url: string, title: string }[]}
 */
export function liveCommonsCovers(root) {
  const shown = new Set([...readRegistryImages(root).values()].map((image) => coverKey(image)).filter(Boolean));
  const seen = new Set();
  const covers = [];
  for (const rel of COMMONS_USAGE_MAPS) {
    const map = readJsonIfPresent(path.join(root, rel)) ?? {};
    for (const [id, url] of Object.entries(map)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const title = titleFromCommonsUrl(url);
      if (title && shown.has(id)) covers.push({ id, url, title });
    }
  }
  return covers.sort((a, b) => a.id.localeCompare(b.id));
}

/** The snapshot, one Commons file per line so a refresh diffs file by file. */
export function serializeSnapshot(snapshot) {
  const { files, aliases, ...head } = snapshot;
  const headLines = Object.entries(head).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  const fileLines = Object.keys(files).sort().map((title) => `    ${JSON.stringify(title)}: ${JSON.stringify(files[title])}`);
  return `{\n${headLines.join('\n')}\n  "aliases": ${JSON.stringify(aliases ?? {})},\n  "files": {\n${fileLines.join(',\n')}\n  }\n}\n`;
}

// ── --fetch ────────────────────────────────────────────────────────────────

/**
 * Reads the Commons metadata of every file the backfill needs and writes the
 * snapshot. The network is injected (`fetchImpl`, `sleep`) so the etiquette
 * itself is testable without calling Commons.
 */
export async function fetchSnapshot({
  root = ROOT,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = new Date(),
  log = console.log,
} = {}) {
  const titles = new Set(liveCommonsCovers(root).map((c) => c.title));
  for (const { record } of readCreditRecords(root)) if (record?.commons?.title) titles.add(record.commons.title);
  const all = [...titles].sort();
  const files = {};
  const aliases = {};
  let requests = 0;
  let last = 0;
  for (let i = 0; i < all.length; i += BATCH_SIZE) {
    const batch = all.slice(i, i + BATCH_SIZE);
    const url = `${COMMONS_API}?action=query&format=json&formatversion=2&redirects=1&maxlag=5&${COMMONS_IMAGEINFO_PARAMS}`
      + `&titles=${encodeURIComponent(batch.map((t) => `File:${t}`).join('|'))}`;
    let json = null;
    for (let attempt = 0; ; attempt += 1) {
      const wait = Math.max(0, last + PAUSE_MS - Date.now());
      if (last && wait) await sleep(wait);
      last = Date.now();
      requests += 1;
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': COMMONS_USER_AGENT, 'Api-User-Agent': COMMONS_USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
      const body = await res.text();
      try { json = JSON.parse(body); } catch { json = null; }
      const lagged = json?.error?.code === 'maxlag';
      if ((res.status === 429 || res.status >= 500 || lagged) && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers?.get?.('retry-after') || 5);
        log(`[backfill] batch ${i / BATCH_SIZE}: HTTP ${res.status}${lagged ? ' maxlag' : ''}, retrying in ${retryAfter}s`);
        await sleep(retryAfter * 1000);
        continue;
      }
      if (!res.ok || !json || json.error) {
        throw new Error(`Commons API refused batch ${i / BATCH_SIZE}: HTTP ${res.status}${json?.error ? ` ${json.error.code}` : ''}`);
      }
      break;
    }
    const renamed = new Map();
    for (const n of json.query?.normalized ?? []) renamed.set(n.from.replace(/^File:/, ''), n.to.replace(/^File:/, ''));
    for (const r of json.query?.redirects ?? []) renamed.set(r.from.replace(/^File:/, ''), r.to.replace(/^File:/, ''));
    const pages = new Map((json.query?.pages ?? []).map((p) => [String(p.title).replace(/^File:/, ''), p]));
    for (const requested of batch) {
      let title = requested;
      for (let hops = 0; renamed.has(title) && hops < 5; hops += 1) title = renamed.get(title);
      if (title !== requested) aliases[requested] = title;
      const page = pages.get(title);
      const { title: _ignored, ...entry } = readCommonsPage(page ?? { title, missing: true });
      void _ignored;
      files[title] = entry;
    }
    log(`[backfill] batch ${i / BATCH_SIZE}: ${batch.length} titles`);
  }
  const snapshot = { schema: 1, fetchedAt: utcDate(now), requests, imageinfoParams: COMMONS_IMAGEINFO_PARAMS, files, aliases };
  fs.mkdirSync(path.dirname(path.join(root, SNAPSHOT_FILE)), { recursive: true });
  writeTextAtomic(path.join(root, SNAPSHOT_FILE), serializeSnapshot(snapshot));
  return { titles: all.length, requests };
}

// ── The overrides ──────────────────────────────────────────────────────────

const OVERRIDE_DECISIONS = new Set(['replace', 'accept-restriction']);
const OVERRIDE_FILE_KEYS = new Set(['decision', 'replacement', 'author', 'attribution', 'licence', 'curation']);

/** @returns {string[]} problems; empty when the overrides can be applied as written */
export function validateOverrides(overrides) {
  const problems = [];
  if (overrides === null) return problems;
  if (overrides?.schema !== 1) problems.push(`${OVERRIDES_FILE}: schema must be 1`);
  for (const [title, entry] of Object.entries(overrides?.files ?? {})) {
    const where = `${OVERRIDES_FILE}: files["${title}"]`;
    for (const key of Object.keys(entry)) if (!OVERRIDE_FILE_KEYS.has(key)) problems.push(`${where}: unknown field "${key}"`);
    if (entry.decision !== undefined && !OVERRIDE_DECISIONS.has(entry.decision)) problems.push(`${where}: decision must be replace or accept-restriction`);
    if (entry.decision === 'replace' && !/^\/images\/[A-Za-z0-9][A-Za-z0-9/._-]*\.(?:webp|png|jpe?g|avif)$/.test(entry.replacement ?? '')) {
      problems.push(`${where}: replace needs a "replacement" site path under /images/`);
    }
    if (entry.decision !== 'replace' && entry.replacement !== undefined) problems.push(`${where}: "replacement" without decision replace`);
    const curation = entry.curation;
    if (!curation || !['by', 'at', 'note'].every((k) => typeof curation[k] === 'string' && curation[k].trim())) {
      problems.push(`${where}: every override needs curation { by, at, note }`);
    }
    if (entry.author?.type !== undefined && !['Person', 'Organization'].includes(entry.author.type)) problems.push(`${where}: author.type must be Person or Organization`);
    if (entry.author?.url !== undefined && entry.author.url !== null && !isAllowedAuthorUrl(entry.author.url)) problems.push(`${where}: author.url is not an allowed profile URL`);
    if (entry.licence?.url !== undefined && entry.licence.url !== null && normaliseLicenceUrl(entry.licence.url) !== entry.licence.url) {
      problems.push(`${where}: licence.url must be normalised (${normaliseLicenceUrl(entry.licence.url)})`);
    }
  }
  for (const [key, entry] of Object.entries(overrides?.covers ?? {})) {
    if (entry?.modified !== 'cropped' && entry?.modified !== 'resized') problems.push(`${OVERRIDES_FILE}: covers["${key}"].modified must be cropped or resized`);
  }
  return problems;
}

/** Applies one file's overrides to a template; the reasons they answer are returned. */
function applyFileOverride(template, entry) {
  const answered = new Set();
  if (!entry) return { template, answered };
  const next = structuredClone(template);
  if (entry.author) {
    next.author = { ...next.author, ...entry.author };
    answered.add('author');
  }
  if (entry.attribution !== undefined) {
    next.attribution = entry.attribution;
    answered.add('author');
  }
  if (entry.licence) {
    next.licence = { ...next.licence, ...entry.licence };
    answered.add('licence');
  }
  if (entry.decision === 'accept-restriction') answered.add('restriction');
  next.curation = { by: entry.curation.by, at: entry.curation.at, note: entry.curation.note };
  return { template: next, answered };
}

/** Which kind of answer a review reason needs. `null`: no override can make the file creditable. */
function reasonKind(reason) {
  if (reason.startsWith('restriction:')) return 'restriction';
  if (reason.startsWith('licence:')) return 'licence';
  if (reason.startsWith('author:') || reason === 'email-in-artist') return 'author';
  return null;
}

// ── The plan (--build and --check share it) ────────────────────────────────

/**
 * Everything `--build` would write, computed without writing.
 *
 * @returns {{
 *   records: Map<string, object>,          cover key → record
 *   repoints: Map<string, string>,         cover key → replacement path
 *   pending: { title: string, covers: string[], reasons: string[] }[],
 * }}
 */
export function planBackfill(root, { snapshot, overrides }) {
  const records = new Map();
  const repoints = new Map();
  const pending = [];
  const aliases = snapshot.aliases ?? {};
  /** @type {Map<string, string[]>} */
  const coversByTitle = new Map();
  for (const { id, title } of liveCommonsCovers(root)) {
    const canonical = aliases[title] ?? title;
    if (!coversByTitle.has(canonical)) coversByTitle.set(canonical, []);
    coversByTitle.get(canonical).push(id);
  }
  for (const [title, covers] of [...coversByTitle].sort(([a], [b]) => a.localeCompare(b))) {
    const entry = overrides?.files?.[title];
    const file = snapshot.files?.[title];
    if (entry?.decision === 'replace') {
      for (const id of covers) repoints.set(id, entry.replacement);
      continue;
    }
    if (!file) {
      pending.push({ title, covers, reasons: ['not in the snapshot: run --fetch'] });
      continue;
    }
    const assessment = assessCommonsFile({ title, ...file });
    if (assessment.decision === 'replace') {
      pending.push({ title, covers, reasons: [...assessment.reasons, 'cannot be credited: add decision "replace" with a replacement'] });
      continue;
    }
    const base = creditTemplate(assessment, { title, ...file }, { fetchedAt: snapshot.fetchedAt });
    const { template, answered } = applyFileOverride(base, entry);
    const unanswered = assessment.decision === 'ok'
      ? []
      : assessment.reasons.filter((reason) => !answered.has(reasonKind(reason)));
    if (unanswered.length > 0) {
      pending.push({ title, covers, reasons: unanswered });
      continue;
    }
    template.status = 'ok';
    for (const id of covers) {
      const cover = `/images/blog/${id}.webp`;
      const coverFile = path.join(root, COVERS_DIR, `${id}.webp`);
      const modified = overrides?.covers?.[id]?.modified
        ?? (fs.existsSync(coverFile) ? modifiedFor(file, webpDimensions(fs.readFileSync(coverFile))) : null);
      if (!modified) {
        pending.push({ title, covers: [id], reasons: [`size of ${cover} unknown: no ${COVERS_DIR}/${id}.webp and no overrides.covers entry`] });
        continue;
      }
      const record = finalizeCreditRecord(template, { cover, modified });
      const { valid, errors } = validateImageCreditRecord(record);
      if (!valid) {
        pending.push({ title, covers: [id], reasons: errors.map((e) => `record: ${e}`) });
        continue;
      }
      records.set(id, record);
    }
  }
  return { records, repoints, pending };
}

/** Covers that will carry a credit: the plan's records plus the publishable records it leaves alone. */
function creditedKeys(root, plan) {
  const keys = new Set(plan.records.keys());
  for (const { key, record } of readCreditRecords(root)) {
    if (!plan.repoints.has(key) && record?.status === 'ok') keys.add(key);
  }
  return keys;
}

/** Points every registry row and SEO literal of a replaced cover at its replacement. */
function repointCovers(root, repoints) {
  let changed = 0;
  for (const rel of REGISTRY_FILES) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, 'utf-8');
    const out = src.replace(/(\bimage:\s*')\/images\/blog\/([A-Za-z0-9][A-Za-z0-9._-]*)\.webp(')/g, (m, open, key, close) => (
      repoints.has(key) ? `${open}${repoints.get(key)}${close}` : m
    ));
    if (out !== src) { writeTextAtomic(file, out); changed += 1; }
  }
  for (const rel of seoLiteralFiles(root)) {
    const file = path.join(root, rel);
    const src = fs.readFileSync(file, 'utf-8');
    const edits = [];
    for (const block of scanSeoImageBlocks(src)) {
      if (!block.cover || !repoints.has(block.cover)) continue;
      const url = block.props.find((p) => p.key === 'url');
      const value = src.slice(url.valueStart, url.valueEnd);
      edits.push({ from: url.valueStart, to: url.valueEnd, text: value.replace(`/images/blog/${block.cover}.webp`, repoints.get(block.cover)) });
    }
    if (edits.length === 0) continue;
    let out = src;
    for (const e of edits.sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.text + out.slice(e.to);
    writeTextAtomic(file, out);
    changed += 1;
  }
  return changed;
}

/** Writes the plan. Idempotent: an unchanged record is not rewritten. */
export function applyBackfill(root, plan) {
  let written = 0;
  for (const record of plan.records.values()) {
    const file = creditRecordPath(root, coverKey(record.cover));
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
    if (current !== null && canonicalJson(JSON.parse(current)) === canonicalJson(record)) continue;
    writeCreditRecord(root, record);
    written += 1;
  }
  let removed = 0;
  for (const key of plan.repoints.keys()) {
    const file = creditRecordPath(root, key);
    if (fs.existsSync(file)) { fs.rmSync(file); removed += 1; }
  }
  const repointedFiles = plan.repoints.size > 0 ? repointCovers(root, plan.repoints) : 0;
  const credited = creditedKeys(root, plan);
  const unmatched = [];
  let stripped = 0;
  for (const rel of seoLiteralFiles(root)) {
    const file = path.join(root, rel);
    const src = fs.readFileSync(file, 'utf-8');
    const result = stripCreditedImageRights(src, (key) => credited.has(key));
    stripped += result.stripped.length;
    for (const u of result.unmatched) unmatched.push(`${rel}: ${u.cover} — ${u.reason}`);
    if (result.src !== src) writeTextAtomic(file, result.src);
  }
  return { written, removed, repointedFiles, stripped, unmatched };
}

// ── --check ────────────────────────────────────────────────────────────────

/**
 * The tree as it must be: every problem as one line, empty when clean.
 */
export function checkTree(root) {
  const snapshot = readJsonIfPresent(path.join(root, SNAPSHOT_FILE));
  const overrides = readJsonIfPresent(path.join(root, OVERRIDES_FILE));
  const entries = readCreditRecords(root);
  const problems = [...auditCreditRecords(entries), ...validateOverrides(overrides)];
  if (problems.some((p) => p.startsWith(OVERRIDES_FILE))) return problems;

  // The curation file applied: a curated title's records say what the human
  // decided, a replaced title has no record, a restricted file is credited
  // only with the owner's acceptance.
  for (const { file, record } of entries) {
    if (!record?.commons) continue;
    const entry = overrides?.files?.[record.commons.title];
    if (entry?.decision === 'replace') problems.push(`${file}: «${record.commons.title}» is to be replaced, not credited`);
    if (record.restrictions?.length && entry?.decision !== 'accept-restriction') {
      problems.push(`${file}: restrictions ${record.restrictions.join('|')} without the owner's accept-restriction in ${OVERRIDES_FILE}`);
    }
    if (!entry) continue;
    for (const [field, expected] of [['author', entry.author], ['licence', entry.licence]]) {
      for (const [key, value] of Object.entries(expected ?? {})) {
        if (record[field]?.[key] !== value) problems.push(`${file}: ${field}.${key} is not the curated value`);
      }
    }
    if (entry.attribution !== undefined && record.attribution !== entry.attribution) problems.push(`${file}: attribution is not the curated value`);
    if (canonicalJson(record.curation) !== canonicalJson(entry.curation)) problems.push(`${file}: curation is not the one in ${OVERRIDES_FILE}`);
  }

  if (snapshot) {
    const plan = planBackfill(root, { snapshot, overrides });
    for (const p of plan.pending) problems.push(`needs a human: «${p.title}» (${p.covers.join(', ')}): ${p.reasons.join('; ')}`);
    const onDisk = new Map(entries.filter((e) => e.record).map((e) => [e.key, e.record]));
    for (const [key, record] of plan.records) {
      const current = onDisk.get(key);
      if (!current) problems.push(`${IMAGE_CREDIT_RECORDS_DIR}/${key}.json: missing — run --build`);
      else if (canonicalJson(current) !== canonicalJson(record)) problems.push(`${IMAGE_CREDIT_RECORDS_DIR}/${key}.json: differs from a rebuild — run --build`);
    }
    const registry = readRegistryImages(root);
    for (const key of plan.repoints.keys()) {
      for (const [id, image] of registry) if (image === `/images/blog/${key}.webp`) problems.push(`registry row ${id} still shows replaced cover ${key} — run --build`);
    }
    if (plan.repoints.size > 0) {
      for (const rel of seoLiteralFiles(root)) {
        for (const block of scanSeoImageBlocks(fs.readFileSync(path.join(root, rel), 'utf-8'))) {
          if (block.cover && plan.repoints.has(block.cover)) problems.push(`${rel}: a literal still shows replaced cover ${block.cover} — run --build`);
        }
      }
    }
  }

  const credited = new Set(entries.filter((e) => e.record?.status === 'ok').map((e) => e.key));
  for (const claim of findCreditedRightsClaims(root, credited)) {
    problems.push(`${claim.file}: the literal of credited cover ${claim.cover} still carries ${claim.rights.join(', ')} — run --build`);
  }
  return problems;
}

// ── CLI ────────────────────────────────────────────────────────────────────

async function main(argv) {
  const rootAt = argv.indexOf('--root');
  const root = rootAt >= 0 ? path.resolve(argv[rootAt + 1]) : ROOT;
  const mode = ['--fetch', '--build', '--check'].filter((m) => argv.includes(m));
  if (mode.length !== 1) {
    console.error('usage: node scripts/backfill-image-credits.mjs --fetch|--build|--check [--root <dir>]');
    return 2;
  }
  if (mode[0] === '--fetch') {
    const { titles, requests } = await fetchSnapshot({ root });
    console.log(`[backfill] ${SNAPSHOT_FILE}: ${titles} Commons files in ${requests} requests`);
    return 0;
  }
  if (mode[0] === '--build') {
    const snapshot = readJsonIfPresent(path.join(root, SNAPSHOT_FILE));
    if (!snapshot) {
      console.error(`[backfill] ${SNAPSHOT_FILE} missing — run --fetch first`);
      return 1;
    }
    const overrides = readJsonIfPresent(path.join(root, OVERRIDES_FILE));
    const overrideProblems = validateOverrides(overrides);
    if (overrideProblems.length > 0) {
      for (const p of overrideProblems) console.error(`[backfill] ${p}`);
      return 1;
    }
    const plan = planBackfill(root, { snapshot, overrides });
    const result = applyBackfill(root, plan);
    console.log(`[backfill] records: ${plan.records.size} planned, ${result.written} written, ${result.removed} removed; `
      + `${plan.repoints.size} covers repointed in ${result.repointedFiles} files; ${result.stripped} literals stripped`);
    for (const u of result.unmatched) console.error(`[backfill] literal left unchanged: ${u}`);
    for (const p of plan.pending) console.error(`[backfill] needs a human: «${p.title}» (${p.covers.join(', ')}): ${p.reasons.join('; ')}`);
    return plan.pending.length > 0 || result.unmatched.length > 0 ? 1 : 0;
  }
  const problems = checkTree(root);
  for (const p of problems) console.error(`[backfill] ${p}`);
  console.log(`[backfill] --check: ${problems.length} problem(s)`);
  return problems.length > 0 ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(`[backfill] ${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 1;
  });
}
