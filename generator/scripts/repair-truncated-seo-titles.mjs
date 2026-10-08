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
 *     tied to an indentation: 663 entries are indented with one space.
 *
 * What counts as broken, and what the repair is, is decided in one place —
 * `./lib/seo-title-repair.mjs`. A field is rewritten only when that module
 * proves the defect; a real title that dangles itself is reported as
 * unrepairable and left for a human, never copied into three more fields.
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

// The value group is anchored on the property name, so a title that contains
// the word «ogTitle» cannot shift the offsets (see the offset test).
const FIELD_PATTERNS = {
  title: /\b(title\s*:\s*')((?:[^'\\]|\\.)*)'/,
  ogTitle: /\b(ogTitle\s*:\s*')((?:[^'\\]|\\.)*)'/,
  headline: /("headline"\s*:\s*")((?:[^"\\]|\\.)*)"/,
};

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

/** Locate one title field inside an SEO entry block, with its codec. */
export function fieldMatch(block, field) {
  const pattern = FIELD_PATTERNS[field];
  if (!pattern) throw new Error(`campo titolo SEO sconosciuto: '${field}'`);
  const match = pattern.exec(block);
  if (!match) return null;
  const doubleQuoted = field === 'headline';
  return {
    raw: match[2],
    start: match.index + match[1].length,
    end: match.index + match[1].length + match[2].length,
    decode: doubleQuoted ? decodeDouble : decodeSingle,
    encode: doubleQuoted ? encodeDouble : encodeSingle,
  };
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
 */
export function scanSeoTitleFields({ root = ROOT } = {}) {
  const rows = [];
  const files = [];
  let entries = 0;
  let titles = 0;
  for (const section of Object.keys(SECTIONS)) {
    const sectionTitles = readSectionTitles(section, { root });
    titles += sectionTitles.size;
    for (const file of seoFilesFor(section, root)) {
      files.push(file);
      const absolute = path.join(root, file);
      const source = fs.readFileSync(absolute, 'utf8');
      for (const entry of findAllSeoEntryMatches(source, file)) {
        entries += 1;
        const canonical = sectionTitles.get(entry.id) ?? '';
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
  }
  return { sections: Object.keys(SECTIONS), files, entries, titles, rows };
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

  const plans = [];
  const unrepairable = [];
  for (const row of scan.rows) {
    if (!row.defect) continue;
    const after = repairSeoTitleValue(row.field, row.value, row.canonical);
    if (after === row.value) {
      unrepairable.push(row);
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
  return { ...scan, plans, unrepairable };
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
    lines.push(`⚠️  non riparabili (titolo vero assente o monco, da correggere a mano): ${unrepairable.length}`);
    for (const row of unrepairable) {
      lines.push(`- ${row.file}: ${row.id}.${row.field} = "${row.value}" (titolo vero: "${row.canonical}")`);
    }
  }
  return lines.join('\n');
}

export function main(argv = process.argv.slice(2)) {
  const apply = argv.includes('--apply');
  const dryRun = argv.includes('--dry-run') || !apply;
  if (apply && argv.includes('--dry-run')) throw new Error('scegliere --dry-run oppure --apply, non entrambi');
  const result = planSeoTitleRepairs();
  if (apply && !dryRun) applyPlans(result.plans);
  console.log(formatReport({ ...result, mode: apply ? 'apply' : 'dry-run' }));
  return result.plans.length;
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
    main();
  } catch (error) {
    console.error(`✖ ${error.message}`);
    process.exitCode = 1;
  }
}
