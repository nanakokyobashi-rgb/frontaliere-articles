#!/usr/bin/env node
/**
 * Misura i fatti chiave senza valore nel corpus pubblicato (issue #1054).
 *
 * Lo scanner e' read-only: non riscrive `content/` e non applica il gate. La
 * prevenzione e' nel percorso di generazione; questo comando rende osservabile
 * l'arretrato per file-locale, articolo distinto e lingua.
 *
 * Uso:
 *   node generator/scripts/scan-vacuous-key-facts.mjs
 *   node generator/scripts/scan-vacuous-key-facts.mjs --list
 *   node generator/scripts/scan-vacuous-key-facts.mjs --json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findReferenceVacuousFacts,
  SUPPORTED_LOCALES,
} from './lib/key-facts-specificity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BODY_DIRS = ['blog-body', 'blog-body-ch'];

/** Inverso per i literal TS emessi dal generatore, comprese \u/\x escapate. */
export function unescapeTs(value) {
  return value.replace(
    /\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})|\\(?:\r\n|\r|\n)|\\(.)/giu,
    (match, codePoint, unicode, hex, character) => {
      if (codePoint) {
        const valuePoint = Number.parseInt(codePoint, 16);
        return valuePoint <= 0x10ffff ? String.fromCodePoint(valuePoint) : match;
      }
      if (unicode) return String.fromCharCode(Number.parseInt(unicode, 16));
      if (hex) return String.fromCharCode(Number.parseInt(hex, 16));
      return {
        b: '\b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t',
        v: '\v',
        '0': '\0',
        '\\': '\\',
        "'": "'",
        '"': '"',
        '`': '`',
      }[character] ?? character ?? match;
    },
  );
}

// Support all static TS string delimiters. The value is still ignored when it
// contains `${...}` because evaluating an interpolated template would require
// executing corpus code; the scanner must remain read-only and deterministic.
const BODY_LITERAL_RX = /(['"`])blog\.article\.([^'"`]+)\.(body\d+)\1\s*:\s*(['"`])((?:\\[\s\S]|(?!\4)[\s\S])*)\4/gu;

function* iterateBodies(root) {
  for (const directory of BODY_DIRS) {
    for (const locale of SUPPORTED_LOCALES) {
      const absoluteDirectory = path.join(root, 'content', directory, locale);
      if (!fs.existsSync(absoluteDirectory)) continue;
      for (const file of fs.readdirSync(absoluteDirectory).sort()) {
        if (!file.endsWith('.ts')) continue;
        const absoluteFile = path.join(absoluteDirectory, file);
        const source = fs.readFileSync(absoluteFile, 'utf8');
        for (const match of source.matchAll(BODY_LITERAL_RX)) {
          if (match[5].includes('${')) continue;
          yield {
            rel: path.join('content', directory, locale, file),
            id: match[2],
            field: match[3],
            locale,
            value: unescapeTs(match[5]),
          };
        }
      }
    }
  }
}

function newLocaleReport() {
  return { files: new Set(), articles: new Set(), hits: 0 };
}

/**
 * @param {string} [root=ROOT]
 * @returns {{fieldsScanned: number, files: string[], articles: string[], byKind: object, articlesByKind: object, byLocale: object, fileSummaries: object[], hits: object[]}}
 */
export function scanCorpus(root = ROOT) {
  const files = new Set();
  const articlesByKind = {
    'placeholder-value': new Set(),
    'hedged-prose': new Set(),
  };
  const byKind = {
    'placeholder-value': 0,
    'hedged-prose': 0,
  };
  const byLocale = Object.fromEntries(SUPPORTED_LOCALES.map((locale) => [locale, newLocaleReport()]));
  const fileSummaries = new Map();
  const hits = [];
  let fieldsScanned = 0;

  for (const entry of iterateBodies(root)) {
    fieldsScanned += 1;
    // Keep the metric byte-for-byte comparable with #1054's reference grep.
    // The broader `findVacuousFacts()` belongs to the prevention gate and is
    // intentionally not used to recalculate this historical baseline.
    const entryHits = findReferenceVacuousFacts(entry.value);
    if (entryHits.length === 0) continue;

    files.add(entry.rel);
    const localeReport = byLocale[entry.locale];
    localeReport.files.add(entry.rel);
    localeReport.articles.add(entry.id);
    const fileSummary = fileSummaries.get(entry.rel) || {
      file: entry.rel,
      locale: entry.locale,
      hits: 0,
      articles: new Set(),
    };
    fileSummary.articles.add(entry.id);
    fileSummary.hits += entryHits.length;
    fileSummaries.set(entry.rel, fileSummary);

    for (const hit of entryHits) {
      const kind = 'placeholder-value';
      byKind[kind] += 1;
      articlesByKind[kind].add(entry.id);
      localeReport.hits += 1;
      hits.push({
        ...hit,
        kind,
        file: entry.rel,
        id: entry.id,
        field: entry.field,
        locale: entry.locale,
      });
    }
  }

  const allArticles = new Set([
    ...articlesByKind['placeholder-value'],
    ...articlesByKind['hedged-prose'],
  ]);
  return {
    fieldsScanned,
    files: [...files].sort(),
    articles: [...allArticles].sort(),
    byKind,
    articlesByKind: Object.fromEntries(
      Object.entries(articlesByKind).map(([kind, ids]) => [kind, [...ids].sort()]),
    ),
    byLocale: Object.fromEntries(
      Object.entries(byLocale).map(([locale, report]) => [locale, {
        files: [...report.files].sort(),
        articles: [...report.articles].sort(),
        hits: report.hits,
      }]),
    ),
    fileSummaries: [...fileSummaries.values()]
      .map((summary) => ({ ...summary, articles: [...summary.articles].sort() }))
      .sort((a, b) => a.file.localeCompare(b.file)),
    hits,
  };
}

export function printReport(report, { list = false } = {}) {
  if (list) {
    for (const hit of report.hits) {
      const flat = hit.text.replace(/\s+/gu, ' ').slice(0, 160);
      console.log(`${hit.kind}\t${hit.file}\t${hit.id}.${hit.field}\t${flat}`);
    }
    if (report.hits.length > 0) console.log('');
  }

  console.log(`Campi body scanditi ......... ${report.fieldsScanned}`);
  console.log(`File-locale con almeno un hit ${report.files.length}`);
  console.log(`Articoli distinti ........... ${report.articles.length}`);
  console.log('Per file-locale:');
  for (const file of report.fileSummaries) {
    console.log(`  ${file.file}\t${file.hits} hit`);
  }
  console.log('Per locale:');
  for (const locale of SUPPORTED_LOCALES) {
    const value = report.byLocale[locale];
    console.log(`  ${locale}\t${value.files.length} file-locale\t${value.articles.length} articoli\t${value.hits} hit`);
  }
  console.log(`placeholder-value .......... ${report.byKind['placeholder-value']} coppie su ${report.articlesByKind['placeholder-value'].length} articoli`);
  console.log(`hedged-prose ............... ${report.byKind['hedged-prose']} bullet su ${report.articlesByKind['hedged-prose'].length} articoli`);
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const report = scanCorpus();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report, { list: process.argv.includes('--list') });
  }
}
