/**
 * canton-hub-data.mjs — i DATI degli hub tematici di una sezione cantonale,
 * letti dal publisher (scripts/publish-section-pages.mjs) e dal registro
 * (scripts/lib/section-registry.mjs).
 *
 * Il contenuto degli hub NON nasce qui: lo scrive il producer degli hub (P10
 * del piano «sezioni articoli per cantone», nel generatore) in un file
 * committato per (sezione, tema), con le quattro locali. Questo modulo e' il solo posto che sa DOVE sta quel file e che forma
 * ha: se il producer sposta il path, cambia `cantonHubDataFile` e nient'altro.
 *
 * Forma del file (`content/cantons/<sezione>/hubs/<tema>.json`), prodotta da
 * `generator/scripts/generate-canton-hubs.mjs` (P10):
 *
 *   { schemaVersion: 1, id: "canton-ti:fisco", section, canton, topic,
 *     updatedAt, contentHash, blocks: [],
 *     locales: { it: { canton, topic, locale, intro, keyFacts,
 *       dataBlocks, curatedArticles, links, updatedAt }, … } }
 *
 * La forma e' validata qui, al confine fra producer e publisher. Ogni voce di
 * locale e' l'input di `renderCantonTopicHub` (engine/cantonSectionPages.ts).
 *
 * Nessun hub e' mai `noindex` (decisione del proprietario, 2026-10-05). Un hub
 * senza file semplicemente non viene pubblicato, e una sezione a cui manca un
 * hub non puo' essere `live` (la sua landing li linka tutti e sei): resta
 * `draft` finche' il producer non li ha scritti.
 *
 * Solo builtin Node (regola di `scripts/lib/**`).
 */
import fs from 'node:fs';
import path from 'node:path';

import { ARTICLE_SECTION_CORE_ALL } from '../../engine/shared/articleSectionCore.mjs';
import { CANTON_HUB_MIN_CONTENT_WORDS, countCantonHubContentWords } from './canton-hub-content.mjs';
import { hubFilePath } from '../../generator/scripts/lib/canton-hubs/paths.mjs';

export const CANTON_HUB_LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);
export const CANTON_HUB_SCHEMA_VERSION = 1;

/** Path (relativo alla radice del repo) del file dati di un hub. UNICA sorgente. */
export function cantonHubDataFile(section, topic) {
  return hubFilePath(section, topic);
}

/** I temi hub di una sezione cantonale, nell'ordine del core. */
export function cantonHubTopics(section) {
  const hubs = ARTICLE_SECTION_CORE_ALL[section]?.topicHubs;
  if (!hubs) throw new Error(`cantonHubTopics: "${section}" non ha hub tematici nel core`);
  return Object.keys(hubs);
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function isIsoDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validateHubDocument(doc, section, topic, rel) {
  const expectedCanton = ARTICLE_SECTION_CORE_ALL[section]?.canton;
  if (!isPlainObject(doc)) throw new Error(`${rel}: atteso un documento oggetto P10`);
  if (doc.schemaVersion !== CANTON_HUB_SCHEMA_VERSION) throw new Error(`${rel}: schemaVersion ${doc.schemaVersion ?? 'assente'} (attesa ${CANTON_HUB_SCHEMA_VERSION})`);
  if (doc.id !== `${section}:${topic}`) throw new Error(`${rel}: id ${JSON.stringify(doc.id)} diverso da ${section}:${topic}`);
  if (doc.section !== section) throw new Error(`${rel}: section ${JSON.stringify(doc.section)} diverso da ${section}`);
  if (doc.canton !== expectedCanton) throw new Error(`${rel}: canton ${JSON.stringify(doc.canton)} diverso da ${JSON.stringify(expectedCanton)}`);
  if (doc.topic !== topic) throw new Error(`${rel}: topic ${JSON.stringify(doc.topic)} diverso da ${topic}`);
  if (!isIsoDate(doc.updatedAt)) throw new Error(`${rel}: updatedAt non e' una data ISO valida`);
  if (typeof doc.contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(doc.contentHash)) throw new Error(`${rel}: contentHash non e' uno SHA-256 esadecimale`);
  if (!Array.isArray(doc.blocks)) throw new Error(`${rel}: blocks deve essere un array`);
  if (!isPlainObject(doc.locales)) throw new Error(`${rel}: manca l'oggetto locales`);
  const actualLocales = Object.keys(doc.locales).sort().join(',');
  const expectedLocales = [...CANTON_HUB_LOCALES].sort().join(',');
  if (actualLocales !== expectedLocales) throw new Error(`${rel}: locali ${actualLocales || 'assenti'} diverse da ${expectedLocales}`);
  for (const locale of CANTON_HUB_LOCALES) {
    const entry = doc.locales[locale];
    if (!isPlainObject(entry)) throw new Error(`${rel}: locale "${locale}" mancante`);
    if (entry.canton !== expectedCanton) throw new Error(`${rel}: canton della locale "${locale}" non valido`);
    if (entry.topic !== topic) throw new Error(`${rel}: topic della locale "${locale}" non valido`);
    if (entry.locale !== locale) throw new Error(`${rel}: codice della locale "${locale}" non valido`);
    if (typeof entry.intro !== 'string' || entry.intro.trim() === '') throw new Error(`${rel}: intro "${locale}" vuota`);
    for (const field of ['keyFacts', 'dataBlocks', 'curatedArticles', 'links']) {
      if (!Array.isArray(entry[field])) throw new Error(`${rel}: ${field} della locale "${locale}" deve essere un array`);
    }
    const contentWords = countCantonHubContentWords(entry);
    if (contentWords < CANTON_HUB_MIN_CONTENT_WORDS) {
      throw new Error(`${rel}: contenuto insufficiente nella locale "${locale}" (${contentWords} parole < ${CANTON_HUB_MIN_CONTENT_WORDS})`);
    }
    if (!isIsoDate(entry.updatedAt)) throw new Error(`${rel}: updatedAt della locale "${locale}" non e' valida`);
  }
  return doc.locales;
}

/**
 * I dati di un hub per le quattro locali, o `null` se il file non esiste.
 * Un file presente ma malformato (JSON illeggibile, metadata/schema P10,
 * locale mancante o intro vuota) LANCIA: un hub pubblicato in tre lingue su
 * quattro avrebbe hreflang verso una pagina che non c'e'.
 *
 * @returns {Record<string, Record<string, unknown>> | null}
 */
export function readCantonHubData(root, section, topic) {
  if (!cantonHubTopics(section).includes(topic)) throw new Error(`readCantonHubData: tema "${topic}" sconosciuto per ${section}`);
  const rel = cantonHubDataFile(section, topic);
  let raw;
  try {
    raw = fs.readFileSync(path.join(root, rel), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${rel}: JSON illeggibile (${error.message})`, { cause: error });
  }
  return validateHubDocument(doc, section, topic, rel);
}

/**
 * Quali hub di una sezione hanno il file dati (validato) e quali no.
 * @returns {{ present: string[], missing: string[] }}
 */
export function cantonHubCoverage(root, section) {
  const present = [];
  const missing = [];
  for (const topic of cantonHubTopics(section)) (readCantonHubData(root, section, topic) ? present : missing).push(topic);
  return { present, missing };
}
