#!/usr/bin/env node
/**
 * Misura lo stock dei body italiani con una lista di fatti chiave orfana
 * (issue #2325).
 *
 * Lo scanner e' esclusivamente read-only. Produce l'elenco dei file e una
 * prova del diff previsto: una sola riga aggiunta, l'heading localizzato, nel
 * punto in cui oggi iniziano i bullet. Non contiene un ramo di applicazione e
 * non riscrive mai `content/**`.
 *
 * Uso:
 *   node generator/scripts/scan-keyfacts-heading-stock.mjs
 *   node generator/scripts/scan-keyfacts-heading-stock.mjs --root /path/to/repo --list
 *   node generator/scripts/scan-keyfacts-heading-stock.mjs --root /path/to/repo --json
 */

import fs, { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getKeyFactsHeading } from './lib/ai-search-template.mjs';
import { findOrphanedKeyFactsList } from './lib/key-facts-specificity.mjs';
import { unescapeTs } from './scan-vacuous-key-facts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BODY_DIRS = Object.freeze(['blog-body', 'blog-body-ch']);
export const STOCK_BASELINE = Object.freeze({
  total: 0,
  byTree: Object.freeze({
    'blog-body': 0,
    'blog-body-ch': 0,
  }),
});

const BODY_LITERAL_RX = /(['"`])blog\.article\.([^'"`]+)\.(body\d+)\1\s*:\s*(['"`])((?:\\[\s\S]|(?!\4)[\s\S])*)\4/gu;

function normalizedRelativePath(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join('/');
}

function exactSingleLineInsertion(before, after) {
  if (after.length !== before.length + 1) return null;
  for (let index = 0; index < after.length; index += 1) {
    if (before.slice(0, index).some((line, offset) => line !== after[offset])) continue;
    if (before.slice(index).some((line, offset) => line !== after[index + 1 + offset])) continue;
    return { index, added: after[index] };
  }
  return null;
}

/**
 * Plans, without applying, the one-line correction for an orphaned list.
 *
 * @param {string} body1
 * @param {'it'|'en'|'de'|'fr'} [locale='it']
 * @returns {{heading: string, bulletCount: number, insertBeforeLine: number, diff: object}|null}
 */
export function planKeyFactsHeadingInsertion(body1, locale = 'it') {
  const orphan = findOrphanedKeyFactsList(body1, locale);
  if (!orphan) return null;

  const lines = body1.split('\n');
  const insertAt = orphan.lineIndex - 1;
  if (insertAt < 0) throw new Error('Posizione di inserimento non valida per la lista orfana');
  const plannedLines = [
    ...lines.slice(0, insertAt),
    getKeyFactsHeading(locale),
    ...lines.slice(insertAt),
  ];
  const diff = exactSingleLineInsertion(lines, plannedLines);
  if (!diff || diff.added !== getKeyFactsHeading(locale)) {
    throw new Error('Il diff previsto non e\' una singola aggiunta dell\'heading dei fatti chiave');
  }

  return {
    heading: orphan.heading,
    bulletCount: orphan.bulletCount,
    // 1-based line number in the original decoded body, before which the
    // read-only plan would add the heading.
    insertBeforeLine: insertAt + 1,
    diff: {
      exact: true,
      addedLines: [diff.added],
      removedLines: [],
      changedLines: 1,
    },
  };
}

function body1FromSource(source) {
  for (const match of source.matchAll(BODY_LITERAL_RX)) {
    if (match[3] !== 'body1' || match[5].includes('${')) continue;
    return unescapeTs(match[5]);
  }
  return null;
}

/**
 * @param {string} [root=ROOT]
 * @returns {{root: string, filesScanned: number, total: number, byTree: object, entries: object[]}}
 */
export function scanKeyFactsHeadingStock(root = ROOT) {
  const absoluteRoot = path.resolve(root);
  const entries = [];
  const byTree = Object.fromEntries(BODY_DIRS.map((directory) => [directory, 0]));
  let filesScanned = 0;

  for (const directory of BODY_DIRS) {
    const absoluteDirectory = path.join(absoluteRoot, 'content', directory, 'it');
    if (!fs.existsSync(absoluteDirectory)) {
      throw new Error(`Directory del corpus non trovato: ${absoluteDirectory}`);
    }
    for (const file of fs.readdirSync(absoluteDirectory).sort()) {
      if (!file.endsWith('.ts')) continue;
      filesScanned += 1;
      const absoluteFile = path.join(absoluteDirectory, file);
      const body1 = body1FromSource(fs.readFileSync(absoluteFile, 'utf8'));
      if (body1 === null) continue;
      const plan = planKeyFactsHeadingInsertion(body1, 'it');
      if (!plan) continue;
      byTree[directory] += 1;
      entries.push({
        path: normalizedRelativePath(absoluteRoot, absoluteFile),
        id: file.slice(0, -3),
        bulletCount: plan.bulletCount,
        insertBeforeLine: plan.insertBeforeLine,
        diff: plan.diff,
      });
    }
  }

  return {
    root: absoluteRoot,
    filesScanned,
    total: entries.length,
    byTree,
    entries,
  };
}

export function printReport(report, { list = true } = {}) {
  console.log(`Stock lista orfana .......... ${report.total}`);
  console.log(`  blog-body ................. ${report.byTree['blog-body']}`);
  console.log(`  blog-body-ch .............. ${report.byTree['blog-body-ch']}`);
  console.log(`File italiani scanditi ...... ${report.filesScanned}`);
  console.log('Diff previsto (sola lettura): + una riga heading, nessuna riga rimossa');
  if (!list) return;
  for (const entry of report.entries) {
    console.log(
      `${entry.path}\t+${entry.diff.addedLines[0]}\tprima della riga ${entry.insertBeforeLine}`
      + `\t${entry.diff.exact ? 'diff esatto' : 'diff non esatto'}`,
    );
  }
}

function parseArgs(args) {
  let root = ROOT;
  let json = false;
  let list = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--root') {
      if (!args[index + 1]) throw new Error('--root richiede un percorso');
      root = args[index + 1];
      index += 1;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--list') {
      list = true;
    } else {
      throw new Error(`Opzione non supportata: ${arg}`);
    }
  }
  return { root, json, list };
}

const invokedDirectly = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] || '');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = scanKeyFactsHeadingStock(options.root);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printReport(report, { list: options.list });
    }
  } catch (error) {
    console.error(`scan-keyfacts-heading-stock: ${error.message}`);
    process.exitCode = 1;
  }
}
