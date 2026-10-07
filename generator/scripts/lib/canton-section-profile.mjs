/**
 * canton-section-profile.mjs — la sezione cantonale vista da `create-article.mjs`
 * (P6b del piano «sezioni articoli per cantone», D14/D16/D18/D19).
 *
 * `create-article.mjs` conosceva due sezioni scritte a mano. Con il core guidato
 * da tabella (`engine/shared/articleSectionCore.mjs`, `kind` = frontaliere |
 * national | canton) le 24 sezioni cantonali sono DATI: i path di registro,
 * mappa slug, meta e corpi vengono dal core (`ARTICLE_SECTION_CORE_ALL`), il
 * profilo editoriale (fonti, contesto frontalieri, budget, `enabled`) da
 * `generator/data/canton-sections.json`. Questo modulo li unisce in UNA voce di
 * `ARTICLE_SECTION_CONFIGS` per cantone, piu' il profilo che i rami di sezione
 * del generatore leggono al posto di `IS_FRONTALIERE`.
 *
 * Cosa decide, e perche' qui e non nel generatore:
 *
 *   - QUANDO una sezione cantonale genera davvero (D16): il profilo `enabled`
 *     attiva la sezione nel corpus, ma la generazione richiede ANCHE la sezione
 *     elencata in `CANTON_ARTICLE_SECTIONS_ENABLED` (Remote Config, mappata in
 *     `load-rc-env.mjs`; assente o vuota = nessun cantone). Il generatore
 *     chiede `resolveCantonSectionGate` e, se chiusa, esce pulito con il
 *     marcatore `CANTON_SECTION_DISABLED section=<id>`.
 *   - DOVE scrive lo stato (D18): ledger URL->id, quote per dominio,
 *     `quota-state.json` e i contatori `topic-candidates-*` di una sezione
 *     cantonale stanno sotto `data/sections/<id>/`. 24 scrittori paralleli non
 *     si contendono gli stessi file; frontaliere e svizzera tengono i path di
 *     sempre (questo modulo non li tocca). `scripts/lib/article-surfaces.mjs`
 *     legge `cantonSectionPaths` per le superfici del tipo `canton`, e da li'
 *     li ricevono il rebase (`--section-surfaces`) e il ricontrollo di
 *     unicita' dopo il rebase.
 *   - COME si ammette una notizia: lessico nazionale + termini tedeschi e
 *     francesi (le fonti cantonali non sono italiane) + nome del cantone;
 *     cronaca locale solo se NEL cantone (`isInCantonArea` di P6a) e con
 *     impatto pratico (chiusure, deviazioni, servizi interrotti).
 *
 * Il pool evergreen generico NON vale per i cantoni: i suoi temi sono
 * frontalieri/Ticino o nazionali, e gli evergreen cantonali sono gli hub di P10.
 *
 * Solo builtin Node e moduli puri del corpus: i test lo importano senza `npm ci`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARTICLE_SECTION_CORE_ALL,
  isCantonSection,
} from '../../../engine/shared/articleSectionCore.mjs';
import { corpusPath } from './corpus-paths.mjs';
import { buildSourceDomainMap, isInCantonArea, registrableHost } from './canton-classifier.mjs';

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data');

/** Variabile d'ambiente (da Remote Config) che accende la generazione per cantone. */
export const CANTON_SECTIONS_ENABLED_ENV = 'CANTON_ARTICLE_SECTIONS_ENABLED';

// I prompt cantonali devono poter passare anche dalla flotta con cap di
// richiesta a 8k. Questi limiti riguardano solo testo di contesto/riassunto:
// il lessico usato dai gate deterministici resta intero in `topicalTerms`.
// Sono costanti condivise per evitare cap diversi fra classifier, selezione e
// generazione (e per renderli misurabili nei test offline).
export const CANTON_PROMPT_CONTEXT_MAX_CHARS = 360;
export const CANTON_PROMPT_CANDIDATE_LINE_MAX_CHARS = 220;
export const CANTON_PROMPT_PUBLISHED_EXCERPT_MAX_CHARS = 48;

// Il classifier è un filtro fail-open: una headline oltre questo tetto resta
// nel pool e passa comunque al gate REGOLA #0. Il tetto impedisce che una
// giornata con molte fonti cantonali spenda la durata dell'intera cascata su
// classificazioni leggere prima ancora di arrivare alla selezione.
export const CANTON_PRESPEND_MAX_CLASSIFIER_CALLS = 12;
export const CANTON_PRESPEND_CLASSIFIER_TIMEOUT_MS = 10_000;
export const CANTON_PRESPEND_CLASSIFIER_DEADLINE_MS = 45_000;

/** Marcatore di log dell'uscita pulita per una sezione cantonale spenta. */
export const CANTON_SECTION_DISABLED_MARKER = 'CANTON_SECTION_DISABLED';

/** Radice dello stato per sezione delle sezioni cantonali (D18). */
export const CANTON_STATE_ROOT = 'data/sections';

/** Locali scritte per ogni articolo, nell'ordine del generatore. */
const LOCALES = ['it', 'en', 'de', 'fr'];

/**
 * Nome italiano del gruppo URL, per prompt e log. Le 24 chiavi sono quelle di
 * `canton-url-slugs.json`: il test verifica che la tabella le copra tutte.
 */
export const CANTON_DISPLAY_NAMES = Object.freeze({
  AG: 'Argovia',
  APPENZELLO: 'Appenzello',
  BASILEA: 'Basilea',
  BE: 'Berna',
  FR: 'Friburgo',
  GE: 'Ginevra',
  GL: 'Glarona',
  GR: 'Grigioni',
  JU: 'Giura',
  LU: 'Lucerna',
  NE: 'Neuchâtel',
  NW: 'Nidvaldo',
  OW: 'Obvaldo',
  SG: 'San Gallo',
  SH: 'Sciaffusa',
  SO: 'Soletta',
  SZ: 'Svitto',
  TG: 'Turgovia',
  TI: 'Ticino',
  UR: 'Uri',
  VD: 'Vaud',
  VS: 'Vallese',
  ZG: 'Zugo',
  ZH: 'Zurigo',
});

/**
 * Nomi del cantone nelle lingue delle sue fonti: un titolo «Kanton Bern
 * erhöht die Steuern» e' cantonale per costruzione anche senza un comune.
 * Solo nomi di CANTONE (mai di citta' omonime fuori da «Kanton/canton …»).
 */
const CANTON_INSTITUTION_NAMES = Object.freeze({
  AG: ['kanton aargau', 'canton d\'argovie', 'canton argovia', 'aargauer regierung'],
  APPENZELLO: ['appenzell ausserrhoden', 'appenzell innerrhoden', 'kanton appenzell'],
  BASILEA: ['basel-stadt', 'basel-landschaft', 'baselland', 'baselbiet', 'kanton basel'],
  BE: ['kanton bern', 'canton de berne', 'canton berna', 'berner regierung', 'grosser rat bern'],
  FR: ['canton de fribourg', 'kanton freiburg', 'canton friburgo', 'conseil d\'etat fribourgeois', 'etat de fribourg'],
  GE: ['canton de geneve', 'canton ginevra', 'etat de geneve', 'conseil d\'etat genevois', 'grand conseil genevois'],
  GL: ['kanton glarus', 'canton glarona', 'glarner regierung', 'landrat glarus'],
  GR: ['kanton graubunden', 'kanton graubuenden', 'canton grigioni', 'chantun grischun', 'bundner regierung', 'buendner regierung'],
  JU: ['canton du jura', 'republique et canton du jura', 'canton giura', 'gouvernement jurassien'],
  LU: ['kanton luzern', 'canton lucerna', 'luzerner regierung', 'kantonsrat luzern'],
  NE: ['canton de neuchatel', 'canton neuchatel', 'etat de neuchatel', 'conseil d\'etat neuchatelois'],
  NW: ['kanton nidwalden', 'canton nidvaldo', 'nidwaldner regierung'],
  OW: ['kanton obwalden', 'canton obvaldo', 'obwaldner regierung'],
  SG: ['kanton st. gallen', 'kanton st gallen', 'canton san gallo', 'st. galler regierung'],
  SH: ['kanton schaffhausen', 'canton sciaffusa', 'schaffhauser regierung'],
  SO: ['kanton solothurn', 'canton soletta', 'solothurner regierung'],
  SZ: ['kanton schwyz', 'canton svitto', 'schwyzer regierung'],
  TG: ['kanton thurgau', 'canton turgovia', 'thurgauer regierung'],
  TI: ['canton ticino', 'cantone ticino', 'consiglio di stato ticinese', 'gran consiglio ticinese'],
  UR: ['kanton uri', 'canton uri', 'urner regierung'],
  VD: ['canton de vaud', 'canton vaud', 'etat de vaud', 'conseil d\'etat vaudois', 'grand conseil vaudois'],
  VS: ['canton du valais', 'kanton wallis', 'canton vallese', 'etat du valais', 'walliser regierung'],
  ZG: ['kanton zug', 'canton zugo', 'zuger regierung'],
  ZH: ['kanton zurich', 'kanton zuerich', 'canton zurigo', 'zurcher regierung', 'zuercher regierung', 'kantonsrat zurich'],
});

/**
 * Lessico topicale tedesco e francese delle fonti cantonali (D14: «lessico
 * nazionale + termini del cantone»). Il lessico nazionale del generatore e'
 * italiano: senza questa meta' una fonte tedesca o francese non supererebbe
 * MAI il gate topicale. Gli stem si confrontano a INIZIO parola
 * (`termHits`), non come sottostringa: «stellen» dentro «feststellen» non e'
 * il mercato del lavoro.
 */
export const CANTON_TOPICAL_TERMS_DE_FR = Object.freeze([
  // frontalieri / confine
  'grenzgänger', 'grenzganger', 'grenzgaenger', 'grenzübergang', 'grenzuebergang', 'grenzwache', 'zoll',
  'frontalier', 'transfrontali', 'douane', 'poste-frontière', 'passage frontière',
  // fisco
  'quellensteuer', 'steuer', 'steuererklärung', 'steuerfuss', 'impôt', 'impot', 'fiscal', 'taxe',
  // previdenza e assicurazioni sociali
  'ahv', 'iv-rente', 'pensionskasse', 'krankenkass', 'krankenversicherung', 'prämie', 'praemie',
  'prämienverbilligung', 'avs', 'caisse de pension', 'assurance maladie', 'assurance-maladie', 'subside',
  // lavoro
  'lohn', 'löhne', 'loehne', 'mindestlohn', 'arbeitsmarkt', 'arbeitslos', 'arbeitsplätze', 'arbeitsplatz',
  'entlassung', 'stellenabbau', 'kurzarbeit', 'gesamtarbeitsvertrag', 'fachkräfte', 'fachkraefte',
  'salaire', 'salaire minimum', 'emploi', 'chômage', 'chomage', 'licenciement', 'marché du travail',
  'convention collective', 'travailleurs',
  // istituzioni e politica cantonale
  'regierungsrat', 'grosser rat', 'kantonsrat', 'landrat', 'landsgemeinde', 'abstimmung', 'volksabstimmung',
  'gesetz', 'verordnung', 'voranschlag', 'budget', 'staatsrechnung', 'finanzplan',
  'conseil d\'état', 'conseil d\'etat', 'grand conseil', 'gouvernement', 'votation', 'parlement cantonal',
  // casa e costo della vita
  'miete', 'mieten', 'wohnungsmarkt', 'wohnungsnot', 'teuerung', 'inflation', 'strompreis', 'energiepreis',
  'loyer', 'logement', 'coût de la vie', 'cout de la vie', 'prix de l\'électricité',
  // mobilita' e servizi
  'verkehr', 'baustelle', 'sperrung', 'gesperrt', 'umleitung', 'stau', 'autobahn', 'fahrplan', 'postauto',
  'sbb', 'öv', 'fussweg', 'veloweg', 'radweg', 'veloroute', 'verkehrssicherheit', 'verkehrsunfall',
  'wildunfall', 'strassenverkehr', 'strassensperrung', 'vollsperrung', 'umfahrungsbetrieb', 'umfahrung',
  'kantonsstr', 'fahrbahn', 'schulweg', 'sicherheitsmassnahmen', 'verkehrsführung',
  'trafic', 'chantier', 'fermeture', 'fermeture complète', 'fermeture complete', 'déviation', 'deviation',
  'bouchon', 'autoroute', 'voie cyclable', 'piste cyclable', 'sécurité routière', 'securite routiere',
  'accident de la route', 'collision avec un animal', 'route cantonale', 'horaire', 'cff', 'transports publics',
  // sanita', scuola, economia
  'spital', 'gesundheit', 'schule', 'volksschule', 'hôpital', 'hopital', 'santé', 'école', 'ecole',
  'wirtschaft', 'unternehmen', 'konkurs', 'firma', 'économie', 'economie', 'entreprise', 'faillite',
  // permessi e residenza
  'aufenthaltsbewilligung', 'bewilligung', 'niederlassung', 'permis de séjour', 'permis g', 'permis b',
]);

/**
 * Impatto pratico di un fatto di cronaca locale: e' la sola cronaca che una
 * sezione cantonale pubblica (chiusure, deviazioni, servizi sospesi), nelle tre
 * lingue delle fonti. Un incidente che chiude l'A1 interessa chi ci passa ogni
 * mattina; un furto in un appartamento no.
 */
export const PRACTICAL_IMPACT_TERMS = Object.freeze([
  // it
  'chius', 'deviazion', 'cantier', 'coda', 'code ', 'traffico', 'interruzion', 'sospes', 'sciopero',
  'evacuat', 'allerta', 'blocc', 'disagi', 'senza corrente', 'acqua potabile',
  // de
  'gesperrt', 'sperrung', 'umleitung', 'stau', 'baustelle', 'verkehrsbehinderung', 'unterbruch',
  'ausfall', 'streik', 'evakuiert', 'stromausfall', 'trinkwasser', 'warnung', 'ersatzbus',
  // fr
  'fermé', 'ferme ', 'fermeture', 'déviation', 'deviation', 'bouchon', 'chantier', 'perturbation',
  'interruption', 'grève', 'greve', 'évacu', 'evacu', 'panne', 'coupure', 'eau potable', 'bus de remplacement',
]);

/** Il frontaliere nelle tre lingue: il segnale che una fonte del lato estero parla di noi. */
const FRONTALIERI_TERMS = Object.freeze([
  'frontalier', 'transfrontali', 'grenzgänger', 'grenzganger', 'grenzgaenger', 'pendolar', 'pendler',
  'permesso g', 'permis g', 'g-bewilligung', 'grenzgängerbewilligung',
]);

/** Minuscole e senza diacritici, come `foldKeepCase` ma per un confronto a stem. */
export function foldForMatch(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[’`]/gu, "'");
}

/**
 * Quante volte compaiono gli stem in `text`, ciascuno a INIZIO parola. I
 * termini si piegano come il testo (minuscolo, senza diacritici).
 */
export function termHits(text, terms) {
  const hay = foldForMatch(text);
  if (!hay) return 0;
  let hits = 0;
  for (const raw of terms) {
    const term = foldForMatch(raw);
    if (!term) continue;
    let from = 0;
    for (;;) {
      const at = hay.indexOf(term, from);
      if (at === -1) break;
      const before = at === 0 ? '' : hay[at - 1];
      if (!before || !/[\p{L}\p{N}]/u.test(before)) hits += 1;
      from = at + term.length;
    }
  }
  return hits;
}

// ── Profili e core ───────────────────────────────────────────────────────────

let _profiles = null;

/** `canton-sections.json`, letto una volta. */
export function loadCantonSectionProfiles() {
  if (_profiles) return _profiles;
  _profiles = JSON.parse(readFileSync(path.join(DATA_DIR, 'canton-sections.json'), 'utf8'));
  return _profiles;
}

/** Il profilo editoriale di una sezione cantonale (lancia su un id ignoto). */
export function cantonSectionProfile(section, profiles = loadCantonSectionProfiles()) {
  const found = (profiles?.cantons || []).find((c) => c.section === section);
  if (!found) throw new Error(`canton-sections.json: nessun profilo per la sezione "${section}"`);
  return found;
}

/** Gli id delle sezioni cantonali del core, nell'ordine del core. */
export function cantonSectionIds() {
  return Object.keys(ARTICLE_SECTION_CORE_ALL).filter((id) => isCantonSection(id));
}

// ── D16: il gate di generazione ──────────────────────────────────────────────

/**
 * Legge `CANTON_ARTICLE_SECTIONS_ENABLED`: codici di gruppo («TI»), id di
 * sezione («canton-ti») o la parola `all`, separati da virgole o spazi,
 * maiuscole indifferenti. Un token che non nomina un cantone del core finisce
 * in `unknown` (si logga, non si indovina).
 *
 * @param {string | undefined | null} raw
 * @returns {{ sections: Set<string>, unknown: string[] }}
 */
export function parseEnabledCantonSections(raw) {
  const sections = new Set();
  const unknown = [];
  const ids = cantonSectionIds();
  for (const token of String(raw || '').split(/[\s,;]+/u).map((t) => t.trim()).filter(Boolean)) {
    const lower = token.toLowerCase();
    if (lower === 'all' || lower === '*') {
      for (const id of ids) sections.add(id);
      continue;
    }
    const id = lower.startsWith('canton-') ? lower : `canton-${lower}`;
    if (ids.includes(id)) sections.add(id);
    else unknown.push(token);
  }
  return { sections, unknown };
}

/**
 * La sezione cantonale puo' generare? Deve essere attiva nel profilo corpus
 * (D22) E presente nell'elenco Remote Config (D16). `enabled` da solo non
 * autorizza mai una generazione; assente o vuoto = spenta.
 *
 * @param {string} section
 * @param {{ env?: Record<string, string | undefined>, profiles?: any }} [opts]
 * @returns {{ enabled: boolean, via: 'env' | null, unknown: string[] }}
 */
export function resolveCantonSectionGate(section, { env = process.env, profiles } = {}) {
  const profile = cantonSectionProfile(section, profiles ?? loadCantonSectionProfiles());
  const { sections, unknown } = parseEnabledCantonSections(env?.[CANTON_SECTIONS_ENABLED_ENV]);
  if (profile.enabled === true && sections.has(section)) return { enabled: true, via: 'env', unknown };
  return { enabled: false, via: null, unknown };
}

// ── D18: lo stato per sezione ────────────────────────────────────────────────

/**
 * Tutti i path che create-article scrive per una sezione cantonale. I path
 * sorgente (registro, mappa slug, meta, corpi) sono quelli del core, nel
 * layout del sito come il resto del generatore (`corpusPath` li traduce).
 *
 * @param {string} section
 */
export function cantonSectionPaths(section) {
  if (!isCantonSection(section)) throw new Error(`cantonSectionPaths: "${section}" non e' una sezione cantonale`);
  const core = ARTICLE_SECTION_CORE_ALL[section];
  const state = `${CANTON_STATE_ROOT}/${section}`;
  return {
    registryFile: core.registryFile,
    slugDataFile: core.slugDataFile,
    metaPrefix: core.metaPrefix,
    bodyDir: core.bodyDir,
    metaFiles: LOCALES.map((loc) => `services/locales/${core.metaPrefix}-${loc}.ts`),
    seoFile: `packages/articles/content/cantons/${section}/seo.ts`,
    sourceUrlsFile: `${state}/article-source-urls.json`,
    sourceQuotaFile: `${state}/article-source-quotas.json`,
    quotaStateFile: `${state}/quota-state.json`,
    experimentalCounterFile: `${state}/topic-candidates-experimental-counter.json`,
    evergreenCounterFile: `${state}/topic-candidates-evergreen-counter.json`,
    consumedFile: `${state}/topic-candidates-consumed.json`,
    todayPicksFile: `${state}/topic-candidates-today-picks.json`,
    evergreenRejectedFile: `${state}/topic-candidates-evergreen-rejected.json`,
    sidecarDir: `${state}/articles`,
    embeddingsBinPath: `${state}/article-embeddings.bin`,
    embeddingsMetaPath: `${state}/article-embeddings-meta.json`,
  };
}

// ── La voce di ARTICLE_SECTION_CONFIGS ───────────────────────────────────────

/** Le fonti news del profilo, nella forma che lo scanner cantonale legge. */
function newsSourcesOf(profile) {
  return (profile.newsSources || []).map((s) => Object.freeze({
    url: s.url,
    parser: s.parser,
    format: s.format,
    language: s.language,
    kind: s.kind,
    publisher: s.publisher,
    topics: Object.freeze([...(s.topics || [])]),
    quirks: Object.freeze({ ...(s.quirks || {}) }),
    reserve: s.reserve === true,
  }));
}

/**
 * La voce di `ARTICLE_SECTION_CONFIGS` per una sezione cantonale: stessi campi
 * delle due storiche, valori dal core e da `cantonSectionPaths`.
 *
 * @param {string} section
 * @param {any} [profiles]
 */
export function cantonSectionConfig(section, profiles = loadCantonSectionProfiles()) {
  const core = ARTICLE_SECTION_CORE_ALL[section];
  if (!core || core.kind !== 'canton') throw new Error(`cantonSectionConfig: "${section}" non e' una sezione cantonale del core`);
  const profile = cantonSectionProfile(section, profiles);
  const p = cantonSectionPaths(section);
  return {
    section,
    kind: 'canton',
    canton: core.canton,
    label: `Articoli ${CANTON_DISPLAY_NAMES[core.canton] || core.canton}`,
    newsSources: newsSourcesOf(profile),
    rssFallbackMap: {},
    hubSlug: core.indexSlug,
    registryFile: core.registryFile,
    registryArrayName: 'CANTON_ARTICLES',
    slugDataFile: core.slugDataFile,
    slugsConstName: core.slugConst,
    fallbackReasonsConstName: 'CANTON_SLUG_FALLBACK_REASONS',
    allIdsConstName: 'ALL_CANTON_ARTICLE_IDS',
    updateRouterUnion: false,
    metaPrefix: core.metaPrefix,
    bodyDir: core.bodyDir,
    seoFile: p.seoFile,
    seoConstName: 'CANTON_SEO_METADATA',
    // Nessuna sitemap scritta dal generatore (no-op anche per le storiche):
    // la sitemap di famiglia la emette build-api (P7).
    sitemapFile: null,
    sitemapUrl: null,
    embeddingsBinPath: p.embeddingsBinPath,
    embeddingsMetaPath: p.embeddingsMetaPath,
    sidecarDir: p.sidecarDir,
    sourceQuotaFile: p.sourceQuotaFile,
    sourceUrlsFile: p.sourceUrlsFile,
    statePaths: Object.freeze({
      quotaState: p.quotaStateFile,
      experimentalCounter: p.experimentalCounterFile,
      evergreenCounter: p.evergreenCounterFile,
      consumed: p.consumedFile,
      todayPicks: p.todayPicksFile,
      evergreenRejected: p.evergreenRejectedFile,
    }),
  };
}

/** Le 24 voci cantonali, nell'ordine del core. */
export function cantonSectionConfigs(profiles = loadCantonSectionProfiles()) {
  return Object.fromEntries(cantonSectionIds().map((id) => [id, cantonSectionConfig(id, profiles)]));
}

// ── File vuoti al primo articolo ─────────────────────────────────────────────

/**
 * La riga di import di tipo di uno scheletro. Composta e non scritta letterale
 * dentro il template: `generator/tests/import-closure.test.mjs` legge gli
 * import di questo file in modo lessicale e prenderebbe la riga del file
 * GENERATO (relativa a content/cantons/<id>/) per un import di questo modulo.
 */
function typeImportLine(name, from) {
  return ['import', 'type', `{ ${name} }`, 'from', `'${from}';`].join(' ');
}

function pascal(section) {
  return section.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

/**
 * Lo scheletro dei file di una sezione cantonale ancora senza articoli, nella
 * forma che gli scrittori di create-article riconoscono come «vuota»
 * (`modifyRouterTs`, `modifyBlogArticlesTsx`, `writeSectionLocale`,
 * `modifySeoService`): mappa slug `{\n}`, array `[\n]`, oggetti `{\n}`.
 * Path nel layout del sito; il chiamante li traduce con `corpusPath`.
 *
 * @param {string} section
 * @returns {Record<string, string>}
 */
export function cantonSectionSkeletons(section) {
  const cfg = cantonSectionConfig(section);
  const name = CANTON_DISPLAY_NAMES[cfg.canton] || cfg.canton;
  const files = {};
  files[cfg.registryFile] = `/**
 * Articoli della sezione ${section} (${name}). Stessa forma \`Article\` del
 * registro frontaliere; scritto da generator/scripts/create-article.mjs
 * --section=${section}.
 */
${typeImportLine('Article', '../../blog-articles-data')}

export const ${cfg.registryArrayName}: Article[] = [
];
`;
  files[cfg.slugDataFile] = `/**
 * Slug per locale degli articoli della sezione ${section} (${name}).
 * Scritto da generator/scripts/create-article.mjs --section=${section}.
 */
export const ${cfg.slugsConstName}: Record<string, { it: string; en: string; de: string; fr: string }> = {
};

export const ${cfg.fallbackReasonsConstName}: Record<string, Record<string, string>> = {
};

export const ${cfg.allIdsConstName}: string[] = Object.keys(${cfg.slugsConstName});
`;
  for (const loc of LOCALES) {
    const varName = `blogMeta${pascal(section)}${loc.charAt(0).toUpperCase()}${loc.slice(1)}`;
    files[`services/locales/${cfg.metaPrefix}-${loc}.ts`] = `/**
 * Meta (${loc}) degli articoli della sezione ${section} (${name}): chiavi
 * \`blog.article.{id}.*\`, namespace condiviso con le altre sezioni.
 */
const ${varName}: Record<string, string> = {
};

export default ${varName};
`;
  }
  files[cfg.seoFile] = `// Metadati SEO degli articoli della sezione ${section} (${name}).
// Stessa forma voce di seo-blog-ch.ts; scritto da create-article.mjs.

${typeImportLine('SEOMetadata', '../../seo/seoMetadataType')}

const BASE_URL = 'https://frontaliereticino.ch';

const ${cfg.seoConstName}: Record<string, SEOMetadata> = {
};

export default ${cfg.seoConstName};
`;
  return files;
}

// ── Il profilo letto dai rami di sezione ─────────────────────────────────────

let _domainMap = null;
function sourceDomainMap() {
  if (!_domainMap) _domainMap = buildSourceDomainMap(loadCantonSectionProfiles());
  return _domainMap;
}

let _sourceUrlMap = null;
const LOCAL_SOURCE_KINDS = new Set(['media', 'istituzionale', 'polizia']);

/**
 * Alias espliciti per il solo feed condiviso Ob-/Nidvaldo. Non entrano nel
 * gate geografico generale: qui servono a separare un feed regionale che usa
 * «Unterwalden» come nome storico e titoli che indicano il cantone solo nel
 * percorso dell'articolo (per esempio `www.nw.ch`).
 */
const SHARED_CANTON_AREA_ALIASES = Object.freeze({
  NW: Object.freeze([
    'nidwalden', 'nidwald', 'nidvaldo', 'stans', 'hergiswil', 'buochs', 'stansstad',
    'dallenwil', 'wolfenschiessen', 'ennetbuergen', 'nw.ch', 'ob- und nidwalden', 'unterwalden',
  ]),
  OW: Object.freeze([
    'obwalden', 'obwald', 'obvaldo', 'sarnen', 'engelberg', 'alpnach', 'giswil', 'kerns',
    'sachseln', 'lungern', 'melchtal', 'ow.ch', 'ob- und nidwalden', 'unterwalden',
  ]),
});

/** URL che identificano una pagina-fonte strettamente cantonale. */
function canonicalSourceUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return String(url || '').trim();
  }
}

/**
 * I token del cantone che possono comparire nel percorso della pagina-fonte.
 * «kanton»/«canton» da soli sono volutamente esclusi: un URL come
 * `/kanton/medien` non distingue il gruppo. Questo consente di riconoscere
 * `nau.ch/ort/luzern`, ma non il feed regionale condiviso di Tele 1 o 20min.
 */
function cantonSourcePathTokens(code) {
  const stop = new Set(['kanton', 'canton', 'regierung', 'regierungsrat', 'conseil', 'etat', 'gouvernement']);
  return [...new Set((CANTON_INSTITUTION_NAMES[code] || [])
    .flatMap((name) => foldForMatch(name).split(/[^\p{L}\p{N}]+/u))
    .filter((token) => token.length >= 4 && !stop.has(token)))];
}

/**
 * Mappa URL-fonte -> cantone solo quando la pagina e' locale senza ambiguita'.
 * Il dominio unico resta la regola principale. Per gli host condivisi si
 * accetta soltanto un URL esatto usato da un solo profilo il cui percorso
 * contiene il nome del cantone; i feed dichiarati `filterByCanton` restano
 * esclusi perche' il loro URL e' condiviso per costruzione.
 *
 * @param {any} cantonSections
 */
export function buildCantonSourceUrlMap(cantonSections = loadCantonSectionProfiles()) {
  const domainMap = buildSourceDomainMap(cantonSections);
  const candidates = new Map();
  for (const profile of cantonSections?.cantons || []) {
    for (const source of profile.newsSources || []) {
      const url = canonicalSourceUrl(source.url);
      if (!url) continue;
      const host = registrableHost(url);
      const hostIsLocal = domainMap.get(host) === profile.code;
      const pathHasCanton = termHits(url, cantonSourcePathTokens(profile.code)) > 0;
      const scoped = hostIsLocal || (
        LOCAL_SOURCE_KINDS.has(source.kind)
        && !source.quirks?.filterByCanton
        && pathHasCanton
      );
      if (!scoped) continue;
      if (!candidates.has(url)) candidates.set(url, new Set());
      candidates.get(url).add(profile.code);
    }
  }
  return new Map([...candidates]
    .filter(([, codes]) => codes.size === 1)
    .map(([url, codes]) => [url, [...codes][0]]));
}

function sourceUrlMap() {
  if (!_sourceUrlMap) _sourceUrlMap = buildCantonSourceUrlMap(loadCantonSectionProfiles());
  return _sourceUrlMap;
}

/**
 * Riduce un feed condiviso alle voci del cantone dichiarato dal quirk. Il
 * filtro e' volutamente basato sull'area reale del titolo/lead/URL, non sul
 * dominio del feed: `unterwalden24.ch` serve sia NW sia OW.
 */
export function filterCantonSourceHeadlines(profile, source, headlines) {
  const wanted = String(source?.quirks?.filterByCanton || '').trim().toUpperCase();
  if (!wanted) return headlines;
  if (wanted !== String(profile?.canton || '').trim().toUpperCase()) return [];
  const aliases = SHARED_CANTON_AREA_ALIASES[wanted] || [];
  const textAliases = aliases.filter((alias) => !alias.includes('.ch'));
  const urlAliases = wanted === 'NW' ? ['nw.ch'] : wanted === 'OW' ? ['ow.ch'] : [];
  const filtered = (headlines || []).filter((h) => {
    const text = `${h.headline || ''} ${h.lead || ''}`;
    return profile?.isLocalArea?.(text) || termHits(text, textAliases) > 0 || termHits(h.url || '', urlAliases) > 0;
  });
  // Il filtro ha già dimostrato che questa voce appartiene al cantone
  // dichiarato. Conserviamo la prova come metadato interno: il successivo
  // anchor-gate non deve riconoscere di nuovo gli alias condivisi come se
  // fossero un feed regionale non filtrato.
  return filtered.map((h) => ({ ...h, _cantonFilterBy: wanted }));
}

/**
 * Il profilo di sezione per `kind: 'canton'`. Le parti nazionali (lessico
 * italiano) arrivano dal chiamante: vivono in create-article.mjs e non si
 * copiano qui.
 *
 * @param {string} section
 * @param {{ nationalTopicalKeywords: string[], nationalAdmissionKeywords: string[],
 *   isInArea?: (code: string, text: string) => boolean }} deps
 */
export function buildCantonProfile(section, deps) {
  const cfg = cantonSectionConfig(section);
  const profile = cantonSectionProfile(section);
  const code = cfg.canton;
  const name = CANTON_DISPLAY_NAMES[code] || code;
  const inArea = deps?.isInArea || isInCantonArea;
  const nationalTopical = deps?.nationalTopicalKeywords || [];
  const nationalAdmission = deps?.nationalAdmissionKeywords || [];
  const institutionNames = CANTON_INSTITUTION_NAMES[code] || [];
  const topicalTerms = Object.freeze([...CANTON_TOPICAL_TERMS_DE_FR, ...institutionNames]);

  const nationalHits = (text, list) => {
    const lower = String(text || '').toLowerCase();
    return list.reduce((acc, k) => acc + (lower.split(k).length - 1), 0);
  };
  const isLocalArea = (text) => Boolean(text) && inArea(code, String(text));
  const hasPracticalImpact = (text) => termHits(text, PRACTICAL_IMPACT_TERMS) > 0;
  const hasFrontalieriSignal = (text) => termHits(text, FRONTALIERI_TERMS) > 0;
  /** Cronaca locale ammessa: NEL cantone e con impatto pratico. */
  const localAdmits = (text) => isLocalArea(text) && hasPracticalImpact(text);
  const countTopical = (text) => nationalHits(text, nationalTopical) + termHits(text, topicalTerms);
  const countAdmission = (text) => nationalHits(text, nationalAdmission) + termHits(text, topicalTerms);

  return Object.freeze({
    kind: 'canton',
    section,
    canton: code,
    cantonName: name,
    languages: Object.freeze([...(profile.languages || [])]),
    frontalieriContext: String(profile.frontalieriContext || ''),
    dailyBudget: profile.dailyBudget,
    topicalTerms,
    // Rami del generatore (create-article.mjs legge QUESTI, non il nome).
    // Niente pool discovery/Google News, niente ranker sulla domanda GSC
    // (vocabolario e candidate sperimentali sono frontalieri/nazionali: il tier
    // sperimentale proporrebbe una keyword evergreen frontaliera), niente pool
    // evergreen generico: gli evergreen cantonali sono gli hub di P10.
    discoveryPool: false,
    demandRanker: false,
    evergreenPool: null,
    hasTopical: (text) => countTopical(text) > 0,
    countTopical,
    hasAdmission: (text) => countAdmission(text) > 0 || localAdmits(text),
    countAdmission: (text) => countAdmission(text) + (localAdmits(text) ? 1 : 0),
    localAdmits,
    isLocalArea,
    hasPracticalImpact,
    hasFrontalieriSignal,
    /**
     * Il gate geografico dello scan: il testo nomina un luogo del cantone, la
     * fonte e' una testata/ente `.ch` di questo solo cantone, o (fonti del
     * lato estero) parla di frontalieri.
     */
    anchors(text, url, sourceUrl, cantonFilterBy) {
      if (String(cantonFilterBy || '').trim().toUpperCase() === code) return true;
      if (isLocalArea(text)) return true;
      if (termHits(text, institutionNames) > 0) return true;
      const host = registrableHost(url || '');
      if (host && sourceDomainMap().get(host) === code) return true;
      const configuredSource = canonicalSourceUrl(sourceUrl);
      if (configuredSource && sourceUrlMap().get(configuredSource) === code) return true;
      return hasFrontalieriSignal(text);
    },
  });
}

// ── I testi di prompt della sezione cantonale ────────────────────────────────

/** Riga di contesto frontalieri del profilo, compatta. */
function contextLine(p) {
  if (!p.frontalieriContext) return '\n';
  const raw = String(p.frontalieriContext).replace(/\s+/g, ' ').trim();
  if (raw.length <= CANTON_PROMPT_CONTEXT_MAX_CHARS) {
    return `\nCONTESTO DEL CANTONE (per giudicare, non da citare come fonte): ${raw}\n`;
  }
  const marker = ' … ';
  const available = CANTON_PROMPT_CONTEXT_MAX_CHARS - marker.length;
  const headChars = Math.ceil(available * 0.7);
  const tailChars = available - headChars;
  const compact = `${raw.slice(0, headChars).trimEnd()}${marker}${raw.slice(-tailChars).trimStart()}`;
  return `\nCONTESTO DEL CANTONE (per giudicare, non da citare come fonte): ${compact}\n`;
}

function compactPromptList(value, maxLineChars) {
  return String(value || '').split('\n').map((line) => {
    const text = line.trimEnd();
    if (text.length <= maxLineChars) return text;
    return `${text.slice(0, maxLineChars - 1).trimEnd()}…`;
  }).join('\n');
}

function compactPublishedDigest(value, maxExcerptChars) {
  return String(value || '').split('\n').map((line) => {
    const separator = ' — ';
    const separatorAt = line.lastIndexOf(separator);
    if (!line.startsWith('• ') || separatorAt < 0) return line;
    const title = line.slice(0, separatorAt);
    const excerpt = line.slice(separatorAt + separator.length);
    if (excerpt.length <= maxExcerptChars) return line;
    return `${title}${separator}${excerpt.slice(0, maxExcerptChars).trimEnd()}…`;
  }).join('\n');
}

/** Il prompt del classifier pre-spend (stessa forma di risposta delle storiche). */
export function cantonClassifierPrompt(p, { headline, sourceHint, summary }) {
  return `Sei un editor del sito frontaliereticino.ch, sezione del Canton ${p.cantonName}: informa chi VIVE o LAVORA nel Canton ${p.cantonName}, frontalieri compresi.
${contextLine(p)}
È RILEVANTE: lavoro e salari nel cantone (assunzioni, licenziamenti, chiusure, contratti), fisco cantonale e imposta alla fonte, AVS/LPP, premi cassa malati e sussidi, permessi (B, G), decisioni del governo e del parlamento cantonale, preventivo e servizi pubblici, casa e affitti, mobilità e trasporti nel cantone (strade, cantieri, chiusure, treni e bus, valichi), economia e imprese del cantone, temi dei frontalieri che lavorano nel cantone. Cronaca locale SOLO se avviene nel Canton ${p.cantonName} E ha un impatto pratico (strada chiusa, deviazione, servizio interrotto, evacuazione).

NON è rilevante:
- Cronaca nera, incidenti, sport, cultura ed eventi senza impatto pratico su chi vive o lavora nel cantone
- Notizie di altri cantoni o di altri paesi senza ricadute sul Canton ${p.cantonName}
- Gossip, intrattenimento, necrologi, risultati sportivi

La fonte può essere in tedesco, francese o italiano: giudica il contenuto, non la lingua.

HEADLINE: ${String(headline || '').slice(0, 240)}
${sourceHint ? `FONTE: ${sourceHint}\n` : ''}${summary ? `SOMMARIO: ${String(summary).slice(0, 320)}\n` : ''}
Rispondi ESATTAMENTE in questo formato (una riga):
relevant=<yes|no>; reason=<una frase di massimo 15 parole>`;
}

/** Il prompt di selezione della headline (stesso protocollo H<n> delle storiche). */
export function cantonHeadlineSelectionPrompt(p, { headlineList, recentArticles, jsonQuoteSafetyRule }) {
  const compactHeadlineList = compactPromptList(headlineList, CANTON_PROMPT_CANDIDATE_LINE_MAX_CHARS);
  const compactRecentArticles = compactPublishedDigest(recentArticles, CANTON_PROMPT_PUBLISHED_EXCERPT_MAX_CHARS);
  return `Sei un editor del sito frontaliereticino.ch, sezione del Canton ${p.cantonName}.
Devi scegliere UN articolo da queste headline di fonti del cantone per scrivere un pezzo utile a chi vive o lavora nel Canton ${p.cantonName}, frontalieri compresi.
${contextLine(p)}
HEADLINE DISPONIBILI — ognuna ha una CHIAVE «H<n>» prima del simbolo «»». La chiave è l'UNICA cosa che puoi selezionare:
${compactHeadlineList}

ARTICOLI GIÀ PUBBLICATI (NON scegliere argomenti simili o già coperti). Questo elenco NON ha chiavi e NON è selezionabile: serve solo a dirti di cosa si è già parlato.
${compactRecentArticles}

CRITERI DI SELEZIONE (in ordine di priorità):
1. IMPATTO PRATICO NEL CANTONE: lavoro e salari, fisco e imposta alla fonte, AVS/LPP, premi cassa malati, permessi, decisioni del governo o del parlamento cantonale, casa, mobilità e trasporti (chiusure, cantieri, orari), servizi pubblici
2. FRONTALIERI: a parità di impatto, preferisci le notizie che toccano chi attraversa il confine per lavorare nel cantone
3. NOVITÀ: notizie recenti con un fatto concreto (decisione, dato, scadenza, cambiamento)
4. ⚠️ NO DUPLICATI (CRITICO): non scegliere MAI un tema già coperto dagli articoli già pubblicati
5. CRONACA: solo se avviene nel cantone E ha un impatto pratico (strada chiusa, servizio interrotto); niente cronaca nera, sport o gossip fini a sé stessi
6. LINGUA: le fonti possono essere in tedesco o francese; l'articolo sarà scritto in italiano

${jsonQuoteSafetyRule}

Rispondi con un JSON object (no markdown, no code fences). Usa la CHIAVE della headline scelta, mai un numero nudo e mai il titolo di un articolo già pubblicato:
{
  "selectedId": "<chiave della headline scelta, esattamente nella forma H1, H2, …>",
  "reason": "<perché questa notizia conta per chi vive o lavora nel Canton ${p.cantonName}, max 2 frasi>"
}`;
}

/**
 * Le righe del prompt di generazione e dei controlli a valle che, per la
 * sezione cantonale, non possono essere ne' quelle frontaliere (Ticino-Italia)
 * ne' quelle nazionali (che rifiutano la cronaca cantonale).
 */
export function cantonPromptLines(p) {
  const name = p.cantonName;
  return Object.freeze({
    scanLabel: `🔍 Scansione fonti del Canton ${name} (${p.section})...\n`,
    phase1Label: `🤖 Fase 1: Ricerca articolo da fonti del Canton ${name}...\n`,
    lexiconLabel: `cantonale: ${p.section} — lessico nazionale + termini DE/FR + istituzioni del Canton ${name}`,
    anchorLabel: `nessun luogo del Canton ${name}, nessuna fonte del cantone, nessun segnale frontalieri`,
    factCheckPersona: `Sei un fact-checker senior specializzato in affari del Canton ${name} e della Svizzera (fiscalità cantonale e federale, mercato del lavoro, assicurazioni sociali, frontalieri), per un pubblico che vive o lavora nel cantone.`,
    factCheckRelevance: (isEvergreen) => `11. **RILEVANZA TOPICA PER IL CANTON ${name.toUpperCase()} (CRITICO)**: L'articolo deve avere un nesso REALE, SPECIFICO e VERIFICABILE con la vita di chi vive o lavora nel Canton ${name}, frontalieri compresi. Sono nessi reali: lavoro e salari nel cantone, fisco cantonale e imposta alla fonte, AVS/LPP/LAMal e premi, permessi B/G, decisioni del governo e del parlamento cantonale, preventivo e servizi pubblici, casa e affitti, mobilità e trasporti nel cantone (chiusure, cantieri, orari), economia e imprese del cantone, cronaca locale nel cantone con un impatto pratico documentato dalla fonte.

   ${isEvergreen ? '' : 'NON sono nessi reali (segnala "critical" come "rilevanza_topica"): cronaca nera, sport, cultura ed eventi senza impatto pratico, notizie di altri cantoni o paesi senza ricadute sul cantone, gossip.'}

   SEGNALE D'ALLARME (= "critical: rilevanza_topica"): forzare «implicazioni per i frontalieri» o consigli generici ("consulta un avvocato", "verifica l'assicurazione") su un fatto che la fonte non collega al cantone.

   ${isEvergreen ? '' : "Se l'articolo è un commento generico attaccato a una notizia SENZA nesso concreto con chi vive o lavora nel cantone, il verdetto è FAIL."}`,
    systemRoleLine: `You write for "Frontaliere Ticino" (frontaliereticino.ch), Canton ${name} section — news that matters to people who live or work in the canton (including cross-border commuters): jobs and wages, cantonal tax and withholding tax, social insurance, permits, cantonal government decisions, housing, mobility and public services. The source may be in German or French: write the article in Italian. Based on the following source, write a blog article.`,
    reachLine: `- Analizza le IMPLICAZIONI PRATICHE per chi vive o lavora nel Canton ${name} (frontalieri compresi, se la fonte li riguarda)`,
    topicalRelevanceGate: `═══ REGOLA #0 — GATE DI RILEVANZA TOPICA (BLOCCANTE — PRIMA DI TUTTO) ═══

Prima di scrivere, valuta se la fonte ha un nesso REALE e VERIFICABILE con chi vive o lavora nel Canton ${name}, frontalieri compresi. Esempi di nesso reale:
- Lavoro nel cantone: assunzioni, licenziamenti, chiusure, salari, contratti collettivi
- Fisco cantonale, imposta alla fonte, AVS/LPP, premi cassa malati e sussidi, permessi B/G
- Governo e parlamento cantonale: leggi, preventivo, servizi pubblici
- Casa e affitti, costo della vita nel cantone
- Mobilità: strade, cantieri, chiusure, deviazioni, treni e bus, valichi di confine
- Cronaca locale NEL cantone con un impatto pratico documentato (strada chiusa, servizio interrotto, evacuazione)
${contextLine(p)}
NON sono nesso reale: cronaca nera, sport, cultura ed eventi senza impatto pratico, fatti di altri cantoni o paesi senza ricadute sul cantone.

Se il nesso NON c'è, RIFIUTATI e restituisci SOLTANTO:
{
  "abort_topical_relevance": true,
  "reason": "<1-2 frasi: perché la fonte non ha un nesso reale con chi vive o lavora nel Canton ${name}>"
}
NON inventare un angolo "implicazioni per i frontalieri" né consigli generici al posto del nesso.`,
    styleColorLine: `Colore locale: comuni, enti e istituzioni del Canton ${name} (governo e parlamento cantonale, uffici cantonali) citati dalla fonte; cifre in CHF.`,
    systemRoleQualifier: `di affari del Canton ${name}`,
    expandPersona: `Sei un giornalista esperto di affari del Canton ${name} (lavoro, fisco, servizi, mobilità).`,
    // L'espansione di un body corto gira DOPO il fact-check: niente fatti
    // nuovi, come per la cronaca locale (expandEnrichmentLine in create-article).
    expandEnrichmentLine: `- Aggiungi PROFONDITÀ solo con ciò che il testo già contiene: dettagli dei fatti, contesto del Canton ${name} e implicazioni pratiche per chi vive o lavora nel cantone che il testo già documenta. NON aggiungere NESSUN fatto, numero, comune, altro cantone, normativa, data o importo che non sia già scritto nel TESTO ATTUALE qui sopra.`,
    imagePromptSchemaLine: `"imagePrompt": "Prompt per immagine editoriale fotorealistica DSLR di una scena del Canton ${name} pertinente al tema, che non sembri AI. Max 2 frasi EN.",`,
    fallbackImagePrompt: `Professional editorial photo for a regional Swiss news article about the canton of ${name}. A recognizable local scene appropriate to the topic, natural warm lighting.`,
  });
}
