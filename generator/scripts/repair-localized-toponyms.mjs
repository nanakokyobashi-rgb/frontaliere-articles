#!/usr/bin/env node

/**
 * Deterministic one-shot repair for already published localized exonyms.
 *
 * The source of truth is the Italian field with the same article key. The
 * script never calls a model and edits only the string literal value of a
 * `blog.article.*` field. It is deliberately dry-run by default.
 */

import { readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LOCALIZED_TOPONYM_LOCALES,
  replaceLocalizedToponymMismatches,
} from './lib/localized-toponyms.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONTENT_ROOT = path.join(ROOT, 'content');
const WRITE = process.argv.includes('--write');
let writeTmpSeq = 0;
const ENTRY_RE = /['"]blog\.article\.([^'"]+)\.([^'"]+)['"]\s*:\s*(['"])((?:\\.|(?!\3)[^\r\n])*?)\3\s*(?=[,}])/gu;

function walk(directory, output = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file, output);
    else if (entry.isFile() && file.endsWith('.ts')) output.push(file);
  }
  return output;
}

function isCorpusFile(file) {
  const relative = path.relative(ROOT, file);
  return relative.split(path.sep).some((part) => part.startsWith('blog-body'))
    || /^content\/blog-meta(?:-canton-[^-]+|-ch)?-(?:it|en|de|fr)\.ts$/u.test(relative);
}

function localeForFile(file) {
  const basename = path.basename(file);
  const metaLocale = basename.match(/-(it|en|de|fr)\.ts$/u)?.[1];
  if (metaLocale) return metaLocale;
  return file.split(path.sep).reverse().find((part) => LOCALIZED_TOPONYM_LOCALES.includes(part)) || null;
}

function rawValuePosition(match) {
  const colon = match[0].indexOf(':');
  const quote = match[3];
  const quotePosition = match[0].indexOf(quote, colon);
  const start = (match.index ?? 0) + quotePosition + 1;
  return { start, end: start + match[4].length };
}

const files = walk(CONTENT_ROOT).filter(isCorpusFile);
const fileSources = new Map();
const sourceValues = new Map();
const targets = [];

for (const file of files) {
  const locale = localeForFile(file);
  if (!locale) continue;
  const source = readFileSync(file, 'utf8');
  fileSources.set(file, source);
  for (const match of source.matchAll(ENTRY_RE)) {
    const key = `${match[1]}|${match[2]}`;
    if (locale === 'it') {
      const values = sourceValues.get(key) || new Set();
      values.add(match[4]);
      sourceValues.set(key, values);
    } else {
      targets.push({ file, locale, key, raw: match[4], ...rawValuePosition(match) });
    }
  }
}

const editsByFile = new Map();
const byLocale = new Map(LOCALIZED_TOPONYM_LOCALES.filter((locale) => locale !== 'it').map((locale) => [locale, 0]));
const byForm = new Map();
let fieldsChanged = 0;
let replacements = 0;

for (const target of targets) {
  const references = sourceValues.get(target.key);
  if (!references) continue;
  let next = target.raw;
  const issues = new Map();
  for (const sourceText of references) {
    const result = replaceLocalizedToponymMismatches({
      sourceText,
      targetText: next,
      locale: target.locale,
    });
    next = result.text;
    replacements += result.replacements;
    for (const issue of result.issues) {
      const issueKey = `${issue.code}|${issue.locale}|${issue.form}|${issue.expected}`;
      issues.set(issueKey, issue);
    }
  }
  if (next === target.raw) continue;
  const edits = editsByFile.get(target.file) || [];
  edits.push({ start: target.start, end: target.end, value: next });
  editsByFile.set(target.file, edits);
  fieldsChanged += 1;
  for (const issue of issues.values()) {
    const issueKey = `${issue.code}|${issue.locale}|${issue.form}|${issue.expected}`;
    // The field may contain the same foreign exonym more than once; report
    // actual token replacements, not merely the number of flagged fields.
    const count = [...references].reduce((total, sourceText) => {
      const result = replaceLocalizedToponymMismatches({
        sourceText,
        targetText: target.raw,
        locale: target.locale,
      });
      return total + (result.replacementCounts.get(issueKey) || 0);
    }, 0);
    byLocale.set(target.locale, (byLocale.get(target.locale) || 0) + count);
    const formKey = `${target.locale}|${issue.form}|${issue.expected}`;
    byForm.set(formKey, (byForm.get(formKey) || 0) + count);
  }
}

if (WRITE) {
  for (const [file, edits] of editsByFile) {
    let source = fileSources.get(file);
    for (const edit of edits.sort((left, right) => right.start - left.start)) {
      source = `${source.slice(0, edit.start)}${edit.value}${source.slice(edit.end)}`;
    }
    const tmp = `${file}.${process.pid}.${writeTmpSeq++}.tmp`;
    try {
      writeFileSync(tmp, source, 'utf8');
      renameSync(tmp, file);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
      throw error;
    }
  }
}

console.log(JSON.stringify({
  mode: WRITE ? 'write' : 'dry-run',
  filesScanned: files.length,
  fieldsChanged,
  replacements,
  byLocale: Object.fromEntries(byLocale),
  byForm: Object.fromEntries([...byForm].sort((left, right) => right[1] - left[1])),
}, null, 2));
