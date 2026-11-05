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
 * del corpus (chiavi quoted e stringhe single/double-quoted/static template literals).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectLanguageWithConfidence } from '../../generator/scripts/lib/detect-language.mjs';
import '../../host/cantonSectionsBootstrap.mjs';
import { CORPUS_SECTIONS } from '../lib/corpus-sections.mjs';
import { floorFrom } from '../lib/corpus-floors.mjs';
import { extractBodyFields } from '../lib/article-body-api.mjs';

export { extractBodyFields };

export function formatViolationForCli(violation, { redactPaths = false } = {}) {
  if (!redactPaths) return violation?.message ?? 'content completeness violation';
  const code = typeof violation?.code === 'string' ? violation.code : 'content-violation';
  const section = typeof violation?.section === 'string' ? violation.section : 'unknown';
  const locale = typeof violation?.locale === 'string' ? violation.locale : 'unknown';
  return `[${code}] section=${section} locale=${locale}: content check failed`;
}

export function projectReportForCli(report, { redactPaths = false } = {}) {
  if (!redactPaths) return report;
  return {
    ...report,
    changedPaths: Array.isArray(report?.changedPaths)
      ? report.changedPaths.map(() => '[path redacted]')
      : report?.changedPaths ?? null,
    violations: Array.isArray(report?.violations)
      ? report.violations.map((violation) => ({
        code: violation?.code ?? 'content-violation',
        section: violation?.section ?? 'unknown',
        locale: violation?.locale ?? 'unknown',
        message: formatViolationForCli(violation, { redactPaths: true }),
      }))
      : report?.violations,
  };
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Le radici dei corpi vengono dal core (sezioni ATTIVE), non da una coppia
// scritta a mano: una sezione accesa nel core e' sorvegliata senza toccare qui.
// `floorPolicy` e `registryFile` decidono quali pavimenti valgono per la radice
// (vedi `inspectBlogLocaleCompleteness`).
export const BODY_ROOTS = Object.freeze(
  CORPUS_SECTIONS.map((section) => Object.freeze({
    rel: section.bodyDir,
    name: section.section,
    floorPolicy: section.floorPolicy,
    registryFile: section.registryFile,
  })),
);

const REGISTRY_ID_RE = /^\s*id:\s*(?:'[^']+'|"[^"]+")/gm;

/** Voci del registro sorgente; 0 se il registro non esiste (sezione di famiglia nuova). */
function registryEntryCount(root, rel) {
  try {
    return (fs.readFileSync(path.join(root, rel), 'utf8').match(REGISTRY_ID_RE) ?? []).length;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}
export const LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);
export const TARGET_LOCALES = Object.freeze(['en', 'de', 'fr']);

/**
 * Decode `git status --porcelain=v1 -z` without losing paths that contain
 * whitespace. Rename/copy records carry a second NUL-delimited path; keeping
 * both is harmless for the body-file selector and preserves fail-closed
 * behaviour if a writer ever renames a generated body.
 */
export function parseGitStatusPaths(raw) {
  const fields = String(raw ?? '').split('\0');
  const paths = [];
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    const file = record.slice(3);
    if (file) paths.push(file);
    if (/[RC]/u.test(status) && fields[index + 1]) {
      paths.push(fields[index + 1]);
      index += 1;
    }
  }
  return paths;
}

/**
 * Read the body paths changed in the current writer worktree. A scoped writer
 * gate must fail if this read fails; an empty result is the safe no-op for a
 * run that did not write a body.
 */
export function changedPathsFromGit(root = ROOT) {
  const raw = execFileSync(
    'git',
    [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '-z',
      '--',
      ...BODY_ROOTS.map(({ rel }) => rel),
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  return parseGitStatusPaths(raw);
}
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

function inspectLocale({
  root,
  bodyRoot,
  locale,
  expectedByFile,
  sourceByFile,
  violations,
  checkLanguage,
  selectedFiles = null,
}) {
  const localeDir = path.join(root, bodyRoot.rel, locale);
  const localeFiles = new Set(listTsFiles(localeDir));

  const files = selectedFiles === null
    ? [...expectedByFile.keys()]
    : [...selectedFiles].filter((file) => expectedByFile.has(file)).sort();
  for (const file of files) {
    const expected = expectedByFile.get(file);
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

  if (selectedFiles === null) {
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
}

/**
 * Scans both corpus roots.
 *
 * @param {{root?: string, minItalianFiles?: number, minItalianFields?: number,
 *   checkLanguage?: boolean, bodyRoots?: Array<object>, changedPaths?: string[]|null}} options
 */
export function inspectBlogLocaleCompleteness({
  root = ROOT,
  minItalianFiles = MIN_ITALIAN_FILES,
  minItalianFields = MIN_ITALIAN_FIELDS,
  checkLanguage = false,
  bodyRoots = BODY_ROOTS,
  changedPaths = null,
} = {}) {
  const scoped = Array.isArray(changedPaths);
  const violations = [];
  const sections = [];
  // I pavimenti ASSOLUTI (anti-checkout-sparse) valgono per le radici con
  // politica `section`, le storiche. Una radice di famiglia (cantonale) parte
  // legittimamente a zero corpi: per lei il riferimento e' il suo registro, e
  // si giudica la famiglia — nessuna sezione con voci nel registro puo' avere
  // zero corpi italiani, e il totale deve reggere il pavimento relativo.
  const familyRows = [];
  for (const bodyRoot of bodyRoots) {
    const italianDir = path.join(root, bodyRoot.rel, 'it');
    const italianFiles = listTsFiles(italianDir);
    const selectedFiles = scoped
      ? new Set(
        (changedPaths ?? [])
          .map((changedPath) => String(changedPath).replaceAll('\\', '/'))
          .flatMap((changedPath) => {
            const prefix = `${String(bodyRoot.rel).replaceAll('\\', '/')}/`;
            if (!changedPath.startsWith(prefix)) return [];
            const parts = changedPath.slice(prefix.length).split('/');
            if (parts.length !== 2 || !LOCALES.includes(parts[0]) || !parts[1].endsWith('.ts')) {
              return [];
            }
            return [parts[1]];
          }),
      )
      : null;
    const filesToCheck = scoped ? [...selectedFiles].sort() : italianFiles;
    const italianFileSet = new Set(italianFiles);
    const expectedByFile = new Map();
    const sourceByFile = new Map();
    let italianFields = 0;
    const familyRoot = bodyRoot.floorPolicy === 'family';
    if (!scoped && familyRoot) {
      familyRows.push({
        section: bodyRoot.name,
        rel: bodyRoot.rel,
        registry: registryEntryCount(root, bodyRoot.registryFile),
        files: italianFiles.length,
      });
    }

    if (!scoped && !familyRoot && italianFiles.length < minItalianFiles) {
      addViolation(violations, {
        code: 'source-floor',
        section: bodyRoot.name,
        locale: 'it',
        path: path.join(bodyRoot.rel, 'it'),
        message: `${bodyRoot.rel}/it: solo ${italianFiles.length} file italiani `
          + `(floor ${minItalianFiles})`,
      });
    }
    for (const file of filesToCheck) {
      const relativePath = path.join(bodyRoot.rel, 'it', file);
      if (!italianFileSet.has(file)) {
        addViolation(violations, {
          code: 'missing-source-file',
          section: bodyRoot.name,
          locale: 'it',
          file,
          path: relativePath,
          message: `${relativePath}: file sorgente italiana assente`,
        });
        continue;
      }
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
    if (!scoped && !familyRoot && italianFields < minItalianFields) {
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
      inspectLocale({
        root,
        bodyRoot,
        locale,
        expectedByFile,
        sourceByFile,
        violations,
        checkLanguage,
        selectedFiles,
      });
    }
    sections.push({
      section: bodyRoot.name,
      root: bodyRoot.rel,
      italianFiles: italianFiles.length,
      italianFields,
      expectedFiles: expectedByFile.size,
      checkedFiles: filesToCheck.length,
    });
  }

  if (!scoped) {
    const familyRegistry = familyRows.reduce((total, row) => total + row.registry, 0);
    const familyFiles = familyRows.reduce((total, row) => total + row.files, 0);
    const familyFloor = floorFrom(familyRegistry);
    for (const row of familyRows) {
      if (row.registry > 0 && row.files === 0) {
        addViolation(violations, {
          code: 'family-source-floor',
          section: row.section,
          locale: 'it',
          path: path.join(row.rel, 'it'),
          message: `${row.rel}/it: 0 file italiani contro ${row.registry} voci del registro`,
        });
      }
    }
    if (familyRows.length > 0 && familyFiles < familyFloor) {
      addViolation(violations, {
        code: 'family-source-floor',
        section: familyRows.map((row) => row.section).join(','),
        locale: 'it',
        path: familyRows.map((row) => `${row.rel}/it`).join(', '),
        message: `famiglia ${familyRows.map((row) => row.section).join(', ')}: ${familyFiles} file italiani `
          + `contro ${familyRegistry} voci dei registri (floor ${familyFloor})`,
      });
    }
  }

  const byCode = {};
  for (const violation of violations) byCode[violation.code] = (byCode[violation.code] || 0) + 1;
  return {
    ok: violations.length === 0,
    scoped,
    changedPaths: scoped ? [...(changedPaths ?? [])] : null,
    sections,
    violations,
    counts: byCode,
    totalViolations: violations.length,
  };
}

function main() {
  const args = new Set(process.argv.slice(2));
  const redactPaths = args.has('--redact-paths');
  let changedPaths = null;
  if (args.has('--changed-paths')) {
    try {
      changedPaths = changedPathsFromGit(ROOT);
    } catch (error) {
      console.error(`::error::impossibile leggere i path cambiati del worktree: ${String(error)}`);
      process.exitCode = 1;
      return;
    }
  }
  const report = inspectBlogLocaleCompleteness({
    checkLanguage: args.has('--language'),
    changedPaths,
  });
  if (args.has('--json')) {
    console.log(JSON.stringify(projectReportForCli(report, { redactPaths }), null, 2));
  } else {
    if (report.scoped) {
      console.log(`Scope: ${report.changedPaths.length} path cambiati, solo body localizzati`);
    }
    for (const section of report.sections) {
      const checked = report.scoped ? `, ${section.checkedFiles} file verificati` : '';
      console.log(`${section.section}: ${section.italianFiles} file IT, ${section.italianFields} body fields attesi${checked}`);
    }
    console.log(`Violazioni: ${report.totalViolations}`);
    for (const [code, count] of Object.entries(report.counts)) console.log(`  ${code}: ${count}`);
    for (const violation of report.violations.slice(0, 80)) {
      console.error(`::error::${formatViolationForCli(violation, { redactPaths })}`);
    }
    if (report.violations.length > 80) {
      console.error(`::error::altre ${report.violations.length - 80} violazioni non mostrate`);
    }
  }
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
