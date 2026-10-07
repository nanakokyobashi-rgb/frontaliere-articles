#!/usr/bin/env node
/**
 * retire-article.mjs — l'inverso di `generator/scripts/create-article.mjs`.
 *
 * Uso:
 *   node scripts/retire-article.mjs <article-id> --winner <other-id> [--dry-run]
 *
 * ## Perché esiste
 *
 * `create-article.mjs` registra un articolo su ~10 superfici diverse. Non
 * esisteva l'operazione inversa: fino a oggi «ritirare» un articolo voleva dire
 * modificarne a mano una dozzina, fra cui due registri da centinaia di migliaia
 * di righe e un file SEO da 25.000. È per questo che i 5 duplicati
 * cross-sezione di #251/#304 sono rimasti online mentre il gate che impedisce
 * di generarne altri era già attivo da giorni: la bonifica non era difficile da
 * decidere, era difficile da ESEGUIRE.
 *
 * ## Perché una rimozione PARZIALE è peggio di nessuna rimozione
 *
 * Le superfici non sono indipendenti, e `scripts/build-api.mjs` le incrocia al
 * momento della pubblicazione:
 *
 *   - un id nel registro senza la sua riga in `routerSwissData.ts` →
 *     `news-ticker: article '<id>' has no <loc> slug — refusing to publish`
 *   - un id nel registro senza la sua voce di meta →
 *     stesso `throw`, sul titolo
 *
 * Quel `throw` non degrada l'articolo ritirato: **ferma la pubblicazione
 * dell'intera superficie dati**, per tutti gli articoli. Una rimozione lasciata
 * a metà congela quindi il corpus, e lo fa al primo push di contenuto
 * successivo — cioè in mano a qualcun altro, su un commit che non c'entra.
 * Da qui le due scelte di questo script: fa TUTTE le superfici o nessuna
 * (`--dry-run` per vedere prima), e al termine rilegge i file da disco per
 * verificare che l'id non compaia più da nessuna parte, uscendo 1 se compare.
 *
 * ## Cosa NON fa, di proposito
 *
 * Non tocca il 301. L'URL ritirata continua a essere servita dallo shard
 * (append-only per gli otto prefissi articolo), e l'unico strato che la può
 * ritirare davvero è `EDGE_RETIRED_PATHS` in
 * `infra/cloudflare-worker/locale-router.js`, che vive nel repo del SITO.
 * Perciò questo script **preserva i quattro slug localizzati** in
 * `data/retired-articles.json` prima di cancellarli: dopo la rimozione non
 * sono più derivabili da nessun registro, e sono esattamente ciò che serve per
 * scrivere le voci edge dall'altro lato.
 */

import '../host/cantonSectionsBootstrap.mjs';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ledgerArticleId } from '../generator/scripts/lib/source-url-ledger.mjs';
import { writeFileAtomic } from '../generator/scripts/lib/atomic-write-file.mjs';
import { writeJsonAtomic } from '../generator/scripts/lib/atomic-write-json.mjs';
import {
  SECTIONS, LOCALES, IMAGES_LEDGER, IMAGE_CATALOG, RETIRED_LEDGER,
  seoFilesFor, leftoverSurfacesFor, requiredWritableSurfaceFilesFor,
  surfaceArticleIdStatus, SURFACE_ARTICLE_ID_STATUS,
  assertRegularFileIfPresent,
  requireRegularFile, requireWritableDirectory, requireWritableRegularFile,
} from './lib/article-surfaces.mjs';
// La localizzazione dei letterali TS (span dell'array piatto degli id, e la
// parentesi che chiude davvero quella di apertura) vive in un modulo condiviso:
// la usa anche `generator/scripts/create-article.mjs`, che lo STESSO array lo
// rigenera (vedi il file per il perché delle due euristiche cadute).
import { matchingDelimiter, removeFromIdListLiteral } from './lib/ts-literals.mjs';
import { removeSeoEntriesFromSource } from './lib/seo-entry.mjs';
import { IMAGE_CREDIT_RECORDS_DIR } from './lib/image-credit-records.mjs';
import { isNewFamilySection } from './lib/corpus-floors.mjs';
import { coverKey } from '../engine/shared/imageCredits.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RETIREMENT_JOURNAL = 'data/retirement-journal.json';

const rel = (p) => path.join(ROOT, p);
const read = (p) => readFileSync(rel(p), 'utf-8');
const write = (p, s) => writeFileAtomic(rel(p), s);

/** Accoda solo un target che il retirement può riscrivere davvero. */
function queueWriteTarget(writes, file, text, what) {
  requireWritableRegularFile(ROOT, file, `target da scrivere (${what})`);
  writes.push([file, text]);
}

/** Riesegue il controllo sui target di write subito prima del primo write. */
function validateWriteTargets(writes) {
  for (const [file] of writes) {
    requireWritableRegularFile(ROOT, file, 'target da scrivere');
  }
}

/** Aggiunge un target opzionale solo se è davvero un file cancellabile. */
function queueDeleteTarget(deletes, planned, file, what) {
  if (!assertRegularFileIfPresent(ROOT, file, `target da cancellare (${what})`)) return;
  requireWritableDirectory(ROOT, path.dirname(file), `directory padre del target da cancellare (${what})`);
  deletes.push(file);
  planned.push({ file, what });
}

/** Riesegue il controllo subito prima del primo write, chiudendo il TOCTOU. */
function validateDeleteTargets(deletes) {
  for (const file of deletes) {
    requireRegularFile(ROOT, file, 'target da cancellare');
    requireWritableDirectory(ROOT, path.dirname(file), 'directory padre del target da cancellare');
  }
}

// Descrittori di sezione, costanti e l'elenco delle superfici: sorgente unica,
// condivisa col gate di PR `generator/tests/retired-articles-fully-removed.test.mjs`
// (vedi il modulo per il perché).

/** Rimuove il blocco `{ … id: '<id>', … },` dal registro di sezione. */
function removeRegistryEntry(file, id) {
  const src = read(file);
  const needle = `id: '${id}',`;
  const at = src.indexOf(needle);
  if (at === -1) return { changed: false, src };
  const open = src.lastIndexOf('{', at);
  if (open === -1) throw new Error(`${file}: nessuna '{' prima di ${needle}`);
  const close = matchingDelimiter(src, open);
  if (close === -1) throw new Error(`${file}: graffe sbilanciate attorno a ${id}`);
  // Inghiotti la virgola e la riga vuota che seguono, e il rientro che precede.
  let start = open;
  while (start > 0 && (src[start - 1] === ' ' || src[start - 1] === '\t')) start -= 1;
  let end = close + 1;
  if (src[end] === ',') end += 1;
  if (src[end] === '\n') end += 1;
  return { changed: true, src: src.slice(0, start) + src.slice(end) };
}

/** Rimuove la riga `'<id>': { it: …, en: …, de: …, fr: … },` e restituisce gli slug. */
function removeSlugRow(file, id) {
  const src = read(file);
  const rx = new RegExp(`^[ \\t]*'${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}':\\s*\\{([^}]*)\\}\\s*,?[ \\t]*\\n`, 'm');
  const m = src.match(rx);
  if (!m) return { changed: false, src, slugs: null };
  const slugs = {};
  const slugRx = /\b(it|en|de|fr)\s*:\s*'([^']+)'/g;
  let s;
  while ((s = slugRx.exec(m[1])) !== null) slugs[s[1]] = s[2];
  for (const loc of LOCALES) {
    if (!slugs[loc]) throw new Error(`${file}: la riga di ${id} non ha lo slug ${loc}`);
  }
  return { changed: true, src: src.replace(rx, ''), slugs };
}

/** Rimuove la provenienza dello slug per lo stesso id dalla mappa del router. */
function removeFallbackProvenanceRow(src, file, constName, id) {
  const declarationAt = src.indexOf(`export const ${constName}`);
  if (declarationAt === -1) {
    throw new Error(`${file}: mappa ${constName} non dichiarata`);
  }
  const equalsAt = src.indexOf('=', declarationAt);
  const open = src.indexOf('{', equalsAt);
  if (equalsAt === -1 || open === -1) {
    throw new Error(`${file}: mappa ${constName} senza apertura leggibile`);
  }
  const close = matchingDelimiter(src, open);
  if (close === -1) throw new Error(`${file}: graffe sbilanciate nella mappa ${constName}`);

  const bodyStart = open + 1;
  const body = src.slice(bodyStart, close);
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const entry = new RegExp(`^[ \\t]*'${escaped}'\\s*:\\s*\\{`, 'm').exec(body);
  if (!entry) return { changed: false, src };

  const entryStart = bodyStart + entry.index;
  const entryOpen = bodyStart + entry.index + entry[0].lastIndexOf('{');
  const entryClose = matchingDelimiter(src, entryOpen);
  if (entryClose === -1) throw new Error(`${file}: graffe sbilanciate nella provenienza di ${id}`);
  let end = entryClose + 1;
  if (src[end] === ',') end += 1;
  if (src[end] === '\n') end += 1;
  return { changed: true, src: src.slice(0, entryStart) + src.slice(end) };
}

/**
 * Rimuove `'<id>'` da una union di literal spezzata in alias
 * (`type _BlogIdN = 'a' | 'b' | …;`), come `content/blogArticleIds.ts`.
 * Opera alias per alias, così il membro viene tolto insieme alla `|` che lo
 * lega ai vicini e un alias che resta vuoto è un errore, non un tipo rotto.
 */
function removeFromIdUnion(src, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const member = new RegExp(`'${escaped}'`);
  let changed = false;
  const out = src.replace(/type (_\w+)\s*=\s*([^;]+);/g, (whole, name, body) => {
    if (!member.test(body)) return whole;
    let next = body;
    if (new RegExp(`\\|\\s*'${escaped}'`).test(next)) {
      next = next.replace(new RegExp(`\\s*\\|\\s*'${escaped}'`), '');
    } else {
      next = next.replace(new RegExp(`'${escaped}'\\s*\\|\\s*`), '');
    }
    if (member.test(next)) throw new Error(`union ${name}: '${id}' compare più volte`);
    if (!next.trim()) throw new Error(`union ${name}: rimuovere '${id}' la lascerebbe vuota`);
    changed = true;
    return `type ${name} = ${next};`;
  });
  return { changed, src: out };
}

/** Rimuove ogni riga `'blog.article.<id>.<campo>': …` da un file di meta. */
function removeMetaKeys(file, id) {
  const src = read(file);
  const rx = new RegExp(`^[ \\t]*'blog\\.article\\.${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[^']*':[\\s\\S]*?\\n(?=[ \\t]*'|[ \\t]*\\})`, 'gm');
  const out = src.replace(rx, '');
  return { changed: out !== src, src: out };
}

/** Rimuove tutti i blocchi `'blog-<id>': { … },` da un file SEO. */
function removeSeoEntry(file, id) {
  return removeSeoEntriesFromSource(read(file), id, file);
}

/**
 * Rimuove da una mappa JSON ogni voce il cui VALORE è l'id (ledger URL→id).
 *
 * `ledgerArticleId` e non `v === id`: dal 2026-08-18 `recordSourceUrl` scrive
 * `{articleId, ts}` e le voci storiche restano stringhe nude. Col confronto
 * diretto le voci nuove non avrebbero MAI corrisposto, e un articolo ritirato
 * avrebbe lasciato il suo URL di fonte nel ledger — invisibile qui e ancora
 * bloccante per la sezione.
 */
function removeJsonByValue(file, id) {
  const map = JSON.parse(read(file));
  const hits = Object.entries(map).filter(([, v]) => ledgerArticleId(v) === id).map(([k]) => k);
  for (const k of hits) delete map[k];
  return { changed: hits.length > 0, text: `${JSON.stringify(map, null, 2)}\n`, hits };
}

/** Rimuove da una mappa JSON la voce la cui CHIAVE è l'id. */
function removeJsonByKey(file, id) {
  const map = JSON.parse(read(file));
  if (!Object.prototype.hasOwnProperty.call(map, id)) return { changed: false, text: null };
  delete map[id];
  return { changed: true, text: `${JSON.stringify(map, null, 2)}\n` };
}

/**
 * Rimuove dal catalogo immagini ogni oggetto il cui `path` nomina una delle
 * copertine `keys` (chiavi di `coverKey`, non id di articolo: la copertina di
 * un articolo può portare il nome di un altro).
 */
function removeFromImageCatalog(file, keys) {
  const list = JSON.parse(read(file));
  if (!Array.isArray(list)) throw new Error(`${file}: atteso un array`);
  const names = keys.map((key) => `/${key}.webp`);
  const kept = list.filter((e) => !(e && typeof e.path === 'string' && names.some((n) => e.path.includes(n))));
  if (kept.length === list.length) return { changed: false, text: null };
  return { changed: true, text: `${JSON.stringify(kept)}\n` };
}

/**
 * Ogni blocco `{ id: '…', … }` di un registro di sezione, delimitato con
 * `matchingDelimiter` come in `removeRegistryEntry`: una regex che si ferma
 * alla prima `}` perderebbe il campo `image` dietro un oggetto annidato, e qui
 * un'immagine persa vuol dire una copertina altrui cancellata. Graffe
 * sbilanciate sono un errore, non un registro più corto.
 *
 * Non importa `readRegistry` da `scripts/build-blog-index.mjs`: quel modulo
 * esegue la build all'import.
 */
function registryBlocks(file) {
  const src = read(file);
  const out = [];
  const rx = /\bid:\s*'([^']+)',/g;
  let m;
  while ((m = rx.exec(src)) !== null) {
    const open = src.lastIndexOf('{', m.index);
    if (open === -1) throw new Error(`${file}: nessuna '{' prima di id '${m[1]}'`);
    const close = matchingDelimiter(src, open);
    if (close === -1) throw new Error(`${file}: graffe sbilanciate attorno a ${m[1]}`);
    out.push({ id: m[1], block: src.slice(open, close + 1) });
    rx.lastIndex = close + 1;
  }
  return out;
}

/** Il valore letterale del campo `image` di un blocco di registro, o undefined. */
function registryImage(block) {
  return (block.match(/\bimage:\s*(['"`])([^'"`]*)\1/) ?? [])[2];
}

/**
 * `coverKey(image) → [id…]` per tutti gli articoli pubblicati di ENTRAMBE le
 * sezioni, tranne `excludeId`. Una copertina può essere condivisa anche fra
 * frontaliere e svizzera: guardare solo il registro del ritirato la darebbe
 * per libera.
 */
function coverKeysInUse(excludeId) {
  /** @type {Map<string, string[]>} */
  const inUse = new Map();
  for (const [section, cfg] of Object.entries(SECTIONS)) {
    // Una sezione cantonale attiva puo' essere ancora nuova: D22 la rende
    // visibile al core prima che il primo articolo crei registry e slugs. La
    // coppia assente e' uno stato valido per una famiglia vuota; una coppia
    // parziale, invece, resta fail-closed dentro isNewFamilySection().
    if (isNewFamilySection(ROOT, section)) continue;
    for (const { id, block } of registryBlocks(cfg.registryFile)) {
      if (id === excludeId) continue;
      const key = coverKey(registryImage(block));
      if (!key) continue;
      if (!inUse.has(key)) inUse.set(key, []);
      inUse.get(key).push(id);
    }
  }
  return inUse;
}



/** In quale sezione vive l'id? Deciso dal registro che lo contiene. */
function findSection(id) {
  const found = Object.entries(SECTIONS)
    .filter(([section]) => !isNewFamilySection(ROOT, section))
    .filter(([, cfg]) => read(cfg.registryFile).includes(`id: '${id}',`));
  if (found.length === 0) throw new Error(`'${id}' non è in nessuno dei due registri`);
  if (found.length > 1) throw new Error(`'${id}' è in ${found.length} registri: ambiguo, va risolto a mano`);
  return found[0][0];
}

/**
 * Restituisce una tombstone già scritta dal retirement precedente, se esiste.
 *
 * Il caso non è teorico: il resolver di rebase lavorava su registri append-only
 * e, prima di conoscere le tombstone, poteva riesumare soltanto la riga di
 * `routerBlogData.ts`/`blogArticleIds.ts`. In quel punto il registro principale
 * è già pulito, quindi il comando normale non riesce a trovare l'articolo e
 * non può completare l'operazione. La tombstone conserva però sezione e slug:
 * sono sufficienti per riprendere in modo atomico le superfici residue.
 */
function validateRetirementEntry(entry, label) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${label} deve essere un oggetto completo`);
  }
  for (const field of ['id', 'section', 'winnerId', 'winnerSection', 'retiredOn']) {
    if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
      throw new Error(`${label}.${field} deve essere una stringa non vuota`);
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.retiredOn)) {
    throw new Error(`${label}.retiredOn deve essere YYYY-MM-DD`);
  }
  if (!Array.isArray(entry.duplicateOf) || entry.duplicateOf.some((url) => typeof url !== 'string' || url.trim() === '')) {
    throw new Error(`${label}.duplicateOf deve essere un array di stringhe`);
  }
  if (!entry.slugs || typeof entry.slugs !== 'object' || Array.isArray(entry.slugs)) {
    throw new Error(`${label}.slugs deve essere un oggetto`);
  }
  for (const locale of LOCALES) {
    if (typeof entry.slugs[locale] !== 'string' || entry.slugs[locale].trim() === '') {
      throw new Error(`${label}.slugs.${locale} deve essere una stringa non vuota`);
    }
  }
  if (entry.imageKey !== undefined && (typeof entry.imageKey !== 'string' || entry.imageKey.trim() === '')) {
    throw new Error(`${label}.imageKey deve essere una stringa non vuota`);
  }
  return entry;
}

function retiredLedgerEntries() {
  const ledgerPath = rel(RETIRED_LEDGER);
  if (!assertRegularFileIfPresent(ROOT, RETIRED_LEDGER, 'ledger dei ritirati')) return [];
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8'));
  if (!Array.isArray(ledger.retired)) {
    throw new Error(`${RETIRED_LEDGER}: "retired" deve essere un array`);
  }
  const ids = new Set();
  return ledger.retired.map((entry, index) => {
    const validated = validateRetirementEntry(entry, `${RETIRED_LEDGER}: retired[${index}]`);
    if (ids.has(validated.id)) throw new Error(`${RETIRED_LEDGER}: '${validated.id}' compare più volte`);
    ids.add(validated.id);
    return validated;
  });
}

function retiredEntryFor(id) {
  return retiredLedgerEntries().find((entry) => entry.id === id) ?? null;
}

/** Un journal presente indica una transazione interrotta prima della tombstone. */
function retirementJournalFor(id) {
  const journalPath = rel(RETIREMENT_JOURNAL);
  if (!assertRegularFileIfPresent(ROOT, RETIREMENT_JOURNAL, 'journal del retirement')) return null;
  const journal = validateRetirementEntry(
    JSON.parse(readFileSync(journalPath, 'utf-8')),
    `${RETIREMENT_JOURNAL}: journal`,
  );
  if (journal.id !== id) {
    throw new Error(`${RETIREMENT_JOURNAL}: transazione aperta per '${journal.id}', non per '${id}'`);
  }
  return journal;
}

function main() {
  const argv = process.argv.slice(2);
  const id = argv.find((a) => !a.startsWith('--'));
  const winner = argv[argv.indexOf('--winner') + 1];
  const dryRun = argv.includes('--dry-run');

  if (typeof id !== 'string' || id.trim().length === 0 || !argv.includes('--winner') || !winner || winner.startsWith('--')) {
    console.error('uso: node scripts/retire-article.mjs <article-id> --winner <other-id> [--dry-run]');
    process.exit(2);
  }
  if (id === winner) {
    console.error('il vincitore non può essere l\'articolo ritirato');
    process.exit(2);
  }

  let section;
  let priorRetirement = retirementJournalFor(id);
  try {
    section = findSection(id);
  } catch (error) {
    if (!String(error?.message).includes('non è in nessuno dei due registri')) throw error;
    if (!priorRetirement) priorRetirement = retiredEntryFor(id);
    if (!priorRetirement || !SECTIONS[priorRetirement.section]) throw error;
    section = priorRetirement.section;
    console.warn(`'${id}' non è più nel registro: riprendo il retirement parziale dalla tombstone`);
  }
  const cfg = SECTIONS[section];
  // Missing registry/slug/meta surfaces must stop before any retirement
  // planning can become a partial write. Keep this preflight before the
  // dry-run branch too: --dry-run must validate the same required inputs as a
  // real retirement, not merely avoid persisting an already-invalid plan.
  requiredWritableSurfaceFilesFor(section);
  const winnerSection = findSection(winner); // esiste? altrimenti throw: mai ritirare verso il nulla
  if (priorRetirement?.section && priorRetirement.section !== section) {
    throw new Error(`'${id}' ha una transazione aperta per la sezione '${priorRetirement.section}', non '${section}'`);
  }
  if (priorRetirement?.winnerId && priorRetirement.winnerId !== winner) {
    throw new Error(`'${id}' è già ritirato verso '${priorRetirement.winnerId}', non verso '${winner}'`);
  }
  console.log(`ritiro '${id}' (${section}) → vincitore '${winner}' (${winnerSection})${dryRun ? '  [DRY RUN]' : ''}`);

  /** @type {Array<{file: string, what: string, kept?: boolean}>} */
  const planned = [];
  /** @type {Array<[string, string]>} */
  const writes = [];
  /** @type {string[]} */
  const deletes = [];

  // 1. slug map — PRIMA di tutto: è l'unico posto da cui gli slug localizzati
  //    sono ancora leggibili, e servono al ledger dei ritirati.
  const slugRow = removeSlugRow(cfg.slugDataFile, id);
  let slugDataSrc;
  let slugs;
  if (slugRow.changed) {
    slugDataSrc = slugRow.src;
    slugs = slugRow.slugs;
    planned.push({ file: cfg.slugDataFile, what: `riga slug (${LOCALES.map((l) => slugs[l]).join(', ')})` });
  } else if (priorRetirement?.slugs) {
    slugs = priorRetirement.slugs;
    slugDataSrc = read(cfg.slugDataFile);
    planned.push({ file: cfg.slugDataFile, what: 'mappa slug già priva della tombstone' });
  } else {
    throw new Error(`${cfg.slugDataFile}: nessuna riga per '${id}' — mappa slug già incoerente col registro`);
  }

  // La provenienza vive accanto alla mappa slug e deve uscire nello stesso
  // buffer, altrimenti build-api.mjs la pubblica come residuo fantasma dopo
  // il retirement dell'articolo.
  const fallbackRow = removeFallbackProvenanceRow(
    slugDataSrc,
    cfg.slugDataFile,
    cfg.fallbackReasonsConstName,
    id,
  );
  if (fallbackRow.changed) {
    slugDataSrc = fallbackRow.src;
    planned.push({ file: cfg.slugDataFile, what: 'provenienza fallback slug' });
  }

  // 1b. array letterale piatto degli id (es. `ALL_BLOG_ARTICLE_IDS`), se la
  //     sezione ne ha uno indipendente dalla mappa slug appena ripulita.
  if (cfg.idListVar) {
    let idList;
    try {
      idList = removeFromIdListLiteral(slugDataSrc, cfg.idListVar, id);
    } catch (error) {
      // A prior interrupted retirement may have removed the id from this
      // secondary list while leaving the slug row to finish. That state is
      // already the requested result; tolerate only this named absence and
      // keep surfacing shape/I/O errors.
      if (error?.code !== 'ID_LIST_ENTRY_MISSING') throw error;
      console.warn(`elenco flat ${cfg.idListVar}: '${id}' già assente — continuo con la rimozione`);
      idList = { changed: false, src: slugDataSrc };
    }
    if (idList.changed) {
      slugDataSrc = idList.src;
      planned.push({ file: cfg.slugDataFile, what: `elenco flat ${cfg.idListVar}` });
    }
  }
  queueWriteTarget(writes, cfg.slugDataFile, slugDataSrc, 'mappa slug');

  // 1c. union di literal degli id (`BlogArticleId`), che vive in un file
  //     separato dalla mappa slug e che solo questa sezione mantiene.
  if (cfg.idUnionFile && assertRegularFileIfPresent(
    ROOT,
    cfg.idUnionFile,
    'target da scrivere (union BlogArticleId)',
  )) {
    const union = removeFromIdUnion(read(cfg.idUnionFile), id);
    if (union.changed) {
      queueWriteTarget(writes, cfg.idUnionFile, union.src, 'union BlogArticleId');
      planned.push({ file: cfg.idUnionFile, what: 'membro della union BlogArticleId' });
    }
  }

  // 2. registro di sezione
  const reg = removeRegistryEntry(cfg.registryFile, id);
  if (reg.changed) {
    queueWriteTarget(writes, cfg.registryFile, reg.src, 'registro di sezione');
    planned.push({ file: cfg.registryFile, what: 'blocco di registro' });
  } else if (!priorRetirement) {
    throw new Error(`${cfg.registryFile}: nessun blocco per '${id}'`);
  } else {
    planned.push({ file: cfg.registryFile, what: 'registro già privo della tombstone' });
  }

  // 3. meta per locale
  for (const metaFile of cfg.metaFiles) {
    const r = removeMetaKeys(metaFile, id);
    if (r.changed) {
      queueWriteTarget(writes, metaFile, r.src, 'chiavi i18n');
      planned.push({ file: metaFile, what: 'chiavi i18n' });
    }
  }

  // 4. SEO
  for (const seoFile of seoFilesFor(section)) {
    const r = removeSeoEntry(seoFile, id);
    if (r.changed) {
      queueWriteTarget(writes, seoFile, r.src, 'blocco SEO');
      planned.push({ file: seoFile, what: 'blocco SEO' });
    }
  }

  // 5. corpi per locale
  for (const loc of LOCALES) {
    const bodyFile = `${cfg.bodyDir}/${loc}/${id}.ts`;
    queueDeleteTarget(deletes, planned, bodyFile, 'corpo');
  }

  // 6. sidecar
  const sidecar = `${cfg.sidecarDir}/${id}.json`;
  queueDeleteTarget(deletes, planned, sidecar, 'sidecar');

  // 7. ledger URL→id della sezione
  const sourceLedgerPresent = assertRegularFileIfPresent(
    ROOT,
    cfg.sourceLedger,
    'target da scrivere (ledger URL)',
  );
  const led = sourceLedgerPresent
    ? removeJsonByValue(cfg.sourceLedger, id)
    : { changed: false, hits: [], text: null };
  let retiredSourceUrls = Array.isArray(priorRetirement?.duplicateOf) ? priorRetirement.duplicateOf : [];
  if (led.changed) {
    retiredSourceUrls = led.hits;
    queueWriteTarget(writes, cfg.sourceLedger, led.text, 'ledger URL');
    planned.push({ file: cfg.sourceLedger, what: `${led.hits.length} URL di fonte` });
  }

  // 8. provenienza immagine
  const imageLedgerPresent = assertRegularFileIfPresent(
    ROOT,
    IMAGES_LEDGER,
    'target da scrivere (ledger immagini)',
  );
  const img = imageLedgerPresent
    ? removeJsonByKey(IMAGES_LEDGER, id)
    : { changed: false, text: null };
  if (img.changed) {
    queueWriteTarget(writes, IMAGES_LEDGER, img.text, 'provenienza immagine');
    planned.push({ file: IMAGES_LEDGER, what: 'provenienza immagine' });
  }

  // 9-10. Quali copertine si possono togliere. La copertina dell'articolo è
  //     quella che dichiara il suo campo `image` (`ownKey`), che non porta per
  //     forza il nome dell'id: un articolo può riusare la copertina di un altro
  //     (es. due articoli con `image: '/images/blog/<id-dell-altro>.webp'`).
  //     Restano candidati anche i file col nome dell'id, che prima di questo
  //     controllo erano l'unica cosa cancellata. Una chiave ancora usata da un
  //     altro articolo pubblicato, in QUALUNQUE sezione, si conserva per intero:
  //     copertina, miniatura, credito (P14) e voce di catalogo descrivono il
  //     file, non l'articolo, e servono all'articolo che resta.
  const retiredBlock = registryBlocks(cfg.registryFile).find((b) => b.id === id);
  const ownKey = priorRetirement?.imageKey ?? coverKey(retiredBlock && registryImage(retiredBlock.block)) ?? id;
  const inUse = coverKeysInUse(id);
  /** @type {string[]} */
  const removableCovers = [];
  for (const key of new Set([ownKey, id])) {
    const users = inUse.get(key);
    if (users) {
      planned.push({ file: `public/images/blog/${key}.webp`, what: `copertina ${key} conservata: usata da ${users.join(', ')}`, kept: true });
    } else {
      removableCovers.push(key);
    }
  }

  // 9. catalogo immagini del giornalista
  if (assertRegularFileIfPresent(ROOT, IMAGE_CATALOG, 'target da scrivere (catalogo immagini)')) {
    const cat = removableCovers.length > 0
      ? removeFromImageCatalog(IMAGE_CATALOG, removableCovers)
      : { changed: false, text: null };
    if (cat.changed) {
      queueWriteTarget(writes, IMAGE_CATALOG, cat.text, 'catalogo immagini');
      planned.push({ file: IMAGE_CATALOG, what: 'voce di catalogo' });
    }
  }

  // 10. asset immagine, e con la copertina il suo credito (P14): il record
  //     `content/image-credits/blog/<key>.json` descrive proprio questo file, e
  //     senza il file resterebbe il credito di una copertina che non c'è più.
  for (const key of removableCovers) {
    for (const asset of [`public/images/blog/${key}.webp`, `public/images/blog/thumbnails/${key}-480w.webp`]) {
      queueDeleteTarget(deletes, planned, asset, 'asset');
    }
    queueDeleteTarget(deletes, planned, `${IMAGE_CREDIT_RECORDS_DIR}/${key}.json`, 'credito della copertina');
  }

  // Il ledger dei ritirati è scritto atomicamente più avanti, ma va letto e
  // validato ora: una directory, una symlink o un JSON rotto non devono poter
  // interrompere il retirement dopo le scritture delle superfici principali.
  const retiredLedgerPresent = assertRegularFileIfPresent(
    ROOT,
    RETIRED_LEDGER,
    'target da scrivere (ledger ritirati)',
  );
  const retiredLedgerDirectory = path.dirname(RETIRED_LEDGER);
  const retirementJournalPresent = assertRegularFileIfPresent(
    ROOT,
    RETIREMENT_JOURNAL,
    'target da scrivere (journal del retirement)',
  );
  const retirementJournalDirectory = path.dirname(RETIREMENT_JOURNAL);
  requireWritableDirectory(
    ROOT,
    retiredLedgerDirectory,
    'directory padre del ledger ritirati',
  );
  requireWritableDirectory(
    ROOT,
    retirementJournalDirectory,
    'directory padre del journal del retirement',
  );
  if (retirementJournalPresent) {
    requireWritableRegularFile(ROOT, RETIREMENT_JOURNAL, 'target da scrivere (journal del retirement)');
  }
  const ledgerPath = rel(RETIRED_LEDGER);
  const ledger = retiredLedgerPresent
    ? JSON.parse(readFileSync(ledgerPath, 'utf-8'))
    : { _doc: '', retired: [] };
  ledger.retired = ledger.retired.filter((e) => e.id !== id);
  ledger.retired.push({
    id,
    section,
    winnerId: winner,
    winnerSection,
    retiredOn: priorRetirement?.retiredOn ?? new Date().toISOString().slice(0, 10),
    duplicateOf: retiredSourceUrls,
    slugs,
  });
  ledger.retired.sort((a, b) => a.id.localeCompare(b.id));
  const journalPath = rel(RETIREMENT_JOURNAL);
  const journal = {
    _doc: 'Transazione di recovery per scripts/retire-article.mjs; si elimina a verifica completata.',
    id,
    section,
    winnerId: winner,
    winnerSection,
    retiredOn: priorRetirement?.retiredOn ?? new Date().toISOString().slice(0, 10),
    duplicateOf: retiredSourceUrls,
    slugs,
    imageKey: ownKey,
  };

  for (const p of planned) console.log(`   - ${p.file}  (${p.what})`);

  // Nessun target di write può cambiare tipo o permessi tra la pianificazione
  // e il primo write; come per i delete, la verifica è fail-closed.
  validateWriteTargets(writes);

  // Every delete target has been checked while planning; check again after
  // planning so a directory/FIFO or a vanished file cannot slip in between
  // validation and the first write.
  validateDeleteTargets(deletes);
  requireWritableDirectory(
    ROOT,
    retiredLedgerDirectory,
    'directory padre del ledger ritirati',
  );
  requireWritableDirectory(
    ROOT,
    retirementJournalDirectory,
    'directory padre del journal del retirement',
  );
  if (retirementJournalPresent) {
    requireWritableRegularFile(ROOT, RETIREMENT_JOURNAL, 'target da scrivere (journal del retirement)');
  }

  if (dryRun) {
    console.log('\n[DRY RUN] niente scritto.');
    return;
  }

  // Il journal e' il primo commit atomico: se il processo muore in uno dei
  // write/delete successivi, la prossima invocazione sa quale retirement
  // riprendere anche quando la tombstone non e' ancora stata scritta.
  writeJsonAtomic(journalPath, journal);
  for (const [file, text] of writes) write(file, text);
  for (const file of deletes) unlinkSync(rel(file));

  // 11. ledger dei ritirati — gli slug localizzati non sono più derivabili da
  //     nessun registro dopo il passo 1, e servono all'altro repo per il 301.
  writeJsonAtomic(ledgerPath, ledger);

  // 12. verifica finale: l'id non deve più comparire da nessuna parte.
  //     Senza questo passo una rimozione parziale esce 0 e ferma il publish
  //     del corpus intero al prossimo push di contenuto.
  const leftovers = [];
  const unreadable = [];
  for (const file of leftoverSurfacesFor(section)) {
    const status = surfaceArticleIdStatus(file, read(file), id);
    if (status === SURFACE_ARTICLE_ID_STATUS.PRESENT) leftovers.push(file);
    if (status === SURFACE_ARTICLE_ID_STATUS.UNREADABLE) unreadable.push(file);
  }
  if (leftovers.length > 0 || unreadable.length > 0) {
    if (leftovers.length > 0) {
      console.error(`\nRIMOZIONE PARZIALE — '${id}' compare ancora in:\n${leftovers.map((f) => `   ${f}`).join('\n')}`);
    }
    if (unreadable.length > 0) {
      console.error(`\nVERIFICA INCOMPLETA — impossibile stabilire se '${id}' è assente da questi ledger:\n${unreadable.map((f) => `   ${f} (ledger illeggibile o in forma non supportata)`).join('\n')}`);
    }
    process.exit(1);
  }
  if (existsSync(journalPath)) unlinkSync(journalPath);
  console.log(`\nfatto: '${id}' rimosso da ${planned.filter((p) => !p.kept).length} superfici, slug preservati in ${RETIRED_LEDGER}.`);
}

main();
