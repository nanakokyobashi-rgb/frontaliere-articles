/**
 * blocks-services.mjs — i blocchi dell'hub servizi, dalla VISTA
 * `generator/data/canton-services.json` che `refresh-canton-services-data.mjs`
 * costruisce dai quattro dataset del sito (premi cassa malati, turni farmacia,
 * aste targhe, meteo). La vista decide gia', blocco per blocco, se il dato di
 * un cantone e' pubblicabile (`available`); qui si ricontrolla solo cio' che
 * invecchia fra il refresh e la scrittura dell'hub (turni e aste gia' finiti).
 */
import { fmtAmount, fmtChf, fmtNumber, httpsUrlOrNull } from './format.mjs';
import { BLOCK_THRESHOLDS, finite, freshnessProblem, instantMs, isObj, omitted } from './blocks-common.mjs';

export const SERVICES_BLOCK_IDS = Object.freeze({
  premiums: 'premi-cassa-malati',
  pharmacyDuties: 'farmacie-di-turno',
  plateAuctions: 'aste-targhe',
  weather: 'meteo',
});

const TXT = {
  it: {
    premiums: {
      title: (year) => `Premi di cassa malati ${year}`,
      description: 'Premio mensile dell’assicurazione di base per un adulto con franchigia di 300 franchi, infortunio incluso, modello standard: minimo, mediana e massimo fra gli assicuratori di ogni regione di premio.',
      region: (canton, region) => `${canton}, regione di premio ${region}`,
      value: (median) => `mediana ${median} CHF al mese`,
      detail: (min, max, n) => `da ${min} a ${max} CHF, ${n} assicuratori`,
      source: 'Ufficio federale della sanità pubblica (UFSP)',
      fact: (year) => `Premio mediano adulto ${year}`,
      note: (region) => `regione di premio ${region}, franchigia 300 CHF`,
    },
    duties: { title: 'Farmacie di turno', description: 'Prossimi turni di guardia pubblicati dalla fonte ufficiale del cantone.', source: 'Servizio ufficiale dei turni farmacia' },
    auctions: {
      title: 'Aste delle targhe',
      description: 'Aste ufficiali di targhe in corso nel cantone, con le offerte più alte al momento della rilevazione.',
      detail: 'offerta attuale',
      source: 'Ufficio cantonale della circolazione',
      fact: 'Aste di targhe in corso',
      note: (median) => `offerta mediana ${median}`,
    },
    weather: { title: 'Meteo', description: 'Temperatura attuale e previsione di oggi nelle città del cantone seguite dal sito.', detail: (min, max) => `oggi da ${min} a ${max} °C`, max: (v) => `massima di oggi ${v} °C`, min: (v) => `minima di oggi ${v} °C`, source: 'Meteo di Frontaliere Ticino' },
  },
  en: {
    premiums: {
      title: (year) => `Health insurance premiums ${year}`,
      description: 'Monthly basic insurance premium for an adult with a CHF 300 deductible, accident cover included, standard model: lowest, typical (middle value) and highest among the insurers of each premium region.',
      region: (canton, region) => `${canton}, premium region ${region}`,
      value: (median) => `typical ${median} CHF per month`,
      detail: (min, max, n) => `from ${min} to ${max} CHF, ${n} insurers`,
      source: 'Federal Office of Public Health (FOPH)',
      fact: (year) => `Typical adult premium ${year}`,
      note: (region) => `premium region ${region}, CHF 300 deductible`,
    },
    duties: { title: 'On-duty pharmacies', description: 'Upcoming duty shifts published by the canton’s official service.', source: 'Official pharmacy duty service' },
    auctions: {
      title: 'Number plate auctions',
      description: 'Official number plate auctions running in the canton, with the highest bids at the time of the snapshot.',
      detail: 'current bid',
      source: 'Cantonal road traffic office',
      fact: 'Plate auctions running',
      note: (median) => `typical bid ${median}`,
    },
    weather: { title: 'Weather', description: 'Current temperature and today’s forecast in the canton’s cities covered by the site.', detail: (min, max) => `today from ${min} to ${max} °C`, max: (v) => `today’s high ${v} °C`, min: (v) => `today’s low ${v} °C`, source: 'Frontaliere Ticino weather' },
  },
  de: {
    premiums: {
      title: (year) => `Krankenkassenprämien ${year}`,
      description: 'Monatsprämie der Grundversicherung für Erwachsene mit Franchise 300 Franken, mit Unfalldeckung, Standardmodell: tiefster, mittlerer und höchster Wert unter den Versicherern jeder Prämienregion.',
      region: (canton, region) => `${canton}, Prämienregion ${region}`,
      value: (median) => `Mittelwert ${median} CHF pro Monat`,
      detail: (min, max, n) => `von ${min} bis ${max} CHF, ${n} Versicherer`,
      source: 'Bundesamt für Gesundheit (BAG)',
      fact: (year) => `Mittlere Erwachsenenprämie ${year}`,
      note: (region) => `Prämienregion ${region}, Franchise 300 CHF`,
    },
    duties: { title: 'Notfallapotheken', description: 'Nächste Notfalldienste gemäss der offiziellen Stelle des Kantons.', source: 'Offizieller Apotheken-Notfalldienst' },
    auctions: {
      title: 'Kontrollschild-Auktionen',
      description: 'Laufende offizielle Kontrollschild-Auktionen im Kanton mit den höchsten Geboten zum Zeitpunkt der Erhebung.',
      detail: 'aktuelles Gebot',
      source: 'Kantonales Strassenverkehrsamt',
      fact: 'Laufende Kontrollschild-Auktionen',
      note: (median) => `mittleres Gebot ${median}`,
    },
    weather: { title: 'Wetter', description: 'Aktuelle Temperatur und heutige Prognose in den Städten des Kantons, die die Website abdeckt.', detail: (min, max) => `heute ${min} bis ${max} °C`, max: (v) => `Höchstwert heute ${v} °C`, min: (v) => `Tiefstwert heute ${v} °C`, source: 'Wetter von Frontaliere Ticino' },
  },
  fr: {
    premiums: {
      title: (year) => `Primes d’assurance-maladie ${year}`,
      description: 'Prime mensuelle de l’assurance de base pour un adulte avec franchise de 300 francs, accident inclus, modèle standard : valeur la plus basse, valeur centrale et valeur la plus haute parmi les assureurs de chaque région de primes.',
      region: (canton, region) => `${canton}, région de primes ${region}`,
      value: (median) => `valeur centrale ${median} CHF par mois`,
      detail: (min, max, n) => `de ${min} à ${max} CHF, ${n} assureurs`,
      source: 'Office fédéral de la santé publique (OFSP)',
      fact: (year) => `Prime adulte centrale ${year}`,
      note: (region) => `région de primes ${region}, franchise 300 CHF`,
    },
    duties: { title: 'Pharmacies de garde', description: 'Prochaines gardes publiées par le service officiel du canton.', source: 'Service officiel des pharmacies de garde' },
    auctions: {
      title: 'Enchères de plaques',
      description: 'Enchères officielles de plaques d’immatriculation en cours dans le canton, avec les offres les plus élevées au moment du relevé.',
      detail: 'offre actuelle',
      source: 'Office cantonal de la circulation',
      fact: 'Enchères de plaques en cours',
      note: (median) => `offre centrale ${median}`,
    },
    weather: { title: 'Météo', description: 'Température actuelle et prévision du jour dans les villes du canton suivies par le site.', detail: (min, max) => `aujourd’hui de ${min} à ${max} °C`, max: (v) => `maximale du jour ${v} °C`, min: (v) => `minimale du jour ${v} °C`, source: 'Météo de Frontaliere Ticino' },
  },
};

function fromView(id, view, canton, key, nowMs) {
  if (view == null) return { skip: omitted(id, 'missing', 'canton-services.json non in cache') };
  if (!isObj(view) || view.schemaVersion !== 1 || !isObj(view.cantons)) return { skip: omitted(id, 'invalid', 'canton-services.json: forma non riconosciuta') };
  const stale = freshnessProblem(view.generatedAt, nowMs, BLOCK_THRESHOLDS.services.maxAgeMs, 'canton-services.json');
  if (stale) return { skip: omitted(id, stale.code, stale.reason) };
  const block = view.cantons[canton]?.blocks?.[key];
  if (!isObj(block)) return { skip: omitted(id, 'invalid', `canton-services.json: blocco ${key} assente per ${canton}`) };
  if (block.available !== true) return { skip: omitted(id, 'empty', String(block.reason ?? 'non disponibile')) };
  return { block };
}

/** Premi dell'assicurazione di base per regione di premio. */
export function shapePremiumsBlock(view, { canton, nowMs }) {
  const id = SERVICES_BLOCK_IDS.premiums;
  const { block, skip } = fromView(id, view, canton, 'premiums', nowMs);
  if (skip) return skip;
  const regions = (Array.isArray(block.regions) ? block.regions : [])
    .filter((r) => isObj(r) && finite(r.standardMin) != null && finite(r.standardMedian) != null && finite(r.standardMax) != null && Number.isInteger(r.region))
    .sort((a, b) => String(a.canton).localeCompare(String(b.canton)) || a.region - b.region);
  if (!regions.length || !Number.isInteger(block.year)) return omitted(id, 'empty', `nessuna regione di premio leggibile per ${canton}`);
  return {
    id,
    available: true,
    // I premi sono annuali: lo snapshot e' la data di scarico dichiarata, se c'e'.
    updatedAt: Number.isFinite(instantMs(block.fetchedAt)) ? block.fetchedAt : view.generatedAt,
    maxAgeMs: BLOCK_THRESHOLDS.services.maxAgeMs,
    render(locale) {
      const t = TXT[locale].premiums;
      const first = regions[0];
      return {
        title: t.title(block.year),
        description: t.description,
        items: regions.map((r) => ({
          label: t.region(r.canton, r.region),
          value: t.value(fmtAmount(r.standardMedian, locale)),
          detail: t.detail(fmtAmount(r.standardMin, locale), fmtAmount(r.standardMax, locale), fmtNumber(r.insurers, locale)),
        })),
        sourceName: t.source,
        sourceUrl: 'https://www.priminfo.admin.ch/',
        keyFacts: [{ label: t.fact(block.year), value: `${fmtAmount(first.standardMedian, locale)} CHF`, note: t.note(first.region), sourceName: t.source }],
      };
    },
  };
}

/** Prossimi turni di guardia delle farmacie. */
export function shapePharmacyDutiesBlock(view, { canton, nowMs }) {
  const id = SERVICES_BLOCK_IDS.pharmacyDuties;
  const { block, skip } = fromView(id, view, canton, 'pharmacyDuties', nowMs);
  if (skip) return skip;
  const duties = (Array.isArray(block.duties) ? block.duties : [])
    .filter((d) => isObj(d) && typeof d.pharmacy === 'string' && d.pharmacy.trim() && instantMs(d.endsAt) > nowMs && Number.isFinite(instantMs(d.startsAt)));
  if (!duties.length) return omitted(id, 'empty', `nessun turno farmacia ancora in corso per ${canton}`);
  const sourceUrl = httpsUrlOrNull(block.sourceUrl);
  return {
    id,
    available: true,
    updatedAt: block.fetchedAt,
    maxAgeMs: BLOCK_THRESHOLDS.services.maxAgeMs,
    render(locale) {
      const t = TXT[locale].duties;
      return {
        title: t.title,
        description: t.description,
        items: duties.map((d) => ({
          label: d.pharmacy.trim(),
          ...(d.city || d.coverageName ? { detail: [d.city, d.coverageName].filter(Boolean).join(', ') } : {}),
          date: d.startsAt,
        })),
        sourceName: t.source,
        ...(sourceUrl ? { sourceUrl } : {}),
        keyFacts: [],
      };
    },
  };
}

/** Aste ufficiali delle targhe. */
export function shapePlateAuctionsBlock(view, { canton, nowMs }) {
  const id = SERVICES_BLOCK_IDS.plateAuctions;
  const { block, skip } = fromView(id, view, canton, 'plateAuctions', nowMs);
  if (skip) return skip;
  const highlights = (Array.isArray(block.highlights) ? block.highlights : [])
    .filter((h) => isObj(h) && typeof h.plate === 'string' && h.plate && finite(h.currentBidChf) != null && instantMs(h.endsAt) > nowMs);
  if (!highlights.length || !Number.isInteger(block.activeCount) || block.activeCount < 1) {
    return omitted(id, 'empty', `nessuna asta di targhe ancora aperta per ${canton}`);
  }
  const officialUrl = (Array.isArray(block.officialUrls) ? block.officialUrls : []).map(httpsUrlOrNull).find(Boolean);
  return {
    id,
    available: true,
    updatedAt: block.generatedAt,
    maxAgeMs: BLOCK_THRESHOLDS.services.maxAgeMs,
    render(locale) {
      const t = TXT[locale].auctions;
      return {
        title: t.title,
        description: t.description,
        items: highlights.map((h) => {
          const url = httpsUrlOrNull(h.url);
          return { label: h.plate, value: fmtChf(h.currentBidChf, locale), detail: t.detail, date: h.endsAt, ...(url ? { url } : {}) };
        }),
        sourceName: t.source,
        ...(officialUrl ? { sourceUrl: officialUrl } : {}),
        keyFacts: [{
          label: t.fact,
          value: fmtNumber(block.activeCount, locale),
          ...(finite(block.bidMedianChf) != null ? { note: t.note(fmtChf(block.bidMedianChf, locale)) } : {}),
        }],
      };
    },
  };
}

/** Meteo delle citta' del cantone coperte dal sito. */
export function shapeWeatherBlock(view, { canton, nowMs }) {
  const id = SERVICES_BLOCK_IDS.weather;
  const { block, skip } = fromView(id, view, canton, 'weather', nowMs);
  if (skip) return skip;
  const cities = (Array.isArray(block.cities) ? block.cities : [])
    // Stessa regola della vista dei servizi: basta una temperatura qualunque,
    // attuale o prevista per oggi.
    .filter((c) => isObj(c) && typeof c.name === 'string' && c.name
      && (finite(c.temperatureC) != null || finite(c.todayMaxC) != null || finite(c.todayMinC) != null))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!cities.length) return omitted(id, 'empty', `nessuna citta' con temperatura per ${canton}`);
  return {
    id,
    available: true,
    updatedAt: block.generatedAt,
    maxAgeMs: BLOCK_THRESHOLDS.services.maxAgeMs,
    render(locale) {
      const t = TXT[locale].weather;
      return {
        title: t.title,
        description: t.description,
        items: cities.map((c) => {
          const deg = (v) => fmtNumber(Math.round(v), locale);
          const range = finite(c.todayMinC) != null && finite(c.todayMaxC) != null;
          if (finite(c.temperatureC) != null) {
            return { label: c.name, value: `${deg(c.temperatureC)} °C`, ...(range ? { detail: t.detail(deg(c.todayMinC), deg(c.todayMaxC)) } : {}) };
          }
          // Solo previsione: il valore e' la previsione di oggi, dichiarata come tale.
          if (range) return { label: c.name, value: t.detail(deg(c.todayMinC), deg(c.todayMaxC)) };
          return finite(c.todayMaxC) != null
            ? { label: c.name, value: t.max(deg(c.todayMaxC)) }
            : { label: c.name, value: t.min(deg(c.todayMinC)) };
        }),
        sourceName: t.source,
        keyFacts: [],
      };
    },
  };
}
