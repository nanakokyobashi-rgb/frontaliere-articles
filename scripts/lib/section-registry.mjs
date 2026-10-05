/**
 * section-registry.mjs — il registro delle sezioni articolo pubblicate dal
 * corpus e servite dal Worker del sito (piano «sezioni articoli per cantone»,
 * D3, D9, D14; P7).
 *
 * ── Tre documenti, una sola verita' ─────────────────────────────────────────
 *
 *   1. `sections/registry.json` (COMMITTATO): lo stato DICHIARATO di ogni
 *      sezione cantonale — `kind`, `canton`, `status` (`live|draft|retired`),
 *      `indexSlug`, `topics`, e facoltativi `redirects`/`gone`. E' la verita'
 *      (D9): accendere un cantone e' un commit qui.
 *   2. `dist/api/sections.json` (pubblicato su Pages): il catalogo che il sito
 *      legge a runtime (blocco di navigazione «Articoli per cantone»), con lo
 *      stato EFFETTIVO, i percorsi, i conteggi e la sitemap di ogni sezione.
 *   3. `dist/api/edge/sections/registry.json` → R2 `edge/sections/registry.json`:
 *      la copia nel formato ESATTO che il Worker valida
 *      (`parseCorpusSectionRegistry` in
 *      infra/cloudflare-worker/locale-router.js del sito): `schema: 1`,
 *      `commit`, `sections: { <canton-id>: { status, redirects?, gone? } }`.
 *
 * ── Kill-switch (D9) ────────────────────────────────────────────────────────
 *
 * Remote Config `CANTON_ARTICLE_SECTIONS_KILL` (mappato in `RC_TO_ENV` di
 * generator/scripts/load-rc-env.mjs) elenca le sezioni da spegnere: una
 * sezione dichiarata `live` e nominata li' esce `draft` nei documenti 2 e 3, e
 * il Worker torna a rispondere come prima che esistesse (404). Default assente
 * = nessun override. Formato: codici di gruppo (`TI`, `BASILEA`), id
 * (`canton-ti`) o `all`/`*`, separati da virgola o spazio. `retired` non viene
 * toccato: spegnere non deve resuscitare un 410 in un 404.
 *
 * Il loader di Remote Config e' fail-open (esce 0 anche senza caricare
 * niente), quindi l'assenza della variabile non dimostra «nessun kill». Il
 * successo si verifica in modo esplicito col marker `RC_ENV_LOADED=1` che il
 * loader scrive solo dopo aver letto il template. Senza marker lo stato del
 * kill-switch e' `unverified`: se una sezione e' dichiarata `live`, la copia
 * per il Worker NON viene scritta (resta servita l'ultima su R2, che il
 * kill-switch l'aveva gia' applicato) — mai riaccendere una sezione spenta
 * perche' Remote Config non ha risposto.
 * Nello stesso caso il catalogo tiene `draft` le
 * sezioni dichiarate `live` (`killSwitch.held`): puo' restare indietro rispetto
 * al Worker, mai annunciare una sezione che il Worker serve ancora 404.
 *
 * ── Regole speculari al Worker ─────────────────────────────────────────────
 *
 * Il Worker scarta il registro INTERO se una voce e' fuori contratto e resta
 * sull'ultimo valido in memoria: un registro rifiutato e' quindi un cambio che
 * non arriva mai, in silenzio. Per questo qui si applicano le stesse regole
 * (prefissi, forma canonica dei path, target dei redirect, cicli) PRIMA di
 * pubblicare, e `validateEdgeSectionRegistry` rifa' il parse del Worker sul
 * documento emesso. Le costanti sono copie dichiarate (il Worker e' uno script
 * autonomo, non importabile): vedi generator/tests/section-registry.test.mjs.
 *
 * Solo builtin Node (regola di `scripts/lib/**`).
 */
import fs from 'node:fs';
import path from 'node:path';

import { ARTICLE_SECTION_CORE, ARTICLE_SECTION_CORE_ALL } from '../../engine/shared/articleSectionCore.mjs';

export const SECTION_REGISTRY_FILE = 'sections/registry.json';
export const SECTIONS_CATALOG_FILE = 'sections.json';
/** Path in `dist/api/` della copia per il Worker; la chiave R2 e' la stessa senza `dist/api/`. */
export const EDGE_SECTION_REGISTRY_FILE = 'edge/sections/registry.json';
export const SECTION_SITEMAP_INDEX_FILE = 'sitemap-cantons.xml';
export const SECTION_STATUSES = Object.freeze(['live', 'draft', 'retired']);
export const KILL_SWITCH_ENV = 'CANTON_ARTICLE_SECTIONS_KILL';
/** Il marker che load-rc-env.mjs scrive SOLO dopo aver letto il template di Remote Config. */
export const RC_LOADED_ENV = 'RC_ENV_LOADED';

const SITE = 'https://frontaliereticino.ch';
const LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);

// ── Copie dichiarate del Worker (locale-router.js) ───────────────────────────
// CORPUS_SEGMENT_RE, CORPUS_MAX_SEGMENTS, CORPUS_MAX_PATH_LENGTH,
// CORPUS_COMMIT_RE, CORPUS_REDIRECT_TARGET_RE.
const SEGMENT_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SEGMENTS = 4;
const MAX_PATH_LENGTH = 512;
const COMMIT_RE = /^[0-9a-f]{7,40}$/;
const REDIRECT_TARGET_RE = /^\/(?:(?!\/)[^\s\\?#]*\/)?$/;

const ENTRY_KEYS = new Set(['kind', 'canton', 'status', 'indexSlug', 'topics', 'redirects', 'gone']);
const TOP_KEYS = new Set(['_doc', 'schema', 'sections']);

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Le sezioni che il registro governa: le cantonali del core (attive o no), nell'ordine del core. */
export function registrySectionIds(all = ARTICLE_SECTION_CORE_ALL) {
  return Object.values(all)
    .filter((core) => core.kind === 'canton')
    .map((core) => core.section);
}

/** I 4 prefissi di una sezione, come `CORPUS_SECTION_ROUTES` del Worker (IT all'apex). */
export function sectionRoutes(id, all = ARTICLE_SECTION_CORE_ALL) {
  const core = all[id];
  if (!core) throw new Error(`sectionRoutes: sezione sconosciuta "${id}"`);
  return LOCALES.map((locale) => ({
    section: id,
    locale,
    prefix: locale === 'it' ? `/${core.indexSlug.it}` : `/${locale}/${core.indexSlug[locale]}`,
  }));
}

/** `matchCorpusSection` del Worker sull'insieme chiuso delle cantonali. */
export function matchSectionPath(pathname, all = ARTICLE_SECTION_CORE_ALL) {
  for (const id of registrySectionIds(all)) {
    for (const route of sectionRoutes(id, all)) {
      if (pathname === route.prefix || pathname === `${route.prefix}.html` || pathname.startsWith(`${route.prefix}/`)) {
        return route;
      }
    }
  }
  return null;
}

/** `corpusSectionCanonicalDir` del Worker: la forma `/x/` di un path di sezione, o null. */
export function canonicalSectionDir(pathname, route) {
  let dir = pathname;
  if (dir.endsWith('/index.html')) dir = dir.slice(0, -'index.html'.length);
  else if (dir.endsWith('.html')) dir = `${dir.slice(0, -'.html'.length)}/`;
  else if (!dir.endsWith('/')) dir = `${dir}/`;
  if (dir.length > MAX_PATH_LENGTH) return null;
  if (dir !== `${route.prefix}/` && !dir.startsWith(`${route.prefix}/`)) return null;
  const rest = dir.slice(route.prefix.length + 1, -1);
  if (rest === '') return dir;
  const segments = rest.split('/');
  if (segments.length > MAX_SEGMENTS) return null;
  return segments.every((seg) => SEGMENT_RE.test(seg)) ? dir : null;
}

function insideSection(p, id, all) {
  if (typeof p !== 'string') return false;
  const route = matchSectionPath(p, all);
  return Boolean(route && route.section === id && canonicalSectionDir(p, route) === p);
}

function redirectCycle(sections) {
  const next = new Map();
  for (const entry of Object.values(sections)) {
    for (const [from, to] of Object.entries(entry.redirects ?? {})) next.set(from, to);
  }
  for (const start of next.keys()) {
    const seen = new Set([start]);
    let cur = next.get(start);
    while (cur !== undefined && next.has(cur)) {
      if (seen.has(cur)) return start;
      seen.add(cur);
      cur = next.get(cur);
    }
  }
  return null;
}

/** Errori di `redirects`/`gone` di una voce, con le regole del Worker. */
function routingErrors(id, entry, all) {
  const errors = [];
  if (entry.redirects !== undefined) {
    if (!isPlainObject(entry.redirects)) {
      errors.push(`${id}.redirects: deve essere un oggetto { "<path>": "<target>" }`);
    } else {
      for (const [from, to] of Object.entries(entry.redirects)) {
        if (!insideSection(from, id, all)) errors.push(`${id}.redirects: "${from}" non e' un path canonico (/x/) della sezione`);
        if (typeof to !== 'string' || to.length > MAX_PATH_LENGTH || !REDIRECT_TARGET_RE.test(to)) {
          errors.push(`${id}.redirects["${from}"]: target "${to}" non e' un path same-origin che termina con /`);
        } else if (to === from) {
          errors.push(`${id}.redirects["${from}"]: redirect verso se stesso`);
        }
      }
    }
  }
  if (entry.gone !== undefined) {
    if (!Array.isArray(entry.gone)) {
      errors.push(`${id}.gone: deve essere un array di path`);
    } else {
      for (const p of entry.gone) {
        if (!insideSection(p, id, all)) errors.push(`${id}.gone: "${p}" non e' un path canonico (/x/) della sezione`);
        if (isPlainObject(entry.redirects) && Object.prototype.hasOwnProperty.call(entry.redirects, p)) {
          errors.push(`${id}.gone: "${p}" e' anche un redirect`);
        }
      }
    }
  }
  return errors;
}

function sameSlugs(a, b) {
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

/**
 * Gli errori del registro DICHIARATO (vuoto = valido). Insieme chiuso: ogni
 * sezione cantonale del core c'e' esattamente una volta, nessun'altra; i dati
 * che duplicano il core (`kind`, `canton`, `indexSlug`, `topics`) devono
 * coincidere col core, che resta la sorgente (AGENTS.md #6: qui si
 * dichiarano per chi legge il registro, ma un disaccordo e' un errore); una
 * sezione `live` deve essere ATTIVA nel core, altrimenti build-api non ne
 * pubblicherebbe ne' la sitemap ne' gli articoli e il Worker servirebbe 404
 * su una sezione dichiarata viva.
 *
 * @param {unknown} doc
 * @param {{ all?: Record<string, any>, active?: Record<string, any> }} [core]
 */
export function declaredRegistryErrors(doc, { all = ARTICLE_SECTION_CORE_ALL, active = ARTICLE_SECTION_CORE } = {}) {
  const errors = [];
  if (!isPlainObject(doc)) return ['il registro deve essere un oggetto JSON'];
  for (const key of Object.keys(doc)) if (!TOP_KEYS.has(key)) errors.push(`chiave sconosciuta "${key}" al livello superiore`);
  if (doc.schema !== 1) errors.push(`schema ${JSON.stringify(doc.schema)}: atteso 1`);
  if (!isPlainObject(doc.sections)) return [...errors, '"sections" deve essere un oggetto { <id>: {...} }'];
  const expected = registrySectionIds(all);
  for (const id of expected) if (!Object.prototype.hasOwnProperty.call(doc.sections, id)) errors.push(`${id}: manca dal registro`);
  for (const [id, entry] of Object.entries(doc.sections)) {
    if (!expected.includes(id)) {
      errors.push(`${id}: non e' una sezione cantonale del core`);
      continue;
    }
    if (!isPlainObject(entry)) {
      errors.push(`${id}: la voce deve essere un oggetto`);
      continue;
    }
    for (const key of Object.keys(entry)) if (!ENTRY_KEYS.has(key)) errors.push(`${id}: chiave sconosciuta "${key}"`);
    const core = all[id];
    if (entry.kind !== core.kind) errors.push(`${id}.kind "${entry.kind}": il core dice "${core.kind}"`);
    if (entry.canton !== core.canton) errors.push(`${id}.canton "${entry.canton}": il core dice "${core.canton}"`);
    if (!SECTION_STATUSES.includes(entry.status)) errors.push(`${id}.status "${entry.status}": atteso ${SECTION_STATUSES.join('|')}`);
    if (!sameSlugs(entry.indexSlug, core.indexSlug)) errors.push(`${id}.indexSlug diverge dal core`);
    const topicIds = Object.keys(core.topicHubs ?? {});
    if (
      !isPlainObject(entry.topics) ||
      Object.keys(entry.topics).join(',') !== topicIds.join(',') ||
      !topicIds.every((t) => sameSlugs(entry.topics[t], core.topicHubs[t]))
    ) {
      errors.push(`${id}.topics diverge dagli hub tematici del core (stessi temi, stesso ordine, stessi slug)`);
    }
    if (entry.status === 'live' && !Object.prototype.hasOwnProperty.call(active, id)) {
      errors.push(`${id}: dichiarata live ma non attiva nel core (ACTIVE_CANTON_SECTIONS) — nessuna sua pagina verrebbe pubblicata`);
    }
    errors.push(...routingErrors(id, entry, all));
  }
  const cycleFrom = redirectCycle(doc.sections);
  if (cycleFrom) errors.push(`redirect circolare a partire da "${cycleFrom}"`);
  return errors;
}

/** Legge e valida `sections/registry.json`; lancia con TUTTI gli errori. */
export function loadDeclaredRegistry(root, core) {
  const file = path.join(root, SECTION_REGISTRY_FILE);
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${SECTION_REGISTRY_FILE} illeggibile: ${error.message}`, { cause: error });
  }
  const errors = declaredRegistryErrors(doc, core);
  if (errors.length) throw new Error(`${SECTION_REGISTRY_FILE} non valido:\n  ${errors.join('\n  ')}`);
  return doc;
}

// ── Sorgenti di una sezione di famiglia ─────────────────────────────────────

/**
 * Se un file sorgente di una sezione di FAMIGLIA manca legittimamente.
 * Una sezione appena accesa non ha ancora nessun file (create-article li crea
 * tutti insieme al primo articolo): e' «nuova» se manca il REGISTRO, e allora
 * devono mancare anche mappa slug e meta. Ogni insieme parziale lancia:
 * trattarlo come vuoto pubblicherebbe una famiglia troncata con registro,
 * sitemap e counts concordi.
 *
 * @returns {boolean} true = file assente di una sezione nuova (vale vuoto); false = file presente
 */
export function familySourceMissing({ section, rel, registryRel, present, registryPresent }) {
  if (present === registryPresent) return !present;
  throw new Error(
    present
      ? `${rel} esiste ma ${registryRel} no: sezione ${section} parziale — refusing`
      : `${rel} assente mentre ${registryRel} esiste: sezione ${section} parziale — refusing`,
  );
}

/**
 * Gli slug IT degli articoli che il registro dichiarato ritira (`gone`) o
 * sposta (`redirects`) in ALMENO una locale: il registro accetta path canonici
 * in qualsiasi lingua, e la voce di sitemap di un articolo porta la loc IT e
 * i quattro alternate insieme, quindi una sola variante 410/301 toglie
 * l'articolo intero.
 *
 * @param {{ redirects?: Record<string, string>, gone?: string[] } | undefined} entry voce del registro
 * @param {Record<string, Record<string, string>>} slugMap id → slug per locale
 * @param {Record<string, string>} prefixes prefisso della sezione per locale (`/articoli-x/`)
 */
export function registryRetiredSlugs(entry, slugMap, prefixes) {
  if (!entry) return [];
  const moved = new Set([...Object.keys(entry.redirects ?? {}), ...(entry.gone ?? [])]);
  if (moved.size === 0) return [];
  return Object.values(slugMap ?? {})
    .filter((slugs) => LOCALES.some((loc) => slugs?.[loc] && moved.has(`${prefixes[loc]}${slugs[loc]}/`)))
    .map((slugs) => slugs?.it)
    .filter(Boolean);
}

// ── Kill-switch ──────────────────────────────────────────────────────────────

/**
 * @param {string | undefined} raw valore di `CANTON_ARTICLE_SECTIONS_KILL`
 * @returns {{ sections: string[], unknown: string[] }} id spenti (ordine del core) e token non riconosciuti
 */
export function parseKillSwitch(raw, all = ARTICLE_SECTION_CORE_ALL) {
  const ids = registrySectionIds(all);
  const byCode = new Map(ids.map((id) => [String(all[id].canton).toUpperCase(), id]));
  const killed = new Set();
  const unknown = [];
  for (const token of String(raw ?? '').split(/[\s,;]+/).filter(Boolean)) {
    const lower = token.toLowerCase();
    if (lower === 'all' || lower === '*') {
      for (const id of ids) killed.add(id);
    } else if (ids.includes(lower)) {
      killed.add(lower);
    } else if (byCode.has(token.toUpperCase())) {
      killed.add(byCode.get(token.toUpperCase()));
    } else {
      unknown.push(token);
    }
  }
  return { sections: ids.filter((id) => killed.has(id)), unknown };
}

/**
 * Lo stato del kill-switch letto dall'ambiente. `verified` solo se il loader di
 * Remote Config ha scritto il suo marker di successo.
 */
export function resolveKillSwitch(env = process.env, all = ARTICLE_SECTION_CORE_ALL) {
  const raw = env[KILL_SWITCH_ENV];
  const { sections, unknown } = parseKillSwitch(raw, all);
  return { state: env[RC_LOADED_ENV] === '1' ? 'verified' : 'unverified', sections, unknown };
}

/**
 * Stato effettivo per sezione: `live` dichiarato e spento → `draft`.
 *
 * FAIL-CLOSED senza verifica: se il kill-switch non e' verificabile, nessuna
 * sezione dichiarata `live` esce `live` (`held: true`). In quel caso la copia
 * per il Worker non viene scritta (`edgeRegistryPublishable`) e su R2 resta
 * l'ultimo registro verificato; se il catalogo dicesse comunque `live`, alla
 * prima attivazione annuncerebbe pagine che il Worker serve ancora 404. Il
 * catalogo puo' quindi restare indietro rispetto al Worker (nasconde una
 * sezione gia' servita) ma mai avanti.
 *
 * @returns {Record<string, { declared: string, status: string, killed: boolean, held: boolean }>}
 */
export function effectiveStatuses(declared, killSwitch) {
  const killed = new Set(killSwitch.sections);
  const verified = killSwitch.state === 'verified';
  return Object.fromEntries(
    Object.entries(declared.sections).map(([id, entry]) => {
      const live = entry.status === 'live';
      const off = live && killed.has(id);
      const held = live && !off && !verified;
      return [id, { declared: entry.status, status: off || held ? 'draft' : entry.status, killed: off, held }];
    }),
  );
}

/**
 * La copia per il Worker si scrive solo se il kill-switch e' verificato, o se
 * nessuna sezione e' dichiarata `live` (allora il kill-switch non ha niente da
 * spegnere e il documento e' lo stesso in ogni caso).
 */
export function edgeRegistryPublishable(declared, killSwitch) {
  return killSwitch.state === 'verified' || !Object.values(declared.sections).some((entry) => entry.status === 'live');
}

// ── Documenti pubblicati ─────────────────────────────────────────────────────

/** `edge/sections/registry.json`, nel formato di `parseCorpusSectionRegistry`. */
export function buildEdgeRegistry({ declared, effective, commit }) {
  const sections = {};
  for (const [id, entry] of Object.entries(declared.sections)) {
    const out = { status: effective[id].status };
    if (entry.redirects && Object.keys(entry.redirects).length) out.redirects = { ...entry.redirects };
    if (entry.gone && entry.gone.length) out.gone = [...entry.gone];
    sections[id] = out;
  }
  return { schema: 1, commit, sections };
}

/**
 * Il parse del Worker sul documento emesso: true se il Worker lo accetterebbe.
 * Stesse condizioni di `parseCorpusSectionRegistry` (vedi l'header).
 */
export function validateEdgeSectionRegistry(raw, all = ARTICLE_SECTION_CORE_ALL) {
  if (!isPlainObject(raw) || raw.schema !== 1) return false;
  if (typeof raw.commit !== 'string' || !COMMIT_RE.test(raw.commit)) return false;
  if (!isPlainObject(raw.sections)) return false;
  const ids = registrySectionIds(all);
  for (const [id, entry] of Object.entries(raw.sections)) {
    if (!ids.includes(id)) return false;
    if (!isPlainObject(entry) || !SECTION_STATUSES.includes(entry.status)) return false;
    if (routingErrors(id, entry, all).length) return false;
  }
  return redirectCycle(raw.sections) === null;
}

/**
 * `dist/api/sections.json`: il catalogo delle sezioni per il sito. `articles`
 * per id (0 per una sezione non attiva o senza registro).
 */
export function buildSectionsCatalog({ declared, effective, killSwitch, commit, articles = {}, sitemapOf }) {
  return {
    schema: 1,
    commit,
    killSwitch: {
      state: killSwitch.state,
      applied: Object.keys(effective).filter((id) => effective[id].killed),
      // Sezioni dichiarate live e tenute draft perche' Remote Config non e' verificato.
      held: Object.keys(effective).filter((id) => effective[id].held),
      unknown: killSwitch.unknown,
    },
    sections: Object.entries(declared.sections).map(([id, entry]) => {
      const live = effective[id].status === 'live';
      return {
        id,
        kind: entry.kind,
        canton: entry.canton,
        status: effective[id].status,
        declaredStatus: entry.status,
        indexSlug: { ...entry.indexSlug },
        paths: Object.fromEntries(sectionRoutes(id).map((r) => [r.locale, `${r.prefix}/`])),
        topics: Object.entries(entry.topics).map(([topic, slug]) => ({ id: topic, slug: { ...slug } })),
        counts: { articles: articles[id] ?? 0 },
        sitemap: live ? `/${sitemapOf(id)}` : null,
      };
    }),
  };
}

/**
 * `sitemap-cantons.xml`, l'indice delle sitemap per sezione (dichiarato in
 * robots.txt). Una voce per sezione `live`; `null` se non ce n'e' nessuna,
 * perche' un `<sitemapindex>` senza `<sitemap>` viola lo schema (minimo 1): in
 * quel caso l'indice non si emette e il Worker risponde 404, come prima.
 *
 * @param {Array<{ file: string, lastmod?: string | null }>} sitemaps
 */
export function buildSitemapIndex(sitemaps) {
  if (!Array.isArray(sitemaps)) throw new Error('buildSitemapIndex: atteso un array di { file, lastmod? }');
  if (!sitemaps.length) return null;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const blocks = sitemaps.map(({ file, lastmod }) => {
    const parts = ['  <sitemap>', `    <loc>${SITE}/${esc(file)}</loc>`];
    if (lastmod) parts.push(`    <lastmod>${esc(lastmod)}</lastmod>`);
    parts.push('  </sitemap>');
    return parts.join('\n');
  });
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    blocks.join('\n') +
    '\n</sitemapindex>\n'
  );
}

/** La data piu' recente (`updatedAt` o `date`) di un registro, per il `<lastmod>` dell'indice. */
export function latestArticleDate(entries) {
  let best = null;
  for (const entry of entries ?? []) {
    // Un `updatedAt` illeggibile non deve nascondere una `date` valida.
    const value = [entry?.updatedAt, entry?.date].find((v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)));
    if (value === undefined) continue;
    if (best === null || Date.parse(value) > Date.parse(best)) best = value;
  }
  // `<lastmod>` vuole una data W3C: una stringa leggibile da Date.parse ma
  // non ISO («Oct 5, 2026») si normalizza invece di finire tale e quale nell'XML.
  if (best !== null && !/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/.test(best)) return new Date(best).toISOString();
  return best;
}
