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
 * pensioni; ogni tema puo' anche avere un classificatore lessicale diretto
 * dichiarato in `generator/data/canton-hub-topics.json`. Il lessico diretto
 * recupera titoli editorialmente espliciti che il seed TF-IDF non riconosce
 * (per esempio una strada chiusa o un bilancio cantonale), senza trasformare
 * un articolo genericamente cantonale in una news di tema.
 * L'assegnazione dell'engine resta il segnale principale, ma la pertinenza
 * viene verificata direttamente per OGNI tema: una news con evidenza esplicita
 * in due temi alimenta entrambi gli hub. Le news della sezione propria hanno
 * priorita' nel tetto editoriale; quelle multi-label storiche restano il
 * fallback D13.
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
 * Punteggio del classificatore a parole chiave per un tema.
 * @returns {{ score: number, titleHit: boolean, requiredHit: boolean, excluded: boolean }}
 */
export function keywordTopicScore(article, topicConfig) {
  let score = 0;
  let titleHit = false;
  let requiredHit = !topicConfig.requiredTerms;
  let excluded = false;
  for (const locale of HUB_LOCALES) {
    const terms = topicConfig.terms?.[locale] ?? [];
    const requiredTerms = topicConfig.requiredTerms?.[locale] ?? [];
    const inTitle = Math.min(2, termHits(article.title[locale], terms));
    const inExcerpt = Math.min(3, termHits(article.excerpt[locale], terms));
    if (inTitle > 0) titleHit = true;
    if (termHits(article.title[locale], requiredTerms) > 0) requiredHit = true;
    score += 3 * inTitle + inExcerpt;
    const hasExcludedTerm = termHits(article.title[locale], topicConfig.exclude?.[locale] ?? []) > 0;
    const hasExceptionTerm = termHits(article.title[locale], topicConfig.excludeUnless?.[locale] ?? []) > 0;
    if (hasExcludedTerm && !hasExceptionTerm) excluded = true;
  }
  return { score, titleHit, requiredHit, excluded };
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
 * @returns {{ byTopic: Record<string, any[]>, stats: { pool: number, clusterAssigned: number, keywordAssigned: number, unassigned: number, multiTopic: number } }}
 */
export function selectCuratedArticles({ pool, section, config, engine, nowMs }) {
  const today = Date.parse(`${isoDayOf(nowMs)}T00:00:00Z`);
  // Un articolo datato nel futuro non e' ancora una news da promuovere: passa
  // solo lo sfasamento d'orologio fra chi ha scritto la data e questo runner.
  const eligible = pool.filter((a) => dateMs(a.date) <= nowMs + CLOCK_SKEW_MS);
  const inputs = eligible.map((a) => ({ articleId: a.id, title: a.title.it, excerpt: a.excerpt.it, datePub: a.date, category: a.category }));
  const seeds = engine.TOPIC_CLUSTERS.map((t) => ({ key: t.key, seedText: t.seedText }));
  // L'engine calcola comunque l'assegnazione canonica D17 sul corpus filtrato
  // per cantone. Per la promozione, però, non si usa il suo `topicOf` come
  // etichetta esclusiva: la stessa news può avere due evidenze dirette e deve
  // poter arrivare a entrambi gli hub. Le componenti propagate non bastano da
  // sole: la verifica sotto richiede un termine del tema nel titolo e il
  // coseno minimo, così una guida generica non viene inventata come news
  // fiscale o pensionistica.
  const assignment = engine.assignArticlesToTopics(inputs, seeds, { threshold: 2 });
  const model = engine.buildCorpusModel(inputs);
  const seedBags = new Map(seeds.map((t) => {
    const bag = new Map();
    for (const tok of engine.tokenize(t.seedText)) bag.set(tok, (bag.get(tok) ?? 0) + 1);
    return [t.key, { bag, norm: model.normOfTokens(bag) }];
  }));

  const keywordTopics = CANTON_HUB_TOPIC_KEYS.filter((t) => config.keywordTopics?.[t]);
  for (const t of CANTON_HUB_TOPIC_KEYS) {
    if (CANTON_HUB_TOPIC_CLUSTERS[t].length === 0 && !config.keywordTopics?.[t]) {
      throw new Error(`canton-hubs: il tema "${t}" non ha cluster nell'engine ne' classificatore in canton-hub-topics.json`);
    }
  }

  const { freshnessHalfLifeDays, weights, neutralQuality, minTopicStrength, fullTopicStrength } = config.ranking;
  const byTopic = Object.fromEntries(CANTON_HUB_TOPIC_KEYS.map((t) => [t, []]));
  const clusterArticles = new Set();
  const keywordArticles = new Set();
  const assignedArticles = new Set();
  const multiTopicArticles = new Set();
  for (const a of eligible) {
    const primaryTopic = cantonHubTopicForCluster(assignment.topicOf.get(a.id));
    const titleTokens = new Set(engine.tokenize(a.title.it));
    const articleTokens = new Set(engine.tokenize(`${a.title.it} ${a.excerpt.it}`));
    // Calcola una volta le esclusioni lessicali: valgono anche per il match
    // semantico. Un titolo esplicitamente escluso (per esempio un phishing
    // che usa la parola «fisco») non deve rientrare nell'hub solo perché il
    // cluster TF-IDF gli assegna un coseno sufficiente.
    const keywordResults = new Map(keywordTopics.map((topic) => [
      topic,
      keywordTopicScore(a, config.keywordTopics[topic]),
    ]));
    const isExcluded = (topic) => keywordResults.get(topic)?.excluded === true;
    const matchesByTopic = new Map();
    const addMatch = (match) => {
      const previous = matchesByTopic.get(match.topic);
      if (!previous || Number(match.primary) > Number(previous.primary) || match.strength > previous.strength) {
        matchesByTopic.set(match.topic, match);
      }
    };

    // Per i temi con cluster, valuta tutti i cluster che alimentano l'hub,
    // non solo il vincitore monolabel dell'engine. Il titolo resta una prova
    // editoriale necessaria: l'estratto da solo non trasforma una news
    // generica in una news di tema.
    for (const topic of CANTON_HUB_TOPIC_KEYS) {
      const clusters = CANTON_HUB_TOPIC_CLUSTERS[topic];
      if (clusters.length === 0) continue;
      const best = clusters
        .map((cluster) => {
          const seed = seedBags.get(cluster);
          const cosine = model.cosineWithBag(a.id, seed.bag, seed.norm);
          const titleHit = [...titleTokens].some((tok) => seed.bag.has(tok));
          const seedHitCount = [...articleTokens].filter((tok) => seed.bag.has(tok)).length;
          return { cluster, cosine, titleHit, seedHitCount, primary: topic === primaryTopic };
        })
        // Scegli fra i cluster che sono già ammissibili. Un cluster
        // semanticamente vicino ma senza prova nel titolo non deve oscurare
        // l'altro cluster che invece prova il tema (in particolare mobilita').
        .filter((match) => match.titleHit && match.cosine >= minTopicStrength
          && !isExcluded(topic)
          // «frontaliere»/«confine» da soli descrivono il pubblico, non
          // necessariamente una notizia di mobilita'. Per il cluster
          // specifico servono due termini del seme tra titolo ed estratto.
          && (match.cluster === 'confine-dogana'
            ? match.seedHitCount >= 2
            : (match.primary || match.seedHitCount >= 2)))
        .sort((x, y) => y.cosine - x.cosine
          || y.seedHitCount - x.seedHitCount
          || x.cluster.localeCompare(y.cluster))[0];
      // Una parola ambigua condivisa dal seed (per esempio «guardie» in una
      // cronaca di polizia) non basta per un secondo tema. Il tema primario
      // dell'engine può usare il match singolo; ogni tema aggiuntivo richiede
      // due occorrenze di lessico nel titolo+estratto, senza allargare la
      // pertinenza con la sola presenza nel cantone.
      if (!best) continue;
      addMatch({
        topic,
        strength: Math.min(1, best.cosine / fullTopicStrength),
        source: 'cluster',
        primary: topic === primaryTopic,
      });
    }

    // Il lessico dichiarato e' un secondo segnale diretto, non un fallback
    // esclusivo: vale anche quando l'engine ha scelto un cluster diverso.
    // Questo recupera titoli cantonali espliciti che i seed non coprono e
    // conserva i match multi-tema senza duplicare una voce nello stesso hub.
    for (const topic of keywordTopics) {
      const cfg = config.keywordTopics[topic];
      const result = keywordResults.get(topic);
      if (result.excluded || !result.requiredHit || !result.titleHit || result.score < cfg.minScore) continue;
      addMatch({
        topic,
        strength: Math.min(1, result.score / (3 * cfg.minScore)),
        source: 'keyword',
        primary: topic === primaryTopic,
      });
    }
    const matches = [...matchesByTopic.values()];
    if (matches.length === 0) continue;
    assignedArticles.add(a.id);
    if (matches.length > 1) multiTopicArticles.add(a.id);
    if (matches.some((match) => match.source === 'cluster')) clusterArticles.add(a.id);
    if (matches.some((match) => match.source === 'keyword')) keywordArticles.add(a.id);

    const ageDays = Math.max(0, Math.floor((today - Date.parse(`${isoDayOf(a.date)}T00:00:00Z`)) / DAY_MS));
    const freshness = 0.5 ** (ageDays / freshnessHalfLifeDays);
    // Un articolo della sezione del cantone parla solo di lui; uno etichettato
    // con tre cantoni e' meno «del cantone» di uno etichettato con uno.
    const own = a.section === section ? 1 : 1 / Math.max(1, a.cantons.length);
    const quality = a.quality ?? neutralQuality;
    for (const match of matches) {
      const relevance = 0.4 * own + 0.6 * match.strength;
      const score = Math.round((weights.freshness * freshness + weights.relevance * relevance + weights.quality * quality) * 1e6) / 1e6;
      byTopic[match.topic].push({ article: a, score, own: a.section === section, primary: match.primary });
    }
  }

  const max = config.maxCuratedArticles;
  for (const topic of CANTON_HUB_TOPIC_KEYS) {
    byTopic[topic] = filterUniqueCuratedCandidates(byTopic[topic]
      .sort((x, y) => Number(y.own) - Number(x.own)
        || Number(y.primary) - Number(x.primary)
        || y.score - x.score
        || y.article.date.localeCompare(x.article.date)
        || x.article.id.localeCompare(y.article.id)))
      .slice(0, max)
      .map(({ article }) => article);
  }
  return {
    byTopic,
    stats: {
      pool: eligible.length,
      // Sono conteggi di articoli, non di slot: un articolo puo' appartenere
      // sia a un tema tassonomico sia a eventi/servizi e a piu' hub.
      clusterAssigned: clusterArticles.size,
      keywordAssigned: keywordArticles.size,
      unassigned: eligible.length - assignedArticles.size,
      multiTopic: multiTopicArticles.size,
    },
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
