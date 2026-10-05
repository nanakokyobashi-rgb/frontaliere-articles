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
 *     pubblicata. Esiste solo per i tipi che hanno un profilo API: oggi
 *     `frontaliere` e `national`, con i nomi storici che il sito legge. La
 *     famiglia `canton` non ha ancora un profilo: le sue superfici aggregate
 *     (`canton-articles.json`, `meta-canton-<loc>.json`, `slugs.json.cantons`)
 *     arrivano con la PR che le pubblica (P7 del piano «sezioni cantonali»).
 *     Fino ad allora una sezione cantonale ATTIVA fa fallire `build-api.mjs`
 *     con un errore esplicito, mai un salto silenzioso: e' la stessa scelta
 *     dell'engine (`rssFeeds.mjs` non ha un profilo RSS `canton` e rifiuta
 *     una sezione attiva senza profilo).
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
    // La forma del registro cantonale la scrive create-article (P6): fino ad
    // allora il nome dell'export non e' noto e nessuno lo deve indovinare.
    registryExport: null,
    reverseExport: null,
    fallbackReasonsExport: null,
    canonicalOverrides: null,
    retiredDailyEditions: false,
  }),
});

/**
 * I nomi della superficie pubblicata, per tipo. Sono un CONTRATTO col sito
 * (il pull dell'API nel repo del sito, `reconcile-article-shards.mjs`,
 * `announced-surface.mjs`): non si derivano, si dichiarano una volta qui.
 * `canton` manca apposta — vedi l'header.
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
 * I nomi pubblicati di una sezione. Lancia per un tipo senza profilo API
 * (oggi `canton`): pubblicarla con nomi improvvisati, o saltarla, sarebbe un
 * set troncato che nessun gate vede.
 *
 * @param {string} id
 */
export function sectionApiSurfaces(id) {
  const core = articleSectionEntry(id);
  if (!Object.prototype.hasOwnProperty.call(KIND_API_PROFILES, core.kind)) {
    throw new Error(
      `sezione "${id}" (tipo ${core.kind}) senza superficie API: i nomi pubblicati della famiglia ` +
        `${core.kind} non sono ancora definiti (arrivano con la PR che pubblica le sezioni cantonali, P7). ` +
        'Rifiuto di pubblicare un set che non la contiene.',
    );
  }
  const api = KIND_API_PROFILES[core.kind];
  return Object.freeze({
    section: core.section,
    kind: core.kind,
    ...api,
    metaFile: (locale) => `${api.metaPrefix}-${locale}.json`,
  });
}

/** True se il tipo della sezione ha una superficie API propria. */
export function hasApiSurfaces(id) {
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
 * Le sezioni attive che hanno una superficie API propria. Una sezione attiva
 * SENZA profilo API non sparisce da qui in silenzio: `assertActiveSectionsPublishable`
 * la rifiuta, e `build-api.mjs` la chiama prima di scrivere qualunque file.
 */
export const API_SECTIONS = Object.freeze(
  ARTICLE_SECTION_CORE_LIST.filter((core) => hasApiSurfaces(core.section)).map((core) =>
    Object.freeze({ ...sectionSourceSurfaces(core.section), api: sectionApiSurfaces(core.section) }),
  ),
);

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
