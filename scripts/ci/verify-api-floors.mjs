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
  countSeoEntries,
  countSourceArticles,
  countSourceImages,
  missingCorpusMessage,
  withinWarnBand,
  SECTION_BODY_DIRS,
  SEO_DIR,
  IMAGE_SOURCE_DIR,
} from '../lib/corpus-floors.mjs';
// I `<item>` si contano sulla STRUTTURA del documento, non sul suo testo: il
// corpo integrale dell'articolo viaggia dentro <content:encoded><![CDATA[…]]>.
import { countTags } from '../lib/xml-counts.mjs';

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
 * @param {{sourceArticles: Record<string, number>, seoEntries: Record<string, number>,
 *          sourceImages: number, rssMaxItems: number}} expected   cio' che il corpus
 *          sorgente promette: i corpi per i contatori del manifest, le voci SEO per i
 *          feed (sono due popolazioni diverse, e ciascun pavimento va sulla propria)
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
  // il tetto e la popolazione che lo genera.
  //
  // E quella popolazione sono le VOCI SEO, non i file di corpo della sezione:
  // `buildSectionFeeds` costruisce gli <item> da `parseSeoBlogs(section.seoFiles)`
  // (`engine/rssFeeds.mjs`), e i corpi non entrano nel conteggio. Tarare il
  // pavimento sui corpi legava il gate a una popolazione DIVERSA da quella
  // misurata: due insiemi che possono divergere senza che nulla li colleghi —
  // e' gia' successo, il feed fermo tre mesi perche' i chunk letti erano due su
  // sette. Peggio ancora, la divergenza andava nella direzione che blocca: un
  // chunk uscito dalla lista, o una sezione con meno di 45 voci datate, non
  // faceva segnalare un feed vecchio, faceva fallire l'INTERA pubblicazione per
  // un feed legittimamente corto.
  for (const feed of measured.feeds) {
    const section = feedSection(feed.name);
    const source = expected.seoEntries[section] ?? 0;
    if (source === 0) {
      violations.push(missingCorpusMessage(`${feed.name} (voci SEO di ${section})`, SEO_DIR));
      continue;
    }
    const cap = Math.min(expected.rssMaxItems, source);
    const min = floor(cap);
    if (feed.items < min) {
      violations.push(
        `${feed.name}: ${feed.items} <item> contro ${cap} attesi (pavimento ${min}, ` +
          `da ${source} voci SEO nella sezione ${section}) — feed troncato`,
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
 * Gli avvisi di AVVICINAMENTO al pavimento — nessuna decisione di pass/fail.
 *
 * `FLOOR_RETENTION` e' misurato su un rapporto che NON e' stazionario: da un
 * lato i file di corpo `it`, dall'altro le voci del registro, e i due restano
 * allineati (3786/3789, 1856/1856) solo perche' `scripts/retire-article.mjs`
 * cancella corpo e voce insieme. Qualunque flusso che lasci un corpo senza voce
 * — orfani, ritiri a meta', import parziali — abbassa il rapporto in modo
 * MONOTONO, e al -10% questo gate comincia a rifiutare una pubblicazione sana
 * con un messaggio che parla di «set troncato». Oggi nessuno misura quel
 * rapporto nel tempo.
 *
 * Una deriva monotona attraversa pero' una banda prima del muro: `WARN_MARGIN`.
 * Emettere l'avviso qui lo mette nel log della run che pubblica — cioe' nel
 * posto dove il rapporto viene gia' calcolato — e lo rende visibile PRIMA che
 * diventi un blocco, senza allargare di un millimetro il pavimento.
 */
export function retentionWarnings(measured, expected) {
  const warnings = [];
  for (const [section, counter] of Object.entries(SECTION_COUNTERS)) {
    const source = expected.sourceArticles[section] ?? 0;
    const declared = measured.articleCounts[counter];
    if (!withinWarnBand(declared, source)) continue;
    warnings.push(
      `manifest.counts.${counter}: ${declared}/${source} corpi sorgente ` +
        `(${(100 * (declared / source)).toFixed(1)}%) — sopra il pavimento ma dentro la banda di ` +
        `margine. I due lati contano cose diverse e il rapporto deriva in modo monotono: ` +
        `un corpo senza voce di registro (orfano, ritiro a meta', import parziale) lo abbassa ` +
        `e basta. Riconcilia corpi e registro prima che il gate blocchi una pubblicazione sana.`,
    );
  }
  return warnings;
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
    .map(({ name, xml }) => ({ name, items: countTags(xml, 'item') }));

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
  // `RSS_SECTIONS` porta con se' i propri `seoFiles`: la lista dei chunk NON
  // viene ricopiata qui, o il pavimento tornerebbe a misurare una popolazione
  // che nessuno garantisce sia quella letta dal generatore dei feed.
  const { RSS_MAX_ITEMS, RSS_SECTIONS } = await import(
    pathToFileURL(path.join(root, 'engine', 'rssFeeds.mjs')).href
  );
  const seoEntries = {};
  for (const section of RSS_SECTIONS) seoEntries[section.id] = countSeoEntries(root, section.seoFiles);
  return {
    sourceArticles: {
      frontaliere: countSourceArticles(root, 'frontaliere'),
      svizzera: countSourceArticles(root, 'svizzera'),
    },
    seoEntries,
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
      `${expected.sourceArticles.svizzera} svizzera, ${expected.sourceImages} immagini, ` +
      `voci SEO ${expected.seoEntries.frontaliere}/${expected.seoEntries.svizzera}`,
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
  for (const w of retentionWarnings(measured, expected)) console.log(`::warning::${w}`);
  console.log(`[api-floors] pavimenti derivati dal corpus: tutti retti (${measured.feeds.length} feed inclusi)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
