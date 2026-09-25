#!/usr/bin/env node
/**
 * transport-realign-body.mjs — il formato delle righe `(site sha256 ...)` che
 * il trasporto dei gemelli `identical` scrive nel body della PR, e il parser
 * che il realign post-merge usa per rileggerle.
 *
 * Produttore (`transport-identical-twins.yml`) e consumatore
 * (`transport-identical-twins-realign.yml`) importano entrambi da qui: il
 * formato ha UNA sorgente (AGENTS.md #6). Prima vivevano in due `node -e`
 * separati, e il consumatore leggeva il path con `([^`\n]+)`: un path Git con
 * un backtick veniva scritto dal produttore come code span rotto, spariva dal
 * match e il realign falliva con un falso «il body non cita tutti i file»
 * (follow-up sito valerielinc-ops/frontaliere-si-o-no#9443, FU-2026-09-21-010).
 *
 * I path viaggiano come code span CommonMark: il delimitatore e' una stringa
 * di backtick piu' lunga di qualunque run interna, con uno spazio di padding
 * quando il testo inizia o finisce con un backtick (o con uno spazio su
 * entrambi i lati). Il parser accetta qualunque lunghezza di delimitatore,
 * quindi i body storici col singolo backtick restano validi.
 *
 * Duplicati (FU-2026-09-21-011): lo stesso path citato piu' volte con la STESSA
 * site hash (anche 16 vs 64 hex, o maiuscole/minuscole) e' una sola
 * attestazione; lo stesso path con hash diverse e' un errore prima che il TSV
 * venga scritto — il realign non sceglie fra due provenienze.
 *
 * Uso nel workflow:
 *   node scripts/ci/transport-realign-body.mjs <body.md> <files.txt> <out.tsv>
 * Legge `scripts/ci/loop-sync-manifest.json` dalla directory corrente.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFEST_PATH = 'scripts/ci/loop-sync-manifest.json';

/**
 * Riga del body per un path che deve attivare il realign post-merge: il
 * gruppo 1 e' il delimitatore del code span, il 2 il suo contenuto grezzo, il
 * 3 la site hash (16 o 64 hex, maiuscole ammesse per i body storici).
 */
export const TRANSPORT_BULLET_RE = /^- (`+)(?!`)([^\n]*?[^`\n])\1(?!`) .*?\((?:site )?sha256 `([0-9a-fA-F]{16}|[0-9a-fA-F]{64})`\)[^\S\n]*$/gm;

/** Code span CommonMark che rilegge esattamente `text`. */
export function markdownCodeSpan(text) {
  const value = String(text);
  if (!value || /\n/.test(value)) {
    throw new Error('code span non rappresentabile: ' + JSON.stringify(value));
  }
  const longestRun = (value.match(/`+/g) || []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(longestRun + 1);
  const needsPadding = value.startsWith('`') || value.endsWith('`')
    || (value.startsWith(' ') && value.endsWith(' ') && value.trim() !== '');
  const pad = needsPadding ? ' ' : '';
  return fence + pad + value + pad + fence;
}

/** Contenuto di un code span CommonMark (regola dello spazio di padding). */
export function decodeCodeSpanContent(raw) {
  if (raw.length >= 2 && raw.startsWith(' ') && raw.endsWith(' ') && raw.trim() !== '') {
    return raw.slice(1, -1);
  }
  return raw;
}

/** Riga del body scritta dal trasporto per un gemello portato. */
export function transportBulletLine({ path: filePath, sitePath, to }) {
  return '- ' + markdownCodeSpan(filePath) + ' ← ' + markdownCodeSpan(sitePath)
    + ' del sito (site sha256 `' + to + '`)';
}

export function normalizeSiteHash(value) {
  const normalized = String(value).toLowerCase();
  return normalized.length === 64 ? normalized.slice(0, 16) : normalized;
}

/** Ogni riga `(site sha256 ...)` del body, in ordine: `{ path, siteHash }`. */
export function parseTransportBullets(body) {
  const bullets = [];
  for (const match of String(body || '').matchAll(TRANSPORT_BULLET_RE)) {
    bullets.push({ path: decodeCodeSpanContent(match[2]), siteHash: normalizeSiteHash(match[3]) });
  }
  return bullets;
}

/**
 * Lista dei path da riallineare dopo il merge. Lancia se la PR tocca file non
 * dichiarati, se il body cita un path assente dai file della PR, se cita lo
 * stesso path con hash diverse o se manca un file `identical` modificato.
 */
export function planTransportRealign({ body, changedFiles, manifest, manifestPath = MANIFEST_PATH }) {
  const changed = new Set(changedFiles.filter(Boolean));
  const files = (manifest && manifest.files) || [];
  const declared = new Set(files.map((entry) => entry.path));
  const identical = new Set(files.filter((entry) => entry.mode === 'identical').map((entry) => entry.path));
  const unknown = [...changed]
    .filter((filename) => filename !== manifestPath && !declared.has(filename))
    .sort();
  if (unknown.length) {
    throw new Error('file modificati dalla PR non dichiarati nel manifest: ' + unknown.join(', '));
  }
  const expected = [...changed]
    .filter((filename) => filename !== manifestPath && identical.has(filename))
    .sort();
  const excluded = [...changed]
    .filter((filename) => filename !== manifestPath && declared.has(filename) && !identical.has(filename))
    .sort();
  const found = new Map();
  for (const bullet of parseTransportBullets(body)) {
    if (!changed.has(bullet.path)) {
      throw new Error('il body cita un path non presente nei file della PR: ' + bullet.path);
    }
    if (!identical.has(bullet.path)) continue;
    if (found.has(bullet.path) && found.get(bullet.path) !== bullet.siteHash) {
      throw new Error('il body cita lo stesso path con site hash diverse: ' + bullet.path);
    }
    found.set(bullet.path, bullet.siteHash);
  }
  const missing = expected.filter((filename) => !found.has(filename));
  if (missing.length) {
    throw new Error('il body non cita tutti i file trasportati e modificati dalla PR: ' + missing.join(', '));
  }
  const rows = [...found].map(([filename, siteHash]) => filename + '\t' + siteHash).sort();
  return { rows, expected, excluded };
}

function main(argv) {
  const [bodyFile, filesFile, outFile] = argv;
  if (!bodyFile || !filesFile || !outFile) {
    throw new Error('uso: transport-realign-body.mjs <body.md> <files.txt> <out.tsv>');
  }
  const plan = planTransportRealign({
    body: fs.readFileSync(bodyFile, 'utf8'),
    changedFiles: fs.readFileSync(filesFile, 'utf8').split(/\r?\n/),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')),
  });
  if (plan.excluded.length) {
    console.log('Path non-identical esclusi dal realign post-merge: ' + plan.excluded.join(', '));
  }
  fs.writeFileSync(outFile, plan.rows.length ? plan.rows.join('\n') + '\n' : '');
  console.log('Path realign post-merge: ' + plan.rows.length + ' citati su ' + plan.expected.length
    + ' attesi; ' + plan.excluded.length + ' non-identical esclusi');
}

const isDirectRun = (() => {
  try {
    return path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isDirectRun) main(process.argv.slice(2));
