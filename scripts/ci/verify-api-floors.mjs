#!/usr/bin/env node
/**
 * verify-api-floors.mjs — il gate di magnitudine di `publish-api.yml`.
 *
 * WHY THIS EXISTS
 * ───────────────
 * `build-api.mjs` chiude gia' tre gate sul proprio output: caratteri di
 * controllo, `manifest.files` (byte su disco) e `manifest.counts` (cardinalita'
 * ri-derivata dai byte scritti). Tutti e tre dimostrano che il manifest
 * DESCRIVE cio' che sta in `dist/api/` — nessuno puo' dire se cio' che sta in
 * `dist/api/` sia il corpus INTERO. Un registro letto a meta' produce una
 * superficie perfettamente coerente con se stessa, e il manifest dichiara
 * onestamente i suoi 500 articoli su 3782.
 *
 * Quel confronto e' il mestiere di questo file, ed e' l'unico che ha bisogno di
 * un riferimento ESTERNO all'artefatto. Il riferimento e' il corpus sorgente su
 * disco (`scripts/lib/corpus-floors.mjs`), non una costante: un pavimento
 * assoluto e' proprio cio' che si e' svuotato in silenzio mentre il corpus
 * cresceva (`counts.articles -lt 100` contro 3782 reali, e nessun pavimento su
 * `counts.swissArticles`).
 *
 * Vive qui e non nello YAML perche' il pavimento nello YAML non era
 * testabile — ed e' esattamente per questo che il suo decadimento non e' stato
 * visto da nessun test per tutta la crescita del corpus.
 *
 * Uso:  node scripts/ci/verify-api-floors.mjs [--dist dist/api]
 * Esce 1 elencando ogni violazione; 0 e un riepilogo se tutto regge.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  floorFrom,
  retentionLine,
  retentionWarning,
  retentionRatio,
  FLOOR_RETENTION,
  FLOOR_WARN_RETENTION,
  countSourceArticles,
  countSourceImages,
  missingCorpusMessage,
  countSeoEntries,
  SECTION_BODY_DIRS,
  SEO_CHUNK_DIR,
  IMAGE_SOURCE_DIR,
} from '../lib/corpus-floors.mjs';
// Stessa funzione del writer e del gate manifest.counts in build-api.mjs: un
// `<item>` citato dentro un CDATA non e' un elemento del feed, e contarlo qui
// alzerebbe la misura sopra il pavimento mascherando un feed troncato.
import { countXmlTags } from '../lib/count-xml-tags.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Le due sezioni, col contatore del manifest che ciascuna alimenta. */
export const SECTION_COUNTERS = {
  frontaliere: 'articles',
  svizzera: 'swissArticles',
};

/**
 * A quale sezione appartiene un feed, dal nome del file.
 *
 * `rss-svizzera*.xml` e' la sezione svizzera, tutto il resto e' frontaliere —
 * e' la stessa convenzione che `RSS_SECTIONS` usa per generarli.
 */
export function feedSection(fileName) {
  return /^rss-svizzera/.test(fileName) ? 'svizzera' : 'frontaliere';
}

/**
 * Il nucleo puro: date le misure, quali pavimenti sono sfondati.
 *
 * @param {{articleCounts: Record<string, number>, feeds: {name: string, items: number}[],
 *          images: number|null}} measured  cio' che l'artefatto dichiara
 * @param {{sourceArticles: Record<string, number>, feedSources: Record<string, number>,
 *          sourceImages: number, rssMaxItems: number}} expected   cio' che il corpus
 *          sorgente promette: `sourceArticles` sono i file di corpo (il riferimento di
 *          `manifest.counts`), `feedSources` le voci dei chunk SEO (quello dei feed)
 * @returns {string[]} una riga per violazione, vuoto se tutto regge
 */
export function floorViolations(measured, expected, retention = undefined) {
  const violations = [];
  const floor = (n) => floorFrom(n, retention);

  for (const [section, counter] of Object.entries(SECTION_COUNTERS)) {
    const source = expected.sourceArticles[section] ?? 0;
    // Corpus della sezione a zero: NON e' «niente da confrontare», e' il
    // riferimento che manca. Saltare qui azzererebbe insieme questo pavimento,
    // i dieci dei feed e quello delle immagini, e il verificatore uscirebbe 0
    // con un messaggio affermativo su un artefatto arbitrariamente troncato —
    // un livello sopra, esattamente la classe che questa PR chiude. Pubblicare
    // `dist/api` da un checkout senza corpus non e' mai legittimo.
    if (source === 0) {
      violations.push(missingCorpusMessage(`manifest.counts.${counter}`, SECTION_BODY_DIRS[section]));
      continue;
    }
    const declared = measured.articleCounts[counter];
    if (typeof declared !== 'number') {
      violations.push(`manifest.counts.${counter} assente: il corpus sorgente ne tiene ${source}`);
      continue;
    }
    const min = floor(source);
    if (declared < min) {
      violations.push(
        `manifest.counts.${counter}: ${declared} contro ${source} articoli sorgente (pavimento ${min}) — set troncato`,
      );
    }
  }

  // Un feed e' tagliato a RSS_MAX_ITEMS, quindi il suo atteso e' il minimo fra
  // il tetto e la popolazione che lo GENERA: su una sezione piccola un feed
  // corto e' corretto, su una grande e' un troncamento.
  //
  // E quella popolazione sono i chunk SEO, non i file di corpo. Gli `<item>`
  // nascono da `parseSeoBlogs` sui `RSS_SECTIONS[].seoFiles`; i corpi sono un
  // insieme scollegato, che oggi diverge gia' di quasi mille unita' (4728
  // contro 3792 lato frontaliere). Tararci sopra il pavimento dei feed sbaglia
  // in entrambe le direzioni, e la peggiore per il ciclo non e' il falso
  // negativo: e' che una sezione con meno di `floor(RSS_MAX_ITEMS * retention)`
  // voci datate BLOCCA l'intera pubblicazione per un feed corto ma completo.
  const missingSeo = new Set();
  for (const feed of measured.feeds) {
    const section = feedSection(feed.name);
    const source = expected.feedSources?.[section] ?? 0;
    // Stessa regola dei corpi, un riferimento diverso: zero voci nei chunk non
    // e' «feed legittimamente vuoto», e' la lista dei chunk che non risolve —
    // il modo esatto in cui un feed e' gia' rimasto fermo tre mesi. Una riga
    // per sezione, non una per feed: i cinque feed di una sezione condividono
    // il riferimento, e ripeterlo cinque volte non aggiunge niente.
    if (source === 0) {
      if (!missingSeo.has(section)) {
        missingSeo.add(section);
        violations.push(
          missingCorpusMessage(`i feed di ${section}`, `${SEO_CHUNK_DIR} (chunk di ${section})`),
        );
      }
      continue;
    }
    const min = floor(Math.min(expected.rssMaxItems, source));
    if (feed.items < min) {
      violations.push(
        `${feed.name}: ${feed.items} <item> contro ${min} attesi ` +
          `(${source} voci nei chunk SEO di ${section}) — feed troncato`,
      );
    }
  }

  // `images-manifest.json` viene emesso SOLO se questo repo tiene immagini:
  // `null` significa non emesso, che e' valido (lo stesso ramo che lo YAML
  // gestisce con `-f`). Emesso, deve descrivere le immagini che ci sono.
  if (measured.images !== null) {
    // Emesso ma senza sorgente: stesso fail-open degli articoli. Il ramo
    // `null` (manifest non emesso) resta valido — e' l'unico caso in cui non
    // c'e' niente da confrontare.
    if (expected.sourceImages === 0) {
      violations.push(missingCorpusMessage('images-manifest.json', IMAGE_SOURCE_DIR));
    } else {
      const min = floor(expected.sourceImages);
      if (measured.images < min) {
        violations.push(
          `images-manifest.json: ${measured.images} immagini contro ${expected.sourceImages} in ${IMAGE_SOURCE_DIR} (pavimento ${min})`,
        );
      }
    }
  }

  return violations;
}

/**
 * Ogni rapporto misurato/atteso che un pavimento sorveglia, come DATO.
 *
 * WHY. `floorViolations` risponde a una domanda binaria — sfondato o no — e
 * quella risposta e' muta finche' non e' «sfondato». Ma il rapporto fra corpus
 * e artefatto non e' stazionario: qualunque flusso che lasci un corpo senza la
 * sua voce (orfani, ritiri a meta', import parziali) lo erode in modo
 * MONOTONO, e con la sola risposta binaria la prima notizia dell'erosione e'
 * la pubblicazione bloccata su un corpus sano. Questa funzione rende il
 * rapporto osservabile PRIMA che diventi un fallimento.
 *
 * Le righe le produce lo stesso attraversamento di `floorViolations`, con gli
 * stessi riferimenti — i corpi per `manifest.counts`, i chunk SEO (tagliati a
 * `RSS_MAX_ITEMS`) per i feed, le hero per le immagini: un secondo criterio
 * qui misurerebbe qualcosa che il gate non gata, che e' peggio di non misurare.
 *
 * Le righe SENZA riferimento non compaiono: sorgente a zero non e' un rapporto
 * basso, e' l'assenza del riferimento, ed e' gia' una violazione bloccante.
 *
 * @returns {{kind: string, label: string, declared: number, source: number}[]}
 */
export function retentionReport(measured, expected) {
  const rows = [];

  for (const [section, counter] of Object.entries(SECTION_COUNTERS)) {
    const source = expected.sourceArticles[section] ?? 0;
    const declared = measured.articleCounts[counter];
    if (source <= 0 || typeof declared !== 'number') continue;
    rows.push({ kind: 'manifest', label: `manifest.counts.${counter}`, declared, source });
  }

  for (const feed of measured.feeds) {
    const source = expected.feedSources?.[feedSection(feed.name)] ?? 0;
    if (source <= 0) continue;
    // Lo stesso atteso del pavimento: un feed e' tagliato a RSS_MAX_ITEMS,
    // quindi su una sezione grande il 100% e' 50 item, non 3750.
    rows.push({
      kind: 'feed',
      label: feed.name,
      declared: feed.items,
      source: Math.min(expected.rssMaxItems, source),
    });
  }

  if (measured.images !== null && expected.sourceImages > 0) {
    rows.push({
      kind: 'images',
      label: 'images-manifest.json',
      declared: measured.images,
      source: expected.sourceImages,
    });
  }

  return rows;
}

/**
 * I preallarmi del report: una riga per rapporto sceso sotto
 * `FLOOR_WARN_RETENTION` ma ancora sopra il gate.
 *
 * Advisory per costruzione — il chiamante le emette come `::warning::` e ESCE
 * COMUNQUE 0. Spostare il verdetto qui significherebbe aver alzato il gate da
 * 0,90 a 0,97 di soppiatto (AGENTS.md #1), che e' l'opposto di cio' che questo
 * livello serve a fare.
 */
export function retentionAdvisories(rows, retention = FLOOR_RETENTION, warn = FLOOR_WARN_RETENTION) {
  return rows
    .map((r) => retentionWarning(r.label, r.declared, r.source, retention, warn))
    .filter((line) => line !== null);
}

/**
 * Le righe da stampare a ogni run: i due rapporti del manifest, quello delle
 * immagini, e — per i feed — il PIU' MAGRO della sezione.
 *
 * I dieci feed condividono il riferimento della loro sezione e stanno quasi
 * sempre tutti al tetto: stamparli tutti annegherebbe le due righe che contano
 * in otto identiche, e una telemetria che non si legge non e' telemetria. Il
 * minimo e' il rappresentante giusto perche' e' quello che tocchera' per primo
 * sia il preallarme sia il gate; i preallarmi veri restano comunque uno per
 * feed, perche' li produce `retentionAdvisories` sul report INTERO.
 */
export function retentionLines(rows, retention = FLOOR_RETENTION) {
  const worstFeed = rows
    .filter((r) => r.kind === 'feed')
    .reduce((worst, r) => (worst === null || retentionRatio(r.declared, r.source) < retentionRatio(worst.declared, worst.source) ? r : worst), null);
  const feedCount = rows.filter((r) => r.kind === 'feed').length;

  return rows
    .filter((r) => r.kind !== 'feed' || r === worstFeed)
    .map((r) =>
      retentionLine(
        r.kind === 'feed' ? `${r.label} (il piu' magro dei ${feedCount} feed)` : r.label,
        r.declared,
        r.source,
        retention,
      ),
    );
}

/** Legge dall'artefatto su disco le misure che il nucleo puro confronta. */
export function measureDist(distDir) {
  const readOut = (name) => fs.readFileSync(path.join(distDir, name), 'utf-8');
  const manifest = JSON.parse(readOut('manifest.json'));

  // I feed si riconoscono dal DOCUMENTO, non dal nome: una lista di nomi qui
  // sarebbe una seconda copia di quella dello YAML, e un feed aggiunto domani
  // resterebbe fuori dal gate senza che nulla lo segnali.
  const feeds = fs
    .readdirSync(distDir)
    .filter((f) => f.endsWith('.xml'))
    .map((name) => ({ name, xml: readOut(name) }))
    .filter(({ xml }) => xml.includes('<rss'))
    .map(({ name, xml }) => ({ name, items: countXmlTags(xml, 'item') }));

  const imageManifest = path.join(distDir, 'images-manifest.json');
  const images = fs.existsSync(imageManifest)
    ? JSON.parse(fs.readFileSync(imageManifest, 'utf-8')).images.length
    : null;

  return { articleCounts: manifest.counts ?? {}, feeds, images };
}

/** Riconta il corpus sorgente, che e' il riferimento esterno all'artefatto. */
export async function expectFromCorpus(root) {
  // Importati, non ricopiati: `RSS_MAX_ITEMS` e la lista dei chunk di ogni
  // sezione hanno una sorgente sola, ed e' quella che genera davvero i feed.
  // Una seconda lista qui sarebbe il difetto che ha congelato rss.xml per tre
  // mesi, spostato di un file (AGENTS.md #6).
  const { RSS_MAX_ITEMS, RSS_SECTIONS } = await import(
    pathToFileURL(path.join(root, 'engine', 'rssFeeds.mjs')).href
  );
  const feedSources = {};
  for (const section of RSS_SECTIONS) {
    feedSources[section.id] = countSeoEntries(root, section.seoFiles);
  }
  return {
    sourceArticles: {
      frontaliere: countSourceArticles(root, 'frontaliere'),
      svizzera: countSourceArticles(root, 'svizzera'),
    },
    feedSources,
    sourceImages: countSourceImages(root),
    rssMaxItems: RSS_MAX_ITEMS,
  };
}

async function main() {
  const distIdx = process.argv.indexOf('--dist');
  const distDir = distIdx >= 0 ? path.resolve(process.argv[distIdx + 1]) : path.join(ROOT, 'dist', 'api');

  const measured = measureDist(distDir);
  const expected = await expectFromCorpus(ROOT);
  const violations = floorViolations(measured, expected);

  console.log(
    `[api-floors] corpus sorgente: ${expected.sourceArticles.frontaliere} frontaliere, ` +
      `${expected.sourceArticles.svizzera} svizzera, ${expected.sourceImages} immagini`,
  );
  console.log(
    `[api-floors] chunk SEO (la popolazione che genera i feed): ` +
      `${expected.feedSources.frontaliere} frontaliere, ${expected.feedSources.svizzera} svizzera`,
  );
  console.log(
    `[api-floors] manifest: articles=${measured.articleCounts.articles}, ` +
      `swissArticles=${measured.articleCounts.swissArticles}, ` +
      `feeds=${measured.feeds.length}, images=${measured.images ?? 'non emesso'}`,
  );

  // La telemetria del rapporto viene PRIMA del verdetto, e viene stampata anche
  // quando il verdetto e' rosso: se il gate scatta, il margine di ogni altro
  // rapporto e' la prima cosa che serve per capire quanto e' vicino il
  // prossimo.
  const rows = retentionReport(measured, expected);
  for (const line of retentionLines(rows)) console.log(`[api-floors] ${line}`);

  if (violations.length) {
    for (const v of violations) console.error(`::error::${v}`);
    process.exit(1);
  }

  // Advisory: sotto il preallarme ma sopra il gate. Esce comunque 0 — il gate
  // resta 0,90 e resta l'unico a bloccare.
  const advisories = retentionAdvisories(rows);
  for (const a of advisories) console.warn(`::warning::[api-floors] ${a}`);
  if (advisories.length) {
    console.log(
      `[api-floors] ${advisories.length} rapporto/i sotto il preallarme ` +
        `${(FLOOR_WARN_RETENTION * 100).toFixed(0)}%: la pubblicazione passa, l'erosione no`,
    );
  }
  console.log(`[api-floors] pavimenti derivati dal corpus: tutti retti (${measured.feeds.length} feed inclusi)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
