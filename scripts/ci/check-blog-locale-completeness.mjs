#!/usr/bin/env node
/**
 * check-blog-locale-completeness.mjs — verifica che ogni body localizzato
 * abbia la stessa superficie di chiavi dell'italiano.
 *
 * FU-009: una traduzione può essere sintatticamente valida e tuttavia lasciare
 * una pagina senza body1..bodyN. Il publisher non se ne accorge perché i
 * body non entrano nell'API che costruisce; il sito lo scopre soltanto quando
 * prova a renderizzare la pagina. Questo controllo resta nel repo del corpus,
 * dove l'italiano è la sorgente autorevole degli id e delle chiavi.
 *
 * Il controllo è intenzionalmente dependency-free: gira prima di npm e non
 * importa il parser TypeScript. Legge soltanto la forma emessa dagli writer
 * del corpus (chiavi quoted e stringhe single-quoted/template-literal).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectLanguageWithConfidence } from '../../generator/scripts/lib/detect-language.mjs';
import { CORPUS_SECTIONS } from '../lib/corpus-sections.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Le radici dei corpi vengono dal core (sezioni ATTIVE), non da una coppia
// scritta a mano: una sezione accesa nel core e' sorvegliata senza toccare qui.
export const BODY_ROOTS = Object.freeze(
  CORPUS_SECTIONS.map((section) => Object.freeze({ rel: section.bodyDir, name: section.section })),
);
export const LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);
export const TARGET_LOCALES = Object.freeze(['en', 'de', 'fr']);
// Keep this in lockstep with buildBodyFile() in
// generator/scripts/create-article.mjs: body1..body3 are required by the
// historical schema; body4..body20 are optional per article and must still be
// propagated to every locale when the writer emits them.
export const MAX_BODY_KEYS = 20;
export const BODY_FIELDS = Object.freeze(
  Array.from({ length: MAX_BODY_KEYS }, (_, index) => `body${index + 1}`),
);
export const REQUIRED_BODY_FIELDS = Object.freeze(BODY_FIELDS.slice(0, 3));

// These are ratchets, not a content count to be updated whenever a file is
// added. They make an empty/truncated checkout fail instead of auto-passing.
export const MIN_ITALIAN_FILES = 1000;
export const MIN_ITALIAN_FIELDS = 3000;
export const LANGUAGE_CHECK_MIN_CHARS = 120;
export const LANGUAGE_CHECK_MIN_CONFIDENCE = 0.65;

const STRING_QUOTES = new Set(["'", '`']);
const BODY_KEY_VALUE_RE = /^blog\.article\.([^'"\r\n]+)\.(body(?:[1-9]|1[0-9]|20))$/u;

function decodeTsString(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== '\\' || i + 1 >= raw.length) {
      out += raw[i];
      continue;
    }
    const next = raw[++i];
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else if (next === 'b') out += '\b';
    else if (next === 'f') out += '\f';
    else if (next === 'v') out += '\v';
    else if (next === '0') out += '\0';
    else out += next;
  }
  return out;
}

function readQuotedValue(source, offset) {
  let i = offset;
  while (i < source.length && /\s/u.test(source[i])) i += 1;
  const token = readQuotedToken(source, i);
  if (!token) return null;
  return { value: token.value, end: token.end };
}

function readQuotedToken(source, offset) {
  const quote = source[offset];
  if (!STRING_QUOTES.has(quote)) return null;
  const start = offset + 1;
  let i = start;
  for (; i < source.length; i += 1) {
    if (source[i] === '\\') {
      i += 1;
      continue;
    }
    if (source[i] === quote) {
      return { value: decodeTsString(source.slice(start, i)), end: i + 1 };
    }
  }
  return null;
}

function skipComment(source, offset) {
  if (source[offset] !== '/' || offset + 1 >= source.length) return offset;
  if (source[offset + 1] === '/') {
    const newline = source.indexOf('\n', offset + 2);
    return newline === -1 ? source.length : newline + 1;
  }
  if (source[offset + 1] === '*') {
    const end = source.indexOf('*/', offset + 2);
    return end === -1 ? source.length : end + 2;
  }
  return offset;
}

/**
 * Extracts body1..body20 entries and their decoded values. The writer emits
 * body1..body3 for the historical schema and body4..body20 opportunistically.
 *
 * @returns {Array<{id: string, field: string, value: string}>}
 */
export function extractBodyFields(source) {
  const text = String(source ?? '');
  const entries = [];
  // Scan string tokens instead of matching the whole file with a regexp:
  // body text and comments can contain examples that look like i18n keys.
  // A real writer key is a quoted token followed by the object-property colon.
  for (let i = 0; i < text.length;) {
    const afterComment = skipComment(text, i);
    if (afterComment !== i) {
      i = afterComment;
      continue;
    }
    const token = readQuotedToken(text, i);
    if (!token) {
      i += 1;
      continue;
    }
    let next = token.end;
    while (next < text.length && /\s/u.test(text[next])) next += 1;
    const key = BODY_KEY_VALUE_RE.exec(token.value);
    if (key && text[next] === ':') {
      const parsed = readQuotedValue(text, next + 1);
      entries.push({
        id: key[1],
        field: key[2],
        value: parsed?.value ?? null,
      });
    }
    i = token.end;
  }
  return entries;
}

function normalizeComparable(value) {
  return String(value ?? '').replace(/\r\n?/gu, '\n').trim();
}

function listTsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => entry.name)
    .sort();
}

function addViolation(violations, violation) {
  violations.push({ ...violation, path: violation.path || null });
}

function inspectLocale({ root, bodyRoot, locale, expectedByFile, sourceByFile, violations, checkLanguage }) {
  const localeDir = path.join(root, bodyRoot.rel, locale);
  const localeFiles = new Set(listTsFiles(localeDir));

  for (const [file, expected] of expectedByFile) {
    const relativePath = path.join(bodyRoot.rel, locale, file);
    const filePath = path.join(root, relativePath);
    if (!localeFiles.has(file)) {
      addViolation(violations, {
        code: 'missing-file',
        section: bodyRoot.name,
        locale,
        file,
        path: relativePath,
        fields: [...expected.keys()],
        message: `${relativePath}: file locale assente`,
      });
      continue;
    }

    const entries = extractBodyFields(fs.readFileSync(filePath, 'utf8'));
    const byField = new Map();
    for (const entry of entries) {
      if (entry.id !== file.slice(0, -3)) {
        addViolation(violations, {
          code: 'key-file-mismatch',
          section: bodyRoot.name,
          locale,
          file,
          field: entry.field,
          path: relativePath,
          message: `${relativePath}: chiave ${entry.id}.${entry.field} non corrisponde al filename`,
        });
        continue;
      }
      if (byField.has(entry.field)) {
        addViolation(violations, {
          code: 'duplicate-key',
          section: bodyRoot.name,
          locale,
          file,
          field: entry.field,
          path: relativePath,
          message: `${relativePath}: chiave duplicata ${entry.field}`,
        });
      }
      byField.set(entry.field, entry);
    }

    for (const [field, sourceEntry] of expected) {
      const entry = byField.get(field);
      if (!entry) {
        addViolation(violations, {
          code: 'missing-key',
          section: bodyRoot.name,
          locale,
          file,
          field,
          path: relativePath,
          message: `${relativePath}: chiave mancante ${field}`,
        });
        continue;
      }
      if (entry.value === null || !entry.value.trim()) {
        addViolation(violations, {
          code: 'empty-value',
          section: bodyRoot.name,
          locale,
          file,
          field,
          path: relativePath,
          message: `${relativePath}: valore vuoto per ${field}`,
        });
        continue;
      }
      if (locale !== 'it' && normalizeComparable(entry.value) === normalizeComparable(sourceEntry.value)) {
        addViolation(violations, {
          code: 'source-echo',
          section: bodyRoot.name,
          locale,
          file,
          field,
          path: relativePath,
          message: `${relativePath}: ${field} è una copia verbatim dell'italiano`,
        });
      }
      if (checkLanguage && locale !== 'it' && entry.value.length >= LANGUAGE_CHECK_MIN_CHARS) {
        const detected = detectLanguageWithConfidence(entry.value, locale);
        if (detected.lang === 'it' && detected.confidence >= LANGUAGE_CHECK_MIN_CONFIDENCE) {
          addViolation(violations, {
            code: 'wrong-locale',
            section: bodyRoot.name,
            locale,
            file,
            field,
            path: relativePath,
            detected: detected.lang,
            confidence: detected.confidence,
            message: `${relativePath}: ${field} rilevato come ${detected.lang} `
              + `(confidence ${detected.confidence.toFixed(2)})`,
          });
        }
      }
    }

    for (const field of byField.keys()) {
      if (!expected.has(field)) {
        addViolation(violations, {
          code: 'unexpected-key',
          section: bodyRoot.name,
          locale,
          file,
          field,
          path: relativePath,
          message: `${relativePath}: chiave non presente nell'italiano ${field}`,
        });
      }
    }
  }

  for (const file of localeFiles) {
    if (!expectedByFile.has(file)) {
      addViolation(violations, {
        code: 'unexpected-file',
        section: bodyRoot.name,
        locale,
        file,
        path: path.join(bodyRoot.rel, locale, file),
        message: `${bodyRoot.rel}/${locale}/${file}: file senza sorgente italiana`,
      });
    }
  }
}

/**
 * Scans both corpus roots.
 *
 * @param {{root?: string, minItalianFiles?: number, minItalianFields?: number}} options
 */
export function inspectBlogLocaleCompleteness({
  root = ROOT,
  minItalianFiles = MIN_ITALIAN_FILES,
  minItalianFields = MIN_ITALIAN_FIELDS,
  checkLanguage = false,
} = {}) {
  const violations = [];
  const sections = [];
  for (const bodyRoot of BODY_ROOTS) {
    const italianDir = path.join(root, bodyRoot.rel, 'it');
    const italianFiles = listTsFiles(italianDir);
    const expectedByFile = new Map();
    const sourceByFile = new Map();
    let italianFields = 0;

    if (italianFiles.length < minItalianFiles) {
      addViolation(violations, {
        code: 'source-floor',
        section: bodyRoot.name,
        locale: 'it',
        path: path.join(bodyRoot.rel, 'it'),
        message: `${bodyRoot.rel}/it: solo ${italianFiles.length} file italiani `
          + `(floor ${minItalianFiles})`,
      });
    }
    for (const file of italianFiles) {
      const relativePath = path.join(bodyRoot.rel, 'it', file);
      const entries = extractBodyFields(fs.readFileSync(path.join(root, relativePath), 'utf8'));
      const expected = new Map();
      for (const entry of entries) {
        if (!BODY_FIELDS.includes(entry.field)) continue;
        if (entry.id !== file.slice(0, -3)) {
          addViolation(violations, {
            code: 'key-file-mismatch',
            section: bodyRoot.name,
            locale: 'it',
            file,
            field: entry.field,
            path: relativePath,
            message: `${relativePath}: chiave ${entry.id}.${entry.field} non corrisponde al filename`,
          });
          continue;
        }
        if (expected.has(entry.field)) {
          addViolation(violations, {
            code: 'duplicate-key',
            section: bodyRoot.name,
            locale: 'it',
            file,
            field: entry.field,
            path: relativePath,
            message: `${relativePath}: chiave duplicata ${entry.field}`,
          });
          continue;
        }
        expected.set(entry.field, entry);
      }
      italianFields += expected.size;
      expectedByFile.set(file, expected);
      sourceByFile.set(file, entries);
      const missingRequiredFields = REQUIRED_BODY_FIELDS.filter((field) => !expected.has(field));
      if (missingRequiredFields.length > 0) {
        addViolation(violations, {
          code: 'source-missing-key',
          section: bodyRoot.name,
          locale: 'it',
          file,
          path: relativePath,
          fields: missingRequiredFields,
          message: `${relativePath}: sorgente italiana incompleta`,
        });
      }
    }
    if (italianFields < minItalianFields) {
      addViolation(violations, {
        code: 'source-field-floor',
        section: bodyRoot.name,
        locale: 'it',
        path: path.join(bodyRoot.rel, 'it'),
        message: `${bodyRoot.rel}/it: solo ${italianFields} body fields italiani `
          + `(floor ${minItalianFields})`,
      });
    }

    for (const locale of TARGET_LOCALES) {
      inspectLocale({ root, bodyRoot, locale, expectedByFile, sourceByFile, violations, checkLanguage });
    }
    sections.push({
      section: bodyRoot.name,
      root: bodyRoot.rel,
      italianFiles: italianFiles.length,
      italianFields,
      expectedFiles: expectedByFile.size,
    });
  }

  const byCode = {};
  for (const violation of violations) byCode[violation.code] = (byCode[violation.code] || 0) + 1;
  return {
    ok: violations.length === 0,
    sections,
    violations,
    counts: byCode,
    totalViolations: violations.length,
  };
}

function main() {
  const args = new Set(process.argv.slice(2));
  const report = inspectBlogLocaleCompleteness({ checkLanguage: args.has('--language') });
  if (args.has('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const section of report.sections) {
      console.log(`${section.section}: ${section.italianFiles} file IT, ${section.italianFields} body fields attesi`);
    }
    console.log(`Violazioni: ${report.totalViolations}`);
    for (const [code, count] of Object.entries(report.counts)) console.log(`  ${code}: ${count}`);
    for (const violation of report.violations.slice(0, 80)) console.error(`::error::${violation.message}`);
    if (report.violations.length > 80) {
      console.error(`::error::altre ${report.violations.length - 80} violazioni non mostrate`);
    }
  }
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
