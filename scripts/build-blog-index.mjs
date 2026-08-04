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
 * Emits: <out>/blog-index-<section>-<locale>.json  (2 sections x 4 locales),
 *        each carrying the newest RECENT_LIMIT articles — see the slice below.
 */

import fs from 'node:fs';
import path from 'node:path';

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

/** How many of the newest articles the overlay carries — see the slice below. */
const RECENT_LIMIT = Number(process.env.BLOG_INDEX_LIMIT) || 150;

/**
 * Registry entries as `{ id: '…', category: '…', date: '…', image: '…' }`
 * object literals. Parsed with a regex rather than imported: this file must not
 * drag the corpus's TS module graph (and its extensionless specifiers) into a
 * plain-node script, and the shapes here are emitted by our own generator.
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
      image: pick('image') ?? '',
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
    const value = raw.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');
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

    // Capped, and the cap is the whole design. The site's bundle already
    // carries every article it knew about at build time; this index exists to
    // cover the ones generated SINCE, so only the recent tail is ever needed.
    // The full set is 3069 entries = ~1.3 MB per locale, which is not something
    // to fetch on every blog view. RECENT_LIMIT of 150 is ~65 KB and is a wide
    // margin: at the observed rate of a few articles a day it covers weeks
    // between site deploys.
    const capped = entries.slice(0, RECENT_LIMIT);
    const file = path.join(OUT, `blog-index-${section.name}-${locale}.json`);
    fs.writeFileSync(file, JSON.stringify({
      version: 1, section: section.name, locale,
      count: capped.length, total: entries.length, articles: capped,
    }) + '\n');
    const kb = Math.round(fs.statSync(file).size / 1024);
    console.log(`[blog-index] ${path.basename(file)} — ${capped.length}/${entries.length} articles, ${kb} KB, newest ${capped[0].date}`);
  }
}

if (failed) process.exit(1);
