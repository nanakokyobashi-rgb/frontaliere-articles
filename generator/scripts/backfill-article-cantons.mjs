#!/usr/bin/env node
/**
 * backfill-article-cantons.mjs — backfill one-shot del campo `canton` sugli
 * articoli esistenti delle sezioni `frontaliere` e `svizzera` (D13 del piano
 * sezioni cantonali: gli articoli non si spostano, ricevono il campo).
 *
 * Uso (dalla root del corpus):
 *   node generator/scripts/backfill-article-cantons.mjs --dry-run [--report <file.md>] [--sample 50]
 *   node generator/scripts/backfill-article-cantons.mjs --write   [--report <file.md>]
 *
 * Legge, per ogni voce dei due registry, titolo ed excerpt italiani
 * (`content/blog-meta-it.ts`, `content/blog-meta-ch-it.ts`), il corpo italiano
 * (`content/blog-body{,-ch}/it/<id>.ts`) e l'URL della fonte quando e' noto
 * (ledger `data/*article-source-urls.json`, sidecar `_pool_source`), e chiede
 * a `lib/canton-classifier.mjs` i cantoni. `--write` riscrive SOLO le righe
 * `canton:` del registry; `--dry-run` non tocca nulla. In entrambi i casi
 * stampa la distribuzione per cantone e un campione deterministico di
 * assegnazioni da verificare a mano.
 *
 * Idempotente: rieseguito su un registry gia' riempito non cambia nulla, e
 * riallinea le voci se il classificatore o il testo cambiano. I due output
 * vengono preparati prima della sostituzione e un errore sincrono di rename
 * ripristina gli eventuali registry gia' sostituiti; crash tra rename non sono
 * una transazione multi-file.
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultCantonClassifier } from './lib/canton-classifier.mjs';
import { applyRegistryCantons, readRegistryCantons, registryEntrySpans } from './lib/registry-canton-field.mjs';
import { readTsStringLiteral, readTsStringMap } from './lib/ts-string-map.mjs';
import { writeFilePairAtomically } from '../../scripts/lib/write-file-pair-atomically.mjs';

// Riesportati: il lettore abita in `lib/ts-string-map.mjs`, condiviso con
// `backfill-article-type.mjs`; i test del classificatore lo importano da qui.
export { readTsStringLiteral, readTsStringMap };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const SECTIONS = Object.freeze({
  frontaliere: {
    registry: 'content/blog-articles-data.ts',
    meta: 'content/blog-meta-it.ts',
    bodyDir: 'content/blog-body/it',
    sourceLedger: 'data/article-source-urls.json',
    sidecarDir: 'data/blog-articles',
  },
  svizzera: {
    registry: 'content/swiss-articles-data.ts',
    meta: 'content/blog-meta-ch-it.ts',
    bodyDir: 'content/blog-body-ch/it',
    sourceLedger: 'data/swiss-article-source-urls.json',
    sidecarDir: 'data/swiss-articles',
  },
});

function readJsonIfExists(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** id -> URL della fonte, dai ledger (URL -> id o URL -> { articleId }). */
export function invertSourceLedger(ledger) {
  const out = new Map();
  for (const [url, value] of Object.entries(ledger || {})) {
    const id = typeof value === 'string' ? value : value?.articleId;
    if (typeof id === 'string' && id && !out.has(id)) out.set(id, url);
  }
  return out;
}

/** Gli input del classificatore per ogni voce di una sezione. */
export function loadSectionInputs(root, spec) {
  const registrySrc = readFileSync(path.join(root, spec.registry), 'utf8');
  const meta = readTsStringMap(readFileSync(path.join(root, spec.meta), 'utf8'));
  const sources = invertSourceLedger(readJsonIfExists(path.join(root, spec.sourceLedger)));
  const ids = registryEntrySpans(registrySrc).map((e) => e.id);
  const bodyDir = path.join(root, spec.bodyDir);
  const inputs = [];
  for (const id of ids) {
    const bodyFile = path.join(bodyDir, `${id}.ts`);
    let body = '';
    if (existsSync(bodyFile)) {
      body = [...readTsStringMap(readFileSync(bodyFile, 'utf8')).values()].join('\n\n');
    }
    let sourceUrl = sources.get(id) || '';
    if (!sourceUrl) {
      const sidecar = readJsonIfExists(path.join(root, spec.sidecarDir, `${id}.json`));
      if (typeof sidecar?._pool_source === 'string') sourceUrl = sidecar._pool_source;
    }
    inputs.push({
      id,
      title: meta.get(`blog.article.${id}.title`) || '',
      excerpt: meta.get(`blog.article.${id}.excerpt`) || '',
      body,
      sourceUrl,
    });
  }
  return { registrySrc, inputs };
}

const stableRank = (id) => createHash('sha256').update(`canton-sample:${id}`).digest('hex');

/** Classifica tutte le sezioni. */
export function classifyCorpus(root = ROOT, classifier = defaultCantonClassifier()) {
  const results = {};
  for (const [section, spec] of Object.entries(SECTIONS)) {
    const { registrySrc, inputs } = loadSectionInputs(root, spec);
    const rows = inputs.map((input) => ({
      section,
      id: input.id,
      title: input.title,
      hasBody: Boolean(input.body),
      cantons: classifier.classifyCantons(input),
    }));
    results[section] = { spec, registrySrc, rows };
  }
  return results;
}

function escapeCell(s) {
  return String(s).replace(/\|/gu, '\\|').replace(/\n/gu, ' ');
}

/** Report markdown: distribuzione per cantone e campione. */
export function renderReport(results, { sampleSize = 50 } = {}) {
  const lines = [];
  const all = Object.values(results).flatMap((r) => r.rows);
  const assigned = all.filter((r) => r.cantons.length > 0);
  lines.push(`Articoli: ${all.length} (con cantone: ${assigned.length}, senza: ${all.length - assigned.length}, senza corpo IT: ${all.filter((r) => !r.hasBody).length})`);
  lines.push('');
  const dist = new Map();
  for (const r of assigned) {
    for (const c of r.cantons) {
      const d = dist.get(c.canton) || { frontaliere: 0, svizzera: 0 };
      d[r.section] += 1;
      dist.set(c.canton, d);
    }
  }
  lines.push('| Cantone | frontaliere | svizzera | totale |');
  lines.push('|---|---:|---:|---:|');
  for (const [c, d] of [...dist.entries()].sort((a, b) => (b[1].frontaliere + b[1].svizzera) - (a[1].frontaliere + a[1].svizzera))) {
    lines.push(`| ${c} | ${d.frontaliere} | ${d.svizzera} | ${d.frontaliere + d.svizzera} |`);
  }
  const multi = assigned.filter((r) => r.cantons.length > 1).length;
  lines.push('');
  lines.push(`Multi-label: ${multi} articoli con piu' di un cantone.`);
  lines.push('');
  const sample = [...assigned].sort((a, b) => stableRank(a.id).localeCompare(stableRank(b.id))).slice(0, sampleSize);
  lines.push(`Campione deterministico (${sample.length}, ordinato per sha256 dell'id):`);
  lines.push('');
  lines.push('| # | Sezione | Titolo | Cantoni | Evidenza |');
  lines.push('|---:|---|---|---|---|');
  sample.forEach((r, i) => {
    const cantons = r.cantons.map((c) => `${c.canton} (${c.score})`).join(', ');
    const evidence = r.cantons.map((c) => `${c.canton}: ${c.evidence.slice(0, 3).map((e) => `${e.term}@${e.field}${e.count > 1 ? `x${e.count}` : ''}`).join(', ')}`).join('; ');
    lines.push(`| ${i + 1} | ${r.section} | ${escapeCell(r.title || r.id)} | ${cantons} | ${escapeCell(evidence)} |`);
  });
  return `${lines.join('\n')}\n`;
}

/** Riscrive i registry. @returns {{[section: string]: number}} voci cambiate */
export function writeRegistries(results, root = ROOT) {
  const changed = {};
  const writes = [];
  for (const [section, { spec, registrySrc, rows }] of Object.entries(results)) {
    const byId = new Map(rows.map((r) => [r.id, r.cantons.map((c) => c.canton)]));
    const { source, changed: n } = applyRegistryCantons(registrySrc, byId);
    // Backstop: nessuna voce persa o duplicata, e i cantoni scritti si rileggono uguali.
    const before = registryEntrySpans(registrySrc).map((e) => e.id);
    const after = registryEntrySpans(source).map((e) => e.id);
    if (before.join('\n') !== after.join('\n')) throw new Error(`${spec.registry}: l'elenco degli id e' cambiato`);
    const reread = readRegistryCantons(source);
    for (const [id, cantons] of byId) {
      const got = reread.get(id) || [];
      if (got.join(',') !== cantons.join(',')) throw new Error(`${spec.registry}: ${id} riletto ${got} invece di ${cantons}`);
    }
    if (n > 0) writes.push({ file: path.join(root, spec.registry), before: registrySrc, after: source });
    changed[section] = n;
  }
  writeFilePairAtomically(writes);
  return changed;
}

function parseArgs(argv) {
  const args = { write: false, dryRun: false, report: null, sample: 50 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--write') args.write = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--report') args.report = argv[++i];
    else if (a === '--sample') args.sample = Number(argv[++i]);
    else throw new Error(`argomento sconosciuto: ${a}`);
  }
  if (args.write === args.dryRun) throw new Error('serve esattamente uno fra --dry-run e --write');
  if (!Number.isInteger(args.sample) || args.sample < 0) throw new Error('--sample vuole un intero >= 0');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const results = classifyCorpus(ROOT);
  const report = renderReport(results, { sampleSize: args.sample });
  if (args.report) writeFileSync(args.report, report);
  process.stdout.write(report);
  if (args.write) {
    const changed = writeRegistries(results, ROOT);
    process.stdout.write(`\nvoci riscritte: ${JSON.stringify(changed)}\n`);
  } else {
    process.stdout.write('\n--dry-run: nessun file modificato\n');
  }
}

const invokedDirectly = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] || '');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err?.stack || err);
    process.exit(1);
  });
}
