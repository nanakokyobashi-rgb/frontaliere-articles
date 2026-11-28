#!/usr/bin/env node
/**
 * Elenco versionato delle destinazioni dei link nel corpo degli articoli
 * (F6.3b): landing lavoro per cantone, landing per professione, landing
 * professione x cantone e landing lavoro nazionale, nelle quattro lingue.
 *
 * Le URL NON si scrivono a mano: si leggono dalle sitemap pubblicate del sito
 * (confine sito-corpus = HTTP) e ognuna deve rispondere 200 con
 * `<link rel="canonical">` uguale a se stessa. Un'URL che non supera la verifica
 * esce dall'elenco e viene riportata in `rejected`.
 *
 *   node scripts/ci/build-body-link-destinations.mjs            # riscrive il JSON
 *   node scripts/ci/build-body-link-destinations.mjs --check    # solo verifica, esce 1 se cambia
 *
 * Uscita: generator/data/body-link-destinations.json. Il generatore lo legge
 * offline (generator/scripts/lib/body-link-destinations.mjs): nessuna rete a
 * tempo di generazione.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const OUTPUT = path.join(ROOT, 'generator', 'data', 'body-link-destinations.json');
const SITE = process.env.BODY_LINK_SITE_BASE || 'https://frontaliereticino.ch';
const USER_AGENT = 'Mozilla/5.0 (compatible; BodyLinkDestinations/1.0; +https://frontaliereticino.ch)';
const LOCALES = ['it', 'en', 'de', 'fr'];
const CONCURRENCY = 8;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function get(url, { retries = 3 } = {}) {
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, { redirect: 'manual', headers: { 'user-agent': USER_AGENT } });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await res.arrayBuffer().catch(() => {});
        await sleep(500 * 2 ** attempt);
        continue;
      }
      const body = res.status >= 300 && res.status < 400 ? '' : await res.text();
      return { status: res.status, body };
    } catch (error) {
      last = error;
      await sleep(500 * 2 ** attempt);
    }
  }
  return { status: 0, body: '', error: String(last?.message || last) };
}

async function mapLimit(items, limit, mapper) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next; next += 1; out[i] = await mapper(items[i], i); }
  }));
  return out;
}

export function sitemapLocs(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
}

export function toPath(url) {
  const u = new URL(url);
  return u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`;
}

export function localeOfPath(p) {
  const m = /^\/(en|de|fr)\//.exec(p);
  return m ? m[1] : 'it';
}

/** Raggruppa 4 URL per lingua in {it,en,de,fr}; scarta i gruppi incompleti. */
export function quadsOf(paths) {
  const byLocale = Object.fromEntries(LOCALES.map((l) => [l, []]));
  for (const p of paths) byLocale[localeOfPath(p)].push(p);
  const count = byLocale.it.length;
  if (!count || LOCALES.some((l) => byLocale[l].length !== count)) return [];
  return byLocale.it.map((_, i) => Object.fromEntries(LOCALES.map((l) => [l, byLocale[l][i]])));
}

export function canonicalOf(html) {
  // Il template emette anche attributi senza virgolette (`rel=canonical href=...`).
  const tag = /<link\b[^>]*\brel=["']?canonical["']?(?=[\s>/])[^>]*>/i.exec(html)?.[0];
  const href = tag && /\bhref=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(tag)?.slice(1).find(Boolean);
  if (!href) return null;
  try { return toPath(new URL(href, SITE).href); } catch { return null; }
}

/** Alternate per lingua dichiarate dalla pagina IT (`hreflang`), la fonte dei gemelli localizzati. */
export function hreflangAlternates(html) {
  const out = {};
  for (const tag of html.match(/<link\b[^>]*\brel=["']?alternate["']?[^>]*>/gi) || []) {
    const lang = /\bhreflang=["']?([a-z-]+)["']?/i.exec(tag)?.[1];
    const href = /\bhref=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(tag)?.slice(1).find(Boolean);
    if (LOCALES.includes(lang) && href) { try { out[lang] = toPath(new URL(href, SITE).href); } catch { /* href non valido */ } }
  }
  return out;
}

async function verify(paths) {
  const unique = [...new Set(paths)];
  const verdicts = new Map();
  await mapLimit(unique, CONCURRENCY, async (p) => {
    const res = await get(`${SITE}${p}`);
    const canonical = res.status === 200 ? canonicalOf(res.body) : null;
    verdicts.set(p, res.status === 200 && canonical === p ? { ok: true } : { ok: false, status: res.status, canonical });
  });
  return verdicts;
}

export async function build({
  readXml = async (name) => (await get(`${SITE}/${name}`)).body,
  readAlternates = async (itPath) => ({ it: itPath, ...hreflangAlternates((await get(`${SITE}${itPath}`)).body) }),
  verifyPaths = verify,
} = {}) {
  const slugs = JSON.parse(fs.readFileSync(path.join(ROOT, 'generator', 'data', 'canton-url-slugs.json'), 'utf8')).cantons;
  const codeByItSlug = new Map(Object.entries(slugs).map(([code, v]) => [v.it, code]));

  // Landing lavoro per cantone: sitemap-jobs-<slug-it>.xml = 4 URL (una per lingua);
  // il Ticino vive nelle prime 4 voci di sitemap-jobs.xml.
  const cantonQuads = {};
  for (const [itSlug, code] of codeByItSlug) {
    if (code === 'TI') continue;
    const quad = quadsOf(sitemapLocs(await readXml(`sitemap-jobs-${itSlug}.xml`)).map(toPath))[0];
    if (quad) cantonQuads[code] = quad;
  }
  const ticino = quadsOf(sitemapLocs(await readXml('sitemap-jobs.xml')).map(toPath).slice(0, 4))[0];
  if (ticino) cantonQuads.TI = ticino;
  const national = quadsOf(sitemapLocs(await readXml('sitemap-jobs-svizzera.xml')).map(toPath))[0] || null;

  // Landing per professione (Ticino) e professione x cantone.
  const professionQuads = quadsOf(sitemapLocs(await readXml('sitemap-professions.xml')).map(toPath));
  const professions = {};
  for (const quad of professionQuads) {
    const m = /^\/lavoro-ticino-([a-z-]+)\/$/.exec(quad.it);
    if (m) professions[m[1]] = quad;
  }
  const professionCantons = {};
  for (const quad of quadsOf(sitemapLocs(await readXml('sitemap-profession-cantons.xml')).map(toPath))) {
    const m = /^\/lavoro-([a-z-]+?)-([a-z-]+)\/$/.exec(quad.it);
    if (!m) continue;
    // Il cantone e' il prefisso piu' lungo che sia uno slug IT noto, il resto e' la professione.
    const parts = quad.it.slice('/lavoro-'.length, -1);
    const itSlug = [...codeByItSlug.keys()].filter((s) => parts.startsWith(`${s}-`)).sort((a, b) => b.length - a.length)[0];
    const profession = itSlug && parts.slice(itSlug.length + 1);
    if (!itSlug || !professions[profession]) continue;
    professionCantons[`${codeByItSlug.get(itSlug)}/${profession}`] = quad;
  }

  // Pagine tematiche per cantone (premi cassa malati, salario minimo): la pagina IT
  // viene dalla sitemap, i gemelli localizzati dai suoi hreflang.
  const topicLanding = {};
  const topics = [
    ['health-premiums', 'sitemap-health-premiums.xml', '/premi-cassa-malati/'],
    ['minimum-wage', 'sitemap-minimum-wage.xml', '/salario-minimo/'],
  ];
  for (const [topic, sitemap, hubPath] of topics) {
    const itPaths = sitemapLocs(await readXml(sitemap)).map(toPath).filter((p) => localeOfPath(p) === 'it');
    const table = {};
    const wanted = [[hubPath, 'CH'], ...[...codeByItSlug].map(([slug, code]) => [`${hubPath}${slug}/`, code])];
    for (const [itPath, code] of wanted) {
      if (!itPaths.includes(itPath)) continue;
      const alternates = await readAlternates(itPath);
      if (LOCALES.every((l) => alternates[l])) table[code] = Object.fromEntries(LOCALES.map((l) => [l, alternates[l]]));
    }
    topicLanding[topic] = table;
  }

  const all = [
    ...Object.values(topicLanding).flatMap((t) => Object.values(t)),
    ...Object.values(cantonQuads), ...(national ? [national] : []),
    ...Object.values(professions), ...Object.values(professionCantons),
  ].flatMap((q) => Object.values(q));
  const verdicts = await verifyPaths(all);
  const keepQuad = (quad) => LOCALES.every((l) => verdicts.get(quad[l])?.ok);
  const filter = (table) => Object.fromEntries(Object.entries(table).filter(([, q]) => keepQuad(q)));
  const rejected = [...new Set(all)].filter((p) => !verdicts.get(p)?.ok)
    .map((p) => ({ path: p, status: verdicts.get(p)?.status ?? null, canonical: verdicts.get(p)?.canonical ?? null }));

  return {
    schema: 1,
    source: 'sitemap-jobs*.xml, sitemap-professions.xml, sitemap-profession-cantons.xml, sitemap-health-premiums.xml, sitemap-minimum-wage.xml (+ hreflang delle pagine IT)',
    verifiedBy: 'HTTP 200 e <link rel="canonical"> uguale al path, una lingua alla volta',
    cantonLanding: filter(cantonQuads),
    nationalLanding: national && keepQuad(national) ? national : null,
    professionLanding: filter(professions),
    professionCantonLanding: filter(professionCantons),
    topicLanding: Object.fromEntries(Object.entries(topicLanding).map(([topic, table]) => [topic, filter(table)])),
    rejected,
  };
}

export function stable(value) { return `${JSON.stringify(value, null, 1)}\n`; }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const data = await build();
  const text = stable(data);
  const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : '';
  console.error(`cantoni ${Object.keys(data.cantonLanding).length}, professioni ${Object.keys(data.professionLanding).length}, `
    + `professione x cantone ${Object.keys(data.professionCantonLanding).length}, `
    + `premi ${Object.keys(data.topicLanding['health-premiums']).length}, salario minimo ${Object.keys(data.topicLanding['minimum-wage']).length}, scartate ${data.rejected.length}`);
  if (check) process.exit(text === current ? 0 : 1);
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, text);
}
