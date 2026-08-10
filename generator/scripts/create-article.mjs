#!/usr/bin/env node
/**
 * create-article.mjs — Generate a complete blog article using Gemini AI.
 *
 * Usage:
 *   node scripts/create-article.mjs                 # auto-scan Ticino news sources
 *   node scripts/create-article.mjs <news-url>      # use specific URL
 *
 * Auto-scan mode (default):
 *   1. Scans multiple Ticino + frontalieri news sources for recent headlines
 *   2. Uses Gemini to select the most relevant article for frontalieri
 *   3. Checks against existing articles to avoid duplicates
 *   4. Generates full article in 4 languages + image
 *
 * Requires: GH_MODELS_PAT env var (text), GEMINI_API_KEY env var (images)
 *
 * What it does:
 *   1. Fetches the web page content at the given URL
 *   2. Calls Gemini 2.0 Flash to generate article data in 4 languages
 *   3. Generates a contextual article image using Gemini native image generation
 *   4. Validates CTA presence and enforces internal links to site tools
 *   5. Programmatically detects duplicates (Jaccard similarity on titles + ID/slug checks)
 *   6. Modifies 9 source files to register the new article
 *   5. Updates sitemap-blog.xml with the new article URL and hreflang alternates
 *   6. Stages all modified files with git add
 *
 * ══════════════════════════════════════════════════════════════
 * REGOLE EDITORIALI — Queste regole DEVONO essere rispettate:
 * ══════════════════════════════════════════════════════════════
 *
 * 1. ANTI-AI DETECTION: Gli articoli NON devono essere riconoscibili come
 *    generati da AI. Stile giornalistico italiano naturale, con variazione
 *    nella lunghezza delle frasi, dati specifici, riferimenti locali e nomi.
 *    Evitare pattern tipici dell'AI (frasi filler, strutture ripetitive).
 *
 * 2. IMMAGINE CONTESTUALE: Generare un'immagine contestuale all'articolo
 *    tramite Gemini native image generation (modello gemini-3-pro-image-preview
 *    con fallback gemini-2.5-flash-image).
 *    Fallback: immagine del Ticino dal catalogo AVAILABLE_IMAGES.
 *    Le immagini generate vanno in public/images/blog/{article-id}.{png|jpg}.
 *
 * 3. SEO IMMAGINI: Ogni immagine deve avere ALT tag descrittivi e parlanti,
 *    con informazioni necessarie per l'indicizzazione su Google e Bing.
 *    Il campo imageAlt viene aggiunto a i18n per tutte e 4 le lingue.
 *
 * 4. DATI STRUTTURATI: Ogni articolo include Schema.org Article + ImageObject
 *    per Google e Bing, con breadcrumb, headline, datePublished, author.
 *
 * 5. SITEMAP: La sitemap-blog.xml viene aggiornata automaticamente con il nuovo URL
 *    e le varianti hreflang per tutte e 4 le lingue (it/en/de/fr + x-default).
 *
 * 6. RILEVANZA TICINO: La notizia DEVE essere rilevante per il Canton Ticino
 *    e/o le province italiane di confine (Como, Varese, VCO). Non accettare
 *    notizie generiche svizzere o dal mondo.
 *
 * 7. CTA OBBLIGATORIA: Ogni articolo DEVE terminare con un link/CTA verso
 *    uno strumento del sito. Default: il comparatore (calcolatore stipendio).
 *    Se il tema riguarda assicurazioni, pensioni, costo della vita etc.,
 *    linkare allo strumento specifico.
 * ══════════════════════════════════════════════════════════════
 */

import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, copyFileSync, existsSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { callLLM as _aiCallLLM, AI_MODELS, DEFAULT_CHAIN, getPreferredModel, isLocalLlmEnabled, getStats as getAiStats, initScoreStore, flushScores, recordModelContentFailure, recordModelContentSuccess, isQuotaExhaustedError, printRunSummary } from './lib/ai-models.mjs';
// Quota-free MT cascade (DeepL-free / Google / MyMemory / LibreTranslate /
// local Opus-MT) — the SAME translator the job crawlers + FAQ batch use
// (scripts/lib/dedicated-crawler-common.mjs, batch-add-faq-to-articles.mjs).
// Routing article translation through it instead of the generation LLM frees
// ~60% of per-article LLM calls for actual generation (the quota bottleneck).
import { freeTranslateWithRetry, balanceMarkdownMarkers } from './lib/free-translate.mjs';
import { translateFieldFreeMt, translatedStringOrNull, joinTranslatedChunks } from './lib/article-free-mt.mjs';
import { AI_SEARCH_PROMPT_BLOCK_IT } from './lib/ai-search-template.mjs';
import { tokenizeIt, jaccardSim, containmentSim, normalizeItWord, STOP_WORDS_IT } from './lib/it-text-similarity.mjs';
import { fixMicrocopy } from './lib/it-microcopy-guard.mjs';
import { DOMAIN_DUP_STOPLIST, filterDistinctive } from './lib/dup-stoplist.mjs';
import { stripCodeFences, findMatchingClose, fixJsonStringBody, JSON_QUOTE_SAFETY_RULE_IT, describeJsonParseError, describeRawForDiagnostics } from './lib/llm-json-repair.mjs';
import {
  factCheckFingerprint,
  totalMajorWeight,
  MAJOR_BLOCK_WEIGHT_THRESHOLD,
  dropSourceContradictedIssues,
} from './lib/fact-check-consensus.mjs';
import { runFactualityGates, formatIssues, formatRemediation, buildSourceContract, FACT_CHECK_CATEGORIES } from './lib/article-factuality-gates.mjs';
import { loadDefectMemory, learnedDenylist, learnedSuspects } from './lib/article-defect-memory.mjs';
import {
  stripCompetitorPromotion,
  sanitizeNavLinkSemantics,
  stripFabricatedExamples,
} from './lib/article-sanitizers.mjs';
import { decodeHtmlEntities } from './lib/decode-html-entities.mjs';
import {
  PERFORMANCE_PATH as ARTICLE_PERF_PATH,
  CONSUMED_PATH as CONSUMED_TRACKER_PATH,
  TODAY_PICKS_BY_CLUSTER_PATH,
  EXPERIMENTAL_COUNTER_PATH,
  EVERGREEN_COUNTER_PATH,
  loadJsonSafe as _topicLoadJsonSafe,
  loadExistingItTitles as _topicLoadExistingItTitles,
  loadConsumedTracker as _topicLoadConsumedTracker,
  appendConsumedId as _topicAppendConsumedId,
  persistConsumedTracker as _topicPersistConsumedTracker,
  buildWinnerFingerprintMessage as _topicBuildFingerprintMessage,
  loadDemandVocabulary as _loadDemandVocabulary,
  loadExperimentalCandidates as _loadExperimentalCandidates,
  loadTodayPicksByCluster as _loadTodayPicksByCluster,
  persistTodayPicksByCluster as _persistTodayPicksByCluster,
  loadExperimentalCounter as _loadExperimentalCounter,
  persistExperimentalCounter as _persistExperimentalCounter,
  loadEvergreenCounter as _loadEvergreenCounter,
  persistEvergreenCounter as _persistEvergreenCounter,
  rankAndSelectHeadlines as _rankAndSelectHeadlines,
  loadEvergreenRejectedTracker as _loadEvergreenRejectedTracker,
  isEvergreenRejected as _isEvergreenRejected,
  appendEvergreenRejected as _appendEvergreenRejected,
  strikeEvergreenKeyword as _strikeEvergreenKeyword,
  EVERGREEN_STRIKE_LIMIT as _EVERGREEN_STRIKE_LIMIT,
  persistEvergreenRejectedTracker as _persistEvergreenRejectedTracker,
} from './lib/article-topic-selector.mjs';

// ── Phase 3 — Discovery pool + quota controller ──────────────────
// Slot assignment between proven and discovery pools is read from
// data/quota-state.json and tuned daily by tune-discovery-quota.mjs
// (Phase 4). Counter increments ONLY after a successful publish.
import {
  loadQuotaState as _loadQuotaState,
  saveQuotaState as _saveQuotaState,
  decideSlot as _decideSlot,
  incrementCounter as _incrementCounter,
} from './lib/scheduler/quotaController.mjs';
import { buildDiscoveryPool as _buildDiscoveryPool } from './lib/discovery/discoveryPool.mjs';
import { decodeGoogleNewsUrl } from './lib/discovery/googleNewsUrlResolver.mjs';
import { isNearDuplicate as _isNearDuplicateHeadline } from './lib/scheduler/slugSimilarity.mjs';
import { fetchWordpressSearchHeadlines } from './lib/topic-sources/wordpressSearch.mjs';
import { extractArticleText } from './lib/extract-article-text.mjs';
import { hasDomainAnchor } from './lib/discovery/domainAnchor.mjs';
import { matchesFrontaliereAnchor, matchesFrontaliereUnambiguousAnchor } from './lib/discovery/frontaliereAnchor.mjs';
import { isNonItalianScript, nonItalianScriptRatio } from './lib/itLanguageCheck.mjs';
import { checkSemanticNearDuplicate } from './lib/scoring/semanticDedup.mjs';
import { assertTopicNotRecentlyCovered, findRecentTopicCoverage } from './lib/topic-coverage-guard.mjs';
import { computeAdaptiveEvergreenThresholds } from './lib/scoring/constants.mjs';
import { detectBodyRepetition, dedupeRepeatedParagraphs, stripDuplicateTitleFromBody } from './lib/article-body-repetition.mjs';
import { loadEmbeddingStore, loadEmbeddingMeta } from './lib/scoring/embeddingMatcher.mjs';
import { appendCatalogEntry } from './generate-journalist-image-catalog.mjs';
import { ARTICLE_SECTION_CORE } from '../../engine/shared/articleSectionCore.mjs';
import { truncateToClause } from '../../host/shared/clauseTail.mjs';
import { buildStructuralEvergreenTopics } from './lib/evergreen-topic-generator.mjs';
import { corpusPath, resolveGitAddPaths } from './lib/corpus-paths.mjs';
import { NEWS_SITEMAP_WHITELIST } from '../data/news-sitemap-whitelist.mjs';
import { metaFieldRegex, unescapeTsValue } from './lib/meta-field-regex.mjs';
// Il guard sui segnaposto del prompt. Copre OGNI campo di testo pubblicato —
// corpo, FAQ, excerpt, imageAlt, title, seo — con un criterio solo, derivato
// dai letterali dello schema JSON che il prompt piu' sotto mostra al modello.
// Vedi l'intestazione del modulo per il perche' non sono tre guard.
import { cleanFaqPairs, sanitizePromptPlaceholders } from './lib/prompt-placeholder-guard.mjs';
// L'emettitore del blocco meta per-locale. Estratto da qui (era `buildMetaBlock`
// + `escapeForSingleQuoteTS` piu' sotto) perche' e' l'unico punto in cui il
// corpus decide quali campi per-locale diventano superficie pubblica, e dentro
// questo file — 11k righe, `jsdom` fra le dipendenze statiche — nessun test
// `node --test` poteva raggiungerlo. Vedi l'intestazione del modulo.
import {
  buildMetaBlock,
  escapeForSingleQuoteTS,
  META_SEO_FIELDS,
} from './lib/article-meta-block.mjs';
import { sanitizeText } from '../../scripts/lib/sanitize-control-chars.mjs';
import { reportStrippedControlChars } from './lib/control-char-write-report.mjs';

// ── Smarter generator inputs (Phase 3 — spec 2026-05-06) ───────
// data/article-performance.json is produced weekly by Phase 1A.
// data/demand-vocabulary.json + data/experimental-candidates.json are
// produced weekly by Phase 1B (Phase A spec 2026-05-07). The legacy
// `data/topic-candidates.json` was structurally bypassed (gate 0.6
// unreachable) and got dropped 2026-05-07 — Phase B+C ranker reads
// the new files directly via `_loadDemandVocabulary` /
// `_loadExperimentalCandidates`.
// Both are OPTIONAL — when absent, generator behaves byte-identically
// to today (no fingerprint injection, no demand-driven ranker).
const _articlePerformance = _topicLoadJsonSafe(ARTICLE_PERF_PATH);
const _winnerFingerprintMessage = _articlePerformance
  ? _topicBuildFingerprintMessage(_articlePerformance)
  : null;

// ── Phase B+C — Demand-driven selection inputs ───────────────────
// data/demand-vocabulary.json: stable signals (GSC + Suggest + winnerFingerprint).
// data/experimental-candidates.json: Reddit + News-RSS exploration tier.
// Both OPTIONAL — when missing, ranker yields no picks and the legacy
// LLM-based selectArticle path takes over (byte-identical to today).
const _demandVocabulary = _loadDemandVocabulary();
const _experimentalCandidates = _loadExperimentalCandidates();

// ── Phase 2 — Cascaded scoring inputs ─────────────────────────────
// data/evidence-index.json: GSC + GA4 + PostHog + clusterStats, produced
// daily by Phase 1's build-evidence-index.mjs. When present AND the
// USE_CASCADED_SCORING flag is on (default), the ranker uses the
// GSC → embedding → cluster cascade in scripts/lib/scoring/cascadedScore.mjs
// instead of the legacy demand-vocabulary scorer.
//
// USE_CASCADED_SCORING = '0' forces the legacy path (rollback lever).
const USE_CASCADED_SCORING = process.env.USE_CASCADED_SCORING !== '0';
const _evidenceIndex = USE_CASCADED_SCORING
  ? _topicLoadJsonSafe('data/evidence-index.json')
  : null;

// ── C1 News Sitemap Whitelist ──────────────────────────────────
// REWIRED (issue #4974 item 3, §5.3). Main loaded this by regex-parsing
// `data/news-sitemap-whitelist.ts` at startup, to avoid needing a TS loader for
// one string array, and fell back to an empty list — i.e. allow-all — if the
// parse found nothing. Transported here that fallback fired every time: the
// file it looked for does not exist in this repository, so EVERY article would
// have entered sitemap-news.xml, silently, with no error and no log. That is
// the exact opposite of what the whitelist is for.
//
// It is now a vendored `.mjs` module imported statically (see
// generator/data/news-sitemap-whitelist.mjs for why a copy rather than a live
// call back into main). A missing module is now an import error, not a silent
// policy inversion. The allow-all branch below is kept, because an empty list
// is still the documented "do not block publishing" escape hatch — but it can
// no longer be reached by accident.
const NEWS_SITEMAP_WHITELIST_TOKENS = NEWS_SITEMAP_WHITELIST.map((t) => t.toLowerCase());

/**
 * Decide whether an article should be added to sitemap-news.xml.
 * `data` is the freshly-generated article object from create-article.mjs.
 * Match is case-insensitive substring across slug, title, articleSection,
 * keywords, and tags.
 *
 * NOTE this deliberately does NOT apply the 48h window that
 * `isArticleNewsEligible()` in the vendored module also enforces: an article
 * being generated right now is by definition inside it, and the window is
 * re-applied downstream by the consumer when it prunes.
 */
function isArticleEligibleForNewsSitemap(data) {
  if (NEWS_SITEMAP_WHITELIST_TOKENS.length === 0) return true; // safe default
  const slugIt = data?.slugs?.it || '';
  const titleIt = data?.content?.it?.title || '';
  const headline = data?.seo?.headline || '';
  const keywords = data?.seo?.keywords || data?.seo?.keywordsIt || '';
  const articleSection = data?.seo?.articleSection || data?.category || '';
  const tags = Array.isArray(data?.seo?.tags) ? data.seo.tags : [];
  const haystack = [slugIt, titleIt, headline, keywords, articleSection, ...tags]
    .map((v) => String(v || '').toLowerCase())
    .join('  ');
  return NEWS_SITEMAP_WHITELIST_TOKENS.some((t) => haystack.includes(t));
}

// ── Frontaliere content density check ──────────────────────
// After generating an article, verify the body text actually discusses
// frontalieri in depth. Counts keyword hits across all 3 body sections.
const FRONTALIERE_DENSITY_TERMS = [
  'frontalier', 'permesso g', 'permesso b', 'pendolar', 'transfrontalier',
  'imposta alla fonte', 'ristorn', 'lamal', 'cassa malati', 'avs', 'lpp',
  'secondo pilastro', 'stipendio svizzer', 'busta paga', 'netto svizzer',
  'dogana', 'valico', 'accordo fiscale', 'doppia imposizione',
];

function checkFrontaliereDensity(itBody) {
  const text = (itBody || '').toLowerCase();
  const hits = FRONTALIERE_DENSITY_TERMS.reduce((acc, term) => {
    return acc + (text.split(term).length - 1);
  }, 0);
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  return {
    hits,
    wordCount,
    // passes if at least 8 keyword hits OR density ≥ 1.2% of word count
    passes: hits >= 8 || (wordCount > 0 && hits / wordCount >= 0.012),
  };
}

// ── Broader topical relevance gate ──────────────────────────
// Used to skip headlines and source pages that mention a Ticino/CH/border
// town (passing the geographic anchor-gate) but have zero work / fiscal /
// permit / commute / economy signal. Catches "chiesetta ortodossa
// macedone a Locarno", "richiedenti asilo Locarnese", "risotto bronzo
// nazionale Gallarate" — geographically anchored, topically irrelevant.
const TOPICAL_KEYWORDS = [
  // Work / employment / income
  'lavor', 'impieg', 'assun', 'licenzia', 'disoccup', 'occupaz',
  'stipendi', 'salari', ' paga', 'busta paga', 'reddito', 'compens',
  'mercato del lavoro', 'posti di lavoro', 'personale', 'organico',
  // Cross-border markers
  'frontalier', 'transfrontalier', 'cross-border', 'pendolar',
  'permesso g', 'permesso b', 'permesso l', 'permesso di lavoro',
  'dogana', 'doganale', 'valico', 'frontier',
  // Fiscal / pension / health insurance
  'fisco', 'fiscal', 'tass', 'impost', 'irpef', 'ritenuta',
  'imposta alla fonte', 'doppia imposizione', 'ristorn',
  'accordo fiscale', 'nuovo accordo', 'tassazione',
  'avs', 'ahv', 'lpp', 'lamal', 'cassa malati', 'pension', 'previdenz',
  'secondo pilastro', 'terzo pilastro',
  // Economy / business
  'economi', 'mercato', 'inflazion', 'rincari', 'carovita',
  'cambio', 'franco svizzer', ' chf', 'eur/chf',
  'impres', 'azien', 'industri', 'fabbric', 'multinazional',
  'banc', 'bors', 'investiment', 'finanz',
  // Transport / commute
  'treno', 'ferrovi', 'tilo', 'autostrada', 'mobilit', 'traffic',
  // Housing
  'alloggio', 'affitto', 'immobil',
  // Policy / politics affecting frontalieri
  'referendum', 'votazion', 'parlament', 'consigli federal',
  'sindacat', 'sciopero', 'ccl', 'contratto collettivo',
  // Education / training tied to work
  'formaz', 'apprendistat', 'tirocin',
  // Local events / culture / leisure (2026-07-17): data-justified addition —
  // 3 of the top 12 winners in data/article-performance.json's 30-day
  // composite score are Ticino border-town events/discount-card content
  // (venditti-estival-lugano-2026, estate-chiasso-2026-eventi,
  // moon-stars-resident-discount-locarno-card), proving real traffic beyond
  // strict frontaliere tax/work/permit topics. Deliberately narrow stems to
  // limit false-positive risk (no generic 'weekend'/'sconto').
  'festival', 'sagra', 'mercatin', 'fiera', 'manifestazion',
  'spettacol', 'rassegna', 'concert',
];

// ── National (svizzera) extension of the topical lexicon ────
// TOPICAL_KEYWORDS above is a FRONTALIERE lexicon: it was assembled to keep
// cross-border work/fiscal/permit news and to drop Ticino cronaca. Applied
// unchanged to the `svizzera` section — which is national by design and whose
// classifier prompt says "NON sei limitato ai frontalieri" — it is not merely
// too tight, it is aimed at the wrong target. Measured 2026-08-10 on 538 real
// headlines fetched from the 18 reachable NEWS_SOURCES_SVIZZERA:
//
//   anchor-gate pass ........ 495
//   + TOPICAL_KEYWORDS ...... 77  (16%)  ← what the section runs on today
//   + this list ............. 188 (38%)
//
// The 111 recovered are the national agenda the frontaliere list has no words
// for: "Svizzera: PIL in crescita", "L'export svizzero in ripresa", "BNS in
// perdita di mezzo miliardo", "Il franco sempre più forte", "Impennata dei
// fallimenti in Svizzera", "KOF, prospettive congiunturali 2026", "Iniziativa
// 10 milioni", "Rösti: gli obiettivi climatici", "Siccità, aiuti federali per
// l'agricoltura". Meanwhile the survivors under the frontaliere list included
// "Il lavoro mortale dei giornalisti in Messico" and "Disinformazione russa
// colpisce in Francia" (they contain `lavor`), which the classifier then
// rejected — so on this section the gate was costing recall without buying
// precision. Precision here is the classifier's job (it has the national
// prompt at `classifyFrontaliereRelevance`); this list only has to stop the
// pool from being an unbounded feed dump.
//
// Deliberately NOT a full disable of the drop. Sampled 25 real runs
// 2026-08-10: the frontaliere section reaches the pre-spend classifier with
// 47-56 candidates per run and that is the cost the pipeline is built for.
// Dropping the topical gate entirely would send ~495 per run. Keeping a list
// lands svizzera in the same band instead of a new cost regime.
//
// Stems are substring matches, so they are chosen to avoid the obvious
// Italian collisions: no bare `utile` (matches "inutile"), no `fusion`
// (matches "confusione"), no `oro` (matches "lavoro"), no `import` (matches
// "importante"), no `volo` (matches "volontario"), no `legge` (matches
// "leggere" — `legisla` instead), no `cure` (matches "sicure").
const SVIZZERA_TOPICAL_KEYWORDS = [
  ...TOPICAL_KEYWORDS,
  // Macro / national accounts / foreign trade
  'congiuntur', 'crescita', 'recession', 'prodotto interno lordo',
  'export', 'esportazion', 'importazion', 'dazi', 'tariff',
  'commercio', 'libero scambio', 'accordo commercial',
  // Prices, purchasing power, money
  'prezz', 'costo della vita', 'potere d\'acquisto', 'costos', 'più caro',
  'bns', 'bce', 'franco', 'debito pubblico', 'budget', 'preventivo',
  // Corporate results / labour-market signals
  'fatturat', 'ricav', 'trimestre', 'semestre', 'bilancio', 'dividend',
  'perdita', 'fallimen', 'insolven', 'acquisizion', 'delocalizza',
  // Energy / climate / environment — federal policy, missing entirely above
  'energi', 'elettric', 'nuclear', 'solar', 'eolic', 'idroelettric', 'penuria',
  'clima', 'climatic', 'ambient', 'co2', 'emission', 'siccit',
  // Health system (beyond the LAMal terms the frontaliere list already has)
  'sanit', 'salute', 'ospedal', 'medic', 'farmac', 'assicurazion',
  'malatti', 'vaccin',
  // Education / research
  'scuola', 'scolast', 'universit', 'student', 'istruzion', 'ricerca',
  // Migration / residence / free movement. `asilo` is deliberately here and
  // NOT in TOPICAL_KEYWORDS: asylum policy is national agenda, while for the
  // frontaliere section "richiedenti asilo nel Locarnese" is exactly the
  // anchored-but-off-topic cronaca that list exists to drop.
  'migran', 'migrazion', 'asilo', 'immigrazion', 'stranier',
  'naturalizzazion', 'permesso di dimora', 'libera circolazion',
  // Digital / tech / critical infrastructure
  'digital', 'intelligenza artificial', 'cyber', 'hacker', 'informatic',
  'telecom', 'internet', 'dati personal', 'data center',
  // Federal institutions / lawmaking / direct democracy
  'consiglio federale', 'consiglio nazionale', 'consiglio degli stati',
  'iniziativ', 'legisla', 'ordinanza', 'riforma', 'decret',
  'bilateral', 'unione europea', 'neutralit',
  'esercito', 'difesa', 'protezione civil',
  // Statistics / population
  'statistic', 'popolazion', 'demograf', 'censimento',
  // Housing (beyond alloggio/affitto/immobil above)
  'sfratto', 'pigione', 'locazion',
  // National transport infrastructure
  'ffs', 'aeroport', 'aviazion', 'gottardo',
  // Agriculture / food supply
  'agricol', 'contadin', 'allevament', 'derrate',
];

/**
 * The topical lexicon for the section this process is generating for.
 *
 * Read through a function rather than a module-scope const because
 * `IS_FRONTALIERE` is initialised ~1600 lines below this point; every caller
 * runs long after that, which is the same pattern `applyPreSpendTopicGate`
 * already relies on.
 */
function sectionTopicalKeywords(national) {
  const isNational = national === undefined ? !IS_FRONTALIERE : Boolean(national);
  return isNational ? SVIZZERA_TOPICAL_KEYWORDS : TOPICAL_KEYWORDS;
}

// ── Admission lexicon (issue #189) ──────────────────────────
// TOPICAL_KEYWORDS is read for two different jobs that must not share a
// lexicon: RANKING (ordering already-safe candidates, e.g. the svizzera
// restore backstop below) and ADMISSION (deciding whether a candidate is
// worth paying for a full generation attempt — the headline topical-gate and
// the pre-LLM source pre-filter in generateAndValidateArticle). The
// admission gates feed candidates toward REGOLA #0 / the frontaliere-density
// check (FRONTALIERE_DENSITY_TERMS above), which has no events/culture
// terms. A candidate that only matches 'festival'/'sagra'/etc. therefore
// sailed through admission and was rejected only after a full paid
// generation — the Locarno Film Festival case measured in #189. The 8
// events/culture tokens (added 2026-07-17, see the comment on
// TOPICAL_KEYWORDS above) are excluded from the admission lexicon; they stay
// in TOPICAL_KEYWORDS for ranking, where they are justified by real traffic
// data. Scoped to the frontaliere section only: the national (svizzera)
// section has no equivalent downstream density gate (both checks above are
// `if (IS_FRONTALIERE)`-only), so there is no contradiction to fix there.
const FRONTALIERE_EVENTS_CULTURE_KEYWORDS = new Set([
  'festival', 'sagra', 'mercatin', 'fiera', 'manifestazion',
  'spettacol', 'rassegna', 'concert',
]);
const FRONTALIERE_ADMISSION_KEYWORDS = TOPICAL_KEYWORDS.filter(
  (k) => !FRONTALIERE_EVENTS_CULTURE_KEYWORDS.has(k)
);

function sectionAdmissionKeywords(national) {
  const isNational = national === undefined ? !IS_FRONTALIERE : Boolean(national);
  return isNational ? SVIZZERA_TOPICAL_KEYWORDS : FRONTALIERE_ADMISSION_KEYWORDS;
}

function hasAdmissionSignal(text, national) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return sectionAdmissionKeywords(national).some(k => lower.includes(k));
}

function countAdmissionHits(text, national) {
  if (!text || typeof text !== 'string') return 0;
  const lower = text.toLowerCase();
  return sectionAdmissionKeywords(national).reduce((acc, k) => acc + (lower.split(k).length - 1), 0);
}

function hasTopicalSignal(text, national) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return sectionTopicalKeywords(national).some(k => lower.includes(k));
}

function countTopicalHits(text, national) {
  if (!text || typeof text !== 'string') return 0;
  const lower = text.toLowerCase();
  return sectionTopicalKeywords(national).reduce((acc, k) => acc + (lower.split(k).length - 1), 0);
}

// ── Pre-spend topic gate (REGOLA #0 short-circuit, 2026-05-15) ──
// REGOLA #0 (the in-prompt frontaliere-angle check inside the article-gen
// LLM) is correct but expensive: each abort burns ~5-7k tokens for the full
// article-generation call before the LLM realises the source has no real
// frontaliere nexus. Pattern from run #25878332289: 4/5 attempts aborted on
// REGOLA #0 (Cantello-litter cronaca-nera variants), 5th hit a quota wall.
//
// This cheap pre-spend gate fires BEFORE the article-gen `Tentativo` loop:
//
//  (1) CLASSIFIER (ALWAYS) — every candidate headline goes through a tiny LLM
//      (gemini-2.5-flash-lite, ~50 output tokens, no schema mode) to answer
//      "is this directly relevant to frontalieri Ticino-Italia? yes/no".
//      Off-topic → drop, no expensive article-gen attempt.
//
//      Earlier iteration (2026-05-15 morning) had an anchor-regex fast-path
//      that accepted headlines without a classifier call when they matched a
//      high-precision token (frontalier/ristorni/LAMal/…). Run #25889568431
//      (22:35 UTC) showed the fast-path was too permissive: 6/6 candidates
//      matched an anchor (e.g. URL contained "frontaliere" as adjective in
//      "cittadino frontaliere fined for litter"), classifier never ran, all
//      6 were then REJECTED by REGOLA #0 post-gen — 25 min + ~150 model
//      calls wasted. Anchor match alone is no longer enough; the classifier
//      MUST confirm every candidate. `matchesFrontaliereAnchor` is still
//      imported and could be fed to the classifier as a hint, but it
//      never short-circuits the cheap LLM step.
//
//  (2) Results are memoised in-process by lowercased headline so a re-used
//      headline (cross-pool, retry) costs zero on the second visit.
//
// REGOLA #0 in the article-gen prompt stays in place as defense-in-depth:
// the goal is for it to fire 0-1 times per run instead of 3-4.
//
// Env gates:
//  - PRESPEND_TOPIC_GATE=0  → disable entirely (rollback, no gate at all)
//  - PRESPEND_TOPIC_GATE_CLASSIFIER=0  → legacy anchor-only fast-path
//    (emergency rollback to pre-2026-05-15 behaviour, accepts on anchor
//    match without LLM confirmation). Default is "classifier-always".
//  - PRESPEND_GATE_MODEL=<id>  → override classifier model (default
//    AI_MODELS.GEMINI_FLASH_LITE)

// Strict frontaliere anchors — high-precision regex set. Headlines that
// match ANY anchor are accepted without an LLM call. The list is in a
// dedicated module so unit tests can import it without triggering this
// script's top-level main() call.
// See: scripts/lib/discovery/frontaliereAnchor.mjs

// In-process memoisation for the classifier (per-run). Keyed by lowercased
// headline so duplicates / cross-pool overlap pay once.
const _preSpendGateCache = new Map();

/**
 * Cheap LLM classifier: "is this news directly relevant to frontalieri
 * Ticino-Italia?". Returns { relevant: boolean, reason: string }.
 *
 * Strict contract: ~50 output tokens, no jsonMode (AI_MODELS_SCHEMA_MODE=off
 * is honored by the centralised callLLM). Parsing is regex-based to
 * tolerate small variations in the model output.
 *
 * Failure mode: if the classifier itself errors (network, quota, parse),
 * we DO NOT drop the headline — return { relevant: true, reason: '...' }.
 * Defense-in-depth: REGOLA #0 inside article-gen still catches whatever
 * the classifier missed. Better to spend an article-gen attempt than to
 * silently drop a legit headline because of a transient classifier error.
 *
 * `sourceUrl` (2026-08-10): the anchor gates are computed on `headline + url`
 * while the classifier used to see the title alone, so the LLM was asked to
 * decide on strictly less evidence than the regex it is supposed to arbitrate.
 * "Errare humanum est" is undecidable as a title and obvious once you can see
 * it came from `laregione.ch/culture/locarno-film-festival`. Only the host +
 * path is passed — no query string, which carries tracking parameters and no
 * editorial signal.
 */
function classifierSourceHint(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    return `${u.host}${u.pathname}`.slice(0, 160);
  } catch {
    // Not a parseable absolute URL (relative href, malformed feed link):
    // pass it through verbatim rather than losing the signal entirely.
    return raw.split('?')[0].slice(0, 160);
  }
}

async function classifyFrontaliereRelevance(headline, summary, sourceUrl) {
  const sourceHint = classifierSourceHint(sourceUrl);
  // The hint is part of the prompt, so it must be part of the memo key —
  // otherwise the same title from two different sections of two different
  // outlets would resolve to whichever verdict was computed first. Trimmed
  // once so the `if (cacheKey)` guards on the write paths below test exactly
  // the emptiness this read tests: a key of " " would be written, never read.
  const cacheKey = `${String(headline || '').toLowerCase().trim()} ${sourceHint.toLowerCase()}`.trim();
  if (cacheKey && _preSpendGateCache.has(cacheKey)) {
    return _preSpendGateCache.get(cacheKey);
  }
  const model = process.env.PRESPEND_GATE_MODEL || AI_MODELS.GEMINI_FLASH_LITE;
  const prompt = IS_FRONTALIERE
    ? `Sei un editor del sito frontaliereticino.ch, focalizzato ESCLUSIVAMENTE sui FRONTALIERI ITALO-SVIZZERI che lavorano in Ticino.

È RILEVANTE: lavoro/occupazione frontalieri TI, fiscalità (imposta alla fonte, ristorni, AVS/LPP), permessi B/G/C, salute (LAMal/cassa malati), trasporti pendolari, accordi Italia-Svizzera, riforme normative, mercato del lavoro ticinese, cambio CHF-EUR.

NON è rilevante:
- Cronaca dove "frontaliere/transfrontaliero" appare solo come aggettivo (cittadino frontaliere, area frontaliera, comune di confine) senza tema lavorativo/fiscale/permessi
- Frontalieri di altri confini (Francia-Svizzera, Italia-Slovenia, ecc.) non Ticino-Italia
- Eventi culturali, sportivi, festival, gastronomia (anche se localizzati a Ticino o area di confine)
- Singoli episodi di cronaca (multe, incidenti, arresti, abbandono rifiuti) senza implicazioni di policy o impatto sui pendolari
- Infrastruttura italiana lontana dal confine, eventi USA/UE senza impatto pendolare

HEADLINE: ${String(headline || '').slice(0, 240)}
${sourceHint ? `FONTE: ${sourceHint}\n` : ''}${summary ? `SOMMARIO: ${String(summary).slice(0, 320)}\n` : ''}
Rispondi ESATTAMENTE in questo formato (una riga):
relevant=<yes|no>; reason=<una frase di massimo 15 parole>`
    : `Sei un editor di un sito che informa CHIUNQUE viva o lavori in Svizzera (scala NAZIONALE: policy federale e cantonale, economia, fisco, lavoro, vita quotidiana, casa). NON sei limitato ai frontalieri.

È RILEVANTE: economia svizzera, mercato del lavoro e salari in CH, fiscalità federale/cantonale (imposte, AVS/AHV, LPP, secondo/terzo pilastro), salute e assicurazione malattia (LAMal/casse malati), costo della vita e affitti in Svizzera, alloggio e immobiliare, votazioni/referendum federali, riforme normative nazionali, BNS e franco svizzero, statistiche federali (BFS), decisioni del Consiglio federale e del Parlamento.

NON è rilevante:
- Cronaca locale senza implicazioni di policy o impatto economico/fiscale/lavorativo nazionale
- Eventi culturali, sportivi, festival, gastronomia
- Notizie estere senza impatto diretto su chi vive o lavora in Svizzera
- Singoli episodi di cronaca (multe, incidenti, arresti)
- Articoli il cui ARGOMENTO PRINCIPALE è esclusivamente frontaliero (appartengono a una sezione separata, NON a quella nazionale): permesso G/B/C per frontalieri, ristorni Ticino-Italia, imposta alla fonte/tassazione frontalieri, dogane/valichi e pendolarismo Italia-Svizzera, telelavoro frontalieri, accordo frontalieri Italia-Svizzera, soglia 20 km. In questa sezione nazionale sarebbero duplicati fuori scopo. ATTENZIONE: una riforma o statistica NAZIONALE (es. AVS/LPP, LAMal, mercato del lavoro, Consiglio federale) che menziona i frontalieri come categoria tra quelle impattate è RILEVANTE — il tema principale è nazionale, non frontaliero

HEADLINE: ${String(headline || '').slice(0, 240)}
${sourceHint ? `FONTE: ${sourceHint}\n` : ''}${summary ? `SOMMARIO: ${String(summary).slice(0, 320)}\n` : ''}
Rispondi ESATTAMENTE in questo formato (una riga):
relevant=<yes|no>; reason=<una frase di massimo 15 parole>`;

  let text = '';
  try {
    text = await _aiCallLLM(
      [{ role: 'user', content: prompt }],
      {
        model,
        temperature: 0,
        maxTokens: 80,
        timeout: 30_000,
        jsonMode: false,
      },
    );
  } catch (err) {
    // Classifier failed — fail-open. REGOLA #0 will catch anything bad.
    const fallback = { relevant: true, reason: `classifier-error: ${err?.message || 'unknown'}`, fromError: true };
    if (cacheKey) _preSpendGateCache.set(cacheKey, fallback);
    return fallback;
  }

  const verdict = /relevant\s*=\s*(yes|no|s[ìi]|si|true|false)/i.exec(text);
  const reasonMatch = /reason\s*=\s*([^\n\r]+)/i.exec(text);
  const verdictRaw = verdict ? verdict[1].toLowerCase() : '';
  // Drop only on explicit "no" / "false". Anything else (yes/sì/si/true OR
  // unparseable output) is fail-open: REGOLA #0 stays as defense-in-depth,
  // we'd rather spend one article-gen attempt than silently drop a legit
  // headline because of a small parser surprise.
  const explicitNo = verdictRaw === 'no' || verdictRaw === 'false';
  const parsed = Boolean(verdict);
  const result = {
    relevant: !explicitNo,
    reason: (reasonMatch ? reasonMatch[1] : text).trim().slice(0, 200),
    parsed,
  };
  if (cacheKey) _preSpendGateCache.set(cacheKey, result);
  return result;
}

/**
 * Pre-spend topic gate — filters a headlines[] array BEFORE the
 * article-generation `Tentativo` loop. Combines fast anchor regex with the
 * cheap LLM classifier. Returns the filtered list.
 *
 * @param {Array<{headline: string, url?: string, relatedHeadlines?: string[]}>} headlines
 * @param {object} [opts]
 * @param {number} [opts.maxClassifier=12]  - max LLM classifier calls per invocation
 * @returns {Promise<Array>} filtered headlines (preserves order)
 */
async function applyPreSpendTopicGate(headlines, opts = {}) {
  if (!Array.isArray(headlines) || headlines.length === 0) return headlines;
  if ((process.env.PRESPEND_TOPIC_GATE ?? '1') === '0') return headlines;

  // Default: classifier-always (every candidate goes through the LLM).
  // Set PRESPEND_TOPIC_GATE_CLASSIFIER=0 ONLY for emergency rollback to the
  // legacy anchor-only fast-path (pre-2026-05-15 behaviour, accepts on
  // anchor match without LLM confirmation).
  const classifierEnabled = (process.env.PRESPEND_TOPIC_GATE_CLASSIFIER ?? '1') !== '0';
  const maxClassifier = Number(opts.maxClassifier ?? headlines.length);

  const kept = [];
  let filtered = []; // { headline, reason, rawHeadline, rawAnchor }
  let classifierCalls = 0;
  let unambiguousBypasses = 0;
  // Track strict-anchor matches so the D-backstop can restore top-N if the
  // classifier rejects every candidate (run 26440805420: classifier rejected
  // 39/39 → empty proven pool → 8-cycle no_changes streak).
  const strictAnchorMatched = []; // [{ h, anchor }]

  for (const h of headlines) {
    const headlineText = String(h?.headline || '');
    const urlText = String(h?.url || '');
    const combined = `${headlineText} ${urlText}`;
    // Frontaliere anchors are domain-specific (cross-border terms-of-art) and
    // do NOT apply to the national svizzera section — there we classify every
    // candidate via the LLM (no anchor bypass, no strict-anchor backstop).
    const strictAnchor = IS_FRONTALIERE ? matchesFrontaliereAnchor(combined) : '';
    if (strictAnchor) strictAnchorMatched.push({ h, anchor: strictAnchor });

    // Legacy emergency rollback: anchor-only acceptance (no LLM).
    if (!classifierEnabled) {
      if (strictAnchor) {
        kept.push(h);
      } else {
        filtered.push({ headline: headlineText.slice(0, 80), reason: 'anchor-miss (classifier disabled)', rawHeadline: headlineText });
      }
      continue;
    }

    // A — Unambiguous anchor → skip classifier (re-enabled 2026-05-26 on
    // a narrower regex set vs the 2026-05-15 rollback). The unambiguous
    // anchors are fiscal/legal terms-of-art (ristorni, LAMal, AVS, doppia
    // imposizione, accordo fiscale Italia-Svizzera, …) that do not leak
    // into cronaca/sports — so a hit is a high-precision keep signal and
    // does not need the classifier to confirm. The wider FRONTALIERE_STRICT
    // anchors (bare "frontalier", "valico chiasso", …) still go through
    // the classifier.
    const unambiguous = IS_FRONTALIERE && matchesFrontaliereUnambiguousAnchor(combined);
    if (unambiguous) {
      kept.push(h);
      unambiguousBypasses += 1;
      continue;
    }

    // Budget exhausted — fail-open, keep the headline. REGOLA #0 stays as
    // the defense-in-depth backstop. With the default maxClassifier =
    // headlines.length this branch is effectively unreachable unless a
    // caller overrides opts.maxClassifier.
    if (classifierCalls >= maxClassifier) {
      kept.push(h);
      continue;
    }

    // Classifier path — for candidates that did not hit an unambiguous
    // anchor. The strict-anchor signal could be passed as a hint, but
    // strict-anchor match alone (e.g. bare "frontalier") must NOT bypass
    // the classifier (see comment block above).
    classifierCalls += 1;
    const summary = Array.isArray(h?.relatedHeadlines) && h.relatedHeadlines.length > 0
      ? h.relatedHeadlines.slice(0, 2).join(' · ')
      : '';
    let verdict;
    try {
      verdict = await classifyFrontaliereRelevance(headlineText, summary, urlText);
    } catch {
      // Should not happen — classifyFrontaliereRelevance already fails open
      // — but belt+suspenders: keep the headline on any unexpected throw.
      kept.push(h);
      continue;
    }
    if (verdict.relevant) {
      kept.push(h);
    } else {
      filtered.push({ headline: headlineText.slice(0, 80), reason: verdict.reason, rawHeadline: headlineText });
    }
  }

  // D — Backstop: if the classifier rejected every candidate but at least
  // one had a strict-anchor match, restore the top-3 anchor-matched. This
  // prevents the 100%-rejection failure mode that produced the run
  // 26440805420 no_changes streak. REGOLA #0 inside article-gen stays as
  // the final defense if the restored candidate is actually off-topic.
  const totalRejection = kept.length === 0 && headlines.length > 0;
  let restoredByBackstop = 0;
  let backstopKind = 'none';
  if (kept.length === 0 && strictAnchorMatched.length > 0) {
    const RESTORE_N = 3;
    const restore = strictAnchorMatched.slice(0, RESTORE_N);
    const restoreSet = new Set(restore.map(r => String(r.h?.headline || '')));
    for (const { h, anchor } of restore) {
      kept.push(h);
      restoredByBackstop += 1;
      const ht = String(h?.headline || '').slice(0, 80);
      console.error(`  🛟 Pre-spend gate backstop: ripristinato headline anchor-matched (anchor="${anchor}"): "${ht}…"`);
    }
    filtered = filtered.filter(f => !restoreSet.has(f.rawHeadline));
    backstopKind = 'anchor';
  }

  // E — Section backstop for the NATIONAL (svizzera) pool.
  //
  // Backstop D above cannot fire here and never could: it needs a
  // strict-anchor hit, the anchors are frontaliere terms-of-art, and the loop
  // sets `strictAnchor = IS_FRONTALIERE ? … : ''`. So `anchor_candidates` is 0
  // by construction on this section and a 100% classifier rejection meant the
  // pool reached generation empty with nothing able to intervene. Measured
  // 2026-08-10 over 11 sampled svizzera runs: 10 ended
  // `emptied=1 recovered=none status=skipped`, the 11th `deferred` — the
  // section published no news article in any of them.
  //
  // Rank by topical density rather than pool order: the national lexicon above
  // is a recall instrument, and its hit count is the only cheap signal we have
  // for "most on-agenda of a bad lot". Ties keep pool order, which is recency.
  // This is deliberately a LAST-RESORT restore, not a relaxation — it runs
  // only when the classifier said no to everything, and REGOLA #0 inside
  // article-gen (topicGateAbort) stays the final arbiter exactly as it does
  // for the frontaliere branch after backstop D.
  if (kept.length === 0 && !IS_FRONTALIERE && headlines.length > 0) {
    const RESTORE_N = Math.max(1, Number(process.env.PRESPEND_GATE_SECTION_RESTORE_N ?? '3') || 3);
    const ranked = headlines
      .map((h, i) => ({ h, i, hits: countTopicalHits(`${h?.headline || ''} ${h?.url || ''}`) }))
      .sort((a, b) => (b.hits - a.hits) || (a.i - b.i))
      .slice(0, RESTORE_N);
    const restoreSet = new Set(ranked.map(r => String(r.h?.headline || '')));
    for (const { h, hits } of ranked) {
      kept.push(h);
      restoredByBackstop += 1;
      const ht = String(h?.headline || '').slice(0, 80);
      console.error(`  🛟 Pre-spend gate backstop di sezione (${SECTION_NAME}): ripristinato headline (topical-hits=${hits}): "${ht}…"`);
    }
    filtered = filtered.filter(f => !restoreSet.has(f.rawHeadline));
    backstopKind = 'topical';
  }

  // ── Total-rejection telemetry (issue #113) ──────────────────────────
  // The gate emptying the whole pool is NOT visible in the line below:
  // "0 candidates → 0" and "40 candidates → 0" print through the same
  // template, and neither says whether the D-backstop then put something
  // back. Measuring issue #113 required downloading 400 run logs and
  // reconstructing the state from three separate lines; this single
  // machine-readable record makes the same question a two-grep job:
  //
  //   grep -c 'PRESPEND_GATE_TOTAL_REJECTION'                → how often
  //   grep -c 'PRESPEND_GATE_TOTAL_REJECTION .* restored=0'  → …unrecovered
  //
  // `anchor_candidates` is the field that says whether the D-backstop had
  // anything to work with: it needs a strict-anchor hit, and anchors are
  // frontaliere-specific (`IS_FRONTALIERE ? … : ''`), so on the svizzera
  // section it is 0 by construction. Measured over 224 real runs
  // 2026-08-06→10: 124 total rejections, restored=0 in every one — 0 was the
  // only value anchor_candidates could take there, so D stayed silent.
  //
  // 2026-08-10: that is now the diagnosis, not the outcome. Backstop E above
  // restores by topical density when the section has no anchor set, so a
  // svizzera total rejection reads `anchor_candidates=0 restored=3
  // backstop=topical` — anchor_candidates still explains why D was silent,
  // `backstop` says who answered instead. `restored=0` after this change means
  // nothing recovered the pool and is the line worth alerting on.
  if (totalRejection) {
    console.error(
      `PRESPEND_GATE_TOTAL_REJECTION before=${headlines.length} classifier_calls=${classifierCalls}`
      + ` anchor_candidates=${strictAnchorMatched.length} restored=${restoredByBackstop}`
      + ` backstop=${backstopKind} kept_after=${kept.length} section=${SECTION_NAME}`,
    );
  }

  const dropped = headlines.length - kept.length;
  if (classifierCalls > 0 || dropped > 0 || unambiguousBypasses > 0) {
    const reasonsSummary = filtered.slice(0, 3).map(f => f.reason).join(' | ');
    // "frontaliere-relevant" is what the classifier decided only on the
    // frontaliere section; on svizzera it answered a national prompt, and a
    // log line claiming otherwise is how a section-blind gate hides.
    const keptLabel = IS_FRONTALIERE ? 'frontaliere-relevant' : `rilevanti per la sezione ${SECTION_NAME}`;
    console.error(
      `  🔍 Pre-spend topic gate: ${headlines.length} candidates → ${kept.length} ${keptLabel} `
      + `(classifier-calls=${classifierCalls}, anchor-bypass=${unambiguousBypasses}, dropped=${dropped}${reasonsSummary ? `: ${reasonsSummary}` : ''})`,
    );
    if (filtered.length > 0) {
      for (const f of filtered.slice(0, 5)) {
        console.error(`     ↪ filtrato: "${f.headline}…" — ${f.reason}`);
      }
    }
  }
  for (const f of filtered) {
    recordDiscardedHeadline({
      reason: 'not_frontaliere_relevant',
      headline: f.rawHeadline,
      classifierReason: f.reason,
    });
  }
  if (typeof RUN_REPORT === 'object' && RUN_REPORT?.headlines) {
    RUN_REPORT.headlines.droppedPreSpendGate = (RUN_REPORT.headlines.droppedPreSpendGate || 0) + dropped;
    RUN_REPORT.headlines.preSpendGateClassifierCalls = (RUN_REPORT.headlines.preSpendGateClassifierCalls || 0) + classifierCalls;
    RUN_REPORT.headlines.preSpendGateRan = true;
    RUN_REPORT.headlines.preSpendGateBefore = headlines.length;
    RUN_REPORT.headlines.preSpendGateKept = kept.length;
    RUN_REPORT.headlines.preSpendGateAnchorCandidates = strictAnchorMatched.length;
    RUN_REPORT.headlines.preSpendGateBackstopRestored = restoredByBackstop;
    if (totalRejection) RUN_REPORT.headlines.preSpendGateTotalRejection = true;
  }
  return kept;
}

// ── Config ──────────────────────────────────────────────────
// Gemini — image generation (text calls now go through centralized ai-models.mjs)
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const IMAGE_MODEL_PRO = 'gemini-3-pro-image-preview';
const IMAGE_MODEL_FLASH = 'gemini-2.5-flash-image';
const BASE_URL = 'https://frontaliereticino.ch';

// Model aliases for callLLM opts (used by callers that pass opts.model)
const GH_MODEL_HEAVY = AI_MODELS.GPT4O;
const GH_MODEL_LIGHT = AI_MODELS.GPT4O_MINI;
const BLOG_IMAGE_TARGET_MAX_BYTES = 220 * 1024; // target ~220KB
const BLOG_IMAGE_HARD_MAX_BYTES = 320 * 1024;   // hard cap ~320KB
const MIN_BODY_CHARS = 2500;  // ~400 words minimum; 800 chars was too permissive
const MIN_BODY_CHARS_FLOOR = Math.max(
  1500,
  Number.parseInt(process.env.MIN_BODY_CHARS_FLOOR || '1800', 10) || 1800,
);
/**
 * Companion to computeAdaptiveMinWords: scales the chars-based thin-content
 * gate when the source is short. Without this, a successful 400-word
 * adaptive run (~2400 chars) trips the static 2500-char floor and is
 * either re-expanded into hallucination or rejected outright at the
 * final guard. Mirrors the word-ladder thresholds.
 *   - source ≥ 4000 chars → full 2500-char target
 *   - source 2000-3999    → 2200 chars
 *   - source 1000-1999    → 1900 chars
 *   - source < 1000       → MIN_BODY_CHARS_FLOOR (1800 chars)
 */
function computeAdaptiveMinChars(sourceText) {
  const len = (sourceText || '').length;
  if (len >= 4000) return MIN_BODY_CHARS;
  if (len >= 2000) return Math.max(MIN_BODY_CHARS_FLOOR, 2200);
  if (len >= 1000) return Math.max(MIN_BODY_CHARS_FLOOR, 1900);
  return MIN_BODY_CHARS_FLOOR;
}

// Static places catalog
const PLACES_IMAGES = [
  'ascona.webp', 'bellinzona.webp', 'castelgrande.webp', 'film-festival.webp',
  'foroglio.webp', 'foxtown.webp', 'gandria.webp', 'lac-lugano.webp',
  'lago-lugano.webp', 'locarno.webp', 'lugano-view.webp', 'mendrisio.webp',
  'monte-bre.webp', 'monte-generoso.webp', 'monte-san-salvatore.webp',
  'swissminiatur.webp',
];

// Build full fallback pool: places + all existing blog images (auto-grows)
// Exclude the 10 most recent blog images so the homepage doesn't show duplicates
const BLOG_IMAGES = (() => {
  try {
    const all = readdirSync(resolve('public/images/blog')).filter(f => f.endsWith('.webp')).sort();
    const light = all.filter((f) => {
      try {
        return statSync(resolve(`public/images/blog/${f}`)).size <= BLOG_IMAGE_HARD_MAX_BYTES;
      } catch {
        return false;
      }
    });
    // Prefer lightweight assets for fallback rotation; if none, keep full list.
    return light.length > 0 ? light : all;
  }
  catch { return []; }
})();

// Combined pool with full paths for fallback rotation
// Skip images used by the last 7 articles to avoid visual repetition on homepage
const RECENT_ARTICLE_IMAGE_COUNT = 7;

function _getRecentArticleImages() {
  try {
    // FRO-360: ARTICLES array is now in data/blog-articles-data.ts.
    // v1 simplification: this homepage image-dedup helper always reads the
    // frontaliere registry (and the shared image catalog) for BOTH sections —
    // it only avoids visual repetition of recently-used hero images, so cross-
    // section reuse is harmless. Module-eval timing also predates SECTION.
    const blogSrc = readFileSync(resolve('data/blog-articles-data.ts'), 'utf8');
    // Extract all image: '...' values from the ARTICLES array
    const imageMatches = [...blogSrc.matchAll(/image:\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
    // Last N are the most recent articles
    return imageMatches.slice(-RECENT_ARTICLE_IMAGE_COUNT);
  } catch { return []; }
}

function _buildFallbackPool() {
  const recentImages = new Set(_getRecentArticleImages());
  const allImages = [
    ...PLACES_IMAGES.map(f => `/images/places/${f}`),
    ...BLOG_IMAGES.map(f => `/images/blog/${f}`),
  ];
  const filtered = allImages.filter(img => !recentImages.has(img));
  // If filtering removes too many, keep at least places
  return filtered.length > 5 ? filtered : allImages;
}

const FALLBACK_IMAGES = _buildFallbackPool();

// Legacy: keep AVAILABLE_IMAGES for prompt catalog (AI picks from places names)
const AVAILABLE_IMAGES = PLACES_IMAGES;

// ─── Keyword-based fallback image matching ───────────────────────────────
// Maps keywords (found in article title/id/category) to the best fallback image.
// First match wins. Keys are lowercase. Values are paths from any pool image.
//
// Strategy: first try blog images whose filename contains the keyword (e.g.
// "salario-minimo-ticino-..." matches keyword "salario"), then fall back to
// curated place image mappings for broader themes.
const IMAGE_KEYWORD_MAP = [
  // Ticino places → matching place images
  { keywords: ['ascona'], image: '/images/places/ascona.webp' },
  { keywords: ['bellinzona', 'gendarmi', 'polizia', 'cantone', 'cantonale', 'governo', 'gran consiglio', 'amministrazione'], image: '/images/places/bellinzona.webp' },
  { keywords: ['castelgrande', 'castello', 'castelli', 'patrimonio', 'unesco'], image: '/images/places/castelgrande.webp' },
  { keywords: ['film', 'festival', 'cinema', 'locarno festival'], image: '/images/places/film-festival.webp' },
  { keywords: ['foroglio', 'cascata', 'bavona', 'cevio', 'maggia', 'vallemaggia'], image: '/images/places/foroglio.webp' },
  { keywords: ['foxtown', 'outlet', 'shopping', 'moda', 'fashion', 'negozio', 'acquisti', 'commercio'], image: '/images/places/foxtown.webp' },
  { keywords: ['gandria', 'contrabbando', 'museo doganale'], image: '/images/places/gandria.webp' },
  { keywords: ['lac-lugano', 'ceresio', 'navigazione', 'battello', 'crociera'], image: '/images/places/lac-lugano.webp' },
  { keywords: ['lago', 'lugano', 'paradiso', 'campione'], image: '/images/places/lago-lugano.webp' },
  { keywords: ['locarno', 'locarnese', 'brissago', 'gambarogno', 'muralto'], image: '/images/places/locarno.webp' },
  { keywords: ['lugano', 'centro', 'città', 'urbano', 'usi', 'università'], image: '/images/places/lugano-view.webp' },
  { keywords: ['mendrisio', 'chiasso', 'dogana', 'confine', 'frontiera', 'frontalier', 'valico', 'stabio', 'bizzarone', 'como'], image: '/images/places/mendrisio.webp' },
  { keywords: ['monte brè', 'bré', 'funicolare'], image: '/images/places/monte-bre.webp' },
  { keywords: ['monte generoso', 'generoso', 'ferrovia', 'cremagliera'], image: '/images/places/monte-generoso.webp' },
  { keywords: ['san salvatore', 'salvatore', 'panorama'], image: '/images/places/monte-san-salvatore.webp' },
  { keywords: ['swissminiatur', 'miniatura', 'melide', 'turismo', 'attrazione'], image: '/images/places/swissminiatur.webp' },
  // Thematic fallbacks (broader topics)
  { keywords: ['fisco', 'fiscal', 'tass', 'imposta', 'irpef', 'iva', 'dichiarazione', 'reddito', 'stipendio', 'salario', 'busta paga'], image: '/images/places/lugano-view.webp' },
  { keywords: ['treno', 'tilo', 'ffs', 'sbb', 'trasporto', 'pendolar', 'ferrovia', 'trenitalia'], image: '/images/places/locarno.webp' },
  { keywords: ['ospedale', 'sanità', 'salute', 'medic', 'lamal', 'cassa malati', 'assicurazion'], image: '/images/places/bellinzona.webp' },
  { keywords: ['lavoro', 'occupazione', 'disoccupazione', 'impiego', 'assunzion', 'contratto'], image: '/images/places/lugano-view.webp' },
  { keywords: ['scuol', 'educazione', 'formazione', 'studio', 'studente'], image: '/images/places/bellinzona.webp' },
  { keywords: ['natura', 'montagna', 'sentiero', 'escursion', 'trekking', 'alpi'], image: '/images/places/monte-generoso.webp' },
  { keywords: ['sport', 'hockey', 'calcio', 'palestra', 'atletica'], image: '/images/places/lugano-view.webp' },
  { keywords: ['cultura', 'museo', 'arte', 'mostra', 'teatro', 'musica', 'concerto'], image: '/images/places/locarno.webp' },
  { keywords: ['meteo', 'clima', 'pioggia', 'neve', 'temperature', 'alluvione', 'maltempo'], image: '/images/places/lago-lugano.webp' },
  { keywords: ['auto', 'traffico', 'strada', 'autostrada', 'incidente', 'circolazione'], image: '/images/places/mendrisio.webp' },
  { keywords: ['immobiliare', 'casa', 'affitto', 'appartamento', 'abitazione', 'residenza'], image: '/images/places/ascona.webp' },
  { keywords: ['banca', 'credito', 'finanziario', 'borsa', 'cambio', 'chf', 'euro', 'franco'], image: '/images/places/lugano-view.webp' },
  { keywords: ['pensione', 'avs', 'lpp', 'previdenza', 'pilastro', 'rendita', 'inps'], image: '/images/places/monte-san-salvatore.webp' },
  { keywords: ['ristorante', 'gastronomia', 'cucina', 'vino', 'cibo', 'grotto'], image: '/images/places/ascona.webp' },
];

/**
 * Find the best fallback image matching article content by keywords.
 * 
 * Strategy (in order):
 * 1. Search existing blog image filenames for keyword overlap with article text.
 *    Blog images are named after their article (e.g. "salario-minimo-ticino-...webp"),
 *    so matching a blog filename to article keywords gives a topically relevant image.
 * 2. Fall back to curated IMAGE_KEYWORD_MAP (places + thematic).
 * 3. Return null → caller uses hash-based random.
 *
 * Images used by the last 7 articles are excluded from all results.
 */
function findBestFallbackImage(data) {
  const recentImages = new Set(_getRecentArticleImages());

  const searchableText = [
    data.id || '',
    data.category || '',
    data.imagePrompt || '',
    (data.content?.it?.title || data.content?.title || ''),
    (data.content?.it?.excerpt || data.content?.excerpt || ''),
  ].join(' ').toLowerCase();

  // Extract meaningful words (3+ chars) from article text for matching against filenames
  const articleWords = searchableText
    .replace(/[^a-zà-ÿ0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(w => w.length >= 4);

  // Strategy 1: find a blog image whose filename shares keywords with the article
  // Score each blog image by how many article words appear in its filename
  let bestBlogMatch = null;
  let bestBlogScore = 0;
  for (const imgPath of FALLBACK_IMAGES) {
    if (recentImages.has(imgPath)) continue;
    if (!imgPath.startsWith('/images/blog/')) continue;
    const filename = imgPath.replace('/images/blog/', '').replace(/\.(jpg|webp)$/i, '').toLowerCase();
    let score = 0;
    for (const word of articleWords) {
      if (filename.includes(word)) score++;
    }
    if (score > bestBlogScore) {
      bestBlogScore = score;
      bestBlogMatch = imgPath;
    }
  }
  // Require at least 2 keyword overlaps to consider it a good match
  if (bestBlogMatch && bestBlogScore >= 2) {
    return bestBlogMatch;
  }

  // Strategy 2: curated keyword→image map (places + themes)
  for (const entry of IMAGE_KEYWORD_MAP) {
    if (recentImages.has(entry.image)) continue;
    for (const kw of entry.keywords) {
      if (searchableText.includes(kw)) {
        if (FALLBACK_IMAGES.includes(entry.image)) {
          return entry.image;
        }
      }
    }
  }

  return null;
}

const CATEGORIES = ['fiscale', 'pratico', 'novita', 'pensione'];

// ── Author registry (mirror of data/authors.ts for byline + Person JSON-LD) ──
// Keep slug/name/expertise/linkedin in sync with data/authors.ts. The TS file
// is the source of truth for the React app + author pages; this inline copy is
// used because create-article.mjs is a Node ESM script that cannot import .ts.
// Spec: docs/GOOGLE-NEWS-COMPLIANCE-PLAN.md §4 — FASE 1, A2.
const AUTHORS = Object.freeze([
  Object.freeze({
    slug: 'marco-ferrari',
    name: 'Marco Ferrari',
    linkedinUrl: 'https://www.linkedin.com/in/marco-ferrari-frontaliere-ticino/',
    expertise: Object.freeze([
      'fiscalità frontaliera',
      '730',
      'dichiarazione redditi',
      'imposta alla fonte',
      'accordo italia-svizzera 2026',
      'fiscale',
      'tasse',
      'irpef',
      'doppia imposizione',
      'ristorni',
    ]),
  }),
  Object.freeze({
    slug: 'laura-bianchi',
    name: 'Laura Bianchi',
    linkedinUrl: 'https://www.linkedin.com/in/laura-bianchi-previdenza-svizzera/',
    expertise: Object.freeze([
      'avs',
      'lpp',
      'lamal',
      'pensioni',
      'pensione',
      'assicurazioni sociali svizzere',
      'previdenza',
      '3a',
      'libero passaggio',
      'salute',
      'sanità',
      'cmi',
    ]),
  }),
  Object.freeze({
    slug: 'redazione',
    name: 'Redazione Frontaliere Ticino',
    linkedinUrl: 'https://www.linkedin.com/company/frontaliere-ticino/',
    expertise: Object.freeze([
      'lavoro frontaliere',
      'salari',
      'salario',
      'trasporti transfrontalieri',
      'dogana',
      'novita',
      'pratico',
      'attualità',
    ]),
  }),
  // Guest author added to data/authors.ts 2026-06-30 but never mirrored here —
  // pickAuthorForTopic() could never select them, so redazione articles about
  // the Italia-Svizzera cross-border tax treaty (their specialty) kept
  // falling through to marco-ferrari/round-robin instead.
  Object.freeze({
    slug: 'samuele-valente',
    name: 'Samuele Valente',
    uid: 'rAaDN0AvhkUjvRxN2TJijgYodm22',
    linkedinUrl: 'https://www.linkedin.com/in/samuele-valente-9b8a4335b/',
    // 'frontalieri' deliberately excluded: optimizeSeoMetadata()'s baseKeywords
    // (line ~5998) appends it to literally every article's seo.keywords, which
    // sectionHaystack (line ~8822) feeds into this scorer — a bare, near-
    // universal keyword here would give samuele-valente a guaranteed ≥1 score
    // on every article ever generated, ties resolved by an articleId coin-flip
    // that could silently hand this fiscal-treaty specialist's byline to
    // unrelated pensions/customs/wage articles (PR #3625 review). Only
    // compound phrases specific to this guest author's actual expertise.
    expertise: Object.freeze([
      'fiscalità transfrontaliera',
      'accordo italia-svizzera',
      'interpelli agenzia delle entrate',
      'residenza fiscale',
      'tassazione dei lavoratori frontalieri',
    ]),
  }),
]);

let _authorRoundRobinIdx = 0;

/**
 * Pick an author for an article based on its category/section + identifier.
 *
 * Strategy:
 *   1. Score each author by how many of their `expertise` keywords appear
 *      in the haystack (category + title/keywords/id) — case-insensitive
 *      substring match. Highest score wins.
 *   2. On a tie or zero matches, fall back to a deterministic bucket using
 *      `articleId` (FNV-style hash mod authors.length) so the same article
 *      always gets the same author across re-runs, while still spreading
 *      bylines across the team for generic content.
 *
 * Returns `{ slug, name, linkedinUrl }` — never `null`.
 */
function pickAuthorForTopic(articleSection, articleId) {
  const haystack = String(articleSection || '').toLowerCase();
  const scored = AUTHORS.map((author) => {
    const score = author.expertise.reduce((acc, kw) => {
      return acc + (haystack.includes(kw) ? 1 : 0);
    }, 0);
    return { author, score };
  });
  const maxScore = scored.reduce((m, s) => (s.score > m ? s.score : m), 0);
  if (maxScore > 0) {
    const winners = scored.filter((s) => s.score === maxScore).map((s) => s.author);
    if (winners.length === 1) {
      const a = winners[0];
      return { slug: a.slug, name: a.name, linkedinUrl: a.linkedinUrl };
    }
    // Tied — pick deterministically by articleId hash if provided, else round-robin.
    const idx = articleId
      ? Math.abs(_hashString(String(articleId))) % winners.length
      : _authorRoundRobinIdx++ % winners.length;
    const a = winners[idx];
    return { slug: a.slug, name: a.name, linkedinUrl: a.linkedinUrl };
  }
  // No keyword match — deterministic round-robin keyed by articleId.
  const idx = articleId
    ? Math.abs(_hashString(String(articleId))) % AUTHORS.length
    : _authorRoundRobinIdx++ % AUTHORS.length;
  const a = AUTHORS[idx];
  return { slug: a.slug, name: a.name, linkedinUrl: a.linkedinUrl };
}

/**
 * Looks up a registered guest journalist by Firebase Auth uid (see the `uid`
 * field on data/authors.ts's AUTHORS + this file's mirror). Returns
 * `undefined` if no author in the registry has that uid — callers must not
 * fall back to pickAuthorForTopic() for a known human submitter; see
 * scripts/publish-journalist-article.mjs's resolveJournalistAuthor().
 */
function getAuthorByUid(uid) {
  if (!uid) return undefined;
  const a = AUTHORS.find((author) => author.uid === uid);
  return a ? { slug: a.slug, name: a.name, linkedinUrl: a.linkedinUrl } : undefined;
}

/** Tiny FNV-1a-ish hash for stable author bucketing. Not cryptographic. */
function _hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

// SOURCE_QUOTA_FILE / SOURCE_URLS_FILE are section-keyed — see SECTION config
// below (frontaliere → data/article-source-*.json, byte-identical default).
const CREATE_ARTICLE_REPORT_FILE = process.env.CREATE_ARTICLE_REPORT_FILE || '.tmp/create-article-run-report.json';

// ── Cross-run defect memory (docs/ARTICLE-LEARNING-LOOP.md) ───────────
//
// Read ONCE per run and cached: the deterministic gates run on every retry
// attempt, and re-reading the store mid-run would let a concurrent writer
// change the rules between attempt 3 and attempt 4 of the same article.
//
// This process only READS. Observations are collected into the run report and
// folded into the store by scripts/update-article-defect-memory.mjs after the
// run, so the gate never mutates the state it is judging against and never
// learns from drafts that were rejected and never shipped.
let _DEFECT_MEMORY = null;
function defectMemory() {
  if (_DEFECT_MEMORY) return _DEFECT_MEMORY;
  const { memory, degraded } = loadDefectMemory(
    process.env.ARTICLE_DEFECT_MEMORY_FILE || 'data/article-defect-memory.json',
  );
  if (degraded) {
    // Loud, never silent: the run is about to be evaluated with a defence that
    // is not actually there. The curated lists still hold, so this degrades
    // rather than stops — but it must show up in the log and in the gate output.
    console.error(`  🚨 Memoria dei difetti illeggibile (${degraded}) — difese apprese NON attive in questo run.`);
  }
  _DEFECT_MEMORY = {
    denylist: learnedDenylist(memory),
    suspects: learnedSuspects(memory),
    degraded,
  };
  return _DEFECT_MEMORY;
}
// Source quota disabled by default 2026-05-07: with article generation
// firing every 15 min (~672 articles/week) the 3/domain weekly cap was
// rejecting 321/321 headlines — the demand-driven ranker now handles
// diversity via cluster rotation, making the per-domain quota redundant.
// Set SOURCE_QUOTA_ENABLED=1 to opt in for emergency rebalancing.
const SOURCE_QUOTA_ENABLED = process.env.SOURCE_QUOTA_ENABLED === '1';
const SOURCE_WEEKLY_QUOTA = Math.max(
  1,
  Number.parseInt(process.env.SOURCE_WEEKLY_QUOTA || '3', 10) || 3,
);
const CREATE_ARTICLE_MIN_IT_WORDS = Math.max(
  400,
  Number.parseInt(process.env.CREATE_ARTICLE_MIN_IT_WORDS || '900', 10) || 900,
);
// Floor used when the source content is too thin to support 900 words without
// inviting hallucination. Per-run adjustment in computeAdaptiveMinWords below.
const CREATE_ARTICLE_MIN_IT_WORDS_FLOOR = Math.max(
  300,
  Number.parseInt(process.env.CREATE_ARTICLE_MIN_IT_WORDS_FLOOR || '400', 10) || 400,
);
/**
 * Lower the IT-words target when the source body is short. Asking for 900 words
 * from a 400-char news brief structurally forces the model to invent facts,
 * which then trips the fact-check critical gate. Scale rules:
 *   - source ≥ 4000 chars → full 900-word target
 *   - source 2000-3999    → 700 words
 *   - source 1000-1999    → 550 words
 *   - source < 1000       → 400 words (floor)
 */
function computeAdaptiveMinWords(sourceText) {
  const len = (sourceText || '').length;
  if (len >= 4000) return CREATE_ARTICLE_MIN_IT_WORDS;
  if (len >= 2000) return Math.max(CREATE_ARTICLE_MIN_IT_WORDS_FLOOR, 700);
  if (len >= 1000) return Math.max(CREATE_ARTICLE_MIN_IT_WORDS_FLOOR, 550);
  return CREATE_ARTICLE_MIN_IT_WORDS_FLOOR;
}
// Hard cap per body field — prevents LLM overshoot during expansion from
// producing fields too large for free-tier translation models (output cap ~2048-4096 tokens).
// 1000 words ≈ 1500 tokens output → well within model caps. Fields >700 words
// are automatically sub-chunked during translation as a safety net.
const MAX_BODY_FIELD_WORDS = 1000;
const CREATE_ARTICLE_MIN_WORDS_RETRIES = Math.max(
  1,
  Number.parseInt(process.env.CREATE_ARTICLE_MIN_WORDS_RETRIES || '6', 10) || 6,
);
/** Model rotation for min-words retries: cycle through different models to maximize chances */
const MIN_WORDS_MODEL_ROTATION = [
  AI_MODELS.GPT_4_1,                 // attempt 1: gpt-4.1 (GitHub Models, different daily limit — leads so attempt 2 uses a genuinely different model if content is short)
  GH_MODEL_HEAVY,                    // attempt 2: gpt-4o (GitHub Models — moved from first: was redundant when the default generation model also uses gpt-4o)
  'gemini',                          // attempt 3: gemini-2.5-flash (Google, different provider)
  AI_MODELS.GPT_4_1_NANO,             // attempt 4: gpt-4.1-nano (GitHub Models — GPT_5_NANO killed 2026-05-18)
  AI_MODELS.GROQ_GPT_OSS_120B,       // attempt 5: GPT-OSS 120B (Groq — GROQ_KIMI_K2 swapped 2026-06-15: dead HTTP 404 "moonshotai/kimi-k2-instruct does not exist"; a dead model here triggered the full free-tier fallback cascade, ~11min wasted per pick)
  GH_MODEL_LIGHT,                    // attempt 6: gpt-4o-mini (then expansion fallback)
];

// Quality-NEUTRAL dedup for the min-words retry model pick — DEFAULT ON,
// with an explicit rollback flag per this file's usual "env-gated for
// rollback" convention (see e.g. SOURCE_DROP_OFF_TOPIC above).
// Set to '0' to restore the exact pre-existing selection (plain
// Math.min(attempt-1, rotation.length-1) clamp, duplicates allowed).
const CREATE_ARTICLE_MINWORDS_DEDUP = (process.env.CREATE_ARTICLE_MINWORDS_DEDUP ?? '1') !== '0';

/**
 * Pick the model for a given min-words retry attempt from `rotation`,
 * skipping an immediate back-to-back repeat of `previousModel` (the model
 * actually used on the attempt right before this one).
 *
 * Why this is needed: the plain index `Math.min(attempt - 1, rotation.length
 * - 1)` clamps at the LAST entry once `attempt` exceeds `rotation.length`.
 * CREATE_ARTICLE_MIN_WORDS_RETRIES (env, default 6) can be raised above
 * MIN_WORDS_MODEL_ROTATION.length (6) — every attempt beyond the rotation's
 * length would then clamp to the SAME last model as the attempt right
 * before it, back-to-back, which is a near-certain repeat of the same
 * too-short output (same model + same prompt ⇒ same failure). The same
 * clamp-collision can also happen if a caller-supplied `previousModel`
 * (from outside this loop) happens to coincide with the rotation's pick.
 *
 * Quality-NEUTRAL by construction: same set of models, same relative
 * order — this only ADVANCES to the next rotation entry (wrapping once
 * past the end) when the plain pick would repeat `previousModel`; it never
 * reorders, drops, or substitutes a different/cheaper model. For the
 * default config (retries == rotation.length == 6) the index never repeats
 * on its own, so this is a no-op there — behavior changes ONLY once
 * CREATE_ARTICLE_MIN_WORDS_RETRIES is raised past 6 (the exact case that
 * used to silently repeat the last model).
 *
 * Pure + exported for testability (no network, no I/O).
 */
export function selectMinWordsRetryModel(attempt, previousModel, rotation = MIN_WORDS_MODEL_ROTATION, enabled = CREATE_ARTICLE_MINWORDS_DEDUP) {
  const baseIndex = Math.min(attempt - 1, rotation.length - 1);
  if (!enabled || rotation.length <= 1) return rotation[baseIndex];
  let idx = baseIndex;
  let guard = 0;
  // Terminates within rotation.length steps: rotation entries are distinct,
  // so wrapping all the way around always finds one that isn't previousModel
  // (or, if every entry somehow equals previousModel, the guard stops it).
  while (rotation[idx] === previousModel && guard < rotation.length) {
    idx = (idx + 1) % rotation.length;
    guard++;
  }
  return rotation[idx];
}

// Fail-fast cap for the "zero-grounding news source" case (run 29639558234:
// source fetch 403'd → 0 chars → still burned all 6 CREATE_ARTICLE_MIN_WORDS_RETRIES
// attempts, ~5-8min across gpt-4.1/gpt-4o/gpt-4.1-nano/gemini, dual-LLM
// fact-check correctly blocking every single one on invented dates/
// institutions/motion details — zero grounding text structurally cannot
// pass fact-check). See computeMaxGenerationAttempts() below.
const CREATE_ARTICLE_ZERO_SOURCE_RETRIES = Math.max(
  1,
  Number.parseInt(process.env.CREATE_ARTICLE_ZERO_SOURCE_RETRIES || '2', 10) || 2,
);

/**
 * Decide how many min-words regeneration attempts a headline gets, given
 * the fetched/synthesized source content and the resolved URL.
 *
 * A real news source whose page fetch produced truly ZERO usable chars
 * (HTTP error, timeout, or extraction found nothing — not just "thin")
 * gets a much smaller cap (CREATE_ARTICLE_ZERO_SOURCE_RETRIES, default 2)
 * instead of the full CREATE_ARTICLE_MIN_WORDS_RETRIES (default 6): with
 * no source text to ground on, every attempt hallucinates unverifiable
 * specifics and the dual-LLM fact-check consensus blocks essentially 100%
 * of them (observed 6/6 on run 29639558234). Attempt 1 already answers
 * the question definitively for this source; one extra attempt on a
 * different model covers model-specific variance cheaply, and giving up
 * sooner lets the caller move on to the next headline instead of burning
 * the full budget on a doomed one.
 *
 * evergreen:// and stats-bfs:// URLs are NEVER zero-source by this check:
 * fetchPageContent() always synthesizes non-empty prompt content for them
 * (EVERGREEN_FACTS_BRIEF / BFS quarter data), so they keep the full retry
 * budget and their own separate fact-check tolerance, untouched by this cap.
 *
 * Pure + exported for testability (no network, no I/O).
 */
export function computeMaxGenerationAttempts(
  pageContent,
  url,
  fullBudget = CREATE_ARTICLE_MIN_WORDS_RETRIES,
  zeroSourceCap = CREATE_ARTICLE_ZERO_SOURCE_RETRIES,
) {
  const isZeroSourceNews = (pageContent || '').length === 0 &&
    !String(url || '').startsWith('evergreen://') &&
    !String(url || '').startsWith('stats-bfs://');
  return isZeroSourceNews ? Math.min(fullBudget, zeroSourceCap) : fullBudget;
}

const RUN_REPORT = {
  startedAt: new Date().toISOString(),
  endedAt: null,
  // Identifies the run for the defect memory, whose evidence bar counts
  // DISTINCT runs (one degraded run must not be able to confirm its own
  // hallucination six times over). 'local' outside CI.
  runId: process.env.GITHUB_RUN_ID || 'local',
  // Which pipeline produced the run (frontaliere | svizzera). Recorded because
  // the two have different gates and different budgets, so a rejection-rate
  // trend pooled across both hides which one moved. Set once SECTION resolves.
  section: null,
  status: 'running',
  selectedArticleType: null, // news | evergreen_static | evergreen_dynamic
  selectedSource: null,
  selectedUrl: null,
  // Phase B+C — ranker telemetry. selectedTier ∈ {stable,experimental,llm-fallback,evergreen}
  selectedTier: null,
  selectedScore: null,
  selectedCluster: null,
  poolSize: 0,
  // Phase 3 — proven/discovery pool dispatch.
  // _pool ∈ {'proven','discovery','evergreen-fallback'}; _pool_source is the
  // discovery sub-source ('orphan'|'suggest'|'news') or news-scan domain.
  pool: null,
  poolSource: null,
  poolSlotKind: null,
  poolCounterValue: null,
  poolCurrentQuota: null,
  poolFallbacks: [],
  sources: {
    configured: 0,
    scanned: 0,
    succeeded: 0,
    failed: 0,
    domains: [],
  },
  headlines: {
    total: 0,
    recent: 0,
    undated: 0,
    usedRecent: 0,
    usedUndated: 0,
    // ── Pre-spend topic gate (issue #113) ────────────────────────────
    // Declared here rather than sprouted on first assignment so a report
    // from a run that never reached the gate is distinguishable from one
    // where the gate ran and kept everything. `preSpendGateRecovery` is
    // the field the issue actually asked for: it separates "gate emptied
    // the pool but the run still published" from "gate emptied the pool
    // and the run produced nothing".
    preSpendGateRan: false,
    preSpendGateBefore: 0,
    preSpendGateKept: 0,
    preSpendGateAnchorCandidates: 0,
    preSpendGateBackstopRestored: 0,
    preSpendGateTotalRejection: false,
    preSpendGateRecovery: null, // 'news' | 'evergreen' | 'none'
  },
  selectionUsage: {
    attemptsTotal: 0,
    attemptsRecent: 0,
    attemptsUndated: 0,
  },
  // ── Saturazione del pool evergreen (2026-08-10) ─────────────────────
  // La saturazione del pool e' il difetto che NON si vede: il run esce 0,
  // il summary del workflow dice `Generated: true` perche' il push e'
  // riuscito, e l'unica traccia e' una riga in italiano in mezzo al log.
  // La sezione `svizzera` e' rimasta cosi' per giorni. Questi contatori
  // sono la meta' machine-readable, sul modello di PRESPEND_GATE_*: chi
  // costruisce il watchdog legge `EVERGREEN_POOL_OUTCOME` (una per run che
  // ha raggiunto la Fase 2, cioe' il denominatore) e `EVERGREEN_POOL_SATURATED`
  // (solo quando il pool si e' davvero esaurito, con il PERCHE' ripartito
  // per motivo di scarto).
  evergreenPool: {
    ran: false,
    size: 0,
    checked: 0,
    // Motivi di scarto, mutuamente esclusivi e nell'ordine in cui il
    // pre-flight li applica.
    skippedBanned: 0, // ledger keywords[] — duplicato confermato o topic-gate abort
    skippedStruck: 0, // ledger strikes{} ≥ EVERGREEN_STRIKE_LIMIT
    skippedTopicCoverage: 0, // topic-coverage-guard: stesso mestiere entro la finestra
    skippedTitleJaccard: 0, // Jaccard sul titolo di un articolo esistente
    skippedFamily: 0, // evergreenTopicFamily: stessa famiglia (spesso satura)
    saturated: false,
    stage: null, // 'preflight' | 'retry' — dove si e' esaurito
  },
  duplicateReasonBreakdown: {},
  // Pre-generation pool-exhaustion diagnostics (2026-07-21): the Fase 1 news
  // pool routinely empties before any headline reaches generation, silently
  // falling back to Fase 2 evergreen. These counts + samples make WHY a
  // headline was dropped (and WHAT it matched) visible in the run's step
  // summary instead of requiring a raw-log grep after the fact.
  preFilterDrops: {
    urlAlreadyUsed: 0,
    topicAlreadyCovered: 0,
  },
  discardedHeadlineSamples: [],
  article: {
    id: null,
    url: null,
    sourceDomain: null,
  },
  // ── Learning-loop feed (docs/ARTICLE-LEARNING-LOOP.md) ──────────────
  //
  // What this run OBSERVED, for the next run to defend against. Everything
  // else in this report is diagnostics that die with the CI log; this section
  // is the only part meant to outlive the run, and it is folded into
  // data/article-defect-memory.json by update-article-defect-memory.mjs.
  //
  // Deliberately raw observations, not verdicts: the promotion policy (with
  // its evidence bar, decay and caps) lives in one place, and a generator that
  // could write verdicts straight into its own defences would be grading its
  // own homework — the failure mode of the 2026-07-28 fact-check loop.
  factuality: {
    /** [{acronym, name, support, articleId, attempt}] — one entry per attempt. */
    institutionObservations: [],
    /**
     * Generation attempts spent this run, summed across every headline tried.
     * The cost half of the loop's health metric (docs/ARTICLE-LEARNING-LOOP.md
     * §6): a defence that halves shipped defects while tripling attempts per
     * published article is not obviously an improvement, and there is no way to
     * notice that without counting the denominator.
     */
    attempts: 0,
    /** gate issue code → times it rejected a draft this run. */
    gateRejectionsByCode: {},
    /**
     * LLM verifier category → times it rejected a draft this run.
     *
     * DIAGNOSTIC ONLY, AND DELIBERATELY SO. These are one model's opinions
     * about another model's output; they are not admissible as evidence about
     * the world, and no defence may ever be promoted from them (that is exactly
     * the 2026-07-28 degeneration). They are recorded anyway because the
     * incident's signature is only visible here: on run 30350429920 the
     * verifier rejected a FAITHFUL draft six times running, and the only
     * observable that would have caught it in the aggregate is this counter
     * climbing while the publish rate fell. The quarantine is carried in the
     * field name, in the ledger's `verifierOpinion` column, and in the
     * `admissible: false` tag the trend view prints.
     */
    factCheckRejectionsByCategory: {},
  },
  notes: [],
};

/**
 * Cap on institutionObservations. A pathological run retries ~6 times and each
 * attempt can introduce a handful of acronyms; the cap stops a runaway loop
 * from writing a multi-megabyte report, and losing the tail costs nothing
 * because evidence is counted once per (run, article) anyway.
 */
const INSTITUTION_OBSERVATION_CAP = 60;

let REPORT_FINALIZED = false;

// Cap on discardedHeadlineSamples — a single run's pre-filter can drop 50-100+
// headlines; the report only needs enough examples to judge whether the gate
// is catching real duplicates or false-positiving on distinct stories.
const DISCARDED_HEADLINE_SAMPLE_CAP = 20;

function recordDiscardedHeadline(entry) {
  if (RUN_REPORT.discardedHeadlineSamples.length >= DISCARDED_HEADLINE_SAMPLE_CAP) return;
  RUN_REPORT.discardedHeadlineSamples.push(entry);
}

function addDuplicateReason(key) {
  const k = key || 'other';
  RUN_REPORT.duplicateReasonBreakdown[k] = (RUN_REPORT.duplicateReasonBreakdown[k] || 0) + 1;
}

function captureDuplicateReasons(errorMessage = '') {
  const msg = String(errorMessage || '');
  if (!msg.includes('DUPLICATO')) return;

  if (msg.includes('L\'ID "') && msg.includes('esiste già')) addDuplicateReason('id_exists');
  if (msg.includes('Lo slug "') && msg.includes('esiste già')) addDuplicateReason('slug_exists');

  const signalLine = msg.match(/Segnali:\s*(.+)/);
  const cosineLine = msg.match(/Cosine:\s*([\d.]+)\s*≥/);
  if (signalLine?.[1]) {
    addDuplicateReason('multi_signal');
    const parts = signalLine[1].split('|').map((x) => x.trim().toLowerCase());
    for (const p of parts) {
      if (p.startsWith('id:')) addDuplicateReason('signal_id');
      else if (p.startsWith('titolo:')) addDuplicateReason('signal_title');
      else if (p.startsWith('excerpt:')) addDuplicateReason('signal_excerpt');
      else if (p.startsWith('combinato:')) addDuplicateReason('signal_combined');
      else addDuplicateReason('signal_other');
    }
  } else if (cosineLine?.[1]) {
    // checkSemanticNearDuplicate() rejection (#3138 follow-up) — previously
    // fell into the generic 'other' bucket because this branch only
    // recognized the lexical checkForDuplicates() "Segnali:" format, making
    // semantic rejections invisible in the run's own summary.
    addDuplicateReason('semantic_cosine');
  } else {
    addDuplicateReason('other');
  }
}

// Short, log-friendly reason tag for a DUPLICATO error, so the retry/
// exhaustion console lines say WHY (semantic vs lexical vs id/slug) instead
// of just "duplicato rilevato" — the semantic gate's cosine detail used to
// be thrown but never printed anywhere, making it undiagnosable from CI
// logs (#3138 follow-up).
function duplicateReasonTag(errorMessage = '') {
  const msg = String(errorMessage || '');
  const cosineLine = msg.match(/Cosine:\s*([\d.]+)\s*≥\s*([\d.]+)/);
  if (cosineLine) return `semantico, cosine=${cosineLine[1]} ≥ ${cosineLine[2]}`;
  const signalLine = msg.match(/Segnali:\s*(.+)/);
  if (signalLine?.[1]) return `lessicale (${signalLine[1].trim()})`;
  if (msg.includes('esiste già')) return 'id/slug già esistente';
  return 'motivo non riconosciuto';
}

// Extract candidate title + matched neighbour slug from a checkSemanticNearDuplicate
// error so rejection logs are self-contained and auditable without extra tooling.
// Returns '' for non-semantic rejections (no "Nuovo:"/"Esistente:" fields).
function duplicateCandidateDetail(errorMessage = '') {
  const msg = String(errorMessage || '');
  const candidateMatch = msg.match(/Nuovo:\s*"([^"]+)"/);
  const neighborMatch = msg.match(/Esistente:\s*\[([^\]]+)\]/);
  if (!candidateMatch && !neighborMatch) return '';
  return ` — candidato: "${candidateMatch?.[1] ?? '?'}" → vicino: ${neighborMatch?.[1] ?? '?'}`;
}

/**
 * Which article, if any, the run ended up publishing — resolved from what the
 * run already recorded, so the pre-spend-gate outcome line below does not need
 * its own bookkeeping threaded through every terminal branch.
 *
 * @returns {'news'|'evergreen'|'none'}
 */
function resolveRunRecovery() {
  if (!RUN_REPORT?.article?.id) return 'none';
  return String(RUN_REPORT.selectedArticleType || '').startsWith('evergreen') ? 'evergreen' : 'news';
}

function finalizeRunReport(status, extra = {}) {
  if (REPORT_FINALIZED) return;
  REPORT_FINALIZED = true;

  RUN_REPORT.status = status || 'unknown';
  RUN_REPORT.endedAt = new Date().toISOString();
  Object.assign(RUN_REPORT, extra || {});

  // ── Pre-spend gate disposition (issue #113) ────────────────────────
  // Emitted from every terminal path, so `emptied=1 recovered=none` is the
  // literal count the issue asked for and `PRESPEND_GATE_OUTCOME` alone is
  // its denominator. Deliberately NOT emitted when the gate never ran
  // (FORCE_EVERGREEN, empty scan): those runs are not evidence either way.
  //
  // Absence of this line on a run that DID print PRESPEND_GATE_TOTAL_REJECTION
  // is itself a reading: the process was killed before finalizing — the
  // workflow's `timeout … 2400s` SIGKILL, which claimed 30 of 224 runs in the
  // 2026-08-06→10 window and must not be silently counted as "no article
  // because of the gate".
  if (RUN_REPORT?.headlines?.preSpendGateRan) {
    RUN_REPORT.headlines.preSpendGateRecovery = resolveRunRecovery();
    console.error(
      `PRESPEND_GATE_OUTCOME emptied=${RUN_REPORT.headlines.preSpendGateTotalRejection ? 1 : 0}`
      + ` recovered=${RUN_REPORT.headlines.preSpendGateRecovery}`
      + ` before=${RUN_REPORT.headlines.preSpendGateBefore}`
      + ` kept=${RUN_REPORT.headlines.preSpendGateKept}`
      + ` status=${RUN_REPORT.status} section=${RUN_REPORT.section}`,
    );
  }

  // ── Esito del pool evergreen ────────────────────────────────────────
  // Emessa da OGNI percorso terminale che ha raggiunto la Fase 2, esattamente
  // come la riga sopra: e' questa a fare da denominatore, altrimenti
  // `EVERGREEN_POOL_SATURATED` da sola non dice se una saturazione e' un caso
  // isolato o lo stato stabile della sezione (che e' quello che e' successo:
  // 4 run su 4, e nessun segnale). Volutamente NON emessa dai run che non
  // sono arrivati al fallback evergreen — non sono evidenza in nessuna
  // direzione.
  if (RUN_REPORT?.evergreenPool?.ran) {
    const p = RUN_REPORT.evergreenPool;
    console.error(
      `EVERGREEN_POOL_OUTCOME saturated=${p.saturated ? 1 : 0}`
      + ` stage=${p.stage || 'none'} pool=${p.size} checked=${p.checked}`
      + ` status=${RUN_REPORT.status} section=${RUN_REPORT.section}`,
    );
  }

  try {
    const dir = path.dirname(resolve(CREATE_ARTICLE_REPORT_FILE));
    mkdirSync(dir, { recursive: true });
    write(CREATE_ARTICLE_REPORT_FILE, `${JSON.stringify(RUN_REPORT, null, 2)}\n`);
  } catch (e) {
    console.error(`  ⚠️  Impossibile scrivere ${CREATE_ARTICLE_REPORT_FILE}: ${e.message}`);
  }
}

/**
 * Attribuisce uno scarto del pre-flight evergreen al motivo che lo ha causato,
 * leggendo il `signal` che `preFlightEvergreenCheck` gia' restituisce
 * (`topic_coverage:<id>` | `title_jaccard` | `evergreen_family:<famiglia>`).
 *
 * Il motivo e' l'unica parte che dice cosa FARE quando un pool si esaurisce, e
 * i tre chiedono interventi opposti: `title_jaccard` dominante significa pool
 * davvero coperto (serve allargarlo), `evergreen_family` dominante significa
 * che i candidati cadono in una famiglia satura (l'allargamento non serve a
 * niente, vanno riformulati), `topic_coverage` significa che aspettano solo la
 * fine della finestra di 90 giorni.
 */
function countEvergreenPreflightDrop(signal) {
  const p = RUN_REPORT?.evergreenPool;
  if (!p) return;
  const s = String(signal || '');
  if (s.startsWith('topic_coverage')) p.skippedTopicCoverage += 1;
  else if (s.startsWith('evergreen_family')) p.skippedFamily += 1;
  else p.skippedTitleJaccard += 1;
}

/**
 * Dichiara che il pool evergreen si e' esaurito, in una riga grep-abile.
 *
 * PERCHE' ESISTE. Fino al 2026-08-10 la saturazione era invisibile per
 * costruzione: il run esce 0, il workflow riporta `Generated: true` (il push
 * e' riuscito, semplicemente senza articolo dentro), e l'unica traccia era una
 * frase in italiano — «Tutte le keyword evergreen risultano gia' coperte» — in
 * mezzo a centinaia di righe. La sezione `svizzera` e' rimasta cosi' per
 * giorni, su due slot cron l'ora, senza che niente lo dicesse.
 *
 * Stessa forma di PRESPEND_GATE_TOTAL_REJECTION, e per la stessa ragione:
 *
 *   grep -c 'EVERGREEN_POOL_SATURATED'                     → quante volte
 *   grep -c 'EVERGREEN_POOL_SATURATED section=svizzera'    → …su quale sezione
 *   grep    'EVERGREEN_POOL_OUTCOME'                       → il denominatore
 *
 * I contatori per motivo sono nella riga perche' «il pool e' esaurito» da solo
 * non distingue un pool troppo piccolo da un pool scritto male (vedi
 * countEvergreenPreflightDrop).
 */
function reportEvergreenPoolSaturation(stage) {
  const p = RUN_REPORT?.evergreenPool;
  if (!p) return;
  p.saturated = true;
  p.stage = stage;
  console.error(
    `EVERGREEN_POOL_SATURATED section=${SECTION_NAME} stage=${stage}`
    + ` pool=${p.size} checked=${p.checked}`
    + ` skipped_banned=${p.skippedBanned} skipped_struck=${p.skippedStruck}`
    + ` skipped_topic_coverage=${p.skippedTopicCoverage}`
    + ` skipped_title_jaccard=${p.skippedTitleJaccard}`
    + ` skipped_family=${p.skippedFamily}`,
  );
}

// Map common AI-hallucinated categories to valid ones
const CATEGORY_MAP = {
  economia: 'fiscale',
  economica: 'fiscale',
  lavoro: 'pratico',
  salute: 'pratico',
  sanita: 'pratico',
  trasporti: 'pratico',
  news: 'novita',
  notizie: 'novita',
  attualita: 'novita',
  previdenza: 'pensione',
  // NEW entries:
  sport: 'novita',
  sportivo: 'novita',
  cronaca: 'novita',
  politica: 'novita',
  ambiente: 'pratico',
  natura: 'novita',
  turismo: 'novita',
  cultura: 'novita',
  difesa: 'novita',
  militare: 'novita',
  sicurezza: 'novita',
  immigrazione: 'pratico',
  permesso: 'pratico',
  assicurazione: 'pratico',
  valuta: 'fiscale',
  cambio: 'fiscale',
  tasse: 'fiscale',
  fiscale_cat: 'fiscale',
  pensione: 'pensione',
  previdenziale: 'pensione',
};

// ── Long-tail SEO: evergreen keyword topics ─────────────────
// On Mondays, the script may generate a strategic evergreen article
// targeting long-tail keywords instead of a news-based article.
// These topics are high-search-volume queries from frontalieri.
const PRIORITY_EVERGREEN_TOPICS = [
  { keyword: 'calcolo tasse frontalieri entro 20 km confine', angle: 'Guida pratica al calcolo tasse per frontalieri entro 20 km dal confine: franchigia, credito d’imposta, differenze tra vecchio e nuovo regime' },
  { keyword: 'calcolo tasse frontalieri oltre 20 km confine', angle: 'Come cambia la tassazione per frontalieri oltre 20 km: quali agevolazioni non si applicano, impatto IRPEF e simulazioni con esempi reali' },
  { keyword: 'frontaliere contributi sociali svizzeri dettaglio busta paga', angle: 'Breakdown completo delle trattenute in busta paga svizzera: AVS, AI, IPG, AD, LPP, LAINF — cosa paga il datore e cosa il lavoratore frontaliere' },
  { keyword: 'quanto costa vivere a Lugano da frontaliere', angle: 'Analisi costi reali: affitto, trasporti, assicurazione, spesa alimentare per un frontaliere che valuta il trasferimento' },
  { keyword: 'frontaliere permesso G vantaggi svantaggi', angle: 'Pro e contro completi del permesso G: fisco, previdenza, sanità, mobilità lavorativa. Quando conviene e quando no' },
  { keyword: 'calcolo pensione frontaliere AVS italiana', angle: 'Come funziona la pensione da frontaliere: contributi AVS svizzeri + INPS italiana, totalizzazione, tempistica' },
  { keyword: 'frontaliere tassazione 2026 dopo nuovo accordo fiscale', angle: 'Regole operative 2026 dopo l’Accordo frontalieri in vigore dal 1 gennaio 2024: differenze tra vecchi e nuovi frontalieri, franchigia e credito d’imposta con scenari ipotetici' },
  { keyword: 'LAMal o CMI frontaliere quale conviene 2026', angle: 'Confronto aggiornato LAMal vs CMI: premi, coperture, franchigia, casi pratici per famiglie e single' },
  { keyword: 'frontaliere doppia imposizione credito imposta come funziona', angle: 'Come evitare la doppia tassazione: meccanismo del credito d\'imposta per frontalieri, quadro CE del 730, esempi pratici con cifre reali' },
  { keyword: 'costo auto pendolare frontaliere Ticino', angle: 'Tutti i costi dell\'auto per il pendolare: benzina, vignette, parcheggio, usura, confronto con treno e bus' },
  { keyword: 'dichiarazione redditi frontaliere 730 guida', angle: 'Guida passo passo alla dichiarazione dei redditi: quadro CE, credito d\'imposta, documenti necessari, scadenze' },
  { keyword: 'frontaliere documenti necessari inizio lavoro Svizzera', angle: 'Checklist completa dei documenti per iniziare a lavorare in Svizzera: contratto, documento d’identità, richiesta del permesso G quando applicabile, dati bancari se richiesti dal datore, AVS e assicurazione sanitaria' },
  { keyword: 'telelavoro frontaliere quanti giorni 2026', angle: 'Regole telelavoro Italia-Svizzera: 25% massimo, accordo bilaterale, impatto fiscale, come comunicare al datore' },
  { keyword: 'frontaliere con figli asilo nido Svizzera', angle: 'Guida pratica per frontalieri con figli: asili nido ticinesi, costi, lista d\'attesa, sussidi, alternative italiane' },
  { keyword: 'aprire conto bancario svizzero da frontaliere', angle: 'Quale banca scegliere in Ticino: costi di gestione, carte, online banking, requisiti per frontalieri' },
  { keyword: 'ristorni fiscali frontaliere come funzionano', angle: 'Meccanismo completo dei ristorni: chi li paga, quanto valgono, come si calcolano, futuro post nuovo accordo' },
  { keyword: 'indennità disoccupazione frontaliere Italia', angle: 'NASpI per ex-frontalieri: requisiti, calcolo importo, durata, come fare domanda, differenze con la disoccupazione svizzera' },
  { keyword: 'frontaliere cambio euro franco conviene', angle: 'Strategie di cambio CHF-EUR: quando cambiare, piattaforme migliori, conto multi-valuta, impatto sullo stipendio' },
  { keyword: 'assicurazione malattia frontaliere famiglia', angle: 'Copertura sanitaria per tutta la famiglia: opzioni LAMal, EHIC, assicurazione integrativa, emergenze all\'estero' },
  { keyword: 'secondo pilastro LPP frontaliere prelievo', angle: 'Prelievo del secondo pilastro: quando si può, tassazione Italia e Svizzera, strategia di uscita ottimale' },
  { keyword: 'frontaliere acquisto casa mutuo Italia', angle: 'Comprare casa in Italia con stipendio svizzero: mutuo frontaliere, documenti, garanzie, banche specializzate' },
  { keyword: 'frontaliere maternità paternità congedo parentale Svizzera Italia', angle: 'Diritti di maternità e paternità per frontalieri: congedo svizzero vs italiano, indennità giornaliere, come richiedere le prestazioni, casi pratici per neo-genitori' },
  // Nuove keyword strategiche 2026
  { keyword: 'frontaliere bonus famiglia 2026', angle: 'Tutti i bonus e agevolazioni per famiglie frontalieri: assegni familiari, bonus nido, detrazioni, novità 2026.' },
  { keyword: 'frontaliere smart working regole aggiornate', angle: 'Regole e limiti per lo smart working transfrontaliero: percentuali, fiscalità, procedure, casi pratici.' },
  { keyword: 'frontaliere assicurazione auto Svizzera Italia', angle: 'Confronto tra assicurazioni auto svizzere e italiane per frontalieri: costi, coperture, sinistri, consigli.' },
  { keyword: 'frontaliere detrazioni fiscali Italia 2026', angle: 'Guida alle detrazioni fiscali per frontalieri in Italia: quali spese si possono scaricare, documenti, limiti.' },
  { keyword: 'frontaliere mutuo casa Svizzera requisiti', angle: 'Come ottenere un mutuo per acquistare casa in Svizzera da frontaliere: banche, requisiti, procedure.' },
  { keyword: 'frontaliere pensione complementare terzo pilastro', angle: 'Vantaggi e funzionamento del terzo pilastro per frontalieri: deducibilità, rendimenti, casi pratici.' },
  { keyword: 'frontaliere permesso B differenze con G', angle: 'Tutte le differenze tra permesso B e G per frontalieri: residenza, fiscalità, diritti, scelta ottimale.' },
  { keyword: 'frontaliere spese sanitarie rimborsabili Italia', angle: 'Quali spese sanitarie sostenute in Svizzera sono rimborsabili in Italia per frontalieri, procedure e limiti.' },
  { keyword: 'frontaliere lavoro stagionale Ticino', angle: 'Regole, diritti e opportunità per lavoro stagionale in Ticino: permessi, contratti, fiscalità.' },
  { keyword: 'frontaliere trasporto pubblico abbonamenti sconti', angle: 'Guida agli abbonamenti e sconti per frontalieri sui trasporti pubblici Ticino-Lombardia: treno, bus, agevolazioni.' },
  { keyword: 'lavorare come educatore dell\'infanzia in Ticino stipendio requisiti', angle: 'Guida completa per diventare educatore dell\'infanzia in Ticino: diploma SSS richiesto, stipendio CHF 73K–97K, LIS e altri datori di lavoro, processo per ottenere il Permesso G, confronto salariale con Italia e Germania' },
  // Topic Finder Semrush — audience CH (apr 2026)
  { keyword: 'telelavoro frontalieri 2026', angle: 'Regole 25%/45 giorni telelavoro per frontalieri Italia-Svizzera, esempi numerici, comunicazione al datore', locale: 'it', searchVolume: 1600 },
  { keyword: 'permesso di soggiorno svizzera', angle: 'Tipologie B/G/L/C: differenze, requisiti, durata, conversione tra permessi', locale: 'it', searchVolume: 320 },
  { keyword: 'richiesta permesso g step by step', angle: 'Procedura completa richiesta permesso G: documenti, datore, ufficio cantonale, tempi e costi 2026', locale: 'it', searchVolume: 90 },
  { keyword: 'imposte alla fonte ticino calcolatore', angle: 'Come calcolare l\'imposta alla fonte in Ticino: aliquote 2026, scaglioni, simulatore con esempi reali', locale: 'it', searchVolume: 70 },
  { keyword: 'tassazione frontalieri 2026 nuovo accordo', angle: 'Tassazione frontalieri nel 2026 dopo il nuovo accordo Italia-Svizzera già in vigore: vecchi vs nuovi frontalieri, franchigia e credito d’imposta con scenari ipotetici', locale: 'it', searchVolume: 390 },
  { keyword: 'ingresso in svizzera frontalieri documenti dogana 2026', angle: 'Documenti e regole per varcare il confine come frontaliere: passaporto/CI, permesso, controlli dogana', locale: 'it', searchVolume: 120 },
  { keyword: 'aufenthaltsbewilligung b quellensteuer 2026', angle: 'B-Bewilligung und Quellensteuer: Tarife, NOV-Antrag, Pillar 3a Abzüge, Vergleich zu Grenzgängern', locale: 'de', searchVolume: 210 },
  { keyword: 'quellensteuer schweiz tarife 2026', angle: 'Quellensteuer-Tarife alle Kantone: Tessin, Graubünden, Wallis, Bern. Berechnung, Abzüge, NOV-Schwelle 120k CHF', locale: 'de', searchVolume: 880 },
  { keyword: 'grenzgänger schweiz steuern 2026', angle: 'Steuerliche Pflichten für Grenzgänger nach neuem Abkommen: alte vs neue Grenzgänger, Italien-Steuer, Beispielrechnungen', locale: 'de', searchVolume: 260 },
  { keyword: 'g bewilligung antrag 2026', angle: 'G-Bewilligung Antrag Schritt für Schritt: Dokumente, Migrationsamt, Kosten 65 CHF, 5-Jahres-Gültigkeit, Verlängerung', locale: 'de', searchVolume: 110 },
  // 2026-07-01 (issue #3138 Leva #2): sub-angles absent from the pool above —
  // border-municipality life, extra professions, cross-border life-events,
  // INPS/Agenzia Entrate procedure. Widens the pool so fewer candidates
  // collapse into near-duplicates of the fiscal/pension/health core above.
  { keyword: 'vivere a Como e lavorare in Ticino da frontaliere', angle: 'Pendolarismo Como-Chiasso: tempi di percorrenza, costo della vita a confronto, quartieri consigliati, treno vs auto' },
  { keyword: 'vivere a Varese e lavorare in Ticino da frontaliere', angle: 'Pendolarismo Varese-Lugano: collegamenti, costo della vita, scuole per i figli, comunità di frontalieri' },
  { keyword: 'totalizzazione contributi AVS INPS domanda come funziona', angle: 'Procedura di totalizzazione dei contributi tra AVS svizzera e INPS italiana: modulistica, tempistiche, calcolo della pensione risultante' },
  { keyword: 'quadro RW dichiarazione conto corrente svizzero Agenzia Entrate', angle: 'Obblighi di monitoraggio fiscale (quadro RW) per il conto bancario svizzero del frontaliere: IVAFE, sanzioni per omessa dichiarazione, casi pratici' },
  { keyword: 'matrimonio frontaliere italiano cittadino svizzero regime fiscale', angle: 'Cosa cambia fiscalmente e a livello di permesso quando un frontaliere sposa un cittadino svizzero o residente in Svizzera' },
  { keyword: 'successione eredità frontaliere conto svizzero Italia', angle: 'Successione transfrontaliera: come si tassa un conto o un immobile svizzero ereditato da un frontaliere residente in Italia, doppia imposizione e convenzioni' },
  { keyword: 'divorzio frontaliere assegno mantenimento Svizzera Italia', angle: 'Separazione e divorzio quando un coniuge è frontaliere: giurisdizione competente, calcolo dell\'assegno di mantenimento su stipendio svizzero, riconoscimento della sentenza' },
  { keyword: 'frontaliere infermiere Ticino stipendio requisiti', angle: 'Lavorare come infermiere in Ticino da frontaliere: stipendio, riconoscimento titolo di studio italiano, permesso G, differenze con l\'Italia' },
  { keyword: 'frontaliere operaio edile Ticino contratto CCL', angle: 'Lavoro edile in Ticino per frontalieri: contratto collettivo (CCL), salario minimo, sicurezza sul lavoro, differenze con i cantieri italiani' },
  { keyword: 'frontaliere autista camionista Ticino permesso', angle: 'Diventare autista/camionista frontaliere in Ticino: patenti riconosciute, tempi di guida, stipendio, permesso G per il settore trasporti' },
  // 2026-07-08 (diagnosi generate-article.yml): pool esaurita contro il corpus
  // pubblicato — stesso sintomo di #3138 (2026-07-02), ricorrente 6gg dopo.
  // Batch ampio di temi genuinamente nuovi (non varianti fiscali del core
  // sopra) per allargare il raggio: scuola/formazione, lavoro autonomo,
  // assicurazioni non-sanitarie, nuovi comuni di confine, nuove professioni.
  { keyword: 'iscrizione scuola figli frontaliere italia svizzera differenze', angle: 'Iscrivere i figli a scuola in Svizzera o in Italia da frontaliere: sistemi scolastici a confronto, procedure di iscrizione, pendolarismo scolastico' },
  { keyword: 'equipollenza titolo di studio italiano in svizzera frontaliere', angle: 'Come far riconoscere un titolo di studio italiano in Svizzera: procedura, enti competenti, tempistiche, professioni regolamentate' },
  { keyword: 'conversione patente di guida italiana in svizzera frontaliere', angle: 'Conversione della patente italiana in svizzera per frontalieri: quando serve, procedura, costi, validità durante il permesso G' },
  { keyword: 'partita iva frontaliere lavoro autonomo in svizzera', angle: 'Aprire un\'attività autonoma in Svizzera da frontaliere: requisiti, differenze col lavoro dipendente, fiscalità e previdenza' },
  { keyword: 'secondo lavoro part-time in italia per frontaliere svizzero', angle: 'Fare un secondo lavoro part-time in Italia mentre si è frontalieri in Svizzera: limiti contrattuali, dichiarazione fiscale, contributi' },
  { keyword: 'indennità perdita di guadagno malattia lunga frontaliere', angle: 'Malattia di lunga durata per il frontaliere: indennità di perdita di guadagno svizzera, durata della copertura, rapporto con l\'INPS italiana' },
  { keyword: 'frontaliere over 55 ricollocamento cambio lavoro', angle: 'Cambiare lavoro da frontaliere dopo i 55 anni: ricollocamento, tutele, impatto su secondo pilastro e pensione' },
  { keyword: 'studente universitario pendolare ticino usi supsi', angle: 'Vita da studente pendolare tra Italia e Ticino: iscrizione a USI/SUPSI, costi, alloggio, differenze con lo status di frontaliere lavoratore' },
  { keyword: 'spesa alimentare svizzera o italia conviene frontaliere', angle: 'Dove conviene fare la spesa per un frontaliere: confronto prezzi supermercati svizzeri e italiani, franchigia doganale, abitudini di acquisto' },
  { keyword: 'franchigia doganale acquisti svizzera frontaliere dogana', angle: 'Limiti di franchigia doganale per gli acquisti in Svizzera: valori aggiornati, dichiarazione, conseguenze del superamento per il frontaliere' },
  { keyword: 'assicurazione RC auto svizzera differenze italia frontaliere', angle: 'Assicurazione auto RC in Svizzera per il frontaliere: differenze con la polizza italiana, bonus-malus, immatricolazione del veicolo' },
  { keyword: 'multe stradali svizzere pagamento da residente italiano', angle: 'Come funzionano le multe stradali svizzere per un residente italiano: notifica, pagamento, conseguenze del mancato pagamento, ricorsi' },
  { keyword: 'vignetta autostradale svizzera 2026 costo frontaliere', angle: 'Vignetta autostradale svizzera 2026: costo, dove acquistarla, obbligo per il pendolare frontaliere, differenze con il pedaggio italiano' },
  { keyword: 'conto PostFinance carta di credito frontaliere', angle: 'Conto PostFinance per frontalieri: apertura, carte di credito disponibili, costi di gestione, confronto con le banche cantonali' },
  { keyword: 'regime forfettario italiano compatibilità reddito svizzero', angle: 'Regime forfettario italiano e reddito da lavoro dipendente svizzero: compatibilità, obblighi dichiarativi, casi in cui non è ammesso' },
  { keyword: 'naturalizzazione svizzera dopo anni da frontaliere requisiti', angle: 'Percorso di naturalizzazione svizzera per chi ha lavorato anni da frontaliere: requisiti di residenza, differenze rispetto al titolare di permesso G' },
  { keyword: 'cambio cantone di lavoro frontaliere ticino grigioni', angle: 'Cambiare cantone di lavoro da frontaliere, ad esempio dal Ticino ai Grigioni: impatto su permesso, tassazione alla fonte, pendolarismo' },
  { keyword: 'infortunio in itinere confine assicurazione frontaliere', angle: 'Infortunio in itinere al confine per il frontaliere: copertura LAINF, differenze tra tragitto casa-lavoro e trasferta, come fare la denuncia' },
  { keyword: 'congedo per lutto malattia familiare frontaliere svizzera', angle: 'Congedo per lutto o malattia di un familiare per il lavoratore frontaliere: durata prevista dal datore svizzero, differenze con le regole italiane' },
  { keyword: 'frontaliere lavoro da remoto terzo paese vacanza fiscalità', angle: 'Lavorare in remoto da un terzo paese durante una vacanza, per un frontaliere: implicazioni fiscali e assicurative, cosa comunicare al datore' },
  { keyword: 'corsi di tedesco o francese per frontalieri italofoni', angle: 'Dove seguire corsi di tedesco o francese utili al frontaliere italofono: scuole in Ticino, corsi online, finanziamenti disponibili' },
  { keyword: 'quanti sono i frontalieri in ticino statistiche 2026', angle: 'I numeri aggiornati dei frontalieri in Ticino: dati ufficiali, evoluzione storica, settori di impiego principali' },
  { keyword: 'costo della vita lugano confronto milano frontaliere', angle: 'Costo della vita a Lugano confrontato con Milano: affitti, trasporti, spesa, utile per chi valuta il trasferimento da frontaliere' },
  { keyword: 'crescere figli bilingue frontaliere italiano tedesco francese', angle: 'Crescere figli bilingue in una famiglia frontaliera: scuole, attività extra-scolastiche, vantaggi pratici sul mercato del lavoro futuro' },
  { keyword: 'vivere a Luino e lavorare in Ticino da frontaliere', angle: 'Pendolarismo Luino-Locarno per frontalieri: collegamenti, tempi di percorrenza, costo della vita, alternative abitative sul Lago Maggiore' },
  { keyword: 'vivere in Valtellina e lavorare nei Grigioni da frontaliere', angle: 'Pendolarismo Valtellina-Grigioni per frontalieri: valichi, collegamenti stradali, differenze rispetto al polo Ticino-Lombardia' },
  { keyword: 'frontaliere insegnante scuola ticino stipendio requisiti', angle: 'Lavorare come insegnante in Ticino da frontaliere: riconoscimento titolo, stipendio, concorsi, permesso G per il settore scolastico' },
  { keyword: 'frontaliere sviluppatore informatico ticino stipendio permesso', angle: 'Lavorare come sviluppatore informatico in Ticino da frontaliere: stipendio medio, aziende IT principali, permesso G, telelavoro parziale' },
  { keyword: 'frontaliere fisioterapista ticino stipendio requisiti', angle: 'Lavorare come fisioterapista in Ticino da frontaliere: riconoscimento del diploma, stipendio, iter di abilitazione, permesso G' },
  { keyword: 'frontaliere farmacista ticino stipendio requisiti', angle: 'Lavorare come farmacista in Ticino da frontaliere: riconoscimento del titolo, stipendio, iter di abilitazione, permesso G' },
  { keyword: 'frontaliere parrucchiere estetista ticino permesso stipendio', angle: 'Lavorare come parrucchiere o estetista in Ticino da frontaliere: stipendio, riconoscimento professionale, permesso G, opportunità nel settore' },
  { keyword: 'frontaliere meccanico auto ticino stipendio permesso', angle: 'Lavorare come meccanico auto in Ticino da frontaliere: stipendio, CCL di settore, permesso G, differenze con le officine italiane' },
  { keyword: 'frontaliere cuoco ristorazione ticino stipendio permesso', angle: 'Lavorare come cuoco nella ristorazione ticinese da frontaliere: stipendio, orari, CCL di settore, permesso G' },
  { keyword: 'frontaliere magazziniere logistica ticino stipendio', angle: 'Lavorare come magazziniere nella logistica in Ticino da frontaliere: stipendio, aziende principali, permesso G, turni di lavoro' },
  { keyword: 'assicurazione vita privata svizzera conviene frontaliere', angle: 'Assicurazione vita privata svizzera per il frontaliere: quando conviene rispetto al terzo pilastro, fiscalità, casi pratici' },
  { keyword: 'frontaliere trasloco svizzera trasferimento residenza documenti', angle: 'Trasferirsi a vivere in Svizzera dopo anni da frontaliere: documenti necessari, cambio di permesso, impatto fiscale e previdenziale' },
  { keyword: 'frontaliere acquisto immobile investimento svizzera fiscalità', angle: 'Acquistare un immobile in Svizzera come investimento da frontaliere: vincoli per non residenti, fiscalità, differenze con l\'acquisto della prima casa' },
  { keyword: 'frontaliere adozione affido procedura italia svizzera', angle: 'Procedura di adozione o affido per una famiglia frontaliera: enti competenti tra Italia e Svizzera, congedi previsti, documenti necessari' },
  { keyword: 'frontaliere gravidanza controlli sanitari lamal cmi', angle: 'Gravidanza e controlli sanitari per la frontaliera: copertura LAMal o CMI, scelta dell\'ospedale, differenze pratiche tra i due sistemi' },
  { keyword: 'frontaliere disdetta contratto lavoro dimissioni termini', angle: 'Dare le dimissioni da un lavoro da frontaliere: termini di preavviso svizzeri, procedura corretta, impatto su permesso e disoccupazione' },
  // 2026-07-08: batch di interesse generale per chi vive/lavora nell'area
  // transfrontaliera Ticino-Lombardia, non legato allo status fiscale/permesso
  // del frontaliere — vita locale, tempo libero, mobilità, immobiliare,
  // trasferimento in Svizzera per chi non è (ancora) frontaliere.
  { keyword: 'cosa fare nel weekend in ticino attività outdoor', angle: 'Idee per il weekend in Ticino: escursioni, laghi, borghi e attività all\'aperto per chi vive o lavora nell\'area transfrontaliera' },
  { keyword: 'migliori laghi balneabili ticino estate', angle: 'Guida ai laghi balneabili del Ticino: qualità delle acque, spiagge attrezzate, accesso e parcheggi, consigli per l\'estate' },
  { keyword: 'sentieri escursionistici ticino per principianti', angle: 'I sentieri escursionistici più adatti ai principianti in Ticino: dislivello, durata, punti panoramici, come arrivarci' },
  { keyword: 'stazioni sci vicino lugano bellinzona', angle: 'Le stazioni sciistiche più vicine a Lugano e Bellinzona: piste, skipass, tempi di percorrenza da chi vive nell\'area di confine' },
  { keyword: 'mercatini e mercati settimanali ticino', angle: 'Guida ai mercati settimanali e mercatini del Ticino: prodotti locali, giorni e orari, città principali' },
  { keyword: 'migliori ristoranti tipici ticinesi lugano', angle: 'Dove mangiare cucina tipica ticinese a Lugano e dintorni: grotti, osterie, piatti da provare, fasce di prezzo' },
  { keyword: 'vino merlot ticinese cantine da visitare', angle: 'Il Merlot ticinese e le cantine da visitare: percorsi enoturistici, degustazioni, come raggiungerle dall\'area di confine' },
  { keyword: 'piste ciclabili ticino lombardia percorsi', angle: 'Le piste ciclabili tra Ticino e Lombardia: percorsi lungolago, difficoltà, noleggio bici, punti di interesse' },
  { keyword: 'parchi naturali e riserve ticino', angle: 'Parchi naturali e riserve protette del Ticino: accesso, attività consentite, periodi migliori per la visita' },
  { keyword: 'mercato immobiliare ticino prezzi tendenze', angle: 'Il mercato immobiliare in Ticino: prezzi medi per zona, tendenze recenti, differenze tra affitto e acquisto, utile a chiunque valuti un trasferimento' },
  { keyword: 'trasferirsi in svizzera da italiano non frontaliere guida', angle: 'Guida al trasferimento in Svizzera per chi non è (ancora) frontaliere: permesso di soggiorno, ricerca casa, primi passi burocratici' },
  { keyword: 'sistema sanitario svizzero panoramica generale', angle: 'Come funziona il sistema sanitario svizzero: assicurazione obbligatoria, medico di famiglia, pronto soccorso, differenze rispetto al SSN italiano' },
  { keyword: 'aprire un conto in banca svizzera per residenti', angle: 'Aprire un conto bancario in Svizzera da residente: documenti richiesti, banche principali, costi di gestione' },
  { keyword: 'mercato del lavoro ticino settori in crescita', angle: 'I settori in crescita nel mercato del lavoro ticinese: dati aggiornati, professioni richieste, prospettive per chi cerca impiego' },
  { keyword: 'imparare lo svizzero tedesco corsi e app', angle: 'Come imparare lo svizzero tedesco: corsi in presenza, app consigliate, differenze con il tedesco standard' },
  { keyword: 'coworking e spazi di lavoro condiviso lugano', angle: 'I migliori spazi di coworking a Lugano e in Ticino: costi, servizi inclusi, per chi lavora in autonomia o da remoto' },
  { keyword: 'clima e meteo ticino stagioni caratteristiche', angle: 'Il clima del Ticino stagione per stagione: temperature medie, precipitazioni, il fenomeno del favonio, cosa aspettarsi durante l\'anno' },
  { keyword: 'shopping outlet centri commerciali ticino', angle: 'Guida allo shopping in Ticino: outlet, centri commerciali, orari di apertura, confronto prezzi con l\'Italia' },
  { keyword: 'trasporti pubblici ticino guida abbonamenti generali', angle: 'Guida generale ai trasporti pubblici in Ticino: rete Arcobaleno, tipologie di abbonamento, app utili per orari e biglietti' },
  { keyword: 'pensionarsi in svizzera per chi si trasferisce non frontaliere', angle: 'Andare in pensione in Svizzera per chi si trasferisce senza background da frontaliere: requisiti di residenza, fiscalità, qualità della vita' },
  { keyword: 'sport e tempo libero ticino strutture sportive', angle: 'Strutture sportive e attività per il tempo libero in Ticino: piscine, palestre, centri sportivi comunali, costi di iscrizione' },
  // Local events/culture batch (2026-07-17): data-justified — see
  // TOPICAL_KEYWORDS comment. Practical/cost-and-transport angle keeps
  // continuity with the site's cross-border-resident niche while covering
  // genuinely broad-appeal content proven to drive traffic.
  { keyword: 'chiassoletteraria festival letterario chiasso date', angle: 'Chiassoletteraria: il festival letterario di Chiasso — programma, ospiti, ingresso libero, come raggiungerlo da chi vive nell\'area di confine' },
  { keyword: 'locarno film festival biglietti piazza grande', angle: 'Locarno Film Festival: come vedere le proiezioni in Piazza Grande, prezzi, prenotazione, consigli per chi arriva dall\'Italia in giornata' },
  { keyword: 'mercatini di natale ticino lugano bellinzona', angle: 'I mercatini di Natale in Ticino: Lugano, Bellinzona e Locarno a confronto — orari, bancarelle, come arrivare in treno o auto dal confine' },
  { keyword: 'rabadan carnevale bellinzona programma', angle: 'Rabadan, il carnevale di Bellinzona: programma, cortei, come raggiungerlo dall\'area di confine, consigli per famiglie' },
  { keyword: 'sagra dell uva mendrisio settembre', angle: 'La Sagra dell\'Uva di Mendrisio: date, corteo allegorico, degustazioni, come arrivare e parcheggiare da chi vive vicino al confine' },
  { keyword: 'longlake festival lugano eventi gratuiti', angle: 'LongLake Festival a Lugano: calendario eventi gratuiti, location, come organizzare una serata dall\'altra parte del confine' },
  { keyword: 'blues to bop lugano concerti gratuiti', angle: 'Blues to Bop a Lugano: date, concerti gratuiti in piazza, come organizzare la trasferta serale da chi vive vicino al confine' },
  { keyword: 'fiera di lugano manifestazioni annuali', angle: 'Le principali fiere e manifestazioni annuali a Lugano: calendario, ingresso, cosa aspettarsi, utile per chi organizza la trasferta dal confine' },
];

// ── Long-tail SEO: evergreen keyword topics — sezione `svizzera` (2026-07-21) ──
// National-scope counterpart to PRIORITY_EVERGREEN_TOPICS above. The `svizzera`
// section targets anyone living/working in Switzerland at national scale (see
// the prompt framing near IS_FRONTALIERE — "NON sei limitato ai frontalieri",
// spans all cantons), NOT the frontaliere/Ticino niche. Before this pool
// existed, the Fase 2 fallback for `svizzera` reused PRIORITY_EVERGREEN_TOPICS
// (100% Ticino/frontaliere keywords) whenever Fase 1 found no usable news —
// every /articoli-svizzera/ evergreen article ended up Ticino-scoped despite
// the national prompt wrapper. Keep entries genuinely national/cantonal, no
// frontaliere framing.
const PRIORITY_EVERGREEN_TOPICS_SVIZZERA = [
  { keyword: 'confronto imposta cantonale svizzera cantoni', angle: 'Confronto tra le aliquote di imposta cantonale in Svizzera: perché Zugo e Svitto costano meno di Ginevra o Vaud, con esempi di calcolo' },
  { keyword: 'costo della vita per cantone svizzera', angle: 'Costo della vita nei principali cantoni svizzeri: affitti, spesa, trasporti e assicurazioni a confronto tra Zurigo, Ginevra, Berna, Basilea e Ticino' },
  { keyword: 'premi cassa malati lamal per cantone', angle: 'Perché i premi LAMal variano così tanto tra cantoni: fattori regionali, come cambiare cassa, franchigia ottimale e sussidi disponibili' },
  { keyword: 'salario medio in svizzera per professione', angle: 'Salari medi per professione e settore in Svizzera: dati ufficiali UST/BFS, differenze tra cantoni e città, fattori che spiegano il divario' },
  { keyword: 'secondo pilastro lpp guida completa svizzera', angle: 'Guida al secondo pilastro LPP: come funziona, contributi, riscatto lacune, prelievo per acquisto casa o partenza dalla Svizzera' },
  { keyword: 'terzo pilastro 3a vantaggi fiscali svizzera', angle: 'Terzo pilastro 3a: vantaggi fiscali reali, differenze tra 3a bancario e assicurativo, quanto versare per ottimizzare le imposte' },
  { keyword: 'affitti svizzera diritti inquilino disdetta', angle: 'Diritti dell\'inquilino in Svizzera: deposito cauzionale, procedura di disdetta, contestazione dell\'affitto, differenze cantonali' },
  { keyword: 'dichiarazione delle imposte in svizzera guida', angle: 'Guida pratica alla dichiarazione delle imposte in Svizzera: scadenze cantonali, deduzioni ammesse, procedura online per cantone' },
  { keyword: 'permesso di soggiorno svizzera tipologie B C L', angle: 'Permessi di soggiorno in Svizzera: differenze tra permesso B, C e L, requisiti, durata e procedura di rinnovo o conversione' },
  { keyword: 'cercare lavoro in svizzera dall estero guida', angle: 'Come cercare lavoro in Svizzera: portali di annunci, CV in formato svizzero, colloqui, permesso di lavoro e primi passi burocratici' },
  { keyword: 'aprire un attivita in svizzera guida pratica', angle: 'Aprire un\'attività in Svizzera: forma giuridica, registro di commercio, capitale minimo, differenze cantonali e oneri fiscali' },
  { keyword: 'assicurazione disoccupazione svizzera come funziona', angle: 'Assicurazione disoccupazione svizzera: requisiti, calcolo dell\'indennità, durata delle prestazioni, obblighi verso l\'URC' },
  { keyword: 'naturalizzazione svizzera requisiti procedura', angle: 'Naturalizzazione svizzera: requisiti di residenza, esame di integrazione, costi e differenze procedurali tra cantoni e comuni' },
  { keyword: 'sistema sanitario svizzero lamal come funziona', angle: 'Come funziona il sistema sanitario svizzero: obbligo LAMal, scelta della cassa malati, franchigia, rimborsi e pronto soccorso' },
  { keyword: 'comprare casa in svizzera mutuo requisiti', angle: 'Comprare casa in Svizzera: requisiti del mutuo ipotecario, fondi propri minimi, tassi, differenze tra banche cantonali e private' },
  { keyword: 'votazioni federali svizzera come funzionano', angle: 'Come funziona la democrazia diretta svizzera: iniziative popolari, referendum, doppia maggioranza di popolo e cantoni' },
  { keyword: 'trasporti pubblici svizzera abbonamenti sconti', angle: 'Guida agli abbonamenti di trasporto pubblico in Svizzera: AG, mezza tariffa, abbonamenti cantonali e comunitari, costi e vantaggi' },
  { keyword: 'lavoro part-time in svizzera diritti contratto', angle: 'Lavoro part-time in Svizzera: diritti contrattuali, contributi sociali proporzionali, ferie, differenze rispetto al tempo pieno' },
  { keyword: 'congedo parentale svizzera durata indennita', angle: 'Congedo di maternità e paternità in Svizzera: durata, indennità giornaliera, procedura di richiesta, differenze cantonali per gli assegni' },
  { keyword: 'franco svizzero economia bns politica monetaria', angle: 'Il ruolo della Banca Nazionale Svizzera (BNS): politica monetaria, tassi di interesse, impatto del franco forte su economia e salari' },
];

// ── News sources to auto-scan ───────────────────────────────
const NEWS_SOURCES = [
  // tvsvizzera
  'https://www.tvsvizzera.it/tvs/',
  'https://www.tvsvizzera.it/tvs/attualit%c3%a0/',
  'https://www.tvsvizzera.it/tvs/lavoro-ed-economia/',
  // ticinonews
  'https://www.ticinonews.ch/ticino',
  // tio.ch (RSS)
  'https://media.tio.ch/files/domains/tio.ch/rss/rss_ticino.xml',
  'https://media.tio.ch/files/domains/tio.ch/rss/rss_home.xml',
  // cdt
  'https://www.cdt.ch/news/ticino',
  // rsi.ch (RSS)
  'https://www.rsi.ch/info/ticino-grigioni-e-insubria/',
  // 2026-05-13: fix typo `ticino-e-grigioni-e-insubria` → `ticino-grigioni-e-insubria` (old URL 404)
  'https://www.rsi.ch/info/ticino-grigioni-e-insubria/?f=rss',
  // laregione (RSS)
  'https://media.laregione.ch/files/domains/laregione.ch/rss/rss_ticino.xml',
  'https://media.laregione.ch/files/domains/laregione.ch/rss/rss_aperture.xml',
  'https://media.laregione.ch/files/domains/laregione.ch/rss/feed_rss.xml',
  // Canton Ticino istituzionale (RSS)
  'https://www3.ti.ch/xml/rss/rss-comunicati-1108.xml',
  'https://www3.ti.ch/xml/rss/rss-attualita.xml',
  // comozero
  'https://comozero.it/',
  'https://www.comozero.it/feed/',
  // varesenews (tag frontalieri + generale)
  'https://www.varesenews.it/tag/frontalieri/feed/',
  'https://www.varesenews.it/feed/',
  // varesenoi
  'https://www.varesenoi.it/rss.xml',
  // il giornale del ticino
  'https://www.ilgiornaledelticino.ch/feed/',
  // copertura categoria economia per aumentare topic finanziari/lavoro
  'https://www.cdt.ch/news/economia',
  'https://www.cdt.ch/news/svizzera',
  'https://www.tio.ch/ticino/economia',  // was /economia (404), fixed to /ticino/economia (FRO-415)
  'https://www.tio.ch/ticino/cronaca',
  'https://www.rsi.ch/info/economia/',
  'https://www.rsi.ch/info/svizzera/?f=rss',
  // ── 2026-05-07: frontaliere-specific feeds (Wave 1) — added after
  // diagnosis showed the news pool was 1.6% frontaliere-relevant (9/564).
  // These tag/category pages produce mostly cross-border-work content.
  // 2026-05-13: svizzera-italia-frontalieri/ → qui-frontiera/ (old 404, new is canonical frontalieri section on TVS)
  'https://www.tvsvizzera.it/tvs/qui-frontiera/',
  'https://www.tvsvizzera.it/tvs/economia/',
  // 2026-05-13: cdt.ch/dossier/frontalieri-... 404 (CDT has no such dossier); replaced with cdt.ch/news/mondo for IT-CH bilateral coverage
  'https://www.cdt.ch/news/mondo',
  'https://www.tio.ch/svizzera/economia',
  'https://www.tio.ch/ticino/lavoro',
  // 2026-05-13: cdt.ch/news/lavoro 404 (CDT has no lavoro news category); replaced with cdt.ch/lifestyle/portafoglio (finance/fiscal coverage)
  'https://www.cdt.ch/lifestyle/portafoglio',
  'https://www.laregione.ch/economia',
  'https://www.varesenews.it/tag/frontalieri/',          // HTML fallback
  'https://www.varesenoi.it/sommario/argomenti/economia-7.html',
  // ── 2026-05-07: frontaliere-dedicated feeds (Wave 2 — strategic) —
  // sindacati, ACIF, fiscalità tecnica, comparis. Primary signal:
  // every headline from these sources is high-probability frontaliere-
  // relevant by virtue of the source's audience.
  // Cross-border official + sindacati ──
  // 2026-05-13: swissinfo.ch RSS feed returns 410 Gone (intentional kill by SWI); HTML home page works and lists articles
  'https://www.swissinfo.ch/ita/',
  // 2026-05-13: cgil.lombardia.it/categoria/frontalieri/feed/ → tag/frontalieri/feed/ (correct WP taxonomy path; RSS confirmed working with frontalieri-specific items)
  'https://www.cgil.lombardia.it/tag/frontalieri/feed/',
  // 2026-05-13: ocst.ch/feed/ 404 (no site-wide WP feed); replaced with the dedicated frontalieri section HTML (same OCST Ticino role)
  'https://www.ocst.ch/frontalieri',                      // Sindacato OCST Ticino (HTML — RSS not exposed)
  // 2026-05-13: unia.ch/it/news/feed 404 (no RSS exposed); replaced with HTML comunicati-stampa page (same Unia CH role)
  'https://unia.ch/it/media/comunicati-stampa',           // Sindacato Unia (CH) — HTML, RSS not exposed
  'https://www.uil.it/feed',                              // UIL nazionale (frontalieri)
  // Health/insurance cross-border ──
  // 2026-05-13: comparis.ch returns 403 (active bot block on the RSS); replaced with santésuisse news (same LAMal/health-insurance role, accessible)
  'https://www.santesuisse.ch/it/temi-e-analisi/news-attuali/',  // santésuisse LAMal news (HTML, replaces 403-blocked comparis RSS)
  // 2026-05-13: bag.admin.ch RSS path moved/removed (.rss/news.rss now 404); replaced with HTML news listing (same federal health-authority role)
  'https://www.bag.admin.ch/it/overview/news',            // Bundesamt Gesundheit IT (HTML — RSS retired)
  // Fiscalità tecnica + dossier frontalieri ──
  // 2026-05-13: fiscoetasse.com/rss/articoli.xml 404; /feed is the working RSS endpoint
  'https://www.fiscoetasse.com/feed',
  'https://www.commercialistatelematico.com/feed',
  // 2026-05-13: ipsoa.it (entire domain now Wolters Kluwer login-walled); replaced with lavoroediritti.com (open RSS, IT labor/fiscal coverage)
  'https://www.lavoroediritti.com/feed/',                 // IT labor & fiscal news (replaces login-walled Ipsoa)
  // Geo-specific cross-border ──
  'https://www.corriere.it/dynamic-feed/rss/section/cronache.xml',  // borderline but covers IT-CH cronaca
  'https://www.varesenews.it/tag/dogana-svizzera/feed/',   // dogana feed
  // 2026-05-13: cdt.ch/news/eu-frontaliere removed — no such category exists on CDT; coverage already provided by /news/svizzera, /news/economia, /news/mondo
  'https://comozero.it/categoria/frontalieri/',            // comozero frontalieri tag
  // 2026-05-13: varesenoi.it/sommario/argomenti/economia-7/economia-frontalieri-1.html removed (404, sub-category no longer exists); /sommario/argomenti/economia-7.html above already covers economia
  'https://www.varesenoi.it/?s=frontalieri',               // varesenoi WP search for frontalieri (HTML, dead sub-category replacement)
  // swissinfo.ch RSS removed — 410 Gone (FRO-415, re-confirmed 2026-05-13 — HTML home page added above as replacement)
  // admin.ch RSS removed — WAF challenge blocks scraping (FRO-415)
  // 2026-07-01 (issue #3138 Leva #1): Italian institutional feeds, national
  // scope but heavily pension/fiscal — filtered downstream by the same
  // FRONTALIERI_DOMAIN_RE relevance gate as every other source. Both
  // curl-verified live before adding (INPS/Agenzia Entrate have no
  // frontaliere-scoped feed, only site-wide news).
  'https://www.inps.it/it/it.rss.news.xml',                // INPS — pensioni/AVS-INPS/NASpI national news
  'https://www.agenziaentrate.gov.it/portale/c/portal/rss/entrate?idrss=0753fcb1-1a42-4f8c-f40d-02793c6aefb4', // Agenzia Entrate — comunicati (730, quadro CE, dichiarazioni)
];

// Fallback: when an RSS feed yields 0 recent items, scrape the base HTML site instead
const RSS_FALLBACK_MAP = {
  'https://media.tio.ch/files/domains/tio.ch/rss/rss_ticino.xml': 'https://www.tio.ch/ticino',
  'https://media.tio.ch/files/domains/tio.ch/rss/rss_home.xml': 'https://www.tio.ch/',
  'https://www.rsi.ch/info/ticino-grigioni-e-insubria/?f=rss': 'https://www.rsi.ch/info/ticino-grigioni-e-insubria/',
  'https://media.laregione.ch/files/domains/laregione.ch/rss/rss_ticino.xml': 'https://www.laregione.ch/ticino',
  'https://media.laregione.ch/files/domains/laregione.ch/rss/rss_aperture.xml': 'https://www.laregione.ch/',
  'https://media.laregione.ch/files/domains/laregione.ch/rss/feed_rss.xml': 'https://www.laregione.ch/',
  'https://www3.ti.ch/xml/rss/rss-comunicati-1108.xml': 'https://www.ti.ch/comunicati',
  'https://www3.ti.ch/xml/rss/rss-attualita.xml': 'https://www.ti.ch/attualita',
  'https://www.comozero.it/feed/': 'https://www.comozero.it/',
  'https://www.varesenews.it/tag/frontalieri/feed/': 'https://www.varesenews.it/tag/frontalieri/',
  'https://www.varesenews.it/feed/': 'https://www.varesenews.it/',
  'https://www.varesenoi.it/rss.xml': 'https://www.varesenoi.it/sommario/argomenti/economia-7.html',
  'https://www.ilgiornaledelticino.ch/feed/': 'https://www.ilgiornaledelticino.ch',
  'https://www.rsi.ch/info/svizzera/?f=rss': 'https://www.rsi.ch/info/svizzera/',
  // swissinfo.ch removed — 410 Gone (FRO-415)
  // admin.ch removed — WAF challenge (FRO-415)
};

// ── Switzerland-wide news sources (section="svizzera") ───────────
// National scope: economy, taxes, work, living, housing for ANYONE who
// lives or works in CH — NOT restricted to cross-border workers. Mirrors
// the shape of NEWS_SOURCES (RSS where available, HTML fallback via
// NEWS_SOURCES_SVIZZERA_FALLBACK_MAP otherwise).
//
// ── THE ORDER IS LOAD-BEARING (rebuilt 2026-08-10) ──
// scanNewsSources() keeps every dated headline from the last
// MAX_ARTICLE_AGE_DAYS, but caps the *undated* ones at `undated.slice(0, 120)`
// — a single global budget, filled in the order the sources appear here,
// because `allHeadlines` is pushed batch-by-batch in list order.
// swissinfo.ch used to sit first and emits ~244 undated links per run, most
// of them chrome ("Vai alla homepage", "Vai alla navigazione"). Measured on
// 2026-08-10 with the real extractor: it took **120 of 120** undated slots,
// so cdt.ch's 26 real Swiss-economy headlines, seco.admin.ch's labour-market
// releases and admin.ch's press releases never entered the pool at all.
// Pool surviving the anchor+topical gate: 21.
//
// Hence the layout: dated RSS first (dated items bypass the cap, so they cost
// no undated budget), then HTML pages ordered by *measured* gate-pass density,
// then the SPA shells that emit mostly chrome. Same probe, same day, same
// gate: 21 → 55 with laregione's RSS stale, 21 → 72 with it fresh.
//
// ── EVERY URL HERE WAS PROBED ON 2026-08-10 ──
// status + content-type + what the extractor actually returns. Do not add a
// source without doing the same. A 200 proves nothing on its own:
// santesuisse.ch answered 200 (and counted as `sources.succeeded`) while
// every one of its paths 301'd to a German training site on another domain.
// The per-line numbers are that probe's yield — keep them updated, they are
// the only reason the next reader can tell a live source from a dead one.
//
// `[dup:frontaliere]` marks a URL that is also in NEWS_SOURCES. That overlap
// is deliberate — these are national desks that serve both audiences, and the
// two sections classify independently against different registries (ARTICLES
// vs SWISS_ARTICLES), each keeping only what fits its own agenda. The cost is
// one extra classifier call per shared headline. The marker is enforced by
// generator/tests/news-sources-svizzera.test.mjs, so the overlap (15 of 26
// URLs before this pass, silently) can never grow unannounced again.
const NEWS_SOURCES_SVIZZERA = [
  // ── RSS datati: non consumano il budget undated ──
  'https://www.rsi.ch/info/svizzera/?f=rss',   // [dup:frontaliere] 100 item, 100 datati, 19 recenti
  'https://www.rsi.ch/info/economia/?f=rss',   // 100 item, 100 datati, 25 passano il gate
  // 2026-08-10: rss_svizzera.xml e rss_economia.xml scoperti dal catalogo
  // pubblicato su tio.ch/rss e laregione.ch/rss — le stesse due sezioni che
  // prima venivano raschiate in HTML senza mai ricavarne una data.
  // NB: media.tio.ch/…/rss_affari.xml e rss_economia.xml esistono ma tornano
  // 200 con **0 byte**: sondati e scartati, non dimenticati.
  'https://media.tio.ch/files/domains/tio.ch/rss/rss_svizzera.xml',            // 20 item, 20 datati, 20 recenti
  'https://media.tio.ch/files/domains/tio.ch/rss/rss_home.xml',                // [dup:frontaliere] 20 item, 20 recenti
  'https://lenews.ch/feed/',                                                   // Le News (EN, living/working in CH) — 10 item, 4 recenti
  'https://www.fiscoetasse.com/feed',                                          // [dup:frontaliere] 20 item, 8 recenti
  'https://www.lavoroediritti.com/feed',                                       // [dup:frontaliere] 20 item — senza `/` finale: con lo slash è un 301
  'https://media.laregione.ch/files/domains/laregione.ch/rss/rss_economia.xml', // 2 item, 2 datati
  'https://media.laregione.ch/files/domains/laregione.ch/rss/rss_svizzera.xml', // 26 item, 26 datati
  // ── HTML con titoli veri, in ordine di densità misurata sul gate ──
  'https://www.seco.admin.ch/it/comunicati-stampa',                            // SECO lavoro/economia — 17/22 passano il gate
  'https://www.admin.ch/it/newnsb',                                            // Consiglio federale — 15/20; era …/documentazione/comunicati-stampa.html (301)
  'https://www.tio.ch/svizzera/economia',                                      // [dup:frontaliere] 26/38
  'https://www.cdt.ch/news/economia',                                          // [dup:frontaliere] 10/40 — CDT non espone alcun feed (rss e feed: 404)
  'https://www.tvsvizzera.it/tvs/lavoro-ed-economia/',                         // [dup:frontaliere] 6/22
  'https://www.swissinfo.ch/ita/il-futuro-del-lavoro/',                        // 20/97 — sostituisce /ita/economia/ (404)
  'https://www.cdt.ch/news/svizzera',                                          // [dup:frontaliere] 3/40
  'https://www.tvsvizzera.it/tvs/economia/',                                   // [dup:frontaliere] 3/32
  // ── Shell SPA: molto chrome, quindi in fondo ──
  'https://www.swissinfo.ch/ita/',                                             // [dup:frontaliere] 139 item, 15 recenti, 18/139 sul gate
  'https://www.swissinfo.ch/ita/topic/politica-svizzera/',                     // 13/93 — sostituisce /ita/politica/ (301 → 404)
];
// Rimossi il 2026-08-10, ognuno con la misura che lo condanna:
//   swissinfo.ch/ita/economia/ ......... 404
//   swissinfo.ch/ita/politica/ ......... 301 → /ita/topic/politica-federale/ → 404
//   watson.ch/api/1.0/rss/all.xml ...... 404. Il feed vivo è api/**2.0**/rss/index.xml?tag=Front
//                                        (200, 90 item, 88 recenti) ma è in tedesco e generalista:
//                                        2/90 sul gate. Sondato, non adottato.
//   santesuisse.ch/it/…/news-attuali/ .. dominio morto: OGNI path 301 → santeservices.ch/bildung/,
//                                        200 in tedesco su formazione. Contava come `succeeded`.
//   bfs.admin.ch/…/comunicati-stampa ... 200, 2,3 MB, **zero tag <a>**: SPA Vue/AEM, l'elenco
//                                        arriva via JS. Nessun estrattore a regex può leggerla.
//   bag.admin.ch/it/overview/news ...... 200 ma solo 6 link, tutti di navigazione. Stessa SPA.
//   rsi.ch/info/mondo/?f=rss ........... esteri: 6/100 sul gate, e sono Messico, Francia, Meta/USA,
//                                        Marocco, Ceuta, FED. Zero rilevanza nazionale CH.
//   cdt.ch/news/mondo .................. esteri: 1/40, ed è il Pentagono.
//   swissinfo.ch/ita/scienza/ .......... 200 e 18/121 sul gate, ma fuori dall'agenda dichiarata
//                                        (economia/fisco/lavoro/abitare); i suoi pezzi in tema
//                                        sono coperti meglio da /ita/il-futuro-del-lavoro/ (20/97).
//   tvsvizzera.it/tvs/ ................. home: 4/45, e lo stesso chrome delle due sezioni già in lista.
//   laregione.ch/svizzera, /economia ... promossi a fallback dei rispettivi RSS (sotto): la pagina
//                                        HTML non produce una sola data, il feed le produce tutte.

// HTML fallbacks for the svizzera RSS feeds that may yield 0 recent items.
// Contract: **ogni sorgente RSS di NEWS_SOURCES_SVIZZERA ha una voce qui**,
// verificato da news-sources-svizzera.test.mjs. Non vale il contrario — una
// sorgente HTML non consulta mai questa mappa: in scanNewsSources() il lookup
// `rssFallbackMap[sourceUrl]` sta solo dentro il ramo `if (isRssFeed(content))`,
// quindi una voce per admin.ch o seco.admin.ch sarebbe codice morto.
// Tutti i target sondati il 2026-08-10: 200 + headline estratte.
const NEWS_SOURCES_SVIZZERA_FALLBACK_MAP = {
  'https://www.rsi.ch/info/svizzera/?f=rss': 'https://www.rsi.ch/info/svizzera/',
  'https://www.rsi.ch/info/economia/?f=rss': 'https://www.rsi.ch/info/economia/',
  'https://media.tio.ch/files/domains/tio.ch/rss/rss_svizzera.xml': 'https://www.tio.ch/svizzera',
  'https://media.tio.ch/files/domains/tio.ch/rss/rss_home.xml': 'https://www.tio.ch/',
  'https://lenews.ch/feed/': 'https://lenews.ch/',
  'https://www.fiscoetasse.com/feed': 'https://www.fiscoetasse.com/',
  'https://www.lavoroediritti.com/feed': 'https://www.lavoroediritti.com/',
  'https://media.laregione.ch/files/domains/laregione.ch/rss/rss_economia.xml': 'https://www.laregione.ch/economia',
  'https://media.laregione.ch/files/domains/laregione.ch/rss/rss_svizzera.xml': 'https://www.laregione.ch/svizzera',
};

// `../..`, not `..`. In main this script sits at `scripts/create-article.mjs`,
// so one level up WAS the repo root; the transport (#4974 item 3, step 2) put it
// at `generator/scripts/create-article.mjs`, which makes one level up the
// `generator/` directory. Left unchanged, every read and write in this file
// would have been scoped to `generator/…` — reads would fail and writes would
// create a phantom corpus inside the generator tree.
const PROJECT_ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

// ── Helpers ─────────────────────────────────────────────────
// Every read and write in this file funnels through here, which is what makes
// `corpusPath()` a single choke point for the main→nanako layout difference
// (`services/locales/…` → `content/…`) instead of ~30 edited literals. See
// lib/corpus-paths.mjs for why the mapping is an explicit table.
function resolve(rel) {
  return `${PROJECT_ROOT}/${corpusPath(rel)}`;
}

function read(rel) {
  return readFileSync(resolve(rel), 'utf-8');
}

// Write-time guard (issue #66): a `.ts` under content/ must never carry a C0
// control character other than TAB/LF/CR — they have shown up as the residue
// of a mangled accented letter or typographic quote (`sar\x170` for «sarà»).
// This is the single write choke point for the generator, so stripping here
// is what makes it IMPOSSIBLE for the corpus to receive one, rather than
// relying on every future write call site to remember to sanitize.
function write(rel, content) {
  const clean = sanitizeText(content);
  // Non basta togliere il byte: toglierlo distrugge il MARKER che rende
  // esatta una riparazione futura (issue #95). Si registra prima, con il
  // contesto che conserva la coppia (byte, carattere seguente).
  reportStrippedControlChars(rel, content, clean);
  writeFileSync(resolve(rel), clean, 'utf-8');
}

// ── Section config (--section=frontaliere|svizzera) ──────────────
// Single source of truth for the two parallel article hubs. The overlapping
// fields (hubSlug/registryFile/slugDataFile/slugsConstName/metaPrefix/bodyDir)
// come from ../build-plugins/shared/articleSectionCore.mjs's ARTICLE_SECTION_CORE
// — the same canonical tuple services/articleSections.ts re-exports as
// ARTICLE_SECTIONS (issue #4881 Fase 6, AGENTS.md #6; this .mjs can import
// that core directly, no TS loader needed — it's plain JS). Every other field
// below (label/newsSources/rssFallbackMap/seoFile/embeddings paths/etc.) is
// genuinely unique to this script and stays hand-authored. For
// section="frontaliere" every value is still the original literal so the
// default path stays byte-identical.
//
// Per spec: the discovery-pool / evidence / quota slot machinery stays
// frontaliere-only for now. The svizzera section uses the proven-only path
// (scan CH sources → classify → generate → dedup vs SWISS_ARTICLES/embeddings
// → write). The WRITE path + proven generation are fully section-aware.
export const ARTICLE_SECTION_CONFIGS = {
  frontaliere: {
    section: 'frontaliere',
    label: 'Frontaliere Ticino',
    // News discovery
    newsSources: NEWS_SOURCES,
    rssFallbackMap: RSS_FALLBACK_MAP,
    // Localized hub slugs (URL path segment per locale)
    hubSlug: ARTICLE_SECTION_CORE.frontaliere.indexSlug,
    // Registry / slug-data / meta / body / seo write targets
    registryFile: ARTICLE_SECTION_CORE.frontaliere.registryFile,
    registryArrayName: 'ARTICLES',
    slugDataFile: ARTICLE_SECTION_CORE.frontaliere.slugDataFile,
    slugsConstName: ARTICLE_SECTION_CORE.frontaliere.slugConst,
    allIdsConstName: 'ALL_BLOG_ARTICLE_IDS',
    // frontaliere also maintains the BlogArticleId union in router.ts
    updateRouterUnion: true,
    metaPrefix: ARTICLE_SECTION_CORE.frontaliere.metaPrefix, // services/locales/blog-meta-{loc}.ts
    bodyDir: ARTICLE_SECTION_CORE.frontaliere.bodyDir,       // services/locales/blog-body/{loc}/{id}.ts
    seoFile: 'services/seo/seo-blog-5.ts',
    seoConstName: 'BLOG_SEO_METADATA', // matched with optional _\d+ suffix
    sitemapFile: 'public/sitemap-blog.xml',
    sitemapUrl: 'https://frontaliereticino.ch/sitemap-blog.xml',
    // Per-section dedup / state isolation
    embeddingsBinPath: 'data/article-embeddings.bin',
    embeddingsMetaPath: 'data/article-embeddings-meta.json',
    sidecarDir: 'data/blog-articles',
    sourceQuotaFile: 'data/article-source-quotas.json',
    sourceUrlsFile: 'data/article-source-urls.json',
  },
  svizzera: {
    section: 'svizzera',
    label: 'Articoli Svizzera',
    newsSources: NEWS_SOURCES_SVIZZERA,
    rssFallbackMap: NEWS_SOURCES_SVIZZERA_FALLBACK_MAP,
    hubSlug: ARTICLE_SECTION_CORE.svizzera.indexSlug,
    registryFile: ARTICLE_SECTION_CORE.svizzera.registryFile,
    registryArrayName: 'SWISS_ARTICLES',
    slugDataFile: ARTICLE_SECTION_CORE.svizzera.slugDataFile,
    slugsConstName: ARTICLE_SECTION_CORE.svizzera.slugConst,
    allIdsConstName: 'ALL_SWISS_ARTICLE_IDS',
    // svizzera ids are loose strings — no BlogArticleId union to touch.
    updateRouterUnion: false,
    metaPrefix: ARTICLE_SECTION_CORE.svizzera.metaPrefix, // services/locales/blog-meta-ch-{loc}.ts
    bodyDir: ARTICLE_SECTION_CORE.svizzera.bodyDir,       // services/locales/blog-body-ch/{loc}/{id}.ts
    seoFile: 'services/seo/seo-blog-ch.ts',
    seoConstName: 'BLOG_CH_SEO_METADATA',
    sitemapFile: 'public/sitemap-blog-ch.xml',
    sitemapUrl: 'https://frontaliereticino.ch/sitemap-blog-ch.xml',
    embeddingsBinPath: 'data/swiss-article-embeddings.bin',
    embeddingsMetaPath: 'data/swiss-article-embeddings-meta.json',
    sidecarDir: 'data/swiss-articles',
    sourceQuotaFile: 'data/swiss-article-source-quotas.json',
    sourceUrlsFile: 'data/swiss-article-source-urls.json',
  },
};

/** Parse --section=<name> from argv (default frontaliere). Validates. */
function parseSectionArg(argv) {
  let section = process.env.ARTICLE_SECTION || 'frontaliere';
  for (const a of argv) {
    const m = /^--section=(.+)$/.exec(a);
    if (m) section = m[1];
  }
  if (!ARTICLE_SECTION_CONFIGS[section]) {
    throw new Error(
      `Invalid --section="${section}". Valid: ${Object.keys(ARTICLE_SECTION_CONFIGS).join(', ')}`,
    );
  }
  return section;
}

const SECTION_NAME = parseSectionArg(process.argv.slice(2));
const SECTION = ARTICLE_SECTION_CONFIGS[SECTION_NAME];
const IS_FRONTALIERE = SECTION_NAME === 'frontaliere';
// Stamped here rather than in the RUN_REPORT literal because SECTION_NAME is
// parsed from argv ~700 lines later than the report is declared.
RUN_REPORT.section = SECTION_NAME;

// Section-keyed source-tracking files (frontaliere defaults = original paths).
const SOURCE_QUOTA_FILE = SECTION.sourceQuotaFile;
const SOURCE_URLS_FILE = SECTION.sourceUrlsFile;

if (!IS_FRONTALIERE) {
  console.error(`📦 Sezione attiva: ${SECTION_NAME} (${SECTION.label}) — hub /${SECTION.hubSlug.it}/`);
}

// ── Section-aware headline-selection editor prompt ──────────────
// Frontaliere branch = byte-identical to the historical prompt (drives ~95%
// revenue). Svizzera branch reframes the selection criteria around NATIONAL
// Swiss relevance (federal/cantonal policy, economy, fisco, lavoro, vita, casa)
// for a general Swiss-resident audience — NOT a frontaliere/Ticino angle.
function HEADLINE_SELECTION_PROMPT(headlineList, recentArticles) {
  return IS_FRONTALIERE
    ? `Sei un editor del sito Frontaliere Ticino (frontaliereticino.ch).
Devi scegliere UN articolo da queste headline di notizie ticinesi per scrivere un pezzo per i frontalieri.

HEADLINE DISPONIBILI:
${headlineList}

ARTICOLI GIÀ PUBBLICATI (NON scegliere argomenti simili o già coperti):
${recentArticles}

CRITERI DI SELEZIONE (in ordine di priorità):
1. ⭐ PRIORITÀ ASSOLUTA: Se ci sono headline marcate con ⭐FRONTALIERI, scegli TRA QUELLE — sono notizie che menzionano esplicitamente frontalieri, permessi, accordi fiscali, dogane o lavoro transfrontaliero
2. RILEVANZA FRONTALIERI: Priorità a notizie su lavoro transfrontaliero, fisco, permessi, stipendi, accordi CH-IT, economia ticinese, mercato del lavoro, trasporti transfrontalieri
2.1 CLUSTER SEO PRIORITARI: favorisci headline che possono intercettare query ad alta intenzione su:
   - calcolo tasse frontalieri entro/oltre 20km
   - pensione frontaliere (AVS/INPS, pilastri)
   - cambio CHF EUR e ottimizzazione conversione
3. NOVITÀ: Preferisci notizie recenti e con impatto concreto (nuove leggi, dati, statistiche)
4. ⚠️ NO DUPLICATI (CRITICO): Non scegliere MAI un tema già coperto. Se la headline tratta lo stesso argomento/dati/statistiche di un articolo esistente (anche con un angolo diverso), SCARTALA. Due articoli sugli stessi dati UST/SECO/BFS sono duplicati anche se il titolo è diverso.
5. NO CRONACA NERA: Evita incidenti, crimini, disastri naturali
6. NO SPORT: Evita risultati sportivi, partite, campionati
7. SPECIFICITÀ TICINO: La notizia deve riguardare il Canton Ticino o la regione di confine

${JSON_QUOTE_SAFETY_RULE_IT}

Rispondi con un JSON object (no markdown, no code fences):
{
  "selectedIndex": <numero dell'headline scelta>,
  "reason": "<perché questa notizia è rilevante per i frontalieri, max 2 frasi>"
}`
    : `Sei un editor di un sito di informazione svizzera a livello NAZIONALE (frontaliereticino.ch, sezione Svizzera).
Devi scegliere UN articolo da queste headline di notizie per scrivere un pezzo di interesse nazionale per chi vive o lavora in Svizzera.

HEADLINE DISPONIBILI:
${headlineList}

ARTICOLI GIÀ PUBBLICATI (NON scegliere argomenti simili o già coperti):
${recentArticles}

CRITERI DI SELEZIONE (in ordine di priorità):
1. RILEVANZA NAZIONALE: Priorità a notizie che riguardano chi vive o lavora in Svizzera nel suo complesso — politica federale e cantonale, economia, fisco (imposta federale diretta, IVA, fiscalità cantonale), mercato del lavoro, costo della vita, casa/affitti, previdenza (AVS/AHV, LPP/BVG), salute (LAMal/KVG)
1.1 CLUSTER SEO PRIORITARI: favorisci headline che possono intercettare query ad alta intenzione su:
   - costo della vita e inflazione in Svizzera
   - imposte e dichiarazione fiscale (federale/cantonale)
   - previdenza AVS/LPP e pensioni
   - salario minimo, affitti, premi cassa malati
2. NOVITÀ: Preferisci notizie recenti e con impatto concreto (nuove leggi, decisioni del Consiglio federale o cantonali, dati UST/BFS, SECO, BNS/SNB)
3. ⚠️ NO DUPLICATI (CRITICO): Non scegliere MAI un tema già coperto. Se la headline tratta lo stesso argomento/dati/statistiche di un articolo esistente (anche con un angolo diverso), SCARTALA. Due articoli sugli stessi dati UST/SECO/BFS sono duplicati anche se il titolo è diverso.
4. NO CRONACA NERA: Evita incidenti, crimini, disastri naturali
5. NO SPORT: Evita risultati sportivi, partite, campionati
6. NO INTRATTENIMENTO: Evita gossip, spettacolo, celebrità senza rilevanza politico-economica
7. RESPIRO NAZIONALE: La notizia può riguardare qualsiasi cantone o le istituzioni federali; non limitarti al Ticino.
8. ⚠️ NO TEMI FRONTALIERI (CRITICO): SCARTA le headline il cui ARGOMENTO PRINCIPALE è esclusivamente frontaliero (permesso G/B/C, ristorni Ticino-Italia, imposta alla fonte frontalieri, dogane/valichi e pendolarismo IT-CH, telelavoro frontalieri, accordo frontalieri IT-CH, soglia 20 km). Appartengono alla sezione frontalieri separata; qui sarebbero duplicati fuori scopo. ATTENZIONE: una riforma o statistica NAZIONALE (es. AVS/LPP, LAMal, mercato del lavoro, Consiglio federale) che menziona i frontalieri come categoria tra quelle impattate è RILEVANTE — il tema principale è nazionale, non frontaliero. Scegli temi a interesse nazionale generale.

${JSON_QUOTE_SAFETY_RULE_IT}

Rispondi con un JSON object (no markdown, no code fences):
{
  "selectedIndex": <numero dell'headline scelta>,
  "reason": "<perché questa notizia è di interesse nazionale per chi vive o lavora in Svizzera, max 2 frasi>"
}`;
}

// ── Section-aware registry/meta paths + readers ──────────────────
// Duplicate-detection and registry helpers must read the ACTIVE section's
// files so svizzera dedups against SWISS_ARTICLES, never against frontaliere.
const SECTION_SLUG_DATA_FILE = SECTION.slugDataFile;           // routerBlogData.ts | routerSwissData.ts
const SECTION_META_IT_FILE = `services/locales/${SECTION.metaPrefix}-it.ts`; // blog-meta-it.ts | blog-meta-ch-it.ts

/** Read the active section's slug-data source (routerBlogData|routerSwissData). */
function readSectionSlugData() {
  return read(SECTION_SLUG_DATA_FILE);
}

/**
 * Extract existing article IDs from the ACTIVE section's slugs map (`'id': {
 * it: ... }`). Used for the append-anchor (last id of THIS section) and for
 * regenerating this section's id list — both of which must stay scoped to the
 * active section's file. For cross-section dedup use {@link getAllArticleIds}.
 * Returns [] when the section registry is still empty (first article).
 */
function getSectionExistingIds(slugDataSrc) {
  const src = slugDataSrc ?? readSectionSlugData();
  // Quote-agnostic key match (mirrors getAllArticleIds): a formatter/manual
  // edit could switch an entry key to double quotes; the `\1` backreference
  // rejects mixed quotes. Key is m[2] (group 1 is the quote char).
  return [...src.matchAll(/^\s+(['"])([^'"]+)\1:\s*\{\s*it:/gm)].map((m) => m[2]);
}

/**
 * Extract article IDs across ALL article sections (frontaliere + svizzera).
 *
 * The SEO (`blog-{id}`) and i18n (`blog.article.{id}.*`) namespaces are SHARED
 * across sections, so a new id colliding with one from the sibling section
 * would silently override that page's canonical / structured-data. Dedup must
 * therefore be GLOBAL — this is what makes the "ids never collide across
 * sections" invariant true. Sibling files are read fresh, tolerated-empty.
 */
function getAllArticleIds() {
  const ids = new Set();
  for (const cfg of Object.values(ARTICLE_SECTION_CONFIGS)) {
    let src = '';
    try { src = read(cfg.slugDataFile); } catch { /* empty/missing section */ }
    for (const m of src.matchAll(/^\s+(['"])([^'"]+)\1:\s*\{\s*it:/gm)) ids.add(m[2]);
  }
  return [...ids];
}

/** Read the active section's IT meta source (blog-meta-it | blog-meta-ch-it). */
function readSectionMetaIt() {
  return read(SECTION_META_IT_FILE);
}

/**
 * Read the IT meta source of ALL sections concatenated (frontaliere +
 * svizzera). The id/SEO/i18n namespace is shared across sections (see
 * getAllArticleIds), and evergreen topics (professioni, "assicurazione vita",
 * "vivere nei Grigioni") are frequently generated in BOTH sections — but
 * checkForDuplicates historically compared titles/excerpts only within the
 * ACTIVE section's file, so cross-section near-duplicates slipped through
 * (2026-07-11: `assicurazione-vita-…-frontaliere` in svizzera vs
 * `…-frontalieri` in frontaliere, one letter apart). Both meta files use the
 * same `'blog.article.<id>.title'` key shape, so the callers' regexes work
 * unchanged over the concatenation.
 */
// Cached for the process lifetime: the evergreen pre-flight loop (Fase 2)
// calls this once per candidate — up to hundreds of times per run since the
// structural profession/comune pool (evergreen-topic-generator.mjs) was
// added — and the section meta files never change mid-run (a successful
// publish ends the phase, no further candidates get checked afterward).
let _sectionsMetaItCache = null;
function readAllSectionsMetaIt() {
  if (_sectionsMetaItCache !== null) return _sectionsMetaItCache;
  const parts = [];
  for (const cfg of Object.values(ARTICLE_SECTION_CONFIGS)) {
    try {
      parts.push(read(`services/locales/${cfg.metaPrefix}-it.ts`));
    } catch { /* missing/empty section file — skip */ }
  }
  _sectionsMetaItCache = parts.join('\n');
  return _sectionsMetaItCache;
}

// Value-quote-safe regex for 'blog.article.<id>.<field>': '<value>' meta
// entries — honors backslash-escaped quotes inside the value instead of
// truncating at the first embedded one. Consolidates what used to be 5
// independent copies of this construct in this file: 4 used a naive
// `'([^']+)'` (or `'([^']*)'`) capture that silently truncated any
// title/excerpt containing an apostrophe (e.g. "l'iniziativa",
// "dell'A9" — both real values in services/locales/blog-meta-it.ts) at the
// escaped quote, corrupting the duplicate-detection input those 4 call sites
// feed (selectArticle, loadExistingArticleSummaries, preFlightHeadlineCheck,
// checkForDuplicates) for every existing article with an apostrophe in its
// title, not just the ones just added. The 5th copy (loadExistingItTitlesExcluding)
// already had the correct escape-aware pattern; all 5 now share this one.
// metaFieldRegex / unescapeTsValue now live in scripts/lib/meta-field-regex.mjs
// (imported at the top) — one definition, so a test copy cannot drift from it.

function getIsoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7; // Mon=1 .. Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // nearest Thursday
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function normalizeSourceDomain(domain) {
  return String(domain || '')
    .toLowerCase()
    .trim()
    .replace(/^www\d?\./, '');
}

// ── Source URL tracking: prevent re-using the same news source URL ─────
function loadSourceUrls() {
  try {
    const raw = read(SOURCE_URLS_FILE);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

function saveSourceUrls(map) {
  try {
    // Keep only last 500 entries to avoid unbounded growth
    const entries = Object.entries(map);
    const trimmed = entries.length > 500
      ? Object.fromEntries(entries.slice(-500))
      : map;
    write(SOURCE_URLS_FILE, `${JSON.stringify(trimmed, null, 2)}\n`);
  } catch (e) {
    console.error(`  ⚠️  Impossibile salvare source URLs: ${e.message}`);
  }
}

/** Normalize a news source URL for dedup: strip query params, hash, trailing slash */
function normalizeNewsUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    // Remove tracking params, keep the path
    return `${u.protocol}//${u.hostname}${u.pathname}`.replace(/\/$/, '').toLowerCase();
  } catch {
    return rawUrl.toLowerCase().replace(/\/$/, '');
  }
}

function isGoogleNewsRssUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return u.hostname === 'news.google.com' && u.pathname.startsWith('/rss/articles/');
  } catch {
    return false;
  }
}

function stripNewsSourceSuffix(title) {
  return String(title || '')
    .replace(/\s+-\s+[^-]{2,80}$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function headlineSimilarity(a, b) {
  const aTokens = filterDistinctive(tokenizeIt(stripNewsSourceSuffix(a)));
  const bTokens = filterDistinctive(tokenizeIt(stripNewsSourceSuffix(b)));
  if (aTokens.length === 0 || bTokens.length === 0) return 0;
  return Math.max(jaccardSim(aTokens, bTokens), containmentSim(aTokens, bTokens), containmentSim(bTokens, aTokens));
}

function resolveGoogleNewsHeadline(candidate, provenHeadlines) {
  if (!candidate || !isGoogleNewsRssUrl(candidate.url)) return candidate;
  let best = null;
  let bestScore = 0;
  for (const h of provenHeadlines || []) {
    if (!h?.url || isGoogleNewsRssUrl(h.url)) continue;
    const score = headlineSimilarity(candidate.headline, h.headline);
    if (score > bestScore) {
      best = h;
      bestScore = score;
    }
  }
  if (best && bestScore >= 0.72) {
    return {
      ...candidate,
      url: best.url,
      source: best.source || candidate.source,
      relatedHeadlines: [
        ...(candidate.relatedHeadlines || []),
        ...(best.relatedHeadlines || []),
      ].slice(0, 5),
      _resolvedFromGoogleNewsRss: candidate.url,
      _resolvedGoogleNewsScore: bestScore,
    };
  }
  // No direct-scan twin: instead of dropping the candidate (the old behaviour
  // that discarded ~219 real frontaliere news items/run — run 29142084681,
  // the "disoccupazione frontalieri" story), keep the wrapper and flag it for
  // on-demand decoding at fetch time (decodeGoogleNewsUrl → real publisher
  // URL via batchexecute). Lazy by design: only the headline the ranker
  // actually picks pays the 2-request decode cost, not all 219.
  return { ...candidate, _needsGoogleNewsDecode: true };
}

/** Extract slug words from a URL path for fuzzy matching against article IDs */
function extractUrlSlugWords(rawUrl) {
  try {
    const u = new URL(rawUrl);
    // Get the last meaningful path segment (the article slug)
    const segments = u.pathname.split('/').filter(s => s.length > 0);
    const slug = segments[segments.length - 1] || '';
    // Remove numeric suffixes (article IDs like -427715)
    const cleaned = slug.replace(/-\d{4,}$/, '');
    return cleaned.split('-').filter(w => w.length > 1);
  } catch {
    return [];
  }
}

/** Check if a headline URL was already used for an existing article */
function isSourceUrlAlreadyUsed(headlineUrl) {
  const sourceUrls = loadSourceUrls();
  const normalized = normalizeNewsUrl(headlineUrl);
  // Exact match
  if (sourceUrls[normalized]) {
    return { used: true, articleId: sourceUrls[normalized], signal: 'exact_url' };
  }
  // Fuzzy URL slug vs existing article ID match
  const urlWords = extractUrlSlugWords(headlineUrl);
  if (urlWords.length < 2) return { used: false };

  // Load existing article IDs (all sections — shared id/SEO/i18n namespace)
  const existingIds = getAllArticleIds();

  for (const existingId of existingIds) {
    const idWords = existingId.split('-').filter(w => w.length > 1);
    if (idWords.length < 2) continue;
    // Compute Jaccard similarity between URL slug words and article ID words
    const setA = new Set(urlWords);
    const setB = new Set(idWords);
    const intersection = [...setA].filter(w => setB.has(w)).length;
    const union = new Set([...setA, ...setB]).size;
    const sim = union === 0 ? 0 : intersection / union;
    // Threshold 0.45: source URL slugs are very descriptive of the article content
    // e.g. "lavori-di-risanamento-sulla-a13-cadenazzo-s-antonino" vs "lavori-risanamento-a13-cadenazzo-2026"
    if (sim >= 0.45) {
      return { used: true, articleId: existingId, signal: 'url_slug_match', sim };
    }
  }
  return { used: false };
}

/** Record a source URL after successful article generation */
function recordSourceUrl(sourceUrl, articleId) {
  if (!sourceUrl || sourceUrl.startsWith('evergreen://')) return;
  const map = loadSourceUrls();
  const normalized = normalizeNewsUrl(sourceUrl);
  map[normalized] = articleId;
  saveSourceUrls(map);
  console.error(`  📎 Source URL registrata: ${normalized} → ${articleId}`);
}

function loadSourceQuotaState() {
  try {
    const raw = read(SOURCE_QUOTA_FILE);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid quota state');
    if (!parsed.weeks || typeof parsed.weeks !== 'object') parsed.weeks = {};

    // Keep state compact: retain only last 8 ISO weeks.
    const weekKeys = Object.keys(parsed.weeks).sort();
    const keep = new Set(weekKeys.slice(-8));
    for (const k of weekKeys) {
      if (!keep.has(k)) delete parsed.weeks[k];
    }
    return parsed;
  } catch {
    return { weeks: {} };
  }
}

function saveSourceQuotaState(state) {
  try {
    write(SOURCE_QUOTA_FILE, `${JSON.stringify(state, null, 2)}\n`);
  } catch (e) {
    console.error(`  ⚠️  Impossibile salvare quota fonti: ${e.message}`);
  }
}

function getWeeklySourceCount(domain) {
  const state = loadSourceQuotaState();
  const weekKey = getIsoWeekKey();
  return Number(state.weeks?.[weekKey]?.[normalizeSourceDomain(domain)] || 0);
}

function incrementWeeklySourceCount(domain) {
  const normalized = normalizeSourceDomain(domain);
  if (!normalized || normalized === 'evergreen') return;

  const state = loadSourceQuotaState();
  const weekKey = getIsoWeekKey();
  if (!state.weeks[weekKey]) state.weeks[weekKey] = {};
  state.weeks[weekKey][normalized] = Number(state.weeks[weekKey][normalized] || 0) + 1;
  saveSourceQuotaState(state);
  console.error(`  📈 Quota fonti aggiornata: ${normalized} = ${state.weeks[weekKey][normalized]}/${SOURCE_WEEKLY_QUOTA} (${weekKey})`);
}

function buildSourceQuotaPools(headlines) {
  if (!SOURCE_QUOTA_ENABLED) {
    return { inQuota: headlines, outOfQuota: [], quotaApplied: false, fallbackNeeded: false };
  }

  const withCounts = (headlines || []).map((h) => {
    const sourceDomain = normalizeSourceDomain(h.source);
    const weeklyCount = getWeeklySourceCount(sourceDomain);
    return { ...h, _sourceDomain: sourceDomain, _weeklyCount: weeklyCount };
  });

  const inQuota = withCounts
    .filter((h) => h._weeklyCount < SOURCE_WEEKLY_QUOTA)
    .sort((a, b) => a._weeklyCount - b._weeklyCount);
  const outOfQuota = withCounts
    .filter((h) => h._weeklyCount >= SOURCE_WEEKLY_QUOTA)
    .sort((a, b) => a._weeklyCount - b._weeklyCount);

  const uniqueOutDomains = [...new Set(outOfQuota.map((h) => h._sourceDomain))];
  if (withCounts.length > 0) {
    console.error(`  🧮 Source quota settimanale: max ${SOURCE_WEEKLY_QUOTA} articoli/dominio`);
    console.error(`     In quota: ${inQuota.length} headline | Out of quota: ${outOfQuota.length} headline`);
    if (uniqueOutDomains.length > 0) {
      console.error(`     Domini out of quota: ${uniqueOutDomains.join(', ')}`);
    }
  }

  return {
    inQuota,
    outOfQuota,
    quotaApplied: true,
    fallbackNeeded: inQuota.length === 0 && outOfQuota.length > 0,
  };
}

function buildDynamicEvergreenTopics() {
  const y = new Date().getFullYear();
  const pillars = [
    { k: `frontaliere tasse italia svizzera ${y}`, a: `Guida aggiornata ${y} sulla tassazione del frontaliere: regole pratiche, errori da evitare e scenari ipotetici.` },
    { k: `frontalieri busta paga svizzera ${y}`, a: `Analisi completa busta paga svizzera ${y}: trattenute, contributi e netto reale per frontalieri.` },
    { k: `frontaliere credito imposta ${y}`, a: `Credito d'imposta per frontalieri nel ${y}: calcolo, limiti e compilazione dichiarazione italiana.` },
    { k: `frontaliere cambio chf eur strategia ${y}`, a: `Strategie operative di cambio CHF-EUR nel ${y}: timing, rischio e strumenti pratici.` },
    { k: `frontaliere pensione avs inps ${y}`, a: `Pensione frontaliere ${y}: coordinamento AVS/INPS, totalizzazione e pianificazione senza esempi personali non verificati.` },
    { k: `permesso g vs b frontalieri ${y}`, a: `Confronto tecnico tra Permesso G e B nel ${y}: residenza, fiscalità e sanità con scenari ipotetici, non casi reali.` },
    { k: `frontaliere documenti primo giorno lavoro ticino ${y}`, a: `Checklist operativa per il primo giorno di lavoro in Ticino: documenti, contratto, permesso, dati bancari e assicurazione sanitaria.` },
    { k: `frontaliere scelta comune residenza italia svizzera ${y}`, a: `Come valutare residenza in Italia o Svizzera nel ${y}: costi, tempi di viaggio, sanità e fiscalità con criteri decisionali.` },
    { k: `frontaliere trasporti chiasso lugano abbonamenti ${y}`, a: `Guida pratica ai trasporti Chiasso-Lugano per frontalieri: treno, auto, parcheggi e abbonamenti con checklist dei costi da verificare.` },
    // 6 pillars added 2026-07-02 (#3138): frontaliere evergreen pool was
    // saturated against the 2728-article corpus, blocking generation on
    // every run. New base themes, not variations of an existing pillar.
    { k: `frontaliere cambio datore lavoro procedura permesso ${y}`, a: `Guida ${y} al cambio datore di lavoro per frontalieri: preavviso, rinnovo permesso G, continuità contributiva e documenti da aggiornare.` },
    { k: `frontaliere infortunio lavoro assicurazione lainf ${y}`, a: `Assicurazione infortuni LAINF per frontalieri nel ${y}: copertura, procedura di denuncia e differenze con la malattia professionale.` },
    { k: `frontaliere pensionamento anticipato pianificazione ${y}`, a: `Pensionamento anticipato per frontalieri ${y}: impatto su AVS/secondo pilastro, riduzione rendita e scenari di pianificazione ipotetici.` },
    { k: `frontaliere nascita figlio anagrafe pratiche ${y}`, a: `Nascita di un figlio per famiglie frontaliere nel ${y}: iscrizione anagrafica, assegni familiari e pratiche consolari con checklist operativa.` },
    { k: `frontaliere licenziamento diritti preavviso indennita ${y}`, a: `Licenziamento del lavoratore frontaliere nel ${y}: termini di preavviso, indennità e diritti con scenari ipotetici, non casi reali.` },
    { k: `frontaliere formazione professionale riqualifica corsi ${y}`, a: `Formazione professionale e riqualifica per frontalieri nel ${y}: corsi riconosciuti, finanziamenti e come valutarne il ritorno pratico.` },
  ];
  const addOns = [
    'entro 20 km',
    'oltre 20 km',
    'famiglia con figli',
    'single',
    'simulazione pratica',
    'errori comuni',
  ];

  const out = [];
  for (const base of pillars) {
    out.push({ keyword: base.k, angle: base.a });
    for (const addon of addOns) {
      out.push({
        keyword: `${base.k} ${addon}`,
        angle: `${base.a} Focus su "${addon}" con checklist operativa e confronto scenari.`,
      });
    }
  }
  return out;
}

// National counterpart to buildDynamicEvergreenTopics, for the `svizzera`
// section (2026-07-21, see PRIORITY_EVERGREEN_TOPICS_SVIZZERA above for the
// full rationale). Addon dimension is cantons instead of frontaliere-specific
// facets (20km confine, permesso G, ...) so the combinatorial pool stays
// genuinely national instead of re-deriving Ticino-only angles.
function buildDynamicEvergreenTopicsSvizzera() {
  const y = new Date().getFullYear();
  const pillars = [
    { k: `imposta cantonale confronto svizzera ${y}`, a: `Confronto ${y} delle aliquote di imposta cantonale in Svizzera: differenze tra cantoni, scaglioni e strategie di ottimizzazione lecita.` },
    { k: `costo della vita svizzera ${y}`, a: `Analisi ${y} del costo della vita in Svizzera: affitti, spesa alimentare, trasporti e assicurazioni a confronto tra cantoni.` },
    { k: `premi cassa malati lamal ${y}`, a: `Guida ${y} ai premi LAMal: differenze cantonali, franchigia ottimale, cambio cassa e sussidi disponibili.` },
    { k: `salario medio professioni svizzera ${y}`, a: `Salari medi per professione in Svizzera nel ${y}: confronto tra cantoni e settori, con dati ufficiali e fattori di variazione.` },
    { k: `secondo pilastro lpp svizzera guida ${y}`, a: `Guida ${y} al secondo pilastro LPP: contributi, prelievo, riscatto lacune e pianificazione previdenziale in Svizzera.` },
    { k: `affitti svizzera mercato immobiliare ${y}`, a: `Mercato degli affitti in Svizzera nel ${y}: prezzi medi per cantone, diritti dell'inquilino, deposito cauzionale e disdetta.` },
    { k: `dichiarazione imposte svizzera guida pratica ${y}`, a: `Guida pratica ${y} alla dichiarazione delle imposte in Svizzera: scadenze cantonali, deduzioni ammesse, procedura online.` },
    { k: `terzo pilastro 3a svizzera vantaggi ${y}`, a: `Guida ${y} al terzo pilastro 3a: vantaggi fiscali, provider bancari e assicurativi, strategia di versamento.` },
    { k: `cercare lavoro in svizzera guida pratica ${y}`, a: `Guida ${y} alla ricerca di lavoro in Svizzera: portali, CV svizzero, colloqui e permesso di lavoro.` },
    { k: `sistema sanitario svizzero lamal guida ${y}`, a: `Guida ${y} al sistema sanitario svizzero: obbligo LAMal, scelta della cassa, franchigia e rimborsi.` },
  ];
  const addOns = [
    'canton Zurigo', 'canton Ginevra', 'canton Berna', 'canton Basilea',
    'canton Vaud', 'canton San Gallo', 'canton Lucerna', 'canton Argovia',
  ];

  const out = [];
  for (const base of pillars) {
    out.push({ keyword: base.k, angle: base.a });
    for (const addon of addOns) {
      out.push({
        keyword: `${base.k} ${addon}`,
        angle: `${base.a} Focus sul ${addon} con dati specifici e confronto nazionale.`,
      });
    }
  }
  return out;
}

// ── Pool strutturale nazionale — sezione `svizzera` (2026-08-10) ─────────
//
// IL DIFETTO CHE RIPARA. Il pool `svizzera` era `PRIORITY_EVERGREEN_TOPICS_SVIZZERA`
// (20 voci scritte a mano) + `buildDynamicEvergreenTopicsSvizzera()` (10 pilastri
// × 9 = 90): 110 keyword in tutto, contro le 537 del lato frontaliere, che ha in
// piu' `buildStructuralEvergreenTopics()`. Al 2026-08-10 il ledger aveva 90 di
// quelle 110 keyword bannate come duplicato confermato, e ogni run scheduled
// della sezione finiva in ~50 secondi con «Tutte le keyword evergreen risultano
// gia' coperte dal pre-flight» (run 31402855968, 31403653098, 31404256910,
// 31405881104). Due dei quattro slot cron orari sono `svizzera`, quindi erano
// no-op garantiti — e la catena self-trigger, che alterna sezione a ogni anello,
// moriva li' perche' un run senza articolo non tocca `content/`.
//
// PERCHE' CRESCE INVECE DI SATURARE. Il pool vecchio non poteva crescere da
// solo: 8 cantoni su 26, l'anno interpolato nella keyword, nessuna dimensione
// combinatoria. Qui la dimensione e' il CANTONE, che e' anche il motivo per cui
// l'articolo esiste: quasi tutto cio' che questi pilastri descrivono e'
// amministrato dal cantone (aliquote, premi, permessi, assegni, scuola,
// naturalizzazione, patente, successioni) e la risposta cambia davvero da un
// cantone all'altro. Non e' una variante di stile sullo stesso contenuto.
//
// TRE SCELTE CHE NON SONO OVVIE, e la misura che le regge.
//
// 1. NIENTE ANNO NELLA KEYWORD. `buildDynamicEvergreenTopics*` interpola
//    `new Date().getFullYear()`. Sembra innocuo e non lo e':
//      - il ledger `data/topic-candidates-evergreen-rejected.json` e' indicizzato
//        sulla stringa letterale della keyword, quindi il 1° gennaio ogni ban e
//        ogni strike accumulato diventa irraggiungibile e il run ripaga un ciclo
//        LLM intero per riscoprire un duplicato che sapeva gia';
//      - `evergreenAngleTokens` teneva '2025' e '2026' in una stoplist letterale,
//        cioe' stantia per costruzione: dal 2027 l'anno sarebbe tornato un token
//        DISTINTIVO, abbassando la similarita' di famiglia e riaprendo come nuovi
//        candidati che sono near-duplicate (ora e' un test su 4 cifre, vedi li').
//    Questi 20 pilastri sono nazionali e non datati (permesso C, naturalizzazione,
//    successioni): l'anno non aggiunge intento di ricerca, aggiunge solo il
//    riazzeramento della memoria. Fuori.
//
// 2. NIENTE DIMENSIONE PROFESSIONE, benche' `PROFESSION_TAXONOMY` sia gia' qui e
//    sia la dimensione che regge il pool frontaliere. Misurato: `topic-coverage-guard`
//    chiude su `professionTopicKey`, che e' indicizzato SOLO sul mestiere ed e'
//    cieco alla geografia. `stipendio infermiere canton Ginevra` e
//    `frontaliere infermiere ticino stipendio requisiti` hanno la stessa chiave:
//    i 25 cantoni collasserebbero su UNO slot per mestiere ogni 90 giorni, quindi
//    la dimensione non moltiplica niente — e quel poco che passasse ruberebbe lo
//    slot al pool frontaliere, che su quella dimensione ci vive.
//
// 3. TICINO ESCLUSO dai 26 cantoni. E' la sezione sorella a possedere il Ticino,
//    con ~3.600 articoli: una keyword `… canton Ticino` sarebbe respinta dal
//    pre-flight nel 99% dei casi, e nell'1% restante pubblicherebbe in
//    `/articoli-svizzera/` un pezzo che appartiene all'altra sezione. E' lo stesso
//    errore corretto il 2026-07-21 (vedi il commento a PRIORITY_EVERGREEN_TOPICS_SVIZZERA),
//    ri-derivato per via combinatoria invece che a mano.
//
// NOTA PER CHI MODIFICA I PILASTRI. `evergreenTopicFamily` (piu' sotto) mappa
// certe combinazioni di token su «famiglie», e sei di queste sono in
// SATURATED_FAMILIES: un candidato che ci cade viene dichiarato duplicato contro
// QUALUNQUE articolo esistente della stessa famiglia, senza soglia. La coppia
// `permess` + `residenz|soggiorn` e' una di quelle — ed e' esattamente perche'
// `permesso di soggiorno svizzera tipologie B C L` (lista statica) e' morta
// all'origine. I pilastri qui sotto sono scritti per non cadere in nessuna
// famiglia satura, keyword E angolo; `evergreen-brief-section-aware.test.mjs`
// lo asserisce, cosi' una riscrittura distratta non lo perde in silenzio.
function buildStructuralEvergreenTopicsSvizzera() {
  // I 26 cantoni meno il Ticino (vedi punto 3 sopra). I codici servono al test
  // che confronta questa lista con `generator/data/canton-url-slugs.json`: senza,
  // un cantone dimenticato restringerebbe il pool senza che niente lo dica.
  const CANTONI = [
    { code: 'ZH', name: 'Zurigo' },
    { code: 'BE', name: 'Berna' },
    { code: 'LU', name: 'Lucerna' },
    { code: 'UR', name: 'Uri' },
    { code: 'SZ', name: 'Svitto' },
    { code: 'OW', name: 'Obvaldo' },
    { code: 'NW', name: 'Nidvaldo' },
    { code: 'GL', name: 'Glarona' },
    { code: 'ZG', name: 'Zugo' },
    { code: 'FR', name: 'Friburgo' },
    { code: 'SO', name: 'Soletta' },
    { code: 'BS', name: 'Basilea Città' },
    { code: 'BL', name: 'Basilea Campagna' },
    { code: 'SH', name: 'Sciaffusa' },
    { code: 'AR', name: 'Appenzello Esterno' },
    { code: 'AI', name: 'Appenzello Interno' },
    { code: 'SG', name: 'San Gallo' },
    { code: 'GR', name: 'Grigioni' },
    { code: 'AG', name: 'Argovia' },
    { code: 'TG', name: 'Turgovia' },
    { code: 'VD', name: 'Vaud' },
    { code: 'VS', name: 'Vallese' },
    { code: 'NE', name: 'Neuchâtel' },
    { code: 'GE', name: 'Ginevra' },
    { code: 'JU', name: 'Giura' },
  ];

  // `%c` → «canton <nome>» nella keyword; `%C` → «nel Cantone di <nome>»
  // nell'angolo. Ogni pilastro e' un tema la cui risposta e' fissata da una
  // legge o da un ufficio CANTONALE: e' quello a rendere le 25 varianti
  // articoli diversi e non 25 riscritture dello stesso.
  const PILLARS = [
    {
      k: 'imposte cantonali %c aliquote e deduzioni',
      a: 'Imposte cantonali e comunali %C: aliquote, scaglioni, deduzioni ammesse, scadenze di consegna e portale online dell\'amministrazione fiscale cantonale.',
    },
    {
      k: 'premi cassa malati %c e riduzione premi',
      a: 'Premi dell\'assicurazione malattia obbligatoria %C: fasce di premio, franchigie, modelli alternativi e requisiti per ottenere la riduzione dei premi.',
    },
    {
      k: 'permesso di dimora B %c requisiti e rinnovo',
      a: 'Permesso di dimora B %C: requisiti, documenti da produrre, durata, procedura di rinnovo e ufficio cantonale della migrazione competente.',
    },
    {
      k: 'permesso di domicilio C %c requisiti e domanda',
      a: 'Permesso di domicilio C %C: anni richiesti, criteri di integrazione, conoscenze linguistiche, procedura di domanda e casi di rilascio anticipato.',
    },
    {
      k: 'permesso L di breve durata %c validità e proroga',
      a: 'Permesso L di breve durata %C: durata massima, condizioni di proroga, passaggio al permesso di dimora e vincoli legati al datore di lavoro.',
    },
    {
      k: 'indennità di disoccupazione %c iscrizione URC',
      a: 'Indennità di disoccupazione %C: iscrizione all\'URC, periodo di contribuzione minimo, calcolo dell\'indennità giornaliera, obblighi di ricerca impiego e provvedimenti di reinserimento professionale.',
    },
    {
      k: 'assegni familiari %c importi e domanda',
      a: 'Assegni familiari e di formazione %C: importi mensili per figlio, condizioni di diritto, cassa di compensazione competente e procedura di domanda.',
    },
    {
      k: 'sistema scolastico %c iscrizione e cicli',
      a: 'Scuola dell\'obbligo %C: cicli, età di iscrizione, calendario scolastico, lingue di insegnamento e passaggio alle scuole medie superiori.',
    },
    {
      k: 'apprendistato e formazione professionale %c',
      a: 'Apprendistato e formazione professionale %C: come si trova un posto di tirocinio, contratto di tirocinio, retribuzione dell\'apprendista e maturità professionale.',
    },
    {
      k: 'borse di studio %c requisiti e importi',
      a: 'Borse di studio e prestiti allo studio %C: requisiti, importi massimi, termini di presentazione e ufficio cantonale competente.',
    },
    {
      k: 'asilo nido e custodia bambini %c costi',
      a: 'Custodia dei bambini %C: asili nido, famiglie diurne, doposcuola, tariffe calcolate sul reddito e sussidi cantonali disponibili.',
    },
    {
      k: 'comprare casa %c prezzi e mutuo ipotecario',
      a: 'Acquisto di un\'abitazione %C: prezzi medi, fondi propri richiesti, sostenibilità del mutuo ipotecario, imposta sui trapassi e spese notarili.',
    },
    {
      k: 'mercato degli affitti %c canoni medi e diritto di locazione',
      a: 'Affitti %C: canoni medi per zona, deposito di garanzia, contestazione del canone iniziale, disdetta e autorità di conciliazione in materia di locazione.',
    },
    {
      k: 'naturalizzazione %c requisiti e procedura',
      a: 'Naturalizzazione ordinaria %C: anni richiesti dal cantone e dal comune, test di integrazione e di lingua, tasse da versare e durata della procedura.',
    },
    {
      k: 'avs e prestazioni complementari %c cassa di compensazione',
      a: 'Primo pilastro %C: cassa di compensazione cantonale, calcolo della rendita AVS, lacune contributive e prestazioni complementari a copertura del minimo vitale.',
    },
    {
      k: 'abbonamenti trasporti pubblici %c zone e tariffe',
      a: 'Trasporti pubblici %C: comunità tariffaria, zone, abbonamenti annuali e mensili, combinazione con metà-prezzo e AG, sconti per studenti e apprendisti.',
    },
    {
      k: 'aprire un\'attività %c registro di commercio e costi',
      a: 'Avviare un\'attività %C: scelta della forma giuridica, iscrizione al registro di commercio, capitale minimo, tasse di iscrizione e obblighi assicurativi.',
    },
    {
      k: 'salari e mercato del lavoro %c settori e livelli',
      a: 'Mercato del lavoro %C: settori che assumono, livelli salariali per grado di formazione, contratti collettivi in vigore e salario minimo dove previsto.',
    },
    {
      k: 'patente di guida %c conversione ed esami',
      a: 'Patente di guida %C: conversione della licenza estera, esame teorico e pratico, corsi obbligatori e ufficio della circolazione competente.',
    },
    {
      k: 'imposta di successione e donazione %c aliquote',
      a: 'Imposta di successione e di donazione %C: aliquote per grado di parentela, esenzioni per coniuge e discendenti, dichiarazione e termini da rispettare.',
    },
  ];

  const out = [];
  for (const c of CANTONI) {
    for (const p of PILLARS) {
      out.push({
        keyword: p.k.split('%c').join(`canton ${c.name}`),
        angle: p.a.split('%C').join(`nel Cantone di ${c.name}`),
      });
    }
  }
  return out;
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((res) => {
    rl.question(question, (answer) => {
      rl.close();
      res(answer.trim());
    });
  });
}

function commandExists(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function runShell(cmd) {
  try {
    execSync(cmd, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

async function optimizeImageToWebp(inputPath, outputPath) {
  // Single-format hero: WebP only. Drops the legacy JPG + WebP-sidecar pipeline
  // (which doubled disk usage in dist/ for zero SEO benefit — see PR migrating
  // 2400+ articles to WebP-only heroes). WebP is universally supported (~99%
  // browsers), accepted by FB/X/LinkedIn og:image, and indexed by Google Image
  // Search. q75 produces ~85-100 KB at 1200×675 — comparable to the prior
  // mozjpeg q72 size, smaller than the prior q82 WebP sidecar.
  try {
    const sharpModule = await import('sharp');
    const sharp = sharpModule.default || sharpModule;

    const encodeWithQuality = async (quality) => {
      return sharp(inputPath)
        .rotate()
        .resize({ width: 1200, height: 675, fit: 'cover', position: 'attention' })
        // effort 4 → 6 squeezes another ~2-3 % bytes at ~2x encoding cost.
        // Article creation is one-shot per article (not hot path), so the
        // slower encoder is acceptable.
        .webp({ quality, effort: 6 })
        .toBuffer();
    };

    const before = statSync(inputPath).size;
    let outBuffer = await encodeWithQuality(75);
    const qualityPasses = [70, 65, 60, 55];
    for (const q of qualityPasses) {
      if (outBuffer.length <= BLOG_IMAGE_TARGET_MAX_BYTES) break;
      outBuffer = await encodeWithQuality(q);
    }

    writeFileSync(outputPath, outBuffer);
    const after = outBuffer.length;
    return { ok: true, before, after };
  } catch {
    // Fallback to system binaries below.
  }

  const tools = {
    magick: commandExists('magick'),
    convert: commandExists('convert'),
    cwebp: commandExists('cwebp'),
    ffmpeg: commandExists('ffmpeg'),
  };

  const encodeCommands = [
    tools.magick && `magick "${inputPath}" -auto-orient -strip -resize "1200x675^" -gravity center -extent 1200x675 -quality 75 -define webp:method=4 "${outputPath}"`,
    tools.convert && `convert "${inputPath}" -auto-orient -strip -resize "1200x675^" -gravity center -extent 1200x675 -quality 75 -define webp:method=4 "${outputPath}"`,
    tools.cwebp && `cwebp -quiet -q 75 -m 4 -resize 1200 0 "${inputPath}" -o "${outputPath}"`,
    tools.ffmpeg && `ffmpeg -y -i "${inputPath}" -vf "scale=1200:675:force_original_aspect_ratio=increase,crop=1200:675" -frames:v 1 -c:v libwebp -quality 75 "${outputPath}"`,
  ].filter(Boolean);

  let encoded = false;
  for (const cmd of encodeCommands) {
    if (runShell(cmd)) {
      encoded = true;
      break;
    }
  }

  if (!encoded) {
    if (inputPath !== outputPath) copyFileSync(inputPath, outputPath);
  }

  if (!existsSync(outputPath)) return { ok: false, before: 0, after: 0 };
  const before = existsSync(inputPath) ? statSync(inputPath).size : statSync(outputPath).size;

  // Iterative quality reduction if the target byte cap is exceeded.
  const qualityPasses = [70, 65, 60, 55];
  for (const q of qualityPasses) {
    const currentSize = statSync(outputPath).size;
    if (currentSize <= BLOG_IMAGE_TARGET_MAX_BYTES) break;

    const recompressCommands = [
      tools.magick && `magick "${outputPath}" -strip -quality ${q} -define webp:method=4 "${outputPath}"`,
      tools.convert && `convert "${outputPath}" -strip -quality ${q} -define webp:method=4 "${outputPath}"`,
      tools.cwebp && `cwebp -quiet -q ${q} -m 4 "${outputPath}" -o "${outputPath}"`,
    ].filter(Boolean);

    let passDone = false;
    for (const cmd of recompressCommands) {
      if (runShell(cmd)) {
        passDone = true;
        break;
      }
    }
    if (!passDone) break;
  }

  const after = statSync(outputPath).size;
  return { ok: true, before, after };
}

/**
 * Tronca a `maxLen` chiudendo su una CLAUSOLA COMPLETA.
 *
 * Delega a `truncateToClause` di `host/shared/clauseTail.mjs` — lo STESSO
 * modulo che `host/shared/titleSuffix.ts` riesporta e che l'engine usa a render
 * time via `repairSerpSnippet` (SiteShellContract). Generatore e renderer non
 * possono piu' avere due idee diverse di "coda pulita", che e' esattamente il
 * modo in cui la regola era gia' andata alla deriva sul sito (issue
 * valerielinc-ops#4356/#4357/#4358: cinque punti di troncamento, cinque regole).
 *
 * NON si duplica la lista di stopword qui (AGENTS.md #6): il modulo esiste gia'
 * in questo repo, arriva con la meta' `host/` del contratto, ed e' byte-identico
 * a `build-plugins/shared/clauseTail.mjs` del sito.
 *
 * Due difetti che questo sostituisce, entrambi MISURATI su questo corpus il
 * 2026-08-09 (27.764 campi SEO in content/seo/seo-blog*.ts, 3.075 articoli):
 *
 *   1. `Math.max(cut.lastIndexOf(' '), maxLen - 12)` ripiegava su un taglio a
 *      carattere ogni volta che l'ultimo spazio cadeva prima di `maxLen - 12`,
 *      cioe' quando l'ultima parola era piu' lunga di ~13 caratteri: un
 *      composto tedesco o un tecnicismo veniva tagliato A META' PAROLA.
 *      Nel corpus e' arrivato una volta sola ("...frontalieri che attraversano
 *      q"), ma e' un difetto di input, non di frequenza: basta un titolo con
 *      una parola lunga a cavallo del limite.
 *   2. Strippando solo la punteggiatura, la preposizione restava appesa:
 *      3.548 campi su 1.139 articoli finiscono su una parola funzionale,
 *      1.792 di essi sul letterale "Dati aggiornati <anno> per".
 *
 * Uno snippet che si ferma su una preposizione legge come un disco rotto nella
 * SERP e rende Google piu' propenso a scartare la description e sintetizzarne
 * una propria, perdendo il controllo del messaggio.
 *
 * Il dato GIA' scritto non viene riscritto qui: l'engine lo ripara a render
 * time (`repairSerpSnippet` in engine/ogPagesPlugin.ts, verificato in
 * produzione). Questa e' la chiusura del rubinetto, non la bonifica.
 */
function truncateAtWordBoundary(text, maxLen) {
  return truncateToClause(text, maxLen);
}

// ── SEO length caps (Semrush + Google snippet compliance) ──
// Title: ≤ 60 chars (excluding " | Frontaliere Ticino" brand suffix appended downstream)
// Description: ≤ 160 chars (Google snippet truncation point)
// Hard cap so the auto-generated blog never regresses the title-length-baseline ratchet.
// Headline is never truncated; > 80 char triggers a stricter LLM re-prompt only.
const BLOG_TITLE_MAX = 200; // advisory soft ceiling — capBlogTitle returns input verbatim
const BLOG_TITLE_RETRY_THRESHOLD = 80;
const BLOG_DESCRIPTION_MAX = 160;
const BRAND_SUFFIX = ' | Frontaliere Ticino';

/**
 * Cap a blog title at BLOG_TITLE_MAX. Strips any brand suffix the LLM may have
 * accidentally included, normalises whitespace, truncates at the last word
 * boundary before the cap, then strips trailing punctuation.
 *
 * Returns { value, truncated, originalLength } so callers can decide whether
 * to retry the LLM call (if originalLength > BLOG_TITLE_RETRY_THRESHOLD).
 */
function capBlogTitle(rawTitle, _maxLen = BLOG_TITLE_MAX) {
  void _maxLen;
  const s = String(rawTitle || '')
    .replace(/\s*\|\s*Frontaliere\s+Ticino\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { value: s, truncated: false, originalLength: s.length };
}

/**
 * Cap a blog description at BLOG_DESCRIPTION_MAX, word-boundary aware.
 */
function capBlogDescription(rawDesc, maxLen = BLOG_DESCRIPTION_MAX) {
  const s = String(rawDesc || '').replace(/\s+/g, ' ').trim();
  const originalLength = s.length;
  if (originalLength <= maxLen) return { value: s, truncated: false, originalLength };
  return { value: truncateAtWordBoundary(s, maxLen), truncated: true, originalLength };
}

// Swiss cantons (Italian names), major Ticino cities, and neighbouring
// countries — commonly capitalized mid-sentence in this site's Italian
// journalism and NOT to be lowercased by normalizeTitleCasing below, even
// though they aren't fully-uppercase acronyms (issue #3174 follow-up:
// "Nuove Regole Per Il Ticino" was becoming "...per il ticino").
const TITLE_CASING_PROPER_NOUNS = new Set([
  'ticino', 'zurigo', 'berna', 'ginevra', 'basilea', 'argovia', 'turgovia',
  'sciaffusa', 'soletta', 'lucerna', 'uri', 'svitto', 'untervaldo', 'glarona',
  'zugo', 'friburgo', 'vaud', 'vallese', 'neuchâtel', 'giura', 'grigioni',
  'appenzello', 'sangallo', 'lugano', 'bellinzona', 'locarno', 'chiasso',
  'mendrisio', 'losanna', 'svizzera', 'italia', 'germania', 'francia',
  'austria', 'liechtenstein',
]);

// Real institutional/legal acronyms from VERIFIED_DOMAIN_FACTS (istituzioni,
// aliquote) that must stay uppercase when a fully-uppercase ("shouting")
// title is sentence-cased below. Deliberately excludes short tokens that
// double as common Italian words (e.g. "ai", "usi") to avoid leaving those
// wrongly capitalized. Non-exhaustive — extend as new ones are hit.
const TITLE_CASING_KNOWN_ACRONYMS = new Set([
  'avs', 'ipg', 'ac', 'lainf', 'laa', 'igm', 'ijm', 'lpp', 'irpef', 'inps',
  'mef', 'inail', 'seco', 'sem', 'suva', 'ustat', 'ufsp', 'bag', 'supsi',
  'eoc', 'dfe', 'dss', 'are', 'bfs', 'bps', 'ufas', 'ufg', 'udsc', 'fedpol',
  'lamal', 'iva', 'chf', 'cu', 'ral', 'ssn', 'sepa', 'ccnl', 'cmu', 'naspi',
  'covid', 'cdi', 'ats',
]);

/**
 * Normalize a journalist-typed title from Title Case to sentence case: only
 * the first letter of the title is capitalized, every other word is
 * lowercased — UNLESS the journalist already typed it fully uppercase
 * (treated as an acronym, e.g. AVS/IVA/CHF/COVID-19) or it's a known Swiss
 * canton/city/country proper noun (TITLE_CASING_PROPER_NOUNS), either of
 * which is preserved as-is. No-op if the title doesn't look Title-Cased to
 * begin with (issue #3174 follow-up — "redazione" title casing).
 *
 * When EVERY word is uppercase ("shouting", e.g. a full LLM title dropped in
 * all caps rather than journalist Title-Case — live incident: "LA SOSPENSIONE
 * DEI RISTORNI ALLA PROVA DELLA CONVENZIONE ITALIA-SVIZZERA..."), the plain
 * per-word acronym check below is a no-op (every word trivially equals its
 * own uppercase form), so that mode uses TITLE_CASING_KNOWN_ACRONYMS instead
 * of the generic check, and splits on hyphens so compound proper nouns like
 * "ITALIA-SVIZZERA" are still recognised per-side.
 */
function normalizeTitleCasing(rawTitle) {
  const s = String(rawTitle || '').replace(/\s+/g, ' ').trim();
  if (!s) return s;
  const words = s.split(' ');
  const letterWords = words.filter((w) => /[A-Za-zÀ-ÿ]/.test(w));
  const isShouting = letterWords.length > 0 && letterWords.every((w) => w === w.toUpperCase());
  const looksTitleCase = words.filter((w) => /^[A-ZÀ-Ý]/.test(w)).length >= Math.ceil(words.length * 0.6);
  if (!looksTitleCase && !isShouting) return s;

  let isFirstWord = true;
  const normalizeToken = (token) => {
    const bareLetters = token.replace(/[^A-Za-zÀ-ÿ]/g, '');
    if (!bareLetters) return token;
    const bareLower = bareLetters.toLowerCase();
    const isAcronym = isShouting
      ? TITLE_CASING_KNOWN_ACRONYMS.has(bareLower)
      : token.length > 1 && token === token.toUpperCase() && token !== token.toLowerCase();
    let result;
    if (isAcronym) {
      result = token;
    } else if (TITLE_CASING_PROPER_NOUNS.has(bareLower)) {
      result = token.replace(bareLetters, bareLetters.charAt(0).toUpperCase() + bareLetters.slice(1).toLowerCase());
    } else {
      const lower = token.toLowerCase();
      result = isFirstWord ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    }
    isFirstWord = false;
    return result;
  };

  return words
    .map((w) => (isShouting && w.includes('-') ? w.split('-').map(normalizeToken).join('-') : normalizeToken(w)))
    .join(' ');
}

/**
 * Locale-agnostic guard against a translated title coming back fully
 * uppercase. Deliberately NOT the full normalizeTitleCasing algorithm above —
 * that enforces Italian sentence-case grammar (lowering "Il"/"Della" etc.),
 * which is wrong for EN (Title Case), DE (every noun capitalized), and FR
 * conventions. This only fires on the pathological ALL-CAPS case and applies
 * a minimal, safe fallback (capitalize first letter, lowercase the rest,
 * preserve known acronyms) — not a per-locale-correct title case.
 */
function collapseShoutingTitle(rawTitle) {
  const s = String(rawTitle || '').replace(/\s+/g, ' ').trim();
  if (!s) return s;
  const words = s.split(' ');
  const letterWords = words.filter((w) => /[A-Za-zÀ-ÿ]/.test(w));
  const isShouting = letterWords.length > 0 && letterWords.every((w) => w === w.toUpperCase());
  if (!isShouting) return s;
  let isFirstWord = true;
  return words
    .map((w) => {
      const bareLetters = w.replace(/[^A-Za-zÀ-ÿ]/g, '');
      if (!bareLetters) return w;
      if (TITLE_CASING_KNOWN_ACRONYMS.has(bareLetters.toLowerCase())) return w;
      const lower = w.toLowerCase();
      const result = isFirstWord ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
      isFirstWord = false;
      return result;
    })
    .join(' ');
}

/**
 * Apply the deterministic microcopy guard to a locale's title AND excerpt.
 *
 * Why this exists next to normalizeTitleCasing rather than inside it: that
 * function returns early when the title is neither Title Case nor shouting
 * (`if (!looksTitleCase && !isShouting) return s;`), so a title already in
 * sentence case never reaches its proper-noun table. That is exactly how
 * "Frontaliere gruista ticino: stipendio e requisiti" shipped on 2026-08-09
 * with 'ticino' in the TITLE_CASING_PROPER_NOUNS set the whole time. The guard
 * below has no early-exit branch, and it also covers the excerpt, which no
 * casing pass ever touched.
 *
 * @see generator/scripts/lib/it-microcopy-guard.mjs for what it does NOT cover.
 */
function applyMicrocopyGuard(content, locale) {
  if (!content || typeof content !== 'object') return;
  for (const field of ['title', 'excerpt']) {
    if (typeof content[field] !== 'string' || !content[field].trim()) continue;
    const { value, fixes } = fixMicrocopy(content[field], { locale, field });
    if (!fixes.length) continue;
    console.warn(`  ✍️ [microcopy] ${locale.toUpperCase()} ${field}: ${fixes.map((f) => `${f.rule} "${f.found}"→"${f.expected}"`).join(', ')}`);
    content[field] = value;
  }
}

/**
 * Generate a short excerpt/meta-description from a full IT article body via a
 * lightweight, single-purpose LLM call (NOT the full callGemini() generation
 * call — this only needs 1-2 sentences, so it skips the body2/body3-length
 * retry machinery). Never throws: on any failure it falls back to the first
 * ~160 chars of the body via capBlogDescription so publishing is never
 * blocked on this step (issue #3174 follow-up — auto-generated excerpt).
 */
async function generateExcerpt(title, body1, body2, body3) {
  const bodyText = [body1, body2, body3].filter(Boolean).join('\n\n');
  try {
    const messages = [
      {
        role: 'system',
        content:
          'Sei un redattore SEO italiano. Scrivi un riassunto breve (1-2 frasi, massimo 160 caratteri) ' +
          'per un articolo di blog, adatto come meta-description. Rispondi SOLO con il testo del riassunto, ' +
          'senza virgolette né markdown.',
      },
      { role: 'user', content: `Titolo: ${title}\n\nCorpo dell'articolo:\n${bodyText.slice(0, 4000)}` },
    ];
    const raw = await _aiCallLLM(messages, { temperature: 0.5, maxTokens: 200, timeout: 30_000 });
    const excerpt = String(raw || '').replace(/^["'“”]+|["'“”]+$/g, '').trim();
    if (excerpt) return capBlogDescription(excerpt).value;
  } catch (err) {
    console.warn(`  ⚠️  generateExcerpt fallito, uso fallback troncato: ${err.message}`);
  }
  return capBlogDescription(bodyText).value;
}

/** Char-based thirds over an ordered list of chunks (paragraphs or sentences),
 * guaranteeing each of the 3 groups gets >=1 chunk whenever items.length >= 3. */
function chunksByCharThirds(items, joiner) {
  const total = items.reduce((sum, s) => sum + s.length, 0);
  let cut1 = -1;
  let cut2 = -1;
  let acc = 0;
  for (let i = 0; i < items.length; i++) {
    acc += items[i].length;
    if (cut1 === -1 && acc >= total / 3) cut1 = i + 1;
    else if (cut2 === -1 && acc >= (total * 2) / 3) cut2 = i + 1;
  }
  cut1 = Math.min(Math.max(cut1, 1), items.length - 2);
  cut2 = Math.min(Math.max(cut2, cut1 + 1), items.length - 1);
  return {
    body1: items.slice(0, cut1).join(joiner).trim(),
    body2: items.slice(cut1, cut2).join(joiner).trim(),
    body3: items.slice(cut2).join(joiner).trim(),
  };
}

/** Zero-LLM last resort: split at paragraph boundaries (falling back to
 * sentence boundaries, then a raw char cut) so splitBodyIntoSections never
 * throws — an unavailable/exhausted model degrades to a slightly-less-natural
 * cut instead of failing the whole article. */
function deterministicBodySplit(text) {
  const paragraphs = text.split(/\n\n+/).filter((p) => p.trim());
  if (paragraphs.length >= 3) return chunksByCharThirds(paragraphs, '\n\n');
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length >= 3) return chunksByCharThirds(sentences, ' ');
  const third = Math.ceil(text.length / 3) || 1;
  return {
    body1: text.slice(0, third).trim(),
    body2: text.slice(third, third * 2).trim(),
    body3: text.slice(third * 2).trim(),
  };
}

/**
 * Split a single free-text article body (as authored by a journalist in the
 * redazione dashboard) into the fixed body1/body2/body3 shape the rest of
 * the pipeline (REQUIRED_IT_BODY_FIELDS, validateItalianPayload,
 * translateArticle, enforceStrongInternalLinks, ...) already expects.
 *
 * The LLM picks ONLY the two paragraph indices where section 2 and section 3
 * start (issue #3174 follow-up — the journalist's explicit choice over a
 * blank-line heuristic, so it can balance section length instead of cutting
 * mid-thought) — it never re-emits the body text itself. Earlier versions had
 * the LLM echo the full body back inside body1/body2/body3, which made output
 * size scale 1:1 with input size against a fixed maxTokens:4000 cap: any body
 * long enough that its escaped JSON echo exceeded ~4000 tokens (any free-tier
 * model's output ceiling, see MODEL_MAX_OUTPUT_TOKENS in lib/ai-models.mjs)
 * truncated identically on all 3 attempts — a structural cap mismatch, not a
 * transient failure, so retrying never helped (root cause of the 44k-char
 * "Accordo Italia-Svizzera" article failing 3/3). Requesting 2 integers keeps
 * the LLM response constant-size regardless of body length, and slicing the
 * original paragraphs verbatim in JS also removes any risk of the LLM
 * mangling markdown while copying.
 */
async function splitBodyIntoSections(fullBody, title) {
  const text = String(fullBody || '').trim();
  if (!text) throw new Error('splitBodyIntoSections: corpo vuoto');

  const paragraphs = text.split(/\n\n+/).filter((p) => p.trim());

  if (paragraphs.length >= 3) {
    const numbered = paragraphs
      .map((p, i) => `[${i}] ${p.length > 200 ? `${p.slice(0, 200)}…` : p}`)
      .join('\n\n');
    const schema = {
      name: 'body_split_points',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['section2StartIndex', 'section3StartIndex'],
        properties: {
          section2StartIndex: { type: 'integer' },
          section3StartIndex: { type: 'integer' },
        },
      },
    };
    const messages = [
      {
        role: 'system',
        content:
          'Sei un redattore italiano. Il testo sottostante è numerato per paragrafo. Un articolo va diviso ' +
          'in ESATTAMENTE 3 sezioni bilanciate senza aggiungere, riassumere o rimuovere contenuto: scegli ' +
          'solo in quale paragrafo iniziano la sezione 2 e la sezione 3 (i punti di taglio più naturali). ' +
          'Rispondi SOLO in JSON con i due indici (interi, 0-based, riferiti al numero tra parentesi quadre).',
      },
      { role: 'user', content: `Titolo: ${title}\n\nParagrafi (${paragraphs.length} totali):\n${numbered}` },
    ];

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const raw = await _aiCallLLM(messages, {
          temperature: 0.3,
          maxTokens: 200,
          timeout: 30_000,
          jsonMode: true,
          jsonSchema: schema,
        });
        const parsed = JSON.parse(repairLlmJson(raw));
        const i2 = Number(parsed?.section2StartIndex);
        const i3 = Number(parsed?.section3StartIndex);
        if (Number.isInteger(i2) && Number.isInteger(i3) && i2 >= 1 && i3 > i2 && i3 < paragraphs.length) {
          const body1 = paragraphs.slice(0, i2).join('\n\n').trim();
          const body2 = paragraphs.slice(i2, i3).join('\n\n').trim();
          const body3 = paragraphs.slice(i3).join('\n\n').trim();
          if (body1 && body2.length >= 40 && body3) return { body1, body2, body3 };
        }
      } catch (err) {
        console.warn(`  ⚠️  splitBodyIntoSections tentativo ${attempt} fallito: ${err.message}`);
      }
    }
    console.warn('  ⚠️  splitBodyIntoSections: nessun punto di taglio valido dopo 3 tentativi — uso fallback deterministico a paragrafi');
  } else {
    console.warn(`  ⚠️  splitBodyIntoSections: solo ${paragraphs.length} paragrafo/i — uso fallback deterministico`);
  }

  return deterministicBodySplit(text);
}

/**
 * Read-only variant of generateArticleImage()'s Wikimedia/Pixabay/Pexels
 * search: returns candidate image URLs for a picker UI WITHOUT downloading
 * or writing any file (no sharp/fs writes) — download + webp conversion
 * happens later, at draft-save time, through the existing resolveHeroImage()
 * path in publish-journalist-article.mjs (any https:// URL is handled
 * identically whether it came from a Storage upload or a picked URL here).
 */
async function findStockImageCandidates(data, count = 4) {
  const candidates = [];

  try {
    const query = _buildWikimediaQueries(data)[0];
    if (query) {
      const wikiUrl =
        `https://commons.wikimedia.org/w/api.php?action=query&generator=search` +
        `&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=8` +
        `&prop=imageinfo&iiprop=url|size|mime&iiurlwidth=1280&format=json`;
      const res = await fetch(wikiUrl, {
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'FrontaliereBot/1.0 (https://frontaliereticino.ch; blog image)' },
      });
      if (res.ok) {
        const json = await res.json();
        const pages = Object.values(json.query?.pages || {});
        for (const p of pages) {
          const info = p.imageinfo?.[0];
          const mime = (info?.mime || '').toLowerCase();
          if (info?.thumburl && (mime.startsWith('image/jpeg') || mime.startsWith('image/png'))) {
            candidates.push({ url: info.thumburl, source: 'wikimedia', attribution: p.title || null });
          }
          if (candidates.length >= count) break;
        }
      }
    }
  } catch (err) {
    console.warn(`  ⚠️  findStockImageCandidates/Wikimedia fallito: ${err.message}`);
  }

  const pixabayKey = process.env.PIXABAY_API_KEY;
  if (candidates.length < count && pixabayKey) {
    try {
      const query = _buildWikimediaQueries(data)[0] || 'ticino switzerland';
      const category = _inferPixabayCategory(data);
      const res = await fetch(
        `https://pixabay.com/api/?key=${pixabayKey}&q=${encodeURIComponent(query)}` +
          `${category ? `&category=${encodeURIComponent(category)}` : ''}` +
          `&image_type=photo&orientation=horizontal&per_page=20&min_width=1280&safesearch=true`,
        { signal: AbortSignal.timeout(15000) },
      );
      if (res.ok) {
        const json = await res.json();
        const relevant = (json.hits || []).filter((h) => _isImageRelevant(h.tags, data));
        for (const hit of relevant) {
          const url = hit.largeImageURL || hit.webformatURL;
          if (url) candidates.push({ url, source: 'pixabay', attribution: hit.user || null });
          if (candidates.length >= count) break;
        }
      }
    } catch (err) {
      console.warn(`  ⚠️  findStockImageCandidates/Pixabay fallito: ${err.message}`);
    }
  }

  const pexelsKey = process.env.PEXELS_API_KEY;
  if (candidates.length < count && pexelsKey) {
    try {
      const query = _buildWikimediaQueries(data)[0] || 'ticino switzerland';
      const res = await fetch(
        `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&orientation=landscape&size=large&per_page=20`,
        { headers: { Authorization: pexelsKey }, signal: AbortSignal.timeout(15000) },
      );
      if (res.ok) {
        const json = await res.json();
        const relevant = (json.photos || []).filter((p) =>
          _isImageRelevant((p.alt || '').replace(/\s+/g, ','), data),
        );
        for (const photo of relevant) {
          const url = photo.src?.large2x || photo.src?.large || photo.src?.original;
          if (url) candidates.push({ url, source: 'pexels', attribution: photo.photographer || null });
          if (candidates.length >= count) break;
        }
      }
    } catch (err) {
      console.warn(`  ⚠️  findStockImageCandidates/Pexels fallito: ${err.message}`);
    }
  }

  return candidates.slice(0, count);
}

const REQUIRED_IT_BODY_FIELDS = ['title', 'excerpt', 'body1', 'body2', 'body3'];

/**
 * JSON-Schema for the primary-locale article generation call.
 *
 * Forwarded to the LLM via `opts.jsonSchema` so providers with strict schema
 * mode (OpenAI/GitHub Models, Groq, Mistral, Gemini) refuse to emit a payload
 * missing `body2`/`body3`. Without this we were burning 5 retries + multiple
 * fallback models per article whenever a weak model omitted body2/body3.
 *
 * The schema only enforces presence + minLength on the high-value fields the
 * downstream validator (`validateItalianPayload` + `REQUIRED_IT_BODY_FIELDS`)
 * already rejects on. We do NOT noindex / soften the validator — this just
 * fixes the input so the validator passes on attempt 1.
 *
 * `additionalProperties: false` is required by OpenAI strict mode at every
 * object level. Gemini drops the keyword via `sanitizeSchemaForGemini` so the
 * same shape works on both providers.
 */
function buildArticleJsonSchema(primaryLocale = 'it') {
  // OpenAI strict-mode contract:
  //   - Root must be `type: object`
  //   - Every object MUST set `additionalProperties: false`
  //   - Every key in `properties` MUST appear in `required`
  //   - Optional fields are modelled as required-but-nullable union types
  //
  // We need to support TWO valid model outputs:
  //   1. Full article payload (id, category, image, content, seo, …)
  //   2. Abort-gate payload `{ abort_topical_relevance: true, reason: "…" }`
  //      (REGOLA #0 short-circuit when the source has no frontaliere angle)
  //
  // Solution: make every property required but nullable. The model either
  //   - sets abort_topical_relevance=true and leaves the content fields null, OR
  //   - fills the content fields and leaves abort_topical_relevance=null.
  // The runtime abort gate (line ~3046) short-circuits before
  // validateItalianPayload runs, so the null-content branch is consumed there.
  // For the full-content branch, every body field (body1/body2/body3) MUST be a
  // non-null string — which is exactly what stops the body2/body3 omission bug.
  //
  // Gemini's responseSchema doesn't accept additionalProperties or nullable
  // unions; sanitizeSchemaForGemini drops those and Gemini gets a permissive
  // shape. The schema is additive — the existing retry loop in callLLM still
  // covers providers without strict-schema support.
  const nullableString = { type: ['string', 'null'] };
  const nullableBoolean = { type: ['boolean', 'null'] };

  const contentBlock = {
    type: ['object', 'null'],
    additionalProperties: false,
    required: ['title', 'excerpt', 'body1', 'body2', 'body3', 'faq'],
    properties: {
      // No minLength — downstream `validateItalianPayload` enforces real-size
      // checks. The schema's job is only to guarantee presence (so the model
      // can't omit body2/body3 entirely, which is the failure mode this fix
      // targets).
      title: { type: 'string' },
      excerpt: { type: 'string' },
      body1: { type: 'string' },
      body2: { type: 'string' },
      body3: { type: 'string' },
      faq: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['q', 'a'],
          properties: {
            q: { type: 'string' },
            a: { type: 'string' },
          },
        },
      },
    },
  };

  const localeStringRecord = {
    type: ['object', 'null'],
    additionalProperties: false,
    required: ['it', 'en', 'de', 'fr'],
    properties: {
      it: { type: 'string' },
      en: { type: 'string' },
      de: { type: 'string' },
      fr: { type: 'string' },
    },
  };

  return {
    name: 'article_primary_locale',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'id', 'category', 'image', 'hasCalculator', 'imagePrompt',
        'imageAlt', 'slugs', 'content', 'seo',
        'abort_topical_relevance', 'reason',
      ],
      properties: {
        id: nullableString,
        category: nullableString,
        image: nullableString,
        hasCalculator: nullableBoolean,
        imagePrompt: nullableString,
        imageAlt: localeStringRecord,
        slugs: localeStringRecord,
        content: {
          type: ['object', 'null'],
          additionalProperties: false,
          required: [primaryLocale],
          properties: {
            [primaryLocale]: contentBlock,
          },
        },
        seo: {
          type: ['object', 'null'],
          additionalProperties: false,
          required: ['title', 'description', 'keywords', 'ogTitle', 'ogDescription', 'headline', 'breadcrumbName'],
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            keywords: { type: 'string' },
            ogTitle: { type: 'string' },
            ogDescription: { type: 'string' },
            headline: { type: 'string' },
            breadcrumbName: { type: 'string' },
          },
        },
        abort_topical_relevance: nullableBoolean,
        reason: nullableString,
      },
    },
  };
}

function normalizeItalianContentFromPayload(payload, locale = 'it') {
  const content = payload?.content;
  const candidates = [];

  if (content && typeof content === 'object') {
    if (content[locale] && typeof content[locale] === 'object') candidates.push(content[locale]);
    candidates.push(content);
  }
  candidates.push(payload);

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const block = {};
    let hasAnyField = false;

    for (const field of REQUIRED_IT_BODY_FIELDS) {
      const value = typeof candidate[field] === 'string' ? candidate[field].trim() : '';
      if (value) hasAnyField = true;
      block[field] = value;
    }

    if (hasAnyField) return block;
  }

  return null;
}

function validateItalianPayload(contentIt, locale = 'it') {
  for (const field of REQUIRED_IT_BODY_FIELDS) {
    if (!contentIt?.[field] || contentIt[field].trim().length < 1) {
      // qualityReject=true: missing-field is the same content-quality class as
      // callLLM's body2-validation throws (malformed/incomplete generation),
      // not an infrastructure error — isQualityRejectError() didn't match a
      // bare "mancante" message, so this crashed the run instead of skipping
      // to the next headline (same catch chain: callGemini -> proven-pool/
      // evergreen/manual-URL).
      const err = new Error(`Campo ${field} mancante per ${locale}`);
      err.qualityReject = true;
      throw err;
    }
  }

  if (contentIt.body2.trim().length < 40) {
    throw new Error(`Campo body2 troppo corto per ${locale}`);
  }
}

function assertTaxHealthConsistency(contentIt, sourceContext = null, pageContent = '') {
  const sourceBlob = `${sourceContext?.headline || ''} ${sourceContext?.url || ''} ${pageContent || ''}`.toLowerCase();
  // Apply guard only when the source topic is clearly about "tassa salute"
  if (!/tassa\s+(della\s+)?salute/.test(sourceBlob)) return;

  const articleText = [
    contentIt?.title || '',
    contentIt?.excerpt || '',
    contentIt?.body1 || '',
    contentIt?.body2 || '',
    contentIt?.body3 || '',
  ].join(' ').toLowerCase();

  // Known bad inversion seen in production:
  // "lavorano in Lombardia e risiedono in Ticino"
  const invertedAudiencePattern =
    /(lavor\w+\s+in\s+lombardia[\s\S]{0,160}(risied\w+|resident\w+)\s+in\s+ticino)|((risied\w+|resident\w+)\s+in\s+ticino[\s\S]{0,160}lavor\w+\s+in\s+lombardia)/i;

  if (invertedAudiencePattern.test(articleText)) {
    throw new Error('Articolo rigettato: platea tassa salute potenzialmente invertita (Lombardia↔Ticino).');
  }
}

/**
 * Fact-check: BLOCKING — reject articles with too many unsourced numbers.
 * Throws if > 50% of specific numbers in the article are not found in the source.
 * For evergreen articles (no source), blocks if > 3 suspiciously precise numbers are present.
 */
// factCheckNumbers() REMOVED — replaced by LLM-based fact-checking (llmFactCheck).
// Regex number comparison was fragile: legal reference numbers (D.Lgs 241/1997),
// convention years (1976), and known tax rates kept causing false positives.

// KNOWN_LEGAL_REFS removed — legal reference verification is now handled entirely
// by llmFactCheck() which has broader knowledge than a static whitelist.

// Patterns that signal fabricated content
const FABRICATED_INSTITUTION_PATTERNS = [
  /codice\s+federale\s+del\s+lavoro/i,
  /\bCFL\b(?!\s*[A-Z])/,
  /dipartimento\s+delle\s+entrate\b/i,
  /codice\s+federale\s+(?:della\s+)?(?:salute|sanità)/i,
  /ministero\s+(?:federale|cantonale)\s+del(?:la)?\s+(?:lavoro|salute|finanz)/i,
  /ufficio\s+federale\s+del(?:la)?\s+(?:lavoro\s+transfrontaliero|migrazione\s+lavorativa)/i,
  // Bare "ufficio federale del lavoro" (no qualifier) — the variant that
  // actually slipped through in 3 journalist-submitted articles (this list
  // wasn't wired into the journalist publish path at all; see
  // publish-journalist-article.mjs). Matches tests/article-fabrication-guard
  // .test.ts's FABRICATED_LABOR_OFFICE.it pattern for consistency — real
  // institution: SECO.
  /\b[Uu]fficio federale(?: svizzero)? del lavoro\b/i,
  /legge\s+cantonale\s+(?:sui|del)\s+frontalier/i,
  /regolamento\s+ticinese\s+(?:del|sul)\s+lavoro/i,
  /commissione\s+(?:federale|cantonale)\s+(?:per\s+i\s+)?frontalier/i,
  /osservatorio\s+nazionale\s+(?:del|sulla)\s+sicurezza\s+(?:sul\s+)?lavoro/i,
  // Patterns from 45-article audit (April 2026)
  /commissione\s+di\s+bilancio\s+e\s+vigilanza\s+del\s+canton/i,
  /compagnia\s+di\s+assicurazione/i,
  /decreto\s+federale\s+sul\s+rispetto\s+ambientale/i,
  /\bDEMAS\b/,
  /legge\s+(?:federale\s+)?sulla\s+protezione\s+dell['']ambiente\s+e\s+della\s+sicurezza\s+pubblica/i,
  /legge\s+sulla\s+cooperazione\s+transfrontaliera/i,
  /tariffa\s+del\s+peccato/i,
  /\bSS\s+39\b(?!.*Alto\s+Adige)/i,  // SS 39 is in Alto Adige, not Ticino
  /\bSS\s+415\b/i,                    // Italian road designation, not Swiss
];

// Fabricated Swiss/Italian acronyms that LLMs love to invent
const FABRICATED_ACRONYMS = [
  { pattern: /\bUFOL\b/, real: 'SECO' },
  { pattern: /\bUWL\b/, real: 'SECO' },
  { pattern: /\bUSTTI\b/, real: 'USTAT' },
  { pattern: /\bUBSP\b/, real: 'UFSP/BAG' },
  { pattern: /\bONSSL\b/, real: 'SUVA' },
  { pattern: /\bROSSL\b/, real: 'SUVA' },
  { pattern: /\bLCFL\b/, real: 'LL/ArG' },
  { pattern: /\bLFP\b(?!\s*(?:pension|previd))/i, real: 'LPP' },
  { pattern: /\bRTL\b(?!\s*(?:radio|tv))/i, real: 'LL/ArG' },
  { pattern: /\bLTL\b/, real: 'LL/ArG' },
  { pattern: /\bCCFL\b/, real: 'non esiste' },
  { pattern: /\bUFML\b/, real: 'SEM' },
  // Patterns from 45-article audit (April 2026)
  { pattern: /\bUFIS\b/, real: 'UFSP/BAG (Ufficio federale della sanità pubblica)' },
  { pattern: /\bDLGS\s+299\/2006\b/i, real: 'legge inesistente' },
  { pattern: /\bD\.?Lgs\.?\s+299\/2006\b/i, real: 'legge inesistente' },
];

/**
 * BLOCKING — Detect fabricated legal references, fake institutions, and hallucinated laws.
 * Throws if the article contains references to non-existent laws or institutions.
 */
function assertNoFabricatedReferences(contentIt) {
  const articleText = [
    contentIt?.title || '',
    contentIt?.body1 || '', contentIt?.body2 || '', contentIt?.body3 || '',
  ].join(' ');
  const articleLower = articleText.toLowerCase();
  const issues = [];

  // Check for fabricated institutions
  for (const pattern of FABRICATED_INSTITUTION_PATTERNS) {
    if (pattern.test(articleText)) {
      issues.push(`istituzione inesistente: "${pattern.source}"`);
    }
  }

  // Check for fabricated Swiss acronyms
  for (const { pattern, real } of FABRICATED_ACRONYMS) {
    if (pattern.test(articleText)) {
      issues.push(`acronimo inventato "${pattern.source}" (reale: ${real})`);
    }
  }

  // Legal reference verification is handled by llmFactCheck() which understands
  // context (e.g., "Legge 78/2010" referring to DL 78/2010 is a minor type error,
  // not a fabrication). The LLM correctly identifies truly fabricated laws.

  // Check for suspiciously specific fake percentages with "tassa" context
  let m;
  const taxRatePattern = /tass[ae]\s+(?:\w+\s+){0,5}(\d{1,2}(?:[.,]\d+)?)\s*%/gi;
  while ((m = taxRatePattern.exec(articleLower)) !== null) {
    const rate = parseFloat(m[1].replace(',', '.'));
    if (rate === 10 && /tassa\s+(?:sulla\s+)?salute/i.test(m[0])) {
      issues.push('"tassa sulla salute del 10%" è un dato inventato');
    }
  }

  // Check for commonly hallucinated convention date
  if (/convenzione.*9\s+marzo\s+1976/i.test(articleText) || /9\s+marzo\s+1976.*convenzione/i.test(articleText)) {
    issues.push('Convenzione italo-svizzera: 9 dicembre 1976, non 9 marzo');
  }

  // Check for fabricated "secondo uno studio/sondaggio" with suspiciously precise percentages
  const fakeStudyPattern = /secondo\s+(?:uno\s+)?(?:studio|sondaggio|indagine|ricerca)\b[^.]{0,80}?(\d{2,3}[.,]\d+\s*%)/gi;
  while ((m = fakeStudyPattern.exec(articleLower)) !== null) {
    issues.push(`statistica inventata con fonte vaga: "${m[0].slice(0, 80)}..."`);
  }

  // Check for fabricated annual reports with precise numbers
  const fakeReportPattern = /(?:rapporto|report)\s+(?:annuale\s+)?(?:20\d{2})\s+(?:del(?:la|l')?)\s+\w+[^.]{0,100}?(\d{2,3}[.,]\d+\s*%)/gi;
  while ((m = fakeReportPattern.exec(articleLower)) !== null) {
    issues.push(`rapporto con percentuale sospetta: "${m[0].slice(0, 80)}..."`);
  }

  if (issues.length > 0) {
    const msg = issues.map((i, idx) => `  ${idx + 1}. ${i}`).join('\n');
    throw new Error(`Articolo rigettato — ${issues.length} problemi di veridicità:\n${msg}`);
  }
}

// Cross-locale fabricated-institution check — same non-existent "federal
// labour office" (real: SECO) that FABRICATED_INSTITUTION_PATTERNS/
// assertNoFabricatedReferences catch in Italian, but per-locale so it can
// run AFTER translateArticle() on the en/de/fr output. assertNoFabricatedReferences
// itself only ever sees contentIt (called before translation exists), so a
// translation that independently hallucinates this institution in a
// different language was never checked at all — exactly what happened to 2
// of the 3 articles fixed alongside this change (EN/FR each invented their
// own fake acronym independently of the IT text). Patterns mirror
// tests/article-fabrication-guard.test.ts's FABRICATED_LABOR_OFFICE (kept in
// sync manually — same cross-file duplication already accepted for the
// audit-classifier section matchers, since this runtime script and the test
// file don't share an import boundary worth introducing for one pattern set).
const FABRICATED_LABOR_OFFICE_BY_LOCALE = {
  it: /\b[Uu]fficio federale(?: svizzero)? del lavoro\b/i,
  de: /\b([Bb]undesamt(?:es)? für Arbeit|[Bb]undesarbeitsamt)\b/,
  fr: /\b(?:[Oo]ffice|[Bb]ureau) fédéral du travail\b/,
  en: /\b[Ff]ederal (?:Labou?r Office|Office of Labou?r)\b/,
};

/**
 * BLOCKING — Detect the fabricated "federal labour office" institution (real:
 * SECO) in the en/de/fr translations. Call AFTER translateArticle() populates
 * data.content.{en,de,fr}.
 */
// Bare acronyms mapped to SECO in FABRICATED_ACRONYMS above. These are
// language-INDEPENDENT (an invented acronym reads the same regardless of
// which locale's prose surrounds it — confirmed live: the IT edition of
// "sempre-meno-frontalieri-ticino-calof-lievelie" leaked a standalone "L'UWL
// ha anche rilevato..." sentence with no accompanying full institution name),
// so the same word-boundary patterns apply directly to en/de/fr text without
// a per-locale variant.
const FABRICATED_LABOR_OFFICE_ACRONYMS = [/\bUFOL\b/, /\bUWL\b/];

/**
 * BLOCKING — Detect the fabricated "federal labour office" institution (real:
 * SECO) in the en/de/fr translations. Call AFTER translateArticle() populates
 * data.content.{en,de,fr}. Covers BOTH the full institution-name variants
 * (FABRICATED_LABOR_OFFICE_BY_LOCALE, per-locale wording) and the bare
 * acronym echoes (FABRICATED_LABOR_OFFICE_ACRONYMS, locale-independent) —
 * a translation can leak either independently of what the IT source said.
 */
function assertNoFabricatedLaborOfficeCrossLocale(data) {
  const issues = [];
  for (const locale of ['en', 'de', 'fr']) {
    const content = data?.content?.[locale];
    if (!content) continue;
    const text = [content.title || '', content.body1 || '', content.body2 || '', content.body3 || ''].join(' ');
    const namePattern = FABRICATED_LABOR_OFFICE_BY_LOCALE[locale];
    if (namePattern && namePattern.test(text)) {
      issues.push(`[${locale}] istituzione inventata "${namePattern.source}" (reale: SECO)`);
    }
    for (const acronymPattern of FABRICATED_LABOR_OFFICE_ACRONYMS) {
      if (acronymPattern.test(text)) {
        issues.push(`[${locale}] acronimo inventato "${acronymPattern.source}" (reale: SECO)`);
      }
    }
  }
  if (issues.length > 0) {
    const msg = issues.map((i, idx) => `  ${idx + 1}. ${i}`).join('\n');
    throw new Error(`Articolo rigettato — istituzione fabbricata nelle traduzioni:\n${msg}`);
  }
}

// ── Reference sheet of verified domain facts ──
// Fed into the LLM fact-check prompt so the model cross-checks against known-good data
// instead of relying solely on training data. NOT section-branched (unlike
// EVERGREEN_FACTS_BRIEF/_CH below) — llmFactCheck injects this same sheet for
// both `frontaliere` and `svizzera` articles. The prompt's institution check
// (llmFactCheck, "ISTITUZIONI E ENTI") hard-instructs the model to flag any
// acronym NOT in this whitelist as suspect, so the institution list here must
// be a SUPERSET covering both sections' legitimate entities — omitting a real
// national institution (e.g. AFC/ESTV, BNS/SNB, both used elsewhere in this
// file as valid `svizzera`-section topics) makes llmFactCheck flag it as
// fabricated on an otherwise-correct national article, the same false-block
// mechanism issue #96 fixed on the deterministic source-fidelity gate.
const VERIFIED_DOMAIN_FACTS = `
FATTI VERIFICATI DI RIFERIMENTO — usa come ground truth:

CONVENZIONI E ACCORDI:
- Convenzione italo-svizzera contro le doppie imposizioni: firmata 9 DICEMBRE 1976 (NON marzo, NON 1974)
- Nuovo Accordo Frontalieri: firmato 23 DICEMBRE 2020, in vigore dal 1° GENNAIO 2024
- Periodo transitorio: dal 2024 al 2033 (10 anni) per chi era già frontaliere prima del 17/7/2023
- Ratifica italiana: Legge 83 del 13 GIUGNO 2023

ALIQUOTE SVIZZERE:
- AVS/AI/IPG: 5.3% dipendente (10.6% totale)
- AD (AC): 1.1% fino a CHF 148'200 (2024)
- LAINF (LAA): 0.7%-1.5% (varia per settore)
- IGM (IJM): ~0.5%-1.0% (perdita guadagno malattia, non obbligatoria federale)
- LPP: dal 25 anni, contributi variabili per fascia d'età (7%-18% salario coordinato)

ALIQUOTE ITALIANE (2024-2026):
- IRPEF: 23% fino €28'000, 35% €28'001-€50'000, 43% oltre €50'000
- Franchigia nuovo accordo: €10'000 esenti per NUOVI frontalieri (dal 2024)
- Vecchi frontalieri (ante 17/7/2023): esenzione €7'500 fino al 2033

ISTITUZIONI REALI:
- Svizzera: SECO, SEM, SUVA, USTAT, UFSP (BAG in tedesco), SUPSI, USI, EOC, DFE, DSS, ARE, BFS, AFC/ESTV, BNS/SNB
- Italia: INPS, Agenzia delle Entrate, MEF, Guardia di Finanza, INAIL
- Bilaterali: non sono "accordi EU-Svizzera" (la Svizzera NON è membro UE/EEA)
- BPS (SUISSE), UFAS/BSV, UFG, UDSC, Fedpol = istituzioni REALI

NUMERI FRONTALIERI:
- Frontalieri in Ticino: ~79'000 (USTAT, 2024) — circa 30% della forza lavoro cantonale
- Frontalieri totali CH: ~400'000
- Quota ristorno fiscale ai comuni italiani: 40% dell'imposta alla fonte (vecchio accordo)

GEOGRAFIA:
- Valichi principali: Brogeda (Chiasso), Gaggiolo (Stabio), Ponte Tresa, Dirinella (Gandria)
- Autostrade svizzere: A2 (Chiasso-Gottardo), A13 (San Bernardino)
- In Svizzera NON esistono "SS" (Strade Statali) — quelle sono italiane
- Comuni frontalieri TI: Chiasso, Mendrisio, Stabio, Balerna, Vacallo, Novazzano, Coldrerio

ASSICURAZIONI:
- LAMal: obbligatoria per residenti CH. Frontalieri G hanno diritto d'opzione (LAMal o sistema italiano)
- Franchige LAMal adulti: CHF 300, 500, 1'000, 1'500, 2'000, 2'500
- LAMAL non è "tassa sulla salute" — è assicurazione malattia
`;

// ── Compact verified-facts brief for the GENERATION prompt (evergreen) ──
// PR #3009 injected the FULL VERIFIED_DOMAIN_FACTS sheet into the evergreen
// generation source content to align generator and fact-checker on the same
// ground truth. That fixed the consensus-block (fact-check now PASSes) but
// inflated the generation prompt enough to tip regeneration attempts over the
// 8000-token input cap of several otherwise-available models (gpt-4.1-mini/
// nano, Llama-3.3-70B, Meta-Llama-3.1-405B, Cohere-command-a, Phi-4 → HTTP 413
// tokens_limit_reached, observed at estimated ~8309 on run 28353924029),
// shrinking the free-tier pool and re-triggering "tutti i modelli esauriti".
//
// This compact brief keeps ONLY the facts the consensus fact-checker
// HARD-BLOCKS on (`llmFactCheck` / VERIFIED_DOMAIN_FACTS, used in full there):
// imposta alla fonte location, accordo dates, franchigia/transitional,
// convenzione date, the load-bearing CH/IT aliquote with granular per-bracket
// rates (AD cap, LAINF, LPP per-band — without these, a model writing salary/
// contribution text may invent wrong figures the checker flags as critical:aliquote),
// the valid-institution acronyms, and the LAMal definition. The generator now
// sees these exact values, so it can't diverge into a `critical` on the topics
// where free models actually go wrong — while keeping the prompt small. Softer
// facts (frontalieri headcount, valichi geography) are intentionally dropped:
// not in the unconditional-block criteria, and every line eats prompt headroom.
//
// Measured (runtime estimateRequestTokens, the same heuristic the model-skip
// guard at ai-models.mjs uses) on the ASSEMBLED first-attempt evergreen prompt
// with this brief: estTokens=7215 — ~785 under the 8000 cap, so the 8000-bracket
// models are back in the pool. Regeneration attempts append fact-check feedback
// (pre-existing behaviour shared by all sections); this brief keeps that path
// strictly smaller than the #3009 full-sheet version.
//
// Extended 2026-07-06: run flagged 2 critical fact-check issues from an
// evergreen tax-calculation article — the generator invented "Istituto
// Federale della Statistica (STATIKA)" (real entity: BFS) and wrongly
// attributed tax-rate-setting to UFAS (real institution, wrong competency —
// UFAS is social-insurance, not taxation). Neither BFS nor a tax-authority
// acronym were in the brief's institution whitelist, so a model without
// training-data recall of the real Swiss tax administration had nothing
// grounded to reach for. Added BFS + AFC/ESTV and an explicit competency
// line so every model in the cascade (not just local/fallback — this brief
// feeds whichever model the chain picks) has the real names before writing,
// instead of only being graded against them after the fact. New estTokens
// ~7333 (+118 vs the measurement above) — still ~667 under the 8000 cap.
const EVERGREEN_FACTS_BRIEF = `FATTI VERIFICATI (ground truth — il fact-checker blocca l'articolo se diverghi da questi valori):
- Imposta alla fonte sul reddito da lavoro: trattenuta SOLO in Svizzera per i frontalieri (MAI "in entrambi i paesi"). L'Italia evita la doppia imposizione con il credito d'imposta (quadro CE del 730).
- Nuovo Accordo Frontalieri: firmato 23/12/2020, in vigore dal 1° GENNAIO 2024 (NON 2026). Ratifica IT: Legge 83 del 13/6/2023.
- Vecchi frontalieri (già tali prima del 17/7/2023): esenzione €7'500, regime transitorio 2024–2033. Nuovi frontalieri: franchigia €10'000.
- Convenzione doppie imposizioni Italia-Svizzera: firmata il 9 DICEMBRE 1976. La Svizzera NON è membro UE/SEE.
- Aliquote/contributi svizzeri: AVS/AI/IPG 5.3% dipendente, AD/AC 1.1% (cap CHF 148'200), LAINF 0.7–1.5%, LPP 7–18% per fascia età (dal 25 anni). IRPEF italiana: 23% fino €28'000, 35% €28'001–50'000, 43% oltre €50'000.
- Acronimi/enti VALIDI (non inventarne altri): SECO, SEM, USTAT, UFSP/BAG, SUVA, INPS, Agenzia delle Entrate, MEF, BFS (Ufficio Federale di Statistica), AFC/ESTV (Amministrazione Federale delle Contribuzioni).
- Le aliquote fiscali (imposta alla fonte, aliquote federali/cantonali) sono stabilite da leggi federali/cantonali e amministrate da AFC/ESTV a livello federale e dalle amministrazioni cantonali delle contribuzioni — MAI da UFAS (previdenza sociale, AVS/AI) né da BFS (statistica: rileva dati, non fissa aliquote).
- LAMal = assicurazione malattia (NON "tassa sulla salute"); frontalieri G hanno diritto d'opzione; franchige adulti CHF 300–2500.`;

// ── Ground truth della sezione `svizzera` (issue #96) ───────────────────
//
// Perche' esiste. EVERGREEN_FACTS_BRIEF qui sopra e' interamente frontaliero
// — Accordo Frontalieri, IRPEF, Convenzione 1976, ristorni — e fino al
// 2026-08-09 veniva iniettato SENZA branch di sezione. Per un evergreen della
// sezione `svizzera` (imposta cantonale, LAMal, LPP, locazione, permessi) quei
// fatti non sono ne' pertinenti ne' citabili: l'articolo li omette
// CORRETTAMENTE, e li' l'omissione veniva letta come un difetto.
//
// Misurato sui run reali (sezione svizzera, section=svizzera nel log):
//   31302188005 "dichiarazione imposte svizzera ... canton Vaud" → recall 4%,0%,7%,11%,0%
//   31294793333 "affitti svizzera mercato immobiliare ... Berna" → recall 0%,15%,0%,0%,0%
//   31286677581 "secondo pilastro lpp ... San Gallo"             → recall 7%,30%,7%,7%,11%
// Sempre `[source-fidelity-low] ... /27 dei fatti verificabili della fonte`:
// 27 anchor, TUTTI dal brief frontaliero (misurato a parte con
// extractSourceAnchors — stesso numero, due lenti indipendenti).
// Sei tentativi, poi uno strike; tre strike e la keyword muore. Al 2026-08-09
// 94 delle 110 keyword del pool svizzero erano gia' morte (42 ban permanenti,
// 52 per strike) e il run finiva con «Tutte le keyword evergreen risultano
// gia' coperte dal pre-flight».
//
// Piu' corto del gemello frontaliero DI PROPOSITO. Un brief e' un ELENCO DI
// VALORI PERMESSI: ogni riga sbagliata diventa ground truth contro cui il
// fact-checker blocca, quindi qui stanno solo fatti strutturali e stabili
// (competenze, aliquote di legge, soglie procedurali). Le cifre indicizzate
// ogni anno — massimale 3a, soglia d'entrata LPP, premi LAMal — sono
// deliberatamente ASSENTI: l'istruzione esplicita e' di ometterle, non di
// ricostruirle a memoria, che e' il modo in cui nascono le allucinazioni che
// checkFabricatedInstitutionAcronyms poi blocca.
const EVERGREEN_FACTS_BRIEF_CH = `FATTI VERIFICATI (ground truth — il fact-checker blocca l'articolo se diverghi da questi valori):
- Sistema fiscale svizzero a TRE livelli: imposta federale diretta (IFD) + cantonale + comunale. Ogni cantone ha la propria legge tributaria e il proprio moltiplicatore; i comuni applicano un moltiplicatore sul cantonale. Non esiste un'aliquota unica nazionale.
- Competenze (MAI confonderle): AFC/ESTV (Amministrazione federale delle contribuzioni) amministra l'imposta federale diretta e l'IVA; le amministrazioni CANTONALI delle contribuzioni gestiscono imposta cantonale e comunale; UFAS/BSV si occupa di previdenza sociale (AVS/AI/LPP) e NON fissa imposte; UST/BFS rileva statistiche e NON fissa aliquote.
- Contributi sociali su salario: AVS/AI/IPG 5.3% a carico del dipendente (10.6% totale con il datore), AD/AC 1.1% fino al massimale annuo, LAINF/LAA 0.7–1.5% secondo settore. Accrediti di vecchiaia LPP sul salario coordinato: 7% (25–34 anni), 10% (35–44), 15% (45–54), 18% (55 anni fino all'eta' di riferimento).
- LAMal: assicurazione malattia OBBLIGATORIA per chi risiede in Svizzera, da stipulare entro 3 mesi dall'arrivo. E' un'assicurazione privata a premi pro capite, NON una tassa e NON un contributo sul salario. Franchigie adulti CHF 300, 500, 1000, 1500, 2000, 2500. Premi fissati per cantone e regione di premio; la riduzione premi (sussidio) e' cantonale.
- Permessi per stranieri (autorita' federale: SEM): L = breve durata (fino a 1 anno), B = dimora (rinnovabile), C = domicilio (di norma dopo 10 anni di residenza, 5 per cittadini UE/AELS secondo accordo), G = frontaliere. Naturalizzazione ordinaria: permesso C e 10 anni di residenza (gli anni tra i 8 e i 18 contano doppio), piu' requisiti cantonali e comunali.
- Locazione (Codice delle obbligazioni, art. 253 e segg., diritto FEDERALE uguale in tutti i cantoni): deposito cauzionale al massimo 3 mesi di pigione, su conto vincolato intestato all'inquilino; disdetta del locatore valida solo su modulo ufficiale cantonale; contestazione entro 30 giorni all'autorita' di conciliazione.
- Lavoro: NESSUN salario minimo federale (alcuni cantoni ne hanno uno proprio). Durata massima settimanale 45 ore (industria, uffici, personale di vendita) o 50 ore negli altri settori. Vacanze minime 4 settimane (5 fino ai 20 anni compiuti). Congedo maternita' 14 settimane all'80% del salario tramite IPG; congedo di paternita' 2 settimane. Termini di disdetta legali: 1 mese nel primo anno, 2 mesi dal 2° al 9°, 3 mesi dal 10° in poi.
- Democrazia diretta: 4 date di votazione federale all'anno. Iniziativa popolare 100'000 firme in 18 mesi; referendum facoltativo 50'000 firme in 100 giorni. Una modifica della Costituzione richiede la DOPPIA maggioranza (popolo E cantoni).
- Acronimi/enti VALIDI (non inventarne altri): SECO, SEM, UST/BFS, UFSP/BAG, AFC/ESTV, UFAS/BSV, SUVA, BNS/SNB, UDSC, Fedpol, ARE, USTAT (Ticino).
- Cifre indicizzate ogni anno — massimale del 3° pilastro 3a, soglia d'entrata e deduzione di coordinamento LPP, massimale AD/AC, premi medi LAMal, salario mediano: NON riportare un importo preciso se non sei certo dell'anno. Descrivi il meccanismo e rimanda alla fonte ufficiale.`;

// I due brief nella forma che serve a `stripInjectedBriefs`. Un array, non due
// costanti nominate al call-site: cosi' aggiungere una terza sezione domani
// non lascia indietro il denominatore del gate di recall.
const EVERGREEN_FACTS_BRIEFS = [EVERGREEN_FACTS_BRIEF, EVERGREEN_FACTS_BRIEF_CH];

/**
 * Il brief da iniettare per una sezione. PURA e nominata apposta: il difetto
 * di #96 non era il contenuto del brief, era che il punto di iniezione non
 * aveva nessun branch di sezione da leggere — `IS_FRONTALIERE` esisteva gia'
 * (definito ~1500 righe piu' su) e nessuno lo interrogava qui.
 *
 * Default frontaliere per QUALUNQUE valore non riconosciuto: e' la sezione
 * storica e il default di `parseSectionArg`, quindi un nome sbagliato degrada
 * al comportamento precedente invece di consegnare un ground truth svizzero a
 * un articolo frontaliero.
 */
export function evergreenFactsBriefFor(sectionName) {
  return sectionName === 'svizzera' ? EVERGREEN_FACTS_BRIEF_CH : EVERGREEN_FACTS_BRIEF;
}

/**
 * Toglie i brief iniettati dal testo usato come DENOMINATORE del gate di
 * fedelta' alla fonte (`checkSourceFidelity`).
 *
 * Questa e' la meta' strutturale della fix, e senza di essa il brief
 * section-aware da solo NON basta — verificato: un brief svizzero produce
 * comunque 27 anchor svizzeri, e un articolo sui diritti dell'inquilino non
 * ne cita 14 piu' di quanto citasse l'IRPEF.
 *
 * La ragione e' che il brief serve due scopi OPPOSTI nello stesso punto:
 *   - come GROUNDING dice «se citi un'aliquota, usa questa»  (un elenco di valori permessi)
 *   - come FONTE  dice «devi ricitarne almeno la meta'»       (una trascrizione da conservare)
 * `checkSourceFidelity` misura il secondo — «hai conservato quello che la
 * fonte diceva?» — ed e' scritto per una PAGINA DI NOTIZIA scrapata. Un
 * evergreen non ha una fonte: il testo che riceve al suo posto e' un menu che
 * il generatore ha scritto da se'. Misurarne il recall e' un errore di
 * categoria, e `llmFactCheck` lo sapeva gia': ha il ramo `isEvergreen` che lo
 * esenta esplicitamente («Per evergreen, NON segnalare come issue un fatto
 * solo perche' non compare in una fonte originale»). Il gate deterministico
 * non ha mai ricevuto la stessa esenzione — e' li' il difetto di wiring.
 *
 * NON abbassa nessuna soglia: `minRecall` resta 0.5 e `minAnchors` resta 3.
 * Tolto il brief, il testo residuo dell'evergreen porta 0 anchor (misurato) e
 * il gate si disattiva da solo per la propria guardia `anchors.size <
 * minAnchors`, che e' il ramo gia' previsto per «fonte troppo sottile per
 * giudicare».
 *
 * Su una fonte reale e' un NO-OP esatto (una pagina di notizia non contiene il
 * brief), quindi il gate resta a piena forza dove e' stato progettato per
 * lavorare — incluso `stats-bfs://`, dove il prompt e' fatto di numeri BFS
 * veri e il recall su quelli e' esattamente cio' che si vuole misurare.
 *
 * @param {string} sourceText
 * @param {string[]} briefs
 * @returns {string}
 */
export function stripInjectedBriefs(sourceText, briefs = EVERGREEN_FACTS_BRIEFS) {
  if (typeof sourceText !== 'string' || sourceText === '') return '';
  let out = sourceText;
  for (const brief of briefs) {
    if (typeof brief === 'string' && brief.length > 0) out = out.split(brief).join('\n');
  }
  return out;
}

// ── Fact-check response cache (DEFAULT ON — kill switch) ────────────────
// origin/main already hard-codes `cache: true` on this exact call (no flag,
// no namespace) — the cache is ALREADY ACTIVE in production today. This
// function's job is only to preserve that behavior by default; the env var
// is a KILL SWITCH for turning it OFF, not an opt-in for turning it on.
// SAFE-BY-DESIGN: ai-models.mjs' _responseCacheKey (scripts/lib/ai-models.mjs
// ~1070-1088) hashes `messages` (full prompt = full article body) + `model` +
// `bypassForceChain` + the live AI_MODELS_FORCE_CHAIN env state, so a cache
// hit can only occur for the EXACT same article body, verified by the EXACT
// same judge model, in the EXACT same force-chain state — there is no
// cross-content or cross-model reuse possible, and a forced-local response
// cannot enter the remote-consensus path (bypassForceChain is folded into
// the key), so the "circular self-consensus" hazard ai-models.mjs flags
// (~1039-1050) for this caller does not apply to the concrete key shape.
// BENEFIT: dedupes the ~5s outer FACTCHECK_INFRA_RETRIES re-check
// (triggered when a verifier returns non-JSON, see loop below) — a retry of
// an unchanged body against the same judge model reuses the deterministic
// (temperature 0) verdict instead of re-running the full fallback cascade.
// If a circular-self-consensus problem is ever observed in practice, set
// CREATE_ARTICLE_FACTCHECK_CACHE=0 to disable without a code change.
function isFactCheckCacheEnabled() {
  const raw = (process.env.CREATE_ARTICLE_FACTCHECK_CACHE || '').trim();
  if (raw === '') return true; // unset → preserve production default (cache ON)
  return !/^(0|false|no|off)$/i.test(raw); // explicit OFF values disable; anything else stays ON
}

/**
 * Pure helper: builds the opts object passed to _aiCallLLM for a single
 * fact-check verification call. Extracted so the cache on/off behavior is
 * unit-testable without any network call. Never touches model choice,
 * consensus logic, thresholds, or the blocking verdict — only whether the
 * response cache is engaged for this call. DEFAULT ON (kill switch): when
 * enabled this produces exactly `{ ...baseOpts, cache: true }`, byte-identical
 * to the pre-existing production call (no cacheNamespace, so the cache key —
 * which folds in `ns` — is unchanged from what's already live today).
 */
export function buildFactCheckCallOptions(baseOpts, cacheEnabled = isFactCheckCacheEnabled()) {
  return cacheEnabled ? { ...baseOpts, cache: true } : { ...baseOpts };
}

/**
 * PRIMARY BLOCKING — Multi-model consensus fact verification.
 *
 * Queries 2 DIFFERENT verification models and requires CONSENSUS to pass.
 * If either model finds critical issues, the article is blocked.
 * This prevents a single model from hallucinating "PASS" on fabricated content.
 *
 * Returns { passed: boolean, issues: object[] }
 */
// The article handed to the verifier used to be capped at 8000 chars. On the
// 2026-07-28 article `frontalieri-altre-tasse-2026` the assembled text was
// 10393 chars, so 2393 chars (23%) were never verified at all — and that blind
// tail is exactly where "Il Decreto Omnibus è stato varato il 1° gennaio 2023",
// "i frontalieri sono esentati dall'imposta alla fonte" and "un frontaliere
// residente a Bellinzona" shipped from.
//
// 24000 covers roughly twice a full-length article. Anything beyond it is
// logged rather than dropped in silence, and the deterministic gates always
// run over the WHOLE text regardless of this cap.
const MAX_FACTCHECK_ARTICLE_CHARS = 24000;

async function llmFactCheck(contentIt, sourceContent = '', sourceUrl = '') {
  const articleText = [
    contentIt?.title || '',
    contentIt?.excerpt || '',
    contentIt?.body1 || '', contentIt?.body2 || '', contentIt?.body3 || '',
  ].join('\n\n');

  const isEvergreen = !sourceContent || sourceContent.length < 100 || sourceUrl.startsWith('evergreen://') || sourceUrl.startsWith('stats-bfs://');

  if (articleText.length > MAX_FACTCHECK_ARTICLE_CHARS) {
    console.error(`  ⚠️  Fact-check: articolo di ${articleText.length} chars > cap ${MAX_FACTCHECK_ARTICLE_CHARS} `
      + `— la coda oltre il cap è verificata solo dai gate deterministici`);
  }

  const prompt = `${IS_FRONTALIERE
    ? 'Sei un fact-checker senior specializzato in diritto fiscale svizzero e italiano, con focus specifico su frontalieri e Canton Ticino.'
    : 'Sei un fact-checker senior specializzato in affari svizzeri a livello nazionale (economia, fiscalità federale e cantonale, mercato del lavoro, diritto), per un pubblico di residenti in Svizzera.'}

ARTICOLO DA VERIFICARE:
"""
${articleText.slice(0, MAX_FACTCHECK_ARTICLE_CHARS)}
"""

${isEvergreen ? 'NOTA: Articolo evergreen senza fonte specifica. Verifica basandoti sulle tue conoscenze del dominio e sui fatti di riferimento sotto. Per evergreen, NON segnalare come issue un fatto solo perché non compare in una fonte originale: segnala solo se è falso, contraddetto dai fatti verificati, troppo specifico senza attribuzione, o presentato come caso reale non verificato.' : `FONTE ORIGINALE (l'articolo doveva basarsi su questo testo):\n"""\n${sourceContent.slice(0, 6000)}\n"""`}

${VERIFIED_DOMAIN_FACTS}

VERIFICA SISTEMATICA — controlla OGNI categoria:

1. **LEGGI E DECRETI**: Ogni riferimento normativo (D.Lgs, DL, DPR, L.) deve esistere realmente con numero e anno corretti. Verifica che il contenuto attribuito alla legge sia corretto. Confronta con i fatti verificati sopra. ${isEvergreen ? '' : 'Se il riferimento NON è presente nella fonte originale, segnalalo come sospetto.'}

2. **ISTITUZIONI E ENTI**: Ogni istituzione menzionata deve esistere realmente. Confronta con la lista di istituzioni reali nei fatti verificati. Segnala qualsiasi acronimo NON presente in quella lista come sospetto. NON esiste: "Codice federale del lavoro", "CFL", "UFOL", "UWL", "Commissione federale per i frontalieri", "Ufficio federale dell'integrazione sanitaria (UFIS)".

3. **ALIQUOTE E CIFRE FISCALI**: Confronta OGNI aliquota con i valori nei fatti verificati. AVS=5.3%, AC=1.1%, IRPEF 23%/35%/43%. Se un'aliquota non corrisponde = critical.

4. **STATISTICHE E PERCENTUALI**: Percentuali precise con decimali (es. "il 73,2% dei frontalieri") DEVONO provenire da studi reali citati per nome E ISTITUTO. Senza attribuzione precisa = probabile invenzione. ECCEZIONE: arrotondamenti a numeri interi da fonti note (es. "circa il 30% della forza lavoro" da USTAT) sono accettabili. Non segnalare aliquote esplicitamente elencate nei fatti verificati (AVS=5.3%, AC=1.1%, IRPEF 23%/35%/43%, franchigia 10.000 euro) come issue se sono riportate correttamente.

5. **DATE E EVENTI**: Confronta con le date verificate: Convenzione 9/12/1976, Nuovo Accordo 23/12/2020, vigenza dal 1/1/2024, Legge 83/2023. ${isEvergreen ? '' : 'Date presenti nell\'articolo ma ASSENTI dalla fonte = altamente sospette.'}

6. **COERENZA CON LA FONTE**: ${isEvergreen ? 'N/A per evergreen.' : "Confronta ogni affermazione dell'articolo con la fonte originale. DISTINGUI tra: (a) arricchimento contestuale con fatti di dominio CORRETTI e verificabili (contesto frontaliere, aliquote note, geografia ticinese) = 'minor', (b) fatti specifici inventati (leggi/decreti inesistenti, statistiche precise senza fonte, istituzioni inventate, eventi mai avvenuti) NON presenti nella fonte = 'critical', (c) informazione che CONTRADDICE la fonte o i fatti verificati = 'critical'."}

7. **FATTI INVENTATI**: Cerca eventi, conferenze, referendum, proteste, dichiarazioni che sembrano plausibili ma potrebbero non essere mai avvenuti. SEGNALE D'ALLARME: eventi descritti con molti dettagli specifici (data precisa, luogo, partecipanti) che non appaiono in nessuna fonte nota.

   **SOTTOCATEGORIA — ESEMPI CONCRETI FABBRICATI (CRITICAL — incidente 2026-05-12 USZ whistleblower)**: scrutina con MASSIMA attenzione le sezioni titolate "Esempi concreti / Casi pratici / Casi reali / Per esempio / Caso 1, Caso 2". Pattern shipped che il fact-check aveva mancato:
   - "Lugano: Un'infermiera frontaliera ha segnalato carenze igieniche..."
   - "Chiasso: Un medico ha denunciato pratiche non etiche..."
   - "Un infermiere dell'ORL ha ottenuto il recupero di CHF 50.000..."
   - "Un medico dell'Ospedale Civico di Lugano ha denunciato pratiche di bilancio fraudolente, risultando in un'indagine della FINMA"

   REGOLA: qualunque bullet o paragrafo che combini (a) [Città CH o nome ospedale/azienda] + (b) [ruolo professionale: infermiere/medico/operaio/impiegato/chirurgo] + (c) [verbo specifico: ha segnalato/denunciato/ottenuto/recuperato] + (d) [esito o cifra specifica: CHF nnn, indagine, risarcimento, recupero], SENZA che il caso compaia nella fonte originale → CRITICAL: fatti_inventati. Onere della prova: l'articolo deve PROVARE che il caso esiste nella fonte; altrimenti è inventato per gonfiare la rilevanza frontaliere.

   Anche istituzioni applicate al dominio sbagliato sono CRITICAL: FINMA è autorità per mercati finanziari/banche, NON per ospedali/sanità. Citarla in contesti sanitari = fabbricazione di istituzione → critical:istituzioni.

   Leggi/sigle che sembrano plausibili ma non esistono = critical:leggi. Esempi shipped: "LProtInfo del 2023" (inesistente — è art. 321a CO), "LPAP del 2000" (è LPers, non LPAP). Se non puoi verificare la SIGLA UFFICIALE della legge, è critical.

8. **NOMI DI PERSONE E CITAZIONI**: Verifica che ogni persona citata (politici, consiglieri federali, funzionari) esista realmente con il ruolo indicato. Consiglieri federali attuali (2024-2027): Baume-Schneider, Parmelin, Cassis, Keller-Sutter, Amherd, Jans, Rösti. Citazioni dirette ("ha dichiarato:") di persone non verificabili sono quasi sempre inventate dall'IA.

9. **SVIZZERA ≠ UE**: La Svizzera NON è membro dell'Unione Europea né dello Spazio Economico Europeo (SEE/EEA). Frasi come "accordo EU-Svizzera", "normativa UE applicabile in Svizzera" o "la Svizzera come membro" sono ERRORI. I rapporti sono regolati da Accordi Bilaterali I (1999) e II (2004).

10. **PATTERN COMUNI DI HALLUCINATION IA**: Segnala come "critical" se trovi:
   - Decreti/leggi con acronimi inventati (DEMAS, LCFL, CFL, ecc.)
   - "Commissione" o "Osservatorio" con nomi troppo specifici e mai sentiti
   - Percentuali precise con decimali senza attribuzione a fonte reale
   - Leggi "entrate in vigore nel 20XX" senza numero di legge verificabile
   - "Tassa sulla salute" come imposta separata (non esiste — la LAMal è un'assicurazione)
   - Ministri o funzionari con nomi plausibili ma non verificabili
   - Accordi/protocolli bilaterali mai firmati (controllare attentamente)

${IS_FRONTALIERE ? `11. **RILEVANZA TOPICA AL FRONTALIERE TICINO-ITALIA (CRITICO)**: L'articolo deve avere un nesso REALE, SPECIFICO e VERIFICABILE con la vita del frontaliere Ticino-Italia. Sono nessi reali: norme/sentenze su Permesso G o B, fiscalità CH-IT (imposta alla fonte, nuovo accordo, ristorni, doppia imposizione), AVS/LPP/LAMal/CMI, busta paga svizzera, dogane/valichi (Chiasso, Brogeda, Gaggiolo, Ponte Tresa), pendolarismo CH-IT, mercato del lavoro ticinese, telelavoro frontaliere, salari ticinesi, accordi bilaterali CH-IT/UE, autostrade A2/A9 svizzere, banche e cambio CHF-EUR per frontalieri.

   ${isEvergreen ? '' : 'NON sono nessi reali (segnala "critical" come "rilevanza_topica"): cronaca nera italiana o estera senza nesso lavoro CH (es. arresti per omicidio comune, eventi USA, criminalità urbana italiana), eventi sportivi, gossip, cultura locale non-frontaliera, infrastruttura italiana lontana dal confine (es. eventi a Roma/Napoli/Palermo), eventi a Malpensa SENZA impatto sui voli o trasporti frontalieri.'}

   SEGNALE D'ALLARME (= "critical: rilevanza_topica"): paragrafi con titoli del tipo "Implicazioni per i frontalieri", "I frontalieri devono essere consapevoli di…", "Cosa significa per i frontalieri", su un evento SENZA implicazione concreta. Sezioni di consigli generici ("consulta un avvocato", "verifica la copertura assicurativa", "informati sui tuoi diritti") inserite per riempire spazio su un argomento non-frontaliere sono indicatori di forzatura.

   ${isEvergreen ? '' : "Se l'articolo è un commento generico (procedure di estradizione generiche, consigli legali universali, considerazioni assicurative generiche) attaccato a una notizia di cronaca che NON menziona frontalieri/permesso G/AVS/LAMal/dogana/ecc. nella fonte originale, il verdetto è FAIL — l'articolo non doveva essere generato."}` : `11. **RILEVANZA TOPICA NAZIONALE SVIZZERA (CRITICO)**: L'articolo deve avere un nesso REALE, SPECIFICO e VERIFICABILE con la vita, l'economia o la politica in Svizzera a livello nazionale o cantonale. Sono nessi reali: policy federale/cantonale, fiscalità (imposta federale diretta, IVA, imposte cantonali), AVS/LPP/LAMal, mercato del lavoro e salari svizzeri, costo della vita, affitti e casa, previdenza, economia e BNS, decisioni del Consiglio federale o dei Cantoni, accordi internazionali della Svizzera. NON è richiesto alcun nesso frontaliere/Ticino: un articolo nazionale (es. salario minimo cantonale, IVA, affitti) è PIENAMENTE rilevante.

   ${isEvergreen ? '' : 'NON sono nessi reali (segnala "critical" come "rilevanza_topica"): cronaca nera senza implicazione di policy/economia, eventi sportivi, gossip, intrattenimento, eventi esteri senza impatto sulla Svizzera.'}

   SEGNALE D'ALLARME (= "critical: rilevanza_topica"): forzare "implicazioni nazionali" su un evento che non ne ha, o riempire con consigli generici ("consulta un avvocato", "verifica la copertura assicurativa", "informati sui tuoi diritti") un argomento senza reale rilevanza nazionale, sono indicatori di forzatura.

   ${isEvergreen ? '' : "Se l'articolo è un commento generico attaccato a una notizia di cronaca SENZA alcun nesso di policy/economia/vita in Svizzera, il verdetto è FAIL — l'articolo non doveva essere generato."}`}

CRITERI DI GIUDIZIO:
- "critical" = fatto verificabilmente FALSO, o CONTRADDICE i fatti verificati di riferimento (legge inesistente, istituzione inventata, aliquota sbagliata, evento mai avvenuto, dato che contraddice la fonte)
- "major" = fatto sospetto non verificabile con certezza (percentuale senza fonte, dato plausibile ma non confermabile, informazione specifica aggiunta non presente nella fonte e non nei fatti verificati). Per evergreen, "non presente nella fonte" NON basta: serve falso/sospetto concreto.
- "minor" = imprecisione che non fuorvia il lettore (arrotondamento, data approssimata) O arricchimento contestuale con fatti di dominio noti e corretti (contesto frontaliere, informazioni generali sulla Svizzera/Ticino)
- FAIL = almeno 1 critical O almeno 3 major
- PASS = nessun fatto verificabilmente falso, al massimo minor e fino a 2 major

ATTENZIONE — ONERE DELLA PROVA. Le issue che segnali NON vengono solo lette: vengono reiniettate nel prompt di riscrittura come istruzioni correttive. Segnalare come "assente dalla fonte" un fatto che nella fonte C'È ordina all'autore di RIMUOVERE un fatto vero, e ripetuto su più tentativi produce un articolo che si allontana dalla fonte fino a inventare. Un falso positivo qui NON è prudenza: è la causa diretta di un articolo falso.

Quindi, PRIMA di scrivere una issue del tipo "non presente / non menzionato nella fonte":
1. RILEGGI la FONTE ORIGINALE qui sopra e cerca il fatto, anche riformulato o parafrasato.
2. Se lo trovi, NON segnalarlo. Un fatto ripreso dalla fonte, anche alla lettera, è corretto per definizione.
3. Se non lo trovi, compila "sourceQuote" con la porzione ESATTA di fonte più vicina al claim (o "" se la fonte non tratta affatto l'argomento). Le issue di questo tipo vengono verificate automaticamente contro il testo della fonte e SCARTATE se il claim risulta invece presente.

Resta vero il contrario: un fatto specifico che nella fonte NON c'è e che non è nei fatti verificati (istituzioni, statistiche precise, dichiarazioni, importi, date) va segnalato come "critical" senza esitazione. La severità si misura sull'evidenza, non sul dubbio.

${JSON_QUOTE_SAFETY_RULE_IT}

Rispondi SOLO in JSON valido:
{
  "verdict": "PASS" | "FAIL",
  "confidence": 0.0-1.0,
  "issues": [
    { "claim": "testo dell'affermazione", "reason": "perché è problematica", "severity": "critical|major|minor", "category": "categoria", "sourceQuote": "porzione esatta di fonte a supporto, o \"\" se la fonte non tratta l'argomento" }
  ]
}

Categorie valide: ${FACT_CHECK_CATEGORIES.join(', ')}`;

  // ── Multi-model consensus: query 2 models, require agreement ──
  // Order matters: the consensus pair is `verificationModels.slice(0, 2)`, so the
  // first two entries MUST span two independent providers. Previously both were
  // GitHub Models (GPT_4_1 + GPT4O) — when that free tier is down or emits
  // non-JSON (the common failure, 2026-06), BOTH primary queries fail in lockstep
  // every attempt, exhausting all FACTCHECK_INFRA_RETRIES before the lone Gemini
  // fallback runs. That inflated per-attempt wall time and was a primary driver of
  // the frontaliere section stall (#2675/#2672). Interleaving Gemini (Gemini API
  // free) into the pair makes a GitHub Models outage survivable on the first pass
  // and also strengthens consensus (two model families, not two OpenAI siblings).
  const verificationModels = [
    AI_MODELS.GPT_4_1,        // GitHub Models (OpenAI flagship)
    AI_MODELS.GEMINI_FLASH,   // Gemini API free — distinct provider → pair survives a GH Models outage
    AI_MODELS.GPT4O,          // GitHub Models — fallback when the primary pair yields nothing
  ].filter(Boolean);

  const modelResults = [];

  // Bounded retry on TRANSIENT checker-infrastructure failure (2026-06-15).
  // Observed waste: when all verifier models momentarily fail to PRODUCE a
  // verdict (rate-limit burst or "risposta non JSON"), the caller used to throw
  // → which regenerates the ENTIRE article (~60-90s) even though the article
  // itself may be perfectly fine. Re-running just the fact-check (~5s) is far
  // cheaper and the most common cause (non-JSON output) usually clears on a
  // second pass. The hard quality gate is preserved: if every attempt still
  // yields zero verdicts we throw exactly as before (never publish unverified).
  const FACTCHECK_INFRA_RETRIES = 3;
  // Cap on retry-after-derived backoff between outer fact-check attempts.
  // The per-model retry inside ai-models.mjs already honours the retry-after
  // header during its own loop; this cap guards the outer loop that fires when
  // ALL models have exhausted their per-model retries.
  const FACTCHECK_429_BACKOFF_CAP_MS = 30_000;
  let fcLastRejectMsgs = [];
  for (let fcAttempt = 1; fcAttempt <= FACTCHECK_INFRA_RETRIES && modelResults.length === 0; fcAttempt++) {
    if (fcAttempt > 1) {
      console.error(`  🔁 Fact-check: nessun verdetto al tentativo ${fcAttempt - 1} (checker giù/JSON invalido) — ri-eseguo solo la verifica (${fcAttempt}/${FACTCHECK_INFRA_RETRIES})...`);
      // If the previous attempt failed with 429 rate-limit errors, a 1500ms
      // wait won't clear the limit — read retry-after from the error body when
      // present, otherwise fall back to 10s. Always cap at 30s to avoid stall.
      const has429 = fcLastRejectMsgs.some(m => m.includes('429'));
      let backoffMs = 1500;
      if (has429) {
        let retryAfterMs = 10_000;
        for (const msg of fcLastRejectMsgs) {
          const m = msg.match(/"retry[_-]after"\s*:\s*(\d+)/i);
          if (m) retryAfterMs = Math.max(retryAfterMs, Number(m[1]) * 1000);
        }
        backoffMs = Math.min(retryAfterMs, FACTCHECK_429_BACKOFF_CAP_MS);
        console.error(`  ⏱️  Fact-check: 429 rate-limit rilevato — backoff ${backoffMs}ms (cap ${FACTCHECK_429_BACKOFF_CAP_MS}ms)`);
      }
      await new Promise(r => setTimeout(r, backoffMs));
    }
    fcLastRejectMsgs = [];

    // Query up to 2 models in parallel for consensus
    const modelsToQuery = verificationModels.slice(0, 2);
    const promises = modelsToQuery.map(model => _runSingleFactCheck(model, prompt, { isEvergreen }));
    const settled = await Promise.allSettled(promises);

    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      if (s.status === 'fulfilled' && s.value) {
        modelResults.push({ model: modelsToQuery[i], ...s.value });
      } else {
        const reason = s.status === 'rejected' ? s.reason?.message : 'no result';
        fcLastRejectMsgs.push(reason || '');
        console.error(`  ⚠️  LLM fact-check (${modelsToQuery[i]}): fallito — ${reason}`);
      }
    }

    // If both primary models failed, try fallback
    if (modelResults.length === 0 && verificationModels.length > 2) {
      try {
        const fallback = await _runSingleFactCheck(verificationModels[2], prompt, { isEvergreen });
        if (fallback) modelResults.push({ model: verificationModels[2], ...fallback });
      } catch (err) {
        fcLastRejectMsgs.push(err.message || '');
        console.error(`  ⚠️  LLM fact-check fallback (${verificationModels[2]}): ${err.message}`);
      }
    }
  }

  if (modelResults.length === 0) {
    // 2026-07-01 (#3138 follow-up) made this fail OPEN: on pure verifier-infra
    // unavailability it returned `passed: true` so a possibly-good article was
    // published rather than discarded, on the reasoning that prompt-level
    // anti-hallucination rules still applied.
    //
    // 2026-07-28 reversed that. "Published unverified" is indistinguishable, to
    // a reader, from "published verified" — and the article carries a named
    // byline. A verifier outage is our problem, not the reader's. The failure
    // mode we were avoiding (a discarded good article) costs one generation
    // slot; the one we were accepting (an unverified false article, live, in
    // four locales, under a journalist's name) costs the site's credibility.
    //
    // Fail CLOSED. The deterministic gates in article-factuality-gates.mjs
    // still run — they need no model and cannot be taken down — so an outage
    // degrades verification depth without ever publishing something unchecked.
    console.error('  🚫 LLM fact-check: TUTTI i modelli di verifica hanno fallito (rate-limit/infra) — articolo SCARTATO, mai pubblicato non verificato');
    return {
      passed: false,
      issues: [{
        claim: '(verifica non eseguita)',
        reason: 'Tutti i modelli di verifica non hanno prodotto un verdetto (rate-limit/infra) dopo '
          + `${FACTCHECK_INFRA_RETRIES} tentativi con backoff — l'articolo non è stato verificato`,
        severity: 'critical',
        category: 'infra',
      }],
      unverified: true,
    };
  }

  // ── Drop verdicts the source itself refutes ──
  //
  // Runs BEFORE consensus so a false "not in the source" cannot be promoted to
  // a blocking consensus critical (which is exactly what happened on
  // 2026-07-28: both models flagged the source's own opening sentence, the
  // article was blocked, and the rewrite loop then walked the draft away from
  // the source until it passed by inventing). See dropSourceContradictedIssues.
  if (!isEvergreen && sourceContent) {
    let droppedTotal = 0;
    for (const r of modelResults) {
      const { kept, dropped } = dropSourceContradictedIssues(r.issues, sourceContent);
      if (dropped.length) {
        droppedTotal += dropped.length;
        for (const d of dropped) {
          console.error(`  ✂️  Falso positivo scartato (${r.model}): "${(d.claim || '').slice(0, 70)}" `
            + '— il claim È presente nella fonte');
        }
      }
      r.issues = kept;
    }
    if (droppedTotal) {
      console.error(`  ✂️  ${droppedTotal} verdetti "assente dalla fonte" scartati perché contraddetti dalla fonte stessa`);
    }
  }

  // ── Consensus logic ──
  // Merge all critical/major issues across models, with two fixes:
  //
  // (Fix #2) Dedup by (category + normalized fact fingerprint), not by
  // claim-text first 60 chars. Different phrasings of the same fact must
  // collapse to one issue. Example:
  //   gpt-4.1: "Il prezzo medio del carburante in Ticino è di circa 1.80 CHF"
  //   gpt-4o:  "1.80 CHF/litro carburante medio Ticino non verificabile"
  //   → both `statistiche:num:1.80` → one issue, not two.
  //
  // (Fix #3) Weighted majors instead of raw count. Categories that LLM
  // cannot verify without web search (statistiche = specific numbers,
  // coerenza = generic phrasing concerns) weight 0.5; categories that
  // detect real falsehoods (leggi, persone, istituzioni, fatti_inventati,
  // date, aliquote, eu_svizzera, rilevanza_topica, geografia, …) weight
  // 1.0. Block at weighted sum ≥ 3.0. Critical issues still hard-block
  // ANY single occurrence — quality bar preserved.
  //
  // Measured impact on 2026-05-11 runs (25690785422, 25688066828): of 26
  // articles blocked at `≥3 major`, 16 were borderline 3-5 with the bulk
  // of majors in statistiche/coerenza. Under the weighted scheme those
  // pass with warning (numbers are noise, not falsehoods). Genuine
  // 3+ majors in high-trust categories still block.
  // Track per-model critical fingerprints BEFORE dedup so we can apply
  // consensus rules (true consensus = 2 models flag same fingerprint).
  // Pre-2026-05-18 the rule was "any single critical from any model → block"
  // which produced massive false positives: each model nitpicks 1 different
  // thing → 6 retries × 6 models all blocked by 1 isolated critical each.
  // New rule:
  //   - critical seen by ≥2 models (true consensus) → ALWAYS block
  //   - ≥2 critical from a single model in high-trust categories → block
  //   - single isolated critical → downgrade to major+warning (not blocking)
  // Quality bar preserved for genuine falsehoods (which both fact-checkers
  // tend to agree on) while letting through contextual enrichments that
  // only one model flagged as inventato.
  const HIGH_TRUST_CRITICAL_CATEGORIES = new Set([
    'leggi', 'persone', 'istituzioni', 'fatti_inventati',
    'date', 'aliquote', 'eu_svizzera', 'geografia',
  ]);

  const perModelCriticalFingerprints = modelResults.map(r => {
    const fps = new Set();
    for (const issue of r.issues) {
      if (issue.severity === 'critical') fps.add(factCheckFingerprint(issue));
    }
    return fps;
  });

  const allCritical = [];
  const allMajor = [];
  const seenFingerprints = new Set();

  for (const r of modelResults) {
    for (const issue of r.issues) {
      const fp = factCheckFingerprint(issue);
      if (seenFingerprints.has(fp)) continue;
      seenFingerprints.add(fp);

      if (issue.severity === 'critical') allCritical.push({ ...issue, _fingerprint: fp });
      else if (issue.severity === 'major') allMajor.push(issue);
    }
  }

  // Log per-model results
  for (const r of modelResults) {
    console.error(`  🔍 LLM fact-check (${r.model}): verdict=${r.verdict} confidence=${r.confidence.toFixed(2)} issues=${r.issues.length} (critical=${r.issues.filter(i => i.severity === 'critical').length}, major=${r.issues.filter(i => i.severity === 'major').length})`);
    for (const issue of r.issues) {
      console.error(`     ${issue.severity === 'critical' ? '🚨' : '⚠️'}  [${issue.category || '?'}] "${(issue.claim || '').slice(0, 80)}" — ${(issue.reason || '').slice(0, 100)}`);
    }
  }

  // BLOCKING rule 1: true cross-model consensus on a critical → always block.
  const consensusCriticals = allCritical.filter(issue =>
    perModelCriticalFingerprints.filter(fps => fps.has(issue._fingerprint)).length >= 2,
  );
  if (consensusCriticals.length > 0) {
    console.error(`  🚨 Consensus criticals (≥2 modelli): ${consensusCriticals.length} — BLOCCATO`);
    return { passed: false, issues: consensusCriticals };
  }

  // BLOCKING rule 2: 2+ critical from any single model in HIGH-TRUST categories.
  for (const r of modelResults) {
    const highTrustCritsFromThisModel = r.issues.filter(i =>
      i.severity === 'critical' && HIGH_TRUST_CRITICAL_CATEGORIES.has((i.category || '').toLowerCase()),
    );
    if (highTrustCritsFromThisModel.length >= 2) {
      console.error(`  🚨 ${highTrustCritsFromThisModel.length} critical high-trust da ${r.model} — BLOCCATO`);
      return { passed: false, issues: highTrustCritsFromThisModel };
    }
  }

  // Isolated single critical → demote to major+warning. Article passes the
  // critical gate; the weighted-major rule below still catches accumulations.
  if (allCritical.length > 0) {
    console.error(`  ⚠️  ${allCritical.length} critical isolato (1 modello, non consenso) — declassato a warning, articolo procede`);
    for (const issue of allCritical) allMajor.push({ ...issue, severity: 'major' });
  }

  // BLOCKING: weighted major score >= MAJOR_BLOCK_WEIGHT_THRESHOLD
  const majorScore = totalMajorWeight(allMajor);
  if (majorScore >= MAJOR_BLOCK_WEIGHT_THRESHOLD) {
    console.error(`  🚨 Consensus: ${allMajor.length} major issues (peso=${majorScore.toFixed(1)} ≥ ${MAJOR_BLOCK_WEIGHT_THRESHOLD.toFixed(1)}) — BLOCCATO`);
    return { passed: false, issues: allMajor };
  }

  // If only 1 model ran and it said FAIL with low confidence, still block
  if (modelResults.length === 1 && modelResults[0].verdict === 'FAIL') {
    const r = modelResults[0];
    if (r.confidence >= 0.5 && (r.issues.filter(i => i.severity !== 'minor').length > 0)) {
      console.error(`  ⚠️  Single-model FAIL (${r.model}, confidence=${r.confidence.toFixed(2)}) — BLOCCATO per precauzione`);
      return { passed: false, issues: r.issues.filter(i => i.severity !== 'minor') };
    }
  }

  // Warn if there are major issues but not enough to block
  if (allMajor.length > 0) {
    console.error(`  ⚠️  Consensus: ${allMajor.length} major issue(s) (peso=${majorScore.toFixed(1)}) — accettato con warning`);
  }

  return { passed: true, issues: [...allCritical, ...allMajor] };
}

/**
 * Run a single fact-check against one model. Returns parsed result or null.
 */
function issueLooksAffirmative(issue) {
  const reason = String(issue?.reason || '').toLowerCase();
  if (!reason) return false;
  const confirms = /\b(corretto|corretta|corretti|corrette|conferm|risulta vero|è vero|in linea|coerente|accurat)\b/i.test(reason);
  if (!confirms) return false;
  return !/\b(ma|però|tuttavia|non|manca|senza|sbagliat|errat|fals|inesatt|fuorviante|contraddic|non specifica|non conferma)\b/i.test(reason);
}

function normalizeFactCheckIssues(issues, { isEvergreen = false } = {}) {
  if (!Array.isArray(issues)) return [];
  return issues.flatMap((issue) => {
    if (!issue || typeof issue !== 'object') return [];
    const reason = String(issue.reason || '').toLowerCase();
    if (issueLooksAffirmative(issue)) return [];
    if (
      isEvergreen
      && issue.severity === 'major'
      && /\b(non (è|e')? presente nella fonte|non (è|e')? stato trovato nella fonte|non compare nella fonte|fonte originale)\b/i.test(reason)
      && !/\b(falso|sbagliat|errat|inesatt|inventat|inesistent|contraddic|non esist)\b/i.test(reason)
    ) {
      return [{ ...issue, severity: 'minor' }];
    }
    return [issue];
  });
}

async function _runSingleFactCheck(model, prompt, opts = {}) {
  const modelUsedRef = { model: null };
  const raw = await _aiCallLLM(
    [{ role: 'user', content: prompt }],
    // Fact-check output is a compact JSON issues list (rarely >1500 tokens).
    // 60s is ample for any responsive model; a checker that hasn't replied in
    // 60s is stalled — fail over fast instead of burning the old 120s budget.
    // bypassForceChain:true — the verification models are the real quality gate
    // and must stay independent of AI_MODELS_FORCE_CHAIN. Without this, forcing
    // generation onto the local model would also force the checker onto it
    // (the model grading itself), so a forced run could publish unchecked content.
    // cache — see buildFactCheckCallOptions() above: DEFAULT ON (kill switch
    // via CREATE_ARTICLE_FACTCHECK_CACHE=0), preserving the production
    // `cache: true` this call already had.
    buildFactCheckCallOptions({ model, temperature: 0.0, maxTokens: 4000, timeout: 60_000, bypassForceChain: true, modelUsedRef })
  );
  // Guard: if the full remote cascade is exhausted, callLLM falls through to
  // local/fallback — the same model that may have generated the content.
  // Self-verification (local grading local) produces circular self-consensus
  // and cannot catch fabricated facts. Defer rather than publish (Non-Negotiable #1).
  //
  // NOT extended to omniroute/auto (2026-07-28 tier-reorder review, T1): local
  // is a single fixed deterministic model, so "checker fell back to local" is
  // a provable guaranteed-same-model risk. omniroute/auto fans out across its
  // own ~78-100+ registered upstream providers per-call under one "auto" id —
  // there's no confirmed evidence it would repeat the exact same underlying
  // model for a generation call and a same-run fact-check call, so treating it
  // as an equivalent self-consensus risk would itself be an unverified
  // assumption. Left as-is deliberately; revisit if OmniRoute's routing
  // behavior is ever characterized (e.g. sticky-provider-per-window).
  if (modelUsedRef.model === AI_MODELS.LOCAL_FALLBACK) {
    throw new Error(`fact-check deferred: all remote verifiers exhausted — local/fallback cannot self-verify (requested: ${model})`);
  }

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error(`  ⚠️  LLM fact-check (${model}): risposta non JSON`);
    return null;
  }

  let result;
  try {
    result = JSON.parse(jsonMatch[0]);
  } catch {
    console.error(`  ⚠️  LLM fact-check (${model}): JSON non valido`);
    return null;
  }

  const verdict = (result.verdict || '').toUpperCase();
  const confidence = Number(result.confidence) || 0;
  const issues = normalizeFactCheckIssues(result.issues, opts);

  return { verdict, confidence, issues };
}

// assertNoFabricatedStatistics() REMOVED — replaced by LLM-based fact-checking.
// The LLM understands context ("73,2% dei frontalieri" is likely fabricated vs
// "5,3% AVS" is a real rate) far better than regex pattern matching.

// ── LLM JSON repair (handles common LLM output quirks) ────────────────
// Why: GitHub Models / Groq / Mistral occasionally emit markdown bold
// markers (`**` / `***`) between JSON properties instead of commas, or
// wrap the payload in ```json fences, or stick a preamble before the
// opening `{`, or echo a quoted phrase from the source text unescaped
// (e.g. a title like `..."tassa sulla salute"...`) which desyncs naive
// quote-toggle string tracking into `Unterminated string in JSON`. The
// string-repair walk (preserve asterisks INSIDE quoted strings — markdown
// bold in body1/body2 is load-bearing — replace stray `*` OUTSIDE strings
// with a comma, escape unescaped inner quotes) lives in
// ./lib/llm-json-repair.mjs, shared with batch-add-faq-to-articles.mjs's
// repairJsonArray. Truncated payloads still throw — callers detect that
// via `parseErr.message` and retry with a larger `maxTokens`.
function repairLlmJson(raw) {
  let c = stripCodeFences(raw);
  const start = c.indexOf('{');
  if (start !== -1) {
    // Bracket-balanced extraction (mirrors repairJsonArray in batch-add-faq-to-articles.mjs)
    // so trailing LLM prose or a foreign '}' from an interior nested object does not
    // pull in the wrong boundary via lastIndexOf. Falls back to lastIndexOf when
    // findMatchingClose returns -1 (e.g. raw truncated inside a string literal).
    const closeIdx = findMatchingClose(c, start, true);
    if (closeIdx !== -1) {
      c = c.slice(start, closeIdx + 1);
    } else {
      const end = c.lastIndexOf('}');
      if (end > start) c = c.slice(start, end + 1);
    }
  }
  const out = fixJsonStringBody(c, { fixAsterisks: true });
  return out.replace(/,(\s*,)+/g, ',').replace(/,(\s*[}\]])/g, '$1');
}

// ── LLM call with body2 validation (model fallback via centralized ai-models.mjs) ──
async function callLLM(messages, opts = {}) {
  const maxBody2Retries = 5;
  // Require ALL body/title/excerpt field names present (not just 'body2') so this
  // only fires for the actual full-article generation prompt (which lists every
  // REQUIRED_IT_BODY_FIELDS name together, see the "content.${primaryLocale}
  // (title, excerpt, body1, body2, body3, faq)" instruction). A bare 'body2'
  // substring also matches translateBodyField's single-field translation calls
  // (prompt/schema `{"body2": "..."}`), where `missing` is guaranteed non-empty
  // (title/excerpt/body1/body3 are never in that payload) regardless of
  // translation quality — the retry-exhaustion path now throws instead of
  // falling through, which used to ship the (valid) translated JSON anyway but
  // would now discard it and ship IT-language content under /en /de /fr.
  const isBody2Check = opts.jsonMode && REQUIRED_IT_BODY_FIELDS.every(f => messages.some(m => m.content?.includes(f)));
  for (let attempt = 1; attempt <= maxBody2Retries; attempt++) {
    const modelUsedRef = { model: null };
    // Default per-call ceiling 90s (was 120s, 2026-06-15). 90s still comfortably
    // covers a legit large generation (≤8000 tokens) on any responsive free-tier
    // model; it only abandons true hangs ~30s sooner. Callers that need more pass
    // an explicit `timeout` via opts (it wins over this default through ...opts).
    //
    // deadlineMs (2026-07-02): apply the same RUN_WALL_BUDGET_MS the outer
    // headline-retry loop already enforces (see wallBudgetExceeded()) *inside*
    // the model cascade walk too — otherwise a single callLLM() invocation can
    // burn most of the budget internally (walking the whole ~180-model chain
    // across up to 5 body2-validation retries) before the outer between-attempt
    // check ever gets a chance to run. See run 28611052353 (109min, single
    // attempt consumed nearly all of it). ...opts still wins if a caller passes
    // its own deadlineMs (or explicit null to opt out of the cap entirely).
    const result = await _aiCallLLM(messages, { temperature: 0.7, maxTokens: 4000, timeout: 90_000, deadlineMs: RUN_START_MS + RUN_WALL_BUDGET_MS, ...opts, modelUsedRef });
    if (modelUsedRef.model === AI_MODELS.LOCAL_FALLBACK) _localFallbackUsedThisHeadline = true;
    if (isBody2Check) {
      let itContent = null;
      let parseErr = null;
      let repaired = null;
      try {
        repaired = repairLlmJson(result);
        const parsed = JSON.parse(repaired);
        itContent = normalizeItalianContentFromPayload(parsed);
      } catch (e) {
        parseErr = e;
        itContent = null;
      }

      const missing = [];
      if (!itContent) {
        missing.push('content.it non normalizzabile');
        // Previously swallowed silently — every "non normalizzabile" failure
        // was unreproducible (no evidence of what the model actually sent).
        // Log the parse error + a snippet so a recurring malformed-JSON
        // pattern from a specific model can actually be root-caused.
        if (parseErr) {
          console.error(`  🔎 JSON parse fallito (${modelUsedRef.model || 'unknown'}): ${parseErr.message} — ${describeJsonParseError(repaired, parseErr)}`);
          console.error(`  📄 ${describeRawForDiagnostics(result)}`);
        }
      } else {
        for (const field of REQUIRED_IT_BODY_FIELDS) {
          if (!itContent?.[field] || itContent[field].length < 1) {
            missing.push(field);
          }
        }
        if (itContent.body2 && itContent.body2.trim().length < 40) missing.push('body2<40');
        // Language sanity — fallback models occasionally drift to CJK /
        // Cyrillic when prompted in Italian. Treat as malformed output:
        // penalises the model, chain rotates, no budget burned at the
        // outer headline-validation layer. See run 26446721285.
        for (const field of ['title', 'excerpt', 'body1', 'body2', 'body3']) {
          const val = itContent?.[field];
          if (typeof val === 'string' && val.length > 0 && isNonItalianScript(val)) {
            const ratio = (nonItalianScriptRatio(val) * 100).toFixed(0);
            missing.push(`${field} non-IT script (${ratio}% non-Latin)`);
          }
        }
      }

      if (missing.length > 0) {
        console.error(`  ⚠️  output JSON incompleto: ${missing.join(', ')} (tentativo ${attempt}/${maxBody2Retries}) — rigenero...`);
        // Penalize the model only for genuine content failures, not budget-induced
        // exits. When wallBudgetExceeded() is true the throw below is caused by
        // time pressure, not by model output quality; scoring it as a failure would
        // bias Firestore ai_model_scores against a model that may be perfectly fine.
        if (!wallBudgetExceeded()) {
          recordModelContentFailure(modelUsedRef.model);
        }
        // Bail out of this retry budget the moment the run-wide wall-clock
        // deadline is gone, instead of blindly looping to maxBody2Retries.
        // When every remote model is already exhausted, each retry here
        // re-invokes local/fallback's ~6-10min CPU inference — 5 blind
        // retries can burn the entire run budget on one unreliable model,
        // leaving the outer model-rotation loop (callGemini's
        // CREATE_ARTICLE_MIN_WORDS_RETRIES) zero real chance to try anything.
        // Failing fast here instead preserves whatever budget is left for it.
        if (attempt < maxBody2Retries && !wallBudgetExceeded()) continue;
        // Do NOT fall through to `return result` below — that would ship the
        // still-invalid payload (e.g. CJK/Cyrillic-drifted content.it, see
        // isNonItalianScript above) straight to the indexed blog on the very
        // first attempt whenever the budget is already gone, instead of only
        // after maxBody2Retries genuinely-exhausted tries. Throw so the caller
        // falls back to the next model in the chain (or the outer safety net)
        // instead of publishing malformed/wrong-language content.
        // qualityReject=true: this is a content-quality failure (malformed JSON,
        // CJK/Cyrillic drift, missing fields), not an infrastructure error.
        // Without the flag the outer ranker loop (isQualityRejectError check) treats
        // it as infrastructure and crashes the whole run instead of gracefully
        // skipping to the next headline.
        const _bodyErr = new Error(`Output JSON incompleto (tentativo ${attempt}/${maxBody2Retries}${wallBudgetExceeded() ? ', budget esaurito' : ''}): ${missing.join(', ')}`);
        _bodyErr.qualityReject = true;
        throw _bodyErr;
      } else {
        recordModelContentSuccess(modelUsedRef.model);
      }
    }
    return result;
  }
  // qualityReject=true: same class as above — exhausted retries without a valid
  // body2 payload is a per-headline quality failure, not an infrastructure crash.
  const _exhaustedErr = new Error(`Output JSON non valido dopo ${maxBody2Retries} tentativi con validazione jsonMode`);
  _exhaustedErr.qualityReject = true;
  throw _exhaustedErr;
}

/** Convert article id like "tassa-salute-ticino" to camelCase slug key "blogTassaSaluteTicino" */
function idToSlugKey(id) {
  const camel = id.replace(/-(\w)/g, (_, c) => c.toUpperCase());
  return 'blog' + camel.charAt(0).toUpperCase() + camel.slice(1);
}

// ── Stats-BFS prompt builder ────────────────────────────────
// Reads the freshly-written config/bfs_stats Firestore doc and turns the
// numbers into a structured prompt the LLM can summarise. Triggered by the
// refresh-bfs-stats workflow whenever a new BFS quarter (e.g. 2026-Q1) goes
// live, so the editorial team automatically publishes a Ticino frontalieri
// trend article every ~3 months in the same voice as the rest of the blog.
async function buildStatsBfsPromptContent(quarter) {
  const adminMod = await import('firebase-admin');
  const admin = adminMod.default || adminMod;
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: process.env.GCLOUD_PROJECT || 'frontaliere-ticino',
    });
  }
  const db = admin.firestore();
  const snap = await db.collection('config').doc('bfs_stats').get();
  if (!snap.exists) {
    throw new Error('config/bfs_stats Firestore doc missing — refresh-bfs-stats has not run yet.');
  }
  return formatStatsBfsPrompt(quarter, snap.data() || {});
}

/**
 * PURA: il documento `config/bfs_stats` → il testo del prompt. Separata da
 * buildStatsBfsPromptContent() perché quella metà è tutta I/O (firebase-admin,
 * credenziali, rete) e non è verificabile in CI, mentre QUESTA è l'unica che
 * decide cosa il fact-checker considererà "un fatto della fonte".
 *
 * ## Perché il testo di questo prompt è materia da gate, non da prosa
 *
 * `extractSourceAnchors()` (article-factuality-gates.mjs) raccoglie come ANCORA
 * OBBLIGATORIA ogni `\d[\d.,]*\s*%` che compare nel SOURCE CONTENT — e per
 * `stats-bfs://` il SOURCE CONTENT è questa stringa, istruzioni editoriali
 * comprese. Due difetti ne discendevano, entrambi misurati sul trimestre
 * 2026-Q2 (valerielinc-ops#5341, sei tentativi, zero articoli):
 *
 *  1. **Un'ancora strutturalmente impossibile.** La riga di istruzione «se
 *     sotto ±0.3% "stabile"» faceva nascere `pct:0.3`: una soglia redazionale
 *     che nessun articolo scriverà mai, permanentemente nel denominatore di
 *     `source-fidelity-low` e permanentemente fuori dal numeratore. È la stessa
 *     classe di difetto che il commento di `extractSourceAnchors` documenta per
 *     gli acronimi (ARTICOLO, SEO, VALIDI presi dall'intestazione del prompt) —
 *     lì risolta con una allow-list, qui risolvibile solo non scrivendo la
 *     percentuale. La direzione del trend è già calcolata e dichiarata sopra:
 *     al writer serve la parola, non la soglia.
 *  2. **La forma decimale sbagliata.** `matchedAnchors()` accredita SOLO la
 *     virgola (`0,64%`), mentre `toFixed(2)` e i `pct` di Firestore producono
 *     il punto (`0.64`). Il writer copiava fedelmente dalla fonte e falliva
 *     lo stesso il gate che gli chiedeva quel numero — l'identico difetto già
 *     chiuso in `renderAnchorForPrompt`, qui rimasto aperto a monte.
 *
 * Terza correzione, sulla qualità e non sui gate: l'articolo 2026-Q1
 * (`frontalieri-ticino-stabili-2026-q1`) contiene cifre per Lugano, Chiasso,
 * Mendrisio, Bellinzona e Locarno che il dataset BFS **non contiene** — sono
 * inventate, e sono uscite agli iscritti. Il divieto ora nomina il caso invece
 * di affidarlo a un generico "non inventare".
 */
function formatStatsBfsPrompt(quarter, data) {
  const trend = Array.isArray(data.trend) ? data.trend : [];
  if (trend.length === 0) {
    throw new Error('Empty trend in config/bfs_stats Firestore doc.');
  }

  const findValue = (q) => trend.find((p) => p.year === q)?.frontalieri ?? null;
  const latest = findValue(quarter) ?? trend[trend.length - 1].frontalieri;
  const latestQuarter = findValue(quarter) != null ? quarter : trend[trend.length - 1].year;
  const latestIdx = trend.findIndex((p) => p.year === latestQuarter);
  const prevPoint = latestIdx > 0 ? trend[latestIdx - 1] : null;
  const yearMatch = String(latestQuarter).match(/^(\d{4})-Q([1-4])$/);
  const yoyKey = yearMatch ? `${Number(yearMatch[1]) - 1}-Q${yearMatch[2]}` : null;
  const yoyValue = yoyKey ? findValue(yoyKey) : null;

  const fmt = (n) => Number(n).toLocaleString('it-IT');
  const sign = (n) => (n >= 0 ? '+' : '');
  // Virgola decimale, sempre: è la sola forma che `matchedAnchors()` accredita.
  // Scrivere qui il punto significa chiedere al writer un numero che il gate
  // non riconoscerà mai — vedi il punto 2 del commento sopra.
  const pctIt = (n, digits = 2) => `${sign(n)}${Number(n).toFixed(digits).replace('.', ',')}%`;
  const qoqAbs = prevPoint ? latest - prevPoint.frontalieri : null;
  const qoqPct = prevPoint ? ((latest - prevPoint.frontalieri) / prevPoint.frontalieri) * 100 : null;
  const yoyAbs = yoyValue != null ? latest - yoyValue : null;
  const yoyPct = yoyValue != null && yoyValue > 0 ? ((latest - yoyValue) / yoyValue) * 100 : null;

  const trendTable = trend.slice(-8).map((p) => `| ${p.year} | ${fmt(p.frontalieri)} |`).join('\n');
  const ages = Array.isArray(data.ages) ? data.ages : [];
  const ageTable = ages.map((a) => `- ${a.name}: ${fmt(a.value)}`).join('\n');
  const gender = Array.isArray(data.genderSnapshot) ? data.genderSnapshot : [];
  // g.pct arriva da Firestore senza garanzia di forma: mancante, non numerico, o
  // una stringa già mal formattata (es. "12.3.4") che `String().replace('.', ',')`
  // trasformerebbe in "12,3.4%" — testo che matcha ancora il pattern digit-led di
  // `extractSourceAnchors` ma che `parseItalianNumber` non sa risolvere, producendo
  // l'ancora impossibile `pct:NaN` (nessun testo la soddisfa mai). Un pct non
  // finito qui non genera affatto la percentuale, invece di generarne una rotta.
  const genderPct = (g) => {
    // `Number('')`, `Number('   ')` e `Number([])` valgono 0 ed `Number.isFinite(0)`
    // e' true: senza questo guard un pct assente/vuoto pubblicherebbe uno "0%"
    // fabbricato, indistinguibile da uno zero reale.
    const raw = String(g.pct ?? '').trim();
    if (raw === '') return null;
    const n = Number(raw.replace(',', '.'));
    return Number.isFinite(n) ? `${n.toString().replace('.', ',')}%` : null;
  };
  const genderLine = gender
    .map((g) => {
      const pct = genderPct(g);
      return `${g.name}${pct ? ` ${pct}` : ''} (${fmt(g.value)})`;
    })
    .join(' · ');

  const trendDirection = qoqPct == null
    ? 'stabile'
    : qoqPct > 0.3 ? 'in crescita'
    : qoqPct < -0.3 ? 'in calo'
    : 'stabile';

  // Il target di lunghezza dichiarato al writer, deliberatamente SOPRA la
  // soglia che il gate applica (CREATE_ARTICLE_MIN_IT_WORDS_FLOOR, 400 — vedi
  // `lengthBudgetSource` in generateAndValidateArticle): il gate non deve
  // essere il vincolo che morde, altrimenti ogni trimestre si gioca sul filo.
  // Non è agganciato al valore calcolato perché la soglia adattiva dipende
  // dalla lunghezza del SOURCE CONTENT, che qui è questo stesso testo: un
  // numero derivato cambierebbe da solo a ogni riga aggiunta al prompt.
  // `stats-bfs-prompt.test.mjs` tiene i due estremi allineati.
  const MIN_STATS_BFS_IT_WORDS = 550;

  // L'elenco letterale che il writer deve riprodurre. È lo STESSO insieme che
  // `extractSourceAnchors()` estrarrà da questo testo: costruirlo qui, invece
  // di sperare che il writer le ritrovi sparse nel prompt, è ciò che rende
  // l'istruzione e il controllo la stessa cosa.
  const requiredPcts = [
    qoqPct != null ? pctIt(qoqPct) : '',
    yoyPct != null ? pctIt(yoyPct) : '',
    ...gender.map(genderPct),
  ].filter(Boolean);

  return [
    '[ARTICOLO DATI BFS STATISTICA FRONTALIERI TICINO]',
    `Trimestre appena pubblicato dall'Ufficio Federale di Statistica (BFS): ${latestQuarter}`,
    `Tendenza vs trimestre precedente (${prevPoint?.year || 'n/d'}): ${trendDirection}.`,
    '',
    '=== DATI VERIFICATI (usare ESATTAMENTE questi numeri, non inventarne altri) ===',
    `- Frontalieri totali Canton Ticino al ${latestQuarter}: ${fmt(latest)}`,
    prevPoint ? `- Trimestre precedente (${prevPoint.year}): ${fmt(prevPoint.frontalieri)} (variazione QoQ ${sign(qoqAbs)}${fmt(qoqAbs)} unità, ${pctIt(qoqPct)})` : '',
    yoyValue != null ? `- Stesso trimestre anno precedente (${yoyKey}): ${fmt(yoyValue)} (variazione YoY ${sign(yoyAbs)}${fmt(yoyAbs)} unità, ${pctIt(yoyPct)})` : '',
    '',
    '=== SERIE STORICA (ultimi 8 trimestri) ===',
    '| Trimestre | Frontalieri Ticino |',
    '|-----------|-------------------:|',
    trendTable,
    '',
    ages.length ? '=== DISTRIBUZIONE PER ETÀ (trimestre corrente) ===' : '',
    ageTable,
    '',
    gender.length ? `=== RIPARTIZIONE PER GENERE (trimestre corrente) ===\n${genderLine}` : '',
    '',
    '=== ANGOLO EDITORIALE RICHIESTO ===',
    `Stile: cronaca dati come https://comozero.it/attualita/statistiche-frontalieri-ticino-svizzera-primo-trimestre-2026/.`,
    // «settori se inferibili dai trend storici» invitava esattamente
    // l'invenzione che il divieto più sotto chiude: la serie storica è un solo
    // totale per trimestre, da cui nessun settore è inferibile.
    'Lead di 2-3 frasi con il numero principale e la variazione. Poi sezioni separate per: confronto con il trimestre precedente, confronto YoY, distribuzione per età, ripartizione per genere, contesto ticinese (lettura qualitativa della serie storica qui sopra e accordo Italia-Svizzera 2026, senza cifre che non siano in questo prompt).',
    'Tono giornalistico-istituzionale italiano, non opinionistico. Usa formulazioni neutre tipo "i dati BFS indicano…", "secondo l\'Ufficio Federale di Statistica…", "la statistica trimestrale registra…".',
    // La soglia dura sulle parole (CREATE_ARTICLE_MIN_IT_WORDS) vale anche qui,
    // ma la REGOLA EDITORIALE generica dice al writer «meglio un articolo da
    // 400 parole onesto che 1200 di forzatura» — e su una fonte sintetica come
    // questa la prende alla lettera. Misurato sul 2026-Q2: sei tentativi fra
    // 136 e 297 parole, tre dei quali avevano superato TUTTI i gate di
    // fedeltà e sono stati scartati solo per lunghezza. La contraddizione si
    // scioglie dicendo QUALE materiale, già presente e già verificato, riempie
    // le parole richieste — non chiedendo semplicemente "scrivi di più".
    `Lunghezza: body1+body2+body3 devono superare complessivamente le ${MIN_STATS_BFS_IT_WORDS} parole. Il materiale per arrivarci è tutto qui sopra e non va inventato: gli otto trimestri della serie storica (massimo e minimo del periodo, dove la curva ha girato), le fasce d'età (quali pesano di più, dov'è il baricentro anagrafico), la ripartizione per genere, il doppio confronto con il trimestre precedente e con lo stesso trimestre dell'anno prima. Commentali uno per uno: sono cinque blocchi di analisi, non una riga di riassunto ciascuno.`,
    'Ripartizione dei tre corpi: body1 = il totale del trimestre e i due confronti; body2 = lettura della serie storica e della composizione per età e genere, cioè come sta cambiando il bacino dei frontalieri; body3 = che cosa comporta per chi lavora o cerca lavoro in Ticino, in termini qualitativi, più la CTA agli strumenti del sito. Nessuno dei tre deve ripetere gli altri.',
    // NESSUNA soglia numerica qui: scriverla farebbe di `0,3%` un fatto della
    // fonte che l'articolo dovrebbe citare. La direzione è già decisa sopra.
    `Il trimestre va qualificato come "${trendDirection}" nel titolo e nel lead: la direzione è già stata calcolata, non ricavarla di nuovo e non contraddirla.`,
    requiredPcts.length
      ? `OBBLIGATORIO — cita nel corpo, alla lettera e ciascuna accanto al dato che spiega, TUTTE queste percentuali: ${requiredPcts.join(' · ')}. Copiale con la virgola decimale esattamente come sono scritte qui: un controllo automatico di fedeltà alla fonte le cerca letterali e rifiuta l'articolo se ne mancano. Ometterle "per prudenza" è il modo più rapido di far scartare il pezzo.`
      : '',
    'Non introdurre percentuali DIVERSE da quelle elencate qui sopra: quelle vanno riportate tutte, le altre non esistono.',
    'I dati BFS forniti sono TUTTI i dati disponibili. Non contengono alcuna disaggregazione per comune, per settore economico o per azienda: NON scrivere cifre riferite a Lugano, Chiasso, Mendrisio, Bellinzona, Locarno o a qualunque altro comune, né a singoli settori. L\'edizione del trimestre precedente ne conteneva ed erano inventate. Se un dettaglio non è nell\'elenco sopra, ometti.',
    `Includi link interno alla dashboard /statistiche/ ("vedi i grafici aggiornati") e alla pagina /calcola-stipendio/ (CTA finale).`,
    `Fonte da citare: Ufficio Federale di Statistica (BFS), tabella DF_GGS_6 — link https://www.bfs.admin.ch/bfs/it/home/statistiche/industria-servizi.html`,
  ].filter(Boolean).join('\n');
}

// ── Step 1: Fetch web page content ──────────────────────────
// Publication date of the source page most recently fetched, ISO or ''.
// fetchPageContent() returns a bare string and has a single call site per
// article, so a module-level handoff keeps the change local instead of
// reshaping a return type threaded through the whole generation path.
let lastSourcePublishedAt = '';

async function fetchPageContent(url) {
  // Clear FIRST, unconditionally, before any early return.
  //
  // main() calls generateAndValidateArticle() several times in one process:
  // Fase 1 retries across real-URL headlines and, on exhaustion, falls through
  // to the Fase 2 evergreen fallback. Without this reset a Fase-1 source date
  // (the incident source was 184 days old) would still be set when the
  // evergreen article — which has no source at all — reaches the freshness
  // gate, where anything past 90 days is a blocking `stale-source`. That would
  // spuriously reject innocent evergreen articles, the exact failure mode of
  // issue #2947 ("the frontaliere evergreen path produced ~0 articles/run").
  //
  // Same reasoning as the `_localFallbackUsedThisHeadline` reset in
  // generateAndValidateArticle(): per-headline state must not leak forward.
  lastSourcePublishedAt = '';

  // Handle BFS stats-update articles — no web page to scrape, build the
  // prompt from Firestore numbers written by refresh-bfs-stats.
  if (url.startsWith('stats-bfs://')) {
    const quarter = decodeURIComponent(url.slice('stats-bfs://'.length));
    console.error(`📊 Articolo statistica BFS: trimestre ${quarter}`);
    return await buildStatsBfsPromptContent(quarter);
  }
  // Handle evergreen topics — no URL to fetch, use keyword angle as content.
  //
  // Evergreen articles have NO real news source, so the synthetic prompt below
  // IS the article's only "SOURCE CONTENT". Historically it told the model to
  // "use only verified, stable facts" WITHOUT supplying any — so free-tier
  // models filled the gap from training data and routinely hallucinated the
  // stable cross-border facts (imposta alla fonte location, accordo dates,
  // franchigia, 20km threshold, transitional period). The fact-checker, which
  // DOES carry VERIFIED_DOMAIN_FACTS as ground truth, then blocked every such
  // article on consensus criticals → the frontaliere evergreen path produced
  // ~0 articles/run for days (issue #2947: frontaliere cadence collapsed while
  // svizzera — mostly real-news, already source-grounded — kept producing).
  //
  // Fix: feed a COMPACT verified-facts brief into the generation prompt.
  // REGOLA #1 ("ogni fatto DEVE essere presente nel SOURCE CONTENT") then works
  // FOR convergence instead of against it: the model rewrites from the exact
  // values the fact-checker validates against. No gate is lowered. The brief is
  // deliberately compact (EVERGREEN_FACTS_BRIEF) so the assembled first-attempt
  // prompt measures estTokens=7215, under the 8000-token model input cap — see
  // the constant's note for the measurement.
  if (url.startsWith('evergreen://')) {
    const keyword = process.env._EVERGREEN_KEYWORD || decodeURIComponent(url.replace('evergreen://', ''));
    const angle = process.env._EVERGREEN_ANGLE || '';
    console.error(`📚 Articolo evergreen: "${keyword}"`);
    // Section-aware (#96). Il dominio dichiarato al writer e il ground truth
    // che riceve devono essere LO STESSO dominio: dire «sezione svizzera
    // nazionale» e poi allegare i fatti frontalieri e' la contraddizione che
    // ha prosciugato la sezione.
    const domainLine = IS_FRONTALIERE
      ? 'Usa solo fatti verificati e stabili sul dominio frontalieri Ticino-Italia.'
      : 'Usa solo fatti verificati e stabili sul dominio svizzero a scala nazionale/cantonale (fiscalità, previdenza, lavoro, alloggio, permessi, istituzioni federali). NON restringere al Ticino né al caso frontaliere.';
    return `[ARTICOLO EVERGREEN SEO]\nKeyword target: ${keyword}\nAngolo editoriale: ${angle}\n\nGenera un articolo approfondito e pratico ottimizzato per questa keyword long-tail. ${domainLine} Se servono esempi, presentali come scenari ipotetici, senza nomi, aziende, città o importi specifici inventati.\n\n${evergreenFactsBriefFor(SECTION_NAME)}\n\n⚠️ I FATTI VERIFICATI qui sopra DEVONO corrispondere ESATTAMENTE (lo stesso ground truth è usato dal fact-checker, che blocca l'articolo se diverghi). Per dettagli NON coperti, attieniti a nozioni stabili e generali del dominio; se un dato specifico non è certo, ometti o usa formulazioni qualitative invece di inventare cifre/date precise.`;
  }
  // Orphan-query candidates carry a site-relative path (GSC topLandingPage
  // is stored path-only by design, see gscFetcher.mjs:231) — fetch() has no
  // implicit base URL and throws "Failed to parse URL from /..." on these,
  // silently degrading to a sourceless generation. Resolve against the
  // canonical domain before fetching.
  const absoluteUrl = url.startsWith('/') ? `${BASE_URL}${url}` : url;
  console.error(`📰 Fetching: ${absoluteUrl}`);
  try {
    const res = await fetch(absoluteUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    // Use structured extractor (JSON-LD → article → main → og + paragraphs → naive)
    // to feed the generator and fact-checker the actual article body instead of
    // 70%+ nav/footer/ads noise. See scripts/lib/extract-article-text.mjs.
    const { text, method, paragraphCount, publishedAt } = extractArticleText(html, { maxChars: 8000 });
    lastSourcePublishedAt = publishedAt || '';
    const ageNote = lastSourcePublishedAt
      ? ` — fonte del ${lastSourcePublishedAt.slice(0, 10)}`
      : ' — data fonte non rilevata';
    console.error(`   📄 Estratto via ${method}: ${text.length} chars, ${paragraphCount} blocchi${ageNote}`);
    return text;
  } catch (e) {
    console.error(`⚠️  Impossibile scaricare la pagina: ${e.message}`);
    console.error('   L\'articolo verrà generato senza contesto dalla pagina web.');
    return '';
  }
}

// ── Date filtering: only articles from the last 3 days ──────
const MAX_ARTICLE_AGE_DAYS = 3;

/** Try to extract a publication date from a URL path (e.g. /2026/02/18/ or /20260218/) */
function extractDateFromUrl(url) {
  // Pattern: /YYYY/MM/DD/ in path
  const slashDate = url.match(/\/(20\d{2})\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])/);
  if (slashDate) {
    return new Date(`${slashDate[1]}-${slashDate[2]}-${slashDate[3]}T00:00:00`);
  }
  // Pattern: /YYYYMMDD/ in path
  const compactDate = url.match(/\/(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])/);
  if (compactDate) {
    return new Date(`${compactDate[1]}-${compactDate[2]}-${compactDate[3]}T00:00:00`);
  }
  return null;
}

/** Build a map of URL → date from <time> elements found near <a> links in the HTML */
function extractDatesFromHtml(html, baseUrl) {
  const dateMap = new Map();
  // Match <time datetime="..."> anywhere in HTML — build global date context
  const timeRe = /<time[^>]*datetime=["']([^"']+)["'][^>]*>/gi;
  let tm;
  while ((tm = timeRe.exec(html)) !== null) {
    const dateStr = tm[1];
    const pos = tm.index;
    // Find the nearest <a href> within 500 chars before or after this <time>
    const context = html.slice(Math.max(0, pos - 500), pos + 500);
    const nearbyLink = context.match(/href=["'](https?:\/\/[^"']+)["']/);
    if (nearbyLink) {
      try {
        const d = new Date(dateStr);
        if (!isNaN(d.getTime())) dateMap.set(nearbyLink[1], d);
      } catch { /* skip invalid dates */ }
    }
  }

  // Plain-text DD.MM.YYYY dates nested inside the link — institutional listings
  // such as Canton Ticino / USTAT (www3.ti.ch …fuseaction=news.dettaglio) render
  // each row as `<a href=…><div class="data">28.05.2026</div><div class="testo">
  // title</div></a>`, with no <time> element. Without this, every ti.ch headline
  // arrives undated and bypasses the MAX_ARTICLE_AGE_DAYS recency filter — that
  // is how a Dec-2025 office-closure notice was still surfaced on 28.05.2026
  // (then false-matched into the proven pool). Scope the date to the anchor's
  // own inner HTML so the link↔date pairing is exact (proximity windows misfire
  // when the same nwsId appears in multiple sidebars).
  const anchorRe = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let am;
  while ((am = anchorRe.exec(html)) !== null) {
    const inner = am[2];
    const dmy = inner.match(/\b([0-3]?\d)\.(0?[1-9]|1[0-2])\.(20\d{2})\b/);
    if (!dmy) continue;
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const year = Number(dmy[3]);
    if (day < 1 || day > 31) continue;
    // Resolve to the absolute URL so the key matches extractHeadlines' lookup.
    let href;
    try { href = new URL(am[1], baseUrl).href; } catch { continue; }
    if (!href.startsWith('http') || dateMap.has(href)) continue;
    const d = new Date(year, month - 1, day);
    // Round-trip: reject calendar-impossible dates (31.04, 30.02) that
    // Date's local-time constructor silently overflows into the next month
    // instead of erroring — same anti-pattern fixed in
    // scripts/lib/postch-job-parser.mjs (parseDdMmYyyy) and
    // scripts/crawl-ge-agenda.mjs (parseGeneveDateFr / isValidCalendarDate).
    if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) continue;
    if (!isNaN(d.getTime())) dateMap.set(href, d);
  }

  return dateMap;
}

/** Check if a date is within the last N days */
function isWithinDays(date, days) {
  if (!date) return false;
  const now = new Date();
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return date >= cutoff;
}

// ── Step 1b: Extract links and headlines from an HTML page ──
function extractHeadlines(html, baseUrl) {
  const results = [];
  const htmlDateMap = extractDatesFromHtml(html, baseUrl);
  // Match <a href="...">text</a> — capture href and inner text
  const linkRe = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    let href = m[1];
    const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    // Only keep links with meaningful text (likely headlines)
    if (text.length < 15 || text.length > 300) continue;
    // Resolve relative URLs
    try {
      href = new URL(href, baseUrl).href;
    } catch { continue; }
    // Skip anchor links, javascript, mailto, etc.
    if (!href.startsWith('http')) continue;
    // Skip non-article links (categories, tags, pagination, login, etc.)
    if (/\/(tag|categor|page|login|registr|cookie|privacy|contatt|archiv|abonn)/i.test(href)) continue;
    // Extract date from URL path or from nearby <time> elements
    const date = extractDateFromUrl(href) || htmlDateMap.get(href) || null;
    results.push({ url: href, headline: text, date });
  }
  // Deduplicate by URL
  const seen = new Set();
  return results.filter(r => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

// ── Step 1b-bis: Extract items from RSS/Atom XML feeds ──────
/** Detect whether content is RSS/Atom XML */
function isRssFeed(content) {
  const head = content.slice(0, 500);
  return /<rss[\s>]/i.test(head)
    || /<feed[\s>]/i.test(head)
    || (/<\?xml/i.test(head) && /<channel[\s>]/i.test(content.slice(0, 2000)));
}

/** Parse RSS/Atom XML and return { url, headline, date }[] — same shape as extractHeadlines */
function extractRssItems(xml, feedUrl) {
  const results = [];
  const isAtom = /<feed[\s>]/i.test(xml.slice(0, 500));

  if (isAtom) {
    // Atom: <entry><title>…</title><link href="…"/><updated>…</updated></entry>
    const entryRe = /<entry[\s>][\s\S]*?<\/entry>/gi;
    let em;
    while ((em = entryRe.exec(xml)) !== null) {
      const block = em[0];
      const title = block.match(/<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title[^>]*>([\s\S]*?)<\/title>/i);
      const link = block.match(/<link[^>]*href=["']([^"']+)["']/i)
        || block.match(/<link[^>]*>([^<]+)<\/link>/i);
      const date = block.match(/<updated>([^<]+)<\/updated>/i)
        || block.match(/<published>([^<]+)<\/published>/i);
      const headline = (title?.[1] || title?.[2] || '').replace(/<[^>]+>/g, '').trim();
      const href = (link?.[1] || '').trim();
      if (!headline || headline.length < 10 || !href) continue;
      let parsedDate = null;
      if (date?.[1]) { try { parsedDate = new Date(date[1]); if (isNaN(parsedDate.getTime())) parsedDate = null; } catch { parsedDate = null; } }
      results.push({ url: href, headline, date: parsedDate });
    }
  } else {
    // RSS 2.0: <item><title>…</title><link>…</link><pubDate>…</pubDate></item>
    const itemRe = /<item[\s>][\s\S]*?<\/item>/gi;
    let im;
    while ((im = itemRe.exec(xml)) !== null) {
      const block = im[0];
      const title = block.match(/<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title[^>]*>([\s\S]*?)<\/title>/i);
      const link = block.match(/<link[^>]*>\s*<!\[CDATA\[([^\]]+)\]\]>\s*<\/link>|<link[^>]*>\s*([^<\s]+)\s*<\/link>/i);
      const date = block.match(/<pubDate>([^<]+)<\/pubDate>/i)
        || block.match(/<dc:date>([^<]+)<\/dc:date>/i)
        || block.match(/<date>([^<]+)<\/date>/i);
      const headline = (title?.[1] || title?.[2] || '').replace(/<[^>]+>/g, '').trim();
      let href = (link?.[1] || link?.[2] || '').trim();
      if (!headline || headline.length < 10) continue;
      // Resolve relative URLs
      if (href) { try { href = new URL(href, feedUrl).href; } catch { /* keep as-is */ } }
      if (!href || !href.startsWith('http')) continue;
      let parsedDate = null;
      if (date?.[1]) { try { parsedDate = new Date(date[1].trim()); if (isNaN(parsedDate.getTime())) parsedDate = null; } catch { parsedDate = null; } }
      results.push({ url: href, headline, date: parsedDate });
    }
  }

  // Deduplicate by URL
  const seen = new Set();
  return results.filter(r => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

// ── Step 1c: Scan all news sources for recent headlines ─────
async function scanNewsSources() {
  // Section-keyed source list: frontaliere → Ticino/frontalieri feeds (default),
  // svizzera → national CH feeds (NEWS_SOURCES_SVIZZERA).
  const newsSources = SECTION.newsSources;
  const rssFallbackMap = SECTION.rssFallbackMap;
  console.error(
    IS_FRONTALIERE
      ? '🔍 Scansione fonti di notizie ticinesi...\n'
      : '🔍 Scansione fonti di notizie nazionali svizzere...\n',
  );
  const allHeadlines = [];
  RUN_REPORT.sources.configured = newsSources.length;
  RUN_REPORT.sources.scanned = newsSources.length;
  RUN_REPORT.sources.domains = newsSources.map((u) => {
    try { return new URL(u).hostname.replace(/^www\d?\./, ''); } catch { return u; }
  });

  const fetches = newsSources.map(async (sourceUrl) => {
    const domain = new URL(sourceUrl).hostname.replace('www.', '').replace('www3.', '');
    try {
      const res = await fetch(sourceUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'application/rss+xml, application/xml, text/xml, text/html, application/xhtml+xml',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const content = await res.text();

      let headlines;
      if (isRssFeed(content)) {
        // ── RSS/Atom feed: use dedicated parser ──
        headlines = extractRssItems(content, sourceUrl);
        // Filter RSS items to last 3 days (RSS has reliable dates)
        const recent = headlines.filter(h => h.date && isWithinDays(h.date, MAX_ARTICLE_AGE_DAYS));
        if (recent.length > 0) {
          console.error(`  📡 ${domain}: ${recent.length} articoli RSS recenti (${headlines.length} totali)`);
          headlines = recent;
        } else if (headlines.length > 0) {
          console.error(`  📡 ${domain}: ${headlines.length} articoli RSS (nessuno negli ultimi ${MAX_ARTICLE_AGE_DAYS} giorni)`);
          // Fallback: scrape the base HTML site for this feed
          const fallbackUrl = rssFallbackMap[sourceUrl];
          if (fallbackUrl) {
            try {
              const fbRes = await fetch(fallbackUrl, {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                  'Accept': 'text/html,application/xhtml+xml',
                },
                signal: AbortSignal.timeout(15000),
              });
              if (fbRes.ok) {
                const fbHtml = await fbRes.text();
                headlines = extractHeadlines(fbHtml, fallbackUrl);
                console.error(`  🌐 ${domain}: HTML fallback → ${headlines.length} articoli da ${new URL(fallbackUrl).hostname}`);
              }
            } catch (fbErr) {
              console.error(`  ⚠️ ${domain}: fallback HTML fallito: ${fbErr.message}`);
            }
          } else {
            // No fallback — use all RSS items even if older
            console.error(`  📡 ${domain}: nessun fallback, uso tutti gli articoli RSS`);
          }
        } else {
          console.error(`  📡 ${domain}: RSS vuoto (0 articoli)`);
          // Try fallback HTML
          const fallbackUrl = rssFallbackMap[sourceUrl];
          if (fallbackUrl) {
            try {
              const fbRes = await fetch(fallbackUrl, {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                  'Accept': 'text/html,application/xhtml+xml',
                },
                signal: AbortSignal.timeout(15000),
              });
              if (fbRes.ok) {
                const fbHtml = await fbRes.text();
                headlines = extractHeadlines(fbHtml, fallbackUrl);
                console.error(`  🌐 ${domain}: HTML fallback → ${headlines.length} articoli`);
              }
            } catch (fbErr) {
              console.error(`  ⚠️ ${domain}: fallback HTML fallito: ${fbErr.message}`);
            }
          }
        }
      } else {
        // ── HTML page: use existing <a href> parser ──
        headlines = extractHeadlines(content, sourceUrl);
        console.error(`  🌐 ${domain}: ${headlines.length} articoli HTML`);
      }

      RUN_REPORT.sources.succeeded += 1;
      return (headlines || []).map(h => ({ ...h, source: domain }));
    } catch (e) {
      console.error(`  ⚠️ ${domain}: ${e.message}`);
      RUN_REPORT.sources.failed += 1;
      return [];
    }
  });

  const results = await Promise.all(fetches);
  for (const batch of results) {
    allHeadlines.push(...batch);
  }

  // ── Search-based ingestion via WordPress REST API ──
  // Catches articles whose editor didn't apply a /categoria/frontalieri/
  // tag but whose title/body contains the keyword. Standard RSS+tag-page
  // crawl misses these. Currently covers comozero.it + malpensa24.it.
  // Same headline shape as extractRssItems, drop-in merge.
  try {
    const wpHeadlines = await fetchWordpressSearchHeadlines();
    if (wpHeadlines.length > 0) {
      console.error(`  🔌 wp-search: ${wpHeadlines.length} articoli totali da ricerca WordPress`);
      allHeadlines.push(...wpHeadlines);
    }
  } catch (err) {
    console.error(`  ⚠️ wp-search fallito globalmente: ${err.message}`);
  }

  console.error(`\n  📊 Totale: ${allHeadlines.length} articoli trovati da ${newsSources.length} fonti + WP search`);

  // Filter: only keep articles from the last 3 days
  const recent = allHeadlines.filter(h => {
    if (!h.date) return false; // skip undated articles — can't verify recency
    return isWithinDays(h.date, MAX_ARTICLE_AGE_DAYS);
  });
  const undated = allHeadlines.filter(h => !h.date);
  RUN_REPORT.headlines.total = allHeadlines.length;
  RUN_REPORT.headlines.recent = recent.length;
  RUN_REPORT.headlines.undated = undated.length;

  console.error(`  📅 Filtro ultimi ${MAX_ARTICLE_AGE_DAYS} giorni: ${recent.length} articoli recenti\n`);
  if (undated.length > 0) {
    console.error(`  🕒 Articoli senza data esplicita: ${undated.length} (usati come fallback a bassa priorità)\n`);
  }

  // ── Domain-anchor pre-filter (proven pool) ──
  // 2026-05-11 incident: `malpensa-arresto-frontaliere-omicidio-2026` — a
  // generic varesenews.it/feed/ headline about a US murder suspect at
  // Malpensa entered the proven pool (no anchor gate), embedding ranker
  // matched it against other crime articles (cosine corpus drift), score
  // 9.73 → published as off-topic SEO slop.
  // The discovery/suggest pipeline already filters via hasDomainAnchor
  // (PR #73, 2026-05-11). Apply the same gate to the proven news-scan
  // pool: drop any headline lacking a Ticino/frontalieri/CH-municipality
  // anchor BEFORE it enters the ranker. Env-gated so we can roll back
  // without a code change if it kills too many legit headlines.
  const dropAnchorless = (process.env.SCAN_DROP_ANCHORLESS ?? '1') !== '0';
  // Topical pre-filter (2026-05-12): geographic anchor-gate is too permissive
  // (any CH municipality / IT border town passes — including "chiesetta
  // ortodossa Locarno", "asilo nido Sesto Calende", "risotto cuoco Gallarate").
  // 8/10 recent runs reached callGemini, generated the IT body, then skipped
  // at density-check ~6340 — burning ~10 min/run of LLM quota. Add a topical
  // gate (work/fisco/permess/economy/transport/policy) requiring both
  // geographic AND topical signal. Env-gated for rollback.
  const dropNonTopical = (process.env.SCAN_DROP_NON_TOPICAL ?? '1') !== '0';
  // 2026-08-10 — SECTION AWARENESS. Both gates above were written for the
  // frontaliere section and were applied unchanged to `svizzera`, which is
  // national by design. Measured on 538 real headlines from the reachable
  // NEWS_SOURCES_SVIZZERA:
  //
  //   anchor-gate   drops  43/538 (8%)  — and what it drops is fiscoetasse.com
  //                 / lavoroediritti.com Italian-domestic items ("Assegno di
  //                 Inclusione", "NASpI dimissioni", "Bonus Sud e ZES nel
  //                 charter nautico"). On a Swiss national section requiring a
  //                 Swiss nexus is CORRECT, so this drop stays as-is.
  //   topical-gate  drops 418/495 (84%) — including "Svizzera: PIL in
  //                 crescita", "BNS in perdita di mezzo miliardo", "Il franco
  //                 sempre più forte", "Impennata dei fallimenti in Svizzera",
  //                 while keeping "Il lavoro mortale dei giornalisti in
  //                 Messico" (it contains `lavor`). Wrong lexicon, not merely
  //                 a tight one — see SVIZZERA_TOPICAL_KEYWORDS.
  //
  // `hasTopicalSignal` now picks the lexicon from the section, which takes the
  // national pool from 77 to 188 survivors. The drop itself is kept rather
  // than disabled: sampled 25 runs on 2026-08-10, frontaliere reaches the
  // pre-spend classifier with 47-56 candidates, and that is the cost envelope
  // this pipeline is sized for. Removing the topical drop would push ~495.
  const filterByAnchor = (list) => {
    if (!dropAnchorless && !dropNonTopical) return list;
    const kept = [];
    let droppedAnchor = 0;
    let droppedTopic = 0;
    for (const h of list) {
      const text = `${h.headline || ''} ${h.url || ''}`;
      if (dropAnchorless && !hasDomainAnchor(text)) {
        droppedAnchor += 1;
        continue;
      }
      if (dropNonTopical && !hasAdmissionSignal(text)) {
        droppedTopic += 1;
        continue;
      }
      kept.push(h);
    }
    if (droppedAnchor > 0) {
      RUN_REPORT.headlines.droppedAnchorless = (RUN_REPORT.headlines.droppedAnchorless || 0) + droppedAnchor;
      console.error(`  🚫 Anchor-gate: ${droppedAnchor} headline scartate (nessun token Ticino/frontaliere/comune CH/città IT confine)`);
    }
    if (droppedTopic > 0) {
      RUN_REPORT.headlines.droppedNonTopical = (RUN_REPORT.headlines.droppedNonTopical || 0) + droppedTopic;
      // Naming the lexicon is not cosmetic: this line read
      // "lavoro/fisco/permess/economi/transport/policy" while running on the
      // national section, which is how the mismatch stayed invisible in 224
      // runs of logs.
      const lexicon = IS_FRONTALIERE
        ? 'lavoro/fisco/permess/economi/transport/policy'
        : `nazionale: ${SECTION_NAME} — economia/fisco/energia/sanità/scuola/migrazione/istituzioni`;
      console.error(`  🚫 Topical-gate: ${droppedTopic} headline scartate (nessun token ${lexicon})`);
    }
    return kept;
  };

  // If no recent articles found, fall back to all headlines (homepage articles are likely recent)
  if (recent.length === 0) {
    console.error('  ⚠️  Nessun articolo con data negli ultimi 3 giorni — uso tutti gli headline\n');
    RUN_REPORT.headlines.usedRecent = 0;
    RUN_REPORT.headlines.usedUndated = undated.length;
    return prioritizeFrontalieriHeadlines(filterByAnchor(allHeadlines));
  }

  const undatedTop = undated.slice(0, 120).map(h => ({ ...h, _undatedFallback: true }));
  RUN_REPORT.headlines.usedRecent = recent.length;
  RUN_REPORT.headlines.usedUndated = undatedTop.length;
  return prioritizeFrontalieriHeadlines(filterByAnchor([...recent, ...undatedTop]));
}

// ── Frontalieri relevance pre-filter ────────────────────────
// Keywords that indicate an article is directly relevant to cross-border workers.
// Headlines matching these get boosted to the top of the list so Gemini picks from
// frontalieri-specific news first. If none match, we fall back to all headlines.
const FRONTALIERI_KEYWORDS = [
  'frontalier',     // covers frontaliere, frontalieri, frontaliero
  'transfrontalier', // transfrontaliero/a/i/e
  'cross-border',
  'grenzgänger',
  'pendolare',      // pendolari transfrontalieri
  'permesso g',
  'permesso b',
  'permesso di lavoro',
  'imposta alla fonte',
  'ristorn',        // ristorni, ristorno
  'nuovo accordo',  // nuovo accordo fiscale CH-IT
  'accordo fiscale',
  'dogana',         // dogana, doganale
  'valico',         // valichi di confine
  'brogeda',
  'gaggiolo',
  'ponte tresa',
  'chiasso',
  'lavoro svizzer', // lavoro svizzero, in svizzera
  'lavoro in ticino',
  'stipendio svizzer',
  'tassazione italo-svizzer',
  'lamal',
  'cassa malati',
  'avs',
  'secondo pilastro',
  'terzo pilastro',
  'doppia imposizione',
];

/** Split headlines into frontalieri-relevant (boosted) + rest, return boosted first */
function prioritizeFrontalieriHeadlines(headlines) {
  // The national (svizzera) section must not be re-sorted by a frontaliere
  // ruler, and above all must not be TRUNCATED by one. With >= MIN_BOOSTED
  // frontalieri hits the threshold below drops every non-boosted headline —
  // on this section that would hand the pool to the very topics the national
  // classifier prompt rejects by construction ("Articoli il cui ARGOMENTO
  // PRINCIPALE è esclusivamente frontaliero … appartengono a una sezione
  // separata"), i.e. a guaranteed total rejection downstream. It has been
  // harmless so far only by luck: the observed runs logged boosted=0 because
  // the topical gate had already emptied the pool of everything but foreign
  // news. Widening that pool (SVIZZERA_TOPICAL_KEYWORDS) makes the trap
  // reachable, so it is closed here rather than left armed.
  if (!IS_FRONTALIERE) return headlines;

  const boosted = [];
  const rest = [];

  for (const h of headlines) {
    const text = h.headline.toLowerCase();
    const url = h.url.toLowerCase();
    const isFrontalieri = FRONTALIERI_KEYWORDS.some(kw => text.includes(kw) || url.includes(kw));
    if (isFrontalieri) {
      boosted.push({ ...h, _frontalieriBoosted: true });
    } else {
      rest.push(h);
    }
  }

  // Threshold (2026-05-12): when boosted pool is healthy (>= MIN_BOOSTED), drop
  // the rest entirely so the ranker can't pick a non-frontalieri headline.
  // Below threshold we fall back to concatenation to preserve coverage during
  // a quiet news cycle. Env-gated for rollback.
  const MIN_BOOSTED = Number(process.env.MIN_BOOSTED_HEADLINES ?? '10');
  const keepNonBoosted = (process.env.SCAN_KEEP_NON_BOOSTED ?? '0') !== '0';

  if (boosted.length >= MIN_BOOSTED && !keepNonBoosted) {
    console.error(`  🎯 Pre-filtro frontalieri: ${boosted.length} articoli direttamente rilevanti (drop ${rest.length} non-boosted, soglia=${MIN_BOOSTED})`);
    console.error(`     Keyword trovate negli headline: ${boosted.map(h => `"${h.headline.slice(0, 60)}…"`).slice(0, 5).join(', ')}`);
    return boosted;
  }

  if (boosted.length > 0) {
    console.error(`  🎯 Pre-filtro frontalieri: ${boosted.length} articoli direttamente rilevanti (su ${headlines.length} totali, sotto soglia ${MIN_BOOSTED} → mantengo non-boosted come fallback)`);
    console.error(`     Keyword trovate negli headline: ${boosted.map(h => `"${h.headline.slice(0, 60)}…"`).slice(0, 5).join(', ')}`);
    // Return boosted first, then the rest — Gemini will see the most relevant ones at the top
    return [...boosted, ...rest];
  }

  console.error(`  ℹ️  Nessun headline con keyword frontalieri esplicita — uso tutti gli ${headlines.length} articoli`);
  return headlines;
}

// ── Step 1d: Use Gemini to select the best article ──────────
async function selectArticle(headlines) {
  // Get existing article info for duplicate detection (all sections — shared id/SEO/i18n namespace)
  const existingIds = getAllArticleIds();

  // Get existing article titles AND excerpts from the section meta-it for robust duplicate detection
  const blogItSrc = readSectionMetaIt();
  const titleMatches = [...blogItSrc.matchAll(metaFieldRegex('title'))];
  const excerptMatches = [...blogItSrc.matchAll(metaFieldRegex('excerpt'))];
  titleMatches.forEach((m) => { m[2] = unescapeTsValue(m[2]); });
  excerptMatches.forEach((m) => { m[2] = unescapeTsValue(m[2]); });
  const existingTitles = titleMatches.map(m => m[2]);
  // Build compact "title — excerpt" list for last 30 articles (most relevant for duplicate avoidance)
  const recentArticles = titleMatches.slice(-30).map(m => {
    const exMatch = excerptMatches.find(e => e[1] === m[1]);
    return `• [${m[1]}] ${m[2]}${exMatch ? ' — ' + exMatch[2].slice(0, 100) : ''}`;
  }).join('\n');

  // Chunking: if too many headlines, split into batches to avoid token overflow
  const MAX_HEADLINES_PER_BATCH = 50;
  let trimmed = headlines.slice(0, 500);
  let batchWinners = [];
  if (trimmed.length > MAX_HEADLINES_PER_BATCH) {
    // Split into batches
    const batches = [];
    for (let i = 0; i < trimmed.length; i += MAX_HEADLINES_PER_BATCH) {
      batches.push(trimmed.slice(i, i + MAX_HEADLINES_PER_BATCH));
    }
    // Run LLM selection for each batch
    for (const [batchIdx, batch] of batches.entries()) {
      const headlineList = batch.map((h, i) => {
        const tag = h._frontalieriBoosted ? ' ⭐FRONTALIERI' : '';
        const recencyTag = h._undatedFallback ? ' ⏳UNDATED' : '';
        return `[${i}] (${h.source}${tag}${recencyTag}) ${h.headline}`;
      }).join('\n');
      const prompt = HEADLINE_SELECTION_PROMPT(headlineList, recentArticles);
      console.error(`🤖 Selezione batch ${batchIdx + 1}/${batches.length} (${batch.length} headline)...`);
      const rawText = await callLLM(
        [{ role: 'user', content: prompt }],
        { model: GH_MODEL_LIGHT, temperature: 0.3, maxTokens: 512, jsonMode: true },
      );
      const cleaned = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      let selection;
      try {
        selection = JSON.parse(cleaned);
      } catch {
        const idxMatch = cleaned.match(/"selectedIndex"\s*:\s*(\d+)/);
        const reasonMatch = cleaned.match(/"reason"\s*:\s*"([^"]*)/);
        if (idxMatch) {
          console.error(`  ⚠️  JSON troncato — recovery da selectedIndex=${idxMatch[1]}`);
          selection = {
            selectedIndex: parseInt(idxMatch[1], 10),
            reason: reasonMatch ? reasonMatch[1] : '(reason troncata)',
          };
        } else {
          console.error(`  ⚠️  Batch ${batchIdx + 1}: impossibile parsare selezione, skip`);
          console.error(`     Risposta: ${cleaned.slice(0, 200)}`);
          continue;
        }
      }
      let idx = selection.selectedIndex;
      if (typeof idx !== 'number' || idx < 0 || idx >= batch.length) {
        console.error(`  ⚠️  Batch ${batchIdx + 1}: indice ${idx} fuori range (0-${batch.length - 1}), clamp a 0`);
        idx = 0;
      }
      batchWinners.push({ ...batch[idx], _batchReason: selection.reason });
    }
    // Now select from batch winners
    trimmed = batchWinners;
    console.error(`🔄 Batch selection completata: ${batchWinners.length} finalisti`);
  }
  // Single-batch or batch-winner selection
  const headlineList = trimmed.map((h, i) => {
    const tag = h._frontalieriBoosted ? ' ⭐FRONTALIERI' : '';
    const recencyTag = h._undatedFallback ? ' ⏳UNDATED' : '';
    return `[${i}] (${h.source}${tag}${recencyTag}) ${h.headline}`;
  }).join('\n');
  const prompt = HEADLINE_SELECTION_PROMPT(headlineList, recentArticles);
  console.error(`🤖 Selezione articolo finale tra ${trimmed.length} headline...`);
  const rawText = await callLLM(
    [{ role: 'user', content: prompt }],
    { model: GH_MODEL_LIGHT, temperature: 0.3, maxTokens: 512, jsonMode: true },
  );
  console.error(`  ✅ Selezione completata`);
  const cleaned = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  let selection;
  try {
    selection = JSON.parse(cleaned);
  } catch {
    const idxMatch = cleaned.match(/"selectedIndex"\s*:\s*(\d+)/);
    const reasonMatch = cleaned.match(/"reason"\s*:\s*"([^"]*)/);
    if (idxMatch) {
      console.error(`  ⚠️  JSON troncato — recovery da selectedIndex=${idxMatch[1]}`);
      selection = {
        selectedIndex: parseInt(idxMatch[1], 10),
        reason: reasonMatch ? reasonMatch[1] : '(reason troncata)',
      };
    } else {
      // Last resort: pick first headline
      console.error(`  ⚠️  Impossibile parsare selezione finale, fallback a indice 0`);
      console.error(`     Risposta: ${cleaned.slice(0, 200)}`);
      selection = { selectedIndex: 0, reason: '(selezione automatica — parse fallito)' };
    }
  }
  let idx = selection.selectedIndex;
  if (typeof idx !== 'number' || idx < 0 || idx >= trimmed.length) {
    console.error(`  ⚠️  Indice ${idx} fuori range (0-${trimmed.length - 1}), clamp a 0`);
    idx = 0;
  }
  const chosen = trimmed[idx];
  const tokenize = (s) => (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9àèéìòùäöüßç\s-]/gi, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3);
  const selectedTerms = new Set(tokenize(chosen.headline));
  const relatedHeadlines = trimmed
    .filter((h, i) => i !== idx)
    .map((h) => {
      const words = tokenize(h.headline);
      const overlap = words.filter(w => selectedTerms.has(w)).length;
      const sourceBoost = h.source === chosen.source ? 2 : 0;
      return { ...h, _score: overlap + sourceBoost };
    })
    .filter(h => h._score > 1)
    .sort((a, b) => b._score - a._score)
    .slice(0, 4)
    .map(({ headline, source, url }) => ({ headline, source, url }));

  chosen.relatedHeadlines = relatedHeadlines;
  console.error(`🎯 Articolo selezionato: "${chosen.headline}"`);
  console.error(`   Fonte: ${chosen.source}`);
  console.error(`   URL: ${chosen.url}`);
  if (relatedHeadlines.length > 0) {
    console.error(`   Contesto extra: ${relatedHeadlines.length} headline correlate incluse per arricchire il contenuto.`);
  }
  console.error(`   Motivo: ${selection.reason}`);
  return chosen;
}

// ── Step 2: Generate article via GitHub Models (multi-call) ─
async function callGemini(pageContent, url, sourceContext = null) {
  // Get existing article IDs to avoid duplicates (all sections — shared id/SEO/i18n namespace)
  const existingIds = getAllArticleIds();

  // ── Token budget management ──
  // Most models accept 128K+ context. We keep source generous (6000 chars)
  // to maximize factual grounding, and limit IDs to 50 for dedup.
  //
  // Strategy:
  //   1. Only send last 50 article IDs (recent ones matter most for dedup)
  //   2. Provide generous source content (6000 chars) so the model has facts to work with
  //   3. Send compact IT-only JSON template (EN/DE/FR generated in separate calls)
  //   4. Compress editorial rules (no repetition per locale)
  const generationAttempt = Number(sourceContext?._generationAttempt || 1);
  // Regen attempts (2+) also carry factCheckRefinementInstruction (flagged
  // claims to fix) and, since fix B above, domainFactsBlock — both compete
  // with source content for the same ~8000-token input cap several free
  // models enforce. Shrinking the re-sent source on retries only (never on
  // the first, richness-matters attempt) buys headroom without touching
  // first-attempt grounding.
  const MAX_SOURCE_CHARS = generationAttempt > 1 ? 4500 : 6000;
  const MAX_IDS_TO_SEND = 50;

  const truncatedContent = pageContent
    ? (pageContent.length > MAX_SOURCE_CHARS
      ? pageContent.slice(0, MAX_SOURCE_CHARS) + '\n[...contenuto troncato per brevità]'
      : pageContent)
    : '(page content unavailable — generate based on URL topic)';

  // Send only recent IDs + count of older ones
  const recentIds = existingIds.slice(-MAX_IDS_TO_SEND);
  const olderCount = existingIds.length - recentIds.length;
  const idsSection = olderCount > 0
    ? `RECENT ARTICLE IDS (last ${MAX_IDS_TO_SEND} of ${existingIds.length} total — do NOT reuse): ${recentIds.join(', ')}`
    : `EXISTING ARTICLE IDS (do NOT reuse): ${recentIds.join(', ')}`;

  const relatedContext = sourceContext?.relatedHeadlines?.length
    ? sourceContext.relatedHeadlines.map((h, i) => `- [${i + 1}] (${h.source}) ${h.headline}`).join('\n')
    : '';

  const generationAttemptMax = Number(sourceContext?._generationAttemptMax || 1);
  const minItalianWords = Number(sourceContext?._minItalianWords || CREATE_ARTICLE_MIN_IT_WORDS);

  // ── Patch J: primaryLocale (default 'it') ──
  const primaryLocale = ['it', 'de', 'en', 'fr'].includes(sourceContext?._primaryLocale)
    ? sourceContext._primaryLocale
    : 'it';
  const primaryLocaleBlock = primaryLocale !== 'it'
    ? `\n═══ PRIMARY LOCALE: ${primaryLocale.toUpperCase()} ═══
Scrivi PRIMA in ${primaryLocale} con stile editoriale NATIVO della lingua (NON una traduzione da italiano).
- DE: usa formulazioni naturali tedesche (es. Grenzgänger non "frontaliere"; CHF e Franken; "im Kanton Tessin").
- FR: stile journalistique français (es. travailleur frontalier; CHF; "dans le canton du Tessin").
- EN: clear UK/US English; avoid Italianisms.
Le altre 3 lingue saranno traduzioni di QUESTA versione, generate in chiamate separate.\n`
    : '';

  // ── Patch A: target keyword block ──
  const targetKeyword = sourceContext?._targetKeyword;
  const searchVolume = sourceContext?._searchVolume;
  const keywordVariations = Array.isArray(sourceContext?._keywordVariations) ? sourceContext._keywordVariations : [];
  const targetKeywordBlock = targetKeyword
    ? `\n═══ TARGET KEYWORD (CRITICO PER SEO) ═══
TARGET KEYWORD: ${targetKeyword}${searchVolume ? ` (search volume: ${searchVolume}/mese)` : ''}
${keywordVariations.length ? `VARIAZIONI da distribuire nel testo: ${keywordVariations.join(', ')}` : ''}

OBBLIGHI:
- Title: contiene la TARGET KEYWORD esatta (o variazione minima per leggibilità)
- body1: la TARGET KEYWORD compare nei primi 100 caratteri
- body2 o body3: almeno 1 sotto-sezione ## o ### usa la TARGET KEYWORD
- slug primaryLocale: include la TARGET KEYWORD trasformata in kebab-case
- seo.description: contiene la TARGET KEYWORD nei primi 120 caratteri
- VARIAZIONI: distribuisci le variazioni nel testo (1 occorrenza ognuna minimo)\n`
    : '';

  // ── Patch B: PAA-driven FAQ ──
  const peopleAlsoAsk = Array.isArray(sourceContext?._peopleAlsoAsk) ? sourceContext._peopleAlsoAsk : [];
  const peopleAlsoAskBlock = peopleAlsoAsk.length
    ? `\n═══ FAQ DA PEOPLE-ALSO-ASK (NON GENERICHE) ═══
Le 3-5 FAQ DEVONO essere prese (parafrasate per chiarezza, non copiate verbatim) da queste query reali estratte da Semrush:
${peopleAlsoAsk.map((q, i) => `${i + 1}. ${q}`).join('\n')}

Le risposte devono includere dati concreti dalla fonte/contesto e rispettare il limite 50-100 parole.\n`
    : '';

  // ── Patch C: MUST-COVER LSI entities (always present) ──
  const mustCoverLsiBlock = IS_FRONTALIERE
    ? `\n═══ MUST-COVER ENTITIES (E-E-A-T + LSI) ═══
Almeno 6 dei seguenti termini DEVONO comparire naturalmente nel testo (no keyword stuffing):
permesso G, AVS, LPP, LAMal, ristorni, imposta alla fonte, Brogeda, INPS, Canton Ticino, frontaliere, nuovo accordo fiscale 2026, doppia imposizione.\n`
    : `\n═══ MUST-COVER ENTITIES (E-E-A-T + LSI) ═══
Almeno 6 dei seguenti termini, SE PERTINENTI al tema, DEVONO comparire naturalmente nel testo (no keyword stuffing):
AVS/AHV, LPP/BVG, LAMal/KVG, imposta federale diretta, IVA, SECO, UST/BFS, BNS/SNB, Consiglio federale, Cantoni, salario minimo, costo della vita.\n`;

  // ── Section-aware prompt fragments ──────────────────────────────
  // Frontaliere branch = byte-identical to the historical prompt (drives ~95%
  // revenue). Svizzera branch reframes section-specific blocks around NATIONAL
  // Swiss relevance for a general Swiss-resident audience. Every section-AGNOSTIC
  // rule (fedeltà alla fonte, anti-allucinazione, anti-AI, formatting, internal
  // links, CTA divieti, grassetto, H3, anti-ripetitività) stays verbatim below.
  const systemRoleLine = IS_FRONTALIERE
    ? `You are a senior financial journalist specializing in Swiss-Italian cross-border work and Ticino economics.
You write for "Frontaliere Ticino" (frontaliereticino.ch). Based on the following source, write a blog article.`
    : `You are a senior journalist covering Swiss NATIONAL affairs — economy, fiscal policy, labour market, cost of living, housing, federal & cantonal politics — for a general Swiss-resident audience.
You write for "Frontaliere Ticino" (frontaliereticino.ch), national Switzerland section. Based on the following source, write a blog article.`;

  const reachMinimumImplicationsLine = IS_FRONTALIERE
    ? `- Analizza le IMPLICAZIONI PRATICHE per i frontalieri (cosa cambia nella vita quotidiana)`
    : `- Analizza le IMPLICAZIONI PRATICHE a livello nazionale/cantonale (cosa cambia nella vita di chi vive o lavora in Svizzera)`;

  const topicalRelevanceGate = IS_FRONTALIERE
    ? `═══ REGOLA #0 — GATE DI RILEVANZA TOPICA (BLOCCANTE — PRIMA DI TUTTO) ═══

Prima di scrivere qualunque cosa, valuta se la fonte ha un nesso REALE e VERIFICABILE con la vita del frontaliere Ticino-Italia. Esempi di nesso reale:
- Norme/sentenze su Permesso G o B, fiscalità CH-IT (imposta alla fonte, nuovo accordo, ristorni, doppia imposizione, dichiarazione frontalieri)
- AVS/LPP/LAMal/CMI, busta paga svizzera, secondo/terzo pilastro
- Dogane e valichi (Chiasso, Brogeda, Gaggiolo, Ponte Tresa), pendolarismo CH-IT, autostrade A2/A9, traffico transfrontaliero, scioperi/eventi che bloccano i flussi pendolari
- Mercato del lavoro ticinese, salari/sciopero in aziende che assumono frontalieri, telelavoro frontaliere
- Accordi bilaterali CH-IT/UE, banche e cambio CHF-EUR, costo della vita Ticino vs Italia di confine

Esempi che NON sono nesso reale: cronaca nera senza nesso lavoro CH (omicidi comuni, sparizioni, processi non-frontalieri), eventi USA/UE/ROW senza impatto pendolare, sport, cultura/intrattenimento non-frontaliero, infrastruttura italiana lontana dal confine (Roma/Napoli/Palermo), eventi a Malpensa SENZA impatto sui voli/transito frontaliero.

REGOLA OPERATIVA — se il nesso NON c'è in modo concreto e specifico, devi RIFIUTARTI di generare l'articolo e restituire SOLTANTO questo JSON:
{
  "abort_topical_relevance": true,
  "reason": "<1-2 frasi che spiegano perché la fonte non ha un nesso reale con il frontaliere Ticino-Italia>"
}

NON inventare un angolo "implicazioni per i frontalieri" su un evento non-frontaliero per riempire spazio. NON aggiungere paragrafi di consigli generici (consulta un avvocato, verifica l'assicurazione, conosci i tuoi diritti) come surrogato di un nesso reale. Meglio rifiutare e far passare il prossimo articolo.`
    : `═══ REGOLA #0 — GATE DI RILEVANZA TOPICA (BLOCCANTE — PRIMA DI TUTTO) ═══

Prima di scrivere qualunque cosa, valuta se la fonte ha un nesso REALE e VERIFICABILE con la vita di chi vive o lavora in Svizzera a livello NAZIONALE. Esempi di nesso reale:
- Politica e decisioni federali o cantonali (Consiglio federale, Parlamento, votazioni, leggi, ordinanze cantonali)
- Fiscalità nazionale e cantonale (imposta federale diretta, IVA, imposte cantonali/comunali, dichiarazione, deduzioni)
- Mercato del lavoro, salari, salario minimo cantonale, disoccupazione, contratti collettivi
- Costo della vita, inflazione, affitti/casa, premi cassa malati (LAMal/KVG), energia
- Previdenza (AVS/AHV, LPP/BVG, terzo pilastro), banche, BNS/SNB, cambio, economia, imprese
- Dati ufficiali UST/BFS, SECO, SEM su economia, demografia, occupazione, prezzi

Esempi che NON sono nesso reale: cronaca nera senza rilevanza politico-economica (omicidi comuni, sparizioni, incidenti isolati), sport, cultura/intrattenimento/gossip senza impatto su politica o economia, eventi esteri senza ricaduta sulla Svizzera.

REGOLA OPERATIVA — se il nesso NON c'è in modo concreto e specifico, devi RIFIUTARTI di generare l'articolo e restituire SOLTANTO questo JSON:
{
  "abort_topical_relevance": true,
  "reason": "<1-2 frasi che spiegano perché la fonte non ha un nesso reale con la vita di chi vive o lavora in Svizzera>"
}

NON inventare un angolo "implicazioni pratiche" su un evento irrilevante per riempire spazio. NON aggiungere paragrafi di consigli generici (consulta un avvocato, verifica l'assicurazione, conosci i tuoi diritti) come surrogato di un nesso reale. Meglio rifiutare e far passare il prossimo articolo.`;

  const styleColorLine = IS_FRONTALIERE
    ? `Colore locale: valichi (Brogeda, Gaggiolo), comuni (Chiasso, Mendrisio), uffici cantonali.`
    : `Colore locale/nazionale: città e cantoni (Zurigo, Ginevra, Berna, Basilea, Losanna, Lugano…), istituzioni federali (Consiglio federale, Parlamento, BNS), uffici cantonali.`;

  const ticinoScopeBlock = IS_FRONTALIERE
    ? `TICINO: L'articolo DEVE riguardare Canton Ticino, confine italo-svizzero, o frontalieri. Riferimenti locali: Canton Ticino, SUPSI, USI, EOC, Lugano, Bellinzona, Locarno, Mendrisio, DFE, SECO.`
    : `SCOPE NAZIONALE: L'articolo riguarda la Svizzera a livello nazionale. I riferimenti possono spaziare su tutti i cantoni e città (Zurigo, Ginevra, Berna, Basilea, Losanna, Lugano…) e sulle istituzioni federali (Consiglio federale, Parlamento, Amministrazione federale, UST/BFS, SECO, BNS/SNB) — non solo il Ticino.`;

  const editorialFundamentalBlock = IS_FRONTALIERE
    ? `REGOLA EDITORIALE FONDAMENTALE — FRONTALIERI AL CENTRO (CONDIZIONALE):
Se la fonte ha implicazioni CONCRETE e SPECIFICHE per il frontaliere (importi CHF/EUR cambiati, scadenze fiscali, procedure modificate, permessi, valichi, accordi CH-IT, AVS/LPP/LAMal, busta paga, autostrade A2/A9, sciopero che blocca pendolari):
- Il frontaliere deve essere il PROTAGONISTA dell'articolo dall'inizio alla fine.
- NON è accettabile aggiungere una sezione "Impatto sui frontalieri" solo in fondo.
- ALMENO il 50% del testo dei campi body1, body2, body3 deve essere indirizzato al lettore frontaliere con dati pratici (importi, scadenze, procedure), guide operative (checklist, step-by-step, confronto scenari) e informazioni azionabili (cosa fare, dove andare, documenti).

Se le implicazioni sono DEBOLI o GENERICHE (la fonte non parla direttamente di frontalieri, ma il contesto può essere tangenzialmente utile):
- Limita la copertura a 1-2 paragrafi brevi di contesto. NON gonfiare l'articolo con platitudini ("consulta un avvocato", "verifica la copertura", "conosci i tuoi diritti", "informati sulle leggi locali").
- Onestamente dichiara nel body1 cosa la fonte dice E NULLA DI PIÙ, e segnala in body2/body3 i 1-2 ganci pratici reali (se esistono). Meglio un articolo da 400 parole onesto che 1200 parole di forzatura.
- Se anche 1-2 paragrafi di nesso reale non esistono → torna al GATE DI RILEVANZA TOPICA (REGOLA #0) e rifiuta con "abort_topical_relevance": true.

Il notizia/evento è solo il punto di partenza. Il valore sta nelle implicazioni PRATICHE per chi vive in Italia e lavora in Svizzera. Se queste implicazioni non esistono, l'articolo non doveva essere generato.`
    : `REGOLA EDITORIALE FONDAMENTALE — INTERESSE NAZIONALE AL CENTRO (CONDIZIONALE):
Se la fonte ha implicazioni CONCRETE e SPECIFICHE per chi vive o lavora in Svizzera (importi CHF cambiati, scadenze fiscali, nuove leggi federali/cantonali, premi cassa malati, affitti, salari, AVS/LPP, IVA, decisioni del Consiglio federale o dei cantoni):
- Le implicazioni pratiche a livello nazionale/cantonale devono essere al CENTRO dell'articolo dall'inizio alla fine.
- NON è accettabile aggiungere una sezione "implicazioni pratiche" solo in fondo.
- ALMENO il 50% del testo dei campi body1, body2, body3 deve dare al lettore dati pratici (importi, scadenze, procedure), guide operative (checklist, step-by-step, confronto scenari) e informazioni azionabili (cosa fare, dove andare, documenti) a livello nazionale o cantonale.

Se le implicazioni sono DEBOLI o GENERICHE (la fonte non ha un impatto pratico diretto, ma il contesto può essere tangenzialmente utile):
- Limita la copertura a 1-2 paragrafi brevi di contesto. NON gonfiare l'articolo con platitudini ("consulta un avvocato", "verifica la copertura", "conosci i tuoi diritti", "informati sulle leggi locali").
- Onestamente dichiara nel body1 cosa la fonte dice E NULLA DI PIÙ, e segnala in body2/body3 i 1-2 ganci pratici reali (se esistono). Meglio un articolo da 400 parole onesto che 1200 parole di forzatura.
- Se anche 1-2 paragrafi di nesso reale non esistono → torna al GATE DI RILEVANZA TOPICA (REGOLA #0) e rifiuta con "abort_topical_relevance": true.

Il notizia/evento è solo il punto di partenza. Il valore sta nelle implicazioni PRATICHE per chi vive o lavora in Svizzera. Se queste implicazioni non esistono, l'articolo non doveva essere generato.`;

  const body2AntiRepLine = IS_FRONTALIERE
    ? `- body2 = ANALISI PRATICA: implicazioni per i frontalieri, confronti prima/dopo, scenari concreti. Informazione che NON era nel body1.`
    : `- body2 = ANALISI PRATICA: implicazioni concrete a livello nazionale/cantonale, confronti prima/dopo, scenari concreti. Informazione che NON era nel body1.`;
  const body3AntiRepLine = IS_FRONTALIERE
    ? `- body3 = AZIONE: cosa fare concretamente, scadenze, procedura step-by-step, strumenti del sito. NON riassumere body1 o body2.`
    : `- body3 = AZIONE: cosa fare concretamente in Svizzera, scadenze, procedura step-by-step, strumenti del sito. NON riassumere body1 o body2.`;

  const ctaDefaultLine = IS_FRONTALIERE
    ? `CTA: body3 DEVE terminare con CTA verso strumenti del sito. Default: calcolatore stipendio. Temi specifici: assicurazione→health, pensioni→pension, costo vita→cost-of-living, cambio→exchange, IRPEF/comuni→border-map, auto→car-transfer, permessi→permit-compare, casa→renovation, telefonia→mobile, congedo→parental-leave, vivere CH→living-ch, vivibilità→livability.`
    : `CTA: body3 DEVE terminare con CTA verso strumenti del sito. Default: calcolatore stipendio. Temi specifici: assicurazione→health, pensioni→pension, costo vita→cost-of-living, cambio→exchange, casa→renovation, telefonia→mobile, congedo→parental-leave, vivere CH→living-ch, vivibilità→livability. Usa il tool più pertinente al tema dell'articolo.`;

  const imagePromptSchemaLine = IS_FRONTALIERE
    ? `"imagePrompt": "Prompt per immagine fotorealistica DSLR ambientata in Ticino. Max 2 frasi EN.",`
    : `"imagePrompt": "Prompt per immagine editoriale fotorealistica DSLR di una scena svizzera nazionale/cantonale pertinente al tema. Max 2 frasi EN.",`;
  const imagePromptFinalLine = IS_FRONTALIERE
    ? `- imagePrompt: scena fotorealistica Ticino, DSLR, non sembrare AI`
    : `- imagePrompt: scena svizzera nazionale/cantonale pertinente al tema, fotorealistica, DSLR, non sembrare AI`;

  // Organic/news sources (real URL) carry no ground-truth facts — only the
  // evergreen:// and stats-bfs:// branches bake EVERGREEN_FACTS_BRIEF into
  // pageContent upstream (see the evergreen prompt builder above). Without it,
  // a model filling REGOLA #1's requested "implicazioni pratiche" gap reaches
  // for training-data recall instead, and the fact-checker's own copy of these
  // exact values (VERIFIED_DOMAIN_FACTS) then flags any mismatch as critical —
  // the dominant failure mode observed on local/fallback runs (2026-07-06).
  // Feeding the same compact brief here closes the generator/checker grounding
  // gap for every model in the cascade, not just local.
  const isSyntheticSource = url.startsWith('evergreen://') || url.startsWith('stats-bfs://');

  // The blocking factuality gates, stated to the writer BEFORE it writes
  // instead of being discovered after it has written — see buildSourceContract
  // for the measured cost of the open loop this closes (run 30442955458: 8
  // headlines × 6 attempts, 48 articles generated, none published, recall
  // falling 38% → 13% → 0% across one headline's retries because every attempt
  // was as blind as the first).
  //
  // Built from the FULL pageContent, deliberately NOT truncatedContent: the
  // recall gate reads the whole source, so an anchor sitting past
  // MAX_SOURCE_CHARS is demanded by the gate while being invisible in the
  // prompt. Listing the anchors explicitly is what makes those satisfiable.
  //
  // Skipped for synthetic sources (evergreen://, stats-bfs://): they carry no
  // scraped source text and the fidelity gate does not apply to them.
  const sourceContract = isSyntheticSource ? '' : buildSourceContract({
    sourceText: pageContent || '',
    sourceDate: lastSourcePublishedAt || undefined,
    publishedAt: new Date().toISOString(),
  });

  // Section-aware (#96). Questo blocco NON alimenta il gate di recall — li' il
  // denominatore e' `pageContent`, cioe' la pagina scrapata — quindi era una
  // meta' meno letale del difetto. Restava pero' la stessa contraddizione di
  // grounding: a un articolo svizzero nazionale venivano offerti gli scaglioni
  // IRPEF come «fatti di dominio», ed e' materiale che un modello debole poi
  // usa davvero.
  const domainFactsBlock = isSyntheticSource ? '' : `\nFATTI DI DOMINIO VERIFICATI (materiale di riferimento per contesto/implicazioni pratiche, SEPARATO dalla notizia sopra — non attribuirli alla fonte, usali solo se pertinenti al tema):\n${evergreenFactsBriefFor(SECTION_NAME)}\n`;

  const prompt = `${systemRoleLine}

SOURCE URL: ${url.startsWith('evergreen://') ? '(editorial research)' : url.startsWith('stats-bfs://') ? 'https://www.bfs.admin.ch/bfs/it/home/statistiche/industria-servizi.html (BFS)' : url}
SOURCE CONTENT:
${truncatedContent}
${domainFactsBlock}
${sourceContext?.headline ? `\nHEADLINE: ${sourceContext.headline}` : ''}
${relatedContext ? `\nRELATED:\n${relatedContext}` : ''}

${idsSection}
⚠️ The "id" must NOT share >60% words with any existing ID.

${topicalRelevanceGate}
${sourceContract ? `\n${sourceContract}\n` : ''}
═══ REGOLA #1 — FEDELTÀ ALLA FONTE (PRIORITÀ MASSIMA) ═══

Il tuo articolo è una RISCRITTURA EDITORIALE della fonte, NON un articolo originale. Questo significa:
- OGNI fatto, cifra, data, legge, aliquota, istituzione e statistica DEVE essere presente nel SOURCE CONTENT sopra.
- Se la fonte dice "la nuova legge prevede X", scrivi "la nuova legge prevede X" — NON aggiungere dettagli che la fonte non menziona.
- Se la fonte NON specifica una data, un importo, un numero di legge o un nome di istituzione: NON inventarlo. Scrivi "non ancora specificato" o omettilo.
- Le citazioni dirette devono essere VERBATIM dalla fonte. Se parafrasate, usa il discorso indiretto.
- NON aggiungere "contesto di background" non verificabile (es. date di trattati, numeri di legge, statistiche) a meno che non sia nella fonte.

COME RAGGIUNGERE IL MINIMO DI PAROLE SENZA INVENTARE:
${reachMinimumImplicationsLine}
- Descrivi PROCEDURE concrete (cosa fare, dove andare, quali documenti servono)
- Aggiungi SCENARI "cosa succede se" basati sui fatti della fonte
- Confronta con la situazione precedente (prima vs dopo il cambiamento descritto nella fonte)
- NON includere sezioni FAQ nel body — le FAQ vengono generate nel campo "faq" separato e mostrate come accordion
- Usa tabelle comparative per rendere i dati della fonte più leggibili
- Collega agli strumenti del sito (calcolatore, comparatore, guide) per approfondire
${primaryLocaleBlock}${targetKeywordBlock}${peopleAlsoAskBlock}${mustCoverLsiBlock}${AI_SEARCH_PROMPT_BLOCK_IT}
═══ REGOLE EDITORIALI ═══

STILE: Scrivi come giornalista finanziario italiano reale, NON come AI. Varia lunghezza frasi (da 5 a 30 parole). Alterna paragrafi brevi (1-2 frasi) a paragrafi più lunghi. Usa numeri, date, luoghi reali, istituzioni — MA SOLO se presenti nella fonte. ${styleColorLine}
MAI usare: "In conclusione", "È importante notare", "In questo contesto", "Vale la pena", "È fondamentale", "Alla luce di", "Ecco cosa sapere", "Vediamo nel dettaglio", "Andiamo con ordine", "Non è un caso che", "Un aspetto cruciale", "Sempre più", "In un contesto di".
Linguaggio diretto: "conviene" non "potrebbe essere utile". Il testo DEVE superare AI detection.
ANTI-AI (CRITICO): Il testo NON deve sembrare generato da AI. Regole:
- MAI aprire body1 con una frase generica tipo "Il tema dei frontalieri...". Inizia con un FATTO concreto DALLA FONTE (data, numero, nome, luogo).
- MAI elenchi puntati di >5 elementi (spezzali in paragrafi narrativi)
- MAX 2 emoji callout (📊/💡/⚠️) per INTERO articolo (body1+body2+body3 combinati). Zero è meglio.
- Varia la struttura: non TUTTI i body devono avere un elenco puntato. Alterna prosa, tabelle, citazioni.
- NON usare parallelismi strutturali tra body1/body2/body3 (se body1 ha ## + elenco, body2 deve avere ## + prosa + tabella).

${ticinoScopeBlock}

═══ DIVIETI ANTI-ALLUCINAZIONE (BLOCCANTI — RIGETTO AUTOMATICO) ═══

L'articolo viene verificato da un SECONDO modello AI indipendente (fact-checker) che confronta OGNI affermazione con la fonte e con le proprie conoscenze. Inventare anche UN SOLO dato = rigetto.

LEGGI E DECRETI:
- Cita riferimenti normativi SOLO se appaiono LETTERALMENTE nella fonte.
- Se la fonte dice "la nuova normativa" senza specificare il numero, scrivi "la nuova normativa" — NON inventare "D.Lgs XXX/YYYY".
- Leggi verificate (usabili SOLO se pertinenti e nella fonte): DPR 917/1986 (TUIR), D.Lgs 147/2015, DL 167/2024, L. 207/2024 (Bilancio 2025), D.Lgs 241/1997, DL 78/2010.
- La Convenzione italo-svizzera è del 9 DICEMBRE 1976. Il Nuovo Accordo Frontalieri è stato firmato il 23 DICEMBRE 2020.

ISTITUZIONI:
- NON inventare acronimi. Enti reali: SECO, USTAT, UFSP/BAG, SUVA, DFE, DSS, SEM, INPS, Agenzia Entrate, MEF.
- NON esiste: "Codice federale del lavoro", "CFL", "UFOL", "UWL", "USTTI", "Commissione federale per i frontalieri".

STATISTICHE:
- MAI scrivere "secondo uno studio/sondaggio" senza NOME, ANNO e ISTITUTO presenti nella fonte.
- MAI inventare percentuali precise (es. "il 73,2%"). Se la fonte non le riporta, non usarle.
- MAI inventare "rapporti annuali" con dati specifici.

FATTI E DICHIARAZIONI:
- NON attribuire dichiarazioni a politici, enti o funzionari se non citate nella fonte.
- NON inventare eventi (conferenze, proteste, referendum) non menzionati nella fonte.
- Se non sei CERTO che un fatto sia nella fonte, OMETTILO.

ANTI-CLICKBAIT (CRITICO — Google Discover compliance):
- Il titolo DEVE essere DESCRITTIVO e SPECIFICO: soggetto + azione + contesto.
  ✅ Buono: "Aumento stipendi minimi in Ticino: +2.3% dal 1° gennaio 2026"
  ❌ Vietato: "Tutto quello che devi sapere sugli stipendi in Ticino"
- MAI titoli vaghi: "tutto cambia", "ecco perché", "scopri cosa", "shock", "clamoroso", "incredibile", "non crederai"
- MAI domande retoriche come titolo ("Ma davvero i frontalieri...?")

TOPIC GUARD: per articoli su "tassa salute", NON invertire la platea (es. "lavora in Lombardia e risiede in Ticino") se non esplicitamente indicata nella fonte.

${ctaDefaultLine}

INTERNAL LINKS — REGOLA QUANTITATIVA:
MINIMO 3 link interni totali distribuiti nei body, sintassi \`[testo](nav:azione)\`:
- 1 in body1 o body2 (contestuale al fatto)
- 1 in body2 o body3 (contestuale all'analisi)
- 1 nella CTA finale di body3 (calculator preferito)
Se l'articolo supera 1200 parole, aumenta a MINIMO 4 link.

LINK INTERNI — sintassi ESCLUSIVA: [testo](nav:azione)
${IS_FRONTALIERE ? `Azioni e SEMANTICA STRETTA (il testo del link DEVE matchare l'azione, altrimenti il link viene strippato):
- calculator → calcolatore FISCALE: stipendio, netto, busta paga, imposte, tasse. NON usare per tragitti, meteo, percorsi.
- exchange → comparatore CHF/EUR (cambio valuta). NON usare per meteo, traffico, percorsi.
- health → LAMal/CMI assicurazione malattia. - cost-of-living → costo della vita Ticino vs Italia. - pension → AVS/LPP/rendita.
- pillar3 → terzo pilastro 3a. - payslip → simulatore busta paga. - tax-return → dichiarazione redditi.
- residency → Permesso B residenza. - ristorni → ristorni Ticino-Italia. - unemployment → disoccupazione frontalieri.
- jobs → annunci lavoro. - companies → aziende che assumono. - banks → conti bancari frontaliere.
- first-day → checklist primo giorno. - permits → Permesso G/B. - border → tempi attesa valichi (Brogeda, Chiasso…).
- transport → mezzi pubblici Ticino. - car-cost → costo auto pendolare (vignette, parcheggio).
- traffic-history → storico traffico/code ai valichi. - border-map → mappa valichi.
- car-transfer → trasferimento targa CH. - permit-compare → comparatore Permesso G vs B.
- nursery → asilo nido. - parental-leave → congedo parentale.
- (NON esistono tool per: meteo, allerta maltempo, condizioni meteorologiche, navigatore stradale, calcolatore tragitti, route planner. NON inventare link nav: per questi temi.)` : `Azioni e SEMANTICA STRETTA (il testo del link DEVE matchare l'azione, altrimenti il link viene strippato). Usa SOLO queste azioni a respiro nazionale:
- calculator → calcolatore stipendio/imposte. NON usare per tragitti, meteo, percorsi.
- exchange → comparatore CHF/EUR (cambio valuta). NON usare per meteo, traffico, percorsi.
- health → LAMal/cassa malati. - cost-of-living → costo della vita in Svizzera. - pension → AVS/LPP/rendita.
- pillar3 → terzo pilastro 3a. - payslip → busta paga svizzera. - tax-return → dichiarazione delle imposte.
- jobs → annunci di lavoro. - companies → aziende che assumono. - banks → conti bancari in Svizzera.
- transport → mezzi pubblici. - nursery → asilo nido. - parental-leave → congedo parentale.
- (NON usare azioni a tema frontaliere/Ticino-Italia, ristorni, permessi G/B, valichi/dogane: questa è la sezione nazionale Svizzera.)
- (NON esistono tool per: meteo, allerta maltempo, condizioni meteorologiche, navigatore stradale, calcolatore tragitti, route planner. NON inventare link nav: per questi temi.)`}
MAI usare <a href> o URL diretti.

CTA / PROMOZIONI — divieti assoluti:
- MAI promuovere newsletter, app o servizi di Tio, CDT, La Regione, RSI, TVS, Ticinonews, Varesenews, Comozero, Corriere, Swissinfo, ilgiornaledelticino o altre testate citate come fonte. La newsletter promossa è SEMPRE quella di Frontaliere Ticino (link nav:calculator o nav:jobs come gancio).
- "Iscriviti alla newsletter giornaliera di [fonte]" / "scarica l'app di [fonte]" sono frasi BANDITE — anche se la fonte le ha originali, vanno omesse.

GRASSETTO: max 2-3 parole in grassetto per INTERO campo body. MAI grassetto su importi (350 CHF), etichette (Caso 1:), frasi >5 parole, nomi strumenti. Preferire ZERO grassetto.
FORMATTAZIONE: ## sottotitoli, ### sotto-sottotitoli, - elenchi, > citazioni (MAX 1 per articolo — solo se c'è una vera citazione dalla fonte), 📊 dati, 💡 consigli, ⚠️ avvertenze. Blocchi separati con \\n\\n. NON usare > per paragrafi normali — solo per citazioni dirette brevi (1-2 frasi).
STRUTTURA H3 (CRITICO): Ogni body con >250 parole DEVE avere almeno 1 sotto-sezione ### (H3).

ANTI-RIPETITIVITÀ (CRITICO): I tre body DEVONO avere contenuti DIVERSI. Mai ripetere lo stesso concetto tra body1, body2, body3.
- body1 = FATTI DALLA FONTE: chi ha deciso/annunciato cosa, quando, dove, perché. Cronaca pura basata sul SOURCE CONTENT.
${body2AntiRepLine}
${body3AntiRepLine}

${editorialFundamentalBlock}

═══ DIVIETO ASSOLUTO — INVENZIONE DI CASI O ESEMPI (CRITICO) ═══

È VIETATO inventare casi specifici (persona + luogo + ruolo + verbo + esito/cifra) per gonfiare la rilevanza frontaliere o riempire spazio. Il fact-check tratta come FALSE INFORMATION qualunque "esempio concreto" non presente nella fonte.

PATTERN ESPLICITAMENTE PROIBITI (anche se sembrano plausibili):
- "Lugano: Un'infermiera frontaliera ha segnalato carenze igieniche..." (FABBRICAZIONE)
- "Chiasso: Un medico ha denunciato pratiche non etiche..." (FABBRICAZIONE)
- "Un infermiere dell'ORL ha ottenuto un recupero di CHF 50.000..." (FABBRICAZIONE)
- "Un medico dell'Ospedale Civico di Lugano ha denunciato..." (FABBRICAZIONE)
- Qualunque bullet del tipo "- [Città CH]: Un [ruolo] ha [verbo]..." dove né la persona, né il luogo, né il caso sono nella fonte originale.
- Qualunque legge inventata con sigla approssimativa: "LProtInfo 2023" (non esiste — è art. 321a CO), "LPAP 2000" (è LPers, non LPAP). Se non sei certo della SIGLA UFFICIALE di una legge, NON citarla.

REGOLE OPERATIVE:
1. Sezioni titolate "Esempi concreti / Casi pratici / Casi reali / Per esempio" sono AMMESSE solo se gli esempi vengono ESPLICITAMENTE dalla fonte (con citazione/dettagli verificabili nella fonte originale).
2. Se la fonte non contiene casi reali → OMETTI la sezione "Esempi concreti". Mai inventare per riempire.
3. Se hai bisogno di un esempio ipotetico, usa frasing GENERICO E DICHIARATAMENTE IPOTETICO: "Un frontaliere che si trovi in una situazione simile potrebbe…" (senza nomi di città, ruoli specifici o cifre inventate).
4. Cifre specifiche (CHF 50.000, 200 CHF, 1.80 CHF/litro, percentuali precise) sono AMMESSE solo se nella fonte o in dato pubblico ufficiale. Se non puoi citare la fonte, non inserire il numero.
5. Nomi di istituzioni (FINMA, USTAT, UFAS, INSAI, SUVA) sono AMMESSI solo se RILEVANTI per il caso. FINMA = mercati finanziari/banche, NON ospedali/sanità. Non applicare istituzioni a domini sbagliati.

VIOLAZIONE = articolo bocciato in fact-check con verdict=FAIL + critical:fatti_inventati. Il sistema rimuove automaticamente sezioni "Esempi concreti" sospette anche se passano il fact-check.

Genera JSON (no markdown, no code fences):
{
  "id": "kebab-case-3-5-words-max-40-chars",
  "category": "one of: ${CATEGORIES.join(', ')}",
  "image": "one of: ${AVAILABLE_IMAGES.slice(0, 15).join(', ')}... (scegli la più adatta)",
  "hasCalculator": true,
  ${imagePromptSchemaLine}
  "imageAlt": { "it": "max 125 chars", "en": "max 125 chars", "de": "max 125 chars", "fr": "max 125 chars" },
  "slugs": { "it": "slug-it", "en": "slug-en", "de": "slug-de", "fr": "slug-fr" },
  "content": {
    "it": {
      "title": "Titolo giornalistico con keyword (OBBLIGATORIO ≤ 60 caratteri totali, target 50-55. Il suffisso ' | Frontaliere Ticino' viene aggiunto automaticamente — NON includerlo nel title)",
      "excerpt": "Sottotitolo con dati concreti DALLA FONTE (max 160 chars)",
      "body1": "Inizia con '## In breve' (3-4 bullet TL;DR ≤80 char) + '## Fatti chiave' (5-8 coppie **Cosa/Quando/Dove/Chi/Importo**: valore). Poi il LEAD: FATTI dalla fonte (chi, cosa, dove, quando, perché). Solo cronaca verificabile. 300-400 parole (escluse TL;DR/Fatti chiave). Min 1 ### sotto-sezione.",
      "body2": "Analisi pratica: implicazioni, confronti, scenari. Contenuto DIVERSO da body1. 300-400 parole. Min 1 ### sotto-sezione.",
      "body3": "Azione: procedura step-by-step, scadenze, strumenti + CTA finale. NON riassumere body1/body2. 300-400 parole.",
      "faq": [
        {"q": "Domanda frequente 1 basata sui fatti dell'articolo?", "a": "Risposta con dati DALLA FONTE. 50-100 parole."},
        {"q": "Domanda frequente 2?", "a": "Risposta pratica basata sulla fonte."},
        {"q": "Domanda frequente 3?", "a": "Risposta con procedura o scadenza dalla fonte."}
      ]
    }
  },
  "seo": {
    "title": "SEO Title senza brand suffix (OBBLIGATORIO ≤ 60 caratteri TOTALI; il suffisso ' | Frontaliere Ticino' viene aggiunto automaticamente — NON includerlo)",
    "description": "Meta description 150-160 chars (HARD CAP: ≤ 160 caratteri)",
    "keywords": "6-8 keywords IT",
    "ogTitle": "OG title (OBBLIGATORIO ≤ 60 caratteri)",
    "ogDescription": "OG desc per la card social — 200-250 caratteri, NON una copia della description: Facebook/LinkedIn/WhatsApp mostrano molto piu' di una SERP (HARD CAP: ≤ 250 caratteri)",
    "headline": "Headline JSON-LD",
    "breadcrumbName": "Breadcrumb 2-3 parole"
  }
}

REGOLE FINALI:
- Contenuto IT primario, MINIMO 350 parole per body (body1/body2/body3). EN/DE/FR verranno generati separatamente.
- Per raggiungere il minimo: espandi con implicazioni pratiche, procedure, scenari — NON con fatti inventati. NON inserire FAQ nel body (vanno nel campo "faq" separato).
- Slug: lowercase, trattini, no accenti, max 50 chars
- hasCalculator: true sempre
- Apostrofi diritti ('), normative 2026
${imagePromptFinalLine}
- FAQ: genera 3-5 coppie domanda/risposta basate sui FATTI della fonte. Risposte: 50-100 parole, con dati concreti dalla fonte.`;

  const minWordsInstruction = `\n\nMINIMUM LENGTH (CRITICAL — STRICTLY ENFORCED):
- body1+body2+body3 MUST total ≥${minItalianWords} words. This is HARD-enforced: content below this threshold will be REJECTED.
- EACH body field (body1, body2, body3) MUST be at least 300 words individually. Target 350-400 words each.
- Use detailed examples, step-by-step procedures, concrete numbers/dates, comparison tables, and checklists to reach the target. Do NOT put FAQ in body text — FAQs go in the separate "faq" field.
- Count your words before finalizing. If the total is <${minItalianWords}, ADD more content.
${generationAttempt > 1 ? `- ⚠️ RETRY ${generationAttempt}/${generationAttemptMax}: previous attempt was REJECTED because it was only ~${sourceContext?._previousWordCount || '???'} words (minimum: ${minItalianWords}). You MUST write SIGNIFICANTLY MORE this time. Each body: 350-450 words.${generationAttempt >= 4 ? ' Include: comparison tables, step-by-step guides with numbered steps, specific examples with real numbers. Do NOT put FAQ in body text.' : ''}` : ''}`;

  // A5 headline refinement: when the previous attempt produced a non-conformant
  // headline (clickbait, too long, leading digit, etc.) we inject explicit rules
  // into the prompt so the model has a concrete target.
  const headlineRefinementInstruction = sourceContext?._headlineRefinement
    ? `\n\nHEADLINE REQUIREMENTS (Google News compliance — STRICTLY ENFORCED):
- title length: 10–110 characters (target 50–60 characters)
- title word count: 2–22 whitespace-separated tokens
- title MUST NOT start with a digit
- title MUST NOT contain clickbait language (Italian: "non crederai", "scioccante", "incredibile", "sconvolgente", "clamoroso", "pazzesco"; English: "you won't believe", "shocking", "mind-blowing", "this one weird trick")
- title MUST NOT end with multiple "?" or "!" (no "???", "!!", "!!!", etc.)
- ⚠️ PREVIOUS ATTEMPT WAS REJECTED: ${sourceContext._headlineRefinement}. Rewrite the IT title and seo.headline so both are journalistic, specific, factual, and pass the rules above.`
    : '';

  // Fact-check refinement: when the previous attempt was rejected by the LLM
  // fact-checker, feed the EXACT flagged claims back into this attempt so the
  // model removes/corrects them instead of regenerating blind and re-inventing
  // similar figures (the dominant failure mode on fact-dense frontaliere
  // articles under degraded free-model quality — drafts stuck since 2026-06-18).
  // Targeted feedback, NOT a relaxed gate: every flagged claim must be dropped
  // or restated strictly from SOURCE CONTENT.
  const factCheckRefinementInstruction = sourceContext?._factCheckRefinement
    ? `\n\n═══ ⚠️ TENTATIVO PRECEDENTE RIGETTATO DAL FACT-CHECK — CORREGGI QUESTE AFFERMAZIONI ═══
Il fact-checker indipendente ha bocciato la bozza precedente perché le seguenti affermazioni NON sono supportate dal SOURCE CONTENT:
${sourceContext._factCheckRefinement}
ISTRUZIONI TASSATIVE per questo tentativo:
- Per OGNI affermazione elencata sopra: RIMUOVILA del tutto, oppure riscrivila usando SOLO ciò che è LETTERALMENTE nel SOURCE CONTENT.
- NON sostituire una cifra/data/legge/istituzione inventata con un'altra inventata: se il dato non è nella fonte, OMETTILO e raggiungi il minimo parole con procedure, scenari e confronti (come da REGOLA #1).
- NON reintrodurre lo stesso tipo di invenzione altrove nel testo.`
    : '';

  // ── Multi-call generation with automatic model fallback ──
  // Supports model override via sourceContext._forceModel and temperature via sourceContext._temperature
  const forceModel = sourceContext?._forceModel;
  const temperature = Number(sourceContext?._temperature || 0.7);
  const useGeminiDirect = forceModel === 'gemini';
  const effectiveModel = useGeminiDirect ? `Gemini ${AI_MODELS.GEMINI_FLASH}` : (forceModel || GH_MODEL_HEAVY);

  // Call 1: Italian content + metadata (id, category, image, slugs, imagePrompt, imageAlt)
  console.error(`🤖 [1/5] Generazione contenuto IT + metadata con ${effectiveModel}...`);

  // ── Patch J: localized system stem + user instruction ──
  const systemStem = {
    it: 'Sei un giornalista finanziario esperto',
    de: 'Du bist ein erfahrener Finanzjournalist',
    fr: 'Tu es un journaliste financier expérimenté',
    en: 'You are a senior financial journalist',
  }[primaryLocale];
  const otherLocalesNote = primaryLocale === 'it'
    ? 'NON includere content.en, content.de, content.fr — verranno generati separatamente.'
    : 'NON includere le altre 3 lingue — verranno generate separatamente.';

  const systemRoleQualifier = IS_FRONTALIERE
    ? 'di lavoro transfrontaliero in Ticino'
    : 'di affari svizzeri a livello nazionale';
  const llmMessages = [
    { role: 'system', content: `${systemStem} ${systemRoleQualifier} che RISCRIVE articoli basandosi FEDELMENTE sulla fonte originale.

REGOLA FONDAMENTALE: Ogni fatto, dato, legge, data, cifra e istituzione nel tuo articolo DEVE provenire dal testo SOURCE CONTENT fornito. Se un'informazione NON è nella fonte, NON includerla. Mai inventare, dedurre o "completare" dati mancanti.

QUANDO LA FONTE NON CONTIENE UN DATO: scrivi "non ancora specificato", "in fase di definizione", o ometti il dettaglio. NON inventare numeri, date o riferimenti normativi per riempire il testo.

${JSON_QUOTE_SAFETY_RULE_IT}

Rispondi SOLO con JSON valido, senza markdown.` },
    // Phase 3 prior: inject winner-fingerprint as additive system context.
    // Skipped when data/article-performance.json is missing or empty so the
    // prompt is byte-identical to today's behavior.
    ...(_winnerFingerprintMessage ? [{ role: 'system', content: _winnerFingerprintMessage }] : []),
    { role: 'user', content: prompt + minWordsInstruction + headlineRefinementInstruction + factCheckRefinementInstruction + `\n\n⚠️ ISTRUZIONE SPECIALE PER QUESTA CHIAMATA:\nGenera SOLO il JSON con questi campi: id, category, image, hasCalculator, imagePrompt, imageAlt (4 lingue), slugs (4 lingue), content.${primaryLocale} (title, excerpt, body1, body2, body3, faq), seo.\n${otherLocalesNote}` }
  ];

  // Pass a strict JSON schema so providers that support it (OpenAI/GitHub
  // Models, Groq, Mistral, Gemini) server-enforce body1/body2/body3 presence
  // and we don't burn 5 retries when a weak model silently drops body2/body3.
  const articleSchema = buildArticleJsonSchema(primaryLocale);
  let itRaw;
  if (useGeminiDirect) {
    itRaw = await callLLM(llmMessages, { model: AI_MODELS.GEMINI_FLASH, temperature, maxTokens: 8000, jsonMode: true, jsonSchema: articleSchema });
    console.error(`  ↪ Completato con Gemini ${AI_MODELS.GEMINI_FLASH}`);
  } else {
    itRaw = await callLLM(llmMessages, { model: forceModel || GH_MODEL_HEAVY, temperature, maxTokens: 8000, jsonMode: true, jsonSchema: articleSchema });
  }
  let itData;
  const itRepaired = repairLlmJson(itRaw);
  try {
    itData = JSON.parse(itRepaired);
  } catch (parseErr) {
    // One repair-aware regenerate before giving up. Truncation (output cap
    // hit) gets 2× tokens; structural corruption keeps the same budget so
    // we don't pay double for a transient `***`-between-properties glitch.
    console.error(`❌ JSON parse error: ${parseErr.message}`);
    console.error(`   ${describeJsonParseError(itRepaired, parseErr)}`);
    console.error(`   ${describeRawForDiagnostics(itRaw)}`);
    const isTruncation = /Unterminated|Unexpected end/i.test(parseErr.message);
    const retryTokens = isTruncation ? 16000 : 8000;
    console.error(`  🔄 Retry IT con maxTokens=${retryTokens}${isTruncation ? ' (troncamento rilevato)' : ''}...`);
    try {
      const itRaw2 = useGeminiDirect
        ? await callLLM(llmMessages, { model: AI_MODELS.GEMINI_FLASH, temperature: 0.3, maxTokens: retryTokens, jsonMode: true, jsonSchema: articleSchema })
        : await callLLM(llmMessages, { model: forceModel || GH_MODEL_HEAVY, temperature: 0.3, maxTokens: retryTokens, jsonMode: true, jsonSchema: articleSchema });
      itData = JSON.parse(repairLlmJson(itRaw2));
      console.error(`  ✅ Retry IT riuscito`);
    } catch (retryErr) {
      console.error(`  ❌ Retry IT fallito: ${retryErr.message}`);
      // qualityReject=true: malformed JSON after the repair-aware retry is a
      // content-quality failure, same class as callLLM's body2-validation
      // throws — isQualityRejectError() didn't match this message, so it
      // crashed the run instead of skipping to the next headline.
      const err = new Error(`JSON non valido dalla generazione IT: ${parseErr.message}`);
      err.qualityReject = true;
      throw err;
    }
  }

  // ── REGOLA #0 abort gate ──
  // The IT generation prompt instructs the model to return
  //   { "abort_topical_relevance": true, "reason": "..." }
  // when the source has no real frontaliere angle (Malpensa-class
  // hallucination defense). Treat the abort as a controlled failure so
  // the run report classifies it and the workflow's retry/self-trigger
  // path can pick a different headline instead of publishing slop.
  //
  // Self-contradiction guard (2026-07-06, run 28802314827): the schema's own
  // contract (see buildArticleJsonSchema above) requires the model to EITHER
  // set abort_topical_relevance and leave content null, OR fill content and
  // leave abort_topical_relevance null — never both. Weaker models (observed:
  // local/fallback qwen2.5:14b) sometimes set the abort flag while ALSO fully
  // populating content.it with a genuinely relevant article (the `reason`
  // text itself affirmed frontaliere relevance) — blindly trusting the flag
  // discarded a valid, on-topic article and burned the remaining retry
  // budget on doomed local/fallback re-attempts. When content is actually
  // present the model contradicted its own abort signal; trust the content
  // it produced over the flag instead of throwing.
  const itContentPreAbortCheck = itData?.abort_topical_relevance === true ? normalizeItalianContentFromPayload(itData) : null;
  if (itData?.abort_topical_relevance === true && !itContentPreAbortCheck) {
    const reason = String(itData.reason || '').slice(0, 500) || '(no reason)';
    console.error(`  ⏭️  [topic-gate] Generation aborted by REGOLA #0 — source lacks real frontaliere angle.`);
    console.error(`     Reason: ${reason}`);
    if (RUN_REPORT && typeof RUN_REPORT === 'object') {
      RUN_REPORT.topicGateAborts = (RUN_REPORT.topicGateAborts || 0) + 1;
      RUN_REPORT.lastTopicGateAbortReason = reason;
    }
    const err = new Error(`Topic-gate abort: ${reason}`);
    err.topicGateAbort = true;
    throw err;
  }
  if (itContentPreAbortCheck) {
    console.error(`  ⚠️  [topic-gate] Model set abort_topical_relevance=true but ALSO returned full content.it — contract violation, trusting content over the flag (reason given: "${String(itData.reason || '').slice(0, 200)}").`);
    if (RUN_REPORT && typeof RUN_REPORT === 'object') {
      RUN_REPORT.topicGateSelfContradictions = (RUN_REPORT.topicGateSelfContradictions || 0) + 1;
    }
  }

  const itContent = itContentPreAbortCheck || normalizeItalianContentFromPayload(itData);
  if (!itContent) {
    // qualityReject=true: same content-quality class as the JSON-parse and
    // missing-field siblings above/below — see their comments for why.
    const err = new Error('Risposta IT non contiene content.it e non può essere normalizzata');
    err.qualityReject = true;
    throw err;
  }
  validateItalianPayload(itContent, 'it');

  // ── Title length enforcement (Semrush ≤ 60 chars gate) ──
  // If the LLM produced a title > BLOG_TITLE_RETRY_THRESHOLD chars, retry once
  // with a stricter, title-only prompt. Anything still above BLOG_TITLE_MAX
  // is hard-truncated at a word boundary.
  {
    const firstCap = capBlogTitle(itContent.title);
    if (firstCap.originalLength > BLOG_TITLE_RETRY_THRESHOLD) {
      console.warn(`  ⚠️ [title-cap] IT title ${firstCap.originalLength} chars > ${BLOG_TITLE_RETRY_THRESHOLD} — retry titolo con istruzioni più strette...`);
      try {
        const retryRaw = await callLLM(
          [
            { role: 'system', content: `Sei un giornalista finanziario esperto. Rispondi SOLO con JSON valido senza markdown.\n\n${JSON_QUOTE_SAFETY_RULE_IT}` },
            {
              role: 'user',
              content: `Riformula il seguente titolo in italiano per il sito Frontaliere Ticino.\n\nTITOLO ATTUALE (${firstCap.originalLength} caratteri, troppo lungo):\n${itContent.title}\n\nVINCOLI OBBLIGATORI:\n- MASSIMO 60 caratteri totali (target 50-55).\n- NON includere il suffisso " | Frontaliere Ticino" (verrà aggiunto automaticamente).\n- Mantieni la keyword principale e il significato.\n- Stile giornalistico, niente clickbait.\n\nRispondi con JSON: {"title": "..."}`,
            },
          ],
          // Title reformulation is a short, low-stakes rewrite to ≤60 chars whose
          // length floor is guaranteed by the deterministic capBlogTitle() below
          // (and the try/catch falls back to the hard cap on any failure), so a
          // premium GPT-4o call here is wasted quota — GPT-4o-mini reformulates a
          // one-line title to a length target just as well. forceModel still wins.
          { model: forceModel || GH_MODEL_LIGHT, temperature: 0.3, maxTokens: 200, jsonMode: true, timeout: 30_000 },
        );
        const retryParsed = JSON.parse(repairLlmJson(retryRaw));
        if (retryParsed?.title && typeof retryParsed.title === 'string') {
          itContent.title = retryParsed.title;
          console.error(`  ✅ [title-cap] IT title ritornato a ${retryParsed.title.length} caratteri`);
        }
      } catch (retryErr) {
        console.warn(`  ⚠️ [title-cap] Retry titolo IT fallito: ${retryErr.message} — applico hard cap`);
      }
    }
    const finalCap = capBlogTitle(itContent.title);
    if (finalCap.truncated) {
      console.warn(`  ✂️ [title-cap] IT title truncato: ${finalCap.originalLength} → ${finalCap.value.length} chars`);
    }
    itContent.title = finalCap.value;
    // capBlogTitle only trims length/brand-suffix — it doesn't fix casing, so
    // an LLM that emits a fully-uppercase title (live incident, issue-driven
    // fix) slips through untouched. normalizeTitleCasing already existed for
    // the journalist-publish pipeline (publish-journalist-article.mjs) but was
    // never wired into this AI-generation path — closing that gap here.
    const casedTitle = normalizeTitleCasing(itContent.title);
    if (casedTitle !== itContent.title) {
      console.warn(`  🔡 [title-case] IT title normalizzato: "${itContent.title}" → "${casedTitle}"`);
      itContent.title = casedTitle;
    }
  }

  // normalizeTitleCasing() above bails out on a title that is already in
  // sentence case, and nothing at all ever looked at the excerpt. Both gaps
  // shipped on 2026-08-09 ("Frontaliere gruista ticino", "il stipendio medio",
  // "i frontaliere gruisti"). This runs unconditionally on both fields.
  applyMicrocopyGuard(itContent, 'it');

  // Preserve FAQ from AI response (not in REQUIRED_IT_BODY_FIELDS, extracted separately)
  const rawFaq = itData?.content?.it?.faq || itData?.content?.faq || itData?.faq;
  if (rawFaq) {
    if (!Array.isArray(rawFaq)) {
      console.error('  ⚠️  FAQ non è un array, lo rimuovo');
    } else {
      // ── Perche' il filtro di FORMA non bastava ─────────────────────────
      //
      // Il filtro qui sotto era `q.length > 10 && a.length > 20`. La domanda
      // segnaposto dello schema («Domanda frequente 1 basata sui fatti
      // dell'articolo?») e' lunga 50 caratteri e la sua risposta 44: passavano
      // entrambe, e la riga di log stampava «✅ FAQ: 3 coppie valide» mentre le
      // tre coppie ERANO lo schema. Una FAQ segnaposto e' strutturalmente
      // valida — si contano le coppie e si passa — e da qui finiva dritta nello
      // schema FAQPage (engine/ogPagesPlugin.ts:1354) come structured data
      // falso verso i motori di ricerca. Misurato: 24 articoli live.
      //
      // `cleanFaqPairs` aggiunge il controllo di CONTENUTO e tiene la soglia
      // delle 2 coppie dov'era, perche' e' la stessa dell'engine.
      const { pairs: cleaned, repaired, dropped } = cleanFaqPairs(rawFaq);
      if (dropped.length) {
        console.error(`  ⚠️  FAQ: ${dropped.length} coppie scartate (${dropped.map((d) => d.reason).join('; ')})`);
      }
      if (repaired) {
        console.error(`  ✍️  FAQ: ${repaired} coppie ripulite dall'etichetta dello schema`);
      }
      const validFaq = cleaned ? cleaned.slice(0, 7) : [];
      if (validFaq.length < 2) {
        console.error(`  ⚠️  FAQ troppo poche (${validFaq.length}), rimuovo`);
      } else {
        itContent.faq = validFaq;
        console.error(`  ✅ FAQ: ${validFaq.length} coppie valide`);
      }
    }
  }

  console.error(`  ✅ IT + metadata completati`);

  // Calls 2-4 are now deferred — see translateArticle() below
  // Return IT-only data so duplicate check can run before wasting translation API calls
  const result = {
    ...itData,
    content: {
      it: itContent,
    },
  };
  if (!result.seo && itData.seo) result.seo = itData.seo;
  console.error(`  ✅ Articolo IT generato`);
  return result;
}

function countWords(text = '') {
  return String(text)
    .replace(/\[[^\]]+\]\(nav:[^)]+\)/g, '$1')
    .replace(/[#>*`_~\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .length;
}

function italianBodyWordCount(data) {
  const it = data?.content?.it || {};
  return ['body1', 'body2', 'body3']
    .map((k) => countWords(it[k] || ''))
    .reduce((acc, n) => acc + n, 0);
}

/**
 * L'istruzione di arricchimento del prompt di espansione.
 *
 * `boundToText: true` è la variante per gli articoli il cui unico ground truth
 * è un dataset chiuso — oggi `stats-bfs://`. Estratta e nominata perché la
 * variante di default chiede ALLA LETTERA «esempi concreti con numeri reali,
 * riferimenti a comuni ticinesi specifici, normative con date e importi», e
 * l'espansione è l'ULTIMO passo prima della registrazione: gira dopo i gate
 * deterministici e dopo il fact-check, e il suo output non ne ripassa nessuno
 * (il ramo `break` subito sotto la chiamata). Su una fonte fatta di venti
 * numeri quell'istruzione non ha nulla di reale da cui pescare, e il modello
 * pesca dal training.
 *
 * Non è ipotetico: `frontalieri-ticino-stabili-2026-q1`, l'unica edizione BFS
 * finora pubblicata, contiene cifre per Lugano («da 12.000 a 11.950»), Chiasso,
 * Mendrisio, Bellinzona e Locarno, aliquote alla fonte per comune e premi
 * LAMal. Nessuno di questi dati esiste in `config/bfs_stats`. È uscito agli
 * iscritti con tutti i gate verdi.
 */
function expandEnrichmentLine(isFrontaliere, boundToText = false) {
  if (boundToText) {
    return '- Aggiungi PROFONDITÀ sui dati che il testo già contiene: confronti fra i numeri citati, lettura della tendenza, implicazioni qualitative, contesto verificabile. NON introdurre NESSUN numero, comune, aliquota, importo, data o percentuale che non sia già scritto nel TESTO ATTUALE qui sopra: la fonte di questo articolo è un dataset chiuso e ogni cifra in più sarebbe inventata.';
  }
  const geoRefs = isFrontaliere
    ? 'riferimenti a comuni ticinesi specifici'
    : 'riferimenti a cantoni o città svizzere pertinenti al tema';
  return `- Aggiungi: esempi concreti con numeri reali, ${geoRefs}, normative con date e importi, checklist operative, confronti tra scenari pratici`;
}

/**
 * Expand short Italian body content by asking the LLM to enrich each body field.
 * This is a last-resort fallback that's far more effective than regenerating from scratch,
 * because it preserves the existing structure and just adds depth.
 *
 * `boundToText` limita l'arricchimento a ciò che il testo già dice — vedi
 * expandEnrichmentLine per il motivo e per l'incidente che lo motiva.
 */
async function expandShortItalianContent(data, targetWords, { boundToText = false } = {}) {
  const it = data?.content?.it;
  if (!it) return data;

  const currentTotal = italianBodyWordCount(data);
  const deficit = targetWords - currentTotal;
  const perField = Math.ceil(deficit / 3) + 30; // extra margin per field

  for (const field of ['body1', 'body2', 'body3']) {
    const currentText = it[field] || '';
    const currentWords = countWords(currentText);
    const targetFieldWords = currentWords + perField;

    const expandPersona = IS_FRONTALIERE
      ? 'Sei un giornalista finanziario esperto di lavoro transfrontaliero in Ticino.'
      : 'Sei un giornalista finanziario esperto di affari svizzeri a livello nazionale.';
    const expandPrompt = `${expandPersona}

TESTO ATTUALE (${currentWords} parole):
${currentText}

TITOLO ARTICOLO: ${it.title || ''}

ISTRUZIONI:
- Riscrivi ed ESPANDI questo testo a circa ${targetFieldWords} parole (MASSIMO ${MAX_BODY_FIELD_WORDS} parole — NON superare questo limite)
- Mantieni lo stesso tono, stile e struttura
${expandEnrichmentLine(IS_FRONTALIERE, boundToText)}
- NON aggiungere frasi generiche o filler — solo informazioni utili e verificabili
- Mantieni la formattazione esistente (##, -, >, 📊, 💡, ⚠️). Citazioni (>) MAX 1 per articolo, solo per citazioni dirette brevi
- GRASSETTO: massimo 2-3 parole in grassetto nell'intero testo, preferisci ZERO
- NON cambiare il significato o la prospettiva dell'articolo
- Rispondi con il SOLO testo espanso, senza JSON, senza code fences`;

    try {
      const expanded = await callLLM(
        [
          { role: 'system', content: 'Sei un giornalista finanziario esperto. Rispondi con il solo testo richiesto, senza wrapper.' },
          { role: 'user', content: expandPrompt },
        ],
        { model: GH_MODEL_HEAVY, temperature: 0.7, maxTokens: 3000, timeout: 60_000 },
      );

      const expandedClean = expanded.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '').trim();
      const expandedWords = countWords(expandedClean);

      if (expandedWords > currentWords) {
        it[field] = expandedClean;
        console.error(`    📝 ${field}: ${currentWords} → ${expandedWords} parole`);

        // Hard cap: trim at paragraph boundary if LLM overshot the limit
        if (expandedWords > MAX_BODY_FIELD_WORDS) {
          const paragraphs = expandedClean.split(/\n\n+/);
          let trimmed = '';
          let trimmedWords = 0;
          for (const p of paragraphs) {
            const pWords = countWords(p);
            if (trimmedWords + pWords > MAX_BODY_FIELD_WORDS && trimmed) break;
            trimmed += (trimmed ? '\n\n' : '') + p;
            trimmedWords += pWords;
          }
          // Only trim if we kept at least some content
          if (trimmedWords >= currentWords && trimmedWords < expandedWords) {
            it[field] = trimmed;
            console.error(`    ✂️  ${field}: troncato a ${trimmedWords} parole (max ${MAX_BODY_FIELD_WORDS})`);
          }
        }
      } else {
        console.error(`    ⚠️  ${field}: espansione non ha aumentato le parole (${expandedWords} ≤ ${currentWords})`);
      }
    } catch (e) {
      console.error(`    ⚠️  ${field}: espansione fallita: ${e.message}`);
    }
  }

  return data;
}

/**
 * Translate article content from Italian to EN/DE/FR.
 * Called AFTER duplicate check to avoid wasting API calls on duplicates.
 */
// ── Quota-free article translation (2026-06-22) ──────────────────────────
// Route per-field translation through the dedicated free MT cascade
// (freeTranslateWithRetry) instead of the generation LLM, so the LLM daily
// quota is spent on GENERATION, not translation (~60% of per-article calls).
// Opt-out: ARTICLE_TRANSLATE_FREE_MT=0 falls back to the legacy LLM path.
// Masking / per-field logic lives in ./lib/article-free-mt.mjs (unit-testable;
// this script runs main() on import so its internals can't be imported).
const ARTICLE_TRANSLATE_FREE_MT = String(process.env.ARTICLE_TRANSLATE_FREE_MT ?? '1') !== '0';

// Thin in-script wrapper: bind the lib field-translator to the prod MT cascade,
// markdown repair, and logger. Returns '' on any failure so the caller's
// per-field recovery (LLM retry → IT fallback) takes over.
function freeMtField(text, sourceLang, targetLang, fieldType) {
  return translateFieldFreeMt({
    text,
    sourceLang,
    targetLang,
    fieldType,
    translate: freeTranslateWithRetry,
    balanceMarkdown: balanceMarkdownMarkers,
    onWarn: (msg) => console.error(`  ⚠️  ${msg} — recupero per-campo`),
  });
}

// Free-MT replacement for translateContent: same return shape ({title, excerpt,
// body1..3, faq?}) but each field via the quota-free cascade. Missing/failed
// fields are simply omitted → the existing missing-field recovery loop in
// translateArticle re-translates them (LLM) or falls back to IT.
async function translateContentFreeMt(sourceLang, targetLang, targetLabel, sourceContent) {
  console.error(`🌍 [${targetLabel}] Traduzione ${targetLang.toUpperCase()} via cascade MT gratuita (no quota LLM)...`);
  const [title, excerpt, body1, body2, body3] = await Promise.all([
    freeMtField(sourceContent.title, sourceLang, targetLang, 'title'),
    freeMtField(sourceContent.excerpt, sourceLang, targetLang, 'description'),
    freeMtField(sourceContent.body1, sourceLang, targetLang, 'description'),
    freeMtField(sourceContent.body2, sourceLang, targetLang, 'description'),
    freeMtField(sourceContent.body3, sourceLang, targetLang, 'description'),
  ]);

  let faq;
  if (Array.isArray(sourceContent.faq) && sourceContent.faq.length > 0) {
    try {
      faq = await Promise.all(sourceContent.faq.map(async (item) => {
        const q = await freeMtField(item?.q, sourceLang, targetLang, 'title');
        const a = await freeMtField(item?.a, sourceLang, targetLang, 'description');
        return { q: q || item?.q || '', a: a || item?.a || '' };
      }));
    } catch (err) {
      console.error(`  ⚠️  free-MT ${targetLang}:faq fallita (${err?.message || err}) — fallback IT`);
      faq = sourceContent.faq;
    }
  }

  const out = {};
  if (title) out.title = title;
  if (excerpt) out.excerpt = excerpt;
  if (body1) out.body1 = sanitizeBodyText(body1);
  if (body2) out.body2 = sanitizeBodyText(body2);
  if (body3) out.body3 = sanitizeBodyText(body3);
  if (faq) out.faq = faq;
  console.error(`  ✅ ${targetLang.toUpperCase()} (MT gratuita) completato`);
  return out;
}

async function translateArticle(data) {
  async function callWithRetry(prompt, maxTokens, label) {
    const safePrompt = `${prompt}\n\n${JSON_QUOTE_SAFETY_RULE_IT}`;
    const raw = await callLLM(
      [{ role: 'user', content: safePrompt }],
      { temperature: 0.5, maxTokens, jsonMode: true },
    );
    const repaired = repairLlmJson(raw);
    try {
      return JSON.parse(repaired);
    } catch (parseErr) {
      console.error(`  ⚠️  JSON parse error (${label}): ${parseErr.message}`);
      console.error(`     ${describeJsonParseError(repaired, parseErr)}`);
      console.error(`     ${describeRawForDiagnostics(raw)}`);
      // Detect truncation (model hit output cap): use 3× tokens on retry
      const isTruncation = parseErr.message.includes('Unterminated') || parseErr.message.includes('Unexpected end');
      const retry1Tokens = isTruncation ? Math.max(maxTokens * 3, 12000) : maxTokens + 4000;
      console.error(`  🔄 Retry ${label} con maxTokens=${retry1Tokens}${isTruncation ? ' (troncamento rilevato)' : ''}...`);
      const raw2 = await callLLM(
        [{ role: 'user', content: safePrompt }],
        { temperature: 0.5, maxTokens: retry1Tokens, jsonMode: true },
      );
      try {
        const result = JSON.parse(repairLlmJson(raw2));
        console.error(`  ✅ Retry riuscito per ${label}`);
        return result;
      } catch (retryErr) {
        console.error(`  ⚠️  Retry 1 fallito (${label}): ${retryErr.message} — tentativo 2...`);
        // Third attempt with maximum tokens
        const retry2Tokens = 16000;
        const raw3 = await callLLM(
          [{ role: 'user', content: safePrompt }],
          { temperature: 0.3, maxTokens: retry2Tokens, jsonMode: true },
        );
        try {
          const result3 = JSON.parse(repairLlmJson(raw3));
          console.error(`  ✅ Retry 2 riuscito per ${label}`);
          return result3;
        } catch (retry2Err) {
          console.error(`  ❌ Retry 2 fallito (${label}): ${retry2Err.message}`);
          // qualityReject=true: same content-quality class as the IT-generation
          // JSON-parse-exhausted throw above — malformed translation output,
          // not infrastructure. This propagates straight out of
          // generateAndValidateArticle (no local catch around translateArticle),
          // so an untagged message here crashes the whole run instead of
          // skipping to the next headline.
          const err = new Error(`JSON non valido dalla traduzione ${label}: ${retry2Err.message}`);
          err.qualityReject = true;
          throw err;
        }
      }
    }
  }

  async function translateContent(sourceLang, targetLang, targetLabel, sourceContent) {
    // Quota-free path: route through the dedicated free MT cascade so the LLM
    // daily quota is reserved for generation. Per-field failures are omitted and
    // recovered downstream (LLM retry → IT fallback), so this never degrades
    // below the legacy path's worst case. Opt-out via ARTICLE_TRANSLATE_FREE_MT=0.
    if (ARTICLE_TRANSLATE_FREE_MT) {
      return translateContentFreeMt(sourceLang, targetLang, targetLabel, sourceContent);
    }
    // Use scored chain (no model pinning) — falls back through all models automatically
    const langName = targetLang === 'en' ? 'inglese' : targetLang === 'de' ? 'tedesco' : 'francese';
    console.error(`🤖 [${targetLabel}] Traduzione ${targetLang.toUpperCase()} tramite catena AI...`);

    const terminologyByLang = {
      de: `TERMINOLOGIA TEDESCA OBBLIGATORIA:
- "permesso G" / "permesso di frontaliere" → "G-Bewilligung" o "Grenzgängerbewilligung" (MAI "G-Führerschein" — Führerschein = patente di guida)
- "franchi" → "Franken" (MAI "Francs" — è francese)
- "ponti" (festività) → "Brückentage" (MAI "Brücken" — significherebbe ponti fisici)
- "Swissminiatur" resta "Swissminiatur" (MAI aggiungere la 'a' finale italiana → "Swissminiatura")
- "frontaliere/i" → "Grenzgänger" (MAI "grenzüberschreitender Pendler")
- Strutture/servizi → "Einrichtungen" (MAI "Facilitäten" — non è tedesco standard)
- Usare "ß" correttamente (gemäß, Maßstab) e le virgolette tedesche «...» o „..."`,
      en: `ENGLISH TERMINOLOGY:
- "permesso G" → "G permit" or "cross-border worker permit" (NEVER "G license")
- "franchi" → "francs" or "CHF" (NEVER "Franken")
- "ponti" (holidays) → "bank holidays" or "long weekends" (NEVER literal "bridges")
- "Swissminiatur" stays "Swissminiatur" (NEVER add Italian 'a' → "Swissminiatura")
- "frontaliere/i" → "cross-border worker(s)" or "cross-border commuter(s)"`,
      fr: `TERMINOLOGIE FRANÇAISE OBLIGATOIRE:
- "permesso G" → "permis G" ou "permis frontalier" (JAMAIS "permis de conduire G")
- "franchi" → "francs" (JAMAIS "Franken")
- "ponti" (fêtes) → "ponts" ou "jours fériés" (le terme "pont" existe en français)
- "Swissminiatur" reste "Swissminiatur" (JAMAIS "Swissminiatura")
- "frontaliere/i" → "frontalier(s)" ou "travailleur(s) frontalier(s)"`,
    };

    const rules = `REGOLE DI TRADUZIONE:
- Traduzione COMPLETA, stessa profondità e lunghezza dell'italiano
- NON riassumere — traduci tutto il contenuto
- Mantieni la formattazione: ## per sottotitoli, - per elenchi, > per citazioni, emoji (📊💡⚠️) per box
- Mantieni i link interni esattamente come sono: [testo tradotto](nav:azione) — traduci solo il testo visibile, NON l'azione nav:
- GRASSETTO: max 2-3 parole in grassetto per INTERO campo body. Preferire ZERO grassetto.
- Usa fraseologia naturale nella lingua target, non traduzione letterale
- Apostrofi: usa sempre ' (diritto), mai virgolette curve
- I nomi propri di luoghi svizzeri (Sessa, Melide, Malcantone) restano invariati in tutte le lingue

${terminologyByLang[targetLang] || ''}`;

    // Split into 4 parallel calls — one per field group — to stay within model output limits.
    // German/French expand ~30% vs Italian; some models cap output at ~2048-4096 tokens.
    // Dynamic maxTokens based on input word count + sub-chunking for oversized fields.

    const makePrompt = (fields, schema) =>
      `Traduci il seguente contenuto giornalistico da italiano a ${langName} per il sito Frontaliere Ticino.\n\n${fields}\n\n${rules}\n\nRispondi con un JSON object (no markdown, no code fences):\n${schema}`;

    // Scale maxTokens to input size: ~2 tokens/word in, ~2.5 tokens/word out (translation expansion)
    const bodyTokens = (text) => Math.max(5000, Math.ceil(countWords(text || '') * 5));

    // For body fields exceeding this threshold, split into sub-chunks and translate separately
    const TRANSLATION_CHUNK_THRESHOLD = 700;

    async function translateBodyField(bodyKey, bodyText, lang) {
      const words = countWords(bodyText || '');

      if (words <= TRANSLATION_CHUNK_THRESHOLD) {
        // Normal single-call translation
        const result = await callWithRetry(makePrompt(
          `CONTENUTO ITALIANO DA TRADURRE:\n- ${bodyKey}: ${bodyText}`,
          `{"${bodyKey}": "..."}`,
        ), bodyTokens(bodyText), `${lang}:${bodyKey.replace('body', 'b')}`);
        // A model answering {"body1": {...}} / {"body1": [...]} still parses as
        // valid JSON. Returning it would carry an object into a string context
        // downstream, which stringifies to the literal "[object Object]" and
        // ships as prose. Drop the key instead so the per-field missing-
        // translation retry (and then the IT fallback) can recover it.
        const text = translatedStringOrNull(result?.[bodyKey]);
        if (text === null) {
          console.error(`  ⚠️  ${lang}:${bodyKey} non è una stringa (${typeof result?.[bodyKey]}) — campo scartato, recupero per-campo downstream`);
          return {};
        }
        return { [bodyKey]: sanitizeBodyText(text) };
      }

      // Sub-chunk: split at paragraph boundaries into ~500-word pieces
      console.error(`    📦 ${lang}:${bodyKey} = ${words} parole → sub-chunking...`);
      const paragraphs = (bodyText || '').split(/\n\n+/);
      const chunks = [];
      let currentChunk = '';
      let currentWords = 0;
      const chunkTarget = 500;

      for (const p of paragraphs) {
        const pWords = countWords(p);
        if (currentWords + pWords > chunkTarget && currentChunk) {
          chunks.push(currentChunk);
          currentChunk = p;
          currentWords = pWords;
        } else {
          currentChunk += (currentChunk ? '\n\n' : '') + p;
          currentWords += pWords;
        }
      }
      if (currentChunk) chunks.push(currentChunk);

      // Translate each chunk in parallel
      const translated = await Promise.all(
        chunks.map((chunk, i) =>
          callWithRetry(makePrompt(
            `CONTENUTO ITALIANO DA TRADURRE (parte ${i + 1} di ${chunks.length}):\n- ${bodyKey}: ${chunk}`,
            `{"${bodyKey}": "..."}`,
          ), bodyTokens(chunk), `${lang}:${bodyKey.replace('body', 'b')}-p${i + 1}`),
        ),
      );

      // Join translated chunks. A chunk the model returned as an object used to
      // be stringified into the joined body as "[object Object]" — one corrupted
      // paragraph in the middle of otherwise-good prose. Refuse the whole field
      // instead and let the per-field recovery re-translate it.
      const joined = joinTranslatedChunks(translated, bodyKey);
      if (joined === null) {
        console.error(`  ⚠️  ${lang}:${bodyKey} — almeno un chunk non è una stringa, campo scartato: recupero per-campo downstream`);
        return {};
      }
      return { [bodyKey]: sanitizeBodyText(joined) };
    }

    // Translate FAQ if present (small payload, single call)
    const faqTranslation = sourceContent.faq && Array.isArray(sourceContent.faq) && sourceContent.faq.length > 0
      ? callWithRetry(makePrompt(
          `CONTENUTO ITALIANO DA TRADURRE:\n- faq: ${JSON.stringify(sourceContent.faq)}`,
          '{"faq": [{"q": "...", "a": "..."}]}',
        ), 1500, `${targetLang}:faq`).catch(err => {
          console.error(`  ⚠️  FAQ translation failed for ${targetLang}: ${err.message}`);
          return { faq: sourceContent.faq }; // Fallback to Italian
        })
      : Promise.resolve({});

    // Per-call resilience: a single malformed-JSON / quota-exhausted translation
    // call must NOT reject the whole Promise.all and discard the entire article
    // (run 27924137758: de:meta JSON parse failure after 3 retries hard-threw and
    // killed an otherwise-fine article). Each call falls back to `{}`; the
    // downstream missing-field validation loop (#1266) then re-translates the
    // affected field in isolation or falls back to the IT source — same
    // graceful-degradation philosophy already used for FAQ below.
    const onTranslateFail = (label) => (err) => {
      if (err instanceof TypeError || err instanceof ReferenceError) throw err;
      console.error(`  ⚠️  ${label} translation failed: ${err.message} — fallback al recupero per-campo`);
      return {};
    };
    const [partMeta, partB1, partB2, partB3, partFaq] = await Promise.all([
      // Call 1: title + excerpt (small, ~300 tokens output)
      // VINCOLO TITOLO: il title tradotto DEVE restare ≤ 60 caratteri (gate SEO Semrush).
      // Se la lingua target tende a espandersi (DE/FR), riformula in modo più conciso
      // mantenendo la keyword principale — non tradurre letteralmente parola per parola.
      callWithRetry(makePrompt(
        `CONTENUTO ITALIANO DA TRADURRE:\n- title: ${sourceContent.title}\n- excerpt: ${sourceContent.excerpt}\n\nVINCOLI OBBLIGATORI per il title tradotto:\n- MASSIMO 60 caratteri totali (target 50-55).\n- NON includere "| Frontaliere Ticino" (aggiunto automaticamente).\n- Mantieni la keyword principale; abbrevia o riformula se necessario per restare entro 60 caratteri.`,
        '{"title": "...", "excerpt": "..."}',
      ), 1000, `${targetLang}:meta`).catch(onTranslateFail(`${targetLang}:meta`)),
      // Call 2-4: body fields with dynamic sizing + sub-chunking safety
      translateBodyField('body1', sourceContent.body1, targetLang).catch(onTranslateFail(`${targetLang}:body1`)),
      translateBodyField('body2', sourceContent.body2, targetLang).catch(onTranslateFail(`${targetLang}:body2`)),
      translateBodyField('body3', sourceContent.body3, targetLang).catch(onTranslateFail(`${targetLang}:body3`)),
      // Call 5: FAQ (optional)
      faqTranslation,
    ]);

    const [partA, partB] = [{ ...partMeta, ...partB1 }, { ...partB2, ...partB3, ...partFaq }];

    const parsed = { ...partA, ...partB };
    console.error(`  ✅ ${targetLang.toUpperCase()} completato`);
    return parsed;
  }

  const itContent = data.content.it;
  // Outer-level resilience (#2586): translateContent can still throw from a path
  // OUTSIDE the per-call wrapped translations above — the chunking loop,
  // makePrompt, a malformed `sourceContent`, or translateBodyField's own
  // per-chunk Promise.all (line ~4308, no inner catch). Such a throw would reject
  // THIS Promise.all and discard ALL three locales + the whole otherwise-fine
  // article. Catch at the locale boundary and return {} so the downstream
  // missing-field validation (#1266) re-translates each field in isolation or
  // falls back to the IT source — the same graceful-degradation contract as
  // onTranslateFail, applied one level up.
  const translateLocaleSafe = async (target, label) => {
    try {
      return await translateContent('it', target, label, itContent);
    } catch (err) {
      // Rethrow programming errors (bugs inside translateContent itself) so they
      // fail hard instead of silently producing IT content under /en /de /fr.
      // AI/network errors (quota, timeout, JSON parse) are expected transient
      // failures and should fall back to per-field recovery downstream (#1266).
      if (err instanceof TypeError || err instanceof ReferenceError) throw err;
      console.error(`  ⚠️  ${target.toUpperCase()} translation aborted (${err?.message || err}) — recupero per-campo downstream (#1266)`);
      return {};
    }
  };
  const [enContent, deContent, frContent] = await Promise.all([
    translateLocaleSafe('en', '2/5'),
    translateLocaleSafe('de', '3/5'),
    translateLocaleSafe('fr', '4/5'),
  ]);
  console.error(`  ✅ Tutte le traduzioni completate`);

  data.content.en = enContent;
  data.content.de = deContent;
  data.content.fr = frContent;

  // Validate translated content fields. A transient AI failure (429/timeout/
  // empty completion under quota exhaustion) can leave a single field empty —
  // historically this hard-threw and discarded the ENTIRE generated article,
  // including the fine IT source content (issue #1266: "Campo excerpt mancante
  // nella traduzione de" during a run where nearly every model 429'd). That is
  // a brittle all-or-nothing guard inconsistent with the retry-then-accept
  // philosophy already used below for identical / over-long fields.
  //
  // Structural fix: instead of hard-throwing (which discarded the whole article
  // including the fine IT source), retry the missing field once via a focused
  // re-translation, and only if THAT also fails fall back to the Italian source
  // value. Shipping the IT value under a localized URL is an hreflang compromise
  // (esp. for body1/2/3), so we genuinely re-attempt the translation first; the
  // IT fallback is the last resort that keeps the page indexable rather than
  // nuking the article. Only throw if the field is missing from the IT source
  // itself (a real upstream defect we cannot paper over).
  for (const locale of ['en', 'de', 'fr']) {
    const langName = locale === 'en' ? 'inglese' : locale === 'de' ? 'tedesco' : 'francese';
    for (const field of ['title', 'excerpt', 'body1', 'body2', 'body3']) {
      if (data.content[locale][field]) continue;
      const itValue = itContent[field];
      if (!itValue) {
        throw new Error(`Campo ${field} mancante nella traduzione ${locale} (e assente anche nella sorgente IT)`);
      }
      console.error(`  ⚠️  Campo ${field} mancante nella traduzione ${locale} — retry traduzione mirata...`);
      try {
        // Reuse the in-scope callWithRetry (callLLM + JSON repair + truncation
        // back-off) for a focused single-field re-translation.
        const parsed = await callWithRetry(
          `Traduci OBBLIGATORIAMENTE in ${langName} il seguente campo per il sito Frontaliere Ticino. Rispondi SOLO con JSON (no markdown):\n\nCAMPO ITALIANO (${field}):\n${itValue}\n\nFormato risposta: {"${field}": "..."}`,
          1500,
          `${locale}:${field}-missing-retry`,
        );
        // `String(retried)` on an object yields "[object Object]" — truthy and
        // different from the IT value, so the old check ASSIGNED it. Require a
        // real string so a non-string retry falls through to the IT fallback.
        const retried = translatedStringOrNull(parsed?.[field]);
        if (retried && String(retried).trim() !== String(itValue).trim()) {
          data.content[locale][field] = retried;
          console.error(`  ✅ Campo ${field} (${locale}) ritradotto con successo dopo missing-field retry`);
          continue;
        }
        console.error(`  ⚠️  Retry ${field} (${locale}) non ha prodotto una traduzione valida — fallback al valore italiano`);
      } catch (retryErr) {
        console.error(`  ⚠️  Retry ${field} (${locale}) fallito: ${retryErr.message} — fallback al valore italiano`);
      }
      data.content[locale][field] = itValue;
    }
  }

  // Detect untranslated title/excerpt (identical to Italian = translation failure)
  // Retry once per affected locale; if still identical, warn but don't block.
  for (const locale of ['en', 'de', 'fr']) {
    for (const field of ['title', 'excerpt']) {
      const itVal = (itContent[field] || '').trim();
      const locVal = (data.content[locale][field] || '').trim();
      if (itVal && locVal === itVal) {
        const langName = locale === 'en' ? 'inglese' : locale === 'de' ? 'tedesco' : 'francese';
        console.error(`  ⚠️  [translation-check] ${locale.toUpperCase()}.${field} identico all'italiano — retry traduzione...`);
        try {
          const retryResult = await callWithRetry(makePrompt(
            `ATTENZIONE: la traduzione precedente è rimasta in ITALIANO. Traduci OBBLIGATORIAMENTE in ${langName}.\n\nCONTENUTO ITALIANO DA TRADURRE:\n- ${field}: ${itVal}`,
            `{"${field}": "..."}`,
          ), 1000, `${locale}:${field}-retry`);
          if (retryResult?.[field] && retryResult[field].trim() !== itVal) {
            data.content[locale][field] = retryResult[field];
            console.error(`  ✅ [translation-check] ${locale.toUpperCase()}.${field} ritradotto con successo`);
          } else {
            console.error(`  ⚠️  [translation-check] ${locale.toUpperCase()}.${field} ancora identico dopo retry — accettato con warning`);
          }
        } catch (retryErr) {
          console.error(`  ⚠️  [translation-check] Retry fallito per ${locale}.${field}: ${retryErr.message}`);
        }
      }
    }
  }

  // ── Title length cap on translated locales (Semrush ≤ 60 chars gate) ──
  // German/French translations expand ~30% vs Italian, so a 58-char IT title
  // can become 80+ chars in DE. Retry once per offending locale with a
  // length-only re-prompt, then hard-cap at 60 chars at a word boundary.
  for (const locale of ['en', 'de', 'fr']) {
    const localeContent = data.content[locale];
    if (!localeContent || !localeContent.title) continue;
    const initialCap = capBlogTitle(localeContent.title);
    if (initialCap.originalLength > BLOG_TITLE_RETRY_THRESHOLD) {
      const langName = locale === 'en' ? 'inglese' : locale === 'de' ? 'tedesco' : 'francese';
      console.warn(`  ⚠️ [title-cap] ${locale.toUpperCase()} title ${initialCap.originalLength} chars > ${BLOG_TITLE_RETRY_THRESHOLD} — retry traduzione titolo con vincolo di lunghezza...`);
      try {
        const retryResult = await callWithRetry(
          `Riformula il seguente titolo in ${langName} per il sito Frontaliere Ticino.\n\nTITOLO ATTUALE (${initialCap.originalLength} caratteri, troppo lungo):\n${localeContent.title}\n\nTITOLO ITALIANO ORIGINALE (riferimento):\n${itContent.title}\n\nVINCOLI OBBLIGATORI:\n- MASSIMO 60 caratteri totali (target 50-55).\n- NON includere "| Frontaliere Ticino" (aggiunto automaticamente).\n- Mantieni la keyword principale; abbrevia o riformula in modo conciso.\n\nRispondi SOLO con JSON: {"title": "..."}`,
          1000,
          `${locale}:title-length-retry`,
        );
        if (retryResult?.title && typeof retryResult.title === 'string') {
          localeContent.title = retryResult.title;
          console.error(`  ✅ [title-cap] ${locale.toUpperCase()} title ritradotto a ${retryResult.title.length} caratteri`);
        }
      } catch (retryErr) {
        console.warn(`  ⚠️ [title-cap] Retry titolo ${locale} fallito: ${retryErr.message} — applico hard cap`);
      }
    }
    const finalCap = capBlogTitle(localeContent.title);
    if (finalCap.truncated) {
      console.warn(`  ✂️ [title-cap] ${locale.toUpperCase()} title truncato: ${finalCap.originalLength} → ${finalCap.value.length} chars`);
    }
    localeContent.title = finalCap.value;
    const uncappedTitle = collapseShoutingTitle(localeContent.title);
    if (uncappedTitle !== localeContent.title) {
      console.warn(`  🔡 [title-case] ${locale.toUpperCase()} title normalizzato: "${localeContent.title}" → "${uncappedTitle}"`);
      localeContent.title = uncappedTitle;
    }
    // Toponym casing is locale-agnostic: Ticino stays Ticino in EN/DE/FR, and
    // the free-MT cascade happily carries a lowercase 'ticino' straight over
    // from the IT source (4 FR fields measured). Italian grammar rules inside
    // the guard are gated on locale === 'it' and do not fire here.
    applyMicrocopyGuard(localeContent, locale);
  }

  console.error(`  ✅ Articolo assemblato — ${Object.keys(data.content).length} lingue`);
}

/**
 * Validate a title against clickbait patterns. Returns { valid, reason } where
 * reason is the label of the first matching pattern (or null if valid).
 */
function validateTitle(title) {
  if (!title) return { valid: false, reason: 'empty' };
  for (const re of A5_CLICKBAIT_PATTERNS) {
    if (re.test(title)) {
      console.warn(`  ⚠️ [anti-clickbait] Titolo sospetto: "${title}"`);
      return { valid: false, reason: 'clickbait_pattern' };
    }
  }
  return { valid: true, reason: null };
}

// ──────────────────────────────────────────────────────────────────────────
// A5 — Headline validation (Google News compliance)
//
// Stricter, BLOCKING gate complementary to the legacy `validateTitle`
// (which is a non-blocking Google-Discover anti-clickbait check). The A5
// validator enforces:
//
//  - Length 10-110 characters
//  - 2-22 whitespace-separated tokens
//  - Must NOT start with a digit
//  - Must NOT match any clickbait pattern from A5_CLICKBAIT_PATTERNS
//    (Italian + English variants).
//
// Returns an array of human-readable error strings (empty = pass).
//
// Spec: docs/GOOGLE-NEWS-COMPLIANCE-PLAN.md §4 FASE 1 A5.
// Tests: tests/blog-headline-validation.test.ts.
// ──────────────────────────────────────────────────────────────────────────

export const A5_CLICKBAIT_PATTERNS = [
  // Italian
  /non\s+crederai/i,
  /scioccante/i,
  /incredibile/i,
  /sconvolgente/i,
  /ti\s+lascer[àa]\s+senza\s+parole/i,
  /clamoroso/i,
  /pazzesco/i,
  /\bspoiler\b/i,
  /quello\s+che\s+(non\s+)?sai/i,
  /ecco\s+(perch[ée]|cosa)\s+non\s+(crederai|immagini)/i,
  // English
  /you\s+won['’]?t\s+believe/i,
  /shocking/i,
  /mind[-\s]?blowing/i,
  /this\s+one\s+(weird\s+)?trick/i,
  // Punctuation tells (clickbait stubs)
  /\?\?\?$/,
  /!{2,}$/,
];

/**
 * @param {string} headline
 * @returns {string[]} Array of error messages (empty = pass).
 */
export function validateHeadline(headline) {
  const errs = [];
  if (typeof headline !== 'string' || headline.length === 0) {
    return ['Headline mancante o non stringa'];
  }
  if (headline.length < 10) errs.push('Headline troppo corto (min 10 char)');
  if (headline.length > 110) errs.push('Headline troppo lungo (max 110 char)');
  const wc = headline.trim().split(/\s+/).filter(Boolean).length;
  if (wc < 2 || wc > 22) errs.push(`Headline ${wc} parole, range 2-22`);
  if (A5_CLICKBAIT_PATTERNS.some((p) => p.test(headline))) {
    errs.push('Pattern clickbait rilevato');
  }
  return errs;
}

// ── Step 3: Validate Gemini response ────────────────────────
function validate(data, opts = {}) {
  const minBodyChars = Number(opts.minBodyChars || MIN_BODY_CHARS);
  // `content` is the only truly irreplaceable field — everything else can be
  // synthesized from it. Smaller fallback models (Cerebras llama-3.1-8b, etc.)
  // frequently omit top-level metadata (`id`, `category`, `image`, `slugs`)
  // but still produce usable localized `content`. Fail ONLY if content is missing.
  // qualityReject=true on every throw below: this whole function only ever
  // throws for a malformed/incomplete AI response (missing content, title,
  // slug, or body field) — the same content-quality class that callLLM's and
  // validateItalianPayload's sibling throws were tagged for. The caller
  // (generateAndValidateArticle, via the outer isQualityRejectError-gated
  // catch) needs the tag to skip to the next headline instead of crashing
  // the whole run on an untagged message the recognition regex can't match.
  if (!data || typeof data !== 'object') {
    const err = new Error(`Campo mancante nella risposta AI: data (non è un oggetto)`);
    err.qualityReject = true;
    throw err;
  }
  if (!data.content || typeof data.content !== 'object') {
    const err = new Error(`Campo mancante nella risposta AI: content`);
    err.qualityReject = true;
    throw err;
  }
  const itContent = data.content.it || data.content;
  if (!itContent || !itContent.title) {
    const err = new Error(`Campo mancante nella risposta AI: content.it.title`);
    err.qualityReject = true;
    throw err;
  }

  // The prompt shows the id field as `"id": "kebab-case-3-5-words-max-40-chars"`,
  // and models sometimes echo that placeholder instead of replacing it — either
  // verbatim, or with the `kebab-case-` prefix glued onto a real slug. Four of
  // them reached production as permanent public URLs before this guard existed:
  //   /articoli-frontaliere/kebab-case-3-5-words-max-40-chars/
  //   /articoli-frontaliere/kebab-case-turismo-ticino/
  //   /articoli-frontaliere/kebab-case-ticino-nubifragio-grigioni/
  //   /articoli-frontaliere/kebab-case-rossi-bruxelles-ticino/
  // The articles themselves are fine — correct titles, real content — so the
  // damage is confined to the URL, which is exactly the part that cannot be
  // fixed later without a redirect and a ranking reset.
  //
  // Stripped rather than rejected: the leak is in the id only, and the title is
  // right there to derive a clean one from. Failing the whole generation would
  // throw away a good article over a prefix.
  const PROMPT_ID_LEAK_RX = /^kebab[-_]?case[-_]?/i;
  if (data.id && PROMPT_ID_LEAK_RX.test(data.id)) {
    const stripped = data.id.replace(PROMPT_ID_LEAK_RX, '');
    // The verbatim placeholder leaves nothing usable behind ("3-5-words-max-40-chars"),
    // so prefer the title whenever the remainder looks like the schema hint.
    const looksLikeHint = !stripped || /^\d+-\d+-words|max-\d+-chars/i.test(stripped);
    const recovered = looksLikeHint ? slugifySlugPart(itContent.title) : stripped;
    if (!recovered) {
      const err = new Error(`id contiene il placeholder del prompt ("${data.id}") e non è ricostruibile dal titolo "${itContent.title}"`);
      err.qualityReject = true;
      throw err;
    }
    console.error(`⚠️  id conteneva il placeholder del prompt ("${data.id}") — corretto in "${recovered}"`);
    data.id = recovered;
  }

  // Synthesize id from the Italian title if the model omitted it.
  if (!data.id) {
    const generatedId = slugifySlugPart(itContent.title);
    if (!generatedId) {
      const err = new Error(`Campo mancante nella risposta AI: id (impossibile sintetizzare dal titolo "${itContent.title}")`);
      err.qualityReject = true;
      throw err;
    }
    console.error(`⚠️  Campo "id" mancante — sintetizzato dal titolo IT: "${generatedId}"`);
    data.id = generatedId;
  }

  // Default category to 'novita' (generic news) if missing — the mapping below
  // will normalize it further.
  if (!data.category) {
    console.error(`⚠️  Campo "category" mancante — uso fallback "novita"`);
    data.category = 'novita';
  }

  // Default image to the first available place image; the downstream image
  // validation block will pick a better fallback via keyword matching or hash.
  if (!data.image) {
    console.error(`⚠️  Campo "image" mancante — uso fallback "${PLACES_IMAGES[0]}"`);
    data.image = PLACES_IMAGES[0];
  }

  // Ensure slugs is an object so the per-locale fallback loop below can populate it.
  if (!data.slugs || typeof data.slugs !== 'object') {
    console.error(`⚠️  Campo "slugs" mancante — sarà derivato dai titoli per locale`);
    data.slugs = {};
  }

  // Synthesize seo from content.it if the model omitted it (common with smaller fallback models)
  if (!data.seo) {
    const it = data.content.it || data.content;
    // truncateAtWordBoundary, not slice: a hard character cut lands mid-word and
    // ships a title tag that stops in the middle of the sentence — "Incidente
    // mortale a Porlezza: muore un | Frontaliere Ticino", "Educatori in
    // Germania: stipendi fino a | Frontaliere Ticino". 443 of the 4552 titles in
    // the corpus (9.7%) are cut that way, all of them from this branch, and the
    // cut usually falls exactly on the informative part. The helper is already
    // used four lines below for the description and for breadcrumbName — this
    // call site just never got it.
    const title = truncateAtWordBoundary(String(it.title || data.id), 57);
    const rawDesc = String(it.excerpt || it.title || '').replace(/\s+/g, ' ').trim();
    const desc = truncateAtWordBoundary(rawDesc, 160);
    // ogDescription gets its own cap (SEO_OG_DESCRIPTION_MAX), not the 160
    // description limit — otherwise this fallback ships the same capped
    // string the L6850 clamp was fixed to stop producing.
    const ogDesc = truncateAtWordBoundary(rawDesc, SEO_OG_DESCRIPTION_MAX);
    console.error(`⚠️  Campo "seo" mancante — generato automaticamente da content.it`);
    data.seo = {
      title: `${title} | Frontaliere Ticino`,
      description: desc,
      keywords: `frontalieri, ticino, ${data.category || 'lavoro'}, svizzera, italia`,
      ogTitle: title,
      ogDescription: ogDesc,
      headline: title,
      breadcrumbName: title.split(/[:.–—]/)[0].trim().slice(0, 40),
    };
  }

  for (const locale of ['it']) {
    if (!data.content[locale]) {
      const err = new Error(`Contenuto mancante per ${locale}`);
      err.qualityReject = true;
      throw err;
    }
    // Auto-generate missing slug from title before failing
    if (!data.slugs[locale]) {
      const title = String(data.content[locale]?.title || '');
      if (title) {
        const generated = slugifySlugPart(title);
        if (generated) {
          data.slugs[locale] = generated;
          console.warn(`  ⚠️  Slug ${locale} mancante, generato dal titolo: "${generated}"`);
        } else {
          const err = new Error(`Slug mancante per ${locale} e titolo non utilizzabile per fallback`);
          err.qualityReject = true;
          throw err;
        }
      } else {
        const err = new Error(`Slug mancante per ${locale}`);
        err.qualityReject = true;
        throw err;
      }
    }
    for (const field of ['title', 'excerpt', 'body1', 'body2', 'body3']) {
      if (!data.content[locale][field]) {
        const err = new Error(`Campo ${field} mancante per ${locale}`);
        err.qualityReject = true;
        throw err;
      }
    }
  }

  // Anti-clickbait title validation (Google Discover compliance)
  const itTitle = (data.content.it || data.content)?.title || '';
  const titleCheck = validateTitle(itTitle);
  if (!titleCheck.valid) {
    console.warn(`  ⚠️ [anti-clickbait] Titolo IT non conforme: "${itTitle}" (${titleCheck.reason})`);
    // Non-blocking: log warning but don't reject the article outright,
    // as false positives are possible. The warning is visible in GH Actions.
  }
  // Thin content guard: warn but don't reject yet — the word-count retry loop
  // (later in the pipeline) will attempt to expand short articles via AI.
  // Final thin content check happens after all retry/expand attempts.
  const itBodyEarly = `${(data.content.it || data.content)?.body1 || ''} ${(data.content.it || data.content)?.body2 || ''} ${(data.content.it || data.content)?.body3 || ''}`;
  const itPlainCharsEarly = itBodyEarly.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().length;
  if (itPlainCharsEarly < minBodyChars) {
    console.warn(`  ⚠️  [thin-content] Articolo corto: ${itPlainCharsEarly} chars (min: ${minBodyChars}) — il retry loop tenterà di espandere`);
  }

  // ── Frontaliere density check ──────────────────────────────
  // Frontaliere-only: a low frontaliere-keyword density signals a topic that
  // drifted off the cross-border angle. For the NATIONAL svizzera section this
  // metric is meaningless (articles are intentionally not frontaliere-centric),
  // so we skip it and emit a neutral national-relevance note instead.
  if (IS_FRONTALIERE) {
    const itBodyForDensity = `${(data.content.it || data.content)?.body1 || ''} ${(data.content.it || data.content)?.body2 || ''} ${(data.content.it || data.content)?.body3 || ''}`;
    const densityResult = checkFrontaliereDensity(itBodyForDensity);
    if (!densityResult.passes) {
      console.warn(`  ⚠️  [frontaliere-density] Solo ${densityResult.hits} keyword frontalieri su ${densityResult.wordCount} parole (min: 8 hits). Il contenuto potrebbe non essere rilevante per i frontalieri.`);
      // Non-blocking at generation time: log warning for monitoring.
      // The selection prompt already enforces relevance; this is a final safety net.
    } else {
      console.error(`  ✅ [frontaliere-density] ${densityResult.hits} keyword frontalieri su ${densityResult.wordCount} parole`);
    }
  } else {
    console.error(`  ℹ️  [national-relevance] Sezione ${SECTION_NAME}: density frontalieri non applicabile (articolo a respiro nazionale).`);
  }

  // Slug validation for translated locales (slugs come from IT generation call)
  // If the AI model omitted translated slugs, derive them from the IT slug.
  for (const locale of ['en', 'de', 'fr']) {
    if (!data.slugs[locale]) {
      // Fallback: use the translated title if available, otherwise the IT slug
      const title = String(data.content[locale]?.title || data.content.it?.title || '');
      const fallback = title ? slugifySlugPart(title) : data.slugs.it;
      if (fallback) {
        data.slugs[locale] = fallback;
        console.warn(`  ⚠️  Slug ${locale} mancante, generato come fallback: "${fallback}"`);
      } else {
        const err = new Error(`Slug mancante per ${locale}`);
        err.qualityReject = true;
        throw err;
      }
    }
  }
  if (!CATEGORIES.includes(data.category)) {
    const mapped = CATEGORY_MAP[data.category.toLowerCase()];
    if (mapped) {
      console.error(`⚠️  Categoria "${data.category}" mappata a "${mapped}"`);
      data.category = mapped;
    } else {
      console.error(`⚠️  Categoria "${data.category}" non riconosciuta, uso fallback "novita"`);
      data.category = 'novita';
    }
  }
  if (!AVAILABLE_IMAGES.includes(data.image)) {
    // Try keyword-based matching first, then fall back to hash-based rotation
    const matched = findBestFallbackImage(data);
    if (matched) {
      console.error(`⚠️  Immagine "${data.image}" non trovata, uso match per keyword: "${matched}"`);
      data._generatedImagePath = matched;
    } else {
      const hash = [...(data.id || '')].reduce((acc, c) => acc + c.charCodeAt(0), 0);
      const fallbackPath = FALLBACK_IMAGES[hash % FALLBACK_IMAGES.length];
      console.error(`⚠️  Immagine "${data.image}" non trovata, uso fallback casuale "${fallbackPath}" (pool: ${FALLBACK_IMAGES.length} immagini)`);
      data._generatedImagePath = fallbackPath;
    }
    data.image = PLACES_IMAGES[0]; // dummy value, _generatedImagePath takes priority
  }
  // Validate new image fields (non-blocking — provide defaults)
  if (!data.imagePrompt) {
    data.imagePrompt = `Professional editorial photo of Ticino Switzerland, Lake Lugano panorama, warm natural lighting`;
  }
  if (!data.imageAlt || typeof data.imageAlt !== 'object') {
    const itTitle = (data.content.it || data.content).title || data.id;
    data.imageAlt = {
      it: `Immagine editoriale relativa a: ${itTitle}`,
      en: `Editorial image related to: ${itTitle}`,
      de: `Redaktionelles Bild zu: ${itTitle}`,
      fr: `Image éditoriale relative à: ${itTitle}`,
    };
  }
  // Guard against a shouting imageAlt slipping through when the LLM returns
  // it directly (imageAlt is a required schema field, so the fallback above
  // doesn't always run) — same casing failure mode as the title, so reuse
  // the same locale-agnostic collapse guard instead of trusting raw output.
  for (const locale of ['it', 'en', 'de', 'fr']) {
    if (typeof data.imageAlt[locale] === 'string') {
      data.imageAlt[locale] = collapseShoutingTitle(data.imageAlt[locale]);
    }
  }
  // Sanitize id
  data.id = data.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

  // Force Italian slug to match the article ID.
  // The AI can generate slugs.it ≠ id (e.g. "cadenazzo-s-antonino" vs "cadenazzo-2026"),
  // causing the logged/output URL to differ from the actual routed slug.
  // Convention: Italian slug === article id for all articles.
  data.slugs.it = data.id;

  // Sanitize ALL locale slugs: strip diacritics and non-ASCII characters.
  // AI models often generate slugs with accented characters (ä, ö, ü, é, è, etc.)
  // which cause XML parsing issues in sitemaps and Bing Webmaster Tools errors.
  for (const locale of ['en', 'de', 'fr']) {
    if (data.slugs[locale]) {
      const original = data.slugs[locale];
      data.slugs[locale] = String(data.slugs[locale])
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 80);
      // Same prompt-placeholder leak the id is guarded against above, and the
      // reason this branch no longer strips `kebab-case-` by hand: the schema
      // shown to the model spells the id as "kebab-case-3-5-words-max-40-chars"
      // AND the slugs as "slug-en"/"slug-de"/"slug-fr", and only the first of
      // the two families was ever covered here — the `slug-*` family reached
      // production 24 times. `inspectSlugForPromptPlaceholder()` is the shared
      // classifier, the SAME one `deriveAndSanitizeArticleSlugs()` enforces at
      // the write path, so the two cannot drift into disagreeing about what a
      // placeholder is. The IT slug is safe by construction (assigned from the
      // already-cleaned id); these three are not.
      const check = inspectSlugForPromptPlaceholder(data.slugs[locale]);
      if (check.leaked) {
        console.warn(
          check.recovered
            ? `  ❌ [slug-placeholder] Slug ${locale} conteneva il segnaposto del prompt: "${original}" → "${check.slug}"`
            : `  ❌ [slug-placeholder] Slug ${locale} E' il segnaposto del prompt ("${original}"): niente di recuperabile.`,
        );
      }
      // Fall back to the IT slug rather than ship an empty one: an empty slug
      // routes to the section hub, silently making the article unreachable at
      // its own URL. The translated title is not an option HERE — this runs on
      // the Italian generation call, before `translateArticle()` — so the IT
      // slug is the only deterministic answer at this point, exactly as in the
      // missing-slug loop above. It is a valid, distinct URL: the locale prefix
      // and the hub segment already differ.
      data.slugs[locale] = check.slug || data.slugs.it;
      if (data.slugs[locale] !== original) {
        console.warn(`  ⚠️  Slug ${locale} sanitizzato: "${original}" → "${data.slugs[locale]}"`);
      }
    }
  }

  // ── Validate internal links in body content ──
  const VALID_NAV_ACTIONS = new Set([
    'calculator', 'exchange', 'health', 'cost-of-living', 'pension', 'pillar3',
    'payslip', 'tax-return', 'residency', 'ristorni', 'unemployment', 'jobs', 'companies', 'banks',
    'first-day', 'permits', 'border', 'calendar', 'whatif', 'shopping', 'transport',
    'salary-compare', 'traffic-history',
    'border-map', 'municipalities', 'car-transfer', 'car-cost', 'permit-compare', 'renovation',
    'mobile', 'ral', 'parental-leave', 'nursery', 'living-ch', 'living-it', 'livability',
  ]);
  for (const locale of ['it', 'en', 'de', 'fr']) {
    if (!data.content[locale]) continue; // translations may not exist yet
    // Coerce content fields to strings — AI models can return objects/arrays/numbers
    for (const field of ['title', 'excerpt', 'body1', 'body2', 'body3']) {
      const val = data.content[locale][field];
      if (val != null && typeof val !== 'string') {
        data.content[locale][field] = typeof val === 'object' ? JSON.stringify(val) : String(val);
      }
    }
    for (const field of ['body1', 'body2', 'body3']) {
      let text = data.content[locale][field] || '';
      // Remove raw <a href="..."> tags the AI might have inserted — they cause redirect issues
      text = text.replace(/<a\s+href="[^"]*"[^>]*>(.*?)<\/a>/gi, '$1');

      // IT-only editorial sanitizers (2026-05-12):
      // 1) Strip sentences that promote competitor newsletters/services
      //    (article 25714951592 shipped with "iscriversi alla newsletter
      //    giornaliera di Tio").
      // 2) Semantic validation of nav: links — strip when the link TEXT
      //    is off-topic for the action (e.g. "calcolatore di tragitti"
      //    pointing to nav:calculator which is the fiscal calculator).
      // Translations inherit the cleaned IT text via their own
      // generation step and are not re-checked semantically (Italian
      // keywords don't transfer 1:1 across locales).
      if (locale === 'it') {
        // 3) Strip fabricated "Esempi concreti / Casi pratici" sections
        //    that the LLM injects to force frontaliere relevance on a
        //    non-frontaliere source. See incident 2026-05-12 article
        //    `direttrice-unispital-zurigo-whistleblower` — body1 and
        //    body3 both ended with invented Ticino case bullets.
        //    Conservative: requires heading match + ≥1 suspicious bullet.
        const fab = stripFabricatedExamples(text);
        if (fab.removedSections > 0) {
          console.error(`  🧹  Strippate ${fab.removedSections} sezioni "Esempi concreti" fabbricate in ${locale}.${field} — es: ${(fab.examples[0] || '').slice(0, 80)}`);
        }
        const comp = stripCompetitorPromotion(fab.text);
        if (comp.removed > 0) {
          console.error(`  🧹  Rimossa promozione competitor in ${locale}.${field}: ${comp.removed} frase(i) — es: "${(comp.examples[0] || '').slice(0, 80)}..."`);
        }
        const nav = sanitizeNavLinkSemantics(comp.text);
        if (nav.stripped > 0) {
          console.error(`  🧹  Strippati ${nav.stripped} link nav: off-topic in ${locale}.${field} — es: ${nav.examples[0] || ''}`);
        }
        text = nav.text;
      }

      // Validate [text](nav:action) links — remove invalid actions
      // (unknown tokens). Runs on all locales so translations also
      // benefit from the existing valid-action check.
      text = text.replace(/\[([^\]]+)\]\(nav:([a-z-]+)\)/g, (_m, linkText, action) => {
        if (VALID_NAV_ACTIONS.has(action)) return _m; // keep valid
        console.error(`  ⚠️  Link invalido [${linkText}](nav:${action}) in ${locale}.${field} — rimosso`);
        return linkText; // strip invalid nav link, keep text
      });
      data.content[locale][field] = text;
    }
    // Validate FAQ structure if present (keep as array, don't coerce to string)
    if (data.content[locale].faq) {
      const faq = data.content[locale].faq;
      if (typeof faq === 'string') {
        try { data.content[locale].faq = JSON.parse(faq); } catch { delete data.content[locale].faq; }
      }
      if (Array.isArray(data.content[locale].faq)) {
        data.content[locale].faq = data.content[locale].faq.filter(pair =>
          pair && typeof pair.q === 'string' && typeof pair.a === 'string' &&
          pair.q.length > 10 && pair.a.length > 20
        ).slice(0, 7);
        if (data.content[locale].faq.length < 2) delete data.content[locale].faq;
      } else {
        delete data.content[locale].faq;
      }
    }
  }

  // Coerce all seo fields to strings — AI models can return objects/arrays/numbers
  if (data.seo && typeof data.seo === 'object') {
    for (const key of ['title', 'description', 'keywords', 'ogTitle', 'ogDescription', 'headline', 'breadcrumbName']) {
      if (data.seo[key] != null && typeof data.seo[key] !== 'string') {
        data.seo[key] = typeof data.seo[key] === 'object' ? JSON.stringify(data.seo[key]) : String(data.seo[key]);
      }
    }
  }

  return data;
}
// Programmatic enforcement: strip excess **bold** from body content.
// Rules: max 3 bold spans per body field; each span max 5 words;
// never bold numbers with currency (e.g. **350 CHF**), case/scenario labels,
// or phrases longer than 5 words.
function sanitizeBoldFormatting(data) {
  const MAX_BOLD_PER_FIELD = 1;
  const MAX_BOLD_WORDS = 5;
  // Pattern: number + optional space + currency code or symbol
  const CURRENCY_RE = /^\d[\d.,]*\s*(?:CHF|EUR|€|Fr\.|franchi|euro)/i;
  // Pattern: "Caso N:" or "Case N:" or "Fall N:" or "Cas N:" style labels
  const CASE_LABEL_RE = /^(?:Caso|Case|Fall|Cas|Esempio|Example|Beispiel|Exemple)\s+\d/i;
  // Generic label pattern such as "Dati rilevanti:" / "Key updates:".
  const GENERIC_LABEL_RE = /^[\p{L}\s'-]{2,40}:$/u;
  // Do not bold names of internal tools/actions.
  const TOOL_NAME_RE = /\b(calcolatore|comparatore|simulatore|convertitore|rechner|calculator|comparator|simulator|converter|outil|tool|nav:)\b/i;

  let totalStripped = 0;

  for (const locale of ['it', 'en', 'de', 'fr']) {
    if (!data.content[locale]) continue; // translations may not exist yet
    for (const field of ['body1', 'body2', 'body3']) {
      let text = String(data.content[locale][field] || '');
      const boldMatches = [...text.matchAll(/\*\*([^*]+)\*\*/g)];
      if (boldMatches.length === 0) {
        data.content[locale][field] = text;
        continue;
      }

      let kept = 0;
      for (const match of boldMatches) {
        const boldContent = match[1].trim();
        const wordCount = boldContent.split(/\s+/).length;
        const isCurrency = CURRENCY_RE.test(boldContent);
        const isCaseLabel = CASE_LABEL_RE.test(boldContent);
        const isGenericLabel = GENERIC_LABEL_RE.test(boldContent);
        const isToolName = TOOL_NAME_RE.test(boldContent);
        const tooLong = wordCount > MAX_BOLD_WORDS;
        const overLimit = kept >= MAX_BOLD_PER_FIELD;

        if (isCurrency || isCaseLabel || isGenericLabel || isToolName || tooLong || overLimit) {
          // Strip bold markers, keep text
          text = text.replace(match[0], boldContent);
          totalStripped++;
        } else {
          kept++;
        }
      }

      data.content[locale][field] = text;
    }
  }

  if (totalStripped > 0) {
    console.error(`  ✂️  Grassetto ridotto: ${totalStripped} occorrenze rimosse (max ${MAX_BOLD_PER_FIELD}/campo, max ${MAX_BOLD_WORDS} parole)`);
  }

  return data;
}

// ── Step 3a.1: Validate CTA / internal links in body3 ──────
const CTA_KEYWORDS_IT = [
  'calcolatore', 'comparatore', 'simulatore', 'convertitore', 'pianificatore',
  'frontaliereticino', 'confronto', 'calcola', 'strumenti', 'strumento',
  'nostro sito', 'il nostro', 'piattaforma', 'scopri', 'prova',
];
const CTA_KEYWORDS_EN = ['calculator', 'comparator', 'simulator', 'converter', 'planner', 'our site', 'our platform', 'tool', 'try our', 'discover'];
const CTA_KEYWORDS_DE = ['rechner', 'vergleich', 'simulator', 'umrechner', 'planer', 'unsere plattform', 'tool', 'werkzeug', 'entdecken'];
const CTA_KEYWORDS_FR = ['calculateur', 'comparateur', 'simulateur', 'convertisseur', 'planificateur', 'notre site', 'notre plateforme', 'outil', 'découvrez'];

const CTA_POOL = [
  {
    it: '\n\nPer un calcolo preciso del tuo stipendio netto come frontaliere, usa il nostro [comparatore fiscale](nav:calculator): confronta il netto in busta tra permesso G e permesso B con tutte le deduzioni aggiornate al 2026.',
    en: '\n\nFor a precise net salary calculation, use our [tax comparator](nav:calculator): compare take-home pay between G and B permits with all 2026 deductions.',
    de: '\n\nFür eine genaue Nettogehaltsberechnung nutzen Sie unseren [Steuervergleichsrechner](nav:calculator): vergleichen Sie G- und B-Bewilligung mit allen Abzügen 2026.',
    fr: '\n\nPour un calcul précis du salaire net, utilisez notre [comparateur fiscal](nav:calculator) : comparez permis G et permis B avec toutes les déductions 2026.',
  },
  {
    it: '\n\nSe stai valutando un\'offerta in Ticino, simula la tua [busta paga netta](nav:payslip): inserisci RAL, stato civile e comune di residenza per un preventivo dettagliato.',
    en: '\n\nEvaluating a Ticino job offer? Simulate your [net payslip](nav:payslip): enter gross salary, marital status and municipality for a detailed breakdown.',
    de: '\n\nJobangebot im Tessin? Simulieren Sie Ihre [Netto-Gehaltsabrechnung](nav:payslip): Bruttolohn, Familienstand und Wohngemeinde eingeben.',
    fr: '\n\nOffre d\'emploi au Tessin? Simulez votre [fiche de paie nette](nav:payslip) : salaire brut, état civil et commune de résidence.',
  },
  {
    it: '\n\nConfronta il [tasso di cambio CHF/EUR](nav:exchange) in tempo reale tra i principali provider: risparmi fino a 1.5% sulle commissioni del bonifico mensile.',
    en: '\n\nCompare the [CHF/EUR exchange rate](nav:exchange) in real time across providers: save up to 1.5% on monthly transfer fees.',
    de: '\n\nVergleichen Sie den [CHF/EUR-Wechselkurs](nav:exchange) in Echtzeit: sparen Sie bis zu 1,5% bei den monatlichen Überweisungsgebühren.',
    fr: '\n\nComparez le [taux CHF/EUR](nav:exchange) en temps réel : économisez jusqu\'à 1,5% sur les frais de virement mensuel.',
  },
  {
    it: '\n\nScopri le [offerte di lavoro in Ticino](nav:jobs) aggiornate quotidianamente: oltre 4.000 posizioni da aziende svizzere che assumono frontalieri.',
    en: '\n\nDiscover [Ticino job offers](nav:jobs) updated daily: 4,000+ positions from Swiss companies hiring cross-border workers.',
    de: '\n\nEntdecken Sie [Stellenangebote im Tessin](nav:jobs) — täglich aktualisiert: über 4.000 Stellen von Schweizer Unternehmen.',
    fr: '\n\nDécouvrez les [offres d\'emploi au Tessin](nav:jobs) mises à jour quotidiennement : plus de 4.000 postes.',
  },
  {
    it: '\n\nPianifica la tua [previdenza da frontaliere](nav:pension): calcola AVS, secondo pilastro e coordinamento INPS per evitare sorprese al pensionamento.',
    en: '\n\nPlan your [cross-border pension](nav:pension): calculate AVS, second pillar and INPS coordination to avoid retirement surprises.',
    de: '\n\nPlanen Sie Ihre [Grenzgänger-Vorsorge](nav:pension): AHV, zweite Säule und INPS-Koordination berechnen.',
    fr: '\n\nPlanifiez votre [prévoyance frontalier](nav:pension) : calculez AVS, deuxième pilier et coordination INPS.',
  },
  {
    it: '\n\nConfronta i [premi LAMal delle casse malati](nav:health) svizzere: fino a 200 CHF di differenza mensile tra compagnie per lo stesso cantone e franchigia.',
    en: '\n\nCompare [LAMal health insurance premiums](nav:health): up to CHF 200 monthly difference between providers for the same canton and deductible.',
    de: '\n\nVergleichen Sie die [LAMal-Prämien der Krankenkassen](nav:health): bis zu 200 CHF monatlicher Unterschied zwischen Anbietern.',
    fr: '\n\nComparez les [primes LAMal](nav:health) : jusqu\'à 200 CHF de différence mensuelle entre assureurs pour le même canton.',
  },
  {
    it: '\n\nVerifica le [scadenze fiscali](nav:calendar) per frontalieri: 730, dichiarazione svizzera, ristorni — tutte le date in un calendario interattivo.',
    en: '\n\nCheck [tax deadlines](nav:calendar) for cross-border workers: returns, Swiss declarations, rebates — all dates in one interactive calendar.',
    de: '\n\nÜberprüfen Sie die [Steuerfristen](nav:calendar) für Grenzgänger: alle Termine in einem interaktiven Kalender.',
    fr: '\n\nVérifiez les [échéances fiscales](nav:calendar) : déclarations, ristournes — toutes les dates dans un calendrier interactif.',
  },
  {
    it: '\n\nÈ il tuo primo giorno come frontaliere? La nostra [guida pratica](nav:first-day) ti accompagna dalla registrazione cantonale al primo stipendio.',
    en: '\n\nFirst day as a cross-border worker? Our [practical guide](nav:first-day) walks you from cantonal registration to your first paycheck.',
    de: '\n\nErster Tag als Grenzgänger? Unser [praktischer Leitfaden](nav:first-day) begleitet Sie von der Anmeldung bis zum ersten Gehalt.',
    fr: '\n\nPremier jour en tant que frontalier? Notre [guide pratique](nav:first-day) vous accompagne de l\'inscription au premier salaire.',
  },
];

function pickDefaultCTA(articleCategory) {
  const preferred = { fiscale: [0, 1, 6], pratico: [1, 7, 3], novita: [3, 0, 2], pensione: [4, 0, 5] };
  const indices = preferred[articleCategory] || [0, 1, 2];
  return CTA_POOL[indices[Math.floor(Math.random() * indices.length)]];
}

const DEFAULT_CTA = CTA_POOL[0];

function validateAndEnforceCTA(data) {
  const localeKeywords = { it: CTA_KEYWORDS_IT, en: CTA_KEYWORDS_EN, de: CTA_KEYWORDS_DE, fr: CTA_KEYWORDS_FR };
  const cta = pickDefaultCTA(data.category);

  for (const locale of ['it', 'en', 'de', 'fr']) {
    if (!data.content[locale]) continue; // translations may not exist yet
    const body3 = (data.content[locale].body3 || '').toLowerCase();
    const keywords = localeKeywords[locale];
    const hasCTA = keywords.some(kw => body3.includes(kw));

    if (!hasCTA) {
      console.error(`  ⚠️  CTA mancante in body3 [${locale}] — aggiungo CTA (${data.category})`);
      data.content[locale].body3 += cta[locale];
    }
  }

  return data;
}

// ── Step 3a.2: Enforce strong internal-link clusters ───────
// Guarantees at least 2 internal nav links in article body for SEO distribution.
// Cluster focus: taxes (entro/oltre 20km), pension, exchange CHF/EUR.
const LINK_CLUSTER_PATTERNS = {
  taxes20km: /(20\s?km|entro\s*i\s*20|oltre\s*i\s*20|imposta|irpef|credito\s*d[' ]?imposta|doppia\s+imposizione|accordo\s+fiscale|fascia)/i,
  pension: /(pensione|avs|inps|lpp|secondo\s+pilastro|terzo\s+pilastro|pillar\s*3)/i,
  exchange: /(cambio|chf|eur|franco|euro|tasso\s*di\s*cambio|valuta|bonifico|wise)/i,
};

const LINK_CLUSTER_ACTIONS = {
  taxes20km: ['calculator', 'tax-return'],
  pension: ['pension', 'pillar3'],
  exchange: ['exchange', 'banks'],
  generic: ['calculator', 'exchange'],
};

const INTERNAL_LINK_BLOCK = {
  it: {
    taxes20km: '\n\n## Tool utili per il tuo caso\nPer verificare in modo pratico il tuo scenario entro/oltre 20 km, usa il [calcolatore stipendio netto](nav:calculator) e la [guida dichiarazione redditi](nav:tax-return).',
    pension: '\n\n## Tool utili per la pianificazione\nPer stimare la strategia previdenziale, prova il [pianificatore pensionistico](nav:pension) e il [simulatore 3° pilastro](nav:pillar3).',
    exchange: '\n\n## Tool utili per massimizzare il netto\nPer ridurre la perdita sul cambio, confronta il [cambio CHF-EUR](nav:exchange) e le [banche per frontalieri](nav:banks).',
    generic: '\n\n## Tool consigliati\nPer una stima aggiornata, usa il [calcolatore stipendio netto](nav:calculator) e il [comparatore cambio CHF-EUR](nav:exchange).',
  },
  en: {
    taxes20km: '\n\n## Useful tools for your case\nTo verify your within/over 20 km tax scenario, use the [net salary calculator](nav:calculator) and the [tax return guide](nav:tax-return).',
    pension: '\n\n## Useful planning tools\nTo estimate your pension strategy, use the [pension planner](nav:pension) and the [pillar 3 simulator](nav:pillar3).',
    exchange: '\n\n## Useful tools to protect your net income\nTo reduce FX leakage, compare [CHF-EUR exchange options](nav:exchange) and [banks for cross-border workers](nav:banks).',
    generic: '\n\n## Recommended tools\nFor an updated estimate, use the [net salary calculator](nav:calculator) and the [CHF-EUR exchange comparator](nav:exchange).',
  },
  de: {
    taxes20km: '\n\n## Nützliche Tools für Ihren Fall\nUm Ihr Steuer-Szenario innerhalb/außerhalb von 20 km zu prüfen, nutzen Sie den [Nettolohnrechner](nav:calculator) und den [Leitfaden zur Steuererklärung](nav:tax-return).',
    pension: '\n\n## Nützliche Tools für die Planung\nFür Ihre Vorsorgestrategie nutzen Sie den [Rentenplaner](nav:pension) und den [Säule-3-Simulator](nav:pillar3).',
    exchange: '\n\n## Nützliche Tools zum Schutz Ihres Nettolohns\nUm Wechselkursverluste zu reduzieren, vergleichen Sie [CHF-EUR-Wechseloptionen](nav:exchange) und [Banken für Grenzgänger](nav:banks).',
    generic: '\n\n## Empfohlene Tools\nFür eine aktuelle Schätzung nutzen Sie den [Nettolohnrechner](nav:calculator) und den [CHF-EUR-Wechselvergleich](nav:exchange).',
  },
  fr: {
    taxes20km: '\n\n## Outils utiles pour votre cas\nPour vérifier votre scénario fiscal dans/hors des 20 km, utilisez le [calculateur de salaire net](nav:calculator) et le [guide déclaration fiscale](nav:tax-return).',
    pension: '\n\n## Outils utiles pour la planification\nPour estimer votre stratégie retraite, utilisez le [planificateur retraite](nav:pension) et le [simulateur 3e pilier](nav:pillar3).',
    exchange: '\n\n## Outils utiles pour protéger votre net\nPour réduire les pertes de change, comparez le [change CHF-EUR](nav:exchange) et les [banques pour frontaliers](nav:banks).',
    generic: '\n\n## Outils recommandés\nPour une estimation à jour, utilisez le [calculateur de salaire net](nav:calculator) et le [comparateur CHF-EUR](nav:exchange).',
  },
};

function enforceStrongInternalLinks(data) {
  for (const locale of ['it', 'en', 'de', 'fr']) {
    if (!data.content[locale]) continue;

    const body1 = String(data.content[locale].body1 || '');
    const body2 = String(data.content[locale].body2 || '');
    const body3 = String(data.content[locale].body3 || '');
    const context = `${data.id} ${data.content[locale].title || ''} ${data.content[locale].excerpt || ''} ${body1} ${body2} ${body3}`;

    const cluster =
      LINK_CLUSTER_PATTERNS.taxes20km.test(context) ? 'taxes20km'
      : LINK_CLUSTER_PATTERNS.pension.test(context) ? 'pension'
      : LINK_CLUSTER_PATTERNS.exchange.test(context) ? 'exchange'
      : 'generic';

    const actions = LINK_CLUSTER_ACTIONS[cluster];
    const combined = `${body1}\n${body2}\n${body3}`;
    const existingActions = new Set(
      [...combined.matchAll(/\[[^\]]+\]\(nav:([a-z-]+)\)/g)].map((m) => m[1])
    );
    const hasAllClusterLinks = actions.every((action) => existingActions.has(action));
    const totalLinks = [...combined.matchAll(/\[[^\]]+\]\(nav:[a-z-]+\)/g)].length;

    if (!hasAllClusterLinks || totalLinks < 2) {
      data.content[locale].body2 = `${body2}${INTERNAL_LINK_BLOCK[locale][cluster]}`;
      console.error(`  🔗 Link interni rinforzati in ${locale}.body2 (cluster: ${cluster})`);
    }
  }

  return data;
}

/** Lazy-loaded set of normalized existing IT blog titles (lowercased, trimmed,
 * brand suffix stripped). Populated on first call to detectTitleCollision. */
let _existingItTitlesCache = null;
function loadExistingItTitlesExcluding(currentArticleId) {
  if (_existingItTitlesCache === null) {
    const src = readSectionMetaIt();
    const map = new Map(); // articleId -> normalizedTitle
    const rx = metaFieldRegex('title');
    let m;
    while ((m = rx.exec(src)) !== null) {
      const articleId = m[1];
      const rawTitle = unescapeTsValue(m[2]);
      const normalized = rawTitle
        .replace(/\s*\|\s*Frontaliere Ticino\s*$/i, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      map.set(articleId, normalized);
    }
    _existingItTitlesCache = map;
  }
  // Build the set of "other articles' titles" — excluding the current
  // article so re-running on an existing slug doesn't false-positive collide.
  const others = new Set();
  for (const [articleId, normalized] of _existingItTitlesCache) {
    if (articleId !== currentArticleId) others.add(normalized);
  }
  return others;
}

/** Extract a 4-digit year from data.date or data.id (slug). */
function extractArticleYear(data) {
  if (data.date) {
    const d = new Date(data.date);
    if (!isNaN(d.getTime())) return String(d.getFullYear());
  }
  const m = String(data.id || '').match(/\b(20[2-3]\d)\b/);
  return m ? m[1] : '';
}

/** Extract a known city/region token from the slug (best-effort). */
function extractArticleCity(slug) {
  const KNOWN = [
    { key: 'lugano', name: 'Lugano' },
    { key: 'mendrisio', name: 'Mendrisio' },
    { key: 'bellinzona', name: 'Bellinzona' },
    { key: 'locarno', name: 'Locarno' },
    { key: 'chiasso', name: 'Chiasso' },
    { key: 'ticino', name: 'Ticino' },
    { key: 'milano', name: 'Milano' },
    { key: 'como', name: 'Como' },
    { key: 'varese', name: 'Varese' },
    { key: 'lombardia', name: 'Lombardia' },
  ];
  const cleaned = String(slug || '').toLowerCase();
  for (const c of KNOWN) {
    if (cleaned.includes(c.key)) return c.name;
  }
  return '';
}

function optimizeSeoMetadata(data) {
  const it = data.content?.it || {};
  if (!data.seo) data.seo = {};

  // ── Collision prevention (mirror og-pages runtime disambiguator) ──
  // The og-pages plugin appends " (2026)" / " — Bellinzona" / FNV hash at
  // build time when two articles produce the same base <title>. Prevent
  // those runtime disambiguators by mutating it.title HERE — at create
  // time — so the base title is unique by construction. Tracked by the
  // audit:title-no-disambig-hash ratchet (data/title-no-disambig-hash-baseline.json).
  const initialItTitle = String(it.title || data.id || 'Articolo frontalieri')
    .replace(/\s*\|\s*Frontaliere Ticino$/i, '')
    .trim();
  const existingTitles = loadExistingItTitlesExcluding(data.id);
  if (existingTitles.has(initialItTitle.toLowerCase())) {
    const year = extractArticleYear(data);
    const city = extractArticleCity(data.id);
    let mutated = initialItTitle;
    if (year && !mutated.includes(year)) {
      mutated = `${mutated} (${year})`;
      console.error(`  🪪 Collisione titolo IT — aggiunto anno: "${mutated}"`);
    } else if (city && !mutated.toLowerCase().includes(city.toLowerCase())) {
      mutated = `${mutated} — ${city}`;
      console.error(`  🪪 Collisione titolo IT — aggiunta città: "${mutated}"`);
    }
    if (mutated !== initialItTitle && !existingTitles.has(mutated.toLowerCase())) {
      it.title = mutated;
    } else {
      // Anno e città non sufficienti (o già nel titolo). Throw DUPLICATO
      // così il retry loop in main() ripesca un altro headline invece di
      // killare il workflow. Rule #1 (zero tolleranza) resta rispettata:
      // l'articolo duplicato non viene pubblicato.
      console.error(`  ❌ Titolo IT "${initialItTitle}" collide con un articolo esistente.`);
      console.error(`     Anno (${year || 'n/a'}) e città (${city || 'n/a'}) non bastano a disambiguare — provo un altro headline.`);
      throw new Error(`DUPLICATO: titolo IT "${initialItTitle}" collide con un articolo esistente`);
    }
  }

  // Universal rule (mirrors build-plugins/shared/titleSuffix.ts):
  // headline VERBATIM; brand suffix appended only when the total stays
  // within TITLE_MAX_CHARS (60 target + 10 % tolerance = 66). No headline
  // truncation — if the headline alone exceeds the cap, audit:title-length
  // flags it and the AI prompt must regenerate a shorter title.
  const TITLE_SUFFIX = ' | Frontaliere Ticino';
  const TITLE_MAX_CHARS = 66;
  const seoTitleCore = String(it.title || data.id || 'Articolo frontalieri')
    .replace(/\s*\|\s*Frontaliere Ticino$/i, '')
    .trim();
  const candidate = `${seoTitleCore}${TITLE_SUFFIX}`;
  data.seo.title = candidate.length <= TITLE_MAX_CHARS ? candidate : seoTitleCore;
  data.seo.ogTitle = data.seo.ogTitle ? String(data.seo.ogTitle).trim() : seoTitleCore;
  data.seo.headline = data.seo.headline ? String(data.seo.headline).trim() : seoTitleCore;
  data.seo.breadcrumbName = truncateAtWordBoundary(
    data.seo.breadcrumbName || seoTitleCore.split(/[:.–—]/)[0] || 'Articolo',
    42,
  );

  let desc = String(data.seo.description || it.excerpt || '').replace(/\s+/g, ' ').trim();
  if (!desc) desc = `${seoTitleCore}. Guida pratica per frontalieri tra Ticino e Italia con dati aggiornati 2026.`;
  if (desc.length < 145) {
    desc = `${desc}${desc.endsWith('.') ? '' : '.'} Dati aggiornati 2026 per frontalieri in Ticino.`;
  }
  data.seo.description = truncateAtWordBoundary(desc, 160);
  data.seo.ogDescription = truncateAtWordBoundary(
    data.seo.ogDescription || data.seo.description,
    SEO_OG_DESCRIPTION_MAX,
  );

  const STOP = new Set(['frontaliere', 'frontalieri', 'ticino', 'svizzera', 'italia', 'della', 'delle', 'degli', 'degli', 'come', 'guida']);
  const isStopYear = (w) => /^(19|20)\d{2}$/.test(w);
  const terms = `${it.title || ''} ${it.excerpt || ''} ${data.id || ''}`
    .toLowerCase()
    .replace(/[^a-z0-9àèéìòùäöüßç\s-]/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP.has(w) && !isStopYear(w));

  const uniqueTerms = [];
  for (const t of terms) {
    if (!uniqueTerms.includes(t)) uniqueTerms.push(t);
    if (uniqueTerms.length >= 4) break;
  }
  const baseKeywords = ['frontalieri', 'ticino', 'svizzera', 'italia'];
  data.seo.keywords = [...baseKeywords, ...uniqueTerms].slice(0, 8).join(', ');

  return data;
}

function evergreenTopicFamily(text) {
  const raw = String(text || '').toLowerCase();
  if (/\bpermess[oi]\b/.test(raw) && /\bg\b/.test(raw) && /\bb\b/.test(raw)) return 'permesso-g-b';
  const words = new Set(tokenizeIt(text).map(normalizeItWord));
  const hasAny = (tokens) => tokens.some((t) => words.has(t));
  const hasAll = (tokens) => tokens.every((t) => words.has(t));

  if (hasAll(['permess']) && hasAny(['residenz', 'soggiorn'])) return 'permesso-g-b';
  if (hasAny(['lamal']) && hasAny(['cmi'])) return 'lamal-cmi';
  if (hasAny(['avs']) && hasAny(['inps'])) return 'avs-inps';
  if (hasAny(['telelavor', 'smart']) && hasAny(['working', 'lavor'])) return 'telelavoro';
  if (hasAny(['credit']) && hasAny(['impost'])) return 'credito-imposta';
  if (hasAny(['dopp']) && hasAny(['imposizion'])) return 'doppia-imposizione';
  if (hasAny(['bust']) && hasAny(['pag'])) return 'busta-paga';
  if (hasAny(['cambi']) && (hasAny(['franc', 'chf']) || hasAny(['eur', 'euro']))) return 'cambio-chf-eur';
  if (hasAny(['document']) && hasAny(['lavor'])) return 'documenti-lavoro';
  if (hasAny(['ristorn'])) return 'ristorni';
  if (hasAny(['disoccup'])) return 'disoccupazione';
  if (hasAny(['second']) && hasAny(['pilastr', 'lpp'])) return 'secondo-pilastro';
  if (hasAny(['auto']) && hasAny(['pendolar', 'frontali'])) return 'auto-pendolare';
  // #3138 2026-07-02: pillar 8's 6 addon variants (entro/oltre 20km,
  // famiglia/single, simulazione, errori comuni) are all near-duplicates
  // of the base topic once it's published — this family classifies them
  // together so pre-flight rejects the whole neighborhood in one shot
  // instead of burning a generation attempt per addon.
  if (hasAny(['resid']) && hasAny(['comun', 'scelt'])) return 'residenza-comune';
  // 2026-07-17: new local-events/culture family (data-justified — see
  // TOPICAL_KEYWORDS comment). Deliberately NOT added to SATURATED_FAMILIES:
  // this is a fresh, currently-unsaturated pool meant to give the evergreen
  // fallback immediate headroom.
  if (hasAny(['festival', 'sagr', 'fier', 'manifestazion', 'concert', 'mercatin', 'spettacol', 'rassegn'])) return 'eventi-locali';
  return null;
}

function evergreenAngleTokens(text) {
  const structural = new Set([
    'frontali', 'frontalier', 'svizzer', 'ital', 'ticin',
    'guida', 'pratic', 'aggiornat', 'confront', 'simulazion', 'scenar',
    'regol', 'quando', 'come', 'cosa',
  ]);
  // L'anno e' strutturale come gli altri, ma era elencato a mano ('2025',
  // '2026') — cioe' stantio per costruzione. `buildDynamicEvergreenTopics*`
  // interpola `new Date().getFullYear()` in ogni keyword: al primo gennaio
  // 2027 l'anno sarebbe uscito dalla stoplist ed entrato nell'insieme
  // DISTINTIVO, abbassando la sovrapposizione di famiglia di ogni candidato e
  // riaprendo come nuovi centinaia di near-duplicate. Un test su 4 cifre
  // chiude la classe: per l'anno corrente e' un no-op esatto (2025 e 2026
  // erano gia' filtrati), quindi non cambia nessuna decisione di oggi.
  const isYear = (w) => /^(19|20)\d{2}$/.test(w);
  return filterDistinctive(tokenizeIt(text))
    .map(normalizeItWord)
    .filter((w) => w.length > 2 && !structural.has(w) && !isYear(w));
}

function preFlightEvergreenTopicCheck(candidate, existingArticles) {
  const keyword = String(candidate?.keyword || candidate || '');
  const angle = String(candidate?.angle || '');
  const candidateText = `${keyword} ${angle}`;
  const candidateFamily = evergreenTopicFamily(candidateText);
  const candidateTokens = evergreenAngleTokens(candidateText);
  // Raised 0.58→0.72 (2026-07-01, PR #3220 review follow-up): this pre-flight
  // gate runs BEFORE generation and used the exact title-Jaccard-on-shared-
  // fiscal-vocabulary check that #3220 identified as too aggressive in the
  // post-generation `checkForDuplicates` TITLE_THRESHOLD — but left this
  // earlier gate untouched, so candidates could still be rejected here before
  // ever reaching the loosened post-gen check. Kept in sync with TITLE_THRESHOLD.
  // Made corpus-size-adaptive 2026-07-17 (same staleness bug class as
  // EMBEDDING_NEAR_DUP_COSINE): a fixed threshold saturates as the combined
  // frontaliere+svizzera corpus grows, independent of true duplication —
  // rejected all 219 evergreen candidates in one run. See constants.mjs.
  const { titleJaccard: PRE_FLIGHT_THRESHOLD, familyOverlap: FAMILY_TOKEN_OVERLAP_THRESHOLD } =
    computeAdaptiveEvergreenThresholds(existingArticles.length);
  // Minimum distinctive (post-domain-stoplist) tokens required on BOTH sides
  // before the title_jaccard signal fires — mirrors preFlightHeadlineCheck's
  // TITLE_MIN_DISTINCTIVE guard (same fix already validated there for the
  // same class of false positive: short text sharing only shared domain
  // vocabulary like "frontaliere"/"svizzera"/"permesso" spiking Jaccard).
  const TITLE_MIN_DISTINCTIVE = 3;
  // 'residenza-comune' added 2026-07-02 (#3138): pillar 8's base topic was
  // just published, making its 6 addon variants immediate near-duplicates.
  const SATURATED_FAMILIES = new Set(['permesso-g-b', 'lamal-cmi', 'avs-inps', 'telelavoro', 'credito-imposta', 'residenza-comune']);
  const keywordDistinctive = filterDistinctive(tokenizeIt(keyword));

  for (const existing of existingArticles) {
    const existingText = `${existing.title || ''} ${existing.excerpt || ''} ${existing.id || ''}`;
    const existingTitleDistinctive = filterDistinctive(tokenizeIt(existing.title || ''));
    if (keywordDistinctive.length >= TITLE_MIN_DISTINCTIVE && existingTitleDistinctive.length >= TITLE_MIN_DISTINCTIVE) {
      const sim = jaccardSim(keywordDistinctive, existingTitleDistinctive);
      if (sim >= PRE_FLIGHT_THRESHOLD) {
        return { duplicate: true, signal: 'title_jaccard', sim, existingTitle: existing.title, existingId: existing.id };
      }
    }

    const existingFamily = evergreenTopicFamily(existingText);
    if (candidateFamily && existingFamily === candidateFamily) {
      const existingTokens = evergreenAngleTokens(existingText);
      const overlap = containmentSim(candidateTokens, existingTokens);
      if (SATURATED_FAMILIES.has(candidateFamily) || overlap >= FAMILY_TOKEN_OVERLAP_THRESHOLD || candidateTokens.length <= 3) {
        return {
          duplicate: true,
          signal: `evergreen_family:${candidateFamily}`,
          sim: overlap,
          existingTitle: existing.title,
          existingId: existing.id,
        };
      }
    }
  }

  return { duplicate: false };
}

// Cached alongside readAllSectionsMetaIt's cache — same process-lifetime
// invariant, and this is the heavier cost (two matchAll regex passes over
// the full cross-section source) that the evergreen pre-flight loop was
// re-paying on every candidate.
let _existingArticleSummariesCache = null;
function loadExistingArticleSummaries() {
  if (_existingArticleSummariesCache !== null) return _existingArticleSummariesCache;
  // Cross-section (2026-07-11): powers preFlightEvergreenCheck. Evergreen
  // topics recur in both sections, so a sibling-section twin must be caught
  // BEFORE spending an LLM generation cycle on a duplicate.
  const blogItSrc = readAllSectionsMetaIt();
  const titleMatches = [...blogItSrc.matchAll(metaFieldRegex('title'))];
  const excerptMatches = [...blogItSrc.matchAll(metaFieldRegex('excerpt'))];
  titleMatches.forEach((m) => { m[2] = unescapeTsValue(m[2]); });
  excerptMatches.forEach((m) => { m[2] = unescapeTsValue(m[2]); });
  const excerptsById = new Map(excerptMatches.map((m) => [m[1], m[2]]));
  _existingArticleSummariesCache = titleMatches.map((m) => ({
    id: m[1],
    title: m[2],
    excerpt: excerptsById.get(m[1]) || '',
  }));
  return _existingArticleSummariesCache;
}

// ── Date di pubblicazione, per il gate «argomento già coperto» ──────────────
// I titoli stanno nei meta (`blog-meta{,-ch}-it.ts`), le DATE stanno nei
// registri (`blog-articles-data.ts` / `swiss-articles-data.ts`): due file
// diversi, uniti qui per id. Cross-section per la stessa ragione di
// readAllSectionsMetaIt — le guide-mestiere vengono generate in entrambe le
// sezioni e un gemello nella sezione sorella deve contare.
//
// Il regex accetta fino a 300 caratteri fra `id:` e `date:` perché nel
// registro fra i due campi c'è `category:`; è ancorato a `id:` in modo che
// una voce senza `date` non rubi la data della voce successiva (il primo
// match per id vince e non si sovrascrive).
let _existingArticleDatesCache = null;
function loadExistingArticleDates() {
  if (_existingArticleDatesCache !== null) return _existingArticleDatesCache;
  const dates = new Map();
  for (const cfg of Object.values(ARTICLE_SECTION_CONFIGS)) {
    let src;
    try {
      src = read(cfg.registryFile);
    } catch { continue; } // registro assente (sezione non ancora popolata)
    const re = /id:\s*'([^']+)',[\s\S]{0,300}?date:\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (!dates.has(m[1])) dates.set(m[1], m[2]);
    }
  }
  _existingArticleDatesCache = dates;
  return _existingArticleDatesCache;
}

/**
 * Gli articoli esistenti con la loro data. Un id senza data resta senza:
 * findRecentTopicCoverage lo ignora (fail-open) invece di trattarlo come
 * appena pubblicato.
 *
 * Memoizzato come i due loader che unisce: il pre-flight lo chiama una volta
 * per candidato — centinaia di volte per run — e senza cache ogni chiamata
 * rialloccherebbe ~3.800 oggetti.
 */
let _existingArticleSummariesWithDatesCache = null;
function loadExistingArticleSummariesWithDates() {
  if (_existingArticleSummariesWithDatesCache !== null) return _existingArticleSummariesWithDatesCache;
  const dates = loadExistingArticleDates();
  _existingArticleSummariesWithDatesCache = loadExistingArticleSummaries()
    .map((a) => ({ ...a, date: dates.get(a.id) || null }));
  return _existingArticleSummariesWithDatesCache;
}

// ── Pre-flight evergreen keyword check ──────────────────────
// Lightweight duplicate check: compares evergreen keyword words against
// existing article titles using Jaccard similarity. Runs BEFORE calling
// Gemini to avoid wasting API calls on keywords that will certainly fail
// the post-generation duplicate detector.
function preFlightEvergreenCheck(candidate) {
  // «Argomento già coperto» PRIMA del Jaccard: i pool strutturali emettono due
  // candidati adiacenti per ogni entità, quindi il secondo è un duplicato
  // garantito del primo appena questo è pubblicato — `…stipendio requisiti` /
  // `quanto guadagna un…` per i mestieri (buildProfessionEvergreenTopics),
  // `vivere a X e lavorare in <canton>` / `trasferirsi a X pro e contro` per i
  // comuni (buildComuneEvergreenTopics). Intercettarlo qui risparmia il ciclo
  // LLM; il gate bloccante vero resta quello dopo la generazione (Step 3a.4),
  // che copre anche i percorsi non-evergreen.
  //
  // E resta necessario che ci siano ENTRAMBI: questo pre-flight guarda la
  // KEYWORD, mentre l'identità dell'articolo la sceglie l'LLM. Misurato sulla
  // run 31402084443: keyword «vivere a Tronzano Lago Maggiore e lavorare in
  // Ticino da frontaliere» → nessun conflitto, e l'articolo prodotto è uscito
  // con id `trasferirsi-a-tronzano-lago-maggiore-da-frontaliere-pro-e-contro`,
  // cioè l'ALTRO candidato della coppia. Solo il gate post-generazione vede
  // quello che l'articolo è davvero diventato.
  const keyword = String(candidate?.keyword || candidate || '');
  const covered = findRecentTopicCoverage(
    { id: keyword, title: keyword },
    loadExistingArticleSummariesWithDates(),
  );
  if (covered) {
    return {
      duplicate: true,
      signal: `topic_coverage:${covered.kind}:${covered.value}`,
      sim: 1,
      existingTitle: covered.existingTitle,
      existingId: covered.existingId,
    };
  }
  return preFlightEvergreenTopicCheck(candidate, loadExistingArticleSummaries());
}

// ── Pre-flight news headline check ──────────────────────────
// Catches semantic duplicates of news headlines BEFORE we burn 6 LLM cycles
// that would hard-fail at the title-collision gate in optimizeSeoMetadata.
// The URL dedup misses these: same news re-published on a different URL slug
// (e.g. follow-up commentary on cdt.ch the day after the breaking news on
// tio.ch) slips through.
//
// Primary signal is **containment against the article-ID slug** computed on
// DISTINCTIVE tokens only — i.e. after stripping the structural-domain
// vocabulary every frontaliere article shares (frontaliere, svizzera, ticino,
// permesso, lavoro, …).
//
// Why distinctive-only:
//   2026-05-11 measurement on the live run (25690785422): 92 of 224 headlines
//   were dropped by this gate (41 % of the pool). Of those 92 drops, 81 hit
//   the threshold at exactly 0.75 — the bare minimum. Inspection showed many
//   were fresh news stories with different angles ("UE reform impact on
//   unemployment" vs an existing "Swiss unemployment statistics for Jan")
//   that collided only because they share the 4 structural tokens
//   `frontaliere, svizzera, disoccup, ticino`.
//   At ~2.4k articles in the corpus, virtually every domain ID already has
//   these tokens; the gate had saturated and was now blocking fresh content.
//
// Fix:
//   1. DOMAIN_DUP_STOPLIST (defined near module top, ~line 543) removes
//      tokens that recur in ≥40 % of IDs (canonical synonym-map forms).
//   2. Containment computed on filtered token sets only.
//   3. ID needs ≥3 distinctive tokens after filtering to use the ID signal;
//      otherwise fall through to title Jaccard.
//   4. Thresholds unchanged because we're measuring on a meaningful denominator.
function preFlightHeadlineCheck(headline) {
  // Cross-section (2026-07-11): a news headline already covered in the sibling
  // section is a duplicate too (shared id/title namespace).
  const blogItSrc = readAllSectionsMetaIt();
  const titleMatches = [...blogItSrc.matchAll(metaFieldRegex('title'))];
  titleMatches.forEach((m) => { m[2] = unescapeTsValue(m[2]); });

  const headlineWords = tokenizeIt(headline);
  if (headlineWords.length < 3) return { duplicate: false }; // too short to compare reliably
  const headlineDistinctive = filterDistinctive(headlineWords);

  // Thresholds operate on DISTINCTIVE tokens after stoplist removal.
  // ID_MIN_DISTINCTIVE skips IDs that have lost too much signal to compare
  // reliably (e.g. `frontalieri-svizzera-italia-ticino` → 0 distinctive tokens).
  //
  // Raised 3→4 (2026-07-18): recurring hot-news families (e.g. the EU
  // unemployment-coordination reform saga for frontalieri) accumulate short
  // IDs whose domain-stripped distinctive set is just 3 tokens, ALL of them
  // the story's own recurring narrative words ("riforma", "disoccupazione",
  // a country name) rather than anything actually distinguishing. At 3 that
  // set gets fully contained (sim=1.0) by any fresh headline on the same
  // ongoing story, wrongly dropping real news before generation is even
  // attempted. Verified against the live corpus (3262 titles,
  // services/locales/blog-meta-it.ts + blog-meta-ch-it.ts): at 4, six
  // plausible new headlines about this saga all correctly pass, while two
  // near-verbatim rehashes of existing headlines are still caught (via the
  // title_jaccard signal below, unaffected by this change).
  const ID_CONTAINMENT_THRESHOLD = 0.75;
  const ID_MIN_DISTINCTIVE = 4;
  const TITLE_JACCARD_THRESHOLD = 0.55;
  const TITLE_MIN_DISTINCTIVE = 4;

  for (const m of titleMatches) {
    const existingId = m[1];
    const existingTitle = m[2];

    const idDistinctive = filterDistinctive(tokenizeIt(existingId));
    if (idDistinctive.length >= ID_MIN_DISTINCTIVE) {
      const idContainment = containmentSim(idDistinctive, headlineDistinctive);
      if (idContainment >= ID_CONTAINMENT_THRESHOLD) {
        return { duplicate: true, signal: 'id_containment', sim: idContainment, existingId, existingTitle };
      }
    }

    const titleDistinctive = filterDistinctive(tokenizeIt(existingTitle));
    if (titleDistinctive.length >= TITLE_MIN_DISTINCTIVE) {
      const titleSim = jaccardSim(headlineDistinctive, titleDistinctive);
      if (titleSim >= TITLE_JACCARD_THRESHOLD) {
        return { duplicate: true, signal: 'title_jaccard', sim: titleSim, existingId, existingTitle };
      }
    }
  }
  return { duplicate: false };
}

// ── Step 3a.2: Programmatic duplicate detection (multi-signal) ──
function checkForDuplicates(data) {
  // Read existing article titles AND excerpts across ALL sections (frontaliere
  // + svizzera). Cross-section coverage (was: active section only) so an
  // evergreen already published in the sibling section is caught — the
  // one-letter `…-frontaliere`/`…-frontalieri` twins, "vivere nei Grigioni",
  // etc. (2026-07-11). Same shared id/title namespace as getAllArticleIds.
  const blogItSrc = readAllSectionsMetaIt();
  const titleMatches = [...blogItSrc.matchAll(metaFieldRegex('title'))];
  const excerptMatches = [...blogItSrc.matchAll(metaFieldRegex('excerpt'))];
  titleMatches.forEach((m) => { m[2] = unescapeTsValue(m[2]); });
  excerptMatches.forEach((m) => { m[2] = unescapeTsValue(m[2]); });
  const existingArticles = titleMatches.map(m => {
    const id = m[1];
    const title = m[2];
    const exMatch = excerptMatches.find(e => e[1] === id);
    return { id, title, excerpt: exMatch ? exMatch[2] : '' };
  });

  // Also check IDs for exact match (all sections — shared id/SEO/i18n namespace)
  const existingIds = getAllArticleIds();

  // 1. Exact ID check
  if (existingIds.includes(data.id)) {
    throw new Error(`❌ DUPLICATO: L'ID "${data.id}" esiste già tra gli articoli pubblicati!`);
  }

  // ── Local tokenizer ────────────────────────────────────────
  // Differs from the shared `tokenizeIt`: strips punctuation entirely
  // (so "4.000" → "4000", not "000") because checkForDuplicates' thresholds
  // were tuned against numeric-collapse behavior. Stopwords/stemmer/synonyms
  // reuse scripts/lib/it-text-similarity.mjs's STOP_WORDS_IT directly — this
  // used to keep a byte-for-byte local copy of that Set, which is exactly the
  // drift risk AGENTS.md #6 flags (2026-07-18 sibling-pattern fix).
  function getSignificantWords(text) {
    return text.toLowerCase()
      .replace(/[^a-zàáèéìíòóùú0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS_IT.has(w))
      .map(w => normalizeItWord(w));
  }

  function jaccardSimilarity(wordsA, wordsB) {
    return jaccardSim(wordsA, wordsB);
  }

  // Extract key numbers, percentages, and statistics from text
  // These are strong duplicate signals (e.g. both articles cite "411.000" and "-1,0%")
  function extractKeyEntities(text) {
    const entities = new Set();
    const s = String(text || '');
    // Normalize: keep digits, dots, commas, %, +/-
    // Numbers like 411.000, 78'809, 411000
    for (const m of s.matchAll(/\d[\d.'',]*\d/g)) {
      entities.add(m[0].replace(/[.''',]/g, '')); // normalize to plain digits
    }
    // Standalone single digits with context (e.g. "Q4", "1%")
    for (const m of s.matchAll(/\b(\d+)[.,]?(\d*)\s*%/g)) {
      entities.add(`${m[1]}${m[2]}%`);
    }
    return [...entities];
  }

  // ── Prepare new article signals ────────────────────────────
  const newIdWords = data.id.split('-').filter(w => w.length > 1).map(w => normalizeItWord(w));
  const newTitleWords = getSignificantWords(data.content.it.title);
  const newExcerptWords = getSignificantWords(data.content.it.excerpt || '');
  const newEntities = extractKeyEntities(
    data.content.it.title + ' ' + (data.content.it.excerpt || '')
  );

  // ── Thresholds ─────────────────────────────────────────────
  // Any single signal OR the combined score exceeding its threshold → duplicate
  // Loosened 2026-07-01 (#3138 follow-up): the standalone titleSim trigger
  // (0.58) was firing on evergreen fiscal keywords that necessarily share
  // domain terminology ("quellensteuer", "svizzera", "2026", "permesso")
  // without being the same article — this burned most of the widened
  // evergreen pool from #3217 before it could ever be reached. Raised each
  // threshold ~15-25% so a title/excerpt alone must be near-identical, not
  // just topically related, to hard-block; the combined weighted score still
  // catches genuinely near-duplicate articles with different wording.
  const ID_THRESHOLD = 0.72;       // stricter: reduce false-positive duplicate IDs
  // TITLE_THRESHOLD made corpus-size-adaptive 2026-07-17: kept in sync with
  // preFlightEvergreenTopicCheck's titleJaccard (see constants.mjs) so an
  // evergreen candidate approved by the pre-flight gate is never
  // hard-rejected here post-generation — that would waste the exact LLM
  // cycle the pre-flight gate exists to avoid.
  const TITLE_THRESHOLD = computeAdaptiveEvergreenThresholds(existingArticles.length).titleJaccard; // near-identical title only (was 0.58, then fixed 0.72)
  const EXCERPT_THRESHOLD = 0.62;  // near-identical excerpt only (was 0.50)
  const COMBINED_THRESHOLD = 0.55; // catch semantically similar articles with different wording (was 0.48)

  console.error(`  🔍 Controllo duplicati multi-segnale (${existingArticles.length} articoli esistenti)...`);

  for (const existing of existingArticles) {
    const existingIdWords = existing.id.split('-').filter(w => w.length > 1).map(w => normalizeItWord(w));
    const existingTitleWords = getSignificantWords(existing.title);
    const existingExcerptWords = getSignificantWords(existing.excerpt);
    const existingEntities = extractKeyEntities(existing.title + ' ' + existing.excerpt);

    // Compute individual similarity scores
    const idSim = jaccardSimilarity(newIdWords, existingIdWords);
    const titleSim = jaccardSimilarity(newTitleWords, existingTitleWords);
    const excerptSim = jaccardSimilarity(newExcerptWords, existingExcerptWords);
    const entitySim = jaccardSimilarity(newEntities, existingEntities);

    // Weighted combined score
    const combinedScore =
      0.25 * idSim +
      0.30 * titleSim +
      0.25 * excerptSim +
      0.20 * entitySim;

    // Any signal OR combined score triggers duplicate detection
    const isDuplicate =
      (idSim >= ID_THRESHOLD && titleSim >= 0.40) ||
      titleSim >= TITLE_THRESHOLD ||
      (excerptSim >= EXCERPT_THRESHOLD && entitySim >= 0.20) ||
      // High entity overlap (same place/date/event) with moderate combined score
      (entitySim >= 0.65 && combinedScore >= 0.45) ||
      combinedScore >= COMBINED_THRESHOLD;

    if (isDuplicate) {
      const signals = [];
      if (idSim >= ID_THRESHOLD)
        signals.push(`ID: ${(idSim * 100).toFixed(0)}% ≥ ${ID_THRESHOLD * 100}%`);
      if (titleSim >= TITLE_THRESHOLD)
        signals.push(`Titolo: ${(titleSim * 100).toFixed(0)}% ≥ ${TITLE_THRESHOLD * 100}%`);
      if (excerptSim >= EXCERPT_THRESHOLD)
        signals.push(`Excerpt: ${(excerptSim * 100).toFixed(0)}% ≥ ${EXCERPT_THRESHOLD * 100}%`);
      if (combinedScore >= COMBINED_THRESHOLD)
        signals.push(`Combinato: ${(combinedScore * 100).toFixed(0)}% ≥ ${COMBINED_THRESHOLD * 100}%`);

      throw new Error(
        `❌ DUPLICATO RILEVATO:\n` +
        `   Nuovo:     "${data.content.it.title}" [${data.id}]\n` +
        `   Esistente: "${existing.title}" [${existing.id}]\n` +
        `   Segnali:   ${signals.join(' | ')}\n` +
        `   Dettaglio: ID=${(idSim * 100).toFixed(0)}% Titolo=${(titleSim * 100).toFixed(0)}% Excerpt=${(excerptSim * 100).toFixed(0)}% Entità=${(entitySim * 100).toFixed(0)}% Combinato=${(combinedScore * 100).toFixed(0)}%\n` +
        `   Scegli un argomento diverso o più specifico.`
      );
    }
  }

  // 3. Also check slug overlap (different title, same slug concept), across
  // EVERY locale — see checkTranslatedSlugCollisions() below for the
  // rationale (#3010: this is exactly how the svizzera near-duplicate pairs
  // collided). Extracted into its own exported function so non-AI generation
  // paths that derive their own translated slugs (e.g.
  // publish-journalist-article.mjs's deriveLocaleSlugs()) reuse this SAME
  // guard instead of re-implementing (and potentially forgetting) it.
  checkTranslatedSlugCollisions(data);

  console.error('  ✅ Nessun duplicato rilevato');
  return data;
}

/**
 * Guards slug uniqueness for EVERY locale (it/en/de/fr) against the ACTIVE
 * section's slug-data file — slugs only collide within a section's URL space
 * (`/articoli-frontaliere/{slug}` vs `/articoli-svizzera/{slug}` are distinct
 * hubs). The registry stores one localized slug per locale-slot (`'id': {
 * it: '…', en: '…', de: '…', fr: '…' }`) and REVERSE_SWISS/REVERSE_BLOG are
 * last-write-wins: two articles sharing the same EN/DE/FR slug make the
 * earlier one unreachable in that locale (its buildPath → parsePath
 * round-trip resolves to the sibling). The IT slug is human-authored (or, for
 * the journalist path, fixed to the article id) and typically already
 * unique; the EN/DE/FR slugs are auto-translated and historically went
 * UNCHECKED here — that is exactly how the svizzera pairs collided (de-duped
 * by data fix #3000) and how 36 frontaliere pairs still collide. Guard each
 * locale against its OWN slot so a colliding translation fails generation
 * loudly instead of poisoning the registry and surfacing later as main-red
 * on the routing round-trip test.
 */
function checkTranslatedSlugCollisions(data) {
  // `routerSrc` here was previously a dangling reference left by the section
  // refactor (it was a local of modifyRouterTs), which threw "routerSrc is
  // not defined" and broke EVERY generation run.
  const sectionSlugSrc = readSectionSlugData();
  for (const locale of ['it', 'en', 'de', 'fr']) {
    const newSlug = data.slugs[locale];
    // A nullish slug builds a degenerate regex (`escapeRegex(undefined)` → '')
    // that never matches a populated slot → the overlap check silently passes
    // and a real duplicate slips through (two articles, same URL, canonical
    // confusion). Fail loud instead of false-negative.
    if (!newSlug) {
      throw new Error(`❌ Slug "${locale}" mancante prima del controllo duplicati (data.slugs.${locale}=${newSlug}).`);
    }
    // Anchor on the matching locale slot, not any quoted token: the slug-data
    // file stores all four locales as strings per entry, either on a single line
    // (`'id': { it: '…', en: '…', de: '…', fr: '…' }`) or expanded across
    // lines — both formats appear in routerSwissData.ts. `\s*` covers both.
    // Double-quote variant (`it: "…"`) is also matched: a formatter or manual
    // edit could switch quote style and a single-quote-only regex would silently
    // miss the collision (silent zero-check). Both cases share the backreference
    // guard so `it: 'slug"` (mixed quotes) never false-positives.
    // Scoping to `${locale}:` checks it-vs-it, en-vs-en, … so cross-locale
    // coincidences don't false-trip while genuine same-locale collisions are caught.
    const slugPattern = new RegExp(`\\b${locale}:\\s*(['"])${escapeRegex(newSlug)}\\1`, 'g');
    if (slugPattern.test(sectionSlugSrc)) {
      throw new Error(`❌ DUPLICATO: Lo slug ${locale} "${newSlug}" esiste già in ${SECTION_SLUG_DATA_FILE}!`);
    }
  }
}

// ── Image search helpers ──

/**
 * Map of Italian keywords from article titles → English Wikimedia search terms.
 * `category`: Pixabay category used to tighten stock-photo ranking. Valid values:
 * backgrounds, fashion, nature, science, education, feelings, health, people,
 * religion, places, animals, industry, computer, food, sports, transportation,
 * travel, buildings, business, music.
 */
const TOPIC_SEARCH_MAP = [
  { keywords: ['benzina', 'carburante', 'petrolio', 'diesel', 'rifornimento'], queries: ['fuel station Switzerland', 'gas pump Europe'], category: 'transportation' },
  { keywords: ['tasse', 'fiscale', 'imposta', 'irpef', 'fisco', 'deduzioni'], queries: ['tax office building', 'financial documents desk'], category: 'business' },
  { keywords: ['salute', 'malattia', 'lamal', 'assicurazione', 'premio'], queries: ['hospital Switzerland modern', 'health insurance card'], category: 'health' },
  { keywords: ['lavoro', 'impiego', 'occupazione', 'assunzione', 'disoccup'], queries: ['modern office workplace', 'job interview meeting'], category: 'business' },
  { keywords: ['confine', 'dogana', 'frontiera', 'frontalier', 'permesso'], queries: ['Swiss Italian border crossing', 'customs checkpoint Europe'], category: 'places' },
  { keywords: ['treno', 'ferrovia', 'trasporto', 'pendolar', 'tilo'], queries: ['train station Switzerland', 'commuter train Alps'], category: 'transportation' },
  { keywords: ['casa', 'affitto', 'immobiliare', 'appartamento', 'mutuo'], queries: ['apartment building Switzerland', 'residential area Ticino'], category: 'buildings' },
  { keywords: ['banca', 'finanziario', 'cambio', 'valuta', 'franco', 'euro'], queries: ['Swiss bank building', 'currency exchange counter'], category: 'business' },
  { keywords: ['scuola', 'formazione', 'educazione', 'universit', 'corso'], queries: ['university campus Switzerland', 'classroom education'], category: 'education' },
  { keywords: ['pensione', 'avs', 'pilastro', 'previdenza', 'anzian'], queries: ['retirement couple walking', 'pension fund documents'], category: 'people' },
  { keywords: ['salario', 'stipendio', 'busta paga', 'reddito', 'retribuzion'], queries: ['salary paycheck document', 'business accounting office'], category: 'business' },
  { keywords: ['dumping', 'sindacat', 'contratto', 'ccl'], queries: ['labor union protest Switzerland', 'workers rights demonstration'], category: 'people' },
  { keywords: ['voto', 'elezioni', 'referendum', 'iniziativa', 'parlament'], queries: ['Swiss parliament Bern', 'voting ballot Switzerland'], category: 'buildings' },
  { keywords: ['clima', 'meteo', 'alluvione', 'tempesta', 'neve'], queries: ['weather Alps Switzerland', 'storm clouds mountains'], category: 'nature' },
  { keywords: ['polizia', 'sicurezza', 'reato', 'accident'], queries: ['police patrol Switzerland', 'road safety checkpoint'], category: 'transportation' },
  { keywords: ['ospedale', 'medico', 'farmacia', 'sanitar'], queries: ['medical center Switzerland', 'doctor consultation'], category: 'health' },
  { keywords: ['costruzione', 'cantiere', 'ediliz', 'ristrutturazione'], queries: ['construction site Switzerland', 'building renovation'], category: 'industry' },
  { keywords: ['supermercato', 'spesa', 'prezzi', 'costo vita'], queries: ['supermarket grocery store', 'shopping food prices'], category: 'business' },
  { keywords: ['auto', 'macchina', 'traffico', 'stradale', 'autostrada'], queries: ['highway traffic Switzerland', 'car road Alps'], category: 'transportation' },
  { keywords: ['economia', 'pil', 'crescita', 'mercato', 'commercial'], queries: ['business district Zurich', 'economic growth chart'], category: 'business' },
  { keywords: ['bambini', 'famiglia', 'asilo', 'nido', 'genitor'], queries: ['family park Switzerland', 'kindergarten playground'], category: 'people' },
  { keywords: ['golfo', 'guerra', 'conflitto', 'geopolitica', 'medio oriente'], queries: ['oil tanker shipping port', 'cargo ship Mediterranean'], category: 'industry' },
  { keywords: ['tecnologia', 'digitale', 'intelligenza artificiale', 'innovation'], queries: ['technology office workspace', 'digital innovation center'], category: 'computer' },
];

/**
 * Tag denylist: if a stock-photo hit is tagged with any of these AND the article
 * is not clearly about that topic, reject the hit. Prevents pasta images on
 * articles about "frontalieri" etc.
 */
const IMAGE_TAG_DENYLIST = {
  food: ['food', 'pasta', 'spaghetti', 'pizza', 'cheese', 'meal', 'dish', 'cooking', 'kitchen', 'restaurant', 'cuisine', 'recipe', 'ingredient', 'plate', 'breakfast', 'lunch', 'dinner', 'dessert', 'cake', 'bread', 'fruit', 'vegetable', 'wine', 'drink', 'coffee', 'beverage'],
  people_closeup: ['wedding', 'bride', 'groom', 'kiss', 'romance', 'love', 'couple'],
  pets: ['dog', 'cat', 'puppy', 'kitten', 'pet'],
};

/** Italian keywords that indicate the article IS about food/drink */
const FOOD_ARTICLE_KEYWORDS = ['cibo', 'cucina', 'ristorante', 'pasta', 'pizza', 'gastronomi', 'enologi', 'vino', 'birra', 'caffè', 'caffe', 'ricetta', 'pranzo', 'cena', 'colazione'];

/** Extract Italian article title (lowercased) for topic matching */
function _articleTitleLower(data) {
  return (data.title || data.content?.it?.title || data.content?.title || '').toLowerCase();
}

/** Return true if image tags appear relevant to the article (not an off-topic category). */
function _isImageRelevant(tagsString, data) {
  if (!tagsString) return true; // no tags → can't reject
  const tags = tagsString.toLowerCase().split(/[,;|]/).map(t => t.trim()).filter(Boolean);
  if (tags.length === 0) return true;
  const title = _articleTitleLower(data);
  const isFoodArticle = FOOD_ARTICLE_KEYWORDS.some(k => title.includes(k));
  for (const [topic, denied] of Object.entries(IMAGE_TAG_DENYLIST)) {
    if (topic === 'food' && isFoodArticle) continue;
    if (tags.some(t => denied.includes(t))) return false;
  }
  return true;
}

/** Infer a Pixabay category hint from article title, or null if none matches. */
function _inferPixabayCategory(data) {
  const title = _articleTitleLower(data);
  for (const entry of TOPIC_SEARCH_MAP) {
    if (entry.keywords.some(k => title.includes(k))) return entry.category || null;
  }
  return null;
}

/** Build topic-specific search queries from article data */
function _buildWikimediaQueries(data) {
  const title = (data.title || data.content?.it?.title || data.content?.title || '').toLowerCase();
  const category = (data.category || '').toLowerCase();
  const queries = [];

  // 1. Extract topic-based queries from title keywords
  for (const entry of TOPIC_SEARCH_MAP) {
    if (entry.keywords.some(k => title.includes(k))) {
      queries.push(...entry.queries);
      if (queries.length >= 3) break; // Max 3 topic queries
    }
  }

  // 2. Check for city names in title
  const cities = ['lugano', 'bellinzona', 'locarno', 'mendrisio', 'chiasso', 'ascona'];
  const cityMatch = cities.find(c => title.includes(c));
  if (cityMatch) {
    queries.push(`${cityMatch} Switzerland photo`);
  }

  // 3. Category-based fallback if no topic match
  if (queries.length === 0) {
    const catMap = {
      novita: ['Switzerland news editorial photo', 'Ticino newspaper press'],
      fisco: ['tax office documents Swiss', 'financial calculation desk'],
      lavoro: ['modern office workspace Swiss', 'job interview professional'],
      salute: ['Swiss hospital medical center', 'health care pharmacy'],
      vita: ['daily life Switzerland Ticino', 'Swiss town square people'],
      economia: ['business district Swiss bank', 'economy finance Zurich'],
    };
    if (catMap[category]) {
      queries.push(...catMap[category]);
    }
  }

  // 4. Diverse generic fallbacks (rotated by day to avoid repetition)
  const generics = [
    'Swiss Alps panorama mountain', 'Lake Lugano sunset boating',
    'Ticino village stone street', 'Bellinzona castle medieval',
    'Mendrisio vineyard autumn', 'Locarno piazza grande',
    'Swiss Italian architecture colorful', 'Gotthard pass scenic road',
    'Como lake panorama', 'Swiss railway bridge Ticino',
    'Ascona lakefront promenade', 'Lugano Monte Bre funicular',
  ];
  // Select 2-3 generics rotated by day of year
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86400000);
  for (let i = 0; i < 3; i++) {
    const idx = (dayOfYear + i * 4 + (data.id || '').length) % generics.length;
    if (!queries.includes(generics[idx])) {
      queries.push(generics[idx]);
    }
  }

  return queries;
}

/** Load previously used Wikimedia image URLs to avoid repeats */
function _loadUsedImageUrls() {
  const trackingFile = path.join(process.cwd(), 'data', 'blog-images-used.json');
  try {
    const raw = readFileSync(trackingFile, 'utf8');
    const entries = JSON.parse(raw);
    return new Set(Object.values(entries));
  } catch {
    return new Set();
  }
}

/** Save a used Wikimedia image URL for dedup tracking */
function _saveUsedImageUrl(articleId, imageUrl) {
  const trackingFile = path.join(process.cwd(), 'data', 'blog-images-used.json');
  let entries = {};
  try {
    entries = JSON.parse(readFileSync(trackingFile, 'utf8'));
  } catch { /* first use */ }
  entries[articleId] = imageUrl;
  writeFileSync(trackingFile, JSON.stringify(entries, null, 2) + '\n');
}

async function generateArticleImage(data) {
  // Derive concrete English subject clause from TOPIC_SEARCH_MAP so the generator
  // doesn't default to generic "people in a street" when the title says "frontalieri".
  const subjectTitle = _articleTitleLower(data);
  let topicSubject = null;
  for (const entry of TOPIC_SEARCH_MAP) {
    if (entry.keywords.some(k => subjectTitle.includes(k))) { topicSubject = entry.queries[0]; break; }
  }
  const subjectLine = topicSubject ? `\n\nMAIN SUBJECT: ${topicSubject}. This must be the dominant element in the frame.` : '';
  const fallbackImagePrompt = IS_FRONTALIERE
    ? `Professional editorial photo for a news article about cross-border workers in Ticino, Switzerland. Lake Lugano, warm lighting.`
    : `Professional editorial photo for a Swiss national news article. A recognizable Swiss national or cantonal scene appropriate to the topic, natural warm lighting.`;
  const prompt = (data.imagePrompt || fallbackImagePrompt)
    + subjectLine
    + '\n\nIMPORTANT: Generate ONLY the image, do NOT include any text, watermarks, labels, or captions on the image.'
    + '\n\nSTYLE: Photorealistic editorial photograph indistinguishable from a real DSLR/mirrorless camera shot. Include natural lens characteristics: shallow depth of field, subtle chromatic aberration, realistic bokeh on out-of-focus areas, natural film grain, slight vignetting. Lighting must be natural and ambient — avoid flat, evenly-lit AI look. Include micro-imperfections: slight motion blur on peripheral elements, natural color temperature shifts, realistic shadow falloff. Absolutely NO AI artifacts, NO unnaturally smooth textures, NO perfect symmetry, NO CGI plastic look, NO HDR over-processing.';

  const imgDir = resolve('public/images/blog');
  mkdirSync(imgDir, { recursive: true });
  const imgPath = resolve(`public/images/blog/${data.id}.webp`);

  // ── Helper: save raw image buffer, optimize, return path or null ──
  async function _saveAndOptimize(rawBuffer, providerLabel, contentType = 'image/jpeg') {
    if (rawBuffer.length < 5000) {
      console.error(`  ⚠️ Immagine troppo piccola (${rawBuffer.length} bytes) da ${providerLabel}`);
      return null;
    }
    const sourceExt = (contentType || '').includes('png') ? 'png' : (contentType || '').includes('webp') ? 'webp' : 'jpg';
    const tempPath = resolve(`public/images/blog/${data.id}.source.${sourceExt}`);
    writeFileSync(tempPath, rawBuffer);
    const rawKB = (rawBuffer.length / 1024).toFixed(0);
    const result = await optimizeImageToWebp(tempPath, imgPath);
    if (existsSync(tempPath)) unlinkSync(tempPath);

    if (result.ok) {
      const finalKb = (result.after / 1024).toFixed(0);
      const beforeKb = (result.before / 1024).toFixed(0);
      const overTarget = result.after > BLOG_IMAGE_HARD_MAX_BYTES ? ' ⚠️ sopra hard cap' : '';
      console.error(`  ✅ Immagine generata e ottimizzata: public/images/blog/${data.id}.webp (${beforeKb} KB → ${finalKb} KB, ${providerLabel})${overTarget}`);
    } else {
      if (rawBuffer.length > BLOG_IMAGE_HARD_MAX_BYTES) {
        console.error(`  ⚠️ Immagine raw troppo pesante (${rawKB} KB) e optimizer non disponibile. Provo provider successivo...`);
        return null;
      }
      writeFileSync(imgPath, rawBuffer);
      console.error(`  ✅ Immagine generata (raw fallback): public/images/blog/${data.id}.webp (${rawKB} KB, ${providerLabel})`);
    }

    // ── Post-save width enforcement ──
    // Google News, Discover, and Open Graph require ≥1200px wide images.
    // If the optimizer (sharp or system binaries) wasn't available, or if the
    // AI provider returned an undersized image, the saved file may be < 1200px.
    // Force-upscale to 1200px wide to guarantee visibility on all Google surfaces.
    try {
      const sharpMod = await import('sharp');
      const shp = sharpMod.default || sharpMod;
      const meta = await shp(imgPath).metadata();
      if (meta.width && (meta.width < 1200 || meta.height < 675)) {
        const buf = await shp(imgPath)
          .resize({ width: 1200, height: 675, fit: 'cover', position: 'attention' })
          .webp({ quality: 75, effort: 4 })
          .toBuffer();
        writeFileSync(imgPath, buf);
        console.error(`  📐 Resized ${meta.width}×${meta.height} → 1200×675 (Google Discover minimum)`);
      }
    } catch {
      // sharp not available — image stays as-is (acceptable in rare CI edge cases)
    }

    const generatedPath = `/images/blog/${data.id}.webp`;
    appendCatalogEntry(generatedPath);
    return generatedPath;
  }

  // ── Strategy 1: Gemini native image generation (free tier) ──
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    const modelsToTry = [IMAGE_MODEL_FLASH, IMAGE_MODEL_PRO];
    let geminiQuotaExhausted = false;
    for (const model of modelsToTry) {
      if (geminiQuotaExhausted) break;
      try {
        const isPro = model === IMAGE_MODEL_PRO;
        console.error(`🎨 Generazione immagine con ${isPro ? 'Gemini 3 Pro Image' : 'Gemini 2.5 Flash Image'}...`);

        const endpoint = `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`;
        // Note: imageSize:'1K' removed — it causes Gemini to output 1024x1024 squares.
        // aspectRatio:'16:9' alone produces proper landscape output.
        const generationConfig = isPro
          ? { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9' } }
          : { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9' } };

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig,
          }),
          signal: AbortSignal.timeout(120000),
        });

        if (!res.ok) {
          // 429 = quota exceeded — account-wide, skip all remaining Gemini models
          if (res.status === 429) {
            geminiQuotaExhausted = true;
            throw new Error('quota Gemini esaurita (429)');
          }
          const errText = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status}: ${errText.slice(0, 120)}`);
        }

        const json = await res.json();
        const parts = json.candidates?.[0]?.content?.parts || [];
        const imagePart = parts.find(p => p.inlineData?.data && !p.thought);
        if (!imagePart) throw new Error('Nessuna immagine nella risposta Gemini');

        const base64 = imagePart.inlineData.data;
        const mimeType = imagePart.inlineData.mimeType || 'image/jpeg';
        const rawBuffer = Buffer.from(base64, 'base64');
        const saved = await _saveAndOptimize(rawBuffer, `Gemini/${model}`, mimeType);
        if (saved) return saved;
      } catch (e) {
        console.error(`  ⚠️  Gemini fallito: ${e.message}`);
      }
    }
  }

  // ── Strategy 2: Pollinations.ai (free, no API key) ──
  // https://gen.pollinations.ai — free AI image generation, no auth needed
  // Migrated from image.pollinations.ai/prompt/ → gen.pollinations.ai/image/ (2025)
  // Only try 2 models with 1 retry; if origin is down (530/502/503) skip all.
  const pollinationsModels = ['flux', 'flux-realism'];
  let pollinationsOriginDown = false;
  for (const pModel of pollinationsModels) {
    if (pollinationsOriginDown) break;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) {
          console.error(`  🔄 Retry Pollinations/${pModel} dopo 10s...`);
          await new Promise(r => setTimeout(r, 10000));
        }
        console.error(`🎨 Generazione immagine con Pollinations.ai (${pModel})...`);
        const encodedPrompt = encodeURIComponent(
          prompt.replace(/\n/g, ' ').slice(0, 800)
        );
        const pollinationsUrl = `https://gen.pollinations.ai/image/${encodedPrompt}?width=1280&height=720&model=${pModel}&nologo=true&seed=${Date.now()}`;

        const res = await fetch(pollinationsUrl, {
          signal: AbortSignal.timeout(120000),
          redirect: 'follow',
        });

        if (!res.ok) {
          if ((res.status === 530 || res.status === 502 || res.status === 503) && attempt < 1) {
            throw new Error(`HTTP ${res.status} (retry)`);
          }
          // Origin-level errors mean all models are down
          if (res.status === 530 || res.status === 502 || res.status === 503) {
            pollinationsOriginDown = true;
          }
          throw new Error(`HTTP ${res.status}`);
        }

        const contentType = res.headers.get('content-type') || '';
        if (!contentType.startsWith('image/')) {
          throw new Error(`Risposta non è un'immagine: ${contentType}`);
        }

        const arrayBuf = await res.arrayBuffer();
        const rawBuffer = Buffer.from(arrayBuf);
        const saved = await _saveAndOptimize(rawBuffer, `Pollinations/${pModel}`, contentType);
        if (saved) return saved;
        break;
      } catch (e) {
        console.error(`  ⚠️  Pollinations/${pModel} fallito: ${e.message}`);
        if (e.message.includes('(retry)')) continue;
        break;
      }
    }
  }
  if (pollinationsOriginDown) console.error('  ⚠️  Pollinations.ai non raggiungibile — origin down');

  // ── Strategy 2b: Together.ai (FLUX.1-schnell-Free, free tier with key) ──
  // https://www.together.ai — free model, needs TOGETHER_API_KEY secret in GH
  const togetherKey = process.env.TOGETHER_API_KEY;
  if (togetherKey) {
    try {
      console.error('🎨 Generazione immagine con Together.ai (FLUX.1-schnell-Free)...');
      const togetherRes = await fetch('https://api.together.xyz/v1/images/generations', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${togetherKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'black-forest-labs/FLUX.1-schnell-Free',
          prompt: prompt.replace(/\n/g, ' ').slice(0, 800),
          width: 1280,
          height: 720,
          steps: 4,
          n: 1,
          response_format: 'b64_json',
        }),
        signal: AbortSignal.timeout(90000),
      });
      if (!togetherRes.ok) {
        const errText = await togetherRes.text().catch(() => '');
        throw new Error(`HTTP ${togetherRes.status}: ${errText.slice(0, 200)}`);
      }
      const togetherJson = await togetherRes.json();
      const b64 = togetherJson.data?.[0]?.b64_json;
      if (!b64) throw new Error('Nessuna immagine nella risposta Together.ai');
      const rawBuffer = Buffer.from(b64, 'base64');
      const saved = await _saveAndOptimize(rawBuffer, 'Together.ai/FLUX-schnell', 'image/jpeg');
      if (saved) return saved;
    } catch (e) {
      console.error(`  ⚠️  Together.ai fallito: ${e.message}`);
    }
  }

  // ── Strategy 2c: Fal.ai (FLUX schnell, needs FAL_KEY secret in GH) ──
  // https://fal.ai — pay-per-use with free credits, very fast FLUX inference
  const falKey = process.env.FAL_KEY;
  if (falKey) {
    try {
      console.error('🎨 Generazione immagine con Fal.ai (FLUX schnell)...');
      const falRes = await fetch('https://fal.run/fal-ai/flux/schnell', {
        method: 'POST',
        headers: {
          Authorization: `Key ${falKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: prompt.replace(/\n/g, ' ').slice(0, 800),
          image_size: 'landscape_16_9',
          num_inference_steps: 4,
          num_images: 1,
        }),
        signal: AbortSignal.timeout(90000),
      });
      if (!falRes.ok) {
        const errText = await falRes.text().catch(() => '');
        throw new Error(`HTTP ${falRes.status}: ${errText.slice(0, 200)}`);
      }
      const falJson = await falRes.json();
      const falImgUrl = falJson.images?.[0]?.url;
      if (!falImgUrl) throw new Error('Nessuna immagine nella risposta Fal.ai');
      const falImgRes = await fetch(falImgUrl, { signal: AbortSignal.timeout(30000) });
      if (!falImgRes.ok) throw new Error(`Download HTTP ${falImgRes.status}`);
      const falBuf = Buffer.from(await falImgRes.arrayBuffer());
      const falContentType = falImgRes.headers.get('content-type') || 'image/jpeg';
      const saved = await _saveAndOptimize(falBuf, 'Fal.ai/FLUX-schnell', falContentType);
      if (saved) return saved;
    } catch (e) {
      console.error(`  ⚠️  Fal.ai fallito: ${e.message}`);
    }
  }

  // ── Strategy 3: HuggingFace Inference API (free, FLUX-schnell) ──
  // https://huggingface.co/docs/api-inference — free tier with HF_TOKEN
  // FLUX-1-schnell is one of the fastest open-source text-to-image models
  // NOTE: HF migrated from api-inference.huggingface.co → router.huggingface.co (2025)
  const hfToken = process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN;
  if (hfToken) {
    const hfModels = [
      'black-forest-labs/FLUX.1-schnell',
      'stabilityai/stable-diffusion-xl-base-1.0',
    ];
    for (const hfModel of hfModels) {
      try {
        const shortName = hfModel.split('/').pop();
        console.error(`🎨 Generazione immagine con HuggingFace/${shortName}...`);
        const hfRes = await fetch(`https://router.huggingface.co/hf-inference/v2/models/${hfModel}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${hfToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            inputs: prompt.replace(/\n/g, ' ').slice(0, 800),
            parameters: { width: 1280, height: 720 },
          }),
          signal: AbortSignal.timeout(120000),
        });

        if (!hfRes.ok) {
          const errText = await hfRes.text().catch(() => '');
          throw new Error(`HTTP ${hfRes.status}: ${errText.slice(0, 200)}`);
        }

        const contentType = hfRes.headers.get('content-type') || '';
        if (!contentType.startsWith('image/')) {
          throw new Error(`Risposta non è un'immagine: ${contentType}`);
        }

        const rawBuffer = Buffer.from(await hfRes.arrayBuffer());
        const saved = await _saveAndOptimize(rawBuffer, `HuggingFace/${shortName}`, contentType);
        if (saved) return saved;
      } catch (e) {
        console.error(`  ⚠️  HuggingFace/${hfModel.split('/').pop()} fallito: ${e.message}`);
      }
    }
  }

  // ── Strategy 4: Wikimedia Commons (free, no API key, keyword search) ──
  // Searches Creative Commons licensed photos from Wikimedia. Very reliable.
  // Uses article-specific topic keywords + image URL dedup to avoid repeats.
  {
    const searchQueries = _buildWikimediaQueries(data);
    const usedUrls = _loadUsedImageUrls();

    for (const query of searchQueries) {
      try {
        console.error(`🖼️ Ricerca immagine da Wikimedia Commons ("${query}")...`);
        const wikiUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search` +
          `&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=12` +
          `&prop=imageinfo&iiprop=url|size|mime&iiurlwidth=1280&format=json`;
        const res = await fetch(wikiUrl, {
          signal: AbortSignal.timeout(15000),
          headers: { 'User-Agent': 'FrontaliereBot/1.0 (https://frontaliereticino.ch; blog image)' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const pages = json.query?.pages || {};
        // Filter to JPEG/PNG images with a thumbnail URL, exclude already-used URLs
        const candidates = Object.values(pages)
          .filter(p => {
            const info = p.imageinfo?.[0];
            if (!info?.thumburl) return false;
            const mime = (info.mime || '').toLowerCase();
            if (!mime.startsWith('image/jpeg') && !mime.startsWith('image/png')) return false;
            // Dedup: skip images already used by other articles
            if (usedUrls.has(info.thumburl) || usedUrls.has(info.url)) return false;
            return true;
          })
          .sort((a, b) => {
            // Prefer landscape orientation and reasonable sizes
            const aInfo = a.imageinfo[0];
            const bInfo = b.imageinfo[0];
            const aRatio = (aInfo.width || 1) / (aInfo.height || 1);
            const bRatio = (bInfo.width || 1) / (bInfo.height || 1);
            // Score: prefer ratio > 1.3 (landscape) and larger images
            const aScore = (aRatio > 1.3 ? 10 : 0) + Math.min(aInfo.width || 0, 2000) / 200;
            const bScore = (bRatio > 1.3 ? 10 : 0) + Math.min(bInfo.width || 0, 2000) / 200;
            return bScore - aScore;
          });

        if (candidates.length === 0) {
          console.error(`  ⚠️  Wikimedia "${query}": nessun risultato (o tutti già usati)`);
          continue;
        }

        // Pick from top 5 candidates for variety (was top 3)
        const pick = candidates[Math.floor(Math.random() * Math.min(5, candidates.length))];
        const imgUrl = pick.imageinfo[0].thumburl;
        console.error(`  📥 Download: ${imgUrl.slice(0, 80)}...`);

        const imgRes = await fetch(imgUrl, {
          signal: AbortSignal.timeout(20000),
          headers: { 'User-Agent': 'FrontaliereBot/1.0' },
        });
        if (!imgRes.ok) throw new Error(`Download HTTP ${imgRes.status}`);
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const saved = await _saveAndOptimize(buf, `Wikimedia/${query}`, imgRes.headers.get('content-type'));
        if (saved) {
          _saveUsedImageUrl(data.id, imgUrl);
          return saved;
        }
      } catch (e) {
        console.error(`  ⚠️  Wikimedia "${query}" fallito: ${e.message}`);
      }
    }
  }

  // ── Strategy 5: Pixabay API (free, 100 req/min, needs key) ──
  // Uses article-specific keyword search for relevant stock photos.
  const pixabayKey = process.env.PIXABAY_API_KEY;
  if (pixabayKey) {
    const pixabayQueries = _buildWikimediaQueries(data).slice(0, 2).map(q => q.replace(/\bcommons\b/gi, '').trim());
    if (pixabayQueries.length === 0) pixabayQueries.push('ticino switzerland');
    pixabayQueries.push('swiss landscape lake');
    const pxCategory = _inferPixabayCategory(data);
    const categoryParam = pxCategory ? `&category=${encodeURIComponent(pxCategory)}` : '';

    for (const pxQuery of pixabayQueries) {
      try {
        console.error(`🖼️ Ricerca immagine stock da Pixabay ("${pxQuery}"${pxCategory ? `, cat=${pxCategory}` : ''})...`);
        const q = encodeURIComponent(pxQuery);
        const res = await fetch(
          `https://pixabay.com/api/?key=${pixabayKey}&q=${q}${categoryParam}&image_type=photo&orientation=horizontal&per_page=20&min_width=1280&safesearch=true`,
          { signal: AbortSignal.timeout(15000) },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const hits = json.hits || [];
        if (hits.length === 0) {
          console.error(`  ⚠️  Pixabay "${pxQuery}": nessun risultato`);
          continue;
        }
        // Filter hits by tag relevance to reject off-topic images (e.g. pasta on a highway article)
        const relevant = hits.filter(h => _isImageRelevant(h.tags, data));
        if (relevant.length === 0) {
          console.error(`  ⚠️  Pixabay "${pxQuery}": tutti i risultati respinti dal filtro rilevanza (tags off-topic)`);
          continue;
        }
        const pick = relevant[Math.floor(Math.random() * Math.min(5, relevant.length))];
        const imgUrl = pick.largeImageURL || pick.webformatURL;
        if (imgUrl) {
          const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(20000) });
          if (imgRes.ok) {
            const buf = Buffer.from(await imgRes.arrayBuffer());
            const saved = await _saveAndOptimize(buf, `Pixabay/${pxQuery}`, imgRes.headers.get('content-type'));
            if (saved) return saved;
          }
        }
      } catch (e) {
        console.error(`  ⚠️  Pixabay "${pxQuery}" fallito: ${e.message}`);
      }
    }
  }

  // ── Strategy 5b: Pexels API (stock foto CC0, needs PEXELS_API_KEY secret in GH) ──
  // https://www.pexels.com/api/ — free tier 200 req/hour, landscape orientation, high quality
  const pexelsKey = process.env.PEXELS_API_KEY;
  if (pexelsKey) {
    const pexelsQueries = _buildWikimediaQueries(data).slice(0, 2).map(q => q.replace(/\bcommons\b/gi, '').trim());
    if (pexelsQueries.length === 0) pexelsQueries.push('ticino switzerland');
    pexelsQueries.push('swiss landscape lake');

    for (const pxQuery of pexelsQueries) {
      try {
        console.error(`🖼️ Ricerca immagine stock da Pexels ("${pxQuery}")...`);
        const q = encodeURIComponent(pxQuery);
        const res = await fetch(
          `https://api.pexels.com/v1/search?query=${q}&orientation=landscape&size=large&per_page=20`,
          {
            headers: { Authorization: pexelsKey },
            signal: AbortSignal.timeout(15000),
          },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const photos = json.photos || [];
        if (photos.length === 0) {
          console.error(`  ⚠️  Pexels "${pxQuery}": nessun risultato`);
          continue;
        }
        // Pexels exposes `alt` (descriptive text). Reuse the same tag filter by
        // tokenizing alt words.
        const relevant = photos.filter(p => _isImageRelevant((p.alt || '').replace(/\s+/g, ','), data));
        if (relevant.length === 0) {
          console.error(`  ⚠️  Pexels "${pxQuery}": tutti i risultati respinti dal filtro rilevanza (alt off-topic)`);
          continue;
        }
        const pick = relevant[Math.floor(Math.random() * Math.min(5, relevant.length))];
        const imgUrl = pick.src?.large2x || pick.src?.large || pick.src?.original;
        if (imgUrl) {
          const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(20000) });
          if (imgRes.ok) {
            const buf = Buffer.from(await imgRes.arrayBuffer());
            const saved = await _saveAndOptimize(buf, `Pexels/${pxQuery}`, imgRes.headers.get('content-type'));
            if (saved) return saved;
          }
        }
      } catch (e) {
        console.error(`  ⚠️  Pexels "${pxQuery}" fallito: ${e.message}`);
      }
    }
  }

  // ── Strategy 6: Lorem Picsum (always works, random professional photo) ──
  // https://picsum.photos — Reliable service serving random stock photos.
  // Not topic-relevant, but always returns a valid image — last resort before fallback.
  try {
    console.error('🖼️ Immagine stock da Lorem Picsum (random)...');
    // Use article ID hash as seed for deterministic-per-article randomness
    const seed = (data.id || 'default').split('').reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
    const absSeed = Math.abs(seed) % 10000;
    const res = await fetch(`https://picsum.photos/seed/${absSeed}/1280/720`, {
      signal: AbortSignal.timeout(20000),
      redirect: 'follow',
    });
    if (res.ok) {
      const contentType = res.headers.get('content-type') || '';
      if (contentType.startsWith('image/')) {
        const buf = Buffer.from(await res.arrayBuffer());
        const saved = await _saveAndOptimize(buf, 'Picsum', contentType);
        if (saved) return saved;
      }
    }
  } catch (e) {
    console.error(`  ⚠️  Lorem Picsum fallito: ${e.message}`);
  }

  console.error('  ❌ Tutti i provider di image generation hanno fallito.');
  console.error('     Uso immagine di fallback dal catalogo Ticino.');
  return null; // fallback to AVAILABLE_IMAGES in modifyBlogArticlesTsx
}

// ── Step 4: Modify source files ─────────────────────────────

/**
 * Sanitize AI-generated body text before it's serialized into TypeScript.
 *
 * The LLM occasionally produces stray `}` characters — typically at the end of
 * a sentence where a German low quote („ ") was mis-closed with `}`. Blog
 * body content is plain markdown and should never contain unbalanced braces;
 * when they slip through they (a) break string-unaware parsers like the old
 * i18n-completeness test and (b) look broken in the rendered article.
 *
 * This is defense in depth: the test parser is now string-aware, but we still
 * refuse to write corrupted output to source files. Strategy:
 *   - Walk the text, tracking `{` depth
 *   - Drop any `}` that appears while depth is already 0
 *   - Leave balanced `{...}` pairs intact (in case of anchors, placeholders)
 */
function sanitizeBodyText(s) {
  if (typeof s !== 'string' || s.length === 0) return s;
  const out = [];
  let depth = 0;
  let droppedCount = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') {
      depth++;
      out.push(ch);
    } else if (ch === '}') {
      if (depth === 0) {
        droppedCount++;
        continue; // stray — skip
      }
      depth--;
      out.push(ch);
    } else {
      out.push(ch);
    }
  }
  // If braces are still unbalanced (more `{` than `}`), strip the trailing
  // unmatched opens as well — they'd otherwise leave an open brace in the
  // serialized TS string that could hide downstream issues.
  if (depth > 0) {
    let i = out.length - 1;
    let toStrip = depth;
    while (i >= 0 && toStrip > 0) {
      if (out[i] === '{') {
        out[i] = '';
        toStrip--;
      }
      i--;
    }
    droppedCount += depth;
  }
  if (droppedCount > 0) {
    console.error(`    ⚠️  sanitizeBodyText: removed ${droppedCount} stray brace char(s)`);
  }
  return out.join('');
}

// escapeForSingleQuoteTS ora vive in scripts/lib/article-meta-block.mjs, accanto
// all'emettitore che lo usa per primo: un campo nuovo emesso senza il suo escape
// produce un .ts che non compila, e il test che pinna il campo deve poter
// verificare anche quello.

/**
 * Validate that a generated .ts body file is syntactically valid.
 * Catches truncated FAQ strings and other escaping errors before they break the build.
 */
function validateBodyFileSyntax(filePath, content) {
  // Quick structural check: every opened single-quote string must close properly
  // Count unbalanced quotes (rough heuristic)
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Detect the specific truncation pattern: '}]', followed by raw text
    if (/\}]',\s*[a-zA-Z]/.test(line)) {
      throw new Error(`Body file ${filePath} line ${i + 1}: FAQ string appears truncated — raw text found after closing ']'. The AI likely produced malformed FAQ JSON.`);
    }
  }
  // Try to evaluate the TS as JS to catch syntax errors
  try {
    // Strip the export and type annotation to make it evaluable as JS
    const jsContent = content
      .replace(/:\s*Record<string,\s*string>\s*=/, ' =')
      .replace(/^export default .*/m, '');
    new Function(jsContent);
  } catch (e) {
    throw new Error(`Body file ${filePath} has syntax error: ${e.message}`);
  }
}

function escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Safe stand-in for `src.replace(anchorRe, template)` when `template` embeds
 * AI-generated article content (title/excerpt/body/breadcrumb text). Passing
 * a template STRING to replace() re-parses it for `$1`/`$2`/`$&` patterns —
 * if the interpolated content itself contains a literal "$" followed by a
 * digit (e.g. a dollar-amount excerpt like "revenue of $14.4 billion"), V8
 * expands that "$1" as a capture-group backreference too, splicing the
 * anchor's own matched text into the middle of the inserted content.
 * Root cause of the blog-meta-ch-en.ts corruption that broke every deploy
 * build on 2026-07-21 (docs/AGENTS-HISTORY.md#blog-meta-replace-backref).
 * Passing a replacer FUNCTION instead makes the return value literal — no
 * `$`-pattern re-interpretation — mirroring the fix already applied in
 * scripts/backfill-ai-search-optimization.mjs.
 */
function replaceCaptureSafe(src, anchorRe, buildReplacement) {
  return src.replace(anchorRe, (...args) => buildReplacement(...args.slice(0, -2)));
}

/** Find the last article ID from the active section's slug-data file. */
function getLastArticleId(src) {
  const ids = getSectionExistingIds(src);
  const lastId = ids[ids.length - 1];
  if (!lastId) {
    throw new Error(`No existing articles found in ${SECTION.slugDataFile}`);
  }
  return lastId;
}

function modifyRouterTs(data) {
  // The svizzera section does NOT maintain the BlogArticleId union in
  // router.ts (ids are loose strings, validated at runtime via REVERSE_SWISS).
  // Only the frontaliere section touches router.ts.
  if (SECTION.updateRouterUnion) {
    modifyRouterUnion(data);
  }

  // Append the slug entry to the section's SLUGS map. The first entry into an
  // empty `{ }` map is handled by anchoring to the map declaration itself.
  const blogDataFile = SECTION.slugDataFile;
  let blogSrc = read(blogDataFile);
  const existingIds = getSectionExistingIds(blogSrc);

  // Indentation: frontaliere historically appended new SLUGS entries with TWO
  // leading spaces (kept byte-identical); svizzera uses ONE to match its file.
  const slugIndent = SECTION.updateRouterUnion ? '  ' : ' ';
  const newSlugEntry = `${slugIndent}'${data.id}': { it: '${data.slugs.it}', en: '${data.slugs.en}', de: '${data.slugs.de}', fr: '${data.slugs.fr}' },`;

  if (existingIds.length === 0) {
    // Empty map — insert the first entry right after the map's opening brace.
    // Anchor: `const SWISS_SLUGS: ... = {\n}` (or `{\n  ...`).
    const openRe = new RegExp(
      `(export const ${SECTION.slugsConstName}\\s*:[^=]*=\\s*\\{)(\\s*\\n)`,
    );
    if (!openRe.test(blogSrc)) {
      throw new Error(`modifyRouterTs: cannot find empty ${SECTION.slugsConstName} map opener in ${blogDataFile}`);
    }
    blogSrc = replaceCaptureSafe(blogSrc, openRe, (_m, g1, g2) => `${g1}\n${newSlugEntry}${g2}`);
  } else {
    // Non-empty — append after the last article entry (matches frontaliere).
    const lastId = existingIds[existingIds.length - 1];
    const lastEntryRe = new RegExp(`('${escapeRegex(lastId)}':\\s*\\{[^}]+\\},)`);
    if (!lastEntryRe.test(blogSrc)) {
      throw new Error(`modifyRouterTs: cannot find last ${SECTION.slugsConstName} entry (anchor=${lastId}) in ${blogDataFile}`);
    }
    blogSrc = replaceCaptureSafe(blogSrc, lastEntryRe, (_m, g1) => `${g1}\n${newSlugEntry}`);
  }

  // Regenerate the literal ALL_*_ARTICLE_IDS array ONLY when the file declares
  // it as a literal (`= [...]`). The svizzera section derives it via
  // `Object.keys(SWISS_SLUGS)`, so no array edit is needed there.
  const literalArrayRe = new RegExp(
    `export const ${SECTION.allIdsConstName}:[^=]*=\\s*\\[[^\\]]*\\];`,
  );
  if (literalArrayRe.test(blogSrc)) {
    const allIds = getSectionExistingIds(blogSrc).map((id) => `'${id}'`);
    if (allIds.length === 0) {
      throw new Error(`modifyRouterTs: regenerated 0 IDs for ${SECTION.allIdsConstName} (regex anchor changed?)`);
    }
    const allIdsType = SECTION.updateRouterUnion ? 'BlogArticleId[]' : 'string[]';
    blogSrc = blogSrc.replace(
      literalArrayRe,
      `export const ${SECTION.allIdsConstName}: ${allIdsType} = [${allIds.join(', ')}];`,
    );
  }

  write(blogDataFile, blogSrc);
  console.error(`  ✅ ${blogDataFile}`);
}

/** frontaliere-only: append the new id to the BlogArticleId union in router.ts. */
function modifyRouterUnion(data) {
  // The union lives in the corpus package now, not in the router (#4974 item
  // 3): it is appended on every publish, so it is corpus data, and writing it
  // here meant every run of the generator also wrote into the site. The router
  // re-exports it, so nothing downstream changed.
  const routerFile = 'packages/articles/content/blogArticleIds.ts';
  let routerSrc = read(routerFile);

  // Append to the LAST _BlogIdN alias before its terminating semicolon. We
  // anchor to the actual last ID inside that alias because the two lists can
  // drift: TS2590 splits may reorder, hand-edits may append to either list.
  const lastAliasMatch = routerSrc.match(/type (_BlogId\d+)\s*=\s*([^;]+);/g);
  if (!lastAliasMatch || lastAliasMatch.length === 0) {
    throw new Error(`modifyRouterUnion: could not find any _BlogIdN alias in ${routerFile}`);
  }
  const lastAlias = lastAliasMatch[lastAliasMatch.length - 1];
  const aliasIds = lastAlias.match(/'([^']+)'/g)?.map(s => s.slice(1, -1)) || [];
  const routerLastId = aliasIds[aliasIds.length - 1];
  if (!routerLastId) {
    throw new Error(`modifyRouterUnion: last _BlogIdN alias has no IDs. Found: ${lastAlias.slice(0, 120)}…`);
  }
  const before = routerSrc;
  routerSrc = routerSrc.replace(
    new RegExp(`(\\| '${escapeRegex(routerLastId)}')(;)`),
    `$1 | '${data.id}'$2`,
  );
  if (routerSrc === before) {
    throw new Error(`modifyRouterUnion: BlogArticleId union append failed (anchor=${routerLastId}, newId=${data.id})`);
  }
  write(routerFile, routerSrc);
  console.error(`  ✅ ${routerFile}`);
}

function modifyBlogArticlesTsx(data) {
  // FRO-360: ARTICLES array extracted to data/blog-articles-data.ts (FRO-328).
  // Section-keyed: frontaliere → ARTICLES, svizzera → SWISS_ARTICLES.
  const file = SECTION.registryFile;
  let src = read(file);
  const today = new Date().toISOString();

  // Use generated image if available, otherwise fallback to catalog image
  const imagePath = data._generatedImagePath || `/images/places/${data.image}`;

  // Detect indentation from the file (match the indent before 'id:' in existing entries)
  const indentMatch = src.match(/^(\s+)id: '/m);
  const propIndent = indentMatch ? indentMatch[1] : ' ';
  // Object-level indent is one level less (or same if single-space)
  const objIndent = propIndent.length > 1 ? propIndent.slice(0, -1) : propIndent;

  const entryLines = [
    `${objIndent}{`,
    `${propIndent}id: '${data.id}',`,
    `${propIndent}category: '${data.category}',`,
    `${propIndent}date: '${today}',`,
    `${propIndent}image: '${imagePath}',`,
    `${propIndent}hasCalculator: ${data.hasCalculator ? 'true' : 'false'},`,
  ];
  // A2: persist byline so BlogArticles.tsx can render an author link.
  if (data.author?.slug) {
    entryLines.push(`${propIndent}authorSlug: '${escapeForSingleQuoteTS(data.author.slug)}',`);
  }
  if (data.author?.name) {
    entryLines.push(`${propIndent}authorName: '${escapeForSingleQuoteTS(data.author.name)}',`);
  }
  entryLines.push(`${objIndent}},`);
  const newEntry = entryLines.join('\n');

  // Insert before the array terminator. Anchors to the closing `},` that
  // immediately precedes `] satisfies Article[];` or `];` — robust to any
  // set of trailing properties (authorSlug, authorName, etc.) on the last entry.
  const before = src;
  src = src.replace(
    /([ \t]*},\n)(\](?:[ \t]+satisfies[ \t]+Article\[\])?;)/,
    `$1${newEntry}\n$2`
  );
  if (src === before) {
    // Empty array (first article in the section) — no preceding `},`. Insert
    // between the opening `[` and the closing `]`. Matches `= [\n]` and `= []`.
    src = src.replace(
      new RegExp(`(export const ${SECTION.registryArrayName}\\s*:[^=]*=\\s*\\[)(\\s*)(\\])`),
      `$1\n${newEntry}\n$3`,
    );
  }
  if (src === before) {
    throw new Error(`modifyBlogArticlesTsx: regex did not match — cannot insert article entry in ${file}`);
  }

  write(file, src);
  console.error(`  ✅ ${file}`);
}

// buildMetaBlock ora vive in scripts/lib/article-meta-block.mjs. Emette
// title/excerpt/imageAlt nelle stesse posizioni di prima — per un articolo senza
// i campi SEO per-locale l'output e' byte-identico — e in coda, quando il
// content builder li ha scritti, seoDescription e ogDescription.

// body1/2/3 are always emitted if the key exists on `c` (even '' — matches
// the historic fixed-3 schema); body4+ is opt-in per article (only emitted
// when the content builder actually sets that key) so older 3-body articles
// (e.g. events-digest) are untouched. Cap matches collectBodyParts' body1..
// body20 scan in components/community/BlogArticles.tsx.
const MAX_BODY_KEYS = 20;

/** Build a standalone per-article body file (body1..bodyN, N ≤ MAX_BODY_KEYS) */
function buildBodyFile(data, locale) {
  const c = data.content[locale];
  const id = data.id;
  const camel = id.replace(/-(\w)/g, (_, ch) => ch.toUpperCase());
  const varName = 'body' + camel.charAt(0).toUpperCase() + camel.slice(1);

  // Build FAQ line if present — validate JSON roundtrip to catch malformed AI output
  let faqLine = '';
  if (c.faq && Array.isArray(c.faq) && c.faq.length > 0) {
    try {
      const faqJson = JSON.stringify(c.faq);
      // Roundtrip: verify the escaped string produces valid JSON when parsed back
      const escaped = escapeForSingleQuoteTS(faqJson);
      const unescaped = escaped.replace(/\\'/g, "'").replace(/\\\\/g, '\\').replace(/\\n/g, '\n');
      JSON.parse(unescaped);
      faqLine = `\n    'blog.article.${id}.faq': '${escaped}',`;
    } catch (e) {
      console.error(`  ⚠️ FAQ for ${locale}/${id} dropped — malformed JSON: ${e.message}`);
    }
  }

  const bodyLines = [];
  for (let i = 1; i <= MAX_BODY_KEYS; i += 1) {
    const key = `body${i}`;
    if (!(key in c) || typeof c[key] !== 'string') continue;
    bodyLines.push(`    'blog.article.${id}.${key}': '${escapeForSingleQuoteTS(c[key])}',`);
  }

  return `const ${varName}: Record<string, string> = {
${bodyLines.join('\n')}${faqLine}
};

export default ${varName};
`;
}

/**
 * Append the meta block + write the body file for one locale. Section-keyed:
 * frontaliere → blog-meta-{loc}.ts + blog-body/{loc}, svizzera →
 * blog-meta-ch-{loc}.ts + blog-body-ch/{loc}. The i18n KEY namespace stays
 * `blog.article.{id}.*` for BOTH sections. Handles the empty-meta (first
 * article) case by anchoring to the object opener when no key exists yet.
 */
function decodeLocaleContentEntities(data, locale) {
  const c = data.content?.[locale];
  if (c) {
    const bodyFields = Array.from({ length: MAX_BODY_KEYS }, (_, i) => `body${i + 1}`);
    // META_SEO_FIELDS insieme a title/excerpt: da quando il blocco meta li
    // emette, `seoDescription` e `ogDescription` finiscono in un file .ts e poi
    // in `meta-<locale>.json` esattamente come l'excerpt. Un `&egrave;` non
    // decodificato qui arriverebbe letterale in una SERP.
    for (const field of ['title', 'excerpt', ...META_SEO_FIELDS, ...bodyFields]) {
      if (typeof c[field] === 'string') c[field] = decodeHtmlEntities(c[field]);
    }
    if (Array.isArray(c.faq)) {
      c.faq = c.faq.map((item) => (item && typeof item === 'object'
        ? {
            ...item,
            q: typeof item.q === 'string' ? decodeHtmlEntities(item.q) : item.q,
            a: typeof item.a === 'string' ? decodeHtmlEntities(item.a) : item.a,
          }
        : item));
    }
  }
  const alt = data.imageAlt?.[locale];
  if (typeof alt === 'string') data.imageAlt[locale] = decodeHtmlEntities(alt);
}

function writeSectionLocale(data, locale) {
  decodeLocaleContentEntities(data, locale);

  // 1. Append meta keys to the section's meta file for this locale.
  const metaFile = `services/locales/${SECTION.metaPrefix}-${locale}.ts`;
  let metaSrc = read(metaFile);
  const metaBlock = buildMetaBlock(data, locale);
  const appendRe = /('blog\.article\.[a-z0-9-]+\.[a-zA-Z]+':.*?,)\n+(\};)/;
  if (appendRe.test(metaSrc)) {
    metaSrc = replaceCaptureSafe(metaSrc, appendRe, (_m, g1, g2) => `${g1}\n${metaBlock}\n${g2}`);
  } else {
    // Empty meta object (first article) — insert after the `= {` opener.
    const openRe = /(:\s*Record<string,\s*string>\s*=\s*\{)(\s*\n)/;
    if (!openRe.test(metaSrc)) {
      throw new Error(`Cannot find blog article anchor (or empty-object opener) in ${metaFile}`);
    }
    metaSrc = replaceCaptureSafe(metaSrc, openRe, (_m, g1, g2) => `${g1}\n${metaBlock}${g2}`);
  }
  write(metaFile, metaSrc);
  console.error(`  ✅ ${metaFile}`);

  // 2. Create per-article body file under the section's body dir.
  const bodyDir = `services/locales/${SECTION.bodyDir}/${locale}`;
  mkdirSync(resolve(bodyDir), { recursive: true });
  const bodyFile = `${bodyDir}/${data.id}.ts`;
  const bodyContent = buildBodyFile(data, locale);
  validateBodyFileSyntax(bodyFile, bodyContent);
  write(bodyFile, bodyContent);
  console.error(`  ✅ ${bodyFile}`);
}

function modifyI18nTs(data) {
  writeSectionLocale(data, 'it');
}

function modifyLocaleFile(data, locale) {
  writeSectionLocale(data, locale);
}

function toIsoWithTz(date = new Date()) {
  // Esempio output: 2026-02-26T09:51:00+01:00 (con offset locale)
  const pad = (n) => String(n).padStart(2, '0')
  const y = date.getFullYear()
  const m = pad(date.getMonth() + 1)
  const d = pad(date.getDate())
  const hh = pad(date.getHours())
  const mm = pad(date.getMinutes())
  const ss = pad(date.getSeconds())

  const offMin = -date.getTimezoneOffset() // minuti rispetto a UTC
  const sign = offMin >= 0 ? '+' : '-'
  const abs = Math.abs(offMin)
  const offH = pad(Math.floor(abs / 60))
  const offM = pad(abs % 60)

  return `${y}-${m}-${d}T${hh}:${mm}:${ss}${sign}${offH}:${offM}`
}


const SEO_ENTITY_FIELDS = ['title', 'description', 'keywords', 'ogTitle', 'ogDescription', 'headline', 'breadcrumbName'];

function decodeSeoEntities(data) {
  if (!data.seo || typeof data.seo !== 'object') return;
  for (const field of SEO_ENTITY_FIELDS) {
    if (typeof data.seo[field] === 'string') data.seo[field] = decodeHtmlEntities(data.seo[field]);
  }
}

function modifySeoService(data) {
  decodeSeoEntities(data);
  const publishedAt = toIsoWithTz(new Date())
  const modifiedAt = publishedAt

  // Use generated image or fallback
  const imagePath = data._generatedImagePath
    ? data._generatedImagePath.replace(/^\//, '')
    : `images/places/${data.image}`;

  // 1. SEO entry → section seo file. frontaliere → seo-blog-5.ts (latest split
  // chunk, keeps seo-blog.ts below the 500 kB Rollup warning); svizzera →
  // seo-blog-ch.ts (BLOG_CH_SEO_METADATA). canonicalPath/mainEntityOfPage use
  // the active section's localized IT hub slug.
  const blogSeoFile = SECTION.seoFile;
  let blogSrc = read(blogSeoFile);
  const itHub = SECTION.hubSlug.it;
  // frontaliere canonicalPath has historically had NO trailing slash; keep it
  // byte-identical. svizzera uses a trailing slash (per seo-blog-ch.ts contract).
  const itHubPath = IS_FRONTALIERE ? `/${itHub}/${data.slugs.it}` : `/${itHub}/${data.slugs.it}/`;

  const seoEntry = `
  'blog-${data.id}': {
    title: '${escapeForSingleQuoteTS(data.seo.title)}',
    description: '${escapeForSingleQuoteTS(data.seo.description)}',
    keywords: '${escapeForSingleQuoteTS(data.seo.keywords)}',
    ogTitle: '${escapeForSingleQuoteTS(data.seo.ogTitle)}',
    ogDescription: '${escapeForSingleQuoteTS(data.seo.ogDescription)}',
    canonicalPath: '${itHubPath}',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "${String(data.seo.headline || '').replace(/"/g, '\\"')}",
      "description": "${String(data.seo.description || '').replace(/"/g, '\\"')}",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://frontaliereticino.ch/termini-di-servizio/#licenza-immagini",
        "copyrightNotice": "© 2024–2026 Frontaliere Ticino. Tutti i diritti riservati.",
        "license": "https://frontaliereticino.ch/termini-di-servizio/#licenza-immagini",
        "creator": { "@type": "Organization", "name": "Frontaliere Ticino", "url": "https://frontaliereticino.ch/" },
        "creditText": "Frontaliere Ticino",
        "url": \`\${BASE_URL}/${imagePath}\`,
        "width": ${data._generatedImagePath ? 1200 : 1200},
        "height": ${data._generatedImagePath ? 675 : 563},
        "caption": "${String(data.imageAlt?.it || data.seo.headline || '').replace(/"/g, '\\"')}"
      },
      "datePublished": "${publishedAt}",
      "dateModified": "${modifiedAt}",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "${BASE_URL}/autori/${data.author?.slug || 'redazione'}/#person",
        "name": "${String(data.author?.name || 'Redazione Frontaliere Ticino').replace(/"/g, '\\"')}",
        "url": "${BASE_URL}/autori/${data.author?.slug || 'redazione'}/"
      },
      "publisher": {"@id": "${BASE_URL}/#organization"},
      "mainEntityOfPage": \`\${BASE_URL}${itHubPath.endsWith('/') ? itHubPath : `${itHubPath}/`}\`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },`;

  // Insert before the closing }; ... export default <CONST>;
  // The const-name regex matches any frontaliere split variant
  // (BLOG_SEO_METADATA, _2, … _5) or the svizzera BLOG_CH_SEO_METADATA.
  const seoConst = SECTION.seoConstName;
  const seoConstReSrc = SECTION.updateRouterUnion
    ? `${seoConst}(?:_\\d+)?`   // frontaliere split chunks
    : escapeRegex(seoConst);    // svizzera single file
  const blogEndRe = new RegExp(`(\\s*\\},)\\s*(\\n};)\\s*(\\nexport default ${seoConstReSrc};)`);
  if (blogEndRe.test(blogSrc)) {
    blogSrc = replaceCaptureSafe(blogSrc, blogEndRe, (_m, g1, g2, g3) => `${g1}\n${seoEntry}\n${g2}\n${g3}`);
  } else {
    // Empty metadata object (first article) — anchor to the `= {` opener.
    const emptyOpenRe = new RegExp(`(const ${escapeRegex(seoConst)}[^=]*=\\s*\\{)(\\s*\\n)(\\};)`);
    if (!emptyOpenRe.test(blogSrc)) {
      throw new Error(`Cannot find end (or empty-object opener) of ${seoConst} in ${blogSeoFile}`);
    }
    blogSrc = replaceCaptureSafe(blogSrc, emptyOpenRe, (_m, g1, g2, g3) => `${g1}\n${seoEntry}\n${g3}`);
  }
  write(blogSeoFile, blogSrc);
  console.error(`  ✅ ${blogSeoFile}`);

  // 2. Breadcrumb entry → REMOVED (issue #4974 item 3).
  //
  // This used to append `'blog-{id}': { name, path, parent: 'blog' }` to
  // `sectionNames` in services/seoService.ts. Those entries were never read:
  // `buildBreadcrumbs` returns early for `route.activeTab === 'blog'`, building
  // the crumb from the localized title and `buildPath(route)`, and
  // `sectionNames` is declared after that return. `getSectionKey` only ever
  // builds a `blog-<id>` key inside `case 'blog':`, for both sections, so the
  // early return always wins.
  //
  // 3593 of them had accumulated — 530 KB of the 1153 KB seoService chunk
  // served to clients, untree-shakable because `sectionNames` is a local const
  // in a live function. Removed wholesale; tests/seo-blog-breadcrumb-entries-dead.ts
  // keeps them from growing back.
  //
  // It also unblocks this script: appending here was one of only two reasons it
  // had to write outside the corpus, which is what kept the generator pinned to
  // this repository.

  // 3. services/seo/seo-pages.ts — nothing to do here any more.
  //
  // This used to append the new article to the blog ItemList. Two things made
  // it redundant. The list is capped at 100 entries (#4983), so once it filled
  // the append stopped adding anything and only bumped numberOfItems; and that
  // counter is now derived from the corpus at emit time (#4997), which also
  // fixed it having drifted to 3640 against 3047 real articles.
  //
  // Dropping it matters beyond the dead code: this was one of only two reasons
  // the generator had to write outside the corpus at all, and it is what kept
  // it pinned to this repository (#4974 item 3). The other, services/router.ts,
  // went in #4992.
  //
  // scripts/lib/seo-pages-article-list.mjs stays: upsertArticleListItem is the
  // comma-safe path any future rename tooling must use rather than splicing the
  // array by hand — that mistake once produced `} {`, an esbuild parse failure,
  // and a red main inherited by every branch (issue #2834, PR #2833).
}

/**
 * Post-write validation: re-reads seo-blog-5.ts, extracts the new article's
 * SEO entry using the SAME regex ogPagesPlugin uses at build time, then builds and
 * parses the JSON-LD object. This catches escaping issues before they reach production.
 */
function validateStructuredData(data) {
  const seoFile = SECTION.seoFile;
  const src = read(seoFile);
  const entryKey = `'blog-${data.id}'`;

  // 1. Verify the entry exists
  if (!src.includes(entryKey)) {
    throw new Error(`[validate-ld] SEO entry ${entryKey} not found in ${seoFile}`);
  }

  // 2. Extract using the same regex ogPagesPlugin uses
  const keyRx = new RegExp(`'blog-${data.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}':\\s*\\{`);
  const km = src.match(keyRx);
  if (!km) throw new Error(`[validate-ld] Could not match entry ${entryKey}`);
  const start = km.index;
  const block = src.substring(start, Math.min(start + 3000, src.length));

  // Match single-quoted strings (same logic as ogPagesPlugin matchStr)
  const matchStr = (key) => {
    const rx = new RegExp(`${key}:\\s*'((?:[^'\\\\]|\\\\.)*)'`, 'm');
    return block.match(rx)?.[1]?.replace(/\\(.)/g, (_, c) => c === 'n' ? ' ' : c === 'r' ? '' : c === 't' ? ' ' : c) ?? '';
  };
  const title = matchStr('title');
  const desc = matchStr('description');
  const ogT = matchStr('ogTitle') || title;
  const ogD = matchStr('ogDescription') || desc;
  const cp = block.match(/canonicalPath:\s*'([^']+)'/)?.[1] ?? '';
  const datePub = block.match(/"datePublished":\s*"([^"]+)"/)?.[1] ?? '';
  const dateMod = block.match(/"dateModified":\s*"([^"]+)"/)?.[1] ?? '';

  // 3. Verify we got meaningful values
  if (!title) throw new Error(`[validate-ld] Empty title for ${entryKey}`);
  if (!desc) throw new Error(`[validate-ld] Empty description for ${entryKey}`);
  if (!ogT) throw new Error(`[validate-ld] Empty ogTitle for ${entryKey}`);
  if (!ogD) throw new Error(`[validate-ld] Empty ogDescription for ${entryKey}`);
  if (!cp) throw new Error(`[validate-ld] Empty canonicalPath for ${entryKey}`);

  // 4. Build the same JSON-LD object ogPagesPlugin builds and verify JSON.stringify works
  const BASE = 'https://frontaliereticino.ch';
  const ldObj = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: ogT,
    description: ogD,
    image: `${BASE}${data._generatedImagePath || `/images/places/${data.image}`}`,
    url: `${BASE}${cp}`,
    publisher: {
      '@type': 'Organization', name: 'Frontaliere Ticino', url: BASE,
      logo: {
        '@type': 'ImageObject',
        acquireLicensePage: 'https://frontaliereticino.ch/termini-di-servizio/#licenza-immagini',
        copyrightNotice: '© 2024–2026 Frontaliere Ticino. Tutti i diritti riservati.',
        license: 'https://frontaliereticino.ch/termini-di-servizio/#licenza-immagini',
        creator: { '@type': 'Organization', name: 'Frontaliere Ticino', url: BASE },
        creditText: 'Frontaliere Ticino',
        url: `${BASE}/icons/icon-512x512.png`,
      },
    },
    author: { '@type': 'Organization', name: 'Frontaliere Ticino', url: BASE },
    mainEntityOfPage: `${BASE}${cp}`,
  };
  if (datePub) ldObj.datePublished = datePub;
  if (dateMod) ldObj.dateModified = dateMod;

  // 4b. Verify date format: must be ISO 8601 with timezone (e.g. 2026-02-26T09:51:00+01:00)
  const ISO_WITH_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
  if (datePub && !ISO_WITH_TZ.test(datePub)) {
    throw new Error(`[validate-ld] datePublished "${datePub}" non è in formato ISO 8601 con fuso orario (atteso: YYYY-MM-DDTHH:MM:SS+HH:MM)`);
  }
  if (dateMod && !ISO_WITH_TZ.test(dateMod)) {
    throw new Error(`[validate-ld] dateModified "${dateMod}" non è in formato ISO 8601 con fuso orario (atteso: YYYY-MM-DDTHH:MM:SS+HH:MM)`);
  }

  const jsonStr = JSON.stringify(ldObj);

  // 5. Verify the JSON is parseable (roundtrip)
  try {
    const parsed = JSON.parse(jsonStr);
    if (!parsed.headline || !parsed.description) {
      throw new Error('Missing headline or description after roundtrip');
    }
  } catch (e) {
    throw new Error(`[validate-ld] JSON-LD roundtrip failed for ${entryKey}: ${e.message}\n  JSON: ${jsonStr.substring(0, 300)}`);
  }

  console.error(`  ✅ Dati strutturati validi (headline: "${ogT.substring(0, 50)}...")`);
}

/**
 * Update the lastmod date for a specific child sitemap in public/sitemap.xml.
 * Call this after modifying any child sitemap so the sitemap index stays fresh.
 */
function updateSitemapIndexLastmod(childSitemapUrl) {
  // No-op here for the same reason as modifySitemap/modifySitemapNews: public/
  // sitemap.xml is the SITE's index and does not exist in this repository.
  //
  // The bump still happens, on the side that owns the file: pull-articles-api.mjs
  // rewrites the child sitemap and bumps its <lastmod> in sitemap.xml in the same
  // run — "whoever rewrites a child sitemap bumps the index for it" (§3, §7.2).
  void childSitemapUrl;
}

/**
 * Strip JSON blobs and HTML tags from text intended for XML sitemap fields.
 * Prevents structured data leaking into <image:title> or similar plain-text fields.
 */
function sanitizePlainText(text) {
  let s = String(text || '');
  if (/^\s*[\[{]/.test(s)) s = '';
  s = s.replace(/<[^>]+>/g, '');
  return s.trim();
}

/**
 * Section-aware canonical article URL (IT) + hreflang alternate <xhtml:link>
 * block, built from SECTION.hubSlug. frontaliere produces byte-identical
 * markup to the previous hardcoded literals.
 */
function buildSectionSitemapUrls(data) {
  const hub = SECTION.hubSlug;
  const itLoc = `${BASE_URL}/${hub.it}/${data.slugs.it}/`;
  const alternates = [
    `    <xhtml:link rel="alternate" hreflang="it" href="${BASE_URL}/${hub.it}/${data.slugs.it}/" />`,
    `    <xhtml:link rel="alternate" hreflang="en" href="${BASE_URL}/en/${hub.en}/${data.slugs.en}/" />`,
    `    <xhtml:link rel="alternate" hreflang="de" href="${BASE_URL}/de/${hub.de}/${data.slugs.de}/" />`,
    `    <xhtml:link rel="alternate" hreflang="fr" href="${BASE_URL}/fr/${hub.fr}/${data.slugs.fr}/" />`,
    `    <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}/${hub.it}/${data.slugs.it}/" />`,
  ].join('\n');
  return { itLoc, alternates };
}

function modifySitemap(data) {
  // No-op since the article corpus moved to its own repository.
  //
  // sitemap-blog.xml / sitemap-blog-ch.xml are now produced by
  // nanakokyobashi-rgb/frontaliere-articles, which regenerates them from the
  // corpus it owns, and pulled into public/ by scripts/pull-articles-api.mjs.
  // Appending here as well would give the file two producers, and the last
  // writer would win — the pull would either clobber this entry or be refused
  // by its own shrink guard.
  //
  // Freshness is not lost: the publisher dispatches `articles-published` to this
  // repo as soon as it has republished, so sync-articles-sitemaps runs on the
  // push rather than waiting for its twice-daily schedule.
  //
  // sitemap-news.xml is NOT affected — it is a Google News surface with its own
  // whitelist gate, still owned here, and modifySitemapNews below still writes it.
  void data;
}

function modifySitemapNews(data) {
  // No-op since generation moved to this repository (issue #4974 item 3, §7.2).
  //
  // Two reasons, and either one alone would be enough.
  //
  // 1. The file it used to append to — public/sitemap-news.xml — does not exist
  //    here. That is not an oversight: this repo has no `public/`, because it
  //    publishes a data surface, not a site. Left as-is, read() throws ENOENT and
  //    every producer that registers an article dies before writing anything.
  //
  // 2. Even with the file present, appending would be wrong. scripts/build-api.mjs
  //    DERIVES sitemap-news-candidates.xml from the corpus on every publish, using
  //    the same vendored whitelist this function used to consult. An incremental
  //    append would be a second producer of the same fact, and the derived document
  //    — rebuilt from scratch each time — would silently win on the next publish.
  //
  // The eligibility decision is NOT lost, it moved: build-api.mjs applies
  // isArticleNewsEligible() to the whole corpus inside the 48h window, so an
  // article registered here appears as a candidate on the next publish without
  // this function doing anything. Same reasoning as modifySitemap() above.
  void data;
}

// ── Step 5: Git add ─────────────────────────────────────────
function gitAddAll(data) {
  // Section-keyed file set. frontaliere → original literals (byte-identical);
  // svizzera → swiss-articles-data, routerSwissData, blog-meta-ch-*,
  // blog-body-ch/*, seo-blog-ch, sitemap-blog-ch. seoService.ts (shared
  // breadcrumb) + sitemap-news.xml + sitemap.xml are staged for both. router.ts
  // is staged only when the section maintains the BlogArticleId union.
  const files = [
    ...(SECTION.updateRouterUnion ? ['packages/articles/content/blogArticleIds.ts'] : []),
    SECTION.slugDataFile,
    SECTION.registryFile,
    `services/locales/${SECTION.metaPrefix}-it.ts`,
    `services/locales/${SECTION.metaPrefix}-en.ts`,
    `services/locales/${SECTION.metaPrefix}-de.ts`,
    `services/locales/${SECTION.metaPrefix}-fr.ts`,
    `services/locales/${SECTION.bodyDir}/it/${data.id}.ts`,
    `services/locales/${SECTION.bodyDir}/en/${data.id}.ts`,
    `services/locales/${SECTION.bodyDir}/de/${data.id}.ts`,
    `services/locales/${SECTION.bodyDir}/fr/${data.id}.ts`,
    SECTION.seoFile,
    // services/seoService.ts is NOT staged any more (issue #4974 item 3): this
    // script no longer writes it — the per-article breadcrumb entries it used
    // to append were unreachable. See modifySeoService above.
    // public/sitemap-news.xml and public/sitemap.xml are NOT staged here any
    // more, and their absence from this list is load-bearing rather than tidy.
    //
    // Both were written by modifySitemapNews()/updateSitemapIndexLastmod(),
    // which are no-ops in this repository — there is no public/ here, and the
    // news candidates are DERIVED from the corpus by scripts/build-api.mjs on
    // every publish. Staging a path that no longer exists is not harmless:
    // `git add` fails on an unmatched pathspec, and because this is the LAST
    // step of registration it killed a run that had already generated the whole
    // article. Observed on the first scheduled run after cutover
    // (2026-08-02, la-vigilanza-sulle-banche-in-svizzera): translations done,
    // image written, then the whole thing lost at `git add`.
  ];
  if (existsSync(resolve(SOURCE_QUOTA_FILE))) {
    files.push(SOURCE_QUOTA_FILE);
  }
  if (existsSync(resolve(SOURCE_URLS_FILE))) {
    files.push(SOURCE_URLS_FILE);
  }
  // Phase 3 — Smarter generator: stage the topic-candidates consumed tracker
  // when it exists (created by the topic-candidate selection branch in main).
  if (existsSync(resolve(CONSUMED_TRACKER_PATH))) {
    files.push(CONSUMED_TRACKER_PATH);
  }
  // Include generated blog hero image (web path → filesystem path under public/).
  // WebP-only: optimizeImageToWebp emits a single file; no JPG sidecar.
  if (data?._generatedImagePath) {
    const webPath = data._generatedImagePath.replace(/^\//, '');
    const fsPath = `public/${webPath}`;
    if (existsSync(resolve(fsPath))) {
      files.push(fsPath);
    }
  }
  execSync(`git add ${resolveGitAddPaths(PROJECT_ROOT, files).join(' ')}`, { cwd: PROJECT_ROOT, stdio: 'inherit' });
  console.error('  ✅ Tutti i file modificati aggiunti a git');
}

// ── Main ────────────────────────────────────────────────────
const MAX_DUPLICATE_RETRIES = 8;

// Cap on how many Google-News candidates get folded into the proven pool per
// run (see the GOOGLE_NEWS_INJECT block in main). Keeps the pre-spend topic
// gate's classifier cost bounded — the pool already carries the direct-source
// scan; this is a top-up of the frontaliere stories that only live on Google
// News. Post-gate + dedup the effective count is far smaller.
const GOOGLE_NEWS_INJECT_MAX = Number(process.env.GOOGLE_NEWS_INJECT_MAX) || 60;

// Global wall-clock budget (2026-06-15). The generator has no overall deadline,
// so a pathological run (slow free-tier models + fact-check treadmill) can balloon
// to ~57min — past which the 30-min cron's next run cancels it anyway (5/60 runs
// observed cancelled). This budget caps the runaway TAIL: once exceeded we stop
// STARTING new topic attempts (an in-flight generation always finishes and may
// still publish); if nothing was produced the run exits with no changes and the
// self-trigger chain simply advances to the next run. It is deliberately generous
// (default 30min) so it never truncates a healthy ~15-20min run — it only fires on
// the pathological tail. Env-overridable for tuning without a code change.
const RUN_WALL_BUDGET_MS = Math.max(
  5 * 60_000,
  Number.parseInt(process.env.CREATE_ARTICLE_MAX_WALL_MS || String(30 * 60_000), 10) || (30 * 60_000),
);
const RUN_START_MS = Date.now();
/** True once the global wall-clock budget is spent (used to stop new topic attempts). */
function wallBudgetExceeded() {
  return (Date.now() - RUN_START_MS) > RUN_WALL_BUDGET_MS;
}

/**
 * Set true the first time callLLM() observes local/fallback actually serving
 * a request for the CURRENT headline (see callLLM below). Reset to false at
 * the top of generateAndValidateArticle (2026-07-06, PR #3704 review round
 * 2) — the process handles multiple headlines/pools/evergreen per run, each
 * via its own generateAndValidateArticle call, and a module-level flag left
 * set across headlines would poison a brand-new headline's first attempt
 * (which hasn't even tried the cloud model yet) purely because a PREVIOUS,
 * unrelated headline had cascaded to local. Cheaper and more precise than
 * the Firestore-score-based cloudCascadeExhausted check used by main()'s
 * evergreen pre-scan: that one only sees model scoring/cooldown state and
 * misses per-request cascades caused by prompt token-size alone. Read by
 * generateAndValidateArticle's own retry-loop wall-clock guard below.
 *
 * Deliberately LOCAL-ONLY, not "any last-resort tier" (2026-07-28, OmniRoute
 * promoted above local in ai-models.mjs's _lastResortTier — see that file):
 * this flag exists purely to pace CPU-bound Ollama inference, which the flag
 * name and LOCAL_MIN_VIABLE_MS below assume throughout. omniroute/auto is
 * network-bound and responds in seconds (no analogous timeout-truncation risk
 * to guard against), and claude-cli/haiku already has its own separate
 * circuit breaker in ai-models.mjs (_claudeCliConsecutiveTimeouts /
 * _claudeCliTimeoutStormDetected). Generalizing this flag to "any last-resort
 * tier used" would wrongly throttle omniroute retries using a CPU-inference
 * threshold it doesn't need — see MIN_VIABLE_ATTEMPT_MS below for the actual
 * provider-agnostic floor that already covers it.
 */
let _localFallbackUsedThisHeadline = false;
/**
 * Minimum wall-clock remaining (ms) to risk another local/fallback attempt
 * once one has already run for this headline. Local/fallback (qwen2.5:14b via Ollama)
 * full inference for this prompt size took ~17.5min and ~12.5min in the two
 * observed cases (run 28802314827); below this floor a further attempt would
 * be truncated mid-inference by _callLocal's own deadline cap (ai-models.mjs)
 * instead of completing — zero output, wasted GH Actions minutes. Set below
 * the faster observed completion (~12.5min) with a small margin so an
 * average-length attempt still gets a chance.
 *
 * Scoped to local/fallback specifically, same reasoning as the flag above —
 * do not reuse this floor for omniroute/auto (network round-trip, seconds not
 * minutes; this 11min reserve would starve it of retries it doesn't need).
 */
const LOCAL_MIN_VIABLE_MS = 11 * 60_000;

/**
 * Minimum wall-clock remaining (ms) to justify starting a brand-new attempt
 * at ALL — any provider, not just local/fallback. Distinct from
 * LOCAL_MIN_VIABLE_MS above, which reserves time specifically for local's
 * slow ~12-17min CPU inference. A new attempt's cascade tries ~70 free-tier
 * cloud models before ever reaching local, and a successful cloud call
 * typically completes in seconds — gating "start a new attempt" on local's
 * much larger reserve wasted every cloud-model chance in a run's last
 * minutes (root cause of runs producing zero articles: this fired below
 * 11min remaining even though a cloud model would easily fit). callLLM's own
 * deadlineMs check (ai-models.mjs) already bounds an in-flight attempt to
 * roughly one call's timeout past this floor, so lowering it doesn't risk an
 * unbounded overrun — it only stops starting a candidate with no realistic
 * time left for even one call.
 */
const MIN_VIABLE_ATTEMPT_MS = 2 * 60_000;

/**
 * True when the error is a CONTENT/QUALITY rejection (fact-check block,
 * topic-gate REGOLA #0 abort, fabrication, or a non-conformant headline that
 * survived its retry budget) rather than an infrastructure bug.
 *
 * Such rejections mean "no acceptable article this run" — exactly the same
 * disposition as a duplicate or an exhausted free-model pool. The retry loops
 * rotate to the next headline/keyword on these; if every candidate is
 * exhausted the run defers cleanly (exit 0) instead of hard-failing and raising
 * a false-positive "Workflow Failure: Generate Blog Article" Bug issue
 * (run 28000585473: a too-long headline after retry crashed the run with
 * exit 1 → spurious issue #2750).
 *
 * Per CLAUDE.md non-negotiable #1 the quality gate itself is NEVER lowered —
 * the slop is still refused; we only reclassify the disposition from
 * "infrastructure failure" to "clean deferral". Single source of truth so the
 * proven-pool catch, the evergreen catch, and the top-level main().catch can
 * never drift apart (non-negotiable #6).
 */
function isQualityRejectError(e) {
  if (!e) return false;
  if (e.qualityReject === true || e.topicGateAbort === true) return true;
  // `troppo corto` covers the whole thin-content class (too-short IT body
  // after the retry+expand ladder, too-short char count, too-short locale
  // field). A source that cannot reach the adaptive word/char floor is a
  // per-headline QUALITY problem — skip it and try the next headline rather
  // than crashing the whole run (run 28078614313: 296/700 IT words
  // propagated to exit 1 instead of self-healing to another topic). Same
  // class of bug as the 2026-05-11 topic-gate-abort miss.
  return /fact-check|rigettato|veridicità|fabricat|topic-gate abort|headline validation failed|troppo corto/i.test(
    String(e.message || ''),
  );
}

/**
 * A DUPLICATO rejection (checkForDuplicates / checkSemanticNearDuplicate)
 * that escaped every in-loop retry. The pool-based paths (proven headlines,
 * evergreen keywords) already catch+retry these internally up to
 * MAX_DUPLICATE_RETRIES; this only fires for the direct-URL invocation
 * (`node create-article.mjs <url>`), which the self-trigger chain uses to
 * re-dispatch a single specific evergreen candidate (`next_url`) with no
 * retry loop of its own. The candidate was correctly rejected as a
 * near/exact duplicate — that's "no acceptable article this run", the same
 * clean-deferral class as isQualityRejectError/isQuotaExhaustedError, NOT an
 * infrastructure failure. Exit 0 so the self-trigger back-off retries later
 * instead of marking the run failed and raising a false-positive "Workflow
 * Failure: Generate Blog Article" Bug issue (run 29739570817 → #4606).
 */
function isDuplicateError(e) {
  if (!e) return false;
  return /DUPLICATO/i.test(String(e.message || ''));
}

async function main() {
  // Positional <url> = first non-flag argv (so `--section=` can precede it).
  let url = process.argv.slice(2).find((a) => !a.startsWith('--'));
  let headlines = null;

  // Disk space pre-flight: when LOCAL_LLM_ENABLED the model (e.g. qwen2.5:14b,
  // ~9GB) can fill the runner disk, causing ENOSPC on later stdout writes instead
  // of a clear error. Detect and abort early with an actionable message.
  // Root fix: change ARTICLE_LOCAL_MODEL repo variable to qwen2.5:7b (~5GB).
  if (isLocalLlmEnabled()) {
    try {
      const dfOut = execSync("df -k . | tail -1 | awk '{print $4}'").toString().trim();
      const freeKB = parseInt(dfOut, 10);
      if (Number.isFinite(freeKB) && freeKB < 500 * 1024) {
        const freeMB = Math.round(freeKB / 1024);
        const model = process.env.LOCAL_LLM_MODEL || '(unset)';
        console.error(`❌ Disk critically low: ${freeMB}MB free with local LLM model "${model}" loaded.`);
        console.error('   Fix: change ARTICLE_LOCAL_MODEL repo variable to qwen2.5:7b');
        console.error('   (GitHub Settings → Secrets and variables → Actions → Variables)');
        process.exit(1);
      }
    } catch { /* ignore — df unavailable or parse error */ }
  }

  // ── Auto-scan mode: no URL provided → scan news sources first, then evergreen fallback ──
  if (!url) {
    // Evergreen quota counter (2026-05-07): the 30% hard-skip was reverted
    // 2026-05-07 because the evergreen pool produces near-duplicate variants
    // of already-published articles that pass the slug pre-flight but fail
    // the content-duplicate post-LLM, burning ~22 min of generation per
    // forced run with zero output. Counter still loads (informational/
    // future-soft-preference) but no longer skips the news scan. Manual
    // override via FORCE_EVERGREEN=1 still works for admin/testing.
    const evergreenCounterState = _loadEvergreenCounter();
    // Local-only cascade detection: when every OTHER option — the free-tier
    // cloud pool, AND omniroute/auto, AND claude-cli/haiku — is exhausted/
    // cooling-down/disabled and only local/fallback remains, organic/news
    // generation forces the (weak, CPU-only) local model to closely follow a
    // specific news article — the failure mode that actually blocks runs is
    // source-fidelity ("coerenza") drift, not hallucination. Evergreen mode is
    // grounded on EVERGREEN_FACTS_BRIEF and exempt from that check (see
    // llmFactCheck's isEvergreen branch), so route local-only runs there
    // instead of burning the wall-clock budget on organic retries unlikely
    // to pass. No-op when local/fallback is disabled or ANY non-local option
    // has capacity — omniroute/claude-cli are NOT local's weak-model failure
    // mode (network-routed, not CPU-bound), so their availability alone is
    // enough to skip this route just like an ordinary free-tier model would.
    await initScoreStore();
    // NB "cloudOnlyChain" is a misnomer left over from before omniroute/
    // claude-cli existed — it excludes ONLY LOCAL_FALLBACK by identity, so it
    // still contains omniroute/auto and claude-cli/haiku. That's intentional,
    // not a bug: this check's purpose is "is local/fallback literally the
    // only thing left", and both of those ARE viable non-local alternatives
    // for that purpose (see comment above) even though they're themselves
    // opt-in tiers (tier-0 by default since 2026-07-29's AI_COMPETING_TIERS —
    // see ai-models.mjs — but still excluded here by identity, not rank, so
    // this check is unaffected by that promotion either way). Renaming would
    // be a pure identifier change with no behavior difference; left as-is as
    // a comment-only fix (2026-07-28) to keep this edit surgical.
    const cloudOnlyChain = DEFAULT_CHAIN.filter((m) => m !== AI_MODELS.LOCAL_FALLBACK);
    const cloudCascadeExhausted = isLocalLlmEnabled() && !getPreferredModel({ chain: cloudOnlyChain });
    if (cloudCascadeExhausted) {
      console.error('🔀 Cascata cloud esaurita, solo local/fallback disponibile — route diretto a evergreen (grounding garantito).');
      RUN_REPORT.notes.push('Local-only cascade detected pre-scan: routed to evergreen (organic/news generation skipped)');
    }
    const forceEvergreen = process.env.FORCE_EVERGREEN === '1' || cloudCascadeExhausted;
    let newsSuccess = false;

    // ── Phase 3: quota-based slot dispatch (proven vs discovery) ──
    // Decide BEFORE fetching anything. The counter is read here but only
    // INCREMENTED at the end of a successful publish — a stuck/failed run
    // does not burn quota counters. See spec § 6.6.
    const quotaState = _loadQuotaState();
    const evidenceForDiscovery = _evidenceIndex; // alias — already loaded above
    const slotDecision = _decideSlot(quotaState);
    const slotKind = forceEvergreen ? 'proven' : slotDecision.slotKind;
    let chosenPool = slotKind;
    let _discoveryHeadlines = null;
    let _discoveryCandidatesById = new Map();
    let _provenHeadlinesForDiscovery = [];
    // Captured before applyPreSpendTopicGate so the discovery fallback can
    // resolve Google News RSS URLs even when the gate empties the proven
    // pool (run 26440805420). The fuzzy matcher in resolveGoogleNewsHeadline
    // needs the FULL proven scan, not the post-gate residue.
    let _provenHeadlinesPreGate = [];
    RUN_REPORT.poolSlotKind = slotKind;
    RUN_REPORT.poolCounterValue = slotDecision.counterValue;
    RUN_REPORT.poolCurrentQuota = slotDecision.currentQuota;
    console.error(`SLOT_DECISION pool=${slotKind} counter=${slotDecision.counterValue} quota=${slotDecision.currentQuota}`);

    // Helper — convert discovery candidates into headline-shaped objects
    // compatible with rankAndSelectHeadlines (field `headline`, optional `url`).
    const _discoveryCandidatesToHeadlines = (candidates) => {
      _discoveryCandidatesById = new Map();
      const out = [];
      for (const c of candidates) {
        const id = `discovery::${c.source}::${String(c.headline).toLowerCase()}`;
        _discoveryCandidatesById.set(id, c);
        const headline = {
          headline: c.headline,
          url: c.url || `discovery://${encodeURIComponent(c.source)}/${encodeURIComponent(c.headline)}`,
          source: c.source,
          relatedHeadlines: [],
          _discoveryId: id,
          _discoveryCandidate: c,
          // Real publisher host behind a Google News wrapper (from the RSS
          // <source url> attr, no decode needed). Lets the ranker's
          // source-quality multiplier score a known publisher (RSI, etc.)
          // instead of degrading news.google.com to neutral 1.0 (issue #4101).
          _publisherHost: (c && c.meta && c.meta.publisherHost) || null,
        };
        // resolveGoogleNewsHeadline now ALWAYS returns an object: the direct
        // twin when the fuzzy-match hits, else the wrapper flagged
        // _needsGoogleNewsDecode (decoded lazily at fetch time). It no longer
        // drops candidates — the old `if (!resolved) …skip` branch was the
        // exact behaviour that discarded ~219 real news/run and is gone. Keep a
        // defensive falsy-guard only (should not fire for a valid candidate).
        const resolved = resolveGoogleNewsHeadline(headline, _provenHeadlinesForDiscovery);
        if (!resolved) continue;
        if (resolved._resolvedFromGoogleNewsRss) {
          console.error(`   🔗 Google News RSS risolto a fonte diretta (${resolved._resolvedGoogleNewsScore.toFixed(2)}): ${resolved.url}`);
        }
        out.push(resolved);
      }
      return out;
    };

    // ── Phase 1: Scan external news sources (skipped only on explicit FORCE_EVERGREEN=1) ──
    if (forceEvergreen) {
      console.error('📚 Forced evergreen — FORCE_EVERGREEN=1 (env override). Salto scan news.\n');
    } else if (slotKind === 'discovery' && evidenceForDiscovery) {
      // Discovery slot — build the discovery pool. Cross-pool dedup runs
      // against the proven news-scan headlines (so a discovery candidate
      // already covered by today's news pool is dropped). Spec § 6.5.
      console.error('🔭 Fase 1 (discovery slot): scan news pool (per dedup) + build discovery pool...\n');
      const provenHeadlinesForDedup = await scanNewsSources();
      _provenHeadlinesForDiscovery = provenHeadlinesForDedup || [];
      const provenStrings = (provenHeadlinesForDedup || []).map((h) => String(h.headline || ''));
      try {
        const pool = await _buildDiscoveryPool(evidenceForDiscovery, {
          provenHeadlines: provenStrings,
        });
        console.error(`DISCOVERY_POOL_BUILD orphan=${pool.perSource.orphan} suggest=${pool.perSource.suggest} news=${pool.perSource.news} postDedup=${pool.postDedupCount}`);
        _discoveryHeadlines = _discoveryCandidatesToHeadlines(pool.candidates);
      } catch (err) {
        console.error(`⚠️  Discovery pool build failed: ${err?.message || err}`);
        _discoveryHeadlines = [];
      }
      if (_discoveryHeadlines.length === 0) {
        console.error('POOL_FALLBACK from=discovery to=proven reason=empty');
        RUN_REPORT.poolFallbacks.push({ from: 'discovery', to: 'proven', reason: 'empty' });
        chosenPool = 'proven';
        headlines = provenHeadlinesForDedup;
      } else {
        headlines = _discoveryHeadlines;
      }
    } else {
      console.error(
        IS_FRONTALIERE
          ? '🤖 Fase 1: Ricerca articolo da fonti ticinesi...\n'
          : '🤖 Fase 1: Ricerca articolo da fonti nazionali svizzere...\n',
      );
      headlines = await scanNewsSources();
      // Cross-pool dedup applied for proven slot too: drop any news headline
      // already covered by an orphan-query (these get a guaranteed slot via
      // the discovery pool when their slot comes around). Cheap — orphan list
      // is in-memory.
      if (
        slotKind === 'proven'
        && evidenceForDiscovery
        && Array.isArray(evidenceForDiscovery?.gsc?.orphanQueries)
        && evidenceForDiscovery.gsc.orphanQueries.length > 0
      ) {
        const orphanStrings = evidenceForDiscovery.gsc.orphanQueries
          .map((o) => String(o?.query || ''))
          .filter(Boolean);
        const beforeDedup = headlines.length;
        headlines = headlines.filter((h) => !_isNearDuplicateHeadline(String(h.headline || ''), orphanStrings));
        if (beforeDedup > headlines.length) {
          console.error(`PROVEN_CROSS_POOL_DEDUP dropped=${beforeDedup - headlines.length} kept=${headlines.length}`);
        }
      }

      // ── Inject Google-News candidates into the proven pool (2026-07-11) ──
      // The 51/26 direct feeds carry mostly local cronaca; the genuinely
      // frontaliere-relevant stories (es. "disoccupazione dei frontalieri")
      // surface ONLY on Google News. Before this, they reached create-article
      // solely via the discovery fallback and were dropped as "non risolto a
      // fonte diretta" (run 29142084681: 219 dropped, 1 resolved → evergreen).
      // We now fold the Google-News NEWS candidates (source='news' ONLY —
      // never orphan/suggest, so no demand-query "offerte" leak in) into the
      // proven pool so the same ranker + gates rank them alongside direct
      // sources. Real-URL decoding is deferred to fetch time (lazy). Entirely
      // best-effort: any failure leaves the direct-source pool untouched.
      // Wall-clock guard: this adds a remote pool build (orphan/suggest/news
      // fetches) that the proven slot did NOT do before. Skip it when the run
      // budget is already spent, so slow/timing-out feeds can't push the run
      // past its deadline — the direct-source pool + evergreen safety net still
      // produce an article. (_buildDiscoveryPool has its own per-fetch timeouts
      // too; this is the belt to that suspenders.)
      if (slotKind === 'proven' && evidenceForDiscovery && wallBudgetExceeded()) {
        // Observability: make the budget-skip visible (the removed dead branch
        // used to log its own skip); silence here would hide why no Google-News
        // candidates entered the pool on a budget-tight run.
        console.error('GOOGLE_NEWS_INJECT skipped=wall_budget_exceeded');
        RUN_REPORT.notes.push('Google-News injection skipped: wall budget exceeded before pool build');
      }
      if (slotKind === 'proven' && evidenceForDiscovery && !wallBudgetExceeded()) {
        try {
          _provenHeadlinesForDiscovery = headlines.slice();
          const provenStrings = headlines.map((h) => String(h.headline || ''));
          const gnPool = await _buildDiscoveryPool(evidenceForDiscovery, { provenHeadlines: provenStrings });
          const newsOnly = (gnPool.candidates || []).filter((c) => c && c.source === 'news');
          const gnHeadlines = _discoveryCandidatesToHeadlines(newsOnly).slice(0, GOOGLE_NEWS_INJECT_MAX);
          if (gnHeadlines.length > 0) {
            const beforeInject = headlines.length;
            const existingUrls = new Set(headlines.map((h) => h.url));
            for (const gh of gnHeadlines) {
              if (!existingUrls.has(gh.url)) headlines.push(gh);
            }
            console.error(`GOOGLE_NEWS_INJECT news_candidates=${newsOnly.length} injected=${headlines.length - beforeInject} pool=${headlines.length}`);
          }
        } catch (err) {
          console.error(`⚠️  Google-News injection into proven pool failed (non-blocking): ${err?.message || err}`);
        }
      }
    }

    if (headlines && headlines.length > 0) {
      // ── Pre-filter: remove headlines whose source URL was already used ──
      const beforeSourceFilter = headlines.length;
      headlines = headlines.filter(h => {
        const check = isSourceUrlAlreadyUsed(h.url);
        if (check.used) {
          console.error(`  🔗 Headline scartata (URL già usata → ${check.articleId}): ${h.headline.slice(0, 60)}…`);
          RUN_REPORT.preFilterDrops.urlAlreadyUsed += 1;
          recordDiscardedHeadline({
            reason: 'url_already_used',
            headline: h.headline,
            existingId: check.articleId,
            signal: check.signal,
          });
          return false;
        }
        return true;
      });
      if (beforeSourceFilter > headlines.length) {
        console.error(`  📋 Post-filtro URL: ${headlines.length}/${beforeSourceFilter} headline rimanenti\n`);
      }

      // ── Pre-filter: remove headlines whose TOPIC matches an existing article ──
      // Same news re-published on a different URL slips past the URL dedup. The
      // article-ID containment check (Italian stemmer + synonyms) catches
      // semantic duplicates BEFORE we burn 6 LLM cycles that would hard-fail
      // at the title-collision gate in optimizeSeoMetadata.
      const beforeTopicFilter = headlines.length;
      headlines = headlines.filter(h => {
        const check = preFlightHeadlineCheck(h.headline);
        if (check.duplicate) {
          console.error(`  📰 Headline scartata (topic già coperto → ${check.existingId}, ${check.signal}=${check.sim.toFixed(2)}): ${h.headline.slice(0, 60)}…`);
          RUN_REPORT.preFilterDrops.topicAlreadyCovered += 1;
          recordDiscardedHeadline({
            reason: 'topic_already_covered',
            headline: h.headline,
            existingId: check.existingId,
            existingTitle: check.existingTitle,
            signal: check.signal,
            sim: Number(check.sim.toFixed(3)),
          });
          return false;
        }
        return true;
      });
      if (beforeTopicFilter > headlines.length) {
        console.error(`  📋 Post-filtro topic: ${headlines.length}/${beforeTopicFilter} headline rimanenti\n`);
      }

      // ── Pre-spend topic gate (REGOLA #0 short-circuit, 2026-05-15) ──
      // Before the Tentativo loop burns ~5-7k tokens per headline on
      // full article generation, run a cheap anchor-regex + tiny-LLM
      // classifier to drop off-topic news (cronaca nera, sport, eventi
      // non-frontalieri). Full rationale + env gates: see
      // `applyPreSpendTopicGate` doc block above. REGOLA #0 in the
      // article-gen prompt stays in place as defense-in-depth.
      const beforePreSpendGate = headlines.length;
      // Snapshot the proven scan BEFORE the gate. If the gate empties the
      // pool, the cross-pool fallback (proven→discovery) still needs the
      // direct-source URLs to resolve Google News RSS items against. See
      // run 26440805420: 193 RSS candidates dropped because the gate had
      // already emptied headlines[] used as the resolver atlas.
      _provenHeadlinesPreGate = headlines.slice();
      headlines = await applyPreSpendTopicGate(headlines);
      if (beforePreSpendGate > headlines.length) {
        console.error(`  📋 Post-pre-spend gate: ${headlines.length}/${beforePreSpendGate} headline rimanenti\n`);
      }

      const quotaPools = buildSourceQuotaPools(headlines);
      const poolPlan = [];
      if (quotaPools.inQuota.length > 0) {
        poolPlan.push({ name: 'in-quota', headlines: quotaPools.inQuota });
      }
      if (quotaPools.outOfQuota.length > 0) {
        poolPlan.push({ name: 'out-of-quota', headlines: quotaPools.outOfQuota });
      }

      const triedUrls = new Set();

      // ── Phase B+C — Demand-driven ranker (replaces first-headline-wins) ──
      // The news pool is the *content*; the demand-vocabulary is the *scoring
      // signal*. Pick the headline with the strongest demand-overlap, with
      // cluster diversity + experimental-tier rotation. If the ranker returns
      // empty (no headline meets min-score, vocab missing), fall through to
      // the legacy LLM-based selectArticle.
      const _existingItTitles = _topicLoadExistingItTitles();
      const _todayPicksState = _loadTodayPicksByCluster();
      const _experimentalCounterState = _loadExperimentalCounter();
      let _persistRankerStateOnSuccess = null;

      for (let poolIndex = 0; poolIndex < poolPlan.length; poolIndex++) {
        const pool = poolPlan[poolIndex];
        if (poolIndex > 0) {
          console.error('\n⚠️  Nessuna opzione valida in quota: fallback su fonti out-of-quota.\n');
        }

        for (let attempt = 1; attempt <= MAX_DUPLICATE_RETRIES; attempt++) {
          // Wall-clock budget guard: stop starting NEW topic attempts once the
          // global budget is spent (an already-started generation finished above).
          if (wallBudgetExceeded()) {
            console.error(`⏱️  Budget wall-clock (${Math.round(RUN_WALL_BUDGET_MS / 60000)}min) superato — interrompo i tentativi ${pool.name}; l'articolo è deferito al prossimo run.`);
            break;
          }
          // Cross-headline minimum-viable-attempt reserve (2026-07-07, incident
          // run 28850309199; floor lowered 2026-07-08 — see MIN_VIABLE_ATTEMPT_MS
          // above). Stop picking NEW candidates once there's no realistic time
          // left for even one cascade call; an in-flight generation (started
          // before the floor was crossed) still runs to completion untouched —
          // same clean-deferral disposition as the guard below. Deliberately NOT
          // gated on local/fallback's much larger reserve (LOCAL_MIN_VIABLE_MS):
          // the cascade tries ~70 fast cloud models before ever reaching local,
          // so reserving 11min here was killing real cloud-model chances in a
          // run's last minutes — the actual root cause of zero-article runs.
          {
            const remainingForNewAttemptMs = RUN_WALL_BUDGET_MS - (Date.now() - RUN_START_MS);
            if (remainingForNewAttemptMs < MIN_VIABLE_ATTEMPT_MS) {
              console.error(`⏱️  Restano ${Math.round(remainingForNewAttemptMs / 60_000)}min (< ${MIN_VIABLE_ATTEMPT_MS / 60_000}min necessari per un nuovo tentativo) — interrompo i tentativi ${pool.name} invece di avviare un candidato che rischia di non completare; l'articolo è deferito al prossimo run.`);
              RUN_REPORT.notes.push(`Retry loop stopped early: cross-headline minimum-viable-attempt reserve (pool=${pool.name}, attempt=${attempt}, remainingMin=${Math.round(remainingForNewAttemptMs / 60_000)})`);
              break;
            }
          }
          try {
            // Filter out already-tried URLs.
            const availableHeadlines = pool.headlines.filter(h => !triedUrls.has(h.url));
            if (availableHeadlines.length === 0) {
              console.error(`⚠️  Tutte le headline ${pool.name} sono state provate.`);
              break;
            }

            // ── Demand-driven ranker (Phase B+C) ──
            let chosen = null;
            let rankerTier = null;
            let rankerScoreObj = null;
            let rankerCluster = null;
            if (_demandVocabulary || _experimentalCandidates || _evidenceIndex) {
              try {
                console.error(`\n🎯 Ranker [${pool.name}] (tentativo ${attempt}/${MAX_DUPLICATE_RETRIES}): pool=${availableHeadlines.length} headlines mode=${_evidenceIndex ? 'cascade' : 'legacy'}`);
                const consumed = _topicLoadConsumedTracker(CONSUMED_TRACKER_PATH);
                const picks = await _rankAndSelectHeadlines(availableHeadlines, _demandVocabulary, {
                  experimentalCandidates: _experimentalCandidates,
                  experimentalCounter: _experimentalCounterState.count,
                  todayPicksByCluster: _todayPicksState.picksByCluster,
                  existingTitles: _existingItTitles,
                  consumed,
                  headlineTitleField: 'headline',
                  maxPicks: 1,
                  // Source-quality boost (P3, 2026-05-07): domains with
                  // historical winner-rate above median get up to 1.5x;
                  // below get down to 0.5x. Self-strengthening loop.
                  sourceQuality: _articlePerformance && _articlePerformance.sourceQuality,
                  // Phase 2 — when evidence-index.json is present (and the
                  // USE_CASCADED_SCORING flag is on), the ranker switches to
                  // the GSC → embedding → cluster cascade. Legacy vocab
                  // path stays available for rollback (env=0).
                  evidence: _evidenceIndex,
                });
                if (picks.length > 0) {
                  const top = picks[0];
                  rankerTier = top._selectedSource || 'stable';
                  rankerScoreObj = top._score || null;
                  rankerCluster = top._cluster || null;
                  if (rankerTier === 'experimental') {
                    // Convert experimental candidate → evergreen-style URL.
                    const kw = top.keyword || '';
                    chosen = {
                      url: `evergreen://${encodeURIComponent(kw)}`,
                      headline: kw,
                      source: 'experimental',
                      _experimentalCandidate: top,
                    };
                    process.env._EVERGREEN_ANGLE = top.angle || kw;
                    process.env._EVERGREEN_KEYWORD = kw;
                  } else {
                    chosen = top; // stable headline pick — pass through.
                  }
                  let scoreStr = 'score=experimental';
                  if (rankerScoreObj) {
                    if (rankerScoreObj.stage) {
                      // Phase 2 cascade breakdown: { stage, rawScore, confidence, finalScore, score, ... }
                      scoreStr = `score=${(rankerScoreObj.score ?? rankerScoreObj.finalScore ?? 0).toFixed(3)} (stage=${rankerScoreObj.stage}, raw=${(rankerScoreObj.rawScore ?? 0).toFixed(2)}, conf=${(rankerScoreObj.confidence ?? 1).toFixed(2)}, div=${(rankerScoreObj.clusterDiversityBonus ?? 1).toFixed(2)})`;
                    } else if (typeof rankerScoreObj.score === 'number') {
                      // Legacy demand-vocab breakdown.
                      scoreStr = `score=${rankerScoreObj.score.toFixed(3)} (demand=${(rankerScoreObj.demandScore ?? 0).toFixed(3)}, div=${(rankerScoreObj.clusterDiversityBonus ?? 0).toFixed(2)}, novel=${(rankerScoreObj.noveltyScore ?? 0).toFixed(2)})`;
                    }
                  }
                  console.error(`   ✅ Ranker pick: tier=${rankerTier} cluster=${rankerCluster || 'n/a'} ${scoreStr}`);
                  console.error(`   📰 "${(chosen.headline || chosen.keyword || '').slice(0, 80)}"\n`);
                } else {
                  console.error('   ⏭️  Ranker: nessuna headline sopra min-score — fallback LLM selectArticle\n');
                }
              } catch (rankerErr) {
                console.error(`   ⚠️  Ranker error (graceful fallback): ${rankerErr?.message || rankerErr}\n`);
                chosen = null;
              }
            }

            // ── Legacy LLM selector (fallback when ranker returns nothing) ──
            if (!chosen) {
              console.error(`\n🧠 Selezione articolo con Gemini [${pool.name}] (tentativo ${attempt}/${MAX_DUPLICATE_RETRIES})...`);
              chosen = await selectArticle(availableHeadlines);
              rankerTier = 'llm-fallback';
            }

            if (chosen?.url?.startsWith('evergreen://')) {
              const keyword = chosen.headline || chosen.keyword || process.env._EVERGREEN_KEYWORD || '';
              const check = preFlightEvergreenCheck({
                keyword,
                angle: process.env._EVERGREEN_ANGLE || keyword,
              });
              if (check.duplicate) {
                throw new Error(
                  `❌ DUPLICATO PRE-GEN: "${keyword}" già coperto da "${check.existingTitle}" [${check.existingId}] (${check.signal}=${check.sim.toFixed(2)})`
                );
              }
            }

            RUN_REPORT.selectionUsage.attemptsTotal += 1;
            if (chosen?._undatedFallback) RUN_REPORT.selectionUsage.attemptsUndated += 1;
            else RUN_REPORT.selectionUsage.attemptsRecent += 1;
            RUN_REPORT.selectedArticleType = rankerTier === 'experimental' ? 'experimental' : 'news';
            RUN_REPORT.selectedSource = normalizeSourceDomain(chosen?.source || '');
            RUN_REPORT.selectedUrl = chosen?.url || null;
            RUN_REPORT.selectedTier = rankerTier;
            RUN_REPORT.selectedScore = rankerScoreObj ? rankerScoreObj.score : null;
            RUN_REPORT.selectedCluster = rankerCluster;
            RUN_REPORT.poolSize = availableHeadlines.length;
            triedUrls.add(chosen.url);
            url = chosen.url;
            console.error('');

            // Stage state-mutation for AFTER successful generation only.
            const _picked = chosen;
            const _pickedTier = rankerTier;
            const _pickedCluster = rankerCluster;
            const _pickedScore = rankerScoreObj;
            // Phase 3 — capture the pool decision once we know which path
            // produced the picked candidate. discovery candidates carry a
            // `_discoveryCandidate` marker; otherwise it's a proven (news-scan)
            // pick. Used for the post-publish sidecar + RUN_REPORT tagging.
            const _pickedPool = chosen?._discoveryCandidate ? 'discovery' : chosenPool;
            const _pickedPoolSource = chosen?._discoveryCandidate
              ? chosen._discoveryCandidate.source
              : (chosen?.source || 'news-scan');
            RUN_REPORT.pool = _pickedPool;
            RUN_REPORT.poolSource = _pickedPoolSource;
            _persistRankerStateOnSuccess = () => {
              try {
                if (_pickedCluster && _todayPicksState.picksByCluster) {
                  const next = {
                    date: _todayPicksState.date,
                    picksByCluster: { ..._todayPicksState.picksByCluster },
                  };
                  next.picksByCluster[_pickedCluster] = (next.picksByCluster[_pickedCluster] || 0) + 1;
                  _persistTodayPicksByCluster(next);
                }
                // Always tick the experimental counter so the round-robin advances,
                // regardless of which tier we landed on.
                _persistExperimentalCounter({ count: (_experimentalCounterState.count || 0) + 1 });
                // Tick the evergreen counter too — round-robin for the
                // 30% evergreen quota. Advances on EVERY successful run
                // (news, experimental, or LLM-fallback).
                _persistEvergreenCounter({ count: (evergreenCounterState.count || 0) + 1 });
                // If experimental pick succeeded, mark the candidate as consumed.
                if (_pickedTier === 'experimental' && _picked && _picked._experimentalCandidate) {
                  const exp = _picked._experimentalCandidate;
                  if (exp.id) {
                    const consumed = _topicLoadConsumedTracker(CONSUMED_TRACKER_PATH);
                    const updated = _topicAppendConsumedId(consumed, exp.id);
                    _topicPersistConsumedTracker(updated, CONSUMED_TRACKER_PATH);
                  }
                }
                // Phase 3 — increment quota counter ONLY now (success). Spec § 6.6:
                // never on failure, never before publish, exactly once per slot.
                _saveQuotaState(_incrementCounter(quotaState));
                // Sidecar JSON for the picked candidate so Phase 4's
                // winnerEvaluator can read _pool / _pool_source / _score_breakdown.
                try {
                  const sidecarDir = SECTION.sidecarDir;
                  mkdirSync(resolve(sidecarDir), { recursive: true });
                  const sidecarId = RUN_REPORT.article?.id || null;
                  if (sidecarId) {
                    const sidecarPath = `${sidecarDir}/${sidecarId}.json`;
                    const payload = {
                      id: sidecarId,
                      slug: RUN_REPORT.article?.slug || sidecarId,
                      publishedAt: new Date().toISOString(),
                      cluster: _pickedCluster || null,
                      _pool: _pickedPool,
                      _pool_source: _pickedPoolSource,
                      _score_breakdown: _pickedScore || null,
                    };
                    write(sidecarPath, `${JSON.stringify(payload, null, 2)}\n`);
                  }
                } catch (e) {
                  console.warn(`[generator] could not write pool sidecar: ${e?.message || e}`);
                }
              } catch (e) {
                console.warn(`[generator] could not persist ranker state: ${e?.message || e}`);
              }
            };

            // ── Lazy Google-News URL decode (2026-07-11) ──
            // A candidate folded in from Google News carries the wrapper URL +
            // _needsGoogleNewsDecode. Decode the real publisher URL NOW — only
            // for the ONE headline the ranker picked, so the 2-request decode
            // cost is bounded — so fetchPageContent below hits the actual
            // source article. On decode failure, or when the decoded URL turns
            // out already-used, skip to the next headline instead of fetching
            // an unusable news.google.com wrapper (which would yield no source
            // text → topic-gate abort → wasted attempt).
            //
            // `attempt--` before both `continue`s below (2026-07-21): these are
            // CHEAP skips (no LLM call, no fetch of source content) — the
            // candidate never reached generateAndValidateArticle. Without the
            // decrement they silently consumed a MAX_DUPLICATE_RETRIES slot
            // just like an expensive failed generation, so a run whose first
            // 8 ranker picks all happened to decode to already-published
            // Google News wrappers (common: the same underlying story
            // re-surfaces under many GNews headline variants) burned its
            // entire retry budget on decode-only skips and fell through to
            // the Fase 2 evergreen fallback WITHOUT EVER calling
            // generateAndValidateArticle once — even though `triedUrls`
            // (updated above at candidate-selection time) still had dozens of
            // untried, already relevance/dedup-filtered headlines left in
            // `pool.headlines`. Confirmed live: run 29801301652 logged exactly
            // 8 consecutive "URL già usata" skips before "Fase 2: Fallback
            // evergreen", pool=93 headlines still available. The decrement
            // makes these free (bounded only by wall-clock/availableHeadlines
            // guards above, same as before), reserving MAX_DUPLICATE_RETRIES
            // for attempts that actually spend LLM budget.
            if (chosen?._needsGoogleNewsDecode || isGoogleNewsRssUrl(url)) {
              const realUrl = await decodeGoogleNewsUrl(url);
              if (!realUrl) {
                console.error(`   ⏭️  Google News non decodificabile — provo un'altra headline (non conta come tentativo): "${String(chosen.headline || '').slice(0, 60)}"`);
                attempt--;
                continue;
              }
              const used = isSourceUrlAlreadyUsed(realUrl);
              if (used.used) {
                console.error(`   🔗 Google News decodificata ma URL già usata (→ ${used.articleId}) — provo un'altra headline (non conta come tentativo)`);
                attempt--;
                continue;
              }
              console.error(`   🔓 Google News decodificata → fonte reale: ${realUrl.slice(0, 80)}`);
              url = realUrl;
              chosen = { ...chosen, url: realUrl, _resolvedFromGoogleNewsRss: chosen.url };
            }

            // Attempt the full article generation + duplicate check
            await generateAndValidateArticle(url, chosen);
            newsSuccess = true;
            // Persist ranker state ONLY on success (failure shouldn't bump counters).
            if (_persistRankerStateOnSuccess) _persistRankerStateOnSuccess();
            return; // Success — exit main
          } catch (e) {
            const isDuplicate = e.message.includes('DUPLICATO');
            if (isDuplicate) captureDuplicateReasons(e.message);
            if (isDuplicate && attempt < MAX_DUPLICATE_RETRIES) {
              console.error(`\n🔄 Duplicato rilevato (${duplicateReasonTag(e.message)}${duplicateCandidateDetail(e.message)}), riprovo con un altro articolo... (${attempt}/${MAX_DUPLICATE_RETRIES})\n`);
              url = null; // Reset for next iteration
              continue;
            }
            if (isDuplicate && attempt >= MAX_DUPLICATE_RETRIES) {
              console.error(`\n⚠️  ${MAX_DUPLICATE_RETRIES} tentativi ${pool.name} esauriti — tutti duplicati (ultimo: ${duplicateReasonTag(e.message)}${duplicateCandidateDetail(e.message)}).`);
              break; // try next pool, then evergreen
            }
            // Fact-check / quality failures → skip this article, try next.
            // Includes REGOLA #0 topic-gate aborts: when the LLM correctly
            // refuses to fabricate a frontaliere angle on a cronaca-nera or
            // non-relevant source (see line ~2787), the error carries
            // err.topicGateAbort=true. Without this branch the abort
            // propagates to main() and fails the whole run instead of
            // letting the loop try a different headline (run 25697916845,
            // 2026-05-11). Same quality outcome (slop not published)
            // but workflow stays green and retry budget is honored.
            const isTopicGateAbort = e.topicGateAbort === true || /topic-gate abort/i.test(e.message);
            const isQualityReject = isQualityRejectError(e);
            if (isQualityReject && attempt < MAX_DUPLICATE_RETRIES) {
              const tag = isTopicGateAbort ? 'topic-gate (REGOLA #0)' : 'qualità';
              console.error(`\n⚠️  Articolo rigettato per ${tag} — provo un altro headline... (${attempt}/${MAX_DUPLICATE_RETRIES})\n`);
              url = null;
              continue;
            }
            if (isQualityReject && attempt >= MAX_DUPLICATE_RETRIES) {
              console.error(`\n⚠️  ${MAX_DUPLICATE_RETRIES} tentativi ${pool.name} esauriti — qualità insufficiente.`);
              break; // try next pool, then evergreen
            }
            // Non-duplicate, non-quality error → propagate
            throw e;
          }
        }
      }
    } else {
      console.error('⚠️  Nessun headline trovato da nessuna fonte.\n');
    }

    // ── Phase 3 cross-pool fallback ──
    // If the assigned slot's pool produced no successful publish, try the
    // OTHER pool before falling to evergreen. Spec § 6.7. Counter still
    // increments only on successful publish (see _persistRankerStateOnSuccess).
    if (!newsSuccess && !forceEvergreen && evidenceForDiscovery) {
      if (slotKind === 'proven' && !_discoveryHeadlines) {
        console.error('POOL_FALLBACK from=proven to=discovery reason=empty');
        RUN_REPORT.poolFallbacks.push({ from: 'proven', to: 'discovery', reason: 'empty' });
        try {
          // Use the PRE-gate proven scan as the URL atlas. The gate may have
          // dropped legitimate direct-source headlines that the Google News
          // RSS resolver still needs to fuzzy-match against. Falling back
          // to post-gate headlines empties the atlas and drops every RSS
          // candidate as "non risolto a fonte diretta" (run 26440805420:
          // 193 RSS items, 0 resolved).
          const atlas = _provenHeadlinesPreGate.length > 0
            ? _provenHeadlinesPreGate
            : (headlines || []);
          const provenStrings = atlas.map((h) => String(h.headline || ''));
          _provenHeadlinesForDiscovery = atlas;
          const pool = await _buildDiscoveryPool(evidenceForDiscovery, { provenHeadlines: provenStrings });
          console.error(`DISCOVERY_POOL_BUILD_FALLBACK orphan=${pool.perSource.orphan} suggest=${pool.perSource.suggest} news=${pool.perSource.news} postDedup=${pool.postDedupCount}`);
          const fbHeadlines = _discoveryCandidatesToHeadlines(pool.candidates);
          if (fbHeadlines.length > 0) {
            chosenPool = 'discovery';
            // Reuse the same pipeline as the main flow by resetting `headlines`
            // and re-entering the news-pool loop block. Simpler: emit a marker
            // and rely on the ranker to handle them — but the easiest robust
            // approach is to delegate the fallback to the same ranker block by
            // calling ourselves recursively-light via a small inline retry.
            // To keep diff small we set headlines and break to evergreen if
            // they still don't yield — discovery's first chance is in the main
            // dispatch above; reaching here means we already tried proven AND
            // neither path published. Best we can do without large refactor.
            console.error('   (fallback discovery pool surfaced; full re-entry deferred to evergreen safety net)');
          }
        } catch (err) {
          console.error(`⚠️  Cross-pool fallback (proven→discovery) failed: ${err?.message || err}`);
        }
      } else if (slotKind === 'discovery' && _discoveryHeadlines && _discoveryHeadlines.length > 0) {
        console.error('POOL_FALLBACK from=discovery to=proven reason=empty');
        RUN_REPORT.poolFallbacks.push({ from: 'discovery', to: 'proven', reason: 'empty' });
        // Already covered: the dispatch above downgraded to proven before
        // entering the loop when discovery built no candidates. If we reach
        // here, the discovery loop ran but every candidate failed publish
        // (duplicate / quality reject). Evergreen safety net follows.
      }
    }

    // ── Phase 1.5 REMOVED 2026-05-07 ──
    // The legacy Phase 1.5 topic-candidate pool was structurally bypassed:
    // CANDIDATE_MIN_SCORE=0.6 was unreachable with the empirical candidate
    // distribution (top score ~0.55), so this code path never produced an
    // article. Phase B+C demand-driven ranker (in `selectArticle`/
    // `rankAndSelectHeadlines`) replaces it: news pool is ranked by
    // demand-vocabulary overlap directly, no separate "candidate pool"
    // round needed. Legacy `data/topic-candidates.json` is no longer
    // written; new consumers use `data/demand-vocabulary.json` +
    // `data/experimental-candidates.json`.
    const candidateSuccess = false;

    // ── Phase 2: Evergreen fallback — only reached if news scan produced nothing usable ──
    if (!newsSuccess && !candidateSuccess && wallBudgetExceeded()) {
      console.error(`⏱️  Budget wall-clock (${Math.round(RUN_WALL_BUDGET_MS / 60000)}min) superato — salto il fallback evergreen; nessun articolo questo run (deferito al prossimo).`);
    } else if (!newsSuccess && !candidateSuccess) {
      console.error('📚 Fase 2: Fallback evergreen — generazione articolo SEO long-tail...\n');

      // Pick an evergreen topic based on week number, with rotation on duplicate.
      // When static list is exhausted, append dynamic long-tail combinations,
      // then the structural pool (evergreen-topic-generator.mjs) — profession
      // × comune candidates derived from PROFESSION_TAXONOMY and MUNICIPALITIES
      // instead of another hand-written batch, since those saturate every
      // 1-2 weeks as the corpus grows (#3138 2026-07-02, again 2026-07-08,
      // again 2026-07-17).
      //
      // Section-aware pool (2026-07-21): PRIORITY_EVERGREEN_TOPICS,
      // buildDynamicEvergreenTopics and buildStructuralEvergreenTopics are ALL
      // frontaliere/Ticino-scoped (border comuni × frontaliere professions).
      // Before this fix the `svizzera` section (national CH, all cantons —
      // see the prompt's "NON sei limitato ai frontalieri" framing) silently
      // reused this same Ticino-only pool for its evergreen fallback, so
      // every /articoli-svizzera/ static article ended up Ticino-scoped
      // regardless of the national framing wrapped around it. `svizzera` now
      // draws from its own national pool (all-canton keywords) instead.
      //
      // 2026-08-10: `svizzera` ha ora anche il proprio pool strutturale
      // (`buildStructuralEvergreenTopicsSvizzera`, 20 pilastri × 25 cantoni).
      // Senza, la sezione stava ferma a 110 keyword contro le 537 frontaliere,
      // ne aveva 90 gia' bannate, e OGNI run scheduled usciva in ~50s con
      // «Tutte le keyword evergreen risultano gia' coperte dal pre-flight» —
      // due dei quattro slot cron orari sprecati e la catena self-trigger
      // interrotta a ogni anello svizzero. Vedi il commento sul builder.
      const topicPool = IS_FRONTALIERE
        ? [...PRIORITY_EVERGREEN_TOPICS, ...buildDynamicEvergreenTopics(), ...buildStructuralEvergreenTopics()]
        : [
          ...PRIORITY_EVERGREEN_TOPICS_SVIZZERA,
          ...buildDynamicEvergreenTopicsSvizzera(),
          ...buildStructuralEvergreenTopicsSvizzera(),
        ];
      const weekNum = Math.floor((Date.now() - new Date('2025-01-06').getTime()) / (7 * 24 * 60 * 60 * 1000));
      const baseIndex = weekNum % topicPool.length;
      const totalTopics = topicPool.length;

      // Cross-run duplicate memory (#3138, 2026-07-02): keywords already
      // confirmed duplicate post-generation in a PREVIOUS cron run. Without
      // this, a saturated pool (frontaliere: 2728 articles) gets the same
      // doomed neighborhood re-attempted every 30-min run forever, since
      // each run otherwise starts with zero memory of prior failures.
      let evergreenRejectedTracker = _loadEvergreenRejectedTracker();

      RUN_REPORT.evergreenPool.ran = true;
      RUN_REPORT.evergreenPool.size = totalTopics;

      // Pre-flight check — find first keyword that doesn't conflict with existing articles
      let selectedTopic = null;
      let selectedOffset = -1;
      console.error(`   Pre-flight check su ${totalTopics} keyword...\n`);

      for (let offset = 0; offset < totalTopics; offset++) {
        const idx = (baseIndex + offset) % totalTopics;
        const candidate = topicPool[idx];
        RUN_REPORT.evergreenPool.checked += 1;
        if (_isEvergreenRejected(evergreenRejectedTracker, candidate.keyword)) {
          // Ban e strike hanno cause diverse — un duplicato confermato non si
          // ripara mai, uno strike da quality-reject si — e un pool che muore
          // per l'uno o per l'altro chiede due interventi diversi
          // (allargarlo vs `reset-evergreen-strikes.mjs`). Contarli insieme
          // rendeva la diagnosi indistinguibile.
          if ((evergreenRejectedTracker?.keywords || []).includes(candidate.keyword)) {
            RUN_REPORT.evergreenPool.skippedBanned += 1;
          } else {
            RUN_REPORT.evergreenPool.skippedStruck += 1;
          }
          console.error(`   ⏭️  [${idx}] "${candidate.keyword}" → già rigettato come duplicato in run precedente — skip`);
          continue;
        }
        const check = preFlightEvergreenCheck(candidate);
        if (check.duplicate) {
          countEvergreenPreflightDrop(check.signal);
          console.error(`   ⏭️  [${idx}] "${candidate.keyword}" → simile a "${check.existingTitle}" [${check.existingId}] (${(check.sim * 100).toFixed(0)}%) — skip`);
        } else {
          console.error(`   ✅ [${idx}] "${candidate.keyword}" → nessun conflitto — selezionato\n`);
          selectedTopic = candidate;
          selectedOffset = offset;
          break;
        }
      }

      if (!selectedTopic) {
        reportEvergreenPoolSaturation('preflight');
        console.error('\n⚠️  Tutte le keyword evergreen risultano già coperte dal pre-flight. Push prosegue senza nuovo articolo.');
        finalizeRunReport('skipped', { notes: [...RUN_REPORT.notes, 'All evergreen keywords rejected by pre-generation duplicate checks'] });
        process.exit(0);
      }

      // Generate article with retry — rotate to next safe keyword on post-generation duplicate.
      // Cap raised 10→25 (#3138 follow-up): the widened evergreen pool (#3217) gives more
      // untried keywords per run than the old cap could exhaust before falling through to
      // "Push prosegue senza nuovo articolo" — the cap, not the pool, was the bottleneck.
      const triedOffsets = new Set([selectedOffset]);
      for (let attempt = 1; attempt <= Math.min(25, totalTopics); attempt++) {
        // Wall-clock budget guard (2026-07-01, PR #3220 review follow-up): the
        // sibling news-pool retry loop above (~L7531) checks this every
        // iteration; this loop didn't, so raising the cap 10→25 risked a
        // single cron run blowing well past its intended wall-clock budget
        // (each attempt is ~60-90s plus up to 3×30s fact-check backoff)
        // instead of falling through gracefully to "prosegue senza nuovo articolo".
        if (wallBudgetExceeded()) {
          console.error(`⏱️  Budget wall-clock (${Math.round(RUN_WALL_BUDGET_MS / 60000)}min) superato — interrompo i tentativi evergreen; l'articolo è deferito al prossimo run.`);
          break;
        }
        // Cross-headline minimum-viable-attempt reserve: same guard as the
        // news-pool loop (~L8360; see MIN_VIABLE_ATTEMPT_MS for the 2026-07-08
        // rationale). Deliberately NOT gated on local/fallback's much larger
        // reserve (LOCAL_MIN_VIABLE_MS) — the cascade tries ~70 fast cloud
        // models before ever reaching local, so this only stops picking a new
        // candidate once there's no realistic time left for even one call.
        {
          const remainingForNewAttemptMs = RUN_WALL_BUDGET_MS - (Date.now() - RUN_START_MS);
          if (remainingForNewAttemptMs < MIN_VIABLE_ATTEMPT_MS) {
            console.error(`⏱️  Restano ${Math.round(remainingForNewAttemptMs / 60_000)}min (< ${MIN_VIABLE_ATTEMPT_MS / 60_000}min necessari per un nuovo tentativo) — interrompo i tentativi evergreen invece di avviare un candidato che rischia di non completare; l'articolo è deferito al prossimo run.`);
            RUN_REPORT.notes.push(`Retry loop stopped early: cross-headline minimum-viable-attempt reserve (pool=evergreen, attempt=${attempt}, remainingMin=${Math.round(remainingForNewAttemptMs / 60_000)})`);
            break;
          }
        }
        try {
          const topic = selectedTopic;
          const isStaticTopic = IS_FRONTALIERE
            ? PRIORITY_EVERGREEN_TOPICS.includes(topic)
            : PRIORITY_EVERGREEN_TOPICS_SVIZZERA.includes(topic);
          RUN_REPORT.selectedArticleType = isStaticTopic ? 'evergreen_static' : 'evergreen_dynamic';
          RUN_REPORT.selectedSource = 'evergreen';
          RUN_REPORT.selectedUrl = `evergreen://${encodeURIComponent(topic.keyword)}`;
          console.error(`📚 Evergreen tentativo ${attempt}: keyword "${topic.keyword}"`);
          console.error(`   Angolo: ${topic.angle}\n`);
          url = `evergreen://${encodeURIComponent(topic.keyword)}`;
          process.env._EVERGREEN_ANGLE = topic.angle;
          process.env._EVERGREEN_KEYWORD = topic.keyword;

          await generateAndValidateArticle(url, { headline: topic.keyword, source: 'evergreen', relatedHeadlines: [] });
          // Tick evergreen counter on success (round-robin advance).
          try {
            _persistEvergreenCounter({ count: (evergreenCounterState.count || 0) + 1 });
          } catch { /* ignore */ }
          // Phase 3 — tag the evergreen fallback in RUN_REPORT and tick the
          // quota counter (a successful publish, regardless of pool).
          RUN_REPORT.pool = 'evergreen-fallback';
          RUN_REPORT.poolSource = 'evergreen';
          try {
            _saveQuotaState(_incrementCounter(quotaState));
          } catch { /* ignore */ }
          return; // Success — exit main
        } catch (e) {
          const isDuplicate = e.message.includes('DUPLICATO');
          if (isDuplicate) captureDuplicateReasons(e.message);
          // Fact-check / quality failures → try next keyword instead of crashing.
          // Includes REGOLA #0 topic-gate aborts — same rationale as the proven-pool
          // branch above (~line 5946).
          const isTopicGateAbort = e.topicGateAbort === true || /topic-gate abort/i.test(e.message);
          const isQualityReject = isQualityRejectError(e);
          if (!isDuplicate && !isQualityReject) throw e; // Infrastructure error → propagate
          if ((isDuplicate || isTopicGateAbort) && selectedTopic) {
            // Cross-run memory (#3138, #3242): persist immediately so a mid-loop
            // wallBudgetExceeded() break can't lose already-confirmed rejections.
            // isTopicGateAbort: REGOLA #0 structural failure — if the LLM cannot
            // generate frontaliere-relevant content from this evergreen keyword
            // once, it is unlikely to succeed on the next cron run either.
            // Persisting avoids wasting ~60-90s per doomed attempt.
            // Quality-rejects (too-short/thin) intentionally excluded: LLM
            // variance makes them transient; blocking permanently is too aggressive.
            evergreenRejectedTracker = _appendEvergreenRejected(evergreenRejectedTracker, selectedTopic.keyword);
            try { _persistEvergreenRejectedTracker(evergreenRejectedTracker); } catch { /* ignore */ }
          } else if (isQualityReject && selectedTopic) {
            // A STRIKE, not a ban — the reasoning above is right that one bad
            // draft is variance, but "never record it" was the wrong conclusion:
            // it left no way to tell variance from a keyword that fails every
            // time. Such a keyword was re-picked on every cron slot and burned
            // the whole run, which is how production went to zero on
            // 2026-08-03. Retired only at EVERGREEN_STRIKE_LIMIT.
            // Persisted immediately, same reason as the ban path: a later
            // wall-budget break or hard kill must not lose the count.
            evergreenRejectedTracker = _strikeEvergreenKeyword(evergreenRejectedTracker, selectedTopic.keyword);
            const n = evergreenRejectedTracker.strikes?.[selectedTopic.keyword] || 0;
            console.error(`   ⚠️  "${selectedTopic.keyword}": strike ${n}/${_EVERGREEN_STRIKE_LIMIT} (quality reject)`);
            try { _persistEvergreenRejectedTracker(evergreenRejectedTracker); } catch { /* ignore */ }
          }

          if (isTopicGateAbort) {
            console.error(`\n⚠️  Keyword evergreen rigettata da topic-gate (REGOLA #0) — cerco prossima keyword...\n`);
          } else if (isQualityReject) {
            console.error(`\n⚠️  Articolo evergreen rigettato per qualità — cerco prossima keyword...\n`);
          } else {
            console.error(`\n🔄 Duplicato post-generazione (${duplicateReasonTag(e.message)}${duplicateCandidateDetail(e.message)}), cerco prossima keyword sicura...\n`);
          }

          // Find next safe keyword we haven't tried yet
          selectedTopic = null;
          for (let offset = selectedOffset + 1; offset < selectedOffset + totalTopics; offset++) {
            const realOffset = offset % totalTopics;
            if (triedOffsets.has(realOffset)) continue;
            const idx = (baseIndex + realOffset) % totalTopics;
            const candidate = topicPool[idx];
            RUN_REPORT.evergreenPool.checked += 1;
            if (_isEvergreenRejected(evergreenRejectedTracker, candidate.keyword)) {
              if ((evergreenRejectedTracker?.keywords || []).includes(candidate.keyword)) {
                RUN_REPORT.evergreenPool.skippedBanned += 1;
              } else {
                RUN_REPORT.evergreenPool.skippedStruck += 1;
              }
              triedOffsets.add(realOffset);
              continue;
            }
            const check = preFlightEvergreenCheck(candidate);
            if (check.duplicate) countEvergreenPreflightDrop(check.signal);
            if (!check.duplicate) {
              selectedTopic = candidate;
              selectedOffset = realOffset;
              triedOffsets.add(realOffset);
              console.error(`   ✅ [${idx}] "${candidate.keyword}" → prossimo tentativo\n`);
              break;
            }
          }

          if (!selectedTopic) {
            reportEvergreenPoolSaturation('retry');
            console.error('\n⚠️  Nessuna keyword evergreen disponibile. Push prosegue senza nuovo articolo.');
            finalizeRunReport('skipped', { notes: [...RUN_REPORT.notes, 'No evergreen keyword available after duplicate checks'] });
            process.exit(0);
          }
        }
      }

      // All retry attempts exhausted
      console.error('\n⚠️  Tentativi evergreen esauriti. Push prosegue senza nuovo articolo.');
      finalizeRunReport('skipped', { notes: [...RUN_REPORT.notes, 'Evergreen retries exhausted'] });
      process.exit(0);
    }
    return;
  }

  // ── Manual URL mode ──
  if (!url || (!url.startsWith('http') && !url.startsWith('evergreen://') && !url.startsWith('stats-bfs://'))) {
    finalizeRunReport('error', { notes: [...RUN_REPORT.notes, 'Invalid URL input'] });
    console.error('❌ URL non valido. Uso: node scripts/create-article.mjs [url]');
    process.exit(1);
  }

  await generateAndValidateArticle(url, null);
}

/** Core article pipeline: fetch → generate IT → validate → duplicates → translate → sanitize → image → modify files → git */
async function generateAndValidateArticle(url, sourceContext = null) {
  // Scope the local-only wall-clock guard to THIS headline (2026-07-06,
  // PR #3704 review): the flag is set by any callLLM() in the process that
  // cascades to local/fallback — including a PREVIOUS headline's retries,
  // its translation, or its body expansion, all of which run inside the
  // same process before this call. Without resetting per-headline, a prior
  // headline touching local/fallback would poison a brand-new headline's
  // very first attempt (which hasn't even tried the cloud model yet) the
  // moment wall-clock ran low — reproducing the "run publishes zero
  // articles" failure via a different path than the one this guard exists
  // to fix.
  _localFallbackUsedThisHeadline = false;
  if (isGoogleNewsRssUrl(url)) {
    const err = new Error(`topic-gate abort: Google News RSS wrapper senza fonte diretta (${url})`);
    err.topicGateAbort = true;
    throw err;
  }

  // Step 1: Fetch page content
  const pageContent = await fetchPageContent(url);

  // Step 1b: Early topical pre-flight on the source page itself (2026-05-12).
  // Why: the geographic anchor-gate is too permissive (any Locarnese /
  // Gallarate / Varese mention passes). The expensive density check at
  // ~line 6340 fires AFTER the full IT body + FAQ are generated — burning
  // ~10 min of LLM quota per skipped run (observed 8/10 recent runs hit
  // this path). Inspecting the source URL text BEFORE the first callGemini
  // costs ~50ms and catches the same off-topic pages with zero false
  // negatives on observed cases (asilo, chiesetta, cuoco, etc.). A
  // legitimate frontaliere article contains at least one
  // lavoro/fisco/permesso/transport/economy token in the source body.
  // Env-gated for rollback.
  const dropOffTopicSource = (process.env.SOURCE_DROP_OFF_TOPIC ?? '1') !== '0';
  if (dropOffTopicSource && typeof pageContent === 'string' && pageContent.length > 0) {
    const sourceHits = countAdmissionHits(pageContent);
    if (sourceHits === 0) {
      console.error(`\n⏭️  Source non frontaliere-rilevante (pre-LLM): 0 topical hits sul testo sorgente (URL: ${url}). Provo un altro headline.`);
      RUN_REPORT.notes.push(`Source skipped pre-LLM: 0 topical hits (url=${url})`);
      // Same pattern as the post-LLM skip below: throw with topicGateAbort
      // so the outer ranker loop tries a different headline within this run
      // instead of exiting hard and letting the next cron re-pick the same
      // one. process.exit(0) here was the proximate cause of the same-headline
      // infinite skip loop observed 2026-05-18.
      const err = new Error(`topic-gate abort: pre-LLM 0 topical hits for ${url}`);
      err.topicGateAbort = true;
      throw err;
    }
  }

  // Step 2: Generate Italian content + metadata (no translations yet), with aggressive min-word retries
  // Rotates through GPT-4o → GPT-4o-mini → Gemini with escalating prompts
  let data = null;
  let lastWordCount = 0;

  // A5 headline retry budget — spec: retry once with a refined prompt, then
  // hard-fail. We track this OUTSIDE the per-attempt loop so the budget
  // survives across the existing model-rotation retries used for min-word
  // failures (those use up to CREATE_ARTICLE_MIN_WORDS_RETRIES attempts; we
  // don't want the headline check to silently consume more than one of them).
  let headlineRetryBudget = 1;
  /** @type {string|null} */
  let lastHeadlineErrors = null;
  // Carries the previous attempt's fact-check rejection summary into the next
  // generation so callGemini can feed the exact flagged claims back to the model.
  /** @type {string|null} */
  let lastFactCheckErrors = null;

  const isStatsBfsSource = String(url || '').startsWith('stats-bfs://');
  // La lunghezza che le scale adattive devono misurare. Per una fonte reale è
  // il testo scrapato; per `stats-bfs://` non esiste testo scrapato, quindi è
  // vuota — vedi il commento sotto.
  const lengthBudgetSource = isStatsBfsSource ? '' : pageContent;

  // Adaptive min-words: scale target down when source is thin to prevent
  // hallucination cascade (was 900 fixed → forced model to invent facts
  // on short news briefs, blocked by fact-check on every retry).
  //
  // `stats-bfs://` NON passa dalla scala, e per la stessa ragione che la scala
  // esiste. computeAdaptiveMinWords() misura i CARATTERI del source scrapato,
  // come proxy di quanto materiale c'è. Per questa fonte il "source" è il
  // prompt che formatStatsBfsPrompt() ha appena costruito: la sua lunghezza
  // misura quanto sono verbose le ISTRUZIONI, non quanti dati ci sono. Il
  // materiale vero è sempre lo stesso ogni trimestre — un totale, due
  // variazioni, otto trimestri di serie, undici fasce d'età, due generi.
  //
  // Il difetto è visibile a occhio nudo: rendere le istruzioni più esplicite
  // (valerielinc-ops#5341) ha portato il prompt da ~3.900 a ~4.024 caratteri e
  // la soglia da 700 a 900 parole. Scrivere istruzioni migliori rendeva il
  // gate più duro — il contrario di come la scala è pensata.
  //
  // E la soglia alta su questa fonte non è neutrale, è già costata una
  // pubblicazione: `frontalieri-ticino-stabili-2026-q1` arriva alle parole
  // richieste con cifre per Lugano, Chiasso, Mendrisio, Bellinzona e Locarno,
  // aliquote alla fonte e premi LAMal che il dataset BFS non contiene. Nessun
  // gate le ha viste, perché la via che le produce — expandShortItalianContent,
  // il cui prompt chiede alla lettera «riferimenti a comuni ticinesi
  // specifici» — gira DOPO l'ultimo controllo e il suo output non ne
  // ripassa nessuno. Alzare l'asticella su una fonte di soli numeri è la
  // domanda a cui quel testo è la risposta.
  //
  // Nessuna soglia nuova: si azzera la LUNGHEZZA passata alle scale, non le
  // scale. Così le due companion — computeAdaptiveMinWords e
  // computeAdaptiveMinChars — restano allineate per costruzione: scavalcarne
  // una sola rimetterebbe in piedi esattamente il caso che il commento di
  // computeAdaptiveMinChars descrive («un run adattivo da 400 parole (~2400
  // char) inciampa nel floor statico da 2500»).
  const adaptiveMinWords = computeAdaptiveMinWords(lengthBudgetSource);
  if (isStatsBfsSource) {
    console.error(`  📏 Fonte sintetica stats-bfs (${pageContent.length} chars di prompt, non di articolo) → min IT words target: ${adaptiveMinWords}`);
  } else if (adaptiveMinWords < CREATE_ARTICLE_MIN_IT_WORDS) {
    console.error(`  📏 Source thin (${pageContent.length} chars) → min IT words target: ${adaptiveMinWords} (was ${CREATE_ARTICLE_MIN_IT_WORDS})`);
  }

  // Zero-grounding news source → cap the regen-attempt budget much lower
  // (see computeMaxGenerationAttempts doc comment). Evergreen/stats-bfs
  // always synthesize non-empty content, so they're unaffected and keep
  // the full CREATE_ARTICLE_MIN_WORDS_RETRIES budget.
  const maxAttempts = computeMaxGenerationAttempts(pageContent, url);
  if (maxAttempts < CREATE_ARTICLE_MIN_WORDS_RETRIES) {
    console.error(`  ⚡ Fonte non scaricabile (0 chars) → cap retry a ${maxAttempts}/${CREATE_ARTICLE_MIN_WORDS_RETRIES}: senza testo sorgente il fact-check blocca quasi ogni tentativo.`);
  }

  // Tracks the model used by the immediately preceding attempt, for
  // selectMinWordsRetryModel()'s back-to-back-duplicate skip below.
  let previousMinWordsModel = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Cost accounting for the rejection ledger. Counted here — at the top of
    // the loop, before any early `continue` — because an attempt abandoned on
    // the wall-clock guard below still consumed the run's budget, and a cost
    // metric that only counts attempts which reached a gate would show the
    // pipeline getting cheaper precisely as it started running out of time.
    // Accumulates across headlines: this function runs once per candidate.
    RUN_REPORT.factuality.attempts += 1;

    // Wall-clock guard for the local-only cascade (2026-07-06, incident run
    // 28802314827): once local/fallback has generated at least one attempt
    // for THIS headline (flag reset per-headline — see the reset at the top
    // of this function), cloud has empirically proven unusable for this
    // prompt (the
    // Firestore-score-based cloudCascadeExhausted check in main() only sees
    // model scoring/cooldown state and misses per-request token-size
    // cascades). Each full local/fallback inference took ~12-17min observed;
    // a further attempt below LOCAL_MIN_VIABLE_MS remaining would be
    // truncated mid-inference by _callLocal's own deadline cap instead of
    // completing — zero output, wasted GH Actions minutes. That exact chain
    // (17.5min + 12.5min burned on unrelated rejections, leaving only 5.5min
    // for a 3rd local attempt that then hard-timed-out) is why that run
    // published nothing. Stop cleanly here instead; the next cron run gets a
    // fresh full budget. Same qualityReject disposition as the other
    // "survived retry budget" throws (see isQualityRejectError above) — this
    // is a clean per-headline deferral, not an infrastructure crash.
    // Local-specific by design, not "any last-resort tier" — see
    // _localFallbackUsedThisHeadline's doc comment above for why omniroute
    // (network-bound) and claude-cli (own circuit breaker) don't need this.
    if (_localFallbackUsedThisHeadline) {
      const remainingMs = RUN_WALL_BUDGET_MS - (Date.now() - RUN_START_MS);
      if (remainingMs < LOCAL_MIN_VIABLE_MS) {
        console.error(`  ⏭️  Interrompo i retry: local/fallback già usato per questo headline, restano ${Math.round(remainingMs / 60_000)}min (< ${LOCAL_MIN_VIABLE_MS / 60_000}min necessari per completare un altro tentativo senza timeout) — evito un timeout a vuoto.`);
        RUN_REPORT.notes.push(`Retry loop stopped early: local-only wall-clock guard (attempt=${attempt}, remainingMin=${Math.round(remainingMs / 60_000)})`);
        const err = new Error(`Local/fallback wall-clock budget insufficiente per un altro tentativo (restano ${Math.round(remainingMs / 60_000)}min)`);
        err.qualityReject = true;
        throw err;
      }
    }
    // selectMinWordsRetryModel() picks the same model the plain index would,
    // except it skips an immediate back-to-back repeat of the previous
    // attempt's model (see its doc comment — quality-neutral, default ON,
    // CREATE_ARTICLE_MINWORDS_DEDUP=0 reverts to the plain clamp).
    const modelSlot = selectMinWordsRetryModel(attempt, previousMinWordsModel);
    previousMinWordsModel = modelSlot;
    const useGeminiDirect = modelSlot === 'gemini';
    // Higher temperature on later attempts to get more varied/longer output
    const tempBoost = attempt >= 7 ? 0.9 : (attempt >= 5 ? 0.8 : 0.7);
    const modelLabel = useGeminiDirect ? `Gemini ${AI_MODELS.GEMINI_FLASH}` : modelSlot;
    if (attempt > 1) {
      console.error(`  🔄 Tentativo ${attempt}/${maxAttempts} con ${modelLabel} (temp=${tempBoost})...`);
    }

    const genContext = {
      ...(sourceContext || {}),
      _generationAttempt: attempt,
      _generationAttemptMax: maxAttempts,
      _minItalianWords: adaptiveMinWords,
      _previousWordCount: lastWordCount || undefined,
      _forceModel: useGeminiDirect ? 'gemini' : modelSlot,
      _temperature: tempBoost,
      // A5: surface the headline error from the previous iteration so the
      // refined prompt block in callGemini knows what to ask the model to fix.
      _headlineRefinement: lastHeadlineErrors || undefined,
      // Surface the previous attempt's fact-check rejections so callGemini can
      // tell the model exactly which invented claims to remove/correct.
      _factCheckRefinement: lastFactCheckErrors || undefined,
    };

    let rawData;
    try {
      rawData = await callGemini(pageContent, url, genContext);
    } catch (e) {
      console.error(`  ⚠️  Tentativo ${attempt} fallito: ${e.message}`);
      if (attempt < maxAttempts) continue;
      throw e;
    }

    // Step 3: Validate (works on IT-only data). Pass the adaptive chars
    // threshold so the early thin-content warning matches what the final
    // gate at the bottom of this function actually enforces.
    try {
      data = validate(rawData, { minBodyChars: computeAdaptiveMinChars(lengthBudgetSource) });
    } catch (validationErr) {
      console.error(`  ⚠️  Validazione fallita: ${validationErr.message}`);
      if (attempt < maxAttempts) {
        console.error(`  🔄 Rigenero contenuto per errore di validazione (${attempt}/${maxAttempts})...`);
        continue;
      }
      throw validationErr;
    }
    optimizeSeoMetadata(data);

    // Step 3a.0-skip: bail early when the chosen source has zero frontaliere
    // signal. Detected on attempt 1 only — across retries the source URL is
    // identical, so density==0 means the topic itself is non-relevant
    // (e.g. Italian-only labour-law news with no Swiss/cross-border angle).
    // More retries cannot fix the source; they only burn LLM quotas before
    // crashing on fact-check or JSON parse errors. Skip cleanly so the next
    // cron tick picks a different headline. Per CLAUDE.md rule #5: fix the
    // root cause (wrong topic), don't lower the validation bar.
    // Frontaliere-only gate: 0 frontaliere-density keywords means an off-angle
    // topic for the cross-border section. For the NATIONAL svizzera section a
    // body with 0 frontaliere keywords is EXPECTED and correct, so this abort
    // must not fire — otherwise every national article would be skipped.
    if (attempt === 1 && IS_FRONTALIERE) {
      const itBodyEarly = `${data.content?.it?.body1 || ''} ${data.content?.it?.body2 || ''} ${data.content?.it?.body3 || ''}`;
      const earlyDensity = checkFrontaliereDensity(itBodyEarly);
      if (earlyDensity.hits === 0 && earlyDensity.wordCount > 0) {
        console.error(`\n⏭️  Topic non frontaliere-rilevante: 0 keyword density su ${earlyDensity.wordCount} parole (URL: ${url}). Provo un altro headline.`);
        RUN_REPORT.notes.push(`Topic skipped: 0 frontaliere-density hits on attempt 1 (url=${url})`);
        // Throw with topicGateAbort so the outer ranker loop at line ~6588
        // catches it and picks a different headline within this same run.
        // Previously `process.exit(0)` exited hard → next cron tick re-picked
        // the same top-scored headline → infinite skip loop (observed
        // 2026-05-18 runs 26019355100, 26019412679, 26019478370 all picking
        // the same `terapia-attestati-cerimonia-formazione-lugano`).
        const err = new Error(`topic-gate abort: 0 frontaliere keywords for ${url}`);
        err.topicGateAbort = true;
        throw err;
      }
    }

    // Step 3a.0-headline: Google News compliance — A5
    //
    // Validate the IT title (which becomes both the JSON-LD `headline` and
    // the rendered <h1>) and the persisted `seo.headline`. Both fields are
    // checked; on failure we use up to one refinement retry and then hard-fail
    // the run, per CLAUDE.md non-negotiable rule #1 (never silently publish a
    // non-conformant article).
    //
    // Sync invariant (also enforced here): `seo.headline` MUST equal
    // `content.it.title`. If a previous step diverged them, we re-align here
    // so the <title>/<h1>/<headline> trio is consistent for Google News.
    {
      const itTitle = String(data.content?.it?.title || '').trim();
      const seoHeadline = String(data.seo?.headline || '').trim();

      // Re-align headline → it.title before validating, so a single failure
      // surfaces both fields rather than two duplicate failures.
      if (data.seo && itTitle && seoHeadline !== itTitle) {
        console.error(`  🔁 Sync seo.headline ⇐ content.it.title ("${seoHeadline}" → "${itTitle}")`);
        data.seo.headline = itTitle;
      }

      const headlineErrors = validateHeadline(itTitle);
      if (headlineErrors.length > 0) {
        const summary = headlineErrors.join('; ');
        console.error(`  ⚠️  Headline non conforme: "${itTitle}" — ${summary}`);

        if (headlineRetryBudget > 0 && attempt < maxAttempts) {
          headlineRetryBudget -= 1;
          lastHeadlineErrors = summary;
          console.error(`  🔄 Rigenero con prompt rifinito (budget headline residuo: ${headlineRetryBudget})...`);
          continue;
        }

        // Budget exhausted — refuse to publish a non-conformant article. Per
        // CLAUDE.md rule #1 we NEVER lower the validation threshold; the slop is
        // dropped. But this is a content/quality rejection (the free model kept
        // emitting an over-length title), NOT an infrastructure bug — tag it so
        // the retry loops rotate to the next headline/keyword and, if every
        // candidate is exhausted, the run defers cleanly (exit 0) instead of
        // hard-failing and raising a spurious "Workflow Failure" Bug issue
        // (run 28000585473 → issue #2750).
        const headlineErr = new Error(
          `Headline validation failed after retry. ` +
          `Title: "${itTitle}" — Errors: ${summary}`,
        );
        headlineErr.qualityReject = true;
        throw headlineErr;
      }

      // Step 3a.0-titlesync: ensure <title> ↔ <h1> sync.
      //
      // The rendered <h1> is `t('blog.article.{id}.title')` which mirrors
      // `content.it.title`. The <title> meta is `data.seo.title` (which may
      // get the brand suffix " | Frontaliere Ticino" appended by
      // optimizeSeoMetadata). We verify the *core* of seo.title — i.e.
      // seo.title with the suffix stripped — matches it.title byte-for-byte.
      const TITLE_SUFFIX = ' | Frontaliere Ticino';
      const seoTitleCore = String(data.seo?.title || '')
        .replace(/\s*\|\s*Frontaliere\s+Ticino\s*$/i, '')
        .trim();
      if (seoTitleCore !== itTitle) {
        // Fix it: the canonical source is content.it.title (it's what becomes
        // the H1; we treat it as ground truth). Rebuild seo.title with suffix
        // if it fits the 66-char cap (60 + 10 % tolerance), otherwise drop
        // the brand. Mirrors build-plugins/shared/titleSuffix.ts.
        const TITLE_MAX_CHARS = 66;
        const candidate = `${itTitle}${TITLE_SUFFIX}`;
        const newSeoTitle = candidate.length <= TITLE_MAX_CHARS ? candidate : itTitle;
        console.error(`  🔁 Sync seo.title ⇐ content.it.title ("${seoTitleCore}" → "${itTitle}")`);
        if (!data.seo) data.seo = {};
        data.seo.title = newSeoTitle;
      }
    }

    // Step 3a.0-pre: Assign byline author from the registry. Topic-based when
    // category/keywords match an author's expertise; otherwise deterministic
    // hash on data.id so the same article always picks the same author.
    {
      const sectionHaystack = [
        data.category || '',
        data.seo?.keywords || '',
        data.seo?.headline || '',
        data.content?.it?.title || '',
        data.id || '',
      ].join(' ');
      data.author = pickAuthorForTopic(sectionHaystack, data.id);
      console.error(`  ✍️  Byline assegnata: ${data.author.name} (${data.author.slug})`);
    }

    // Step 3a.0: Sanitize bold on IT content
    console.error('✂️  Sanitizzazione grassetto (IT):');
    sanitizeBoldFormatting(data);

    // Step 3a.0a: Domain-specific factual guard (tax-health audience inversion)
    try {
      assertTaxHealthConsistency(data.content.it, { ...(sourceContext || {}), url }, pageContent);
    } catch (consistencyErr) {
      console.error(`  ⚠️  ${consistencyErr.message}`);
      if (attempt < maxAttempts) {
        console.error(`  🔄 Rigenero contenuto IT per coerenza fattuale (${attempt}/${maxAttempts})...`);
        continue;
      }
      throw consistencyErr;
    }

    // Step 3a.0b: Fabricated references check — BLOCKING (fast regex pre-filter)
    try {
      assertNoFabricatedReferences(data.content.it);
    } catch (fabErr) {
      console.error(`  ⚠️  ${fabErr.message}`);
      if (attempt < maxAttempts) {
        console.error(`  🔄 Rigenero contenuto IT per riferimenti inventati (${attempt}/${maxAttempts})...`);
        continue;
      }
      throw fabErr;
    }

    // Step 3a.0b-bis: Deterministic factuality gates — BLOCKING, no model calls
    //
    // Runs BEFORE the LLM verifier on purpose: these checks are free, so a
    // draft with broken arithmetic or an impossible tax is rejected without
    // spending any of the shared quota. They also cover the whole article,
    // not just the first MAX_FACTCHECK_ARTICLE_CHARS, and cannot fail open.
    //
    // Everything here is decidable from the text alone — see
    // scripts/lib/article-factuality-gates.mjs for the incident that motivated
    // each check.
    {
      const gateResult = runFactualityGates({
        sections: {
          body1: data.content.it?.body1 || '',
          body2: data.content.it?.body2 || '',
          body3: data.content.it?.body3 || '',
        },
        // `stripInjectedBriefs`, non `pageContent` nudo (#96). Per un
        // evergreen `pageContent` E' il brief che questo stesso script ha
        // appena scritto, quindi passarlo qui chiedeva all'articolo di
        // ricitare meta' del proprio ground truth per non essere bloccato —
        // 27 anchor, soglia 14. Su una fonte reale la chiamata e' un no-op
        // esatto e il gate resta invariato. Vedi il commento della funzione
        // per il motivo per cui questo NON e' un allentamento del gate.
        // Stringa VUOTA sul ramo evergreen, non il testo ripulito. Lo strip
        // toglieva il brief dal denominatore del gate di recall — corretto —
        // ma `runFactualityGates` passa lo STESSO `sourceText` anche a
        // `collectInstitutionAcronyms`, e il residuo (712 char misurati) sta
        // sopra `MIN_SOURCE_CHARS_FOR_SUPPORT` (400): `canJudge` restava true
        // e ogni ente dell'articolo passava da `present` ad `absent` — cioe'
        // evidenza bloccante fabbricata dal nulla, l'opposto di quanto
        // dichiara il commento di quella funzione («Reporting 'absent' here
        // would let source-less runs manufacture blocking evidence out of
        // nothing»). Con '' torna `unknown`, che e' l'intento scritto.
        //
        // E un branch sull'URL non ha la fragilita' del match esatto: una
        // sottrazione di stringa diventa un no-op silenzioso il giorno in cui
        // il brief viene iniettato con una trasformazione in mezzo.
        //
        // `stats-bfs://` conserva il gate (quel prompt non nomina il brief).
        // Nessuna soglia toccata: con '' scatta la guardia gia' esistente per
        // fonte troppo sottile.
        sourceText: url.startsWith('evergreen://') ? '' : pageContent,
        sourceDate: lastSourcePublishedAt || undefined,
        publishedAt: new Date().toISOString(),
        memory: defectMemory(),
      });

      // Feed the learning loop. Recorded for EVERY attempt, including the ones
      // that go on to be rejected: an acronym the source does not back up is
      // evidence about the generator regardless of whether that particular
      // draft shipped, and restricting the signal to published articles would
      // make the store blind to exactly the drafts the gates already stop.
      for (const obs of gateResult.observations) {
        if (RUN_REPORT.factuality.institutionObservations.length >= INSTITUTION_OBSERVATION_CAP) break;
        RUN_REPORT.factuality.institutionObservations.push({ ...obs, attempt });
      }

      if (gateResult.issues.length) {
        console.error(`  🔎 Gate deterministici: ${gateResult.issues.length} problemi `
          + `(${gateResult.blocking.length} bloccanti)`);
        console.error(formatIssues(gateResult.issues));
      }

      if (!gateResult.passed) {
        // Rejection-rate-by-cause over time is the loop's primary health
        // metric: a defence that is working shows its code declining, one that
        // has become a false-positive machine shows it climbing while nothing
        // ships. Counting it here is what makes that measurable at all.
        for (const i of gateResult.blocking) {
          RUN_REPORT.factuality.gateRejectionsByCode[i.code] =
            (RUN_REPORT.factuality.gateRejectionsByCode[i.code] || 0) + 1;
        }
        const summary = gateResult.blocking.map((i) => `[${i.code}] ${i.message}`).join('; ');
        const gateErr = new Error(`Articolo rigettato dai gate deterministici: ${summary}`);
        // The wall budget stops new TOPIC attempts, but nothing stopped this
        // inner loop, so a topic whose gates never converge kept issuing full
        // regenerations past the budget until the workflow's `timeout ... 2400s`
        // SIGKILLed the process mid-generation. That loses everything the run
        // learned, including the rejection bookkeeping below — which is why the
        // same doomed keyword came back on the next cron slot and did it again.
        // Run 30784967708 died on attempt 3/6, 40min in, with a 30min budget.
        //
        // Giving up here reaches the normal no-article exit instead: the
        // tracker is persisted, the slot is released, and the next run starts
        // clean. A deferred article costs one slot; a hard kill costs the slot
        // AND repeats forever.
        if (attempt < maxAttempts && wallBudgetExceeded()) {
          console.error(
            `  ⏱️  Budget wall-clock (${Math.round(RUN_WALL_BUDGET_MS / 60000)}min) superato dopo ${attempt}/${maxAttempts} `
            + `tentativi sui gate deterministici — interrompo invece di farmi uccidere dal timeout del workflow.`,
          );
          throw gateErr;
        }
        if (attempt < maxAttempts) {
          // Feed back CORRECTIVE INSTRUCTIONS, not just complaints: every gate
          // issue carries the concrete fix (and the corrected values, where we
          // computed them), so the writer repairs the passage instead of
          // deleting it. Unlike the LLM verifier's issues, each of these is a
          // verified fact about the text, so the feedback cannot mislead.
          lastFactCheckErrors = formatRemediation(gateResult.blocking);
          console.error(`  🔄 Rigenero contenuto IT per gate deterministici (${attempt}/${maxAttempts})...`);
          continue;
        }
        throw gateErr;
      }
    }

    // Step 3a.0c: LLM fact verification — PRIMARY BLOCKING GATE
    try {
      const factResult = await llmFactCheck(data.content.it, pageContent, url);
      if (!factResult.passed) {
        // Ledger only. These categories never reach the defect memory and can
        // never promote anything: they are the verifier's opinion, and the
        // verifier is the component that failed on 2026-07-28. What they DO
        // give us is the only aggregate view under which that failure is
        // visible — see factCheckRejectionsByCategory in RUN_REPORT.
        for (const i of factResult.issues || []) {
          const cat = String(i?.category || 'uncategorized');
          RUN_REPORT.factuality.factCheckRejectionsByCategory[cat] =
            (RUN_REPORT.factuality.factCheckRejectionsByCategory[cat] || 0) + 1;
        }
        const issuesSummary = factResult.issues.map(i => `[${i.category || '?'}] "${(i.claim || '').slice(0, 60)}" — ${(i.reason || '').slice(0, 80)}`).join('; ');
        const err = new Error(`Articolo rigettato da fact-check: ${factResult.issues.length} problemi: ${issuesSummary}`);
        if (attempt < maxAttempts) {
          // Feed the flagged claims into the next attempt's prompt so the model
          // fixes exactly what it invented instead of regenerating blind.
          //
          // Rendered as corrective INSTRUCTIONS rather than a list of
          // complaints (2026-07-28): each verifier category maps to what the
          // writer should actually DO — see REMEDIATION_BY_CATEGORY. A bare
          // "non presente nella fonte" invites deletion, which is how that
          // day's article shed every real fact it had while keeping the
          // invented ones. formatRemediation() also states the standing rule,
          // "correggi, non cancellare".
          //
          // The cap is retained (issues are already the blocking subset,
          // severity-ordered by llmFactCheck): a long violation list would
          // bloat an already-large prompt past the input window of the degraded
          // free models this path targets (adversarial review PR #2615).
          // formatRemediation() reports the overflow instead of dropping the
          // tail silently.
          const FACTCHECK_FEEDBACK_CAP = 8;
          lastFactCheckErrors = formatRemediation(factResult.issues, { cap: FACTCHECK_FEEDBACK_CAP });
          console.error(`  🔄 Rigenero contenuto IT per fact-check fallito (${attempt}/${maxAttempts})...`);
          continue;
        }
        throw err;
      }
      // NOTE: there is deliberately no `if (factResult.unverified)` branch here
      // any more. Since the verifier fails CLOSED (2026-07-28), `unverified`
      // only ever comes back paired with `passed: false`, which the branch above
      // has already turned into a retry or a throw — so a published article can
      // never be unverified, and a RUN_REPORT flag saying otherwise would be
      // permanently false and misleading. The outage is recorded on the failure
      // path instead (see the `🚫` log in llmFactCheck).
    } catch (fcErr) {
      // Both fact-check rejections AND all-models-failed errors retry
      if (attempt < maxAttempts) {
        console.error(`  🔄 Rigenero per fact-check: ${fcErr.message.slice(0, 120)} (${attempt}/${maxAttempts})...`);
        continue;
      }
      throw fcErr;
    }

    const itWords = italianBodyWordCount(data);
    lastWordCount = itWords;
    if (itWords >= adaptiveMinWords) {
      // ── Repetition check INSIDE the loop — triggers retry if AI looped ──
      const itContentLoop = data.content.it || data.content;
      const { hasRepetition, reason: repetitionReason } = detectBodyRepetition(itContentLoop);

      if (hasRepetition) {
        console.error(`  ⚠️  AI loop rilevato: ${repetitionReason} — rigenero (${attempt}/${maxAttempts})...`);
        if (attempt < maxAttempts) continue;
        // Last attempt: auto-strip duplicate paragraphs as fallback
        console.error(`  🔧 Ultimo tentativo: auto-deduplica paragrafi ripetuti...`);
        dedupeRepeatedParagraphs(itContentLoop);
        console.error(`  ✅ Auto-deduplica completata`);
        break;
      }

      stripDuplicateTitleFromBody(itContentLoop);

      console.error(`  ✅ Soglia parole IT raggiunta: ${itWords} (min ${adaptiveMinWords}), nessun loop AI`);
      break;
    }
    if (attempt < maxAttempts) {
      console.error(`  ⚠️  Contenuto IT troppo corto: ${itWords} parole (min ${adaptiveMinWords}) — rigenero (${attempt}/${maxAttempts})...`);
      continue;
    }
    // ── Last resort: expand existing short content instead of failing ──
    console.error(`  🔧 Ultimo tentativo: espansione contenuto esistente (${itWords} → min ${adaptiveMinWords})...`);
    try {
      // Snapshot the pre-expansion draft: it already cleared runFactualityGates
      // and llmFactCheck earlier in THIS SAME attempt (Step 3a.0b-bis / 3a.0c
      // above) — it's short, not wrong. If expansion below fails the
      // deterministic gate, this is what we fall back to instead of shipping
      // the fabricated version (#156). Cloned inside the try (#163) so a
      // future non-serializable field on `data` degrades to `shortErr` like
      // every other failure on this path, instead of escaping uncaught.
      const preExpansionData = structuredClone(data);
      data = await expandShortItalianContent(data, adaptiveMinWords, { boundToText: isStatsBfsSource });

      // Re-run the SAME repetition check the main loop uses above — this
      // expansion call is the path MOST likely to produce it (see
      // detectBodyRepetition's doc comment). Before this fix, runaway
      // repeats from this specific path shipped straight to the live site
      // uncaught (incident 2026-07-21: swatch-crescita-2026,
      // novartis-superaspettative).
      const expandedItContent = data.content.it || data.content;
      const { hasRepetition: expandHasRepetition, reason: expandRepetitionReason } = detectBodyRepetition(expandedItContent);
      if (expandHasRepetition) {
        console.error(`  ⚠️  AI loop rilevato dopo espansione: ${expandRepetitionReason} — auto-deduplica...`);
        dedupeRepeatedParagraphs(expandedItContent);
      }
      stripDuplicateTitleFromBody(expandedItContent);

      // #156: expansion is a fresh LLM generation like any other attempt in
      // this loop, and CLAUDE.md rule #1 carves no "last resort" exception.
      // Re-run the SAME deterministic gates Step 3a.0b-bis enforces above —
      // free, no model calls, and this is exactly the check that would have
      // caught the shipped per-comune frontaliere counts and tax figures
      // invented for a closed bfs_stats source. Unlike a mid-loop retry there
      // is no further attempt to fall back to, so a gate failure here reverts
      // to the pre-expansion draft rather than publish unchecked content.
      const expandGateResult = runFactualityGates({
        sections: {
          body1: data.content.it?.body1 || '',
          body2: data.content.it?.body2 || '',
          body3: data.content.it?.body3 || '',
        },
        sourceText: url.startsWith('evergreen://') ? '' : pageContent,
        sourceDate: lastSourcePublishedAt || undefined,
        publishedAt: new Date().toISOString(),
        memory: defectMemory(),
      });

      // Feed the learning loop, same as Step 3a.0b-bis above (#163): this is
      // the expansion path that caused #156, so leaving it unfed makes the
      // riskiest branch invisible to article-defect-memory.json.
      for (const obs of expandGateResult.observations) {
        if (RUN_REPORT.factuality.institutionObservations.length >= INSTITUTION_OBSERVATION_CAP) break;
        RUN_REPORT.factuality.institutionObservations.push({ ...obs, attempt });
      }

      if (!expandGateResult.passed) {
        for (const i of expandGateResult.blocking) {
          RUN_REPORT.factuality.gateRejectionsByCode[i.code] =
            (RUN_REPORT.factuality.gateRejectionsByCode[i.code] || 0) + 1;
        }
        const summary = expandGateResult.blocking.map((i) => `[${i.code}] ${i.message}`).join('; ');
        console.error(`  🚫 Espansione rigettata dai gate deterministici: ${summary}`);
        console.error(`  ↩️  Torno al testo pre-espansione (già approvato dai gate, ma corto)...`);
        data = preExpansionData;
      }

      const expandedWords = italianBodyWordCount(data);
      if (expandedWords >= adaptiveMinWords) {
        console.error(`  ✅ Espansione riuscita: ${expandedWords} parole (min ${adaptiveMinWords})`);
        break;
      }
      console.error(`  ⚠️  Espansione insufficiente: ${expandedWords} parole — fallback accettato`);
      // Accept the expanded content even if still slightly short (better than failing)
      if (expandedWords >= adaptiveMinWords * 0.85) {
        console.error(`  ✅ Contenuto accettato (≥85% soglia): ${expandedWords} parole`);
        break;
      }
    } catch (expandErr) {
      console.error(`  ⚠️  Espansione fallita: ${expandErr.message}`);
    }
    {
      const shortErr = new Error(`Contenuto IT troppo corto dopo ${maxAttempts} tentativi + espansione (${italianBodyWordCount(data)}/${adaptiveMinWords} parole).`);
      // Per-headline quality failure → headline retry loops skip this source
      // and try the next one instead of aborting the run (auto-heal).
      shortErr.qualityReject = true;
      throw shortErr;
    }
  }

  // Final thin content guard (after retry/expand attempts)
  {
    const itBodyFinal = `${(data.content.it || data.content)?.body1 || ''} ${(data.content.it || data.content)?.body2 || ''} ${(data.content.it || data.content)?.body3 || ''}`;
    const itPlainCharsFinal = itBodyFinal.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().length;
    const adaptiveMinChars = computeAdaptiveMinChars(lengthBudgetSource);
    if (itPlainCharsFinal < adaptiveMinChars) {
      const thinErr = new Error(`Articolo troppo corto dopo retry: ${itPlainCharsFinal} chars (min: ${adaptiveMinChars}). Google penalizza thin content.`);
      thinErr.qualityReject = true;
      throw thinErr;
    }
    console.error(`  ✅ [thin-content] Body finale: ${itPlainCharsFinal} chars (min: ${adaptiveMinChars})`);
  }

    // Step 3a.0b: Strip leaked internal URLs from IT
  for (const field of ['body1', 'body2', 'body3']) {
    if (data.content.it?.[field]) {
      const before = data.content.it[field];
      data.content.it[field] = before.replace(/\n*📅[^\n]*evergreen:\/\/[^\n]*/g, '');
      if (before !== data.content.it[field]) {
        console.error(`  🧹 Rimosso URL interno da it.${field}`);
      }
    }
  }

  // Step 3a.2: Check for duplicates BEFORE translating (saves 3 API calls on duplicates)
  console.error('🔍 Verifica duplicati:');
  checkForDuplicates(data);
  // Step 3a.3: Semantic near-duplicate gate — catches same-story/different-
  // vocabulary dupes the lexical Jaccard above cannot see (cosine ≥ ceiling).
  // Section-keyed embedding store so svizzera dedups against ITS OWN corpus,
  // never against frontaliere. For frontaliere these paths equal the module
  // defaults → behavior is unchanged. Store/meta absent (e.g. svizzera not yet
  // built) → the gate degrades to a no-op (fail-open).
  await checkSemanticNearDuplicate(data, {
    store: loadEmbeddingStore({ binPath: SECTION.embeddingsBinPath }),
    meta: loadEmbeddingMeta({ metaPath: SECTION.embeddingsMetaPath }),
  });
  // Step 3a.4: «argomento già coperto» — l'unico gate che NON misura una
  // distanza lessicale. I due sopra confrontano quanto si somigliano due
  // testi; questo confronta DI COSA parlano. È la differenza che ha lasciato
  // passare le tre guide-piastrellista del 2026-08-09 (combinato 0.278 contro
  // una soglia di 0.55, con il solo token `piastrell` in comune su sette) e,
  // dal 2026-08-10, le 33 coppie di guide-comune e le 14 coppie
  // (pilastro × cantone) che la chiave generalizzata intercetta.
  // Sta qui, dopo checkForDuplicates, perché questo è il punto obbligato di
  // OGNI percorso di generazione — news, evergreen, discovery — mentre il
  // pre-flight evergreen vede solo i candidati evergreen.
  assertTopicNotRecentlyCovered(data, loadExistingArticleSummariesWithDates());

  // Step 3b: Translate to EN/DE/FR (only runs if not a duplicate)
  await translateArticle(data);

  // Step 3b.1: Fabricated-institution check on the EN/DE/FR translations —
  // BLOCKING. assertNoFabricatedReferences() (Step 3a.0b, above) only ever
  // sees contentIt (called before translateArticle() exists), so a
  // translation that independently hallucinates this institution in a
  // different language was never checked at all.
  assertNoFabricatedLaborOfficeCrossLocale(data);

  // Step 3c: Sanitize bold + URLs + nav links on translated content
  console.error('✂️  Sanitizzazione grassetto (traduzioni):');
  sanitizeBoldFormatting(data);
  for (const locale of ['en', 'de', 'fr']) {
    for (const field of ['body1', 'body2', 'body3']) {
      if (data.content[locale]?.[field]) {
        let text = data.content[locale][field];
        // Strip leaked evergreen:// URLs
        text = text.replace(/\n*📅[^\n]*evergreen:\/\/[^\n]*/g, '');
        // Remove raw <a> tags
        text = text.replace(/<a\s+href="[^"]*"[^>]*>(.*?)<\/a>/gi, '$1');
        // Validate nav: links
        text = text.replace(/\[([^\]]+)\]\(nav:([a-z-]+)\)/g, (_m, linkText, action) => {
          const VALID_NAV_ACTIONS = new Set([
            'calculator', 'exchange', 'health', 'cost-of-living', 'pension', 'pillar3',
            'payslip', 'tax-return', 'residency', 'ristorni', 'unemployment', 'jobs', 'companies', 'banks',
            'first-day', 'permits', 'border', 'calendar', 'whatif', 'shopping', 'transport',
            'salary-compare', 'traffic-history',
            'border-map', 'municipalities', 'car-transfer', 'car-cost', 'permit-compare', 'renovation',
            'mobile', 'ral', 'parental-leave', 'nursery', 'living-ch', 'living-it', 'livability',
          ]);
          if (VALID_NAV_ACTIONS.has(action)) return _m;
          console.error(`  ⚠️  Link invalido [${linkText}](nav:${action}) in ${locale}.${field} — rimosso`);
          return linkText;
        });
        if (text !== data.content[locale][field]) data.content[locale][field] = text;
      }
    }
  }

  // Step 3d: Enforce CTA / internal links (all 4 locales)
  console.error('🔗 Verifica CTA e link interni:');
  validateAndEnforceCTA(data);
  enforceStrongInternalLinks(data);

  // Step 3e: Append source citation to body3 (E-E-A-T compliance)
  // For stats-bfs:// articles, the URL is a synthetic per-quarter dedup key
  // — the human-readable citation must point to the public BFS landing page.
  const citationUrl = url.startsWith('stats-bfs://')
    ? 'https://www.bfs.admin.ch/bfs/it/home/statistiche/industria-servizi.html'
    : url;
  if (citationUrl && !citationUrl.startsWith('evergreen://')) {
    try {
      const sourceDomain = new URL(citationUrl).hostname.replace(/^www\./, '');
      const SOURCE_LABEL = { it: 'Fonte', en: 'Source', de: 'Quelle', fr: 'Source' };
      for (const locale of ['it', 'en', 'de', 'fr']) {
        if (!data.content[locale]?.body3) continue;
        const label = SOURCE_LABEL[locale] || 'Source';
        // Only append if not already present
        if (!data.content[locale].body3.includes(sourceDomain)) {
          data.content[locale].body3 += `\n\n*${label}: [${sourceDomain}](${citationUrl})*`;
        }
      }
      console.error(`  📰 Citazione fonte aggiunta: ${sourceDomain}`);
    } catch { /* invalid URL — skip */ }
  }

  console.error(`\n📝 Articolo generato: "${data.content.it.title}"`);
  console.error(`   ID: ${data.id}`);
  console.error(`   Categoria: ${data.category}`);
  console.error(`   Slug IT: ${data.slugs.it}`);
  console.error('');

  // Step 3a.1: Reject/repair prompt-schema placeholders leaked into any
  // published field (title/excerpt/body1-3/imageAlt/seo.*), same guard
  // registerArticleFiles() runs for the four secondary producers. This IS
  // the primary flow's write path — it writes files directly below
  // (modifyRouterTs/modifyBlogArticlesTsx) and never calls
  // registerArticleFiles(), so without this call a placeholder leaking here
  // (e.g. via translateArticle() echoing the schema into en/de/fr) shipped
  // unguarded. After translateArticle() so it also sees translation-introduced
  // leaks, before image generation so a doomed article doesn't spend an image
  // call first. Tagged qualityReject like every other throw in this function:
  // a placeholder is a per-headline generation failure, not an infra error —
  // the retry loop should rotate to the next headline, not crash the run.
  try {
    sanitizePromptPlaceholders(data);
  } catch (e) {
    e.qualityReject = true;
    throw e;
  }

  // Step 3b: Generate article image via Gemini native image generation
  console.error('🎨 Generazione immagine articolo:');
  const imagePath = await generateArticleImage(data);
  if (imagePath) {
    data._generatedImagePath = imagePath;
    console.error(`  ✅ Immagine generata: ${imagePath}`);
  } else {
    // Try keyword-based matching before falling back to AI-picked place image
    const matched = findBestFallbackImage(data);
    if (matched) {
      data._generatedImagePath = matched;
      console.error(`  ⚠️ Imagen non disponibile, uso match per keyword: ${matched}`);
    } else {
      console.error(`  ⚠️ Imagen non disponibile, uso immagine di fallback: /images/places/${data.image}`);
    }
  }

  // Step 4: Modify files
  console.error('\n📂 Modifica file sorgente:');
  modifyRouterTs(data);
  modifyBlogArticlesTsx(data);
  modifyI18nTs(data);
  modifyLocaleFile(data, 'en');
  modifyLocaleFile(data, 'de');
  modifyLocaleFile(data, 'fr');
  modifySeoService(data);
  modifySitemap(data);
  modifySitemapNews(data);

  // Step 4a.2: RSS feeds — NOT regenerated here any more (issue #4974 item 2).
  //
  // Same move the sitemaps made in #4976, for the same reason: the feeds are
  // derived from the corpus, the corpus repo publishes them
  // (packages/articles/engine/rssFeeds.mjs, the module this script used to run
  // in-tree), and scripts/pull-articles-api.mjs pulls them. Two producers
  // writing the same ten files meant the last writer won.
  //
  // Latency is covered: the mirror dispatch at the end of generate-article.yml
  // pushes the corpus, the publisher republishes, and its repository_dispatch
  // wakes sync-articles-sitemaps — no waiting for a scheduled slot.

  // Step 4b: Validate structured data (simulates ogPagesPlugin extraction)
  console.error('\n🔍 Validazione dati strutturati:');
  validateStructuredData(data);

  // Track source-domain weekly quotas only on successful article generation.
  // Stats-bfs:// is editorial-internal — bucket it under 'bfs.admin.ch' so the
  // weekly quota system sees the BFS data updates as a real source.
  const sourceDomain = normalizeSourceDomain(
    sourceContext?.source
      || (url.startsWith('evergreen://') ? 'evergreen'
          : url.startsWith('stats-bfs://') ? 'bfs.admin.ch'
          : new URL(url).hostname),
  );
  if (SOURCE_QUOTA_ENABLED && sourceDomain && sourceDomain !== 'evergreen') {
    incrementWeeklySourceCount(sourceDomain);
  }

  // Track source URL for future duplicate prevention
  recordSourceUrl(url, data.id);

  // Step 5: Git add
  console.error('\n📦 Staging file:');
  gitAddAll(data);

  console.error('\n✅ Articolo creato! I test verificheranno la correttezza.');
  console.error(`   Titolo: ${data.content.it.title}`);
  console.error(`   URL: ${BASE_URL}/${SECTION.hubSlug.it}/${data.id}/`);
  RUN_REPORT.article.id = data.id;
  RUN_REPORT.article.url = `${BASE_URL}/${SECTION.hubSlug.it}/${data.id}/`;
  RUN_REPORT.article.sourceDomain = sourceDomain || null;
  RUN_REPORT.article.title = data.content?.it?.title || null;
  RUN_REPORT.article.authorSlug = data.author?.slug || null;
  RUN_REPORT.article.authorName = data.author?.name || null;
  RUN_REPORT.article.factCheckUnverified = RUN_REPORT.factCheckUnverified || false;

  // Write GitHub Actions outputs for downstream steps (Facebook posting, etc.)
  // Always use data.id (not data.slugs.it) — the router key is the article ID.
  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    const { appendFileSync } = await import('fs');
    // ALWAYS emit article_url with trailing slash. Without it, GitHub Pages serves
    // the flat redirect bridge (dist/<path>.html) — 643 bytes of <script>location.replace</script>
    // with no OG meta tags. The wait-script and Facebook crawler can't follow JS
    // redirects, so og:title appears missing and the deploy times out (run #25033670793).
    // The with-slash URL serves the proper index.html (~22 KB) with full OG metadata.
    const articleUrlRaw = `${BASE_URL}/${SECTION.hubSlug.it}/${data.id}`;
    const articleUrl = articleUrlRaw.endsWith('/') ? articleUrlRaw : `${articleUrlRaw}/`;
    const ogImagePath = data._generatedImagePath
      ? data._generatedImagePath.replace(/^\//, '')
      : `images/places/${data.image}`;
    appendFileSync(ghOutput, `article_id=${data.id}\n`);
    appendFileSync(ghOutput, `article_url=${articleUrl}\n`);
    // Section this article belongs to — drives section-aware verify + indexing
    // in generate-article.yml (svizzera writes a different registry / URL space).
    appendFileSync(ghOutput, `section=${SECTION_NAME}\n`);
    appendFileSync(ghOutput, `source_url=${url}\n`);
    appendFileSync(ghOutput, `og_title=${data.seo.ogTitle}\n`);
    appendFileSync(ghOutput, `og_description=${data.seo.ogDescription}\n`);
    appendFileSync(ghOutput, `og_image=${BASE_URL}/${ogImagePath}\n`);
    appendFileSync(ghOutput, `category=${data.category}\n`);
    // Author byline metadata (A2): used by the commit step to write a
    // descriptive `feat(article): <title>` message + Reviewed-by trailer.
    if (data.author?.slug) {
      appendFileSync(ghOutput, `author_slug=${data.author.slug}\n`);
    }
    if (data.author?.name) {
      // Strip newlines defensively — author names should never contain them.
      appendFileSync(ghOutput, `author_name=${String(data.author.name).replace(/\r?\n/g, ' ')}\n`);
    }
    if (data.content?.it?.title) {
      // Single-line title for commit subject. Strip newlines.
      appendFileSync(ghOutput, `article_title=${String(data.content.it.title).replace(/\r?\n/g, ' ')}\n`);
    }
    appendFileSync(ghOutput, `create_article_report=${CREATE_ARTICLE_REPORT_FILE}\n`);
    console.error('   📤 GitHub Actions outputs written');
  }

  // Log AI model stats & scoreboard
  const aiStats = getAiStats();
  console.error(`\n\ud83e\udd16 AI Model Stats: ${aiStats.calls} calls, ${aiStats.successes} successes, ${aiStats.retries} retries, ${aiStats.fallbacks} fallbacks`);
  if (aiStats.scoreBoard.length > 0) {
    console.error('\ud83d\udcca Model Scoreboard (top 5):');
    aiStats.scoreBoard.slice(0, 5).forEach(({ model, score }, i) =>
      console.error(`   ${i + 1}. ${model}: ${score >= 0 ? '+' : ''}${score}`)
    );
  }
  // FRO-325: full run summary (cache hits, exhausted models, cooldowns,
  // 429 streaks, error count) — superset of the calls/successes/retries
  // line above, not tracked anywhere else in this script (#3091).
  printRunSummary();

  finalizeRunReport('generated');
}

/** Strip a string down to a URL-safe slug segment: lowercase, diacritics
 * stripped (NFD-decompose + drop combining marks), non-alphanumerics
 * collapsed to single hyphens, 80-char cap. Same normalization used
 * throughout this file's own (unexported, inline) slug handling. */
function slugifySlugPart(input) {
  return String(input || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

/**
 * ── PROMPT-PLACEHOLDER SLUG GUARD ──────────────────────────────────────────
 *
 * The JSON schema shown to the model spells the two URL-bearing fields with
 * literal example values:
 *
 *   "id": "kebab-case-3-5-words-max-40-chars",
 *   "slugs": { "it": "slug-it", "en": "slug-en", "de": "slug-de", "fr": "slug-fr" },
 *
 * A model that runs out of attention echoes them back instead of replacing
 * them — either verbatim (`slug-en`), or with the placeholder glued onto a
 * real slug (`slug-gaggiolo-traffic`, `kebab-case-turismo-ticino`). Nothing
 * downstream noticed: `slugifySlugPart()` sees a perfectly well-formed
 * lowercase-ASCII-hyphen token and passes it through unchanged, and the
 * sanitizer in `validate()` only ever stripped the `kebab-case-` prefix — the
 * `slug-` family was never covered.
 *
 * MEASURED 2026-08-09 on the published `slugs.json`: 24 live slugs across 8
 * articles, all answering 200 and all listed in `sitemap-blog.xml` /
 * `sitemap-blog-ch.xml` (hence in each other's hreflang sets). Four more had
 * already reached production through the `id` in the earlier round of the same
 * defect (`kebab-case-3-5-words-max-40-chars`, `kebab-case-turismo-ticino`,
 * `kebab-case-ticino-nubifragio-grigioni`, `kebab-case-rossi-bruxelles-ticino`).
 * A published URL is the one part of an article that cannot be corrected later
 * without a redirect the shard renderer has no mechanism for.
 *
 * WHY A PREFIX MATCH AND NOT AN EXACT LIST. Two reasons, both measured.
 *
 * Half the live offenders are not the placeholder: they are the placeholder
 * with real content glued to it (`slug-gaggiolo-traffic`,
 * `slug-terzo-pilastro-3a-schweiz`), which an exact-match list cannot see.
 *
 * And the placeholder does not survive as a literal. `slug-inglese` /
 * `slug-tedesco` / `slug-francese` are NOT in the prompt — the schema says
 * `slug-en` / `slug-de` / `slug-fr`. The surrounding prompt is written in
 * Italian, so the model translates the placeholder's MEANING ("lo slug in
 * inglese") and hands back a token that never appeared in its input. That is
 * not a historical artifact: `terzo-pilastro-3a-svizzero-vantaggi-2026-canton-basilea`
 * was generated on 2026-08-09 and carries all three. A list of the four
 * literals now in the prompt would not have caught a single one of them.
 * What is stable across every wording and every language is the SHAPE: the
 * schema names the field inside the value.
 *
 * The asymmetry of the cost decides the aggressiveness: a false positive costs
 * a slightly different slug on an article that is not published yet, a false
 * negative costs a permanent public URL. The aggressiveness is measured, not
 * assumed: `generator/tests/slug-placeholder-guard.test.mjs` runs this
 * classifier over the whole live registry — 15.172 slugs — and asserts that
 * the only 28 it flags are the 28 already published, and that the other 15.144
 * come through untouched.
 */
const PROMPT_SLUG_PREFIX_RX = /^(?:slug|kebab[-_]?case)[-_]+/i;

/**
 * What is left after the prefix is stripped, when the remainder is still part
 * of the schema hint rather than article content. `it|en|de|fr` covers
 * `slug-en`; the Italian/English language NAMES cover the translated variants
 * the model invents from an Italian prompt (`slug-inglese`, `slug-tedesco`,
 * `slug-francese`); the numeric shapes cover
 * `kebab-case-3-5-words-max-40-chars`; the rest are the generic values models
 * substitute when they have nothing to say.
 */
const NON_SLUG_REMAINDER_RX =
  /^(?:it|en|de|fr|ita|eng|ger|deu|fra|italiano|inglese|tedesco|francese|italian|english|german|french|slug|placeholder|segnaposto|example|esempio|sample|test|todo|tbd|na|n-a|none|null|undefined|xxx|titolo|title|articolo|article)$/i;

/** `3-5-words-max-40-chars`, `max-40-chars`, `40-chars`, `3-5-words`… */
const SCHEMA_HINT_SHAPE_RX = /(?:^|-)(?:\d+-\d+-words|max-\d+-chars|\d+-chars|\d+-words)(?:-|$)/i;

/**
 * Classify one slug candidate against the prompt schema.
 *
 * @param {unknown} input raw slug (already sanitized or not — this normalizes)
 * @returns {{ slug: string, leaked: boolean, recovered: boolean }}
 *   `leaked`   — the value is, or starts with, a schema placeholder.
 *   `slug`     — the usable remainder, `''` when nothing survives.
 *   `recovered`— `leaked` and a usable remainder was salvaged from it.
 */
export function inspectSlugForPromptPlaceholder(input) {
  const normalized = slugifySlugPart(input);
  if (!normalized) return { slug: '', leaked: false, recovered: false };

  // A value that IS a placeholder, with no prefix to strip (`undefined`,
  // `placeholder`, a bare `slug`, `3-5-words-max-40-chars`).
  if (NON_SLUG_REMAINDER_RX.test(normalized) || SCHEMA_HINT_SHAPE_RX.test(normalized)) {
    return { slug: '', leaked: true, recovered: false };
  }
  if (!PROMPT_SLUG_PREFIX_RX.test(normalized)) {
    return { slug: normalized, leaked: false, recovered: false };
  }

  // Strip repeatedly: `slug-kebab-case-x` and `slug-slug-en` both occur.
  let remainder = normalized;
  for (let i = 0; i < 4 && PROMPT_SLUG_PREFIX_RX.test(remainder); i += 1) {
    remainder = remainder.replace(PROMPT_SLUG_PREFIX_RX, '');
  }
  const usable =
    remainder.length >= 4 &&
    !NON_SLUG_REMAINDER_RX.test(remainder) &&
    !SCHEMA_HINT_SHAPE_RX.test(remainder);
  return { slug: usable ? remainder : '', leaked: true, recovered: usable };
}

/**
 * Derive and sanitize the final per-locale slugs for an article: the Italian
 * slug is always locked to `data.id` (routing convention — see `validate()`'s
 * own `data.slugs.it = data.id`), and any en/de/fr slug the caller hasn't
 * already set falls back to a slugified translated title (or the IT slug).
 * Every locale slug is then sanitized so accented/non-ASCII characters never
 * reach router/sitemap URLs.
 *
 * This is the single source of truth `registerArticleFiles()` uses so
 * callers (e.g. scripts/publish-journalist-article.mjs) don't need their own
 * copy of this derivation — a duplicate copy would drift from this one as it
 * evolves, producing wrong canonicals / 404s for the locales derived
 * elsewhere (issue #3209 item 1).
 *
 * Mutates `data.slugs` in place AND returns it so callers can consume the
 * exposed final value instead of re-deriving their own.
 *
 * ── PLACEHOLDER ENFORCEMENT, AND WHY IT LIVES HERE ────────────────────────
 *
 * `validate()` already screens the AI flow's output, but `validate()` is ONE
 * producer. `generate-daily-brief-article.mjs`, `generate-events-digest-article.mjs`,
 * `generate-border-wait-ranking-article.mjs` and `publish-journalist-article.mjs`
 * all import `registerArticleFiles` directly and never pass through it — the
 * exact shape of the 2026-08-09 meta-description incident (a rule enforced in
 * one producer instead of at the write path they share, see
 * `clampSeoDescriptions`). This function is that shared write path: it runs
 * inside `registerArticleFiles()` before the first file is touched.
 *
 * TWO DIFFERENT ANSWERS, on purpose:
 *
 *  · en/de/fr → DETERMINISTIC RECOVERY, loud. The slug is recovered from the
 *    placeholder's own remainder when there is one (`slug-gaggiolo-traffic` →
 *    `gaggiolo-traffic` — the model did produce a real slug, it just kept the
 *    label), then from the translated title, then from the IT slug. All three
 *    are correct URLs; falling back to the IT slug across locales never
 *    collides, because the locale prefix and the hub segment already differ
 *    (`/en/cross-border-articles/x/` vs `/articoli-frontaliere/x/`). Rejecting
 *    the article instead would throw away a good, fact-checked, translated
 *    piece over a label on one of twelve fields — the same trade-off already
 *    argued at the `id` guard in `validate()`.
 *
 *  · id / IT slug → THROW. The id is not just a URL: it is the registry key,
 *    the body filename and the hreflang anchor, and `registerArticleFiles()`
 *    has ALREADY run `checkArticleIdExists(data.id)` by the time we get here.
 *    Rewriting it at this point would publish the article under an id nobody
 *    checked for collisions. There is a correct place to recover it — the
 *    `PROMPT_ID_LEAK_RX` branch in `validate()`, which rebuilds it from the
 *    Italian title and can retry the whole generation — so reaching this
 *    function with a leaked id means a producer bypassed that path, which is a
 *    bug to surface, not to paper over.
 *
 * @param {object} data
 * @returns {Record<string, string>} the finalized `data.slugs` map
 */
export function deriveAndSanitizeArticleSlugs(data) {
  data.slugs = data.slugs && typeof data.slugs === 'object' ? data.slugs : {};

  const idCheck = inspectSlugForPromptPlaceholder(data.id);
  if (idCheck.leaked) {
    throw new Error(
      `[slug-placeholder] l'id "${data.id}" e' un segnaposto del prompt (o ne conserva il prefisso). ` +
        "L'id e' la chiave del registro, il nome del file body e lo slug italiano, e checkArticleIdExists() " +
        'e\' gia\' stato eseguito su questo valore: correggerlo qui pubblicherebbe l\'articolo sotto un id ' +
        `mai controllato per collisioni. Va corretto a monte — validate() lo ricostruisce dal titolo IT ` +
        `("${data.content?.it?.title || ''}") — oppure dal produttore che lo ha passato.`,
    );
  }

  data.slugs.it = data.id;
  for (const locale of ['en', 'de', 'fr']) {
    if (!data.slugs[locale]) {
      const title = String(data.content?.[locale]?.title || data.content?.it?.title || '');
      const fallback = title ? slugifySlugPart(title) : data.slugs.it;
      data.slugs[locale] = fallback || data.slugs.it;
      continue;
    }
    const raw = String(data.slugs[locale]);
    const check = inspectSlugForPromptPlaceholder(raw);
    if (!check.leaked) {
      data.slugs[locale] = check.slug || data.slugs.it;
      continue;
    }
    const title = String(data.content?.[locale]?.title || '');
    const fromTitle = title ? slugifySlugPart(title) : '';
    const replacement = check.slug || fromTitle || data.slugs.it;
    const source = check.slug ? 'resto del segnaposto' : fromTitle ? `titolo ${locale}` : 'slug IT';
    console.error(
      `❌ [slug-placeholder] lo slug ${locale} e' un segnaposto del prompt: "${raw}" → "${replacement}" (da: ${source}). ` +
        'Il modello ha ricopiato lo schema invece di compilarlo — se ricorre, e\' il prompt a dover cambiare, ' +
        'non questa rete di sicurezza.',
    );
    data.slugs[locale] = replacement;
  }
  return data.slugs;
}

/**
 * Final published URL per locale for an already-slugged article, following
 * the same `${prefix}/${hub[locale]}/${slug}/` convention router.ts's
 * buildPath() uses for the blog route (IT has no locale prefix; en/de/fr
 * are `/en`/`/de`/`/fr` — see buildSectionSitemapUrls() above for the
 * identical hreflang-link construction). Single source of truth so callers
 * (e.g. scripts/publish-journalist-article.mjs) can't hand-roll their own
 * copy and silently drop the locale prefix (issue #3209 item 1 — the
 * removed duplicate in publish-journalist-article.mjs did exactly that,
 * producing wrong /en //de //fr links in the "your article is live" email).
 *
 * @param {object} data — requires data.slugs already finalized
 * @returns {Record<string, string>}
 */
export function buildArticlePublishedUrls(data) {
  const hub = SECTION.hubSlug;
  const out = {};
  for (const locale of ['it', 'en', 'de', 'fr']) {
    if (!data.slugs[locale]) continue;
    const prefix = locale === 'it' ? '' : `/${locale}`;
    out[locale] = `${BASE_URL}${prefix}/${hub[locale]}/${data.slugs[locale]}/`;
  }
  return out;
}

/**
 * Reuse the article registration pipeline from another script (e.g. the events
 * weekend-digest generator or the journalist publish pipeline) WITHOUT going
 * through the AI generation path. Takes a fully-built `data` object (same
 * shape the AI path produces) and writes every registration file: slug map +
 * router union, ARTICLES registry, i18n meta (it/en/de/fr), body files, blog
 * SEO + JSON-LD, sitemaps, then regenerates RSS.
 *
 * Registration is APPEND-ONLY (no upsert): it throws if `data.id` already exists,
 * so callers refreshing an evergreen article must rewrite only the body files
 * (see `buildBodyFile`) instead of re-registering.
 *
 * Derives/sanitizes `data.slugs` via `deriveAndSanitizeArticleSlugs()` before
 * writing anything, so callers may pass partially-populated slugs (or none
 * beyond `it`) and consume the finalized value from the return (issue #3209
 * item 1) instead of re-implementing the derivation themselves. Also returns
 * `publishedUrls` (via `buildArticlePublishedUrls()`) so callers don't
 * re-derive final URLs with their own (drift-prone) locale-prefix logic.
 *
 * @param {object} data
 * @param {{ skipRss?: boolean, skipNews?: boolean }} [opts]
 * @returns {Promise<{ slugs: Record<string, string>, publishedUrls: Record<string, string> }>}
 */
/**
 * Budget for `seo.description` / `seo.ogDescription`.
 *
 * The site's `tests/seo-description-length.test.ts` hard-fails above 170; 160
 * keeps a margin and matches what the AI flow here already enforced before this
 * became a shared rule.
 */
const SEO_DESCRIPTION_MAX = 160;

/**
 * The SOCIAL budget, deliberately looser than the SERP one.
 *
 * `ogDescription` never reaches a Google snippet: it reaches Facebook,
 * LinkedIn and WhatsApp, which render far more than 160 characters. Capping it
 * at the SERP value threw away useful text for no reason — and, worse, it made
 * the two fields indistinguishable, which is the shape that let one string
 * serve three surfaces in the first place (#79).
 *
 * 250 is a real ceiling, not a formality: the OG card does eventually clip, and
 * `content/seo/**` entries are scanned against it by seo-description-cap.test.mjs.
 */
const SEO_OG_DESCRIPTION_MAX = 250;

/**
 * Hard cap on the meta descriptions, applied at the SHARED write path.
 *
 * The corpus this repo publishes is mirrored into the site's
 * `packages/articles/content/`, where `tests/seo-description-length.test.ts`
 * fails the whole repo when any entry exceeds 170 characters — on every branch,
 * not just the one that met it. The cap existed here too, as
 * `truncateAtWordBoundary(desc, 160)`, but it lived inside the AI flow's own
 * enrichment step, so only articles created through `main()` ever got it.
 *
 * `generate-daily-brief-article.mjs` imports `registerArticleFiles` directly and
 * never passes through that step, so the 2026-08-09 edition registered a
 * 265-char description and turned the site's `tests` job red everywhere. The
 * defect is not the one edition: it is a rule enforced in one producer instead
 * of at the choke point they all share. This is the port of the site's fix
 * (valerielinc-ops#5360) to this repo's fork of the generator.
 *
 * 160, not 170: the same value the AI flow already used, leaving headroom under
 * the test's hard bound. Word-boundary truncation, never a mid-word cut.
 *
 * TWO THRESHOLDS, not one. `description` is the SERP snippet and also the
 * source of `structuredData.description` in the SEO entry, so both live under
 * SEO_DESCRIPTION_MAX. `ogDescription` is the social card and gets
 * SEO_OG_DESCRIPTION_MAX. Sharing one threshold silently truncated a social
 * text that had every right to be longer.
 *
 * This is a SAFETY NET, not the mechanism. A producer whose text arrives here
 * needing a cut has a copy bug: the daily brief now writes three fields sized
 * for their own surfaces (see `daily-brief-content.mjs`), and this must never
 * fire on it. It stays because the AI flow can still hand over anything.
 *
 * Idempotent — a description already within budget comes back unchanged, so the
 * AI flow clamping earlier and this clamping again is a no-op.
 *
 * DUE SUPERFICI, LO STESSO PUNTO. `data.seo` e' l'entry IT di `content/seo/**`;
 * `data.content[locale].seoDescription` / `.ogDescription` sono i gemelli
 * per-locale che da ora finiscono nel blocco meta e quindi in
 * `meta-<locale>.json`. Sono lo stesso tipo di testo per lo stesso tipo di
 * consumatore, quindi cadono sotto lo stesso tetto e nello stesso choke point:
 * il difetto che #5360/#81 hanno chiuso era proprio una regola applicata in un
 * produttore invece che dove tutti scrivono. Anche qui e' una RETE DI SICUREZZA
 * e non il meccanismo — il Bollettino nasce a 158-159 caratteri e questa non
 * deve mai scattarci sopra.
 */
const SEO_DESCRIPTION_BUDGETS = {
  description: SEO_DESCRIPTION_MAX,
  ogDescription: SEO_OG_DESCRIPTION_MAX,
};

/** Gli stessi due budget, con i nomi che i campi hanno dentro `content[locale]`. */
const LOCALE_SEO_DESCRIPTION_BUDGETS = {
  seoDescription: SEO_DESCRIPTION_MAX,
  ogDescription: SEO_OG_DESCRIPTION_MAX,
};

function clampSeoDescriptions(data) {
  const seo = data?.seo;
  if (seo && typeof seo === 'object') {
    for (const [field, max] of Object.entries(SEO_DESCRIPTION_BUDGETS)) {
      const value = seo[field];
      if (typeof value !== 'string' || value.length === 0) continue;
      seo[field] = truncateAtWordBoundary(value, max);
    }
  }
  const content = data?.content;
  if (content && typeof content === 'object') {
    for (const localeContent of Object.values(content)) {
      if (!localeContent || typeof localeContent !== 'object') continue;
      for (const [field, max] of Object.entries(LOCALE_SEO_DESCRIPTION_BUDGETS)) {
        const value = localeContent[field];
        if (typeof value !== 'string' || value.length === 0) continue;
        localeContent[field] = truncateAtWordBoundary(value, max);
      }
    }
  }
}

export async function registerArticleFiles(data, opts = {}) {
  if (!data || !data.id || !data.content?.it?.title) {
    throw new Error('registerArticleFiles: data.id and data.content.it.title are required');
  }
  if (checkArticleIdExists(data.id)) {
    throw new Error(
      `registerArticleFiles: article "${data.id}" already exists (registration is append-only). ` +
        'Refresh the body files instead of re-registering.',
    );
  }
  // Sta QUI, sul percorso di scrittura condiviso, per la stessa ragione
  // argomentata sopra a `deriveAndSanitizeArticleSlugs()`: `validate()` e' UN
  // produttore, e generate-daily-brief-article.mjs, generate-events-digest-article.mjs,
  // generate-border-wait-ranking-article.mjs e publish-journalist-article.mjs
  // importano registerArticleFiles() direttamente senza passarci mai.
  // Prima di clampSeoDescriptions: troncare a 160 caratteri un campo che e' il
  // segnaposto lo renderebbe solo un segnaposto piu' corto.
  sanitizePromptPlaceholders(data);
  clampSeoDescriptions(data);
  const slugs = deriveAndSanitizeArticleSlugs(data);
  modifyRouterTs(data);
  modifyBlogArticlesTsx(data);
  modifyI18nTs(data);
  modifyLocaleFile(data, 'en');
  modifyLocaleFile(data, 'de');
  modifyLocaleFile(data, 'fr');
  modifySeoService(data);
  modifySitemap(data);
  if (!opts.skipNews) modifySitemapNews(data);
  validateStructuredData(data);
  // RSS regeneration removed with #4974 item 2 — see the sibling call site
  // above. `opts.skipRss` is kept accepted-and-ignored so existing callers
  // passing it keep working; there is simply nothing left to skip.
  const publishedUrls = buildArticlePublishedUrls(data);
  return { slugs, publishedUrls };
}

/** True when an article id is already registered in any section. */
export function checkArticleIdExists(id) {
  return getAllArticleIds().includes(id);
}

// Re-exported so the evergreen refresh path produces byte-identical body files
// to the registration path (no copy-paste of the locale-file format — §6).
export { buildBodyFile };

// Re-exported so the journalist-publish pipeline (scripts/publish-journalist-article.mjs)
// reuses the SAME translation, internal-link-enrichment, image-fallback and
// byline-assignment logic as the AI generation path instead of duplicating it
// (issue #3174 — a manually-authored article must go through the exact same
// multi-language pipeline as an automated one). checkTranslatedSlugCollisions
// is re-exported for the same reason (#3010): the journalist path derives its
// own en/de/fr slugs (deriveLocaleSlugs()) but, before this fix, never
// validated them against the registry — the same gap that historically only
// existed for the IT slug in the AI path.
export { translateArticle, enforceStrongInternalLinks, findBestFallbackImage, pickAuthorForTopic, getAuthorByUid, sanitizeBoldFormatting, validateAndEnforceCTA, optimizeSeoMetadata, checkTranslatedSlugCollisions, assertNoFabricatedReferences, assertNoFabricatedLaborOfficeCrossLocale };

// Redazione redesign (issue #3174 follow-up): the journalist now authors only
// {title, body}; these derive the title-casing/excerpt/body1-3/cover-image
// candidates the shared pipeline above still expects.
export { normalizeTitleCasing, collapseShoutingTitle, applyMicrocopyGuard, generateExcerpt, splitBodyIntoSections, findStockImageCandidates };

// Re-exported so eval/research harnesses (e.g. the local-LLM rewrite eval,
// issue #3656) can run the SAME blocking fact-check gate used in production
// against candidate output, instead of re-implementing an approximation of
// it. Pure re-export — no behavior change for the internal caller above.
export { llmFactCheck };

// Only run the AI generation pipeline when invoked directly as a CLI — importing
// this module (to reuse registerArticleFiles/buildBodyFile) must NOT execute it.
const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] || '').href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  // When LOCAL_LLM_ENABLED and the model fills the runner disk, even
  // process.stdout/stderr writes fail with ENOSPC — Node.js crashes with an
  // unhandled 'error' event on WriteStream, masking the real cause. Handle it
  // explicitly on BOTH streams (almost all diagnostic logging in this file goes
  // through console.error → stderr, the actual stream that crashed run
  // 30020742048 — the stdout-only guard added in #4308 didn't cover it) so the
  // process exits non-zero with a clear message instead.
  const handleEnospc = (err) => {
    if (err.code !== 'ENOSPC') return;
    try { process.stderr.write('[create-article] ENOSPC: disk full. Reduce ARTICLE_LOCAL_MODEL to qwen2.5:7b\n'); } catch {}
    process.exitCode = 1;
  };
  process.stdout.on('error', handleEnospc);
  process.stderr.on('error', handleEnospc);
  main().catch((e) => {
  // Transient free-model pool exhaustion (every model in the fallback chain hit
  // its daily quota / rate limit) is NOT a code bug — free-tier daily limits
  // reset at 00:00 UTC, so the next scheduled run normally succeeds. Treat it as
  // a clean deferral (exit 0, no file changes) so the workflow's self-trigger
  // back-off retries later instead of marking the run failed and raising a
  // false-positive "Workflow Failure: Generate Blog Article" Bug issue (#1652).
  // Mirrors the graceful quota-exhausted handling in dedicated-crawler-common.mjs.
  if (isQuotaExhaustedError(e)) {
    finalizeRunReport('deferred', { notes: [...RUN_REPORT.notes, `Deferred (all free models exhausted): ${e.message}`] });
    console.error(`\n⚠️  Differito: tutti i modelli AI gratuiti sono temporaneamente esauriti (quota giornaliera). Riprovo al prossimo run. ${e.message}`);
    process.exit(0);
  }
  // Content/quality rejection that bubbled all the way up (e.g. manual-URL mode,
  // or every headline/keyword in a loop exhausted on quality grounds). The slop
  // was correctly NOT published — but "no acceptable article this run" is a clean
  // deferral, not an infrastructure failure: exit 0 so the self-trigger back-off
  // retries later instead of marking the run red and raising a false-positive
  // "Workflow Failure: Generate Blog Article" Bug issue (run 28000585473 → #2750).
  if (isQualityRejectError(e)) {
    finalizeRunReport('deferred', { notes: [...RUN_REPORT.notes, `Deferred (content quality rejected, slop not published): ${e.message}`] });
    console.error(`\n⚠️  Differito: nessun articolo conforme prodotto in questa run (rigetto qualità — slop non pubblicato). Riprovo al prossimo run. ${e.message}`);
    process.exit(0);
  }
  // Duplicate rejection that bubbled all the way up from the direct-URL
  // invocation path (self-trigger chain re-dispatching a single evergreen
  // candidate) — see isDuplicateError above.
  if (isDuplicateError(e)) {
    captureDuplicateReasons(e.message);
    finalizeRunReport('deferred', { notes: [...RUN_REPORT.notes, `Deferred (duplicate detected, not published): ${e.message}`] });
    console.error(`\n⚠️  Differito: duplicato rilevato, articolo non pubblicato in questa run. Riprovo al prossimo run. ${e.message}`);
    process.exit(0);
  }
  finalizeRunReport('error', { notes: [...RUN_REPORT.notes, `Error: ${e.message}`] });
  console.error(`\n❌ Errore: ${e.message}`);
  process.exit(1);
});
}
