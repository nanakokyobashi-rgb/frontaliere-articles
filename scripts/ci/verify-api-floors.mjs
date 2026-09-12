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
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RSS_LOCALES, RSS_MAX_ITEMS, RSS_SECTIONS } from '../../engine/rssFeeds.mjs';
import {
  floorFrom,
  retentionLine,
  retentionWarning,
  populationWarning,
  retentionRatio,
  FLOOR_RETENTION,
  FLOOR_WARN_RETENTION,
  countSourceArticles,
  countSourceImages,
  missingCorpusMessage,
  countSeoEntries,
  collectSeoEntryIds,
  latestSeoPublication,
  SECTION_BODY_DIRS,
  SEO_CHUNK_DIR,
  IMAGE_SOURCE_DIR,
} from '../lib/corpus-floors.mjs';
// Stessa funzione del writer e del gate manifest.counts in build-api.mjs: un
// `<item>` citato dentro un CDATA non e' un elemento del feed, e contarlo qui
// alzerebbe la misura sopra il pavimento mascherando un feed troncato.
import { countXmlTags } from '../lib/count-xml-tags.mjs';
import { stripNonMarkup } from '../lib/count-xml-tags.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Le due sezioni, col contatore del manifest che ciascuna alimenta. */
export const SECTION_COUNTERS = {
  frontaliere: 'articles',
  svizzera: 'swissArticles',
};

/** La popolazione dei chunk ha un preallarme proprio: 90% di una run precedente.
 * Il 97% della retention degli articoli sarebbe rumore permanente per il
 * rapporto chunk/corrente, mentre il 90% segnala una contrazione sostanziale. */
export const FEED_POPULATION_WARN_RETENTION = 0.9;

/** La massima anzianità ammessa dell'ultimo item rispetto al corpus SEO. */
export const FEED_FRESHNESS_MAX_LAG_HOURS = 72;
const FEED_FRESHNESS_MAX_LAG_MS = FEED_FRESHNESS_MAX_LAG_HOURS * 60 * 60 * 1000;

/**
 * A quale sezione appartiene un feed, dal nome del file.
 *
 * Il nome viene risolto dalla stessa `RSS_SECTIONS` che genera i feed. Un nome
 * sconosciuto non viene assegnato per default a frontaliere: e' un errore di
 * censimento che il gate deve rendere visibile.
 */
function feedNames(section) {
  const names = new Set([section.mainFeed]);
  if (typeof section.feedFile === 'function') {
    for (const locale of RSS_LOCALES) names.add(section.feedFile(locale));
  }
  return names;
}

/** I nomi di tutti i feed che la tabella RSS promette di pubblicare. */
export function expectedFeedNames(sections = RSS_SECTIONS) {
  return [...new Set(sections.flatMap((section) => [...feedNames(section)]))];
}

export function feedSection(fileName, sections = RSS_SECTIONS) {
  return sections.find((section) => feedNames(section).has(fileName))?.id ?? null;
}

const ZERO_REVISION_RE = /^0+$/;

export function previousRevision(root, configuredRevision = process.env.API_FLOOR_BASE_REVISION) {
  const configured = String(configuredRevision || '').trim();
  if (configured) return ZERO_REVISION_RE.test(configured) ? null : configured;

  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD^'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

function assertGitRevision(root, revision) {
  try {
    execFileSync('git', ['-C', root, 'cat-file', '-e', `${revision}^{commit}`], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch (error) {
    throw new Error(`revisione storica ${revision} non disponibile nel checkout`, { cause: error });
  }
}

/** Legge un path a una revisione distinguendo file assente da errore git. */
function readGitFileAtRevision(root, revision, rel) {
  let listing;
  try {
    listing = execFileSync('git', ['-C', root, 'ls-tree', '-r', '--name-only', revision, '--', rel], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    throw new Error(`impossibile elencare ${rel} alla revisione ${revision}`, { cause: error });
  }
  if (!listing.split('\n').some((entry) => entry === rel)) return null;

  try {
    return execFileSync('git', ['-C', root, 'show', `${revision}:${rel}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`impossibile leggere ${rel} alla revisione ${revision}`, { cause: error });
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseStringArray(source) {
  return [...source.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

/** Recupera dalla storia la lista di chunk propria della sezione. */
function historicalSeoFilesAtRevision(root, revision, sectionId) {
  assertGitRevision(root, revision);
  const source = readGitFileAtRevision(root, revision, 'engine/rssFeeds.mjs');
  if (source === null) return [];

  const section = new RegExp(
    `\\bid:\\s*['"]${escapeRegExp(sectionId)}['"][\\s\\S]*?\\bseoFiles:\\s*([A-Za-z_$][\\w$]*|\\[[\\s\\S]*?\\])`,
  ).exec(source)?.[1];
  if (!section) return [];
  if (section.startsWith('[')) return parseStringArray(section);

  const declaration = new RegExp(
    `(?:const|let|var)\\s+${escapeRegExp(section)}\\s*=\\s*(\\[[\\s\\S]*?\\])`,
  ).exec(source)?.[1];
  return declaration ? parseStringArray(declaration) : [];
}

function countSeoEntriesAtRevision(root, revision, seoFiles) {
  assertGitRevision(root, revision);
  const ids = new Set();
  for (const file of seoFiles) {
    const rel = path.posix.join(SEO_CHUNK_DIR.split(path.sep).join('/'), file);
    const source = readGitFileAtRevision(root, revision, rel);
    // Un chunk aggiunto dopo la revisione storica non aveva popolazione allora.
    if (source === null) continue;
    collectSeoEntryIds(source, ids);
  }
  return ids.size;
}

/** Current population, plus a historical floor that cannot shrink with it. */
export function feedSourceFloor(expected, section) {
  const current = expected.feedSources?.[section] ?? 0;
  if (current <= 0) return 0;
  const previous = expected.previousFeedSources?.[section];
  return Number.isFinite(previous) ? Math.max(current, previous) : current;
}

function feedPopulationReference(expected, section) {
  const current = expected.feedSources?.[section] ?? 0;
  const previous = expected.previousFeedSources?.[section];
  return Number.isFinite(previous) ? previous : current;
}

/**
 * Il nucleo puro: date le misure, quali pavimenti sono sfondati.
 *
 * @param {{articleCounts: Record<string, number>, feeds: {name: string, items: number, latestPublication?: {datePublished: string, timestamp: number}|null}[],
 *          missingFeeds?: string[], images: number|null, imageErrors?: string[]}} measured  cio' che l'artefatto dichiara
 * @param {{sourceArticles: Record<string, number>, feedSources: Record<string, number>,
 *          previousFeedSources?: Record<string, number|null>, sourceImages: number|null,
 *          latestSeoPublications?: Record<string, {articleId: string, datePublished: string, timestamp: number}|null>,
 *          rssMaxItems: number}} expected   cio' che il corpus
 *          sorgente promette: `sourceArticles` sono i file di corpo (il riferimento di
 *          `manifest.counts`), `feedSources` le voci dei chunk SEO (quello dei feed)
 * @returns {string[]} una riga per violazione, vuoto se tutto regge
 */
export function floorViolations(measured, expected, retention = undefined) {
  const violations = [...(measured.imageErrors ?? [])];
  const floor = (n) => floorFrom(n, retention);

  for (const feedName of measured.missingFeeds ?? []) {
    violations.push(`${feedName}: feed RSS atteso da RSS_SECTIONS assente o non è un documento RSS`);
  }

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
    if (section === null) {
      violations.push(`${feed.name}: nessuna sezione RSS_SECTIONS corrispondente — feed non mappato`);
      continue;
    }
    const current = expected.feedSources?.[section] ?? 0;
    // Stessa regola dei corpi, un riferimento diverso: zero voci nei chunk non
    // e' «feed legittimamente vuoto», e' la lista dei chunk che non risolve —
    // il modo esatto in cui un feed e' gia' rimasto fermo tre mesi. Una riga
    // per sezione, non una per feed: i cinque feed di una sezione condividono
    // il riferimento, e ripeterlo cinque volte non aggiunge niente.
    if (current === 0) {
      if (!missingSeo.has(section)) {
        missingSeo.add(section);
        violations.push(
          missingCorpusMessage(`i feed di ${section}`, `${SEO_CHUNK_DIR} (chunk di ${section})`),
        );
      }
      continue;
    }
    const source = feedSourceFloor(expected, section);
    const min = floor(Math.min(expected.rssMaxItems, source));
    if (feed.items < min) {
      violations.push(
        `${feed.name}: ${feed.items} <item> contro ${min} attesi ` +
          `(${current} voci nei chunk SEO di ${section}; riferimento storico/floor ${source}) — feed troncato`,
      );
    }

    if (expected.latestSeoPublications) {
      const sourcePublication = expected.latestSeoPublications[section];
      if (!sourcePublication) {
        violations.push(`${feed.name}: nessuna datePublished valida nei chunk SEO di ${section}`);
      } else if (!feed.latestPublication) {
        violations.push(`${feed.name}: nessun <pubDate> valido nell'artefatto RSS`);
      } else {
        const lagMs = sourcePublication.timestamp - feed.latestPublication.timestamp;
        if (lagMs > FEED_FRESHNESS_MAX_LAG_MS) {
          const lagHours = (lagMs / (60 * 60 * 1000)).toFixed(1);
          violations.push(
            `${feed.name}: ultima <pubDate> ${feed.latestPublication.datePublished} è ${lagHours}h ` +
              `più vecchia dell'ultima datePublished ${sourcePublication.datePublished} nei chunk SEO di ` +
              `${section} (soglia ${FEED_FRESHNESS_MAX_LAG_HOURS}h) — feed stantio`,
          );
        }
      }
    }
  }

  // `null` in `expected` e' riservato ai fixture senza superficie immagini.
  // Nel checkout reale `countSourceImages` restituisce sempre un numero: zero
  // significa directory assente/vuota e quindi riferimento mancante, mentre
  // un manifest assente con immagini attese e' una violazione esplicita.
  if (expected.sourceImages !== null) {
    if (expected.sourceImages === 0) {
      violations.push(missingCorpusMessage('images-manifest.json', IMAGE_SOURCE_DIR));
    } else if (measured.imageErrors?.length) {
      // The shape error is already a precise violation; do not add the less
      // useful "manifest assente" wording on top of it.
    } else if (measured.images === null) {
      violations.push(
        `images-manifest.json assente: il corpus sorgente ne tiene ${expected.sourceImages} immagini in ${IMAGE_SOURCE_DIR}`,
      );
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

  // Il feed e' capato a RSS_MAX_ITEMS, ma la sua popolazione sorgente non lo
  // e'. Confrontare i chunk con la popolazione della run precedente rende
  // visibile un'erosione da 3750 a 60 voci, che il rapporto del feed (50/50)
  // non puo' osservare e che il rapporto chunk/corpi misurava sul denominatore
  // sbagliato.
  for (const section of Object.keys(SECTION_COUNTERS)) {
    const declared = expected.feedSources?.[section] ?? 0;
    const source = feedPopulationReference(expected, section);
    if (source <= 0 || declared <= 0) continue;
    rows.push({ kind: 'feed-population', label: `chunk SEO ${section}/run precedente`, declared, source });
  }

  for (const feed of measured.feeds) {
    const section = feedSection(feed.name);
    if (section === null) continue;
    const source = feedSourceFloor(expected, section);
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
 * `FLOOR_WARN_RETENTION`. I rapporti agganciati a un pavimento restano
 * limitati alla fascia sopra il gate; la popolazione dei chunk SEO e' invece
 * diagnostica e puo' essere gia' sotto il gate senza cambiare il verdetto.
 *
 * Advisory per costruzione — il chiamante le emette come `::warning::` e ESCE
 * COMUNQUE 0. Spostare il verdetto qui significherebbe aver alzato il gate da
 * 0,90 a 0,97 di soppiatto (AGENTS.md #1), che e' l'opposto di cio' che questo
 * livello serve a fare.
 */
export function retentionAdvisories(rows, retention = FLOOR_RETENTION, warn = FLOOR_WARN_RETENTION) {
  return rows
    .map((r) =>
      r.kind === 'feed-population'
        ? populationWarning(r.label, r.declared, r.source, FEED_POPULATION_WARN_RETENTION)
        : retentionWarning(r.label, r.declared, r.source, retention, warn),
    )
    .filter((line) => line !== null);
}

/**
 * Le righe da stampare a ogni run: i due rapporti del manifest, le popolazioni
 * dei chunk SEO, quello delle immagini, e — per i feed — il PIU' MAGRO della
 * sezione.
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

function latestFeedPublication(xml) {
  const markup = stripNonMarkup(xml);
  const items = [...markup.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g)];
  // Un latest valido non basta: ogni item che il floor conta deve avere
  // esattamente una data parseabile, altrimenti la superficie pubblicata e'
  // parzialmente corrotta anche se un altro item e' fresco.
  if (items.length !== countXmlTags(markup, 'item')) return null;

  let latest = null;
  for (const [, item] of items) {
    const dates = [...item.matchAll(/<pubDate(?:\s[^>]*)?>\s*([^<]*?)\s*<\/pubDate>/g)];
    if (dates.length !== 1) return null;
    const datePublished = dates[0][1].trim();
    const timestamp = Date.parse(datePublished);
    if (!Number.isFinite(timestamp)) return null;
    if (!latest || timestamp > latest.timestamp) latest = { datePublished, timestamp };
  }
  return latest;
}

function isRssDocument(xml) {
  return countXmlTags(xml, 'rss') > 0;
}

/** Legge dall'artefatto su disco le misure che il nucleo puro confronta. */
export function measureDist(distDir) {
  const readOut = (name) => fs.readFileSync(path.join(distDir, name), 'utf-8');
  const manifest = JSON.parse(readOut('manifest.json'));

  // I feed si riconoscono dal DOCUMENTO, non dal nome: i nomi attesi sono
  // comunque derivati dalla tabella del producer, così un file atteso assente
  // o non-RSS non sparisce semplicemente dalla lista delle misure.
  const feeds = fs
    .readdirSync(distDir)
    .filter((f) => f.endsWith('.xml'))
    .map((name) => ({ name, xml: readOut(name) }))
    .filter(({ xml }) => isRssDocument(xml))
    .map(({ name, xml }) => ({
      name,
      items: countXmlTags(xml, 'item'),
      latestPublication: latestFeedPublication(xml),
    }));
  const presentFeedNames = new Set(feeds.map(({ name }) => name));
  const missingFeeds = expectedFeedNames().filter((name) => !presentFeedNames.has(name));

  const imageManifest = path.join(distDir, 'images-manifest.json');
  let images = null;
  const imageErrors = [];
  if (fs.existsSync(imageManifest)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(imageManifest, 'utf-8'));
      if (!Array.isArray(parsed?.images)) {
        imageErrors.push('images-manifest.json: campo "images" assente o non è un array');
      } else {
        images = parsed.images.length;
      }
    } catch (error) {
      imageErrors.push(`images-manifest.json: JSON non leggibile (${error.message})`);
    }
  }

  return { articleCounts: manifest.counts ?? {}, feeds, missingFeeds, images, imageErrors };
}

/** Riconta il corpus sorgente, che e' il riferimento esterno all'artefatto. */
export async function expectFromCorpus(root) {
  // Importati, non ricopiati: `RSS_MAX_ITEMS` e la lista dei chunk di ogni
  // sezione hanno una sorgente sola, ed e' quella che genera davvero i feed.
  // Una seconda lista qui sarebbe il difetto che ha congelato rss.xml per tre
  // mesi, spostato di un file (AGENTS.md #6).
  const feedSources = {};
  const previousFeedSources = {};
  const latestSeoPublications = {};
  const revision = previousRevision(root);
  for (const section of RSS_SECTIONS) {
    feedSources[section.id] = countSeoEntries(root, section.seoFiles);
    latestSeoPublications[section.id] = latestSeoPublication(root, section.seoFiles);
    if (revision === null) {
      previousFeedSources[section.id] = null;
      continue;
    }
    const previousSeoFiles = historicalSeoFilesAtRevision(root, revision, section.id);
    const historicalPopulationFiles = [...new Set([...section.seoFiles, ...previousSeoFiles])];
    previousFeedSources[section.id] = countSeoEntriesAtRevision(root, revision, historicalPopulationFiles);
  }
  return {
    sourceArticles: {
      frontaliere: countSourceArticles(root, 'frontaliere'),
      svizzera: countSourceArticles(root, 'svizzera'),
    },
    feedSources,
    previousFeedSources,
    latestSeoPublications,
    sourceImages: countSourceImages(root),
    rssMaxItems: RSS_MAX_ITEMS,
  };
}

async function main() {
  const distIdx = process.argv.indexOf('--dist');
  const distDir = distIdx >= 0 ? path.resolve(process.argv[distIdx + 1]) : path.join(ROOT, 'dist', 'api');

  let measured;
  let expected;
  try {
    measured = measureDist(distDir);
    expected = await expectFromCorpus(ROOT);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error::[api-floors] ${message}`);
    process.exitCode = 1;
    return;
  }
  const violations = floorViolations(measured, expected);

  console.log(
    `[api-floors] corpus sorgente: ${expected.sourceArticles.frontaliere} frontaliere, ` +
      `${expected.sourceArticles.svizzera} svizzera, ${expected.sourceImages} immagini`,
  );
  console.log(
    `[api-floors] chunk SEO (la popolazione che genera i feed): ` +
      `${expected.feedSources.frontaliere} frontaliere, ${expected.feedSources.svizzera} svizzera; ` +
      `run precedente: ${expected.previousFeedSources?.frontaliere ?? 'non disponibile'} frontaliere, ` +
      `${expected.previousFeedSources?.svizzera ?? 'non disponibile'} svizzera`,
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

  // Anche gli advisory vengono emessi prima del verdetto: una violazione su un
  // pavimento non deve cancellare il margine degli altri rapporti dalla run.
  const advisories = retentionAdvisories(rows);
  for (const a of advisories) console.warn(`::warning::[api-floors] ${a}`);
  if (advisories.length) {
    console.log(
      `[api-floors] ${advisories.length} rapporto/i sotto il preallarme ` +
        `${(FLOOR_WARN_RETENTION * 100).toFixed(0)}%: advisory diagnostici; il gate ` +
        `${(FLOOR_RETENTION * 100).toFixed(0)}% resta separato`,
    );
  }

  if (violations.length) {
    for (const v of violations) console.error(`::error::${v}`);
    process.exit(1);
  }
  console.log(`[api-floors] pavimenti derivati dal corpus: tutti retti (${measured.feeds.length} feed inclusi)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
