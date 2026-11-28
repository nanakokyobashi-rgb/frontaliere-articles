#!/usr/bin/env node
/**
 * Elenco versionato delle destinazioni dei link nel corpo degli articoli
 * (F6.3b): landing lavoro per cantone, landing per professione, landing
 * professione x cantone e landing lavoro nazionale, nelle quattro lingue.
 *
 * F6.3d: aggiunge le pagine tematiche per cantone (agenda eventi, tempi di
 * attesa ai valichi, aste targhe, stipendio per professione, strutture
 * sanitarie) e le pagine tematiche del Ticino (meteo, allerte, farmacie di
 * turno, giorni festivi, costo della vita, carburanti).
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

// F6.3d. Il cantone di ogni struttura sanitaria e' un dato dell'elenco, non si deduce dalla URL:
// solo le strutture pubbliche/cantonali il cui nome dice il cantone.
export const FACILITY_CANTON = {
  'eoc-ente-ospedaliero-cantonale': 'TI', luks: 'LU', ksa: 'AG', ksb: 'AG', ksw: 'ZH', usz: 'ZH', 'unispital-basel': 'BASILEA', ukbb: 'BASILEA',
  ksbl: 'BASILEA', 'kantonsspital-graubuenden-ksgr': 'GR', 'hopital-du-valais': 'VS', 'spital-thurgau': 'TG', 'spitaeler-schaffhausen': 'SH',
  'hfr-hopital-fribourgeois': 'FR', 'rhne-reseau-hospitalier-neuchatelois': 'NE', 'h-ju-hopital-du-jura': 'JU', 'zuger-kantonsspital': 'ZG',
  'spital-schwyz': 'SZ', 'spital-nidwalden': 'NW', ksow: 'OW', ksgl: 'GL',
};
// Pagine tematiche del Ticino: percorso IT -> id. Devono comparire nella sitemap pubblicata.
export const TICINO_PAGES = {
  'weather:hub': { sitemap: 'sitemap-weather.xml', path: '/meteo-frontalieri/' },
  'weather:lugano': { sitemap: 'sitemap-weather.xml', path: '/meteo-frontalieri/lugano/' },
  'weather:bellinzona': { sitemap: 'sitemap-weather.xml', path: '/meteo-frontalieri/bellinzona/' },
  'weather:mendrisio': { sitemap: 'sitemap-weather.xml', path: '/meteo-frontalieri/mendrisio/' },
  'weather:locarno': { sitemap: 'sitemap-weather.xml', path: '/meteo-frontalieri/locarno/' },
  'weather:chiasso': { sitemap: 'sitemap-weather.xml', path: '/meteo-frontalieri/chiasso/' },
  'weather-alerts:hub': { sitemap: 'sitemap-weather-alerts.xml', path: '/allerte-meteo/' },
  'weather-alerts:gotthard-snow': { sitemap: 'sitemap-weather-alerts.xml', path: '/allerte/neve-gottardo/' },
  'pharmacies:ticino': { sitemap: 'sitemap-farmacie.xml', path: '/farmacie/ticino/' },
  'pharmacies:on-duty': { sitemap: 'sitemap-farmacie.xml', path: '/farmacie-di-turno/' },
  'holidays:ticino': { sitemap: 'sitemap-holidays.xml', path: '/giorni-festivi-ticino/' },
  'school-holidays:2027': { sitemap: 'sitemap-school-calendar.xml', path: '/vita-in-ticino/vacanze-scolastiche-ticino-2027/' },
  'school-holidays:2028': { sitemap: 'sitemap-school-calendar.xml', path: '/vita-in-ticino/vacanze-scolastiche-ticino-2028/' },
  'school-holidays:2029': { sitemap: 'sitemap-school-calendar.xml', path: '/vita-in-ticino/vacanze-scolastiche-ticino-2029/' },
  'cost-of-living:ticino': { sitemap: 'sitemap-cost-of-living.xml', path: '/costo-vita-ticino/' },
  'cost-of-living:lugano': { sitemap: 'sitemap-cost-of-living.xml', path: '/costo-vita-lugano-ticino/' },
  'cost-of-living:mendrisio': { sitemap: 'sitemap-cost-of-living.xml', path: '/costo-vita-mendrisio-ticino/' },
  'cost-of-living:chiasso': { sitemap: 'sitemap-cost-of-living.xml', path: '/costo-vita-chiasso-ticino/' },
  'cost-of-living:bellinzona': { sitemap: 'sitemap-cost-of-living.xml', path: '/costo-vita-bellinzona-ticino/' },
  'cost-of-living:locarno': { sitemap: 'sitemap-cost-of-living.xml', path: '/costo-vita-locarno-ticino/' },
  'fuel:diesel': { sitemap: 'sitemap-fuel-daily.xml', path: '/prezzi-diesel/oggi/' },
  'fuel:petrol': { sitemap: 'sitemap-fuel-daily.xml', path: '/prezzi-benzina/oggi/' },
};
const BORDER_COUNTRIES = new Set(['como', 'varese', 'verbano', 'germania', 'francia', 'austria', 'liechtenstein', 'italia']);

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

  // ---- F6.3d: pagine tematiche per cantone e del Ticino. Il gemello localizzato viene
  // sempre dagli hreflang della pagina IT; una pagina non presente in sitemap o senza le quattro lingue esce.
  const twinOf = async (itPath, itPaths) => {
    if (!itPaths.has(itPath)) return null;
    const alternates = await readAlternates(itPath);
    return LOCALES.every((l) => alternates[l]) ? Object.fromEntries(LOCALES.map((l) => [l, alternates[l]])) : null;
  };
  const itSet = async (name) => new Set(sitemapLocs(await readXml(name)).map(toPath).filter((p) => localeOfPath(p) === 'it'));
  const resolveAll = async (entries, itPaths) => {
    const out = {};
    const quads = await mapLimit(entries, CONCURRENCY, ([, itPath]) => twinOf(itPath, itPaths));
    entries.forEach(([key], i) => { if (quads[i]) out[key] = quads[i]; });
    return out;
  };

  const eventPaths = await itSet('sitemap-eventi.xml');
  const eventsLanding = await resolveAll([...codeByItSlug].map(([slug, code]) => [code, `/eventi/${slug}/`]), eventPaths);

  const borderPaths = await itSet('sitemap-border-wait.xml');
  const borderEntries = [['hub', '/traffico-dogane/']];
  const slugToCode = new Map([...codeByItSlug, ['geneve', 'GE']]);
  for (const p of borderPaths) {
    const m = /^\/traffico-dogane\/([a-z-]+)-([a-z]+)\/$/.exec(p);
    if (!m || !BORDER_COUNTRIES.has(m[2]) || !slugToCode.has(m[1])) continue;
    borderEntries.push([`${slugToCode.get(m[1])}/${m[2]}`, p]);
  }
  const borderTraffic = await resolveAll(borderEntries, borderPaths);

  const platePaths = await itSet('sitemap-plate-auctions.xml');
  const plateEntries = [];
  for (const [slug, code] of codeByItSlug) {
    // I gruppi di mezzi cantoni (Appenzello, Basilea) hanno due pagine: nessuna e' «la» pagina del gruppo.
    if (code === 'APPENZELLO' || code === 'BASILEA') continue;
    plateEntries.push([code, `/aste-targhe-svizzera/${slug}-${code.toLowerCase()}/`]);
  }
  const plateAuctions = await resolveAll(plateEntries, platePaths);

  const salaryPaths = await itSet('sitemap-salary-profession-cantons.xml');
  const salaryEntries = [];
  for (const p of salaryPaths) {
    const m = /^\/stipendio-([a-z-]+)\/$/.exec(p);
    if (!m) continue;
    const itSlug = [...codeByItSlug.keys()].filter((c) => m[1].endsWith(`-${c}`)).sort((a, b) => b.length - a.length)[0];
    if (!itSlug) continue;
    salaryEntries.push([`${codeByItSlug.get(itSlug)}/${m[1].slice(0, -itSlug.length - 1)}`, p]);
  }
  const salaryProfession = await resolveAll(salaryEntries, salaryPaths);

  const facilityPaths = await itSet('sitemap-health-facilities.xml');
  const facilityLanding = await resolveAll(Object.entries(FACILITY_CANTON).map(([slug, code]) => [`${code}/${slug}`, `/strutture-sanitarie/${slug}/`]), facilityPaths);

  const ticinoPages = {};
  for (const sitemap of new Set(Object.values(TICINO_PAGES).map((v) => v.sitemap))) {
    const set = await itSet(sitemap);
    const entries = Object.entries(TICINO_PAGES).filter(([, v]) => v.sitemap === sitemap).map(([id, v]) => [id, v.path]);
    Object.assign(ticinoPages, await resolveAll(entries, set));
  }

  const all = [
    ...[eventsLanding, borderTraffic, plateAuctions, salaryProfession, facilityLanding, ticinoPages].flatMap((t) => Object.values(t)),
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
    source: 'sitemap-jobs*.xml, sitemap-professions.xml, sitemap-profession-cantons.xml, sitemap-health-premiums.xml, sitemap-minimum-wage.xml; F6.3d: sitemap-eventi.xml, sitemap-border-wait.xml, sitemap-plate-auctions.xml, sitemap-salary-profession-cantons.xml, sitemap-health-facilities.xml, sitemap-weather*.xml, sitemap-farmacie.xml, sitemap-holidays.xml, sitemap-school-calendar.xml, sitemap-cost-of-living.xml, sitemap-fuel-daily.xml (+ hreflang delle pagine IT)',
    verifiedBy: 'HTTP 200 e <link rel="canonical"> uguale al path, una lingua alla volta',
    cantonLanding: filter(cantonQuads),
    nationalLanding: national && keepQuad(national) ? national : null,
    professionLanding: filter(professions),
    professionCantonLanding: filter(professionCantons),
    topicLanding: Object.fromEntries(Object.entries(topicLanding).map(([topic, table]) => [topic, filter(table)])),
    eventsLanding: filter(eventsLanding),
    borderTraffic: filter(borderTraffic),
    plateAuctions: filter(plateAuctions),
    salaryProfession: filter(salaryProfession),
    facilityLanding: filter(facilityLanding),
    ticinoPages: filter(ticinoPages),
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
    + `premi ${Object.keys(data.topicLanding['health-premiums']).length}, salario minimo ${Object.keys(data.topicLanding['minimum-wage']).length}, `
    + `eventi ${Object.keys(data.eventsLanding).length}, valichi ${Object.keys(data.borderTraffic).length}, targhe ${Object.keys(data.plateAuctions).length}, `
    + `stipendi ${Object.keys(data.salaryProfession).length}, strutture ${Object.keys(data.facilityLanding).length}, ticino ${Object.keys(data.ticinoPages).length}, scartate ${data.rejected.length}`);
  if (check) process.exit(text === current ? 0 : 1);
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, text);
}
