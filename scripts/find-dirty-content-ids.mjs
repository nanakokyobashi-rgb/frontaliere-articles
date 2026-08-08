#!/usr/bin/env node
// find-dirty-content-ids.mjs — trova gli articoli il cui corpus porta ancora
// un control character C0 illegale (vedi scripts/lib/sanitize-control-chars.mjs),
// per pilotare la RIPUBBLICAZIONE delle pagine gia' live (issue #67).
//
// PERCHE' QUESTO SCRIPT ESISTE. #65 sanifica l'output degli emitter: da quel
// merge in poi ogni nuova pubblicazione esce pulita qualunque cosa contenga il
// corpus. Ma l'HTML gia' emesso PRIMA di #65 e' byte su disco sugli shard, e
// resta sporco finche' qualcuno non lo ri-renderizza. #66 tiene la causa a
// monte (il generatore che scrive questi byte); finche' non e' chiusa, nuovi
// articoli possono continuare a nascere sporchi. Questo script e' quindi
// PERMANENTE, non un one-shot: ri-eseguibile ogni volta che serve un altro
// giro di ripubblicazione, e produce zero risultati una volta che #66 e'
// risolta e il backlog e' drenato.
//
// COSA CERCA. Tre superfici dentro content/**, tutte lette come dati (non
// codice): i corpi articolo (`blog-body{,-ch}/<locale>/<id>.ts`, id dal nome
// file), i chunk meta (`blog-meta-<locale>.ts`, id dalla chiave
// `blog.article.<id>.<campo>`) e i chunk SEO (`seo/seo-blog*.ts`, id dalla
// chiave di record `'blog-<id>':` / `'swiss-<id>':` che precede i campi).
// La definizione di "control character illegale" e' importata da
// sanitize-control-chars.mjs — UNA sola sorgente con l'emitter che li rimuove
// in uscita (AGENTS.md #6).
//
// Verificato sul corpus reale (2026-08-09): 32 file, 592 occorrenze — gli
// stessi numeri del censimento in issue #66 — per 29 id distinti.
//
// CLI:
//   node scripts/find-dirty-content-ids.mjs --out <reportJsonPath> [--cap N]
// Exit: 0 sempre (report vuoto = niente da fare, non e' un errore).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findControlChars } from './lib/sanitize-control-chars.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Directory dei corpi articolo -> sezione (id = nome file, locale = sottocartella). */
export const BODY_DIR_SECTIONS = {
  'blog-body': 'frontaliere',
  'blog-body-ch': 'svizzera',
};

export function sectionForBodyDir(dirName) {
  return BODY_DIR_SECTIONS[dirName] ?? null;
}

// Chiave di un campo dentro un chunk meta o body: 'blog.article.<id>.<campo>': '...'
const META_KEY_RX = /'blog\.article\.([a-z0-9-]+)\.[a-zA-Z0-9]+'\s*:/;

/** Id nella chiave di una riga di chunk meta, o null se la riga non ne porta una. */
export function extractMetaArticleId(line) {
  const m = META_KEY_RX.exec(line);
  return m ? m[1] : null;
}

// Chiave di record di un chunk SEO: 'blog-<id>': { ... oppure 'swiss-<id>': { ...
const SEO_BLOCK_KEY_RX = /^\s*'(blog|swiss)-([a-z0-9-]+)':\s*\{/;

/** { section, id } dalla chiave di record che apre un blocco SEO, o null. */
export function extractSeoBlockKey(line) {
  const m = SEO_BLOCK_KEY_RX.exec(line);
  if (!m) return null;
  return { section: m[1] === 'blog' ? 'frontaliere' : 'svizzera', id: m[2] };
}

/**
 * Id sporchi in un chunk meta (content/blog-meta-<locale>.ts): ogni riga la
 * cui chiave nomina un articolo E porta un byte C0 illegale. I chunk meta
 * esistono solo per la sezione frontaliere.
 */
export function dirtyIdsInMetaText(text) {
  const ids = new Set();
  for (const line of text.split('\n')) {
    if (findControlChars(line).length === 0) continue;
    const id = extractMetaArticleId(line);
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * Coppie (sezione, id) sporche in un chunk SEO: la chiave di record che apre
 * un blocco precede i suoi campi, quindi lo stato va tenuto riga per riga.
 * Una riga sporca PRIMA di qualunque chiave di record (should not happen nel
 * formato reale) e' ignorata piuttosto che attribuita al blocco sbagliato.
 */
export function dirtyIdsInSeoText(text) {
  const found = [];
  let current = null;
  for (const line of text.split('\n')) {
    const key = extractSeoBlockKey(line);
    if (key) {
      current = key;
      continue;
    }
    if (current && findControlChars(line).length > 0) found.push(current);
  }
  return found;
}

/** Elenca ricorsivamente i file .ts sotto dir (assente = nessun file, non un errore). */
function listTsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(p));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Aggiunge (o marca) `${section}:${id}` nella mappa dei risultati. */
function mark(map, section, id, source) {
  const key = `${section}:${id}`;
  const entry = map.get(key) || { section, id, sources: [] };
  entry.sources.push(source);
  map.set(key, entry);
}

/**
 * Scansiona l'intero content/ per id sporchi. Pura rispetto all'I/O tranne la
 * lettura file stessa: nessuna rete, nessun git.
 */
export function scanContentForDirtyIds(rootDir) {
  const found = new Map();
  let totalFiles = 0;
  let totalOccurrences = 0;

  for (const bodyDir of Object.keys(BODY_DIR_SECTIONS)) {
    const section = sectionForBodyDir(bodyDir);
    for (const file of listTsFiles(path.join(rootDir, 'content', bodyDir))) {
      const text = fs.readFileSync(file, 'utf8');
      const n = findControlChars(text).length;
      if (n === 0) continue;
      totalFiles += 1;
      totalOccurrences += n;
      const id = path.basename(file, '.ts');
      mark(found, section, id, path.relative(rootDir, file));
    }
  }

  const contentDir = path.join(rootDir, 'content');
  const metaFiles = fs.existsSync(contentDir)
    ? fs.readdirSync(contentDir).filter((n) => /^blog-meta-[a-z]+\.ts$/.test(n))
    : [];
  for (const name of metaFiles) {
    const file = path.join(contentDir, name);
    const text = fs.readFileSync(file, 'utf8');
    const n = findControlChars(text).length;
    if (n === 0) continue;
    totalFiles += 1;
    totalOccurrences += n;
    for (const id of dirtyIdsInMetaText(text)) mark(found, 'frontaliere', id, path.relative(rootDir, file));
  }

  const seoDir = path.join(contentDir, 'seo');
  for (const file of listTsFiles(seoDir)) {
    const text = fs.readFileSync(file, 'utf8');
    const n = findControlChars(text).length;
    if (n === 0) continue;
    totalFiles += 1;
    totalOccurrences += n;
    for (const { section, id } of dirtyIdsInSeoText(text)) mark(found, section, id, path.relative(rootDir, file));
  }

  const ids = [...found.values()].sort((a, b) => (a.section === b.section ? a.id.localeCompare(b.id) : a.section.localeCompare(b.section)));
  return { ids, totalFiles, totalOccurrences };
}

/** Ordine deterministico (sezione, poi id) + cap. Nessuna priorita' di data: sono un backlog storico, non un evento fresco. */
export function orderAndCap(ids, cap) {
  const n = Number(cap);
  const effectiveCap = Number.isInteger(n) && n >= 0 ? n : 10;
  const sorted = [...ids].sort((a, b) => (a.section === b.section ? a.id.localeCompare(b.id) : a.section.localeCompare(b.section)));
  return { selected: sorted.slice(0, effectiveCap), leftover: sorted.slice(effectiveCap) };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out.out = argv[++i];
    else if (argv[i] === '--cap') out.cap = argv[++i];
  }
  if (!out.out) {
    console.error('Uso: node scripts/find-dirty-content-ids.mjs --out <reportJsonPath> [--cap N]');
    process.exit(1);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cap = args.cap ?? 10;

  const { ids, totalFiles, totalOccurrences } = scanContentForDirtyIds(ROOT_DIR);
  const { selected, leftover } = orderAndCap(ids, cap);

  const report = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    totalFiles,
    totalOccurrences,
    counts: { distinct: ids.length, selected: selected.length, leftover: leftover.length },
    selected,
    leftover,
  };
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);

  console.log(
    `[find-dirty-content-ids] ${totalFiles} file, ${totalOccurrences} byte C0, ${ids.length} articoli sporchi (selezionati ${selected.length}, in coda ${leftover.length}, cap ${cap})`,
  );
  for (const { section, id, sources } of selected) console.log(`  → ${section}/${id} (${sources.length} sorgente/i: ${sources.join(', ')})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
