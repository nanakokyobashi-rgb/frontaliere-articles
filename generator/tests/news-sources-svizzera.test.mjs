/**
 * Static contract for NEWS_SOURCES / NEWS_SOURCES_SVIZZERA and their HTML
 * fallback maps in generator/scripts/create-article.mjs. `node --test`.
 *
 * Why this file exists: before 2026-08-10 *nothing* validated these lists.
 * The svizzera list had accumulated a 404 (swissinfo /ita/economia/), a
 * 301→404 (swissinfo /ita/politica/), a 404 feed whose API version had moved
 * (watson api/1.0 → api/2.0), a domain that 301s wholesale to an unrelated
 * German site (santesuisse.ch → santeservices.ch/bildung/), two JS-rendered
 * pages that serve zero anchors (bfs/bag admin.ch), and 15 of its 26 URLs
 * were byte-identical copies of NEWS_SOURCES entries — none of it announced,
 * because a dead source only ever increments RUN_REPORT.sources.failed, and
 * santesuisse did not even do that: it answered 200 and counted as succeeded.
 *
 * Deliberately NO network. A test that curls is a test that goes red the day
 * a newsroom has a bad afternoon; reachability belongs to a scheduled probe
 * that opens an issue, not to the CI gate that blocks every PR. What is
 * checked here is only what is knowable from the source text.
 *
 * The lists are parsed from the file as TEXT rather than imported, for two
 * reasons: importing create-article.mjs executes ~11k lines of module scope
 * (Remote Config bridge, corpus reads), and the `[dup:frontaliere]` markers
 * this contract turns on are comments, which no import can see.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_PATH = join(HERE, '..', 'scripts', 'create-article.mjs');
const SRC = readFileSync(SRC_PATH, 'utf-8');

/** Slice `const <name> = [ … \n];` and return one entry per line that holds a URL. */
function parseUrlList(name) {
  const start = SRC.indexOf(`const ${name} = [`);
  assert.notEqual(start, -1, `${name} not found in create-article.mjs`);
  const end = SRC.indexOf('\n];', start);
  assert.notEqual(end, -1, `${name} has no closing bracket`);
  const body = SRC.slice(start, end);
  const entries = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*'(https?:\/\/[^']+)',/);
    if (m) entries.push({ url: m[1], line: line.trim() });
  }
  return entries;
}

/** Slice `const <name> = { … \n};` into a plain key→value object. */
function parseUrlMap(name) {
  const start = SRC.indexOf(`const ${name} = {`);
  assert.notEqual(start, -1, `${name} not found in create-article.mjs`);
  const end = SRC.indexOf('\n};', start);
  assert.notEqual(end, -1, `${name} has no closing brace`);
  const out = {};
  for (const m of SRC.slice(start, end).matchAll(/^\s*'([^']+)':\s*'([^']+)',/gm)) {
    out[m[1]] = m[2];
  }
  return out;
}

// `https://x/feed` and `https://x/feed/` are the same resource but different
// strings, and the second one costs a 301 per run. Compare normalised so a
// trailing slash can never hide an overlap (lavoroediritti.com was exactly
// this case) — but keep the query string, since `?f=rss` genuinely selects a
// different representation than the bare HTML page.
const norm = (u) => u.replace(/\/+$/, '');

/**
 * Does this URL return a feed rather than an HTML page? Decided from the URL
 * because the runtime decides from the *body* (isRssFeed) and the test may
 * not fetch. Every form below is present in the two lists today; a source
 * whose feed-ness is not visible in its URL must be given a fallback entry
 * anyway, which is the safe direction to be wrong in.
 */
const looksLikeFeed = (u) =>
  /\.xml($|\?)/i.test(u) || /[?&]f=rss\b/i.test(u) || /\/feed\/?$/i.test(u) || /\/rss\/?$/i.test(u);

const FRONTALIERE = parseUrlList('NEWS_SOURCES');
const SVIZZERA = parseUrlList('NEWS_SOURCES_SVIZZERA');
const FRONTALIERE_FB = parseUrlMap('RSS_FALLBACK_MAP');
const SVIZZERA_FB = parseUrlMap('NEWS_SOURCES_SVIZZERA_FALLBACK_MAP');

const DUP_MARKER = '[dup:frontaliere]';

test('both lists parse and are non-empty (an empty list scans nothing, silently)', () => {
  assert.ok(FRONTALIERE.length > 20, `NEWS_SOURCES parsed as ${FRONTALIERE.length} entries`);
  assert.ok(SVIZZERA.length > 10, `NEWS_SOURCES_SVIZZERA parsed as ${SVIZZERA.length} entries`);
});

test('every entry is an absolute http(s) URL that URL() accepts', () => {
  // new URL(sourceUrl) runs unguarded in scanNewsSources' map callback, before
  // the try block that catches fetch failures — a malformed entry there is not
  // a failed source, it is an unhandled rejection.
  for (const { url } of [...FRONTALIERE, ...SVIZZERA]) {
    assert.doesNotThrow(() => new URL(url), `not a valid URL: ${url}`);
    assert.match(url, /^https?:\/\//, `not absolute: ${url}`);
  }
  for (const [k, v] of [...Object.entries(FRONTALIERE_FB), ...Object.entries(SVIZZERA_FB)]) {
    assert.doesNotThrow(() => new URL(v), `fallback target is not a valid URL: ${k} -> ${v}`);
  }
});

test('no duplicate URL inside the same list (trailing slash does not excuse it)', () => {
  for (const [name, list] of [['NEWS_SOURCES', FRONTALIERE], ['NEWS_SOURCES_SVIZZERA', SVIZZERA]]) {
    const seen = new Map();
    for (const { url } of list) {
      const key = norm(url);
      assert.equal(seen.has(key), false, `${name} lists ${url} twice (first as ${seen.get(key)})`);
      seen.set(key, url);
    }
  }
});

test('a URL shared between the two sections carries an explicit note', () => {
  // Sharing is allowed — national desks legitimately serve both audiences —
  // but it costs one classifier call per duplicated headline in each section,
  // so it has to be a decision someone wrote down rather than a copy-paste.
  const inFrontaliere = new Set(FRONTALIERE.map((e) => norm(e.url)));
  const unannotated = SVIZZERA
    .filter((e) => inFrontaliere.has(norm(e.url)) && !e.line.includes(DUP_MARKER))
    .map((e) => e.url);
  assert.deepEqual(
    unannotated,
    [],
    `these URLs are in NEWS_SOURCES too and need a '${DUP_MARKER}' note on their line:\n  ${unannotated.join('\n  ')}`,
  );
});

test('no stale [dup:frontaliere] note left on a URL that is no longer shared', () => {
  const inFrontaliere = new Set(FRONTALIERE.map((e) => norm(e.url)));
  const stale = SVIZZERA
    .filter((e) => e.line.includes(DUP_MARKER) && !inFrontaliere.has(norm(e.url)))
    .map((e) => e.url);
  assert.deepEqual(stale, [], `marked as shared but absent from NEWS_SOURCES:\n  ${stale.join('\n  ')}`);
});

test('every svizzera feed source has an HTML fallback', () => {
  // A feed that goes quiet for MAX_ARTICLE_AGE_DAYS contributes nothing and
  // says nothing: scanNewsSources logs "nessun fallback" and moves on. The
  // fallback is the only thing that turns a stale feed into headlines.
  const missing = SVIZZERA
    .map((e) => e.url)
    .filter((u) => looksLikeFeed(u) && !(u in SVIZZERA_FB));
  assert.deepEqual(missing, [], `feed sources with no NEWS_SOURCES_SVIZZERA_FALLBACK_MAP entry:\n  ${missing.join('\n  ')}`);
});

test('no orphan entry in either fallback map', () => {
  // rssFallbackMap is only ever read as rssFallbackMap[sourceUrl], so a key
  // that is not in the list it serves is unreachable — which is how the map
  // kept pointing at watson.ch's dead api/1.0 feed and at rsi.ch/info/mondo
  // long enough for both to be believed alive.
  for (const [name, map, list] of [
    ['RSS_FALLBACK_MAP', FRONTALIERE_FB, FRONTALIERE],
    ['NEWS_SOURCES_SVIZZERA_FALLBACK_MAP', SVIZZERA_FB, SVIZZERA],
  ]) {
    const urls = new Set(list.map((e) => e.url));
    const orphans = Object.keys(map).filter((k) => !urls.has(k));
    assert.deepEqual(orphans, [], `${name} has keys absent from its source list:\n  ${orphans.join('\n  ')}`);
  }
});

test('no fallback points at the source it is the fallback for', () => {
  for (const [name, map] of [['RSS_FALLBACK_MAP', FRONTALIERE_FB], ['NEWS_SOURCES_SVIZZERA_FALLBACK_MAP', SVIZZERA_FB]]) {
    for (const [k, v] of Object.entries(map)) {
      assert.notEqual(norm(v), norm(k), `${name}: ${k} falls back to itself`);
    }
  }
});

test('svizzera fallbacks stay on the host of the feed they serve', () => {
  // santesuisse.ch answered 200 for every path while silently 301'ing to
  // santeservices.ch. A fallback that leaves its own host is the same failure
  // written down on purpose, so require the hosts to agree.
  for (const [k, v] of Object.entries(SVIZZERA_FB)) {
    const feedHost = new URL(k).hostname.replace(/^(www\d?|media)\./, '');
    const fbHost = new URL(v).hostname.replace(/^(www\d?|media)\./, '');
    assert.equal(fbHost, feedHost, `fallback for ${k} leaves the host: ${v}`);
  }
});

test('the svizzera list carries no foreign-news desk', () => {
  // A "mondo"/"estero" desk is not a national source: measured 2026-08-10,
  // rsi.ch/info/mondo put 6 of 100 headlines through the anchor+topical gate
  // and all six were foreign (Messico, Francia, Meta/USA, Marocco, Ceuta,
  // FED). Every one of them still costs a classifier call before being
  // dropped as "notizia estera senza impatto diretto".
  const foreign = SVIZZERA.map((e) => e.url).filter((u) => /\/(mondo|estero|esteri|world)\b/i.test(u));
  assert.deepEqual(foreign, [], `foreign desks in a national section:\n  ${foreign.join('\n  ')}`);
});

// ── Domini condannati: la rimozione da UNA lista non e' una rimozione ──────
//
// Issue #190 punto 4. `santesuisse.ch` e `bag.admin.ch` sono stati tolti da
// NEWS_SOURCES_SVIZZERA il 2026-08-10 con la misura che li condanna scritta
// accanto, e sono rimasti in NEWS_SOURCES per tre giorni — dove producevano lo
// stesso nulla, contandosi pero' fra i `sources.succeeded`. Non e' una svista
// isolata: rimuovere e' un'operazione su UN array, e i due array non sanno
// l'uno dell'altro. Quello che segue non verifica i due domini di allora ma la
// forma del difetto — `DEAD_NEWS_DOMAINS` e' la dichiarazione unica, e vale su
// entrambe le liste.

/** Slice `const <name> = [ … \n];` and return the quoted domain strings in it. */
function parseDomainList(name) {
  const start = SRC.indexOf(`const ${name} = [`);
  assert.notEqual(start, -1, `${name} not found in create-article.mjs`);
  const end = SRC.indexOf('\n];', start);
  assert.notEqual(end, -1, `${name} has no closing bracket`);
  return [...SRC.slice(start, end).matchAll(/^\s*'([a-z0-9.-]+\.[a-z]{2,})',/gm)].map((m) => m[1]);
}

const DEAD_DOMAINS = parseDomainList('DEAD_NEWS_DOMAINS');

test('DEAD_NEWS_DOMAINS is declared and non-empty (an empty ledger checks nothing)', () => {
  assert.ok(DEAD_DOMAINS.length > 0, 'DEAD_NEWS_DOMAINS parsed as empty — the guard below would be vacuous');
  assert.ok(DEAD_DOMAINS.includes('santesuisse.ch'), 'the domain that made this guard necessary is not in the ledger');
  assert.ok(DEAD_DOMAINS.includes('bag.admin.ch'));
});

test('no dead domain survives in EITHER source list', () => {
  const offenders = [];
  for (const [name, list] of [['NEWS_SOURCES', FRONTALIERE], ['NEWS_SOURCES_SVIZZERA', SVIZZERA]]) {
    for (const { url } of list) {
      const host = new URL(url).hostname.replace(/^(www\d?|media)\./, '');
      const dead = DEAD_DOMAINS.find((d) => host === d || host.endsWith(`.${d}`));
      if (dead) offenders.push(`${name}: ${url} (dominio dichiarato morto: ${dead})`);
    }
  }
  assert.deepEqual(offenders, [], `fonti condannate ancora in lista:\n  ${offenders.join('\n  ')}`);
});

test('no dead domain is used as a fallback target either', () => {
  // Un fallback e' una fonte a tutti gli effetti: viene fetchato e parsato
  // esattamente come le altre, e un dominio morto li' dentro e' invisibile
  // perche' la mappa non viene mai letta finche' il feed principale regge.
  const offenders = [];
  for (const [name, map] of [['RSS_FALLBACK_MAP', FRONTALIERE_FB], ['NEWS_SOURCES_SVIZZERA_FALLBACK_MAP', SVIZZERA_FB]]) {
    for (const [k, v] of Object.entries(map)) {
      const host = new URL(v).hostname.replace(/^(www\d?|media)\./, '');
      const dead = DEAD_DOMAINS.find((d) => host === d || host.endsWith(`.${d}`));
      if (dead) offenders.push(`${name}: ${k} → ${v} (dominio dichiarato morto: ${dead})`);
    }
  }
  assert.deepEqual(offenders, [], `fallback verso domini condannati:\n  ${offenders.join('\n  ')}`);
});
