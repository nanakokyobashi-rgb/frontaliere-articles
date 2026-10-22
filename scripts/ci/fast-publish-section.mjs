#!/usr/bin/env node
/**
 * fast-publish-section.mjs — sezione e shard di un fast-publish, dal core.
 *
 * `fast-publish-article.yml` deduceva la sezione con un `case` sul path
 * (`content/blog-body-ch/*` → svizzera, tutto il resto → frontaliere) e lo
 * shard con un ternario (`svizzera` → articolisvizzera, altrimenti
 * articolifrontaliere), ripetuto in quattro step. Due difetti nella stessa
 * forma: una sezione nuova finiva in silenzio su frontaliere, e il suo
 * articolo veniva spinto nello shard di un'altra sezione.
 *
 * Qui tutto viene da `ARTICLE_SECTION_CORE` (sezioni ATTIVE):
 *
 *   body-regex [shard|r2]  l'ERE che riconosce un corpo di QUALSIASI sezione
 *                          attiva (`^content/(blog-body|blog-body-ch)/[a-z]{2}/.+\.ts$`);
 *                          con `shard` solo le sezioni servite da uno shard
 *                          Pages (cio' che fast-publish-article.yml pubblica),
 *                          con `r2` solo quelle servite da R2 + Worker (le
 *                          cantonali, pubblicate da fast-publish-section.yml).
 *                          Senza sezioni del tipo chiesto l'ERE non combacia
 *                          con niente.
 *   body-plan [shard|r2]   legge da stdin i file cambiati e stampa i body
 *                          pubblicabili raggruppati per sezione. I body orfani
 *                          dal registry restano in `skippedIds`: non possono
 *                          essere renderizzati e non devono bloccare gli ID
 *                          validi dello stesso commit.
 *   article-plan [shard|r2]
 *                          confronta il push base con il checkout sulle
 *                          superfici SEO/meta/slug/registry e stampa gli ID
 *                          articolo realmente cambiati. Serve a riattivare il
 *                          renderer anche quando il body non è toccato.
 *   r2-plan                legge da stdin i file cambiati (uno per riga; accetta
 *                          anche `git diff --name-status`) e stampa la matrice
 *                          JSON `[{section, ids, bootstrap, removeStaleCantonRssFeeds?}]`
 *                          delle sezioni R2 da ripubblicare
 *   r2-reconcile-plan <sha> legge il registro edge effettivo della release
 *                          attesa e stampa la matrice delle sezioni cantonali
 *                          R2 live, il cleanup RSS delle non-live e la pulizia
 *                          delle sezioni disattivate ancora note al Worker
 *   section-of <path>      la sezione che possiede quel corpo (esce 1 se nessuna)
 *   shard-of <section>     lo shard Pages della sezione. Una sezione con
 *                          `shardKey: null` (le cantonali) e' servita da R2 +
 *                          Worker, non da uno shard: esce 1 con un errore
 *                          esplicito invece di ripiegare su uno shard altrui.
 *
 * Solo builtin Node: gira nel primo step del workflow, prima di setup-node.
 */
import '../../host/cantonSectionsBootstrap.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { activeCorpusCoreEntries, activeSourceSections, sectionForBodyPath, sectionSourceSurfaces } from '../lib/corpus-sections.mjs';
import { articleRegistryObjectBodies, articleRegistryObjectFields } from '../../engine/shared/articleRegistryObjectBodies.mjs';
import { parseArticleUrlSlugs } from '../../engine/shared/articleReaderSource.mjs';
import { ARTICLE_SECTION_CORE_ALL } from '../../engine/shared/articleSectionCore.mjs';
import { EDGE_SECTION_REGISTRY_URL, validateEdgeSectionRegistry } from '../lib/section-registry.mjs';
import { findAllSeoEntryMatches } from '../lib/seo-entry.mjs';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Cambiare uno di questi moduli cambia il risultato di ogni publisher R2,
// non una sola sezione: il workflow deve quindi rifare il bootstrap di tutte
// le sezioni cantonali R2 attive, invece di produrre una matrice vuota.
const SHARED_R2_REFRESH_PATHS = new Set([
  'generator/scripts/lib/canton-hubs/paths.mjs',
  'generator/scripts/lib/corpus-paths.mjs',
  'generator/scripts/lib/control-char-write-report.mjs',
  'scripts/ci/fast-publish-section.mjs',
  'scripts/cf-purge-cache.mjs',
  'scripts/lib/article-render-pipeline.mjs',
  'scripts/lib/cf-analytics.mjs',
  'scripts/lib/canton-hub-data.mjs',
  'scripts/lib/canton-hub-content.mjs',
  'scripts/lib/cdn-asset-existence.mjs',
  'scripts/lib/cf-purge-variants.mjs',
  'scripts/lib/delete-cdn-file.sh',
  'scripts/lib/corpus-floors.mjs',
  'scripts/lib/corpus-sections.mjs',
  'scripts/lib/engine-corpus-view.mjs',
  'scripts/lib/sanitize-control-chars.mjs',
  'scripts/lib/section-registry.mjs',
  'scripts/lib/assert-hub-locale-slug.mjs',
  'scripts/lib/upload-cdn-file.sh',
  'scripts/lib/r2-image-lease-process.sh',
  'scripts/lib/r2-image-namespace-lock.mjs',
  'scripts/lib/r2-section-lock.mjs',
  'scripts/lib/is-invoked-directly.mjs',
  'scripts/lib/npm-ci-retry.sh',
  'scripts/lib/parse-positive-num.mjs',
  'scripts/ci/retry-cmd.sh',
  'scripts/lib/section-page-manifest.mjs',
  'generator/scripts/load-rc-env.mjs',
  'scripts/offload-generated-images-cdn.mjs',
  'scripts/publish-section-edge.mjs',
  'scripts/publish-section-pages.mjs',
]);
const SHARED_R2_REFRESH_PREFIXES = Object.freeze(['engine/', 'host/']);

const isSharedR2RefreshPath = (rel) =>
  SHARED_R2_REFRESH_PATHS.has(rel) || SHARED_R2_REFRESH_PREFIXES.some((prefix) => rel.startsWith(prefix));

function changedFileRecords(files) {
  const changedFiles = [];
  for (const raw of files) {
    const line = String(raw ?? '').trimEnd();
    if (!line.trim()) continue;
    const fields = line.split('\t');
    if (fields.length === 1) {
      changedFiles.push({ rel: fields[0].trim(), status: 'M' });
      continue;
    }
    const status = fields[0].trim().charAt(0) || 'M';
    // `--name-status` gives R<score> old new and C<score> old new. A rename or
    // copy is a change to both image paths for publication purposes.
    const paths = status === 'R' || status === 'C' ? fields.slice(1) : fields.slice(1, 2);
    for (const rel of paths) changedFiles.push({ rel: rel.trim(), status });
  }
  return changedFiles;
}

function sourceText(readSource, rel) {
  if (typeof readSource !== 'function') return null;
  const source = readSource(rel);
  return source === undefined || source === null ? null : String(source);
}

function mapRecord(map, id, value) {
  const previous = map.get(id);
  map.set(id, previous === undefined ? value : `${previous}\n${value}`);
}

function changedRecordIds(previous, next) {
  const ids = new Set([...previous.keys(), ...next.keys()]);
  return [...ids].filter((id) => previous.get(id) !== next.get(id));
}

function registryRecords(source) {
  const records = new Map();
  if (source === null) return records;
  for (const body of articleRegistryObjectBodies(source)) {
    const id = articleRegistryObjectFields(body).get('id');
    if (id) mapRecord(records, id, body);
  }
  return records;
}

function seoRecords(source, rel) {
  const records = new Map();
  if (source === null) return records;
  for (const match of findAllSeoEntryMatches(source, rel)) {
    mapRecord(records, match.id, source.slice(match.index, match.closeIdx + 1));
  }
  return records;
}

/**
 * Meta chunks are flat string maps, but a field value can contain commas and
 * newlines. Group from one article key to the next instead of splitting on a
 * comma: the planner compares the complete per-article source record.
 */
function metaRecords(source) {
  const records = new Map();
  if (source === null) return records;
  const keyRe = /^[\t ]*(['"])blog\.article\.([^'"]+)\.[A-Za-z][A-Za-z0-9]*\1\s*:/gm;
  const matches = [...source.matchAll(keyRe)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const end = matches[index + 1]?.index ?? source.length;
    mapRecord(records, match[2], source.slice(match.index, end));
  }
  return records;
}

function slugRecordMap(source, ids, slugExport) {
  const records = new Map();
  if (source === null) return records;
  // Read only the named slug export. The same source file also carries
  // BLOG_SLUG_FALLBACK_REASONS/SWISS_SLUG_FALLBACK_REASONS; scanning every
  // object-shaped entry lets a fallback-reason record overwrite the real slug
  // record for the same article id and can wake the wrong publisher target.
  const slugMap = parseArticleUrlSlugs(source, slugExport);
  for (const [id, locales] of Object.entries(slugMap)) {
    if (ids.has(id)) records.set(id, JSON.stringify(locales));
  }
  return records;
}

function slugRecords(previousSource, nextSource, ids, slugExport) {
  return {
    previous: slugRecordMap(previousSource, ids, slugExport),
    next: slugRecordMap(nextSource, ids, slugExport),
  };
}

function canonicalOverrideRecords(source) {
  const records = new Map();
  if (source === null) return records;
  const document = JSON.parse(source);
  const overrides = document?.overrides;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('canonical override map: manca overrides');
  }
  for (const [slug, canonical] of Object.entries(overrides)) records.set(slug, JSON.stringify(canonical));
  return records;
}

function canonicalIdsForSlugs(slugs, slugRecordMaps, candidateIds) {
  const out = new Set();
  for (const id of candidateIds) {
    const records = slugRecordMaps.map((records) => records.get(id)).filter(Boolean);
    for (const slug of slugs) {
      const literal = new RegExp(`['"]${escapeRe(slug)}['"]`);
      if (records.some((record) => literal.test(record))) {
        out.add(id);
        break;
      }
    }
  }
  return out;
}

function canonicalOverrideChangedIds(previous, next, previousSlugRecords, nextSlugRecords, candidateIds) {
  const changedSlugs = changedRecordIds(previous, next);
  return canonicalIdsForSlugs(changedSlugs, [previousSlugRecords, nextSlugRecords], candidateIds);
}

function articleSurfaceKind(rel, section) {
  const surfaces = sectionSourceSurfaces(section.section);
  if (rel === surfaces.registryFile) return 'registry';
  if (rel === surfaces.slugFile) return 'slug';
  if (surfaces.canonicalOverrides && rel === surfaces.canonicalOverrides) return 'canonical';
  const metaPrefix = `${surfaces.metaPrefix}-`;
  if (rel.startsWith(metaPrefix) && /^[a-z]{2}\.ts$/.test(rel.slice(metaPrefix.length))) return 'meta';
  if (section.kind === 'frontaliere' && /^content\/seo\/seo-blog(?:-\d+)?\.ts$/.test(rel)) return 'seo';
  if (section.kind === 'national' && rel === 'content/seo/seo-blog-ch.ts') return 'seo';
  return null;
}

function repoPathAtRevision(rel) {
  try {
    const resolved = realpathSync(rel).replaceAll('\\', '/');
    const root = process.cwd().replaceAll('\\', '/').replace(/\/$/, '');
    if (resolved.startsWith(`${root}/`)) return resolved.slice(root.length + 1);
  } catch {
    // A deleted path has no realpath; the original repo-relative path is the
    // right lookup for a normal file and the caller will treat a missing blob
    // as a deleted source.
  }
  return rel;
}

function gitSourceAtRevision(revision, rel) {
  if (!revision) return null;
  try {
    return execFileSync('git', ['show', `${revision}:${repoPathAtRevision(rel)}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const diagnostic = String(error?.stderr ?? '');
    // A file added by this push has no base blob. Any other git failure is a
    // broken comparison input and must stop the resolver, not widen the plan.
    if (error?.status === 128 && /does not exist in|exists on disk, but not in/.test(diagnostic)) return null;
    throw new Error(`git show ${revision}:${repoPathAtRevision(rel)} failed: ${diagnostic.trim() || error?.message || error}`);
  }
}

function imageKeyFromPublicPath(rel) {
  const raw = String(rel ?? '').replaceAll('\\', '/').split(/[?#]/, 1)[0];
  if (!raw.startsWith('public/images/')) return null;
  const key = raw.slice('public/'.length);
  return key.includes('..') ? null : key;
}

function imageKeyFromReference(reference) {
  const raw = String(reference ?? '').trim();
  if (!raw) return null;
  try {
    const pathname = /^https?:\/\//i.test(raw) ? new URL(raw).pathname : new URL(raw, 'https://cdn.frontaliereticino.ch').pathname;
    const key = pathname.replace(/^\/+/, '').split(/[?#]/, 1)[0];
    return key.startsWith('images/') && !key.includes('..') ? key : null;
  } catch {
    return null;
  }
}

/**
 * Return the article ids whose registry image is one of the changed public
 * image files. The registry is the source of ownership: an image-only commit
 * must wake the same section/id publisher as a body commit, while an image
 * shared by several records wakes all of them.
 */
export function imageArticleOwners(files, coreList = activeCorpusCoreEntries()) {
  const keys = new Set(changedFileRecords(files).map(({ rel }) => imageKeyFromPublicPath(rel)).filter(Boolean));
  if (keys.size === 0) return new Map();
  const owners = new Map();
  for (const section of activeSourceSections(coreList)) {
    const registryFile = sectionSourceSurfaces(section.section).registryFile;
    if (!existsSync(registryFile)) continue;
    const source = readFileSync(registryFile, 'utf8');
    for (const body of articleRegistryObjectBodies(source)) {
      const fields = articleRegistryObjectFields(body);
      const imageKey = imageKeyFromReference(fields.get('image'));
      const articleId = fields.get('id');
      if (!articleId || !imageKey || !keys.has(imageKey)) continue;
      if (!owners.has(section.section)) owners.set(section.section, new Set());
      owners.get(section.section).add(articleId);
    }
  }
  return owners;
}

/** JSON plan used by both workflow resolvers for an image-only push. */
export function imagePublishPlan(files, coreList = activeCorpusCoreEntries(), { served } = {}) {
  if (served !== undefined && served !== 'shard' && served !== 'r2') throw new Error(`image-plan: tipo "${served}" sconosciuto (shard | r2)`);
  const sections = new Set(
    activeSourceSections(coreList)
      .filter((s) => served === undefined || (served === 'shard') === Boolean(s.shardKey))
      .map((s) => s.section),
  );
  const owners = imageArticleOwners(files, coreList);
  return activeSourceSections(coreList)
    .filter((s) => sections.has(s.section) && owners.has(s.section))
    .map((s) => ({ section: s.section, ids: [...owners.get(s.section)].sort(), bootstrap: false }));
}

/**
 * Article-facing source changes must wake the article renderer even when no
 * body or public image changed. In particular, an SEO-only correction used to
 * produce a green resolver with an empty matrix: the corpus was fixed, but
 * the already-served HTML (and its og:image) stayed stale on the site.
 *
 * Compare keyed records between the push base and the checkout so a change in
 * one large generated chunk wakes only its article ids. The registry remains
 * the admission list: removed/orphaned ids never reach the renderer.
 */
export function articlePublishPlan(
  files,
  coreList = activeCorpusCoreEntries(),
  {
    served,
    readCurrentSource = (rel) => (existsSync(rel) ? readFileSync(rel, 'utf8') : null),
    readPreviousSource = () => null,
    articleIdsForSection = registryArticleIds,
  } = {},
) {
  if (served !== undefined && served !== 'shard' && served !== 'r2') {
    throw new Error(`article-plan: tipo "${served}" sconosciuto (shard | r2)`);
  }
  const sections = activeSourceSections(coreList)
    .filter((section) => served === undefined || (served === 'shard') === Boolean(section.shardKey));
  const sectionBySurface = sections.flatMap((section) => [{ section, kind: section }]);
  const registeredBySection = new Map(
    sections.map((section) => [section.section, new Set(articleIdsForSection(section))]),
  );
  const targets = new Map(sections.map((section) => [section.section, new Set()]));

  for (const { rel } of changedFileRecords(files)) {
    const owner = sectionBySurface.find(({ section }) => articleSurfaceKind(rel, section));
    if (!owner) continue;

    const { section } = owner;
    const kind = articleSurfaceKind(rel, section);
    const previous = sourceText(readPreviousSource, rel);
    const next = sourceText(readCurrentSource, rel);
    let changedIds;

    if (kind === 'registry') {
      changedIds = changedRecordIds(registryRecords(previous), registryRecords(next));
    } else if (kind === 'seo') {
      changedIds = changedRecordIds(seoRecords(previous, rel), seoRecords(next, rel));
    } else if (kind === 'meta') {
      changedIds = changedRecordIds(metaRecords(previous), metaRecords(next));
    } else if (kind === 'slug') {
      const registryBefore = registryRecords(sourceText(readPreviousSource, section.registryFile));
      const registryAfter = registryRecords(sourceText(readCurrentSource, section.registryFile));
      const slug = slugRecords(
        previous,
        next,
        new Set([...registryBefore.keys(), ...registryAfter.keys()]),
        section.slugExport,
      );
      changedIds = changedRecordIds(slug.previous, slug.next);
    } else if (kind === 'canonical') {
      const registryBefore = registryRecords(sourceText(readPreviousSource, section.registryFile));
      const registryAfter = registryRecords(sourceText(readCurrentSource, section.registryFile));
      const candidateIds = new Set([...registryBefore.keys(), ...registryAfter.keys()]);
      const slug = slugRecords(
        sourceText(readPreviousSource, section.slugFile),
        sourceText(readCurrentSource, section.slugFile),
        candidateIds,
        section.slugExport,
      );
      changedIds = [...canonicalOverrideChangedIds(
        canonicalOverrideRecords(previous),
        canonicalOverrideRecords(next),
        slug.previous,
        slug.next,
        candidateIds,
      )];
    } else {
      changedIds = [];
    }

    const registered = registeredBySection.get(section.section);
    for (const id of changedIds) {
      if (registered.has(id)) targets.get(section.section).add(id);
    }
  }

  return sections
    .filter((section) => targets.get(section.section).size > 0)
    .map((section) => ({
      section: section.section,
      ids: [...targets.get(section.section)].sort(),
      bootstrap: false,
    }));
}

/** Promozioni e demozioni cantonali R2 fra due versioni del registro. */
export function liveRegistryTransitions(previousRegistry, nextRegistry, coreList = activeCorpusCoreEntries()) {
  const readSections = (doc, label) => {
    if (!doc || doc.schema !== 1 || !doc.sections || typeof doc.sections !== 'object' || Array.isArray(doc.sections)) {
      throw new Error(`${label}: sections/registry.json non valido`);
    }
    return doc.sections;
  };
  const previous = readSections(previousRegistry, 'registro precedente');
  const next = readSections(nextRegistry, 'registro nuovo');
  const r2CantonSections = new Set(
    activeSourceSections(coreList).filter((section) => section.kind === 'canton' && !section.shardKey).map((section) => section.section),
  );
  const sectionIds = [...new Set([...Object.keys(next), ...Object.keys(previous)])];
  const transitions = [];
  for (const section of sectionIds) {
    const previousStatus = previous[section]?.status;
    const nextStatus = next[section]?.status;
    const promoted = nextStatus === 'live' && previousStatus !== 'live';
    const demoted = previousStatus === 'live' && nextStatus !== 'live';
    if (!promoted && !demoted) continue;
    if (!r2CantonSections.has(section)) {
      const verb = promoted ? 'promuove a live' : 'ritira da live';
      throw new Error(`sections/registry.json ${verb} una sezione R2 non attiva nel core: ${section}`);
    }
    transitions.push({ section, removeStaleCantonRssFeeds: demoted });
  }
  return transitions;
}

/** Nomi delle sezioni cantonali R2 che hanno cambiato stato live/non-live. */
export function liveRegistryTransitionSections(previousRegistry, nextRegistry, coreList = activeCorpusCoreEntries()) {
  return liveRegistryTransitions(previousRegistry, nextRegistry, coreList).map(({ section }) => section);
}

/**
 * Piano bounded per una release API avviata da schedule/manuale. Non usa il
 * registro committato ne' il diff Git: il registro edge e' la superficie che
 * il Worker serve davvero, ma deve appartenere alla release attesa. Le
 * cantonali attive vengono riconciliate; le non-live ricevono il cleanup RSS.
 * Se una sezione e' stata disattivata nel core ma il registro edge la dichiara
 * ancora live o retired, invia una pulizia della superficie: il publisher
 * rimuove pagine e feed senza riattivare/renderizzare la sezione.
 */
export function liveR2ReconciliationPlan(
  registry,
  coreList = activeCorpusCoreEntries(),
  expectedCommit,
  allCore = ARTICLE_SECTION_CORE_ALL,
) {
  if (!validateEdgeSectionRegistry(registry)) {
    throw new Error('registro edge effettivo non valido');
  }
  const expected = typeof expectedCommit === 'string' ? expectedCommit.trim() : '';
  if (!expected) throw new Error('commit della release API attesa non disponibile');
  if (registry.commit !== expected) {
    throw new Error(`registro edge sul commit ${registry.commit}, atteso ${expected}`);
  }
  const live = new Set(
    Object.entries(registry.sections)
      .filter(([, entry]) => entry?.status === 'live')
      .map(([section]) => section),
  );
  const activeCantonSections = coreList
    .filter((section) => section.kind === 'canton' && !section.shardKey)
    .map((section) => section.section);
  const active = new Set(activeCantonSections);
  const plan = coreList
    .filter((section) => section.kind === 'canton' && !section.shardKey)
    .map((section) => live.has(section.section)
      ? { section: section.section, ids: [], bootstrap: true }
      : { section: section.section, ids: [], bootstrap: false, removeStaleCantonRssFeeds: true });
  for (const section of Object.values(allCore)) {
    if (section.kind !== 'canton' || section.shardKey || active.has(section.section)) continue;
    const status = registry.sections[section.section]?.status;
    if (status !== 'live' && status !== 'retired') continue;
    plan.push({
      section: section.section,
      ids: [],
      bootstrap: false,
      removeStaleCantonRssFeeds: true,
      cleanupInactiveSurface: true,
    });
  }
  return plan;
}

/**
 * A successful API push can change canton RSS bytes even when its diff only
 * touched an API-generation input that r2PublishPlan cannot map to one canton.
 * Keep article work scoped to the originating diff, but refresh the
 * non-article surfaces (landing/archive/hubs/RSS) of every currently-live
 * section. Non-live cleanup from the edge registry remains authoritative.
 */
export function r2ApiPushPlan(diffPlan, edgePlan, coreList = activeCorpusCoreEntries()) {
  if (!Array.isArray(diffPlan) || !Array.isArray(edgePlan)) {
    throw new Error('r2 API push plan: diff ed edge devono essere matrici');
  }
  const sections = activeSourceSections(coreList).filter((section) => !section.shardKey);
  const active = new Set(sections.map(({ section }) => section));
  const inactiveCleanupSections = Object.values(ARTICLE_SECTION_CORE_ALL)
    .filter((section) => section.kind === 'canton' && !section.shardKey && !active.has(section.section));
  const orderedSections = [...sections, ...inactiveCleanupSections];
  const bySection = new Map();
  const assertSection = (section, { cleanupInactiveSurface = false } = {}) => {
    if (cleanupInactiveSurface) {
      const known = ARTICLE_SECTION_CORE_ALL[section];
      if (!known || known.kind !== 'canton' || known.shardKey) {
        throw new Error(`r2 API push plan cleanup-only per sezione R2 sconosciuta: ${section}`);
      }
      if (active.has(section)) {
        throw new Error(`r2 API push plan cleanup-only non consentito per sezione attiva: ${section}`);
      }
      return;
    }
    if (!sections.some((entry) => entry.section === section && entry.kind === 'canton')) {
      throw new Error(`r2 API push plan per sezione R2 non attiva: ${section}`);
    }
  };
  for (const target of diffPlan) {
    assertSection(target?.section);
    bySection.set(target.section, {
      section: target.section,
      ids: Array.isArray(target.ids) ? [...target.ids] : [],
      bootstrap: target.bootstrap === true,
      ...(target.removeStaleCantonRssFeeds === true ? { removeStaleCantonRssFeeds: true } : {}),
    });
  }
  for (const target of edgePlan) {
    assertSection(target?.section, { cleanupInactiveSurface: target?.cleanupInactiveSurface === true });
    if (target?.cleanupInactiveSurface === true) {
      bySection.set(target.section, {
        section: target.section,
        ids: [],
        bootstrap: false,
        removeStaleCantonRssFeeds: true,
        cleanupInactiveSurface: true,
      });
      continue;
    }
    const current = bySection.get(target.section);
    if (target.removeStaleCantonRssFeeds === true) {
      bySection.set(target.section, {
        ...(current ?? { section: target.section, ids: [], bootstrap: false }),
        removeStaleCantonRssFeeds: true,
      });
    } else if (!current) {
      bySection.set(target.section, { section: target.section, ids: [], bootstrap: false });
    }
  }
  return orderedSections.filter(({ section }) => bySection.has(section)).map(({ section }) => bySection.get(section));
}

/**
 * L'ERE (grep -E) dei corpi delle sezioni attive. `served` restringe a chi le
 * serve: `shard` (Pages) o `r2` (Worker). Un commit di un articolo cantonale
 * non deve entrare nel fast-publish verso gli shard, dove `shard-of` lo
 * rifiuterebbe facendo fallire il workflow a ogni articolo.
 */
export function bodyRegex(coreList = activeCorpusCoreEntries(), { served } = {}) {
  if (served !== undefined && served !== 'shard' && served !== 'r2') throw new Error(`body-regex: tipo "${served}" sconosciuto (shard | r2)`);
  const sections = activeSourceSections(coreList).filter((s) => served === undefined || (served === 'shard') === Boolean(s.shardKey));
  // Nessuna sezione di quel tipo: un'ERE che non combacia con nessun path.
  if (sections.length === 0) return '^$';
  const dirs = sections.map((s) => {
    if (!s.bodyDir.startsWith('content/')) throw new Error(`bodyDir fuori da content/: ${s.bodyDir}`);
    return escapeRe(s.bodyDir.slice('content/'.length));
  });
  return `^content/(${dirs.join('|')})/[a-z]{2}/.+\\.ts$`;
}

function registryArticleIds(section) {
  const registryFile = sectionSourceSurfaces(section.section).registryFile;
  if (!existsSync(registryFile)) {
    throw new Error(`registry della sezione '${section.section}' non trovato: ${registryFile}`);
  }
  const source = readFileSync(registryFile, 'utf8');
  return new Set(
    articleRegistryObjectBodies(source)
      .map((body) => articleRegistryObjectFields(body).get('id'))
      .filter(Boolean),
  );
}

/**
 * Piano dei body cambiati che il renderer puo' davvero risolvere.
 *
 * Il nome di un file body non prova che esista una voce nel registry. Il
 * corpus storico contiene body orfani (issue #2453): includerne uno in un
 * batch fa rifiutare l'intero render, compresi gli articoli registrati. Gli ID
 * espliciti restano fail-closed nel renderer; solo la derivazione automatica
 * da un diff separa gli orfani in `skippedIds`.
 */
export function bodyPublishPlan(
  files,
  coreList = activeCorpusCoreEntries(),
  {
    served,
    fileExists = existsSync,
    articleIdsForSection = registryArticleIds,
  } = {},
) {
  if (served !== undefined && served !== 'shard' && served !== 'r2') {
    throw new Error(`body-plan: tipo "${served}" sconosciuto (shard | r2)`);
  }
  const sections = activeSourceSections(coreList)
    .filter((section) => served === undefined || (served === 'shard') === Boolean(section.shardKey));
  const byName = new Map(sections.map((section) => [section.section, section]));
  const plan = new Map();

  for (const { rel, status } of changedFileRecords(files)) {
    const body = sectionForBodyPath(rel, coreList);
    const section = body && byName.get(body.section);
    if (!section || status === 'D' || status === 'R' || !fileExists(rel)) continue;

    if (!plan.has(section.section)) {
      plan.set(section.section, {
        ids: new Set(),
        skippedIds: new Set(),
        registeredIds: new Set(articleIdsForSection(section)),
      });
    }
    const state = plan.get(section.section);
    (state.registeredIds.has(body.id) ? state.ids : state.skippedIds).add(body.id);
  }

  return sections
    .filter((section) => plan.has(section.section))
    .map((section) => {
      const state = plan.get(section.section);
      return {
        section: section.section,
        ids: [...state.ids].sort(),
        skippedIds: [...state.skippedIds].sort(),
      };
    });
}

/** La sezione che possiede il corpo, o un errore. */
export function sectionOf(rel, coreList = activeCorpusCoreEntries()) {
  const hit = sectionForBodyPath(rel, coreList);
  if (!hit) throw new Error(`'${rel}' non e' il corpo di nessuna sezione attiva`);
  return hit.section;
}

/** Lo shard Pages di una sezione attiva, o un errore. */
export function shardOf(section, coreList = activeCorpusCoreEntries()) {
  const entry = coreList.find((core) => core.section === section);
  if (!entry) {
    throw new Error(
      `sezione '${section}' non attiva: attese ${coreList.map((c) => c.section).join(', ')}`,
    );
  }
  if (!entry.shardKey) {
    throw new Error(
      `la sezione '${section}' (tipo ${entry.kind}) non ha uno shard Pages: e' servita da R2 + Worker ` +
        '(D3 del piano sezioni cantonali). Il fast-publish verso gli shard non la pubblica; ' +
        'la sua pubblicazione arriva con publish-section-pages (P7).',
    );
  }
  return entry.shardKey;
}

/**
 * Le sezioni R2 (cantonali attive) toccate da un insieme di file cambiati, con
 * gli id degli articoli il cui corpo e' cambiato. `bootstrap: true` significa
 * che un input article-facing (registro, slug, SEO, meta) o una cancellazione
 * richiede il render completo degli id ancora presenti: gli id rimossi non
 * entrano mai in `ids`, quindi il controllo del renderer non fallisce su una
 * voce che il commit ha eliminato. I soli input hub (`.../hubs/*.json`) restano
 * `bootstrap: false` e con `ids: []`: rinfrescano landing, archivio e hub.
 *
 * @param {string[]} files path relativi alla radice del repo
 * @returns {Array<{ section: string, ids: string[], bootstrap: boolean, removeStaleCantonRssFeeds?: boolean }>} nell'ordine del core
 */
export function r2PublishPlan(
  files,
  coreList = activeCorpusCoreEntries(),
  { registryRefreshSections = [], registryCleanupSections = [] } = {},
) {
  const sections = activeSourceSections(coreList).filter((s) => !s.shardKey);
  const plan = new Map();
  const touch = (section) => {
    if (!plan.has(section)) plan.set(section, { ids: new Set(), bootstrap: false });
    return plan.get(section);
  };
  for (const section of registryRefreshSections) {
    if (!sections.some((entry) => entry.section === section && entry.kind === 'canton')) {
      throw new Error(`refresh registry richiesto per sezione R2 non attiva: ${section}`);
    }
    touch(section).bootstrap = true;
  }
  for (const section of registryCleanupSections) {
    if (!sections.some((entry) => entry.section === section && entry.kind === 'canton')) {
      throw new Error(`cleanup RSS richiesto per sezione R2 non attiva: ${section}`);
    }
    touch(section).removeStaleCantonRssFeeds = true;
  }
  const changedFiles = changedFileRecords(files);
  if (changedFiles.some(({ rel }) => isSharedR2RefreshPath(rel))) {
    for (const section of sections) touch(section.section).bootstrap = true;
  }
  for (const { rel, status } of changedFiles) {
    if (!rel) continue;
    const body = sectionForBodyPath(rel, coreList);
    if (body) {
      const target = sections.find((s) => s.section === body.section);
      if (!target) continue;
      const state = touch(target.section);
      if (status === 'D' || status === 'R') state.bootstrap = true;
      else state.ids.add(body.id);
      continue;
    }
    for (const s of sections) {
      const cantonRoot = `content/cantons/${s.section}/`;
      const hubRoot = `${cantonRoot}hubs/`;
      const isHubData = rel.startsWith(hubRoot);
      const own = rel.startsWith(cantonRoot) || rel.startsWith(`${s.metaPrefix}-`);
      if (!own) continue;
      const state = touch(s.section);
      // Hub JSON changes only refresh the non-article surfaces. Every other
      // canton source can alter article HTML/canonical/alternate output.
      if (!isHubData) state.bootstrap = true;
    }
  }
  for (const [section, ids] of imageArticleOwners(files, coreList)) {
    const target = sections.find((s) => s.section === section);
    if (!target) continue;
    const state = touch(section);
    for (const id of ids) state.ids.add(id);
  }
  return sections
    .filter((s) => plan.has(s.section))
    .map((s) => {
      const state = plan.get(s.section);
      const target = {
        section: s.section,
        ids: state.bootstrap ? [] : [...state.ids].sort(),
        bootstrap: state.bootstrap,
      };
      if (state.removeStaleCantonRssFeeds) target.removeStaleCantonRssFeeds = true;
      return target;
    });
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const [cmd, arg] = process.argv.slice(2);
  const run = async () => {
    if (cmd === 'body-regex') console.log(bodyRegex(activeCorpusCoreEntries(), { served: arg }));
    else if (cmd === 'body-plan') console.log(JSON.stringify(bodyPublishPlan(readFileSync(0, 'utf8').split('\n'), activeCorpusCoreEntries(), { served: arg })));
    else if (cmd === 'article-plan') {
      let before = process.env.PUSH_BEFORE ?? '';
      if (!before || /^0+$/.test(before)) before = 'HEAD~1';
      if (!/^[a-f0-9]{40,64}$/i.test(before) && before !== 'HEAD~1') {
        throw new Error('PUSH_BEFORE non disponibile per confrontare le superfici articolo');
      }
      console.log(JSON.stringify(articlePublishPlan(
        readFileSync(0, 'utf8').split('\n'),
        activeCorpusCoreEntries(),
        { served: arg, readPreviousSource: (rel) => gitSourceAtRevision(before, rel) },
      )));
    }
    else if (cmd === 'r2-plan') {
      const files = readFileSync(0, 'utf8').split('\n');
      let registryRefreshSections = [];
      let registryCleanupSections = [];
      if (changedFileRecords(files).some(({ rel }) => rel === 'sections/registry.json')) {
        let before = process.env.PUSH_BEFORE ?? '';
        if (/^0+$/.test(before)) before = execFileSync('git', ['rev-parse', 'HEAD~1'], { encoding: 'utf8' }).trim();
        if (!/^[a-f0-9]{40,64}$/i.test(before)) throw new Error('PUSH_BEFORE non disponibile per confrontare sections/registry.json');
        const previous = JSON.parse(execFileSync('git', ['show', `${before}:sections/registry.json`], { encoding: 'utf8' }));
        const next = JSON.parse(readFileSync('sections/registry.json', 'utf8'));
        const transitions = liveRegistryTransitions(previous, next);
        registryRefreshSections = transitions.map(({ section }) => section);
        registryCleanupSections = transitions
          .filter(({ removeStaleCantonRssFeeds }) => removeStaleCantonRssFeeds)
          .map(({ section }) => section);
      }
      console.log(JSON.stringify(r2PublishPlan(files, activeCorpusCoreEntries(), {
        registryRefreshSections,
        registryCleanupSections,
      })));
    }
    else if (cmd === 'r2-reconcile-plan') {
      const response = await fetch(`${EDGE_SECTION_REGISTRY_URL}?_fpsr=${Date.now()}`, {
        headers: { 'user-agent': 'frontaliere-section-pages/1 (+https://frontaliereticino.ch)' },
      });
      if (!response.ok) throw new Error(`registro edge HTTP ${response.status}`);
      console.log(JSON.stringify(liveR2ReconciliationPlan(await response.json(), activeCorpusCoreEntries(), arg)));
    }
    else if (cmd === 'r2-api-push-plan') {
      const matrices = readFileSync(0, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
      if (matrices.length !== 2) throw new Error('r2-api-push-plan richiede due matrici JSON: diff ed edge');
      console.log(JSON.stringify(r2ApiPushPlan(matrices[0], matrices[1], activeCorpusCoreEntries())));
    }
    else if (cmd === 'image-plan') console.log(JSON.stringify(imagePublishPlan(readFileSync(0, 'utf8').split('\n'), activeCorpusCoreEntries(), { served: arg })));
    else if (cmd === 'section-of' && arg) console.log(sectionOf(arg));
    else if (cmd === 'shard-of' && arg) console.log(shardOf(arg));
    else throw new Error('uso: fast-publish-section.mjs body-regex [shard|r2] | body-plan [shard|r2] < files | article-plan [shard|r2] < files | image-plan [shard|r2] | section-of <path> | shard-of <section> | r2-plan < files | r2-reconcile-plan <commit> | r2-api-push-plan < diff.json edge.json');
  };
  run().catch((error) => {
    console.error(`::error::fast-publish-section: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
