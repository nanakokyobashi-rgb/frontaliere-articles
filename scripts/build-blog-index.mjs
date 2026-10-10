#!/usr/bin/env node
/**
 * build-blog-index.mjs — the runtime article index the site's LISTS read.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Publishing an article to its shard makes its own URL live within a minute.
 * It does NOT make it appear in the site's article lists — the hub, the
 * archive, the homepage. Those are rendered by the site's SPA from data
 * COMPILED INTO ITS BUNDLE (`data/blog-articles-data.ts` for the registry,
 * the `blog-meta-*` chunks for titles), so a new article showed up there only
 * after the site repo rebuilt and redeployed.
 *
 * That was the last dependency of this repo on the other one: generation here,
 * visibility there. Measured 2026-08-03: fourteen articles answered 200 at
 * their own URL and appeared in the sitemaps and RSS, while the hub's newest
 * entry was still dated 2026-07-29.
 *
 * `articles.json` (§7.1) cannot close it — it carries
 * `{id, category, date, updatedAt, image, hasCalculator, authorSlug, authorName}`
 * and deliberately no title. A list needs titles. This index adds exactly the
 * fields a list cell renders, per locale, and nothing else: no bodies, so it
 * stays small enough to fetch on every blog view.
 *
 * The site fetches it at runtime from the CDN and merges anything its bundle
 * does not already have. Additive and fail-open by construction: if this file
 * is missing or malformed the site renders exactly what it renders today.
 *
 * Mirrors the shape the site already uses for jobs
 * (`/data/jobs-<locale>-index.json`), so it is a data publication, not a new
 * mechanism.
 *
 * THE COVER CREDITS RIDE THE SAME CHANNEL (P14)
 * ─────────────────────────────────────────────
 * A second, separate output, not more fields in the index above: the list
 * files stay exactly what a list cell renders. The article page of the SPA
 * needs the credit of a Wikimedia Commons cover (author, licence, Commons
 * file page) for its visible line and its ImageObject, and for a fresh
 * article that data exists only here, in `content/image-credits/blog/` —
 * the bundle lags by hours. So each section also gets
 * `image-credits-<section>.json`: the publishable records of the covers its
 * registry rows use, read through the engine's own reader
 * (`engine/shared/imageCredits.mjs`, so an invalid or `review` record is
 * dropped here exactly as on the static page), file fields stored once per
 * Commons file (`scripts/lib/image-credit-records.mjs` has the shape).
 * Fail-open for the consumer like the index. Two records that credit one
 * Commons file differently (two runs that read Commons at different moments)
 * share one file entry: the most recent read, for every cover cut from that
 * file, so no cover goes out without a credit while its literal no longer
 * claims the photo for the site. A warning names the pair. Refusing would
 * hold back the whole API publication for one cover; the alarm that asks for
 * the records to be aligned is the content gate on `main`
 * (`generator/tests/image-credits-content.test.mjs`), which fails on any such
 * pair.
 *
 * Usage: node scripts/build-blog-index.mjs [--out <dir>]
 * Emits: <out>/blog-index-<section>-<locale>.json       newest RECENT_LIMIT
 *        <out>/blog-index-<section>-<locale>-full.json  every article
 *        (2 sections x 4 locales x 2 files). The capped file is the fast path;
 *        the full one is what stops the cap being a cliff — see the slice below.
 *        <out>/image-credits-<section>.json             the section's Commons credits
 *        <out>/image-credits-blog.json                  all reader-facing cover records
 *        (3 files)
 */

import '../host/cantonSectionsBootstrap.mjs';
import fs from 'node:fs';
import path from 'node:path';
// Same output-boundary guard build-api.mjs uses. This index is the LIST
// surface: a control byte in a title here is rendered in every hub, archive
// and homepage cell that shows the article. Measured on the live index,
// blog-index-frontaliere-it-full.json carried five of them.
import { sanitizeDeep, assertNoControlChars } from './lib/sanitize-control-chars.mjs';
import { reportStrippedControlCharsDeep } from '../generator/scripts/lib/control-char-write-report.mjs';
import { unescapeTsValue } from '../generator/scripts/lib/meta-field-regex.mjs';
import { parsePositiveNum } from './lib/parse-positive-num.mjs';
// Il pavimento anti-troncamento, derivato dal corpus invece che scritto a mano:
// stessa sorgente unica che usa il gate di pubblicazione (scripts/ci/verify-api-floors.mjs).
import {
  floorFrom,
  sectionFloor,
  countSourceArticles,
  retentionLine,
  retentionWarning,
} from './lib/corpus-floors.mjs';
// Gli shard qui sotto sono la superficie da cui il sito rende le LISTE, e
// vengono scritti dopo che `build-api.mjs` ha gia' chiuso `manifest.json`:
// senza questa dichiarazione resterebbero l'unica parte di `dist/api/` che
// nessun consumer puo' verificare prima di usarla.
import { declareApiArtifacts, byteSize } from './lib/api-manifest.mjs';
import { buildImageCreditsIndex, corpusCreditReader } from './lib/image-credit-records.mjs';
import { CORPUS_SECTIONS } from './lib/corpus-sections.mjs';
import {
  BLOG_IMAGE_CREDITS_AGGREGATE,
  buildBlogImageCreditsAggregate,
  buildPublishedBlogImageRegistry,
} from '../generator/scripts/lib/blog-image-registry.mjs';
import {
  readTopLevelBoolean,
  readTopLevelString,
  scanTopLevelArticleRecords,
} from './lib/article-registry-reader.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const outIdx = process.argv.indexOf('--out');
const DEFAULT_OUT = path.join(ROOT, 'dist', 'api', 'data');
const OUT = outIdx >= 0 ? path.resolve(process.argv[outIdx + 1]) : DEFAULT_OUT;
// La dichiarazione nel manifest vale solo quando si scrive DAVVERO nella
// superficie pubblicata: un `--out` di comodo (o un test) non ha un
// `manifest.json` accanto da arricchire, e non ne va inventato uno.
const PUBLISHES_TO_API = OUT === DEFAULT_OUT;
const API_ROOT = path.dirname(OUT);
/** `{ <path relativo a dist/api>: byte UTF-8 }`, per `manifest.files`. */
const writtenShards = {};

const LOCALES = ['it', 'en', 'de', 'fr'];
// Le sezioni ATTIVE del core, non una terza copia scritta a mano: registro e
// prefisso meta vengono da `scripts/lib/corpus-sections.mjs`, che li deriva da
// `ARTICLE_SECTION_CORE`. Con le due sezioni storiche gli shard sono gli stessi
// di sempre (`blog-index-frontaliere-*`, `blog-index-svizzera-*`).
const SECTIONS = CORPUS_SECTIONS.map((section) => ({
  name: section.section,
  registry: section.registryFile,
  metaPrefix: path.basename(section.metaPrefix),
}));
const expectedShards = new Set(
  SECTIONS.flatMap((section) => LOCALES.flatMap((locale) => [
    path.relative(API_ROOT, path.join(OUT, `blog-index-${section.name}-${locale}.json`)),
    path.relative(API_ROOT, path.join(OUT, `blog-index-${section.name}-${locale}-full.json`)),
  ])),
);
/** The cover credits: one file per section, declared apart from the index shards. */
const expectedCreditFiles = new Set(
  [
    ...SECTIONS.map((section) => path.relative(API_ROOT, path.join(OUT, `image-credits-${section.name}.json`))),
    path.relative(API_ROOT, path.join(OUT, path.basename(BLOG_IMAGE_CREDITS_AGGREGATE))),
  ],
);
const writtenCredits = {};

/**
 * The release the credits belong to: `manifest.json`'s `commit`, written by
 * `build-api.mjs` a step earlier — so a consumer can match the two. Outside
 * the published surface (a `--out` of convenience) there is no manifest and
 * the field is null rather than invented.
 */
const releaseCommit = (() => {
  if (!PUBLISHES_TO_API) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(API_ROOT, 'manifest.json'), 'utf-8')).commit ?? null;
  } catch {
    return null;
  }
})();
/** Records the engine reader drops, reported once each instead of vanishing. */
const creditWarnings = [];
const creditReader = corpusCreditReader(ROOT, (message) => creditWarnings.push(message));

/**
 * Il pavimento sotto cui il parse del registro e' rotto, non vuoto.
 *
 * Era `const MIN_ENTRIES = 50`, gemello esatto del `counts.articles -lt 100` di
 * `publish-api.yml`: una costante tarata una volta e mai piu' toccata mentre il
 * corpus cresceva. Misurato il 2026-09-05, le due sezioni tengono 3785 e 1850
 * file di corpo — il pavimento copriva l'1,3% del caso peggiore, quindi un
 * indice troncato al 2% passava e veniva pubblicato come «non vuoto».
 *
 * Ora e' derivato dal corpus su disco a ogni run (`scripts/lib/corpus-floors.mjs`),
 * quindi scala da solo e non ha una taratura che scade.
 *
 * LANCIA quando il corpus sorgente della sezione non c'e', e il chiamante lo
 * tratta come un rifiuto: un derivato a 0 e' un gate che sparisce, e registro
 * (`content/blog-articles-data.ts`) e corpi (`content/blog-body/it`) stanno
 * entrambi sotto `content/`, quindi un solo `content/` non materializzato li
 * azzera INSIEME. `readRegistry` in quel caso ritorna `[]` senza lanciare, e
 * `0 < 0` e' falso: senza questa eccezione lo script scriverebbe e
 * pubblicherebbe un indice VUOTO sopra quello live.
 *
 * Una sezione di famiglia (cantonale) appena accesa ha invece pavimento 0 per
 * costruzione (`sectionFloor`, politica `family`): parte senza articoli, e il
 * «content/ non materializzato» lo rifiutano comunque le sezioni storiche.
 */
function sectionEntryFloor(section) {
  return sectionFloor(ROOT, section);
}

/**
 * How many of the newest articles the FAST-PATH index carries.
 *
 * No longer a ceiling on what a consumer can see: the full set is published
 * alongside it and the consumer escalates when this window cannot close its
 * gap (see the slice below). Tuning this trades bytes on the common path
 * against how often that escalation fires.
 *
 * Read through `parsePositiveNum`, not `Number(env) || 150`: the `||` form
 * covers `NaN`, `0` and `''` but NOT a negative, and `BLOG_INDEX_LIMIT=-5`
 * turned the slice below into `entries.slice(0, -5)` — the fast-path index
 * PUBLISHED with the five newest articles missing, accepted by the site
 * without an error and shown short in every list (issue #871 item 2). A
 * fractional value was the same failure from the other side: `slice(0, 0.5)`
 * is `slice(0, 0)`, an empty index, hence `integer: true`.
 */
const RECENT_LIMIT = parsePositiveNum(process.env.BLOG_INDEX_LIMIT, 150, {
  label: 'BLOG_INDEX_LIMIT',
  tool: 'build-blog-index',
  integer: true,
});

const REPO = 'valerielinc-ops/frontaliere-si-o-no';
const SHA = 'main';
const CDN_BLOG_BASE = 'https://cdn.frontaliereticino.ch/images/blog';
const RAW_BLOG_BASE = `https://raw.githubusercontent.com/${REPO}/${SHA}/public/images/blog`;
const FULL_BLOG_RX = /^(?:https?:\/\/[^/]+)?\/images\/blog\/([^/]+\.(?:webp|png|jpe?g|avif))$/i;

/**
 * Byte-compatible copy of `content/blogImageCdnMirror.ts`'s `cdnBlogImage`.
 *
 * WHY A COPY AND NOT AN IMPORT
 * ────────────────────────────
 * The registries do NOT export what their source literals say. `RAW_ARTICLES`
 * and `RAW_SWISS_ARTICLES` hold site-relative `/images/blog/<id>.webp` — kept
 * that way on purpose so the build plugins that regex-parse those files still
 * find a path they recognise — and the actual exports map every entry through
 * `cdnBlogImage` before anyone sees it. Reading the file with a regex (see
 * `readRegistry` below) therefore reads the PRE-rewrite literal: the one shape
 * no consumer of this index can render. The apex serves `/images/places/`
 * (which is why the older articles looked fine) but not `/images/blog/`, whose
 * files live only on the CDN, so every card the overlay contributed came out
 * with a 404 hero. Measured 2026-08-05 on the pre-fix output: 3036 of 3083
 * frontaliere entries and 612 of 614 svizzera entries carried a
 * `/images/blog/` path.
 *
 * The import would be the single-producer fix, but it is not available here:
 * this script is invoked as plain `node scripts/build-blog-index.mjs` in
 * `.github/workflows/publish-api.yml` (unlike `build-api.mjs` and
 * `refresh-hub-landing.mjs`, which run under tsx and do import the TS
 * modules), and plain Node cannot load a `.ts` module. Keeping it on plain
 * node is deliberate — it is what lets this step stay independent of the
 * corpus's TS module graph and its extensionless specifiers. So this is a
 * fourth byte-compatible copy alongside the three `blogImageCdnMirror.ts`
 * already documents; keep it in step with that file, which is the one the
 * registries actually call.
 */
function cdnBlogImage(p) {
  if (!p) return p ?? '';
  if (p.startsWith(CDN_BLOG_BASE) || p.startsWith(RAW_BLOG_BASE)) return p;
  const m = p.match(FULL_BLOG_RX);
  if (!m) return p; // thumbnails and non-blog paths (/images/places/…) pass through
  return `${CDN_BLOG_BASE}/${m[1]}`;
}

/**
 * Registry entries as `{ id: '…', category: '…', date: '…', image: '…' }`
 * object literals. Parsed with a regex rather than imported: this file must not
 * drag the corpus's TS module graph (and its extensionless specifiers) into a
 * plain-node script, and the shapes here are emitted by our own generator.
 *
 * `image` is the raw literal, so it is rewritten through `cdnBlogImage` above
 * to land on the value the registry's own export carries.
 */
function readRegistry(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  const src = fs.readFileSync(abs, 'utf-8');
  const out = [];
  for (const record of scanTopLevelArticleRecords(src)) {
    const pick = (key) => readTopLevelString(record, key);
    out.push({
      id: record.id,
      category: pick('category') ?? '',
      date: pick('date') ?? '',
      updatedAt: pick('updatedAt') ?? undefined,
      image: cdnBlogImage(pick('image') ?? ''),
      hasCalculator: readTopLevelBoolean(record, 'hasCalculator') || undefined,
      authorSlug: pick('authorSlug') ?? undefined,
    });
  }
  return out;
}

/** `'blog.article.<id>.<field>': '<value>'` pairs out of a meta chunk. */
function readMeta(metaPrefix, locale) {
  const abs = path.join(ROOT, 'content', `${metaPrefix}-${locale}.ts`);
  const out = new Map();
  if (!fs.existsSync(abs)) return out;
  const src = fs.readFileSync(abs, 'utf-8');
  const rx = /'blog\.article\.([^']+?)\.(title|excerpt)':\s*'((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = rx.exec(src)) !== null) {
    const [, id, field, raw] = m;
    const value = unescapeTsValue(raw);
    if (!out.has(id)) out.set(id, {});
    out.get(id)[field] = value;
  }
  return out;
}

let failed = false;
const preparedSections = [];

// Fase 1: valida e prepara tutti gli shard senza creare la directory di output.
// Nessuna sezione parziale deve poter lasciare artefatti se una sezione successiva
// e' assente o troncata.
for (const section of SECTIONS) {
  const registry = readRegistry(section.registry);
  let registryFloor;
  try {
    registryFloor = sectionEntryFloor(section.name);
  } catch (err) {
    console.error('[blog-index] ' + section.name + ': ' + err.message + ' — refusing to publish');
    failed = true;
    continue;
  }
  if (registry.length < registryFloor) {
    console.error(
      '[blog-index] ' + section.name + ': registry parsed to ' + registry.length +
      ' entries (< ' + registryFloor + ', derived from the corpus on disk) — refusing to publish a truncated index',
    );
    failed = true;
    continue;
  }

  const sourceBodies = countSourceArticles(ROOT, section.name);
  console.log('[blog-index] ' + retentionLine(section.name + ' registry/corpus', registry.length, sourceBodies));
  const registryWarning = retentionWarning(section.name + ' registry/corpus', registry.length, sourceBodies);
  if (registryWarning) console.warn('::warning::[blog-index] ' + registryWarning);

  const leaks = registry.filter((a) => /^\/images\/blog\//.test(a.image));
  if (leaks.length > 0) {
    console.error(
      '[blog-index] ' + section.name + ': ' + leaks.length +
      ' entries still carry a same-origin /images/blog/ hero after the CDN rewrite ' +
      '(e.g. ' + leaks[0].id + ' → ' + leaks[0].image + ') — refusing to publish 404 images',
    );
    failed = true;
    continue;
  }

  const itMeta = readMeta(section.metaPrefix, 'it');
  const locales = [];
  for (const locale of LOCALES) {
    const meta = locale === 'it' ? itMeta : readMeta(section.metaPrefix, locale);
    const entries = [];
    for (const a of registry) {
      const title = meta.get(a.id)?.title ?? itMeta.get(a.id)?.title;
      if (!title) continue;
      entries.push({
        id: a.id,
        title,
        excerpt: meta.get(a.id)?.excerpt ?? itMeta.get(a.id)?.excerpt ?? undefined,
        category: a.category,
        date: a.date,
        updatedAt: a.updatedAt,
        image: a.image,
        hasCalculator: a.hasCalculator,
        authorSlug: a.authorSlug,
      });
    }
    const localeFloor = floorFrom(registry.length);
    if (entries.length < localeFloor) {
      console.error(
        '[blog-index] ' + section.name + '/' + locale + ': only ' + entries.length +
        ' entries (< ' + localeFloor + ') — refusing',
      );
      failed = true;
      continue;
    }
    const localeWarning = retentionWarning(section.name + '/' + locale, entries.length, registry.length);
    if (localeWarning) console.warn('::warning::[blog-index] ' + localeWarning);
    entries.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    locales.push({ locale, entries });
  }

  // The section's cover credits (see the header), prepared with the index. Two
  // covers whose records disagree about one Commons file both carry its most
  // recent read; publishing goes on, and the warning names the pair.
  const credits = buildImageCreditsIndex({
    section: section.name,
    commit: releaseCommit,
    images: registry.map((a) => a.image),
    reader: creditReader,
  });
  for (const conflict of credits.conflicts) {
    creditWarnings.push(`${section.name}: ${conflict} — both covers carry the most recent read of the file until the records agree`);
  }
  preparedSections.push({ section, locales, credits: credits.payload });
}
for (const message of creditWarnings) console.warn('::warning::' + message);

if (!failed) {
  fs.mkdirSync(OUT, { recursive: true });

  // Fase 2: la validazione e' completa; da qui in poi si scrive il set preparato.
  for (const { section, locales, credits } of preparedSections) {
    const creditsFile = path.join(OUT, `image-credits-${section.name}.json`);
    const cleanCredits = sanitizeDeep(credits);
    reportStrippedControlCharsDeep(creditsFile, credits, cleanCredits);
    const creditsText = JSON.stringify(cleanCredits) + '\n';
    fs.writeFileSync(creditsFile, creditsText);
    writtenCredits[path.relative(API_ROOT, creditsFile)] = byteSize(creditsText);
    console.log(
      `[blog-index] ${path.basename(creditsFile)} — ${Object.keys(credits.covers).length} credited covers, ` +
      `${Object.keys(credits.files).length} Commons files, ${Math.round(byteSize(creditsText) / 1024)} KB`,
    );

    for (const { locale, entries } of locales) {
      // Two files, and the split is the point.
      //
      // The capped one is a FAST PATH, not the contract. Its original comment
      // said RECENT_LIMIT "covers weeks between site deploys" — true only while
      // the site keeps deploying. When deploys stalled (2026-08-03 → 04, and the
      // hub had been frozen since 2026-07-29) the bundle stopped advancing while
      // articles kept publishing, and a cap sized against deploy cadence turns
      // into a silent cliff: articles older than the window and newer than the
      // bundle are in NEITHER, so they exist, are live at their own URL, and are
      // invisible in every list. Nothing reports that.
      //
      // So the full set is published alongside it. The consumer reads the capped
      // file first and escalates to the full one only when `total` says it is
      // still missing something — no extra bytes on the common path, and no
      // window to fall through on the uncommon one.
      const capped = entries.slice(0, RECENT_LIMIT);
      const file = path.join(OUT, `blog-index-${section.name}-${locale}.json`);
      const payload = {
        version: 1, section: section.name, locale,
        count: capped.length, total: entries.length, articles: capped,
        // Lets a consumer tell "the window covers my gap" from "it does not"
        // without fetching the full file to find out.
        oldest: capped[capped.length - 1]?.date ?? null,
        full: `blog-index-${section.name}-${locale}-full.json`,
      };
      const cleanPayload = sanitizeDeep(payload);
      reportStrippedControlCharsDeep(file, payload, cleanPayload);
      const text = JSON.stringify(cleanPayload) + '\n';
      fs.writeFileSync(file, text);
      writtenShards[path.relative(API_ROOT, file)] = byteSize(text);
      const kb = Math.round(fs.statSync(file).size / 1024);
      console.log(`[blog-index] ${path.basename(file)} — ${capped.length}/${entries.length} articles, ${kb} KB, newest ${capped[0]?.date ?? '— (sezione senza articoli)'}`);

      const fullFile = path.join(OUT, `blog-index-${section.name}-${locale}-full.json`);
      const fullPayload = {
        version: 1, section: section.name, locale,
        count: entries.length, total: entries.length, articles: entries,
        oldest: entries[entries.length - 1]?.date ?? null,
      };
      const cleanFullPayload = sanitizeDeep(fullPayload);
      reportStrippedControlCharsDeep(fullFile, fullPayload, cleanFullPayload);
      const fullText = JSON.stringify(cleanFullPayload) + '\n';
      fs.writeFileSync(fullFile, fullText);
      writtenShards[path.relative(API_ROOT, fullFile)] = byteSize(fullText);
      const fullKb = Math.round(fs.statSync(fullFile).size / 1024);
      console.log(`[blog-index] ${path.basename(fullFile)} — ${entries.length} articles, ${fullKb} KB`);
    }
  }

  // One aggregate ledger is the reader-facing contract for pages that need a
  // cover record without first knowing the article section. It also carries
  // the governed generated/editorial registries, which are not Commons files
  // and therefore cannot be represented by buildImageCreditsIndex().
  const aggregateFile = path.join(OUT, path.basename(BLOG_IMAGE_CREDITS_AGGREGATE));
  const sectionPayloads = Object.fromEntries(
    preparedSections.map(({ section, credits }) => [section.name, credits]),
  );
  const aggregate = buildBlogImageCreditsAggregate({
    commit: releaseCommit,
    sectionPayloads,
    registry: buildPublishedBlogImageRegistry(ROOT),
  });
  const cleanAggregate = sanitizeDeep(aggregate);
  reportStrippedControlCharsDeep(aggregateFile, aggregate, cleanAggregate);
  const aggregateText = JSON.stringify(cleanAggregate) + '\n';
  fs.writeFileSync(aggregateFile, aggregateText);
  writtenCredits[path.relative(API_ROOT, aggregateFile)] = byteSize(aggregateText);
  console.log(
    `[blog-index] ${path.basename(aggregateFile)} — `
      + `${Object.keys(aggregate.generated).length} generated, `
      + `${Object.keys(aggregate.editorial).length} editorial, `
      + `${Object.keys(aggregate.covers).length} Commons covers`,
  );
}

// ── Final gate: no control character leaves this script either ────────────
//
// Same argument as build-api.mjs's closing gate, and it belongs here for the
// same reason: the two writes above are covered by their own sanitizeDeep, so
// today this is silent. It exists for the third write — the one someone adds
// later without noticing that this file has an output contract.
{
  const emitted = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith('.json')) emitted.push(abs);
    }
  };
  if (fs.existsSync(OUT)) walk(OUT);
  for (const file of emitted) {
    assertNoControlChars(fs.readFileSync(file, 'utf-8'), file);
  }
  console.log(`[blog-index] control-character gate: ${emitted.length} files clean`);
}

// ── Final gate: gli shard sono dichiarati in manifest.files ───────────────
//
// `manifest.json` e' il primo file che il sito legge, ed e' il solo modo che ha
// di rifiutare un payload troncato PRIMA di renderlo. Copriva pero' solo cio'
// che `build-api.mjs` scrive: questi shard, che sono la superficie delle liste,
// ne restavano fuori. Dichiararli qui — e rivalidare subito l'intero manifest
// contro il disco — li porta sotto la stessa rete degli altri 29 artefatti.
//
// Prima il conteggio, che e' la meta' `counts` dello stesso argomento: il set
// e' un prodotto cartesiano chiuso (sezioni x locali x {capped, full}), quindi
// una sola voce mancante e' un set troncato, e va rifiutata qui invece di
// essere pubblicata come "indice piu' corto".
if (!failed && PUBLISHES_TO_API) {
  const actual = Object.keys(writtenShards).length;
  const missing = [...expectedShards].filter((rel) => !Object.hasOwn(writtenShards, rel));
  if (actual !== expectedShards.size || missing.length > 0) {
    console.error(`[blog-index] wrote ${actual} shards, expected ${expectedShards.size} — missing ${missing.join(', ') || 'unknown'} — refusing to publish a partial index set`);
    failed = true;
  } else {
    const total = declareApiArtifacts(API_ROOT, writtenShards, { blogIndexShards: actual });
    console.log(`[blog-index] manifest.files: ${actual} shards declared, ${total} artifacts match on disk`);
  }
}

// Same net for the cover credits, declared on their own so the closed product
// above stays the index's: one file per section, or a refusal.
if (!failed && PUBLISHES_TO_API) {
  const missing = [...expectedCreditFiles].filter((rel) => !Object.hasOwn(writtenCredits, rel));
  if (missing.length > 0 || Object.keys(writtenCredits).length !== expectedCreditFiles.size) {
    console.error(`[blog-index] cover credits: missing ${missing.join(', ') || 'unknown'} — refusing to publish a partial set`);
    failed = true;
  } else {
    const total = declareApiArtifacts(API_ROOT, writtenCredits, { imageCreditFiles: expectedCreditFiles.size });
    console.log(`[blog-index] manifest.files: ${expectedCreditFiles.size} cover-credit files declared, ${total} artifacts match on disk`);
  }
}

if (failed) process.exit(1);
