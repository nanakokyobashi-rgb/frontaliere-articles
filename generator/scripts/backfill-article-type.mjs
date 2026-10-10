#!/usr/bin/env node
/**
 * Backfill dimostrabile di `articleType` sui due registry del corpus.
 *
 * Senza opzioni esegue un dry-run. `--apply` inserisce solo la riga
 * `articleType` sulle voci legacy senza tipo: per la sezione frontaliere usa
 * prima il ledger di lettura editoriale, mentre per le voci fuori da quel
 * ledger conserva il backfill dimostrabile dalla citazione finale unica
 * scritta dal generatore, col tipo che il writer assegna a quella run
 * (`registryArticleTypeForRun`). Una decisione `unclassified` e ogni voce
 * ambigua restano senza tipo. Il ledger non autorizza mai la scrittura di
 * `verifiedAt` o di altri campi. Il manifesto laterale pinna cardinalita' e
 * digest del set approvato, cosi' una riga persa non ricade silenziosamente
 * nel fallback. I due registry sono preparati entrambi prima delle
 * sostituzioni; errori sincroni di rename attivano il rollback, ma non si
 * promette atomicita' contro crash tra i rename.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyRegistryArticleTypes,
  readRegistryEntries,
  registryArticleTypeForRun,
} from './lib/registry-article-type.mjs';
import { readTsStringLiteral, readTsStringMap } from './lib/ts-string-map.mjs';

// Riesportati per i test: il lettore e' quello condiviso col backfill dei cantoni.
export { readTsStringLiteral, readTsStringMap };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const ARTICLE_TYPE_READINGS_PATH = 'data/article-type-readings.json';
export const ARTICLE_TYPE_READINGS_MANIFEST_PATH = 'data/article-type-readings.manifest.json';

const LEDGER_DECISIONS = new Set(['news', 'evergreen', 'unclassified']);
const LEDGER_KEYS = ['basis', 'decision', 'id', 'readAt', 'reason'];
const LEDGER_SCHEMA_VERSION = 1;

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key])]),
    );
  }
  return value;
}

/** Digest semantico del ledger: ignora spazi e ordine delle chiavi, non le righe. */
export function articleTypeReadingsDigest(rows) {
  return createHash('sha256').update(JSON.stringify(canonicalJsonValue(rows))).digest('hex');
}

/** Rifiuta un ledger troncato o alterato prima che una riga mancante ricada nel fallback. */
export function assertCompleteArticleTypeLedger(ledger) {
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
    throw new Error('ledger article type: la radice deve contenere il manifesto di copertura');
  }
  const expectedKeys = ['expectedRows', 'rows', 'rowsSha256', 'schemaVersion'].sort().join('|');
  if (Object.keys(ledger).sort().join('|') !== expectedKeys) {
    throw new Error('ledger article type: manifesto di copertura con forma inattesa');
  }
  if (ledger.schemaVersion !== LEDGER_SCHEMA_VERSION) {
    throw new Error(`ledger article type: schema non supportato ${JSON.stringify(ledger.schemaVersion)}`);
  }
  if (!Number.isInteger(ledger.expectedRows) || ledger.expectedRows < 0) {
    throw new Error('ledger article type: expectedRows non valido');
  }
  if (!Array.isArray(ledger.rows)) throw new Error('ledger article type: rows deve essere un array');
  if (ledger.rows.length !== ledger.expectedRows) {
    throw new Error(
      `ledger article type: copertura incompleta (attese ${ledger.expectedRows} righe, trovate ${ledger.rows.length})`,
    );
  }
  if (!/^[a-f0-9]{64}$/u.test(ledger.rowsSha256 || '')) {
    throw new Error('ledger article type: rowsSha256 non valido');
  }
  const actualDigest = articleTypeReadingsDigest(ledger.rows);
  if (actualDigest !== ledger.rowsSha256) {
    throw new Error('ledger article type: digest di copertura non corrispondente');
  }
  return ledger.rows;
}

function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value || ''))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** `readAt` deve essere una data valida non successiva al giorno del backfill. */
export function isReadAtNotFuture(readAt, todayYmd) {
  return isCalendarDate(readAt) && isCalendarDate(todayYmd) && readAt <= todayYmd;
}

export const SECTIONS = Object.freeze({
  frontaliere: {
    registry: 'content/blog-articles-data.ts',
    bodyDir: 'content/blog-body/it',
  },
  svizzera: {
    registry: 'content/swiss-articles-data.ts',
    bodyDir: 'content/blog-body-ch/it',
  },
});

const CITATION_RE = /\*Fonte:\s*\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)\*/gu;
const TAIL_CITATION_RE = /\n\n\*Fonte:\s*\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)\*$/u;

function normalizedHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./u, '');
  } catch {
    return null;
  }
}

/**
 * Regola dimostrabile: la citazione finale unica con il dominio come etichetta
 * e' scritta da un solo punto, lo Step 3e di `create-article.mjs`, e solo
 * quando l'URL della run NON e' `evergreen://`. Chi la porta e' quindi nato da
 * una run non evergreen, e il suo tipo e' quello che il writer assegna oggi a
 * quella run: `registryArticleTypeForRun`, la stessa definizione, non una
 * seconda regola scritta qui.
 *
 * Vale anche per le due citazioni statistiche. Lo Step 3e sostituisce le
 * chiavi sintetiche `stats-bfs://` e `stats-astra://` con la pagina pubblica
 * di BFS e ASTRA, ma il tipo lo decide l'URL della run: non e' `evergreen://`
 * e non riceve mai un'etichetta `evergreen_*` (assegnata soltanto insieme a un
 * URL `evergreen://`), quindi il writer registra quei rapporti di periodo come
 * `news`. Escluderli qui lasciava lo stock statistico senza tipo mentre gli
 * articoli nuovi dello stesso percorso lo ricevono (review della PR 2312).
 * Le due premesse sul generatore sono blindate da
 * `generator/tests/backfill-article-type.test.mjs`.
 */
export function articleTypeFromItalianBody(body3) {
  const body = String(body3 || '').trimEnd();
  const tail = body.match(TAIL_CITATION_RE);
  if (!tail) return undefined;
  const citations = [...body.matchAll(CITATION_RE)];
  if (citations.length !== 1) return undefined;
  const [, label, url] = tail;
  const domain = normalizedHostname(url);
  if (!domain || label !== domain) return undefined;
  // L'etichetta di telemetria della run non e' nel corpus; `undefined` e' il
  // valore delle run manuali, e nessuna etichetta `evergreen_*` convive con
  // un URL che produce la citazione.
  return registryArticleTypeForRun(undefined, url);
}

function body3For(root, bodyDir, id) {
  const file = path.join(root, bodyDir, `${id}.ts`);
  if (!existsSync(file)) return { body3: '', hasBody: false };
  const fields = readTsStringMap(readFileSync(file, 'utf8'));
  return { body3: fields.get(`blog.article.${id}.body3`) || '', hasBody: true };
}

/**
 * Legge e valida il ledger delle letture articolo per articolo.
 *
 * Il ledger e' intenzionalmente indipendente da
 * `data/evergreen-verifications.json`: una decisione editoriale di tipo non
 * e' una verifica di freschezza. Fail-closed su manifesto, copertura, date
 * future, forma, duplicati e ID che non esistono nel registry frontaliere.
 */
export function readArticleTypeReadings(root = ROOT, { todayYmd = new Date().toISOString().slice(0, 10) } = {}) {
  const file = path.join(root, ARTICLE_TYPE_READINGS_PATH);
  const manifestFile = path.join(root, ARTICLE_TYPE_READINGS_MANIFEST_PATH);
  let rows;
  let manifest;
  try {
    rows = JSON.parse(readFileSync(file, 'utf8'));
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  } catch (error) {
    throw new Error(`ledger article type o manifesto illeggibile (${file}; ${manifestFile}): ${error.message}`);
  }
  const manifestKeys = ['expectedRows', 'rowsSha256', 'schemaVersion'].sort().join('|');
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || Object.keys(manifest).sort().join('|') !== manifestKeys) {
    throw new Error('ledger article type: manifesto di copertura con forma inattesa');
  }
  const completeRows = assertCompleteArticleTypeLedger({ ...manifest, rows });
  if (!isCalendarDate(todayYmd)) {
    throw new Error(`ledger article type: todayYmd non valida: ${JSON.stringify(todayYmd)}`);
  }

  const registryFile = path.join(root, SECTIONS.frontaliere.registry);
  const registryIds = new Set(readRegistryEntries(readFileSync(registryFile, 'utf8')).map((entry) => entry.id));
  const seen = new Set();
  const expectedKeys = [...LEDGER_KEYS].sort().join('|');

  for (const [index, row] of completeRows.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`ledger article type: voce ${index + 1} non e' un oggetto`);
    }
    const actualKeys = Object.keys(row).sort().join('|');
    if (actualKeys !== expectedKeys) {
      throw new Error(
        `ledger article type: voce ${index + 1} con forma inattesa `
          + `(atteso ${expectedKeys}, trovato ${actualKeys})`,
      );
    }
    if (typeof row.id !== 'string' || row.id.trim() === '') {
      throw new Error(`ledger article type: voce ${index + 1} con id non valido`);
    }
    if (seen.has(row.id)) throw new Error(`ledger article type: id duplicato ${row.id}`);
    seen.add(row.id);
    if (!registryIds.has(row.id)) {
      throw new Error(`ledger article type: id assente dal registry frontaliere ${row.id}`);
    }
    if (!LEDGER_DECISIONS.has(row.decision)) {
      throw new Error(`ledger article type: decisione non valida per ${row.id}: ${JSON.stringify(row.decision)}`);
    }
    if (typeof row.reason !== 'string' || row.reason.trim() === '') {
      throw new Error(`ledger article type: motivo mancante per ${row.id}`);
    }
    if (!isCalendarDate(row.readAt)) {
      throw new Error(`ledger article type: readAt non valida per ${row.id}: ${row.readAt}`);
    }
    if (!isReadAtNotFuture(row.readAt, todayYmd)) {
      throw new Error(`ledger article type: readAt nel futuro per ${row.id}: ${row.readAt} (oggi ${todayYmd})`);
    }
    if (row.basis !== 'reading') {
      throw new Error(`ledger article type: basis non valida per ${row.id}: ${JSON.stringify(row.basis)}`);
    }
  }
  return completeRows;
}

/** Costruisce il piano senza scrivere file. */
export function planBackfill(root = ROOT) {
  const readingsById = new Map(readArticleTypeReadings(root).map((row) => [row.id, row]));
  const result = {};
  for (const [section, spec] of Object.entries(SECTIONS)) {
    const registryFile = path.join(root, spec.registry);
    const source = readFileSync(registryFile, 'utf8');
    const entries = readRegistryEntries(source);
    const typesById = new Map();
    let withoutType = 0;
    let missingBody = 0;
    for (const entry of entries) {
      if (entry.articleType !== undefined) continue;
      const { body3, hasBody } = body3For(root, spec.bodyDir, entry.id);
      const reading = section === 'frontaliere' ? readingsById.get(entry.id) : undefined;
      if (reading) {
        if (reading.decision === 'news' || reading.decision === 'evergreen') {
          typesById.set(entry.id, reading.decision);
        } else {
          withoutType += 1;
          if (!hasBody) missingBody += 1;
        }
        continue;
      }
      const type = articleTypeFromItalianBody(body3);
      if (type) typesById.set(entry.id, type);
      else {
        withoutType += 1;
        if (!hasBody) missingBody += 1;
      }
    }
    result[section] = {
      spec,
      registryFile,
      source,
      total: entries.length,
      alreadyTyped: entries.filter((entry) => entry.articleType !== undefined).length,
      typesById,
      news: [...typesById.values()].filter((type) => type === 'news').length,
      evergreen: [...typesById.values()].filter((type) => type === 'evergreen').length,
      withoutType,
      missingBody,
    };
  }
  return result;
}

let writeTmpSeq = 0;
function writeAtomic(file, source) {
  const tmp = `${file}.${process.pid}.${writeTmpSeq++}.tmp`;
  try {
    writeFileSync(tmp, source, 'utf8');
    renameSync(tmp, file);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw error;
  }
}

/**
 * Prepara entrambi i registry prima di sostituirne uno. Se un rename fallisce,
 * ripristina i file gia' sostituiti e lascia visibile ogni errore di rollback.
 * Il rollback copre errori sincroni del processo, non crash tra i rename.
 */
export function writeRegistryPairAtomically(changes) {
  if (!Array.isArray(changes)) throw new TypeError('writeRegistryPairAtomically: changes deve essere un array');
  for (const change of changes) {
    if (!change || typeof change.file !== 'string' || typeof change.before !== 'string' || typeof change.after !== 'string') {
      throw new TypeError('writeRegistryPairAtomically: ogni modifica richiede file, before e after testuali');
    }
  }
  const pending = changes.filter((change) => change.before !== change.after);
  const seenFiles = new Set();
  for (const change of pending) {
    const resolved = path.resolve(change.file);
    if (seenFiles.has(resolved)) throw new Error(`writeRegistryPairAtomically: file duplicato ${change.file}`);
    seenFiles.add(resolved);
  }
  if (pending.length === 0) return;

  const staged = [];
  try {
    for (const change of pending) {
      const item = {
        ...change,
        tmp: `${change.file}.${process.pid}.${writeTmpSeq++}.pair.tmp`,
      };
      staged.push(item);
      writeFileSync(item.tmp, item.after, 'utf8');
    }
  } catch (error) {
    for (const item of staged) {
      if (!item.tmp) continue;
      try { unlinkSync(item.tmp); } catch { /* best effort; preserve the write error */ }
    }
    throw error;
  }

  const committed = [];
  try {
    for (const item of staged) {
      renameSync(item.tmp, item.file);
      item.tmp = null;
      committed.push(item);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const item of committed.reverse()) {
      try {
        writeAtomic(item.file, item.before);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    for (const item of staged) {
      if (!item.tmp) continue;
      try { unlinkSync(item.tmp); } catch { /* preserve the commit/rollback errors */ }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        `writeRegistryPairAtomically: commit fallito e rollback incompleto (${rollbackErrors.length} errori)`,
      );
    }
    throw error;
  }
}

function parseArgs(argv) {
  let apply = false;
  for (const arg of argv) {
    if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') apply = false;
    else throw new Error(`argomento sconosciuto: ${arg}`);
  }
  return { apply };
}

function printSummary(plan, apply) {
  for (const [section, row] of Object.entries(plan)) {
    const remaining = row.withoutType;
    console.log(
      `${section}: totale=${row.total} già_tipate=${row.alreadyTyped} `
      + `news=${row.news} evergreen=${row.evergreen} `
      + `restano_senza_tipo=${remaining} corpi_mancanti=${row.missingBody}`,
    );
  }
  console.log(apply ? 'modalità: apply' : 'modalità: dry-run (nessun file modificato)');
}

export function applyPlan(plan) {
  const changed = {};
  const writes = [];
  for (const [section, row] of Object.entries(plan)) {
    const result = applyRegistryArticleTypes(row.source, row.typesById);
    if (result.changed !== row.typesById.size) {
      throw new Error(`${section}: cambiate ${result.changed} voci su ${row.typesById.size} assegnazioni`);
    }
    if (result.changed > 0) writes.push({ file: row.registryFile, before: row.source, after: result.source });
    changed[section] = result.changed;
  }
  writeRegistryPairAtomically(writes);
  return changed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const plan = planBackfill(ROOT);
  printSummary(plan, args.apply);
  if (args.apply) console.log(`voci scritte: ${JSON.stringify(applyPlan(plan))}`);
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
    main();
  } catch (error) {
    console.error(error?.stack || error);
    process.exit(1);
  }
}
