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

import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const rel = (p) => path.join(ROOT, p);
const read = (p) => readFileSync(rel(p), 'utf-8');
const write = (p, s) => writeFileSync(rel(p), s, 'utf-8');

/** Descrittori per sezione: le superfici su cui `create-article.mjs` scrive. */
const SECTIONS = {
  frontaliere: {
    registryFile: 'content/blog-articles-data.ts',
    slugDataFile: 'content/routerBlogData.ts',
    metaFiles: ['it', 'en', 'de', 'fr'].map((l) => `content/blog-meta-${l}.ts`),
    bodyDir: 'content/blog-body',
    seoFiles: null, // scoperti a runtime: content/seo/seo-blog-*.ts
    seoGlobPrefix: 'content/seo/seo-blog-',
    sourceLedger: 'data/article-source-urls.json',
    sidecarDir: 'data/blog-articles',
  },
  svizzera: {
    registryFile: 'content/swiss-articles-data.ts',
    slugDataFile: 'content/routerSwissData.ts',
    metaFiles: ['it', 'en', 'de', 'fr'].map((l) => `content/blog-meta-ch-${l}.ts`),
    bodyDir: 'content/blog-body-ch',
    seoFiles: ['content/seo/seo-blog-ch.ts'],
    seoGlobPrefix: null,
    sourceLedger: 'data/swiss-article-source-urls.json',
    sidecarDir: 'data/swiss-articles',
  },
};

const LOCALES = ['it', 'en', 'de', 'fr'];
const IMAGES_LEDGER = 'data/blog-images-used.json';
const IMAGE_CATALOG = 'public/data/journalist-image-catalog.json';
const RETIRED_LEDGER = 'data/retired-articles.json';

/**
 * Trova la `}` che chiude la `{` a `openIdx`, ignorando le graffe dentro le
 * stringhe.
 *
 * Deve seguire TUTTI E TRE i delimitatori — `'`, `"` e il backtick — e non solo
 * l'apice singolo con cui sono scritte le chiavi. I blocchi `structuredData`
 * dei file SEO sono JSON con le chiavi fra doppi apici, e i loro valori
 * contengono apostrofi italiani (`"description": "…un'autostrada…"`). Seguendo
 * il solo apice singolo, quell'apostrofo apre una stringa che non si chiude
 * più, tutte le graffe successive vengono ignorate e la funzione restituisce
 * una `}` interna: il blocco viene troncato a metà e il file resta con una
 * `},` orfana. Non è ipotetico — è successo al primo giro su
 * `content/seo/seo-blog-ch.ts`, e `tsx` lo ha rifiutato con
 * «Expected identifier» sulla chiave successiva.
 */
function matchingBrace(src, openIdx) {
  let depth = 0;
  let quote = null;
  for (let i = openIdx; i < src.length; i += 1) {
    const ch = src[i];
    if (quote !== null) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Rimuove il blocco `{ … id: '<id>', … },` dal registro di sezione. */
function removeRegistryEntry(file, id) {
  const src = read(file);
  const needle = `id: '${id}',`;
  const at = src.indexOf(needle);
  if (at === -1) return { changed: false, src };
  const open = src.lastIndexOf('{', at);
  if (open === -1) throw new Error(`${file}: nessuna '{' prima di ${needle}`);
  const close = matchingBrace(src, open);
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

/** Rimuove ogni riga `'blog.article.<id>.<campo>': …` da un file di meta. */
function removeMetaKeys(file, id) {
  const src = read(file);
  const rx = new RegExp(`^[ \\t]*'blog\\.article\\.${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[^']*':[\\s\\S]*?\\n(?=[ \\t]*'|[ \\t]*\\})`, 'gm');
  const out = src.replace(rx, '');
  return { changed: out !== src, src: out };
}

/** Rimuove il blocco `'blog-<id>': { … },` da un file SEO. */
function removeSeoEntry(file, id) {
  const src = read(file);
  const needle = `'blog-${id}': {`;
  const at = src.indexOf(needle);
  if (at === -1) return { changed: false, src };
  const open = src.indexOf('{', at);
  const close = matchingBrace(src, open);
  if (close === -1) throw new Error(`${file}: graffe sbilanciate attorno a blog-${id}`);
  let start = at;
  while (start > 0 && (src[start - 1] === ' ' || src[start - 1] === '\t')) start -= 1;
  let end = close + 1;
  if (src[end] === ',') end += 1;
  if (src[end] === '\n') end += 1;
  return { changed: true, src: src.slice(0, start) + src.slice(end) };
}

/** Rimuove da una mappa JSON ogni voce il cui VALORE è l'id (ledger URL→id). */
function removeJsonByValue(file, id) {
  const map = JSON.parse(read(file));
  const hits = Object.entries(map).filter(([, v]) => v === id).map(([k]) => k);
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

function seoFilesFor(section) {
  const cfg = SECTIONS[section];
  if (cfg.seoFiles) return cfg.seoFiles.filter((f) => existsSync(rel(f)));
  const dir = rel('content/seo');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith('seo-blog-') && f.endsWith('.ts'))
    .map((f) => `content/seo/${f}`);
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

  if (!id || !argv.includes('--winner') || !winner || winner.startsWith('--')) {
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
  writes.push([cfg.slugDataFile, slugRow.src]);
  planned.push({ file: cfg.slugDataFile, what: `riga slug (${LOCALES.map((l) => slugRow.slugs[l]).join(', ')})` });

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
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf-8');

  // 12. verifica finale: l'id non deve più comparire da nessuna parte.
  //     Senza questo passo una rimozione parziale esce 0 e ferma il publish
  //     del corpus intero al prossimo push di contenuto.
  const surfaces = [
    cfg.registryFile, cfg.slugDataFile, ...cfg.metaFiles, ...seoFilesFor(section),
    cfg.sourceLedger, IMAGES_LEDGER,
  ].filter((f) => existsSync(rel(f)));
  const leftovers = surfaces.filter((f) => read(f).includes(id));
  if (leftovers.length > 0) {
    console.error(`\nRIMOZIONE PARZIALE — '${id}' compare ancora in:\n${leftovers.map((f) => `   ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`\nfatto: '${id}' rimosso da ${planned.length} superfici, slug preservati in ${RETIRED_LEDGER}.`);
}

main();
