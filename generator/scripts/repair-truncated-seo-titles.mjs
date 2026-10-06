#!/usr/bin/env node
/**
 * Repair historical `ogTitle` and JSON-LD `headline` prefixes.
 *
 * The generator now closes this tap. This script is the one-shot deterministic
 * backfill for entries already stored under `content/seo/`: it only considers a
 * value when it is a strict prefix of the authoritative Italian title in
 * `content/blog-meta-it.ts`, then applies the same shared clause-safe rule as
 * the generator. Unrelated values are reported neither as repaired nor guessed.
 *
 * Usage:
 *   node generator/scripts/repair-truncated-seo-titles.mjs --dry-run
 *   node generator/scripts/repair-truncated-seo-titles.mjs --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAllSeoEntryMatches } from '../../scripts/lib/seo-entry.mjs';
import { escapeForSingleQuoteTS } from './lib/article-meta-block.mjs';
import { metaFieldRegex, unescapeTsValue } from './lib/meta-field-regex.mjs';
import { unescapeTsString } from './lib/unescape-ts-string.mjs';
import {
  SEO_TITLE_FIELD_LIMITS,
  isStrictSeoTitlePrefix,
  repairSeoTitleField,
} from './lib/seo-title-repair.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SEO_DIR = path.join(ROOT, 'content', 'seo');
export const META_IT = path.join(ROOT, 'content', 'blog-meta-it.ts');

const SEO_FILES_RE = /^seo-blog.*\.ts$/;
const OG_TITLE_RE = /\b(ogTitle\s*:\s*')((?:[^'\\]|\\.)*)'/;
const HEADLINE_RE = /("headline"\s*:\s*")((?:[^"\\]|\\.)*)"/;

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

function readCanonicalTitles(metaSource) {
  const titles = new Map();
  for (const match of metaSource.matchAll(metaFieldRegex('title'))) {
    titles.set(match[1], unescapeTsValue(match[2]).trim());
  }
  return titles;
}

export function fieldMatch(block, field) {
  if (field === 'ogTitle') {
    const match = OG_TITLE_RE.exec(block);
    if (!match) return null;
    return {
      raw: match[2],
      start: match.index + match[1].length,
      end: match.index + match[1].length + match[2].length,
      decode: decodeSingle,
      encode: encodeSingle,
    };
  }
  const match = HEADLINE_RE.exec(block);
  if (!match) return null;
  return {
    raw: match[2],
    start: match.index + match[1].length,
    end: match.index + match[1].length + match[2].length,
    decode: decodeDouble,
    encode: encodeDouble,
  };
}

/**
 * Plan all safe edits without writing. The returned offsets are source-local
 * and are applied from right to left by `repairFile`.
 */
export function planSeoTitleRepairs({ root = ROOT } = {}) {
  const metaSource = fs.readFileSync(path.join(root, 'content', 'blog-meta-it.ts'), 'utf8');
  const titles = readCanonicalTitles(metaSource);
  const seoDir = path.join(root, 'content', 'seo');
  const files = fs.readdirSync(seoDir).filter((file) => SEO_FILES_RE.test(file)).sort();
  if (files.length < 8) {
    throw new Error(`checkout incompleto: attesi almeno 8 chunk SEO, trovati ${files.length}`);
  }
  if (titles.size < 3000) {
    throw new Error(`checkout incompleto: attesi almeno 3000 titoli IT, trovati ${titles.size}`);
  }

  const plans = [];
  for (const file of files) {
    const absolute = path.join(seoDir, file);
    const source = fs.readFileSync(absolute, 'utf8');
    for (const entry of findAllSeoEntryMatches(source, path.join('content/seo', file))) {
      const canonical = titles.get(entry.id);
      if (!canonical) continue;
      const block = source.slice(entry.openIdx, entry.closeIdx + 1);
      for (const [field, maxLen] of Object.entries(SEO_TITLE_FIELD_LIMITS)) {
        const match = fieldMatch(block, field);
        if (!match) continue;
        const before = match.decode(match.raw).trim();
        if (!isStrictSeoTitlePrefix(before, canonical)) continue;
        const after = repairSeoTitleField(before, canonical, maxLen);
        if (after === before) continue;
        const encoded = match.encode(after);
        if (match.decode(encoded) !== after) {
          throw new Error(`${file}: round-trip non esatto per ${entry.id}.${field}`);
        }
        plans.push({
          file,
          absolute,
          id: entry.id,
          field,
          before,
          after,
          start: entry.openIdx + match.start,
          end: entry.openIdx + match.end,
          encoded,
        });
      }
    }
  }
  return { files, titles, plans };
}

export function repairFile(source, filePlans) {
  let output = source;
  for (const edit of [...filePlans].sort((a, b) => b.start - a.start)) {
    output = output.slice(0, edit.start) + edit.encoded + output.slice(edit.end);
  }
  return output;
}

export function applyPlans(plans) {
  const byFile = new Map();
  for (const plan of plans) {
    if (!byFile.has(plan.absolute)) byFile.set(plan.absolute, []);
    byFile.get(plan.absolute).push(plan);
  }
  for (const [absolute, filePlans] of byFile) {
    const source = fs.readFileSync(absolute, 'utf8');
    fs.writeFileSync(absolute, repairFile(source, filePlans));
  }
  return byFile.size;
}

export function formatReport({ files, titles, plans, mode }) {
  const byField = Object.fromEntries(Object.keys(SEO_TITLE_FIELD_LIMITS).map((field) => [
    field,
    plans.filter((plan) => plan.field === field).length,
  ]));
  const lines = [
    `${mode === 'apply' ? '✅ applicate' : '🔍 dry-run'}: ${plans.length} sostituzioni in ${new Set(plans.map((p) => p.file)).size} file`,
    `inventario: ${files.length} chunk SEO, ${titles.size} titoli IT`,
    `per campo: ${Object.entries(byField).map(([field, count]) => `${field}=${count}`).join(', ')}`,
  ];
  for (const plan of plans.slice(0, 12)) {
    lines.push(`- ${plan.file}: ${plan.id}.${plan.field}: "${plan.before}" → "${plan.after}"`);
  }
  if (plans.length > 12) lines.push(`- … altri ${plans.length - 12} record`);
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
