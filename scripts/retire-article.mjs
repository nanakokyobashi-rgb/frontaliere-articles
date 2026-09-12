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

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ledgerArticleId } from '../generator/scripts/lib/source-url-ledger.mjs';
import { writeJsonAtomic } from '../generator/scripts/lib/atomic-write-json.mjs';
import {
  SECTIONS, LOCALES, IMAGES_LEDGER, IMAGE_CATALOG, RETIRED_LEDGER,
  seoFilesFor, leftoverSurfacesFor, surfaceArticleIdStatus, SURFACE_ARTICLE_ID_STATUS,
} from './lib/article-surfaces.mjs';
// La localizzazione dei letterali TS (span dell'array piatto degli id, e la
// parentesi che chiude davvero quella di apertura) vive in un modulo condiviso:
// la usa anche `generator/scripts/create-article.mjs`, che lo STESSO array lo
// rigenera (vedi il file per il perché delle due euristiche cadute).
import { matchingDelimiter, removeFromIdListLiteral } from './lib/ts-literals.mjs';
import { removeSeoEntriesFromSource } from './lib/seo-entry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const rel = (p) => path.join(ROOT, p);
const read = (p) => readFileSync(rel(p), 'utf-8');
const write = (p, s) => writeFileSync(rel(p), s, 'utf-8');

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

/** Rimuove dal catalogo immagini l'oggetto il cui `path` nomina l'id. */
function removeFromImageCatalog(file, id) {
  const list = JSON.parse(read(file));
  if (!Array.isArray(list)) throw new Error(`${file}: atteso un array`);
  const kept = list.filter((e) => !(e && typeof e.path === 'string' && e.path.includes(`/${id}.webp`)));
  if (kept.length === list.length) return { changed: false, text: null };
  return { changed: true, text: `${JSON.stringify(kept)}\n` };
}



/** In quale sezione vive l'id? Deciso dal registro che lo contiene. */
function findSection(id) {
  const found = Object.entries(SECTIONS).filter(([, cfg]) => read(cfg.registryFile).includes(`id: '${id}',`));
  if (found.length === 0) throw new Error(`'${id}' non è in nessuno dei due registri`);
  if (found.length > 1) throw new Error(`'${id}' è in ${found.length} registri: ambiguo, va risolto a mano`);
  return found[0][0];
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

  const section = findSection(id);
  const cfg = SECTIONS[section];
  const winnerSection = findSection(winner); // esiste? altrimenti throw: mai ritirare verso il nulla
  console.log(`ritiro '${id}' (${section}) → vincitore '${winner}' (${winnerSection})${dryRun ? '  [DRY RUN]' : ''}`);

  /** @type {Array<{file: string, what: string}>} */
  const planned = [];
  /** @type {Array<[string, string]>} */
  const writes = [];
  /** @type {string[]} */
  const deletes = [];

  // 1. slug map — PRIMA di tutto: è l'unico posto da cui gli slug localizzati
  //    sono ancora leggibili, e servono al ledger dei ritirati.
  const slugRow = removeSlugRow(cfg.slugDataFile, id);
  if (!slugRow.changed) throw new Error(`${cfg.slugDataFile}: nessuna riga per '${id}' — mappa slug già incoerente col registro`);
  let slugDataSrc = slugRow.src;
  planned.push({ file: cfg.slugDataFile, what: `riga slug (${LOCALES.map((l) => slugRow.slugs[l]).join(', ')})` });

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
  writes.push([cfg.slugDataFile, slugDataSrc]);

  // 1c. union di literal degli id (`BlogArticleId`), che vive in un file
  //     separato dalla mappa slug e che solo questa sezione mantiene.
  if (cfg.idUnionFile && existsSync(rel(cfg.idUnionFile))) {
    const union = removeFromIdUnion(read(cfg.idUnionFile), id);
    if (union.changed) {
      writes.push([cfg.idUnionFile, union.src]);
      planned.push({ file: cfg.idUnionFile, what: 'membro della union BlogArticleId' });
    }
  }

  // 2. registro di sezione
  const reg = removeRegistryEntry(cfg.registryFile, id);
  if (!reg.changed) throw new Error(`${cfg.registryFile}: nessun blocco per '${id}'`);
  writes.push([cfg.registryFile, reg.src]);
  planned.push({ file: cfg.registryFile, what: 'blocco di registro' });

  // 3. meta per locale
  for (const metaFile of cfg.metaFiles) {
    const r = removeMetaKeys(metaFile, id);
    if (r.changed) { writes.push([metaFile, r.src]); planned.push({ file: metaFile, what: 'chiavi i18n' }); }
  }

  // 4. SEO
  for (const seoFile of seoFilesFor(section)) {
    const r = removeSeoEntry(seoFile, id);
    if (r.changed) { writes.push([seoFile, r.src]); planned.push({ file: seoFile, what: 'blocco SEO' }); }
  }

  // 5. corpi per locale
  for (const loc of LOCALES) {
    const bodyFile = `${cfg.bodyDir}/${loc}/${id}.ts`;
    if (existsSync(rel(bodyFile))) { deletes.push(bodyFile); planned.push({ file: bodyFile, what: 'corpo' }); }
  }

  // 6. sidecar
  const sidecar = `${cfg.sidecarDir}/${id}.json`;
  if (existsSync(rel(sidecar))) { deletes.push(sidecar); planned.push({ file: sidecar, what: 'sidecar' }); }

  // 7. ledger URL→id della sezione
  const led = removeJsonByValue(cfg.sourceLedger, id);
  let retiredSourceUrls = [];
  if (led.changed) {
    retiredSourceUrls = led.hits;
    writes.push([cfg.sourceLedger, led.text]);
    planned.push({ file: cfg.sourceLedger, what: `${led.hits.length} URL di fonte` });
  }

  // 8. provenienza immagine
  const img = removeJsonByKey(IMAGES_LEDGER, id);
  if (img.changed) { writes.push([IMAGES_LEDGER, img.text]); planned.push({ file: IMAGES_LEDGER, what: 'provenienza immagine' }); }

  // 9. catalogo immagini del giornalista
  if (existsSync(rel(IMAGE_CATALOG))) {
    const cat = removeFromImageCatalog(IMAGE_CATALOG, id);
    if (cat.changed) { writes.push([IMAGE_CATALOG, cat.text]); planned.push({ file: IMAGE_CATALOG, what: 'voce di catalogo' }); }
  }

  // 10. asset immagine
  for (const asset of [`public/images/blog/${id}.webp`, `public/images/blog/thumbnails/${id}-480w.webp`]) {
    if (existsSync(rel(asset))) { deletes.push(asset); planned.push({ file: asset, what: 'asset' }); }
  }

  for (const p of planned) console.log(`   - ${p.file}  (${p.what})`);

  if (dryRun) {
    console.log('\n[DRY RUN] niente scritto.');
    return;
  }

  for (const [file, text] of writes) write(file, text);
  for (const file of deletes) unlinkSync(rel(file));

  // 11. ledger dei ritirati — gli slug localizzati non sono più derivabili da
  //     nessun registro dopo il passo 1, e servono all'altro repo per il 301.
  const ledgerPath = rel(RETIRED_LEDGER);
  const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf-8')) : { _doc: '', retired: [] };
  ledger.retired = ledger.retired.filter((e) => e.id !== id);
  ledger.retired.push({
    id,
    section,
    winnerId: winner,
    winnerSection,
    retiredOn: new Date().toISOString().slice(0, 10),
    duplicateOf: retiredSourceUrls,
    slugs: slugRow.slugs,
  });
  ledger.retired.sort((a, b) => a.id.localeCompare(b.id));
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
  console.log(`\nfatto: '${id}' rimosso da ${planned.length} superfici, slug preservati in ${RETIRED_LEDGER}.`);
}

main();
