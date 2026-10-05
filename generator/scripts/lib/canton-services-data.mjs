/**
 * canton-services-data.mjs — la meta' pura di refresh-canton-services-data.mjs
 * (P9f del programma «sezioni articoli per cantone», D11).
 *
 * L'hub «servizi» di un cantone non ha una fonte sua: e' un AGGREGATORE di
 * dataset che il sito pubblica gia' su cdn.frontaliereticino.ch/data/ e che il
 * corpus legge via HTTP (il confine fra i repo). Un blocco per fonte, ciascuno
 * con `available` e, se manca, `reason` — lo stesso modello di
 * `daily-brief-data.mjs`: una fonte rotta toglie il suo blocco, non la vista.
 *
 *   premiums        ← health-premiums.json          (UFSP/BAG, 26 cantoni)
 *   plateAuctions   ← plate-auctions.json           (uffici cantonali, 26)
 *   pharmacyDuties  ← pharmacy-duty-cantons.json    (turni ufficiali dove esistono)
 *   weather         ← weather-snapshot.json         (citta' dello snapshot meteo)
 *
 * Nessun I/O qui: il fetch sta nello script, cosi' `node --test` esercita ogni
 * regola di degrado con fixture.
 *
 * Forma vs disponibilita'. Un documento che NON ha la forma attesa e' un
 * errore (`ShapeError`: il produttore e' cambiato, lo script esce non-zero e
 * non scrive niente — come refresh-border-wait-averages.mjs, che resta
 * morbido sull'irraggiungibile ma rifiuta cio' che ha scaricato e non e' il
 * suo artefatto). Un documento con la forma giusta ma vecchio, o senza dati
 * per quel cantone, rende il blocco `available: false` con il motivo.
 */

const HOUR_MS = 3600_000;

/** Lo snapshot aste del sito: oltre 24 h il refresh si e' fermato (PLATE_AUCTION_STATIC_MAX_AGE_MS). */
export const PLATE_AUCTIONS_MAX_AGE_MS = 24 * HOUR_MS;
/** Lo snapshot meteo si rinnova ogni 4 h: due giri persi sono gia' un dato vecchio. */
export const WEATHER_MAX_AGE_MS = 12 * HOUR_MS;
/** Turni: l'importazione e' giornaliera (04:23) con rilanci ogni 15 minuti. */
export const PHARMACY_MAX_AGE_MS = 48 * HOUR_MS;
/** I premi sono annuali: l'anno pubblicato non puo' essere piu' vecchio dell'anno in corso. */
export const PREMIUMS_MAX_YEAR_LAG = 0;

/**
 * Tolleranza sull'orologio del produttore. Un timestamp piu' avanti di cosi'
 * non e' «freschissimo»: e' un orologio sbagliato, e con un controllo solo su
 * `age > max` un payload fermo resterebbe disponibile oltre la soglia.
 */
export const CLOCK_SKEW_MS = 10 * 60_000;

/** Soglie della vista: sotto, la vista non si scrive (meglio la copia precedente). */
export const MIN_SOURCES_OK = 2;
export const MIN_CANTONS_WITH_BLOCK = 20;

/** Quante voci per blocco tiene la vista (e' un riassunto per l'hub, non un mirror). */
const MAX_DUTIES = 6;
const MAX_AUCTION_HIGHLIGHTS = 3;

/**
 * Citta' dello snapshot meteo → cantone, per le voci che non portano il campo
 * `canton` (lo snapshot del sito lo aggiunge a ogni citta' da P9f in poi;
 * questa mappa copre le registrazioni precedenti). Una citta' CH senza ne'
 * campo ne' voce NON viene assegnata a caso: finisce in `unmappedWeatherCities`.
 */
export const WEATHER_CITY_CANTON = Object.freeze({
  lugano: 'TI',
  bellinzona: 'TI',
  mendrisio: 'TI',
  locarno: 'TI',
  chiasso: 'TI',
});
/** I 26 codici cantonali reali (i membri dei 24 gruppi URL). */
const SWISS_CANTON_CODES = new Set(['AG', 'AI', 'AR', 'BE', 'BL', 'BS', 'FR', 'GE', 'GL', 'GR', 'JU', 'LU', 'NE', 'NW', 'OW', 'SG', 'SH', 'SO', 'SZ', 'TG', 'TI', 'UR', 'VD', 'VS', 'ZG', 'ZH']);
/** Citta' italiane dello snapshot: lato residenza dei frontalieri, nessun cantone. */
const WEATHER_IT_CITIES = new Set(['como', 'varese', 'lecco']);

export class ShapeError extends Error {}

const ISO_TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/;
/** Solo link assoluti http(s) con host: gli hub li renderanno cliccabili. */
function httpUrlOrNull(value) {
  if (typeof value !== 'string') return null;
  try {
    const u = new URL(value);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname ? u.href : null;
  } catch {
    return null;
  }
}

/** Millisecondi di un timestamp ISO 8601 con fuso; NaN per qualunque altra cosa. */
function isoTimestampMs(value) {
  return typeof value === 'string' && ISO_TIMESTAMP.test(value) ? Date.parse(value) : NaN;
}

/**
 * Gruppo URL → cantoni membri: la stessa tabella di
 * `generator/data/canton-url-slugs.json` (`cantons` + `cantonGroups`), qui
 * come costante perche' il refresh viene copiato da solo nei test del REWIRE
 * set; un test di parita' la tiene allineata al file.
 */
export const CANTON_GROUPS = Object.freeze({
  AG: ['AG'], APPENZELLO: ['AI', 'AR'], BE: ['BE'], BASILEA: ['BL', 'BS'], FR: ['FR'], GE: ['GE'], GL: ['GL'], GR: ['GR'],
  JU: ['JU'], LU: ['LU'], NE: ['NE'], NW: ['NW'], OW: ['OW'], SG: ['SG'], SH: ['SH'], SO: ['SO'], SZ: ['SZ'], TG: ['TG'],
  TI: ['TI'], UR: ['UR'], VD: ['VD'], VS: ['VS'], ZG: ['ZG'], ZH: ['ZH'],
});

const unavailable = (reason) => ({ available: false, reason });
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function median(nums) {
  const s = nums.slice().sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return Number((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2).toFixed(2));
}

// ── premi cassa malati ───────────────────────────────────────────────────────

/** Forma minima di health-premiums.json. @throws {ShapeError} */
export function assertPremiumsShape(doc) {
  if (!isObj(doc)) throw new ShapeError('health-premiums: not an object');
  if (!Number.isInteger(doc.year)) throw new ShapeError('health-premiums: year is not an integer');
  if (!isObj(doc.quotes) || Object.keys(doc.quotes).length < 20) throw new ShapeError('health-premiums: quotes{} missing or with fewer than 20 cantons');
  if (!Array.isArray(doc.insurers)) throw new ShapeError('health-premiums: insurers[] missing');
}

/**
 * Premio mensile adulto (ERW), franchigia 300 CHF, con infortunio, modello
 * standard: la stessa base della «prima media» dell'UFSP. Per regione di premio
 * di ogni cantone membro: minimo, mediana e massimo fra gli assicuratori.
 */
export function shapePremiums(doc, members, { nowMs = Date.now() } = {}) {
  if (!doc) return unavailable('health-premiums.json non raggiungibile');
  const currentYear = new Date(nowMs).getUTCFullYear();
  if (doc.year < currentYear - PREMIUMS_MAX_YEAR_LAG) return unavailable(`premi ${doc.year} piu' vecchi dell'anno in corso (${currentYear})`);
  const regions = [];
  for (const code of members) {
    const byRegion = doc.quotes[code];
    if (!isObj(byRegion)) continue;
    for (const [region, insurers] of Object.entries(byRegion)) {
      const values = [];
      for (const ins of Object.values(insurers ?? {})) {
        const v = finite(ins?.ERW?.withAccident?.['300']?.standard);
        if (v != null && v > 0) values.push(v);
      }
      if (!values.length) continue;
      regions.push({
        canton: code,
        region: Number(region),
        insurers: values.length,
        standardMin: Math.min(...values),
        standardMedian: median(values),
        standardMax: Math.max(...values),
      });
    }
  }
  if (!regions.length) return unavailable(`nessun premio adulto standard per ${members.join('+')}`);
  return {
    available: true,
    year: doc.year,
    fetchedAt: Number.isFinite(isoTimestampMs(doc.fetchedAt)) ? doc.fetchedAt : null,
    basis: { ageClass: 'ERW', franchiseChf: 300, accident: true, model: 'standard', unit: 'CHF/mese' },
    regions,
  };
}

// ── aste targhe ──────────────────────────────────────────────────────────────

/** @throws {ShapeError} */
export function assertPlateAuctionsShape(doc) {
  if (!isObj(doc)) throw new ShapeError('plate-auctions: not an object');
  if (doc.schema !== 1) throw new ShapeError(`plate-auctions: schema is ${JSON.stringify(doc.schema)}, expected 1`);
  if (!Array.isArray(doc.auctions)) throw new ShapeError('plate-auctions: auctions[] missing');
  if (!isObj(doc.sources)) throw new ShapeError('plate-auctions: sources{} missing');
  if (!Number.isFinite(Date.parse(doc.generatedAt ?? ''))) throw new ShapeError('plate-auctions: generatedAt is not a date');
}

export function shapePlateAuctions(doc, members, { nowMs = Date.now() } = {}) {
  if (!doc) return unavailable('plate-auctions.json non raggiungibile');
  const age = nowMs - Date.parse(doc.generatedAt);
  if (age < -CLOCK_SKEW_MS) return unavailable(`snapshot aste datato nel futuro (${doc.generatedAt})`);
  if (age > PLATE_AUCTIONS_MAX_AGE_MS) return unavailable(`snapshot aste vecchio di ${Math.round(age / HOUR_MS)} h (max ${PLATE_AUCTIONS_MAX_AGE_MS / HOUR_MS} h)`);
  const codes = new Set(members.map((m) => m.toUpperCase()));
  const sources = members.map((m) => doc.sources[m.toLowerCase()]).filter(Boolean);
  const active = doc.auctions.filter(
    (a) => codes.has(String(a?.sourceKey ?? '').toUpperCase()) && (a.auctionStatus === 'active' || a.auctionStatus === 'upcoming') && Date.parse(a.endsAt ?? '') > nowMs,
  );
  if (!sources.length) return unavailable(`nessuna fonte aste registrata per ${members.join('+')}`);
  const bids = active.map((a) => finite(a.currentBidChf)).filter((v) => v != null && v > 0);
  const highlights = active
    .filter((a) => finite(a.currentBidChf) != null)
    .sort((a, b) => b.currentBidChf - a.currentBidChf)
    .slice(0, MAX_AUCTION_HIGHLIGHTS)
    .map((a) => ({
      plate: a.normalizedPlate ?? `${a.platePrefix ?? ''}${a.plateNumber ?? ''}`,
      currentBidChf: a.currentBidChf,
      endsAt: new Date(Date.parse(a.endsAt)).toISOString(),
      url: httpUrlOrNull(a.officialDetailUrl),
    }));
  return {
    available: true,
    generatedAt: doc.generatedAt,
    officialUrls: [...new Set(sources.map((s) => httpUrlOrNull(s.officialUrl)).filter(Boolean))],
    sourceStatus: sources.map((s) => s.status ?? null),
    activeCount: active.length,
    bidMedianChf: median(bids),
    bidMaxChf: bids.length ? Math.max(...bids) : null,
    // per istante, non per stringa: fusi diversi ordinerebbero male
    nextEndsAt: active.length ? new Date(Math.min(...active.map((a) => Date.parse(a.endsAt)))).toISOString() : null,
    highlights,
  };
}

// ── turni farmacia ───────────────────────────────────────────────────────────

/** @throws {ShapeError} */
export function assertPharmacyDutyCantonsShape(doc) {
  if (!isObj(doc)) throw new ShapeError('pharmacy-duty-cantons: not an object');
  if (doc.schemaVersion !== 1) throw new ShapeError(`pharmacy-duty-cantons: schemaVersion is ${JSON.stringify(doc.schemaVersion)}, expected 1`);
  if (!isObj(doc.cantons) || !Object.keys(doc.cantons).length) throw new ShapeError('pharmacy-duty-cantons: cantons{} missing or empty');
  for (const [g, c] of Object.entries(doc.cantons)) {
    if (!Array.isArray(c?.duties)) throw new ShapeError(`pharmacy-duty-cantons: ${g}.duties[] missing`);
    // Ogni turno, non solo la lista: un turno con date illeggibili verrebbe
    // ordinato con NaN e pubblicato come disponibile.
    c.duties.forEach((d, i) => {
      // Solo stringhe ISO con ora e fuso: Date.parse convertirebbe in silenzio
      // numeri e altri valori JSON, che poi finirebbero tali e quali nella vista.
      const start = isoTimestampMs(d?.startsAt);
      const end = isoTimestampMs(d?.endsAt);
      if (typeof d?.pharmacy !== 'string' || !d.pharmacy.trim()) throw new ShapeError(`pharmacy-duty-cantons: ${g}.duties[${i}].pharmacy missing`);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        throw new ShapeError(`pharmacy-duty-cantons: ${g}.duties[${i}] has no valid startsAt < endsAt`);
      }
    });
  }
}

export function shapePharmacyDuties(doc, group, { nowMs = Date.now() } = {}) {
  if (!doc) return unavailable('pharmacy-duty-cantons.json non raggiungibile');
  const c = doc.cantons[group];
  if (!c) return unavailable('nessuna fonte ufficiale di turni farmacia leggibile a macchina per questo cantone');
  if (c.state !== 'fresh') return unavailable(`rilascio dei turni non pubblicabile (${c.state})`);
  // Senza un'ora d'importazione leggibile la freschezza non si puo' misurare:
  // il blocco degrada invece di saltare il controllo.
  const fetched = Date.parse(c.fetchedAt ?? doc.generatedAt ?? '');
  if (!Number.isFinite(fetched)) return unavailable('turni senza data di importazione leggibile: freschezza non verificabile');
  if (nowMs - fetched < -CLOCK_SKEW_MS) return unavailable(`turni datati nel futuro (${c.fetchedAt ?? doc.generatedAt})`);
  if (nowMs - fetched > PHARMACY_MAX_AGE_MS) return unavailable(`turni importati ${Math.round((nowMs - fetched) / HOUR_MS)} h fa (max ${PHARMACY_MAX_AGE_MS / HOUR_MS} h)`);
  // Ordine cronologico PRIMA del tetto: il contratto non garantisce l'ordine,
  // e tagliare una lista disordinata scarterebbe i turni piu' vicini.
  const upcoming = c.duties
    .filter((d) => Date.parse(d.endsAt) > nowMs)
    .sort(
      (a, b) =>
        Date.parse(a.startsAt) - Date.parse(b.startsAt) ||
        Date.parse(a.endsAt) - Date.parse(b.endsAt) ||
        String(a.pharmacy).localeCompare(String(b.pharmacy)),
    )
    .slice(0, MAX_DUTIES);
  if (!upcoming.length) return unavailable('nessun turno in corso o in arrivo nella finestra pubblicata');
  return {
    available: true,
    fetchedAt: c.fetchedAt ?? null,
    sourceUrl: c.sourceUrl ?? null,
    dutyHubPath: doc.dutyHubPath ?? null,
    duties: upcoming.map((d) => ({
      pharmacy: d.pharmacy,
      city: typeof d.city === 'string' ? d.city : null,
      coverageName: typeof d.coverageName === 'string' ? d.coverageName : null,
      dutyType: typeof d.dutyType === 'string' ? d.dutyType : null,
      // normalizzati: nella vista escono solo timestamp UTC validati
      startsAt: new Date(Date.parse(d.startsAt)).toISOString(),
      endsAt: new Date(Date.parse(d.endsAt)).toISOString(),
    })),
  };
}

// ── meteo ────────────────────────────────────────────────────────────────────

/** @throws {ShapeError} */
export function assertWeatherShape(doc) {
  if (!isObj(doc)) throw new ShapeError('weather-snapshot: not an object');
  if (!Number.isFinite(Date.parse(doc.generatedAt ?? ''))) throw new ShapeError('weather-snapshot: generatedAt is not a date');
  if (!isObj(doc.cities) || !Object.keys(doc.cities).length) throw new ShapeError('weather-snapshot: cities{} missing or empty');
}

export function shapeWeather(doc, members, { nowMs = Date.now() } = {}) {
  if (!doc) return unavailable('weather-snapshot.json non raggiungibile');
  const age = nowMs - Date.parse(doc.generatedAt);
  if (age < -CLOCK_SKEW_MS) return unavailable(`snapshot meteo datato nel futuro (${doc.generatedAt})`);
  if (age > WEATHER_MAX_AGE_MS) return unavailable(`snapshot meteo vecchio di ${Math.round(age / HOUR_MS)} h (max ${WEATHER_MAX_AGE_MS / HOUR_MS} h)`);
  const cities = [];
  for (const [id, city] of Object.entries(doc.cities)) {
    if (!members.includes(cityCanton(id, city))) continue;
    const today = Array.isArray(city?.daily7) ? city.daily7[0] : null;
    cities.push({
      cityId: id,
      name: typeof city?.name === 'string' ? city.name : null,
      temperatureC: finite(city?.current?.temperature),
      weatherCode: finite(city?.current?.weatherCode),
      todayMaxC: finite(today?.tempMax),
      todayMinC: finite(today?.tempMin),
      precipProb: finite(today?.precipProb),
    });
  }
  if (!cities.length) return unavailable('nessuna citta\' di questo cantone nello snapshot meteo del sito');
  return { available: true, generatedAt: doc.generatedAt, cities };
}

/**
 * Il cantone (codice reale, es. BS) di una citta' dello snapshot: il campo
 * `canton` se c'e', altrimenti la mappa. I gruppi URL si risolvono dai membri.
 */
function cityCanton(id, city) {
  // Solo un codice cantonale vero: un valore sconosciuto non appartiene a
  // nessun gruppo e farebbe sparire la citta' in silenzio, quindi conta come
  // non mappato (e `unmappedWeatherCities` lo segnala).
  if (city?.canton != null) return SWISS_CANTON_CODES.has(city.canton) ? city.canton : null;
  return WEATHER_CITY_CANTON[id] ?? null;
}

/** Citta' CH dello snapshot senza cantone (ne' campo ne' mappa): da mappare, non da indovinare. */
export function unmappedWeatherCities(doc) {
  return Object.entries(doc?.cities ?? {})
    .filter(([id, city]) => !cityCanton(id, city) && city?.country !== 'IT' && !WEATHER_IT_CITIES.has(String(id).toLowerCase()))
    .map(([id]) => id);
}

// ── vista ────────────────────────────────────────────────────────────────────

/**
 * @param {{ premiums: object|null, plateAuctions: object|null, pharmacyDuties: object|null, weather: object|null }} inputs
 *   null = sorgente non raggiungibile (degrada il blocco). Le forme vanno
 *   verificate PRIMA con gli assert*Shape (lo fa lo script).
 * @param {Record<string,string[]>} groups  gruppo URL → cantoni membri
 */
export function buildCantonServices(inputs, groups, { nowMs = Date.now() } = {}) {
  const cantons = {};
  for (const [group, members] of Object.entries(groups)) {
    const blocks = {
      premiums: shapePremiums(inputs.premiums, members, { nowMs }),
      plateAuctions: shapePlateAuctions(inputs.plateAuctions, members, { nowMs }),
      pharmacyDuties: shapePharmacyDuties(inputs.pharmacyDuties, group, { nowMs }),
      weather: shapeWeather(inputs.weather, members, { nowMs }),
    };
    cantons[group] = { members, availableBlocks: Object.values(blocks).filter((b) => b.available).length, blocks };
  }
  const sources = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, { reachable: v != null }]));
  return {
    schemaVersion: 1,
    generatedAt: new Date(nowMs).toISOString(),
    sources,
    counts: {
      sourcesOk: Object.values(sources).filter((s) => s.reachable).length,
      cantonsWithBlock: Object.values(cantons).filter((c) => c.availableBlocks > 0).length,
      byBlock: Object.fromEntries(Object.keys(Object.values(cantons)[0]?.blocks ?? {}).map((b) => [b, Object.values(cantons).filter((c) => c.blocks[b].available).length])),
    },
    unmappedWeatherCities: unmappedWeatherCities(inputs.weather),
    cantons,
  };
}

/** @returns {string[]} motivi per NON scrivere la vista */
export function viewThresholdFailures(view) {
  const out = [];
  if (view.counts.sourcesOk < MIN_SOURCES_OK) out.push(`solo ${view.counts.sourcesOk} fonti raggiungibili (min ${MIN_SOURCES_OK})`);
  if (view.counts.cantonsWithBlock < MIN_CANTONS_WITH_BLOCK) out.push(`solo ${view.counts.cantonsWithBlock} cantoni con almeno un blocco (min ${MIN_CANTONS_WITH_BLOCK})`);
  return out;
}
