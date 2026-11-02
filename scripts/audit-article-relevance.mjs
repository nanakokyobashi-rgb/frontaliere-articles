#!/usr/bin/env node
/**
 * audit-article-relevance.mjs — applica `classifyArticleRelevance` a tutto il
 * corpus pubblicato e mantiene `content/article-index-exclusions.json`.
 *
 * Il ledger e' committato, non calcolato al build, per due ragioni. Cambiare una
 * parola del lessico non deve togliere pagine dall'indice in silenzio: lo
 * spostamento si vede nel diff di una PR. E il sito lo legge via HTTP-mirror, senza
 * il classificatore, che vive nel generatore del corpus.
 *
 * Gli articoli NON si cancellano: restano pubblicati con `noindex,follow`, fuori
 * da sitemap, sitemap-news, RSS e famiglia llms.
 *
 * `manualExclusions` e `manualKeeps` sono le decisioni editoriali che il
 * classificatore non puo' prendere: restano nel ledger attraverso le rigenerazioni.
 *
 * Uso:
 *   node scripts/audit-article-relevance.mjs            # misura, non scrive
 *   node scripts/audit-article-relevance.mjs --write    # riscrive il ledger
 *   node scripts/audit-article-relevance.mjs --check    # esce 1 se il ledger e' fuori sync
 */
import '../host/cantonSectionsBootstrap.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARTICLE_SECTION_CORE_ALL } from '../engine/shared/articleSectionCore.mjs';
import { corpusPath } from '../generator/scripts/lib/corpus-paths.mjs';
import { unescapeForSingleQuoteTS } from '../generator/scripts/lib/article-meta-block.mjs';
import { writeFileAtomic } from '../generator/scripts/lib/atomic-write-file.mjs';
import { classifyArticleRelevance } from '../generator/scripts/lib/article-relevance-gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LEDGER_FILE = 'content/article-index-exclusions.json';

const DOC = 'Articoli pubblicati ma ritirati dall\'indice per mancanza di nesso con frontalieri, Ticino, '
  + 'Svizzera, confine o lavoro. Generato da scripts/audit-article-relevance.mjs (--write): non modificare '
  + '`excluded` a mano, le decisioni editoriali stanno in `manualExclusions` e `manualKeeps`. Letto da '
  + 'engine/shared/articleIndexExclusions.mjs (noindex,follow e RSS) e da scripts/build-api.mjs (sitemap, '
  + 'quindi sitemap-news e llms). Le pagine restano vive.';

const META_LINE_RE = /^\s*'(?:blog|swiss)\.article\.([^.']+)\.(title|excerpt)':\s*'((?:[^'\\]|\\.)*)'/;
const BODY_LITERAL_RE = /'blog\.article\.[^']+\.body\d+':\s*'((?:[^'\\]|\\.)*)'/g;
const REGISTRY_ID_RE = /^\s*id:\s*'([^']+)',/gm;

function readIfPresent(rel) {
  const file = path.join(ROOT, rel);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

function readMeta(metaPrefix) {
  const source = readIfPresent(corpusPath(`services/locales/${metaPrefix}-it.ts`)) ?? '';
  const meta = {};
  for (const line of source.split('\n')) {
    const match = META_LINE_RE.exec(line);
    if (match) (meta[match[1]] ??= {})[match[2]] = unescapeForSingleQuoteTS(match[3]);
  }
  return meta;
}

function readBody(bodyDir, id) {
  const source = readIfPresent(corpusPath(`services/locales/${bodyDir}/it/${id}.ts`));
  if (source === null) return '';
  return [...source.matchAll(BODY_LITERAL_RE)].map((match) => unescapeForSingleQuoteTS(match[1])).join('\n');
}

/** Ogni articolo italiano del corpus, per ogni sezione che ha un registro su disco. */
export function readCorpusArticles() {
  const articles = [];
  for (const core of Object.values(ARTICLE_SECTION_CORE_ALL)) {
    const registry = readIfPresent(corpusPath(core.registryFile));
    if (registry === null) continue;
    const meta = readMeta(core.metaPrefix);
    for (const [, id] of registry.matchAll(REGISTRY_ID_RE)) {
      articles.push({
        section: core.section,
        id,
        title: meta[id]?.title ?? '',
        excerpt: meta[id]?.excerpt ?? '',
        body: readBody(core.bodyDir, id),
      });
    }
  }
  return articles;
}

function currentLedger() {
  const raw = readIfPresent(LEDGER_FILE);
  return raw === null ? { manualExclusions: [], manualKeeps: [], excluded: [] } : JSON.parse(raw);
}

export function buildLedger(articles, previous = currentLedger()) {
  const key = (row) => `${row.section}|${row.id}`;
  const keeps = new Set((previous.manualKeeps ?? []).map(key));
  const manual = new Map((previous.manualExclusions ?? []).map((row) => [key(row), row]));
  const known = new Set(articles.map(key));
  for (const rowKey of [...keeps, ...manual.keys()]) {
    if (!known.has(rowKey)) throw new Error(`article-index-exclusions: voce manuale senza articolo: ${rowKey}`);
  }
  const excluded = [];
  for (const article of articles) {
    const rowKey = key(article);
    const manualRow = manual.get(rowKey);
    if (manualRow) {
      excluded.push({ section: article.section, id: article.id, rule: 'manuale', reason: manualRow.reason });
      continue;
    }
    if (keeps.has(rowKey)) continue;
    const verdict = classifyArticleRelevance(article);
    if (verdict.relevant) continue;
    excluded.push({
      section: article.section,
      id: article.id,
      rule: verdict.rule,
      ...(verdict.family ? { family: verdict.family, term: verdict.term } : {}),
    });
  }
  excluded.sort((a, b) => key(a).localeCompare(key(b)));
  return {
    _doc: DOC,
    manualExclusions: previous.manualExclusions ?? [],
    manualKeeps: previous.manualKeeps ?? [],
    excluded,
  };
}

function summarize(ledger, total) {
  const counts = {};
  for (const row of ledger.excluded) {
    const label = row.family ?? row.rule;
    counts[label] = (counts[label] ?? 0) + 1;
  }
  const bySection = {};
  for (const row of ledger.excluded) {
    const label = row.section.startsWith('canton-') ? 'cantoni' : row.section;
    bySection[label] = (bySection[label] ?? 0) + 1;
  }
  return { articoli: total, esclusi: ledger.excluded.length, perRegola: counts, perSezione: bySection };
}

function main(argv) {
  const articles = readCorpusArticles();
  const ledger = buildLedger(articles);
  const text = `${JSON.stringify(ledger, null, 2)}\n`;
  console.log(JSON.stringify(summarize(ledger, articles.length), null, 2));
  if (argv.includes('--list')) {
    for (const row of ledger.excluded) console.log(`${row.rule}\t${row.family ?? ''}\t${row.term ?? ''}\t${row.section}\t${row.id}`);
  }
  if (argv.includes('--write')) {
    writeFileAtomic(path.join(ROOT, LEDGER_FILE), text);
    return 0;
  }
  if (argv.includes('--check') && readIfPresent(LEDGER_FILE) !== text) {
    console.error(`${LEDGER_FILE} non corrisponde al corpus: rigeneralo con --write e rivedi il diff.`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
