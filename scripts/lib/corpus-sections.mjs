/**
 * corpus-sections.mjs — le sezioni articolo viste dal PUBBLICATORE, derivate
 * dal core.
 *
 * Il core (`engine/shared/articleSectionCore.mjs`, mirrorato dal sito) dice
 * quali sezioni esistono e quali sono ATTIVE, e porta la tupla che tutti i
 * consumer condividono (registro, mappa slug, prefisso meta, cartella corpi,
 * `kind`, `shardKey`). Questo modulo aggiunge solo cio' che il core non porta
 * perche' e' del corpus: i nomi degli export TypeScript che `build-api.mjs`
 * legge, i file di canonical override, e i NOMI della superficie pubblicata in
 * `dist/api/` (`articles.json`, `meta-ch-<loc>.json`, `slugs.json.swiss`, …).
 *
 * Prima di questo modulo ogni consumer del corpus — build-api, la sitemap, i
 * pavimenti, l'indice runtime, il refresh dell'hub, il fast-publish — teneva la
 * propria copia scritta a mano di `frontaliere`/`svizzera`. Accendere una
 * sezione nel core non arrivava a nessuna di quelle copie (AGENTS.md #6).
 *
 * ── Due strati, due domande diverse ────────────────────────────────────────
 *
 *   - `sectionSourceSurfaces(id)`: DOVE vive la sezione nei sorgenti. Vale per
 *     QUALSIASI sezione nota al core, attiva o no, perche' e' pura
 *     derivazione del core + `corpusPath()`: per una sezione cantonale non
 *     ancora generata i file semplicemente non esistono, ed e' un'assenza
 *     legittima che i pavimenti trattano come «sezione nuova, floor 0».
 *   - `sectionApiSurfaces(id)`: COME si chiama la sezione nella superficie
 *     pubblicata. Due forme:
 *       · superficie PROPRIA (`frontaliere`, `national`): i nomi storici che
 *         il sito legge (`articles.json`, `meta-ch-<loc>.json`, …), uno per
 *         sezione. `API_SECTIONS` elenca SOLO queste, come prima.
 *       · superficie di FAMIGLIA (`canton`, P7 del piano «sezioni cantonali»):
 *         le sezioni della famiglia condividono UN registro aggregato
 *         (`canton-articles.json`, una riga per articolo con la sua
 *         `section`), UN meta per locale (`meta-canton-<loc>.json`) e UNA
 *         chiave di `slugs.json` (`cantons`, annidata per sezione); la sola
 *         superficie per sezione e' la sitemap `sitemap-articles-<id>.xml`,
 *         servita dal Worker solo mentre la sezione e' `live`.
 *         `FAMILY_API_SECTIONS` elenca le sezioni ATTIVE di questa forma: con
 *         la lista attiva di oggi e' vuota, quindi niente di cio' viene
 *         emesso e `dist/api` resta quello di prima.
 *     Il feed RSS di una sezione cantonale NON e' qui: e' dell'engine
 *     (`rssFeeds.mjs`, profilo per tipo), che arriva col mirror.
 *
 * Solo builtin Node (regola di `scripts/ci/**` e `scripts/lib/**`): il core e
 * `corpus-paths.mjs` sono moduli puri.
 */
import {
  ARTICLE_SECTION_CORE_ALL,
  ARTICLE_SECTION_CORE_LIST,
  articleSectionEntry,
} from '../../engine/shared/articleSectionCore.mjs';
import { corpusPath } from '../../generator/scripts/lib/corpus-paths.mjs';

/** Le locali di ogni sezione: un file meta e una cartella corpi per locale. */
export const SECTION_LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);

/**
 * Cio' che il corpus sa di un tipo di sezione e il core no. `canonicalOverrides`
 * e' il file letto dalla sitemap (ombre self-canonical); `retiredDailyEditions`
 * dice se la sezione pubblica le edizioni quotidiane che la sitemap ritira.
 * Le sezioni cantonali non hanno override ne' edizioni quotidiane.
 */
const KIND_SOURCE_PROFILES = Object.freeze({
  frontaliere: Object.freeze({
    registryExport: 'ARTICLES',
    reverseExport: 'REVERSE_BLOG',
    fallbackReasonsExport: 'BLOG_SLUG_FALLBACK_REASONS',
    canonicalOverrides: 'engine/shared/frontaliere-article-canonical-overrides.json',
    retiredDailyEditions: true,
  }),
  national: Object.freeze({
    registryExport: 'SWISS_ARTICLES',
    reverseExport: 'REVERSE_SWISS',
    fallbackReasonsExport: 'SWISS_SLUG_FALLBACK_REASONS',
    canonicalOverrides: 'content/swiss-article-canonical-overrides.json',
    retiredDailyEditions: false,
  }),
  canton: Object.freeze({
    // I nomi degli export che create-article scrive per una sezione cantonale
    // (`cantonSectionSkeletons` del profilo cantonale di create-article, P6b):
    // stesso registro `Article[]` delle storiche, mappa slug senza inversa.
    // generator/tests/section-registry.test.mjs li confronta con quel
    // generatore quando e' sul ramo, perche' uno scarto qui pubblicherebbe
    // una famiglia vuota da un registro pieno.
    registryExport: 'CANTON_ARTICLES',
    reverseExport: null,
    fallbackReasonsExport: 'CANTON_SLUG_FALLBACK_REASONS',
    canonicalOverrides: null,
    retiredDailyEditions: false,
  }),
});

/**
 * I nomi della superficie pubblicata PROPRIA, per tipo. Sono un CONTRATTO col
 * sito (il pull dell'API nel repo del sito, `reconcile-article-shards.mjs`,
 * `announced-surface.mjs`): non si derivano, si dichiarano una volta qui.
 * `canton` non e' qui: pubblica in superfici di famiglia (sotto).
 */
const KIND_API_PROFILES = Object.freeze({
  frontaliere: Object.freeze({
    registry: 'articles.json',
    metaPrefix: 'meta',
    slugsKey: 'blog',
    reverseKey: 'blogReverse',
    counter: 'articles',
    sitemap: 'sitemap-blog.xml',
    sitemapCounter: 'sitemapBlogUrls',
  }),
  national: Object.freeze({
    registry: 'swiss-articles.json',
    metaPrefix: 'meta-ch',
    slugsKey: 'swiss',
    reverseKey: 'swissReverse',
    counter: 'swissArticles',
    sitemap: 'sitemap-blog-ch.xml',
    sitemapCounter: 'sitemapBlogChUrls',
  }),
});

/**
 * I nomi della superficie pubblicata di FAMIGLIA, per tipo (vedi l'header).
 * `family` e' l'id della famiglia; `sitemapFile(id)` la sola superficie per
 * sezione. Come quelli propri, sono un contratto: il Worker del sito serve
 * `/sitemap-articles-<canton-id>.xml` da `edge/` con una regola sola
 * (`corpusEdgeFileForPath` in infra/cloudflare-worker/locale-router.js), e il
 * blocco di navigazione del sito leggera' i nomi aggregati.
 */
const KIND_FAMILY_API_PROFILES = Object.freeze({
  canton: Object.freeze({
    family: 'canton',
    registry: 'canton-articles.json',
    metaPrefix: 'meta-canton',
    slugsKey: 'cantons',
    reverseKey: null,
    counter: 'cantonArticles',
    sitemapCounter: 'sitemapCantonUrls',
    sitemapFile: (id) => `sitemap-articles-${id}.xml`,
  }),
});

/**
 * Come si applicano i pavimenti anti-troncamento a un tipo di sezione.
 *
 *   - `section`: ogni sezione ha il SUO pavimento, e una sezione vuota e'
 *     l'assenza del riferimento (corpus non materializzato), quindi un rifiuto.
 *     E' la regola delle due sezioni storiche, invariata.
 *   - `family`: una sezione nuova parte legittimamente da zero articoli, quindi
 *     il suo pavimento proprio e' 0 e una sitemap o un feed vuoti NON sono un
 *     rifiuto; il troncamento si giudica sulla famiglia nel suo insieme
 *     (somma dei sorgenti contro somma degli emessi). Senza questa regola
 *     accendere un cantone a 0 articoli romperebbe `publish-api` per tutti.
 */
export const KIND_FLOOR_POLICY = Object.freeze({
  frontaliere: 'section',
  national: 'section',
  canton: 'family',
});

function ownProfile(table, kind, what, id) {
  const profile = Object.prototype.hasOwnProperty.call(table, kind) ? table[kind] : undefined;
  if (!profile) throw new Error(`${what}: nessun profilo per il tipo "${kind}" (sezione "${id}")`);
  return profile;
}

/**
 * Dove vive una sezione nei sorgenti di QUESTO repo. Accetta qualunque id del
 * core (attivo o no) e lancia su un id sconosciuto: un refuso non deve ricadere
 * sui file di un'altra sezione.
 *
 * @param {string} id
 */
export function sectionSourceSurfaces(id) {
  const core = articleSectionEntry(id);
  const profile = ownProfile(KIND_SOURCE_PROFILES, core.kind, 'sectionSourceSurfaces', id);
  const metaPrefix = corpusPath(`services/locales/${core.metaPrefix}`);
  const bodyDir = corpusPath(`services/locales/${core.bodyDir}`);
  return Object.freeze({
    section: core.section,
    kind: core.kind,
    shardKey: core.shardKey,
    floorPolicy: KIND_FLOOR_POLICY[core.kind],
    registryFile: corpusPath(core.registryFile),
    slugFile: corpusPath(core.slugDataFile),
    slugExport: core.slugConst,
    /** `content/blog-meta-ch` — il file di una locale e' `${metaPrefix}-${loc}.ts`. */
    metaPrefix,
    metaFile: (locale) => `${metaPrefix}-${locale}.ts`,
    /** `content/blog-body-ch` — il corpo e' `${bodyDir}/${loc}/${id}.ts`. */
    bodyDir,
    ...profile,
  });
}

/**
 * I nomi pubblicati di una sezione: la superficie propria del suo tipo, o
 * quella della sua famiglia (con `family` valorizzato e `sitemap` gia' risolta
 * per la sezione). Lancia per un tipo senza nessuno dei due profili:
 * pubblicarla con nomi improvvisati, o saltarla, sarebbe un set troncato che
 * nessun gate vede.
 *
 * @param {string} id
 */
export function sectionApiSurfaces(id) {
  const core = articleSectionEntry(id);
  if (Object.prototype.hasOwnProperty.call(KIND_API_PROFILES, core.kind)) {
    const api = KIND_API_PROFILES[core.kind];
    return Object.freeze({
      section: core.section,
      kind: core.kind,
      family: null,
      ...api,
      metaFile: (locale) => `${api.metaPrefix}-${locale}.json`,
    });
  }
  if (Object.prototype.hasOwnProperty.call(KIND_FAMILY_API_PROFILES, core.kind)) {
    const { sitemapFile, ...api } = KIND_FAMILY_API_PROFILES[core.kind];
    return Object.freeze({
      section: core.section,
      kind: core.kind,
      ...api,
      sitemap: sitemapFile(core.section),
      metaFile: (locale) => `${api.metaPrefix}-${locale}.json`,
    });
  }
  throw new Error(
    `sezione "${id}" (tipo ${core.kind}) senza superficie API: nessun profilo pubblicato, ne' proprio ne' di ` +
      'famiglia, per questo tipo. Rifiuto di pubblicare un set che non la contiene.',
  );
}

/** True se il tipo della sezione ha una superficie API (propria o di famiglia). */
export function hasApiSurfaces(id) {
  const { kind } = articleSectionEntry(id);
  return (
    Object.prototype.hasOwnProperty.call(KIND_API_PROFILES, kind) ||
    Object.prototype.hasOwnProperty.call(KIND_FAMILY_API_PROFILES, kind)
  );
}

/** True se la sezione pubblica in superfici PROPRIE (i nomi storici). */
export function hasOwnApiSurfaces(id) {
  return Object.prototype.hasOwnProperty.call(KIND_API_PROFILES, articleSectionEntry(id).kind);
}

/**
 * Le sezioni ATTIVE, nell'ordine del core (frontaliere, svizzera, poi i
 * cantoni accesi): la sola lista da iterare per decidere cosa costruire.
 * @param {Array<{section: string}>} [coreList]
 */
export function activeSourceSections(coreList = ARTICLE_SECTION_CORE_LIST) {
  return coreList.map((core) => sectionSourceSurfaces(core.section));
}

export const CORPUS_SECTIONS = Object.freeze(activeSourceSections());

/**
 * Le sezioni attive pubblicabili (superficie propria o di famiglia), con
 * sorgenti e nomi pubblicati, nell'ordine del core. Le sezioni senza nessun
 * profilo API non sono qui e non spariscono in silenzio:
 * `assertActiveSectionsPublishable` le rifiuta.
 * @param {Array<{section: string}>} [coreList]
 */
export function publishedApiSections(coreList = ARTICLE_SECTION_CORE_LIST) {
  return coreList
    .filter((core) => hasApiSurfaces(core.section))
    .map((core) => Object.freeze({ ...sectionSourceSurfaces(core.section), api: sectionApiSurfaces(core.section) }));
}

/** Tutte le sezioni attive pubblicate: le storiche, poi le sezioni di famiglia accese. */
export const PUBLISHED_API_SECTIONS = Object.freeze(publishedApiSections());

/**
 * Le sezioni attive con superficie API PROPRIA (oggi frontaliere e svizzera,
 * con i loro nomi storici). E' l'elenco che i consumer storici iterano — i
 * pavimenti per contatore, la riconciliazione degli shard — e resta tale
 * anche quando un cantone si accende: una sezione di famiglia non ha un
 * contatore suo in `manifest.counts`.
 */
export const API_SECTIONS = Object.freeze(PUBLISHED_API_SECTIONS.filter((section) => section.api.family === null));

/**
 * Le sezioni attive che pubblicano in una superficie di famiglia (oggi: le
 * cantonali accese nel core; con la lista attiva di oggi, nessuna).
 */
export const FAMILY_API_SECTIONS = Object.freeze(PUBLISHED_API_SECTIONS.filter((section) => section.api.family !== null));

/**
 * Le famiglie accese, ciascuna con le sue sezioni attive nell'ordine del core:
 * `[{ family: 'canton', api: <nomi aggregati>, sections: [...] }]`.
 * @param {ReadonlyArray<{section: string, api: {family: string | null}}>} [sections]
 */
export function activeApiFamilies(sections = FAMILY_API_SECTIONS) {
  const byFamily = new Map();
  for (const section of sections) {
    if (section.api.family === null) continue;
    if (!byFamily.has(section.api.family)) byFamily.set(section.api.family, { family: section.api.family, api: section.api, sections: [] });
    byFamily.get(section.api.family).sections.push(section);
  }
  return [...byFamily.values()];
}

/** Lancia se una sezione attiva non ha nomi pubblicati (vedi `sectionApiSurfaces`). */
export function assertActiveSectionsPublishable(coreList = ARTICLE_SECTION_CORE_LIST) {
  for (const core of coreList) sectionApiSurfaces(core.section);
  return true;
}

/**
 * La sezione ATTIVA che possiede il file di corpo `content/<bodyDir>/<loc>/<id>.ts`,
 * oppure null se il path non e' un corpo di nessuna sezione attiva. Il match e'
 * sul segmento intero: `content/blog-body/…` non deve catturare
 * `content/blog-body-ch/…`.
 *
 * @param {string} rel path relativo alla radice del repo
 * @param {Array<{section: string}>} [coreList]
 * @returns {{section: string, id: string, locale: string} | null}
 */
export function sectionForBodyPath(rel, coreList = ARTICLE_SECTION_CORE_LIST) {
  const m = /^(content\/[^/]+)\/([a-z]{2})\/([^/]+)\.ts$/.exec(String(rel ?? ''));
  if (!m) return null;
  const [, dir, locale, id] = m;
  if (!SECTION_LOCALES.includes(locale)) return null;
  const owner = activeSourceSections(coreList).find((s) => s.bodyDir === dir);
  return owner ? { section: owner.section, id, locale } : null;
}

/** Ogni sezione nota al core, attiva o no (per controlli di collisione, mai per costruire). */
export const KNOWN_SECTION_IDS = Object.freeze(Object.keys(ARTICLE_SECTION_CORE_ALL));
