#!/usr/bin/env node
/**
 * Backfill dimostrabile di `articleType` sui due registry del corpus.
 *
 * Senza opzioni esegue un dry-run. `--apply` inserisce solo la riga
 * `articleType` sulle voci legacy per cui il corpo italiano porta la citazione
 * finale unica scritta dal generatore, col tipo che il writer assegna a quella
 * run (`registryArticleTypeForRun`). Ogni voce ambigua resta senza tipo.
 */

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

/** Costruisce il piano senza scrivere file. */
export function planBackfill(root = ROOT) {
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

function applyPlan(plan) {
  const changed = {};
  for (const [section, row] of Object.entries(plan)) {
    const result = applyRegistryArticleTypes(row.source, row.typesById);
    if (result.changed !== row.typesById.size) {
      throw new Error(`${section}: cambiate ${result.changed} voci su ${row.typesById.size} assegnazioni`);
    }
    if (result.changed > 0) writeAtomic(row.registryFile, result.source);
    changed[section] = result.changed;
  }
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
