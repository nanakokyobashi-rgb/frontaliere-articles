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
 * Usage: node scripts/build-blog-index.mjs [--out <dir>]
 * Emits: <out>/blog-index-<section>-<locale>.json       newest RECENT_LIMIT
 *        <out>/blog-index-<section>-<locale>-full.json  every article
 *        (2 sections x 4 locales x 2 files). The capped file is the fast path;
 *        the full one is what stops the cap being a cliff — see the slice below.
 */

import fs from 'node:fs';
import path from 'node:path';
// Same output-boundary guard build-api.mjs uses. This index is the LIST
// surface: a control byte in a title here is rendered in every hub, archive
// and homepage cell that shows the article. Measured on the live index,
// blog-index-frontaliere-it-full.json carried five of them.
import { sanitizeDeep, assertNoControlChars } from './lib/sanitize-control-chars.mjs';
import { reportStrippedControlCharsDeep } from '../generator/scripts/lib/control-char-write-report.mjs';
import { unescapeTsValue } from '../generator/scripts/lib/meta-field-regex.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx >= 0 ? path.resolve(process.argv[outIdx + 1]) : path.join(ROOT, 'dist', 'api', 'data');

const LOCALES = ['it', 'en', 'de', 'fr'];
const SECTIONS = [
  { name: 'frontaliere', registry: 'content/blog-articles-data.ts', metaPrefix: 'blog-meta' },
  { name: 'svizzera', registry: 'content/swiss-articles-data.ts', metaPrefix: 'blog-meta-ch' },
];

/** Minimum entries below which the registry parse is assumed broken, not empty. */
const MIN_ENTRIES = 50;

/**
 * How many of the newest articles the FAST-PATH index carries.
 *
 * No longer a ceiling on what a consumer can see: the full set is published
 * alongside it and the consumer escalates when this window cannot close its
 * gap (see the slice below). Tuning this trades bytes on the common path
 * against how often that escalation fires.
 */
const RECENT_LIMIT = Number(process.env.BLOG_INDEX_LIMIT) || 150;

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
  const rx = /\{\s*id:\s*'([^']+)'([\s\S]*?)\}/g;
  let m;
  while ((m = rx.exec(src)) !== null) {
    const [, id, body] = m;
    const pick = (k) => (body.match(new RegExp(`\\b${k}:\\s*'([^']*)'`)) ?? [])[1];
    const pickBool = (k) => new RegExp(`\\b${k}:\\s*true`).test(body);
    out.push({
      id,
      category: pick('category') ?? '',
      date: pick('date') ?? '',
      updatedAt: pick('updatedAt') ?? undefined,
      image: cdnBlogImage(pick('image') ?? ''),
      hasCalculator: pickBool('hasCalculator') || undefined,
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

fs.mkdirSync(OUT, { recursive: true });
let failed = false;

for (const section of SECTIONS) {
  const registry = readRegistry(section.registry);
  if (registry.length < MIN_ENTRIES) {
    console.error(`[blog-index] ${section.name}: registry parsed to ${registry.length} entries (< ${MIN_ENTRIES}) — refusing to publish a truncated index`);
    failed = true;
    continue;
  }
  // Second gate, on the values rather than the count: a surviving
  // `/images/blog/` path is a hero that 404s on the apex, and a card with a
  // broken image is the failure this index existed to prevent. Cheap enough to
  // assert every time, and it fails loudly instead of publishing dead art.
  const leaks = registry.filter((a) => /^\/images\/blog\//.test(a.image));
  if (leaks.length > 0) {
    console.error(`[blog-index] ${section.name}: ${leaks.length} entries still carry a same-origin /images/blog/ hero after the CDN rewrite (e.g. ${leaks[0].id} → ${leaks[0].image}) — refusing to publish 404 images`);
    failed = true;
    continue;
  }

  const itMeta = readMeta(section.metaPrefix, 'it');

  for (const locale of LOCALES) {
    const meta = locale === 'it' ? itMeta : readMeta(section.metaPrefix, locale);
    const entries = [];
    for (const a of registry) {
      // Fall back to the Italian title so a locale whose translation has not
      // landed yet still LISTS the article rather than hiding it — the same
      // union-not-intersection rule the archive renderer uses.
      const title = meta.get(a.id)?.title ?? itMeta.get(a.id)?.title;
      if (!title) continue; // no title anywhere: nothing a list cell could show
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
    if (entries.length < MIN_ENTRIES) {
      console.error(`[blog-index] ${section.name}/${locale}: only ${entries.length} entries — refusing`);
      failed = true;
      continue;
    }
    // Newest first: this index feeds LISTS, and a list is read from the top.
    entries.sort((a, b) => String(b.date).localeCompare(String(a.date)));

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
    fs.writeFileSync(file, JSON.stringify(cleanPayload) + '\n');
    const kb = Math.round(fs.statSync(file).size / 1024);
    console.log(`[blog-index] ${path.basename(file)} — ${capped.length}/${entries.length} articles, ${kb} KB, newest ${capped[0].date}`);

    const fullFile = path.join(OUT, `blog-index-${section.name}-${locale}-full.json`);
    const fullPayload = {
      version: 1, section: section.name, locale,
      count: entries.length, total: entries.length, articles: entries,
      oldest: entries[entries.length - 1]?.date ?? null,
    };
    const cleanFullPayload = sanitizeDeep(fullPayload);
    reportStrippedControlCharsDeep(fullFile, fullPayload, cleanFullPayload);
    fs.writeFileSync(fullFile, JSON.stringify(cleanFullPayload) + '\n');
    const fullKb = Math.round(fs.statSync(fullFile).size / 1024);
    console.log(`[blog-index] ${path.basename(fullFile)} — ${entries.length} articles, ${fullKb} KB`);
  }
}

// ── Final gate: no control character leaves this script either ────────────
//
// Same argument as build-api.mjs's closing gate, and it belongs here for the
// same reason: the two writes above are covered by their own sanitizeDeep, so
// today this is silent. It exists for the third write — the one someone adds
// later without noticing that this file has an output contract.
{
  const emitted = fs.existsSync(OUT) ? fs.readdirSync(OUT).filter((f) => f.endsWith('.json')) : [];
  for (const f of emitted) {
    assertNoControlChars(fs.readFileSync(path.join(OUT, f), 'utf-8'), `${OUT}/${f}`);
  }
  console.log(`[blog-index] control-character gate: ${emitted.length} files clean`);
}

if (failed) process.exit(1);
