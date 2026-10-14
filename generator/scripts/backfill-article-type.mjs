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
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyRegistryArticleTypes,
  readRegistryEntries,
  registryArticleTypeForRun,
} from './lib/registry-article-type.mjs';
import { parseSourceCitations } from './lib/canton-news-sources.mjs';
import {
  itemIdentityOf,
  legacyNewsUrlKey,
  newsUrlKey,
  readLedgerEntry,
  stripItemIdentity,
} from './lib/source-url-ledger.mjs';
import { writeFilePairAtomically } from '../../scripts/lib/write-file-pair-atomically.mjs';
import { readTsStringLiteral, readTsStringMap } from './lib/ts-string-map.mjs';

// Riesportati per i test: il lettore e' quello condiviso col backfill dei cantoni.
export { readTsStringLiteral, readTsStringMap };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const ARTICLE_TYPE_READINGS_PATH = 'data/article-type-readings.json';
export const ARTICLE_TYPE_READINGS_MANIFEST_PATH = 'data/article-type-readings.manifest.json';
const SOURCE_URLS_PATH = Object.freeze({
  frontaliere: 'data/article-source-urls.json',
  svizzera: 'data/swiss-article-source-urls.json',
});
const SYNTHETIC_CITATION_KEYS = Object.freeze({
  'stats-bfs://': newsUrlKey('https://www.bfs.admin.ch/bfs/it/home/statistiche/industria-servizi.html'),
  'stats-astra://': newsUrlKey('https://www.astra.admin.ch/astra/it/home/documentazione/dati-aperti/veicoli.html'),
});

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
    sourceUrls: SOURCE_URLS_PATH.frontaliere,
  },
  svizzera: {
    registry: 'content/swiss-articles-data.ts',
    bodyDir: 'content/blog-body-ch/it',
    sourceUrls: SOURCE_URLS_PATH.svizzera,
  },
});

function normalizedHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./u, '');
  } catch {
    return null;
  }
}

/**
 * La forma finale con dominio come etichetta e' emessa dallo Step 3e di
 * `create-article.mjs`, ma il body da solo non prova la provenienza: puo' essere
 * scritto manualmente o dal modello. `isGeneratedSourceCitation` richiede anche la
 * corrispondenza URL→ID nel ledger della sezione, poi usa la classificazione
 * corrente del writer invece di duplicarne le regole.
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
function finalGeneratedCitation(body3) {
  const body = String(body3 || '').trimEnd();
  const citations = parseSourceCitations(body);
  if (citations.length !== 1) return null;
  const [citation] = citations;
  if (citation.end !== body.length || !body.slice(0, citation.start).endsWith('\n\n')) return null;
  const { label, url } = citation;
  const domain = normalizedHostname(url);
  if (!domain || label !== domain) return null;
  try {
    if (!['http:', 'https:'].includes(new URL(url).protocol)) return null;
  } catch {
    return null;
  }
  return citation;
}

/**
 * La forma Markdown non prova chi l'ha scritta. Il ledger URL→articolo collega
 * la citazione canonica all'ID assegnato dopo una generazione riuscita.
 * Accetta sia le stringhe storiche sia le voci correnti con articleId.
 */
export function isGeneratedSourceCitation(body3, articleId, sourceUrls) {
  if (typeof articleId !== 'string' || !articleId || !sourceUrls || typeof sourceUrls !== 'object') return false;
  const citation = finalGeneratedCitation(body3);
  if (!citation) return false;
  const citationKey = newsUrlKey(citation.url);
  if (readLedgerEntry(sourceUrls[citationKey])?.articleId === articleId) return true;

  // Fonte riusate aggiungono l'identita' dell'item solo al ledger; la
  // citazione pubblica usa l'URL senza quel frammento.
  for (const [sourceUrl, entry] of Object.entries(sourceUrls)) {
    const ledgerEntry = readLedgerEntry(entry);
    if (ledgerEntry?.articleId !== articleId) continue;
    const syntheticCitation = Object.entries(SYNTHETIC_CITATION_KEYS)
      .find(([prefix]) => sourceUrl.startsWith(prefix));
    if (syntheticCitation?.[1] === citationKey) return true;
    const sourceWithoutItemIdentity = stripItemIdentity(sourceUrl);
    if (ledgerEntry.keyForm === 1) {
      // Le chiavi storiche hanno perso la query identificante: confrontarle
      // con la forma 2 ricreerebbe una falsa assenza di provenienza. Hanno
      // perso anche l'identita' dell'item, quindi non provano citazioni che la
      // portano esplicitamente.
      if (!itemIdentityOf(citation.url)
        && legacyNewsUrlKey(sourceWithoutItemIdentity) === legacyNewsUrlKey(citation.url)) return true;
    } else if (newsUrlKey(sourceWithoutItemIdentity) === citationKey) {
      return true;
    }
  }
  return false;
}

export function articleTypeFromItalianBody(body3, articleId, sourceUrls) {
  if (!isGeneratedSourceCitation(body3, articleId, sourceUrls)) return undefined;
  const citation = finalGeneratedCitation(body3);
  return registryArticleTypeForRun(undefined, citation.url);
}

function readSourceUrlLedger(root, relativePath) {
  try {
    const ledger = JSON.parse(readFileSync(path.join(root, relativePath), 'utf8'));
    if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) return {};
    return ledger;
  } catch {
    // Missing or malformed provenance fails closed.
    return {};
  }
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
    const sourceUrls = readSourceUrlLedger(root, spec.sourceUrls);
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
      const type = articleTypeFromItalianBody(body3, entry.id, sourceUrls);
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

/** Acceptance token per la scrittura con rollback della coppia di registry. */
export function writeRegistryPairAtomically(changes, options) {
  return writeFilePairAtomically(changes, options);
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

export function applyPlan(plan, { fsImpl } = {}) {
  const changed = {};
  const writes = [];
  for (const [section, row] of Object.entries(plan)) {
    const result = applyRegistryArticleTypes(row.source, row.typesById);
    if (result.changed !== row.typesById.size) {
      throw new Error(`${section}: cambiate ${result.changed} voci su ${row.typesById.size} assegnazioni`);
    }
    writes.push({ file: row.registryFile, before: row.source, after: result.source });
    changed[section] = result.changed;
  }
  writeRegistryPairAtomically(writes, { fsImpl });
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
