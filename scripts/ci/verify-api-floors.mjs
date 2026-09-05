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
  countSourceArticles,
  countSourceImages,
  missingCorpusMessage,
  SECTION_BODY_DIRS,
  IMAGE_SOURCE_DIR,
} from '../lib/corpus-floors.mjs';

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

const occurrences = (text, needle) => text.split(needle).length - 1;

/**
 * Il nucleo puro: date le misure, quali pavimenti sono sfondati.
 *
 * @param {{articleCounts: Record<string, number>, feeds: {name: string, items: number}[],
 *          images: number|null}} measured  cio' che l'artefatto dichiara
 * @param {{sourceArticles: Record<string, number>, sourceImages: number,
 *          rssMaxItems: number}} expected   cio' che il corpus sorgente promette
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
  // il tetto e il corpus della sua sezione: su una sezione piccola un feed
  // corto e' corretto, su una grande e' un troncamento.
  for (const feed of measured.feeds) {
    const section = feedSection(feed.name);
    const source = expected.sourceArticles[section] ?? 0;
    if (source === 0) continue; // riferimento mancante: gia' segnalato una volta sopra
    const min = floor(Math.min(expected.rssMaxItems, source));
    if (feed.items < min) {
      violations.push(`${feed.name}: ${feed.items} <item> contro ${min} attesi — feed troncato`);
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
    .map(({ name, xml }) => ({ name, items: occurrences(xml, '<item>') }));

  const imageManifest = path.join(distDir, 'images-manifest.json');
  const images = fs.existsSync(imageManifest)
    ? JSON.parse(fs.readFileSync(imageManifest, 'utf-8')).images.length
    : null;

  return { articleCounts: manifest.counts ?? {}, feeds, images };
}

/** Riconta il corpus sorgente, che e' il riferimento esterno all'artefatto. */
export async function expectFromCorpus(root) {
  // Importato, non ricopiato: `RSS_MAX_ITEMS` ha una sorgente sola, ed e'
  // quella che genera davvero i feed.
  const { RSS_MAX_ITEMS } = await import(pathToFileURL(path.join(root, 'engine', 'rssFeeds.mjs')).href);
  return {
    sourceArticles: {
      frontaliere: countSourceArticles(root, 'frontaliere'),
      svizzera: countSourceArticles(root, 'svizzera'),
    },
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
    `[api-floors] manifest: articles=${measured.articleCounts.articles}, ` +
      `swissArticles=${measured.articleCounts.swissArticles}, ` +
      `feeds=${measured.feeds.length}, images=${measured.images ?? 'non emesso'}`,
  );

  if (violations.length) {
    for (const v of violations) console.error(`::error::${v}`);
    process.exit(1);
  }
  console.log(`[api-floors] pavimenti derivati dal corpus: tutti retti (${measured.feeds.length} feed inclusi)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
