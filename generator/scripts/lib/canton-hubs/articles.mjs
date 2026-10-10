/**
 * articles.mjs — «le news migliori del cantone per tema» (D13, D17).
 *
 * Il bacino di un cantone sono gli articoli della SUA sezione piu' quelli di
 * frontaliere/svizzera il cui campo multi-label `canton` (P6a) contiene il
 * cantone: quelli non si spostano e non si duplicano, l'hub li LINKA
 * all'URL della loro sezione.
 *
 * L'assegnazione al tema usa la tassonomia dell'engine
 * (`assignArticlesToTopics` sui 14 `TOPIC_CLUSTERS`, poi la mappa hub→cluster
 * di `engine/shared/cantonSectionCopy.mjs`) per carburanti, fisco, mobilita' e
 * pensioni; eventi e servizi non hanno un cluster e passano dal classificatore
 * a parole chiave dichiarato in `generator/data/canton-hub-topics.json`. Un
 * articolo sta in UN solo hub del cantone: vince il cluster dell'engine.
 *
 * Tutto deterministico: stesso corpus e stesso giorno → stesso elenco.
 */
import '../../../../host/cantonSectionsBootstrap.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { ARTICLE_SECTION_CORE_ALL, articleSectionEntry, isCantonSection } from '../../../../engine/shared/articleSectionCore.mjs';
import { parseArticleUrlSlugs } from '../../../../engine/shared/articleReaderSource.mjs';
import { CANONICAL_OVERRIDE_FILES } from '../../../../engine/shared/canonicalOverrideFiles.mjs';
import { CANTON_HUB_TOPIC_CLUSTERS, cantonHubTopicForCluster } from '../../../../engine/shared/cantonSectionCopy.mjs';
import { CANTON_HUB_TOPIC_KEYS } from '../../../../engine/shared/cantonArticleSectionCore.generated.mjs';
import { sectionSourceSurfaces } from '../../../../scripts/lib/corpus-sections.mjs';
import { sectionWriteSurfaces } from '../../../../scripts/lib/article-surfaces.mjs';
import { readTopLevelString, scanTopLevelArticleRecords } from '../../../../scripts/lib/article-registry-reader.mjs';
import { isReservedPublishedSlug } from '../../../../scripts/lib/published-slug-guard.mjs';
import { readTsStringMap } from '../../backfill-article-cantons.mjs';
import { readEntryCanton, registryEntrySpans } from '../registry-canton-field.mjs';
import { foldForMatch, termHits } from '../canton-section-profile.mjs';
import { DAILY_EDITION_ID_RE } from '../daily-brief-content.mjs';
import { CLOCK_SKEW_MS, DAY_MS, dateMs } from './blocks-common.mjs';
import { HUB_LOCALES, clip, isoDayOf } from './format.mjs';

/** Le due sezioni storiche da cui un hub cantonale promuove via campo `canton`. */
export const LABELLED_SECTIONS = Object.freeze(['frontaliere', 'svizzera']);

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Gli slug IT de-listati dai canonical override di una sezione storica: le
 * chiavi dell'oggetto `overrides` del file (stessa lettura di `build-api.mjs`).
 * Un file presente ma senza un oggetto `overrides` e' una forma sconosciuta e
 * si rifiuta: promuovere un duplicato non canonico e' peggio che fermarsi.
 */
function shadowedSlugs(root, section) {
  for (const rel of CANONICAL_OVERRIDE_FILES[section] ?? []) {
    const raw = readIfExists(path.join(root, rel));
    if (raw == null) continue;
    const overrides = JSON.parse(raw)?.overrides;
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
      throw new Error(`canton-hubs: ${rel} non ha un oggetto \`overrides\`: canonical override illeggibili`);
    }
    return new Set(Object.keys(overrides));
  }
  return new Set();
}

/**
 * Qualita' gia' calcolata dal ranker di create-article (sidecar
 * `_score_breakdown`), portata in [0,1), o null se il sidecar non la porta.
 *
 * `score`/`finalScore` NON sono in [0,1]: nel ranker a cascata sono un
 * punteggio di domanda non negativo e senza tetto (puo' valere 0,4 come 12).
 * Tagliarlo a 1 metterebbe alla pari tutti i candidati sopra 1 e spegnerebbe
 * la componente; qui la scala e' dichiarata: s / (1 + s), monotona, che
 * conserva l'ordine fra due punteggi qualunque e satura dolcemente.
 */
export function sidecarQuality(sidecar) {
  const s = sidecar?._score_breakdown;
  if (!s || typeof s !== 'object') return null;
  const v = [s.score, s.finalScore].find((x) => typeof x === 'number' && Number.isFinite(x));
  if (v == null) return null;
  const positive = Math.max(0, v);
  return positive / (1 + positive);
}

/** Path radice-relativo della landing di una sezione in una locale. */
export function sectionLandingPath(section, locale) {
  const slug = articleSectionEntry(section).indexSlug[locale];
  return locale === 'it' ? `/${slug}/` : `/${locale}/${slug}/`;
}

/** URL radice-relativo (con slash finale) di un articolo nella SUA sezione. */
export function articleUrl(article, locale) {
  return `${sectionLandingPath(article.section, locale)}${article.slug[locale]}/`;
}

/**
 * Gli articoli pubblicabili di UNA sezione, con titolo/estratto/slug nelle 4
 * locali. Una sezione cantonale senza registro (non ancora accesa) rende [].
 *
 * @param {string} root radice del repo
 * @param {string} section id del core (attivo o no)
 */
export function loadSectionArticles(root, section) {
  const src = sectionSourceSurfaces(section);
  const registry = readIfExists(path.join(root, src.registryFile));
  if (registry == null) {
    if (isCantonSection(section)) return [];
    throw new Error(`canton-hubs: registro mancante per la sezione ${section} (${src.registryFile})`);
  }
  const entries = registryEntrySpans(registry);
  // Registro senza voci: lo scheletro di una sezione cantonale appena accesa
  // (mappa slug e meta vuote o assenti sono il suo stato legittimo). Le due
  // sezioni storiche non sono mai vuote: per loro e' un corpus troncato.
  if (entries.length === 0) {
    if (isCantonSection(section)) return [];
    throw new Error(`canton-hubs: il registro di ${section} (${src.registryFile}) non ha voci: corpus troncato`);
  }
  // Da qui in poi il registro HA articoli: mappa slug e meta di tutte le
  // locali sono obbligatorie. Senza, ogni voce verrebbe scartata in silenzio e
  // l'hub uscirebbe senza news come se il cantone non ne avesse.
  const slugSource = readIfExists(path.join(root, src.slugFile));
  if (slugSource == null) throw new Error(`canton-hubs: mappa slug mancante per ${section} (${src.slugFile}) con ${entries.length} voci nel registro`);
  const slugs = parseArticleUrlSlugs(slugSource, src.slugExport);
  const meta = Object.fromEntries(HUB_LOCALES.map((locale) => {
    const text = readIfExists(path.join(root, src.metaFile(locale)));
    if (text == null) throw new Error(`canton-hubs: meta ${locale} mancante per ${section} (${src.metaFile(locale)}) con ${entries.length} voci nel registro`);
    return [locale, readTsStringMap(text)];
  }));
  const sidecarDir = path.join(root, sectionWriteSurfaces(section).sidecarDir);
  const shadowed = shadowedSlugs(root, section);
  const ownCanton = isCantonSection(section) ? ARTICLE_SECTION_CORE_ALL[section].canton : null;

  const out = [];
  for (const { id, text } of entries) {
    if (DAILY_EDITION_ID_RE.test(id)) continue;
    const [record] = scanTopLevelArticleRecords(text);
    const date = readTopLevelString(record, 'date');
    // Una data impossibile nel registro non diventa la data di una news promossa.
    if (!date || !Number.isFinite(dateMs(date))) continue;
    const slug = slugs[id];
    if (!slug || HUB_LOCALES.some((l) => typeof slug[l] !== 'string' || !slug[l] || isReservedPublishedSlug(slug[l]))) continue;
    if (shadowed.has(slug.it)) continue;
    const title = Object.fromEntries(HUB_LOCALES.map((l) => [l, String(meta[l].get(`blog.article.${id}.title`) ?? '').trim()]));
    if (HUB_LOCALES.some((l) => !title[l])) continue;
    const excerpt = Object.fromEntries(HUB_LOCALES.map((l) => [l, String(meta[l].get(`blog.article.${id}.excerpt`) ?? '').trim()]));
    let sidecar = null;
    const raw = readIfExists(path.join(sidecarDir, `${id}.json`));
    if (raw != null) {
      try {
        sidecar = JSON.parse(raw);
      } catch {
        sidecar = null;
      }
    }
    const labelled = readEntryCanton(text) ?? [];
    out.push({
      id,
      section,
      date,
      category: readTopLevelString(record, 'category') ?? '',
      cantons: [...new Set([...(ownCanton ? [ownCanton] : []), ...labelled])],
      title,
      excerpt,
      slug: Object.fromEntries(HUB_LOCALES.map((l) => [l, slug[l]])),
      quality: sidecarQuality(sidecar),
    });
  }
  return out;
}

/**
 * Il bacino di un cantone: sezione propria + frontaliere/svizzera etichettati.
 * @param {string} root
 * @param {string} section id della sezione cantonale
 * @param {(root: string, section: string) => any[]} [load] iniettabile nei test
 */
export function loadCantonPool(root, section, load = loadSectionArticles) {
  const canton = ARTICLE_SECTION_CORE_ALL[section]?.canton;
  if (!canton) throw new Error(`canton-hubs: "${section}" non e' una sezione cantonale`);
  const seen = new Set();
  const pool = [];
  for (const s of [section, ...LABELLED_SECTIONS]) {
    for (const a of load(root, s)) {
      if (!a.cantons.includes(canton) || seen.has(a.id)) continue;
      seen.add(a.id);
      pool.push(a);
    }
  }
  return pool;
}

/**
 * Punteggio del classificatore a parole chiave per un tema senza cluster.
 * @returns {{ score: number, titleHit: boolean, excluded: boolean }}
 */
export function keywordTopicScore(article, topicConfig) {
  let score = 0;
  let titleHit = false;
  let excluded = false;
  for (const locale of HUB_LOCALES) {
    const terms = topicConfig.terms?.[locale] ?? [];
    const inTitle = Math.min(2, termHits(article.title[locale], terms));
    const inExcerpt = Math.min(3, termHits(article.excerpt[locale], terms));
    if (inTitle > 0) titleHit = true;
    score += 3 * inTitle + inExcerpt;
    if (termHits(article.title[locale], topicConfig.exclude?.[locale] ?? []) > 0) excluded = true;
  }
  return { score, titleHit, excluded };
}

const titleKey = (title) => foldForMatch(title).replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Un hub rende ogni voce in tutte le locali. Mantiene il candidato meglio
 * classificato quando ID distinti puntano allo stesso URL canonico in una
 * qualsiasi locale, senza indebolire la validazione finale del renderer.
 * @param {Array<{ article: any }>} candidates ordinati per ranking decrescente
 */
export function filterUniqueCuratedCandidates(candidates) {
  const seenTitles = new Set();
  const seenUrls = new Map(HUB_LOCALES.map((locale) => [locale, new Set()]));
  return candidates.filter(({ article }) => {
    const key = titleKey(article.title.it);
    const localizedUrls = HUB_LOCALES.map((locale) => [locale, articleUrl(article, locale)]);
    if (seenTitles.has(key) || localizedUrls.some(([locale, url]) => seenUrls.get(locale).has(url))) return false;
    seenTitles.add(key);
    for (const [locale, url] of localizedUrls) seenUrls.get(locale).add(url);
    return true;
  });
}

/**
 * Assegna e ordina le news promosse di ogni hub del cantone.
 *
 * @param {object} args
 * @param {any[]} args.pool bacino del cantone (`loadCantonPool`)
 * @param {string} args.section
 * @param {any} args.config `canton-hub-topics.json`
 * @param {{ assignArticlesToTopics: Function, TOPIC_CLUSTERS: ReadonlyArray<{key: string, seedText: string}> }} args.engine
 * @param {number} args.nowMs
 * @returns {{ byTopic: Record<string, any[]>, stats: { pool: number, clusterAssigned: number, keywordAssigned: number, unassigned: number } }}
 */
export function selectCuratedArticles({ pool, section, config, engine, nowMs }) {
  const today = Date.parse(`${isoDayOf(nowMs)}T00:00:00Z`);
  // Un articolo datato nel futuro non e' ancora una news da promuovere: passa
  // solo lo sfasamento d'orologio fra chi ha scritto la data e questo runner.
  const eligible = pool.filter((a) => dateMs(a.date) <= nowMs + CLOCK_SKEW_MS);
  const inputs = eligible.map((a) => ({ articleId: a.id, title: a.title.it, excerpt: a.excerpt.it, datePub: a.date, category: a.category }));
  const seeds = engine.TOPIC_CLUSTERS.map((t) => ({ key: t.key, seedText: t.seedText }));
  // Solo il match DIRETTO sui seed (`threshold` sopra ogni coseno possibile
  // spegne gli archi, quindi la propagazione per componenti). La propagazione
  // serve agli hub di argomento del sito, che vogliono copertura su migliaia
  // di articoli; misurata sul bacino del Ticino (2026-10-05) portava dentro
  // «fisco» e «pensioni» decine di guide «Vivere a <comune>» che il tema non
  // lo trattano. Qui si promuovono le news MIGLIORI: conta la precisione.
  const assignment = engine.assignArticlesToTopics(inputs, seeds, { threshold: 2 });
  const model = engine.buildCorpusModel(inputs);
  const seedBags = new Map(seeds.map((t) => {
    const bag = new Map();
    for (const tok of engine.tokenize(t.seedText)) bag.set(tok, (bag.get(tok) ?? 0) + 1);
    return [t.key, { bag, norm: model.normOfTokens(bag) }];
  }));

  const keywordTopics = CANTON_HUB_TOPIC_KEYS.filter((t) => CANTON_HUB_TOPIC_CLUSTERS[t].length === 0);
  for (const t of keywordTopics) {
    if (!config.keywordTopics?.[t]) throw new Error(`canton-hubs: il tema "${t}" non ha cluster nell'engine ne' classificatore in canton-hub-topics.json`);
  }

  const { freshnessHalfLifeDays, weights, neutralQuality, minTopicStrength, fullTopicStrength } = config.ranking;
  const byTopic = Object.fromEntries(CANTON_HUB_TOPIC_KEYS.map((t) => [t, []]));
  let clusterAssigned = 0;
  let keywordAssigned = 0;
  for (const a of eligible) {
    const cluster = assignment.topicOf.get(a.id);
    let topic = cluster ? cantonHubTopicForCluster(cluster) : null;
    let strength = 0;
    if (topic) {
      const seed = seedBags.get(cluster);
      const cosine = model.cosineWithBag(a.id, seed.bag, seed.norm);
      // Stessa regola del classificatore a parole chiave: il tema deve stare
      // nel TITOLO, non solo in una riga dell'estratto, e con forza sufficiente.
      const titleHit = engine.tokenize(a.title.it).some((tok) => seed.bag.has(tok));
      if (!titleHit || cosine < minTopicStrength) continue;
      strength = Math.min(1, cosine / fullTopicStrength);
      clusterAssigned += 1;
    } else {
      // Nessun cluster, o un cluster che non alimenta alcun hub (salute, lavoro…):
      // l'articolo puo' ancora essere di eventi o servizi.
      let best = null;
      for (const t of keywordTopics) {
        const cfg = config.keywordTopics[t];
        const r = keywordTopicScore(a, cfg);
        if (r.excluded || !r.titleHit || r.score < cfg.minScore) continue;
        // A parita' vince il tema che viene prima nell'ordine canonico.
        if (!best || r.score > best.score) best = { topic: t, score: r.score, min: cfg.minScore };
      }
      if (!best) continue;
      topic = best.topic;
      strength = Math.min(1, best.score / (3 * best.min));
      keywordAssigned += 1;
    }
    const ageDays = Math.max(0, Math.floor((today - Date.parse(`${isoDayOf(a.date)}T00:00:00Z`)) / DAY_MS));
    const freshness = 0.5 ** (ageDays / freshnessHalfLifeDays);
    // Un articolo della sezione del cantone parla solo di lui; uno etichettato
    // con tre cantoni e' meno «del cantone» di uno etichettato con uno.
    const own = a.section === section ? 1 : 1 / Math.max(1, a.cantons.length);
    const relevance = 0.4 * own + 0.6 * strength;
    const quality = a.quality ?? neutralQuality;
    const score = Math.round((weights.freshness * freshness + weights.relevance * relevance + weights.quality * quality) * 1e6) / 1e6;
    byTopic[topic].push({ article: a, score });
  }

  const max = config.maxCuratedArticles;
  for (const topic of CANTON_HUB_TOPIC_KEYS) {
    byTopic[topic] = filterUniqueCuratedCandidates(byTopic[topic]
      .sort((x, y) => y.score - x.score || y.article.date.localeCompare(x.article.date) || x.article.id.localeCompare(y.article.id)))
      .slice(0, max)
      .map(({ article }) => article);
  }
  return {
    byTopic,
    stats: { pool: eligible.length, clusterAssigned, keywordAssigned, unassigned: eligible.length - clusterAssigned - keywordAssigned },
  };
}

/** La voce `curatedArticles` del renderer per una locale. */
export function curatedEntry(article, locale) {
  const excerpt = clip(article.excerpt[locale], 220);
  return {
    title: article.title[locale],
    url: articleUrl(article, locale),
    ...(excerpt ? { excerpt } : {}),
    date: article.date,
  };
}
