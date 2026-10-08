#!/usr/bin/env node
/**
 * Repair stored SEO title fields that are a broken derivative of the real
 * Italian title: `title`, `ogTitle` and the JSON-LD `headline`.
 *
 * The generator closes this tap for new articles. This script is the
 * deterministic backfill for the entries already stored, and it reads them the
 * way the corpus is actually laid out:
 *
 *   - EVERY active section, taken from `scripts/lib/article-surfaces.mjs`
 *     (`SECTIONS`): `frontaliere`, `svizzera` and the cantons, each matched
 *     against its own `blog-meta-…-it.ts`. The first version knew only
 *     `content/seo/` and `content/blog-meta-it.ts`, so the 2.637 `svizzera`
 *     entries were never looked at;
 *   - whole SEO entries through `findAllSeoEntryMatches`, never line patterns
 *     tied to an indentation: 663 entries are indented with one space;
 *   - properties through the entry's string literals, never a pattern over the
 *     raw block: a field whose text contains `"headline": "…"` (the model has
 *     written a whole JSON-LD object into a field before) must not be mistaken
 *     for the JSON-LD property, or the edit lands inside the wrong string.
 *
 * What counts as broken, and what the repair is, is decided in one place —
 * `./lib/seo-title-repair.mjs`. A field is rewritten only when that module
 * proves the defect. What cannot be judged is never skipped in silence: an
 * entry with no real title in its own section, and a real title that dangles
 * itself, are both listed as unrepairable and make the command exit 1.
 *
 * Usage:
 *   node generator/scripts/repair-truncated-seo-titles.mjs --dry-run
 *   node generator/scripts/repair-truncated-seo-titles.mjs --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCALES, SECTIONS, seoFilesFor } from '../../scripts/lib/article-surfaces.mjs';
import { findAllSeoEntryMatches } from '../../scripts/lib/seo-entry.mjs';
import { escapeForSingleQuoteTS } from './lib/article-meta-block.mjs';
import { metaFieldRegex, unescapeTsValue } from './lib/meta-field-regex.mjs';
import { unescapeTsString } from './lib/unescape-ts-string.mjs';
import {
  SEO_TITLE_FIELDS,
  normalizeSeoTitle,
  repairSeoTitleValue,
  seoTitleFieldDefect,
} from './lib/seo-title-repair.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function decodeSingle(raw) {
  return unescapeTsValue(raw);
}

function decodeDouble(raw) {
  return unescapeTsString(raw, { '"': '"', '\\': '\\' });
}

function encodeSingle(value) {
  return escapeForSingleQuoteTS(value);
}

function encodeDouble(value) {
  const encoded = JSON.stringify(String(value));
  if (typeof encoded !== 'string' || encoded.length < 2) {
    throw new Error('JSON.stringify non ha prodotto una stringa per headline');
  }
  return encoded.slice(1, -1);
}

/**
 * The string literals of one SEO entry block, in source order. `start`/`end`
 * delimit the CONTENT (quotes excluded), `open`/`close` the literal itself.
 * Comments are skipped; an unclosed literal is an error, never a silent tail.
 */
export function stringLiterals(block) {
  const literals = [];
  for (let i = 0; i < block.length; i += 1) {
    const ch = block[i];
    if (ch === '/' && block[i + 1] === '/') {
      const end = block.indexOf('\n', i + 2);
      i = end === -1 ? block.length : end;
      continue;
    }
    if (ch === '/' && block[i + 1] === '*') {
      const end = block.indexOf('*/', i + 2);
      if (end === -1) throw new Error('commento multilinea non chiuso nella voce SEO');
      i = end + 1;
      continue;
    }
    if (ch !== "'" && ch !== '"' && ch !== '`') continue;
    let j = i + 1;
    while (j < block.length && block[j] !== ch) j += block[j] === '\\' ? 2 : 1;
    if (j >= block.length) throw new Error(`stringa ${ch} non chiusa nella voce SEO`);
    literals.push({ quote: ch, open: i, start: i + 1, end: j, close: j });
    i = j;
  }
  return literals;
}

function codecFor(literal, block) {
  const doubleQuoted = literal.quote === '"';
  return {
    raw: block.slice(literal.start, literal.end),
    start: literal.start,
    end: literal.end,
    decode: doubleQuoted ? decodeDouble : decodeSingle,
    encode: doubleQuoted ? encodeDouble : encodeSingle,
  };
}

/**
 * Locate one title field inside an SEO entry block, with its codec.
 *
 * `title` and `ogTitle` are identifiers followed by a single-quoted literal;
 * `headline` is a double-quoted JSON key followed by a double-quoted literal.
 * Both are matched between literals, so text INSIDE a literal is never a
 * candidate, whatever it contains.
 */
export function fieldMatch(block, field) {
  if (!SEO_TITLE_FIELDS.includes(field)) throw new Error(`campo titolo SEO sconosciuto: '${field}'`);
  const literals = stringLiterals(block);
  if (field === 'headline') {
    for (let i = 0; i + 1 < literals.length; i += 1) {
      const key = literals[i];
      const value = literals[i + 1];
      if (key.quote !== '"' || value.quote !== '"') continue;
      if (block.slice(key.start, key.end) !== 'headline') continue;
      if (!/^\s*:\s*$/.test(block.slice(key.close + 1, value.open))) continue;
      return codecFor(value, block);
    }
    return null;
  }
  const property = new RegExp(`(?:^|[\\s{,])${field}\\s*:\\s*$`);
  let previousClose = -1;
  for (const literal of literals) {
    const between = block.slice(previousClose + 1, literal.open);
    previousClose = literal.close;
    if (literal.quote === "'" && property.test(between)) return codecFor(literal, block);
  }
  return null;
}

/** The real Italian titles of one section, by article id. */
export function readSectionTitles(section, { root = ROOT } = {}) {
  const surfaces = SECTIONS[section];
  if (!surfaces) throw new Error(`sezione sconosciuta: '${section}'`);
  const metaFile = surfaces.metaFiles[LOCALES.indexOf('it')];
  const absolute = path.join(root, metaFile);
  if (!fs.existsSync(absolute)) {
    throw new Error(`checkout incompleto: manca ${metaFile} (titoli italiani della sezione '${section}')`);
  }
  const titles = new Map();
  for (const match of fs.readFileSync(absolute, 'utf8').matchAll(metaFieldRegex('title'))) {
    titles.set(match[1], normalizeSeoTitle(unescapeTsValue(match[2])));
  }
  return titles;
}

/**
 * Every stored title field of every SEO entry, with its real title and the
 * defect the shared module finds in it (`null` when it is fine). The gates in
 * `generator/tests/` read the corpus through this same scan.
 *
 * Two lists say what the scan could NOT judge, one per direction:
 *   - `orphans`: SEO entries with no real title in their own section. Their
 *     fields are still listed, but the prefix shape has nothing to compare to;
 *   - `uncovered`: per section, the real titles with no SEO entry. A section
 *     whose SEO file is missing (`seoFilesFor` returns only the files that
 *     exist), a lost chunk and a single lost entry all land here, so a
 *     populated section is never read as clean because nothing of it was read.
 */
export function scanSeoTitleFields({ root = ROOT } = {}) {
  const rows = [];
  const files = [];
  const orphans = [];
  const uncovered = [];
  let entries = 0;
  let titles = 0;
  for (const section of Object.keys(SECTIONS)) {
    const sectionTitles = readSectionTitles(section, { root });
    titles += sectionTitles.size;
    // Sorted: the directory listing behind the chunked sections has no order
    // of its own, and the report and the writes should not depend on it.
    const sectionFiles = [...seoFilesFor(section, root)].sort();
    const seen = new Set();
    for (const file of sectionFiles) {
      files.push(file);
      const absolute = path.join(root, file);
      const source = fs.readFileSync(absolute, 'utf8');
      for (const entry of findAllSeoEntryMatches(source, file)) {
        entries += 1;
        seen.add(entry.id);
        const canonical = sectionTitles.get(entry.id) ?? '';
        if (!canonical) orphans.push({ section, file, id: entry.id });
        const block = source.slice(entry.openIdx, entry.closeIdx + 1);
        for (const field of SEO_TITLE_FIELDS) {
          const match = fieldMatch(block, field);
          if (!match) continue;
          const value = match.decode(match.raw).trim();
          rows.push({
            section,
            file,
            absolute,
            id: entry.id,
            field,
            value,
            canonical,
            defect: seoTitleFieldDefect(field, value, canonical),
            start: entry.openIdx + match.start,
            end: entry.openIdx + match.end,
            encode: match.encode,
            decode: match.decode,
          });
        }
      }
    }
    const missing = [...sectionTitles.keys()].filter((id) => !seen.has(id));
    if (missing.length > 0) uncovered.push({ section, seoFiles: sectionFiles.length, missing });
  }
  return { sections: Object.keys(SECTIONS), files, entries, titles, rows, orphans, uncovered };
}

/**
 * Turn a scan into edits. Pure: nothing is read or written here.
 *
 * `unrepairable` holds what the command must not pass over: a defect whose
 * real title cannot repair it, every entry without a real title — for those a
 * field that does not dangle would otherwise look fine while its prefix shape
 * was never compared with anything — and every section with real titles the
 * scan found no SEO entry for.
 */
export function planFromScan(scan) {
  const plans = [];
  const unrepairable = (scan.orphans ?? []).map((orphan) => ({
    ...orphan,
    field: '*',
    value: '',
    canonical: '',
    reason: 'missing-canonical',
  }));
  for (const gap of scan.uncovered ?? []) {
    unrepairable.push({
      section: gap.section,
      file: '',
      id: '*',
      field: '*',
      value: '',
      canonical: '',
      reason: 'missing-seo-entry',
      seoFiles: gap.seoFiles,
      missing: gap.missing,
    });
  }
  for (const row of scan.rows) {
    if (!row.defect) continue;
    const after = repairSeoTitleValue(row.field, row.value, row.canonical);
    if (after === row.value) {
      if (row.canonical) unrepairable.push({ ...row, reason: 'canonical-dangling' });
      continue;
    }
    const encoded = row.encode(after);
    if (row.decode(encoded) !== after) {
      throw new Error(`${row.file}: round-trip non esatto per ${row.id}.${row.field}`);
    }
    plans.push({
      section: row.section,
      file: row.file,
      absolute: row.absolute,
      id: row.id,
      field: row.field,
      defect: row.defect,
      before: row.value,
      after,
      start: row.start,
      end: row.end,
      encoded,
    });
  }
  return { plans, unrepairable };
}

/**
 * Plan all safe edits without writing. The returned offsets are source-local
 * and are applied from right to left by `repairFile`.
 */
export function planSeoTitleRepairs({ root = ROOT } = {}) {
  const scan = scanSeoTitleFields({ root });
  if (scan.files.length < 8) {
    throw new Error(`checkout incompleto: attesi almeno 8 file SEO, trovati ${scan.files.length}`);
  }
  if (scan.titles < 3000) {
    throw new Error(`checkout incompleto: attesi almeno 3000 titoli IT, trovati ${scan.titles}`);
  }
  return { ...scan, ...planFromScan(scan) };
}

export function repairFile(source, filePlans) {
  let output = source;
  for (const edit of [...filePlans].sort((a, b) => b.start - a.start)) {
    output = output.slice(0, edit.start) + edit.encoded + output.slice(edit.end);
  }
  return output;
}

let writeTmpSeq = 0;

function writeAtomic(file, content) {
  const tmp = `${file}.${process.pid}.${writeTmpSeq++}.tmp`;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

export function applyPlans(plans) {
  const byFile = new Map();
  for (const plan of plans) {
    if (!byFile.has(plan.absolute)) byFile.set(plan.absolute, []);
    byFile.get(plan.absolute).push(plan);
  }
  for (const [absolute, filePlans] of byFile) {
    const source = fs.readFileSync(absolute, 'utf8');
    writeAtomic(absolute, repairFile(source, filePlans));
  }
  return byFile.size;
}

// The report is read in a job log: past this many rows the rest is counted.
const UNREPAIRABLE_REPORT_LIMIT = 40;

export function formatReport({ sections, files, entries, titles, plans, unrepairable = [], mode }) {
  const count = (list, key) => SEO_TITLE_FIELDS
    .map((field) => `${field}=${list.filter((item) => item[key] === field).length}`)
    .join(', ');
  const bySection = [...new Set(plans.map((plan) => plan.section))]
    .map((section) => `${section}=${plans.filter((plan) => plan.section === section).length}`)
    .join(', ');
  const lines = [
    `${mode === 'apply' ? '✅ applicate' : '🔍 dry-run'}: ${plans.length} sostituzioni in ${new Set(plans.map((p) => p.file)).size} file`,
    `inventario: ${sections.length} sezioni, ${files.length} file SEO, ${entries} voci, ${titles} titoli IT`,
    `per campo: ${count(plans, 'field')}`,
    `per sezione: ${bySection || '-'}`,
  ];
  for (const plan of plans.slice(0, 12)) {
    lines.push(`- ${plan.file}: ${plan.id}.${plan.field} (${plan.defect}): "${plan.before}" → "${plan.after}"`);
  }
  if (plans.length > 12) lines.push(`- … altri ${plans.length - 12} record`);
  if (unrepairable.length > 0) {
    lines.push(`✖ non riparabili, da correggere a mano: ${unrepairable.length}`);
    if (mode === 'apply' && plans.length > 0) {
      lines.push('  le sostituzioni sicure qui sopra sono state scritte; l\'uscita resta 1 finché questo elenco non è vuoto');
    }
    for (const row of unrepairable.slice(0, UNREPAIRABLE_REPORT_LIMIT)) {
      if (row.reason === 'missing-seo-entry') {
        const sample = row.missing.slice(0, 5).join(', ');
        lines.push(`- sezione '${row.section}': ${row.missing.length} titoli italiani senza voce SEO`
          + ` (file SEO letti: ${row.seoFiles}; ${sample}${row.missing.length > 5 ? ', …' : ''})`);
      } else if (row.reason === 'missing-canonical') {
        lines.push(`- ${row.file}: ${row.id} non ha un titolo italiano nella sezione '${row.section}'`);
      } else {
        lines.push(`- ${row.file}: ${row.id}.${row.field} = "${row.value}" (titolo vero monco: "${row.canonical}")`);
      }
    }
    if (unrepairable.length > UNREPAIRABLE_REPORT_LIMIT) {
      lines.push(`- … altri ${unrepairable.length - UNREPAIRABLE_REPORT_LIMIT}`);
    }
  }
  return lines.join('\n');
}

/** Exit status: 1 while something the command could not judge or repair is left. */
export function main(argv = process.argv.slice(2)) {
  const apply = argv.includes('--apply');
  const dryRun = argv.includes('--dry-run') || !apply;
  if (apply && argv.includes('--dry-run')) throw new Error('scegliere --dry-run oppure --apply, non entrambi');
  const result = planSeoTitleRepairs();
  if (apply && !dryRun) applyPlans(result.plans);
  console.log(formatReport({ ...result, mode: apply ? 'apply' : 'dry-run' }));
  return result.unrepairable.length > 0 ? 1 : 0;
}

const invokedDirectly = (() => {
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] || '');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`✖ ${error.message}`);
    process.exitCode = 1;
  }
}
