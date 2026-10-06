/**
 * build.mjs — costruisce il FILE DATI di un hub tematico cantonale (D17).
 *
 * Un file per (sezione, tema): `content/cantons/<sezione>/hubs/<tema>.json`,
 * con le 4 locali. Ogni `locales[<loc>]` e' ESATTAMENTE un
 * `CantonTopicHubInput` di `engine/cantonSectionPages.ts`
 * (`{ canton, topic, locale, intro, keyFacts, dataBlocks, curatedArticles,
 * links, updatedAt }`): il publisher (P7b) lo passa a `renderCantonTopicHub`
 * senza trasformarlo. Nessun campo `indexable`/`noindex`: gli hub cantonali
 * sono sempre indicizzabili (D2/D17, decisions.md), anche senza blocchi.
 *
 * Stabilita'. L'id e' `<sezione>:<tema>` e non cambia mai. `updatedAt` cambia
 * solo se cambia il CONTENUTO: l'impronta (`contentHash`) si calcola senza i
 * timestamp, e a impronta uguale si restituisce il file precedente tale e
 * quale — seconda esecuzione, nessun diff.
 *
 * Puro: nessun I/O, l'orologio arriva come `nowMs`.
 */
import { createHash } from 'node:crypto';
import { ARTICLE_SECTION_CORE_ALL } from '../../../../engine/shared/articleSectionCore.mjs';
import { CANTON_HUB_TOPIC_KEYS } from '../../../../engine/shared/cantonArticleSectionCore.generated.mjs';
import { CANTON_HUB_MIN_CONTENT_WORDS, countCantonHubContentWords, countCantonHubIntroWords } from '../../../../scripts/lib/canton-hub-content.mjs';
import { BLOCK_THRESHOLDS, DAY_MS, dateMs, instantMs } from './blocks-common.mjs';
import { shapeFuelBlock } from './blocks-fuel.mjs';
import { shapeEventsBlock } from './blocks-events.mjs';
import { shapeBorderWaitBlock } from './blocks-border-wait.mjs';
import { shapeRoadEventsBlock } from './blocks-road-events.mjs';
import { shapeNoticesBlock } from './blocks-notices.mjs';
import { shapePharmacyDutiesBlock, shapePlateAuctionsBlock, shapePremiumsBlock, shapeWeatherBlock } from './blocks-services.mjs';
import { shapeTaxBurdenBlock, shapeWithholdingBlock } from './blocks-tax.mjs';
import { shapeCapitalTaxBlock, shapePensionFederalBlock, shapePensionFundsBlock } from './blocks-pensions.mjs';
import { buildHubIntro, foreignToponymsInCopy } from './copy.mjs';
import { curatedEntry } from './articles.mjs';
import { buildHubLinks } from './links.mjs';
import { HUB_LOCALES } from './format.mjs';
import { hubFilePath, hubFilePaths } from './paths.mjs';

export const HUB_SCHEMA_VERSION = 1;

/**
 * Alias storico del valore condiviso con il renderer e il validatore del
 * publisher. Il modulo comune e' plain ESM, quindi non serve piu' mantenere
 * tre numeri sincronizzati a mano.
 */
export const HUB_MIN_CONTENT_WORDS = CANTON_HUB_MIN_CONTENT_WORDS;

/** Dataset annuali: per quanto si conserva un blocco se la cache manca in un run. */
const ANNUAL_CARRY_MS = 30 * DAY_MS;

/**
 * I blocchi di ogni tema, nell'ordine in cui compaiono in pagina. `dataset` e'
 * la chiave dell'oggetto `datasets`; `carryMs` e' l'eta' massima entro cui un
 * blocco gia' pubblicato sopravvive a un run in cui la sua cache MANCA (fetch
 * fallito): senza, un 404 passeggero toglierebbe il blocco oggi e lo
 * rimetterebbe domani, due commit e due `updatedAt` per nessun cambiamento.
 */
export const TOPIC_BLOCKS = Object.freeze({
  carburanti: [
    { dataset: 'fuel', shape: shapeFuelBlock, carryMs: BLOCK_THRESHOLDS.fuel.maxAgeMs },
    { dataset: 'notices', shape: shapeNoticesBlock, carryMs: BLOCK_THRESHOLDS.notices.maxAgeMs },
  ],
  fisco: [
    { dataset: 'tax', shape: shapeTaxBurdenBlock, carryMs: ANNUAL_CARRY_MS },
    { dataset: 'tax', shape: shapeWithholdingBlock, carryMs: ANNUAL_CARRY_MS },
    { dataset: 'notices', shape: shapeNoticesBlock, carryMs: BLOCK_THRESHOLDS.notices.maxAgeMs },
  ],
  mobilita: [
    { dataset: 'borderWait', shape: shapeBorderWaitBlock, carryMs: BLOCK_THRESHOLDS.borderWait.maxAgeMs },
    { dataset: 'roadEvents', shape: shapeRoadEventsBlock, carryMs: BLOCK_THRESHOLDS.roadEvents.maxAgeMs },
    { dataset: 'notices', shape: shapeNoticesBlock, carryMs: BLOCK_THRESHOLDS.notices.maxAgeMs },
  ],
  eventi: [
    { dataset: 'events', shape: shapeEventsBlock, carryMs: BLOCK_THRESHOLDS.events.maxAgeMs },
    { dataset: 'notices', shape: shapeNoticesBlock, carryMs: BLOCK_THRESHOLDS.notices.maxAgeMs },
  ],
  pensioni: [
    { dataset: 'pensions', shape: shapePensionFederalBlock, carryMs: ANNUAL_CARRY_MS },
    { dataset: 'pensions', shape: shapePensionFundsBlock, carryMs: ANNUAL_CARRY_MS },
    { dataset: 'pensions', shape: shapeCapitalTaxBlock, carryMs: ANNUAL_CARRY_MS },
    { dataset: 'notices', shape: shapeNoticesBlock, carryMs: BLOCK_THRESHOLDS.notices.maxAgeMs },
  ],
  servizi: [
    { dataset: 'services', shape: shapePremiumsBlock, carryMs: BLOCK_THRESHOLDS.services.maxAgeMs },
    { dataset: 'services', shape: shapePharmacyDutiesBlock, carryMs: BLOCK_THRESHOLDS.services.maxAgeMs },
    { dataset: 'services', shape: shapePlateAuctionsBlock, carryMs: BLOCK_THRESHOLDS.services.maxAgeMs },
    { dataset: 'services', shape: shapeWeatherBlock, carryMs: BLOCK_THRESHOLDS.services.maxAgeMs },
    { dataset: 'notices', shape: shapeNoticesBlock, carryMs: BLOCK_THRESHOLDS.notices.maxAgeMs },
  ],
});

/** Le chiavi di `datasets` che `buildHubFile` conosce. */
export const DATASET_KEYS = Object.freeze(['fuel', 'events', 'borderWait', 'roadEvents', 'notices', 'services', 'tax', 'pensions']);

export { hubFilePath, hubFilePaths };

function checkHref(url, what) {
  const value = String(url ?? '').trim();
  if (/^https:\/\/[^\s"<>]+$/.test(value)) return;
  if (/^\/(?!\/)[^\s"<>]*$/.test(value)) {
    if (!value.split(/[?#]/)[0].endsWith('/')) throw new Error(`${what}: link interno senza slash finale: ${value}`);
    return;
  }
  throw new Error(`${what}: URL non ammesso: ${JSON.stringify(value)}`);
}

/** Piu' severo di `requireDate` del renderer, che si fida di `Date.parse`: qui il giorno deve esistere. */
function checkDate(value, what) {
  if (!Number.isFinite(dateMs(value))) throw new Error(`${what}: data non valida: ${JSON.stringify(value)}`);
}

function checkKeys(obj, allowed, what) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new Error(`${what}: campo non previsto dal renderer: "${key}"`);
  }
}

const text = (v, what) => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${what}: testo mancante`);
};

/**
 * Le stesse regole con cui `renderCantonTopicHub` rifiuta un input, piu' tre
 * che il renderer NON applica e che qui diventano errori invece di sparizioni
 * silenziose: nessun campo fuori dalla firma (quindi nessun `indexable`,
 * `noindex`, `image`, `limit`), una `sourceUrl` senza `sourceName` (il
 * renderer la scarterebbe senza dirlo) e stringhe vuote dove serve un testo.
 * Un file che passa di qui passa dal renderer.
 */
export function validateHubInput(input) {
  const at = `hub ${input?.canton}/${input?.topic}/${input?.locale}`;
  checkKeys(input, ['canton', 'topic', 'locale', 'intro', 'keyFacts', 'dataBlocks', 'curatedArticles', 'links', 'updatedAt'], at);
  if (!HUB_LOCALES.includes(input.locale)) throw new Error(`${at}: locale non supportata`);
  if (!CANTON_HUB_TOPIC_KEYS.includes(input.topic)) throw new Error(`${at}: tema sconosciuto`);
  if (!Object.values(ARTICLE_SECTION_CORE_ALL).some((c) => c.kind === 'canton' && c.canton === input.canton)) throw new Error(`${at}: codice cantone non valido`);
  checkDate(input.updatedAt, `${at}: updatedAt`);
  const paragraphs = String(input.intro ?? '').split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (paragraphs.length === 0) throw new Error(`${at}: intro evergreen mancante`);
  for (const list of ['keyFacts', 'dataBlocks', 'curatedArticles', 'links']) {
    if (!Array.isArray(input[list])) throw new Error(`${at}: ${list} non e' una lista`);
  }

  const withSource = (o, what) => {
    if (o.sourceUrl !== undefined) {
      checkHref(o.sourceUrl, `${what}.sourceUrl`);
      if (typeof o.sourceName !== 'string' || !o.sourceName.trim()) throw new Error(`${what}: sourceUrl senza sourceName (il renderer la scarterebbe)`);
    }
    if (o.sourceName !== undefined) text(o.sourceName, `${what}.sourceName`);
  };
  input.keyFacts.forEach((f, i) => {
    const what = `${at}: keyFacts[${i}]`;
    checkKeys(f, ['label', 'value', 'note', 'sourceName', 'sourceUrl'], what);
    text(f.label, `${what}.label`);
    text(f.value, `${what}.value`);
    if (f.note !== undefined) text(f.note, `${what}.note`);
    withSource(f, what);
  });
  const blockIds = new Set();
  input.dataBlocks.forEach((b) => {
    const what = `${at}: dataBlocks.${b?.id}`;
    checkKeys(b, ['id', 'title', 'description', 'items', 'sourceName', 'sourceUrl', 'updatedAt'], what);
    if (typeof b.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(b.id)) throw new Error(`${at}: dataBlocks: id non valido ${JSON.stringify(b.id)}`);
    if (blockIds.has(b.id)) throw new Error(`${what}: id duplicato`);
    blockIds.add(b.id);
    text(b.title, `${what}.title`);
    if (b.description !== undefined) text(b.description, `${what}.description`);
    if (b.updatedAt !== undefined) checkDate(b.updatedAt, `${what}.updatedAt`);
    withSource(b, what);
    if (!Array.isArray(b.items) || b.items.length === 0) throw new Error(`${what}: blocco senza righe (un blocco vuoto si omette)`);
    b.items.forEach((it, i) => {
      const w = `${what}.items[${i}]`;
      checkKeys(it, ['label', 'value', 'detail', 'date', 'url'], w);
      text(it.label, `${w}.label`);
      if (it.value !== undefined) text(it.value, `${w}.value`);
      if (it.detail !== undefined) text(it.detail, `${w}.detail`);
      if (it.date !== undefined) checkDate(it.date, `${w}.date`);
      if (it.url !== undefined) checkHref(it.url, `${w}.url`);
    });
  });
  const urls = new Set();
  input.curatedArticles.forEach((a, i) => {
    const what = `${at}: curatedArticles[${i}]`;
    checkKeys(a, ['title', 'url', 'excerpt', 'date'], what);
    text(a.title, `${what}.title`);
    checkHref(a.url, `${what}.url`);
    if (urls.has(a.url)) throw new Error(`${what}: articolo duplicato ${a.url}`);
    urls.add(a.url);
    if (a.excerpt !== undefined) text(a.excerpt, `${what}.excerpt`);
    if (a.date !== undefined) checkDate(a.date, `${what}.date`);
  });
  const linkUrls = new Set();
  input.links.forEach((l, i) => {
    const what = `${at}: links[${i}]`;
    checkKeys(l, ['label', 'url', 'description'], what);
    text(l.label, `${what}.label`);
    checkHref(l.url, `${what}.url`);
    if (linkUrls.has(l.url)) throw new Error(`${what}: link duplicato ${l.url}`);
    linkUrls.add(l.url);
    if (l.description !== undefined) text(l.description, `${what}.description`);
  });

  const contentWords = countCantonHubContentWords(input);
  if (contentWords < HUB_MIN_CONTENT_WORDS) throw new Error(`${at}: contenuto insufficiente (${contentWords} parole < ${HUB_MIN_CONTENT_WORDS})`);
  // L'intro da sola deve reggere la pagina: e' cio' che resta quando mancano
  // tutti i dataset e non c'e' ancora una news.
  const introWords = countCantonHubIntroWords(input);
  if (introWords < HUB_MIN_CONTENT_WORDS) throw new Error(`${at}: intro evergreen di ${introWords} parole, sotto le ${HUB_MIN_CONTENT_WORDS} che reggono la pagina senza dati`);
  return input;
}

/** JSON canonico: chiavi ordinate, cosi' l'impronta non dipende dall'ordine di inserimento. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Copia senza i campi volatili (timestamp di aggiornamento e impronta). */
function withoutVolatile(value) {
  if (Array.isArray(value)) return value.map(withoutVolatile);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([k]) => k !== 'updatedAt' && k !== 'contentHash' && k !== 'carried')
      .map(([k, v]) => [k, withoutVolatile(v)]));
  }
  return value;
}

/** Impronta del contenuto di un file hub, indipendente da quando e' stato scritto. */
export function hubContentHash(file) {
  return createHash('sha256').update(canonical(withoutVolatile(file))).digest('hex');
}

/** Il file precedente e' di questo hub e leggibile? Altrimenti si riparte da zero. */
function usablePrevious(previous, id) {
  return previous && typeof previous === 'object' && previous.schemaVersion === HUB_SCHEMA_VERSION && previous.id === id
    && previous.locales && HUB_LOCALES.every((l) => Array.isArray(previous.locales[l]?.dataBlocks) && Array.isArray(previous.locales[l]?.keyFacts))
    && Array.isArray(previous.blocks)
    ? previous
    : null;
}

/** Blocco e fatti chiave gia' pubblicati di `blockId`, per locale, o null se non recuperabili. */
function carriedFromPrevious(previous, blockId, carryMs, nowMs) {
  const index = previous.blocks.findIndex((b) => b.id === blockId);
  if (index === -1) return null;
  const meta = previous.blocks[index];
  const at = instantMs(meta.updatedAt);
  if (!Number.isFinite(at) || nowMs - at > carryMs || nowMs - at < -DAY_MS) return null;
  const offset = previous.blocks.slice(0, index).reduce((n, b) => n + (Number.isInteger(b.keyFacts) ? b.keyFacts : 0), 0);
  const perLocale = {};
  for (const locale of HUB_LOCALES) {
    const block = previous.locales[locale].dataBlocks.find((b) => b.id === blockId);
    if (!block) return null;
    perLocale[locale] = { block, keyFacts: previous.locales[locale].keyFacts.slice(offset, offset + (meta.keyFacts || 0)) };
  }
  return { updatedAt: meta.updatedAt, perLocale };
}

/**
 * @param {object} args
 * @param {string} args.section id della sezione cantonale (`canton-ti`)
 * @param {string} args.topic uno dei 6 temi
 * @param {{ languages: string[], members: string[] }} args.profile voce di `canton-sections.json`
 * @param {Record<string, any>} args.datasets cache dei dataset per chiave (`DATASET_KEYS`); null/assente = cache mancante
 * @param {any[]} args.curated articoli promossi del tema (`selectCuratedArticles().byTopic[topic]`)
 * @param {any} args.config `canton-hub-topics.json`
 * @param {any} args.catalogue `canton-hub-links.json`
 * @param {any} args.cantonUrlSlugs `canton-url-slugs.json`
 * @param {Map<string, any>} [args.evergreenArticles]
 * @param {Map<string, string>} [args.crossingNames]
 * @param {any} [args.previous] contenuto attuale del file, se esiste
 * @param {number} args.nowMs
 * @returns {{ file: any, changed: boolean, blocks: Array<{ id: string, status: 'fresh' | 'carried' | 'omitted', code?: string, reason?: string }> }}
 */
export function buildHubFile({ section, topic, profile, datasets, curated, config, catalogue, cantonUrlSlugs, evergreenArticles, crossingNames, previous, nowMs }) {
  const core = ARTICLE_SECTION_CORE_ALL[section];
  if (core?.kind !== 'canton') throw new Error(`canton-hubs: "${section}" non e' una sezione cantonale`);
  const specs = TOPIC_BLOCKS[topic];
  if (!specs) throw new Error(`canton-hubs: tema sconosciuto "${topic}"`);
  const canton = core.canton;
  const members = Array.isArray(profile?.members) && profile.members.length ? profile.members : [canton];
  const id = `${section}:${topic}`;
  const prev = usablePrevious(previous, id);
  const neighbours = config.neighbours?.[canton];
  if (!Array.isArray(neighbours)) throw new Error(`canton-hubs: Paesi confinanti non dichiarati per ${canton} in canton-hub-topics.json`);

  const ctx = { canton, members, topic, nowMs, crossingNames };
  const report = [];
  const resolved = [];
  for (const spec of specs) {
    const result = spec.shape(datasets?.[spec.dataset] ?? null, ctx);
    if (result.available) {
      resolved.push({ id: result.id, updatedAt: result.updatedAt, render: (locale) => result.render(locale) });
      report.push({ id: result.id, status: 'fresh' });
      continue;
    }
    const carried = result.code === 'missing' && prev ? carriedFromPrevious(prev, result.id, spec.carryMs, nowMs) : null;
    if (carried) {
      resolved.push({ id: result.id, updatedAt: carried.updatedAt, carried: true, stored: carried.perLocale });
      report.push({ id: result.id, status: 'carried', code: result.code, reason: result.reason });
    } else {
      report.push({ id: result.id, status: 'omitted', code: result.code, reason: result.reason });
    }
  }

  const maxFacts = config.maxKeyFacts;
  const blocksMeta = [];
  const locales = {};
  for (const locale of HUB_LOCALES) {
    const keyFacts = [];
    const dataBlocks = [];
    const evergreenCopy = [];
    resolved.forEach((r, i) => {
      let block;
      let facts;
      if (r.stored) {
        ({ block, keyFacts: facts } = r.stored[locale]);
      } else {
        const out = r.render(locale);
        facts = out.keyFacts ?? [];
        block = {
          id: r.id,
          title: out.title,
          ...(out.description ? { description: out.description } : {}),
          items: out.items,
          ...(out.sourceName ? { sourceName: out.sourceName } : {}),
          ...(out.sourceName && out.sourceUrl ? { sourceUrl: out.sourceUrl } : {}),
          updatedAt: r.updatedAt,
        };
        evergreenCopy.push(block.title, block.description, ...facts.map((f) => f.label));
      }
      const kept = facts.slice(0, Math.max(0, maxFacts - keyFacts.length));
      keyFacts.push(...kept);
      dataBlocks.push(block);
      if (locale === HUB_LOCALES[0]) blocksMeta[i] = { id: r.id, updatedAt: r.updatedAt, keyFacts: kept.length, ...(r.carried ? { carried: true } : {}) };
      else if (blocksMeta[i].keyFacts !== kept.length) throw new Error(`canton-hubs: ${id}: il blocco ${r.id} ha un numero diverso di fatti chiave in ${locale}`);
    });

    const intro = buildHubIntro({ canton, topic, locale, neighbours, languages: profile?.languages ?? [] });
    const foreign = foreignToponymsInCopy(canton, [intro, ...evergreenCopy]);
    if (foreign.length) {
      throw new Error(`canton-hubs: ${id}/${locale}: il testo evergreen nomina toponimi di un altro cantone: ${foreign.map((f) => f.toponym).join(', ')}`);
    }
    locales[locale] = {
      canton,
      topic,
      locale,
      intro,
      keyFacts,
      dataBlocks,
      curatedArticles: (curated ?? []).map((a) => curatedEntry(a, locale)),
      links: buildHubLinks({ canton, topic, locale, catalogue, cantonUrlSlugs, evergreenArticles }),
      updatedAt: '',
    };
  }

  const draft = { schemaVersion: HUB_SCHEMA_VERSION, id, section, canton, topic, updatedAt: '', contentHash: '', blocks: blocksMeta, locales };
  const contentHash = hubContentHash(draft);
  if (prev && prev.contentHash === contentHash && hubContentHash(prev) === contentHash) {
    // Stesso contenuto: si tiene il file com'e', purche' passi ancora le
    // regole di oggi. Se non le passa (regole cambiate dopo che fu scritto) si
    // prosegue e lo si riscrive, invece di restare bloccati su un file vecchio.
    let stillValid = true;
    try {
      for (const locale of HUB_LOCALES) validateHubInput(prev.locales[locale]);
    } catch {
      stillValid = false;
    }
    if (stillValid) return { file: prev, changed: false, blocks: report };
  }
  const updatedAt = new Date(nowMs).toISOString();
  draft.updatedAt = updatedAt;
  draft.contentHash = contentHash;
  for (const locale of HUB_LOCALES) {
    locales[locale].updatedAt = updatedAt;
    validateHubInput(locales[locale]);
  }
  return { file: draft, changed: true, blocks: report };
}
