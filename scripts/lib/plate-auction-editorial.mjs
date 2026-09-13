/**
 * Build the small editorial surface that accompanies the plate-auction data.
 *
 * The corpus is a publisher and consumes the auction snapshot over HTTP. This
 * module intentionally has no import from the site repository and accepts only
 * the public, bidder-free JSON contract.
 */

export const PLATE_AUCTION_EDITORIAL_SCHEMA = 1;
export const DEFAULT_PLATE_AUCTION_API_URL =
  'https://europe-west6-frontaliere-ticino.cloudfunctions.net/getPlateAuctions';

const LOCALES = ['it', 'en', 'de', 'fr'];
const FINAL_STATUSES = new Set(['closed', 'sold', 'unsold']);

const COPY = {
  it: {
    evergreenTitle: 'Come seguire le aste delle targhe svizzere',
    evergreenExcerpt: 'Una guida alle fonti cantonali, ai prezzi correnti e alla differenza tra inserzione, asta conclusa e risultato verificato.',
    evergreenParagraphs: [
      'Le targhe numeriche svizzere vengono pubblicate dai singoli uffici cantonali o dalle piattaforme incaricate. La disponibilità non è uniforme: per questo una panoramica affidabile deve indicare il cantone e collegare sempre la fonte ufficiale.',
      'Il prezzo corrente descrive un’osservazione del catalogo, non una vendita conclusa. Un risultato entra nello storico finale solo quando la fonte rende disponibile un prezzo finale verificabile.',
      'Prima di fare un’offerta, controlla categoria della targa, scadenza, condizioni della piattaforma e requisiti amministrativi direttamente sul sito cantonale.',
    ],
    evergreenBullets: ['Fonte ufficiale e data dell’ultimo aggiornamento', 'Categoria: asta, vendita diretta, targa desiderata o registrazione futura', 'Prezzo corrente distinto dal prezzo finale', 'Collegamento alla scheda ufficiale prima di qualsiasi pagamento'],
    weeklyTitle: 'Aggiornamento settimanale sulle targhe svizzere',
    weeklyUnavailable: 'L’aggiornamento automatico non è disponibile in questo momento. La guida resta valida; per i dati correnti va consultata la fonte cantonale.',
    weeklyInsufficient: 'Il feed pubblico non offre ancora abbastanza osservazioni per un aggiornamento settimanale affidabile.',
    observed: (current, cantons) => `Il feed ha osservato ${current} inserzioni pubbliche in ${cantons} cantoni.`,
    finals: (count) => count ? `Sono presenti ${count} risultati finali con prezzo verificato.` : 'Non risultano ancora risultati finali con prezzo verificato nel periodo osservato.',
    checkedAt: (date) => `Ultima lettura del feed: ${date}.`,
    highlight: 'Osservazioni recenti',
  },
  en: {
    evergreenTitle: 'How to follow Swiss plate auctions',
    evergreenExcerpt: 'A guide to cantonal sources, current prices and the difference between a listing, a completed auction and a verified result.',
    evergreenParagraphs: [
      'Swiss numeric plates are published by individual cantonal offices or their appointed platforms. Availability is not uniform, so a reliable overview names the canton and always links to the official source.',
      'A current price is an observation from a catalogue, not a completed sale. A result enters the final history only when the source exposes a verifiable final price.',
      'Before bidding, check the plate category, deadline, platform conditions and administrative requirements on the cantonal website itself.',
    ],
    evergreenBullets: ['Official source and last update', 'Category: auction, direct sale, wanted plate or future registration', 'Current price kept separate from final price', 'Official detail link before any payment'],
    weeklyTitle: 'Weekly Swiss plate-auction update',
    weeklyUnavailable: 'The automatic update is unavailable right now. The guide remains valid; check the cantonal source for current data.',
    weeklyInsufficient: 'The public feed does not yet contain enough observations for a reliable weekly update.',
    observed: (current, cantons) => `The feed observed ${current} public listings across ${cantons} cantons.`,
    finals: (count) => count ? `${count} final results with a verified price are available.` : 'No final results with a verified price are available in the observed period yet.',
    checkedAt: (date) => `Last feed check: ${date}.`,
    highlight: 'Recent observations',
  },
  de: {
    evergreenTitle: 'So verfolgen Sie Schweizer Kontrollschildauktionen',
    evergreenExcerpt: 'Ein Leitfaden zu kantonalen Quellen, aktuellen Preisen und dem Unterschied zwischen Angebot, abgeschlossenem Verkauf und verifiziertem Ergebnis.',
    evergreenParagraphs: [
      'Schweizer Kontrollschilder werden von den einzelnen kantonalen Ämtern oder beauftragten Plattformen veröffentlicht. Das Angebot ist nicht einheitlich; deshalb nennt eine verlässliche Übersicht den Kanton und verlinkt immer die offizielle Quelle.',
      'Ein aktueller Preis ist eine Beobachtung aus dem Katalog und kein abgeschlossener Verkauf. Ein Ergebnis wird erst dann in der Endhistorie geführt, wenn ein überprüfbarer Endpreis veröffentlicht ist.',
      'Vor einem Gebot sollten Kategorie, Frist, Plattformbedingungen und administrative Voraussetzungen direkt auf der kantonalen Website geprüft werden.',
    ],
    evergreenBullets: ['Offizielle Quelle und Zeitpunkt der letzten Aktualisierung', 'Kategorie: Auktion, Direktverkauf, Wunschkontrollschild oder zukünftige Registrierung', 'Aktueller Preis getrennt vom Endpreis', 'Offizieller Detail-Link vor jeder Zahlung'],
    weeklyTitle: 'Wöchentlicher Überblick zu Schweizer Kontrollschildauktionen',
    weeklyUnavailable: 'Die automatische Aktualisierung ist derzeit nicht verfügbar. Der Leitfaden bleibt gültig; aktuelle Daten stehen bei der kantonalen Quelle.',
    weeklyInsufficient: 'Der öffentliche Feed enthält noch nicht genügend Beobachtungen für einen verlässlichen Wochenüberblick.',
    observed: (current, cantons) => `Der Feed hat ${current} öffentliche Angebote in ${cantons} Kantonen beobachtet.`,
    finals: (count) => count ? `${count} Endergebnisse mit verifiziertem Preis sind verfügbar.` : 'Im beobachteten Zeitraum liegen noch keine Endergebnisse mit verifiziertem Preis vor.',
    checkedAt: (date) => `Letzte Feed-Prüfung: ${date}.`,
    highlight: 'Aktuelle Beobachtungen',
  },
  fr: {
    evergreenTitle: 'Suivre les enchères de plaques suisses',
    evergreenExcerpt: 'Un guide des sources cantonales, des prix actuels et de la différence entre une annonce, une vente terminée et un résultat vérifié.',
    evergreenParagraphs: [
      'Les plaques numériques suisses sont publiées par les offices cantonaux ou leurs plateformes mandatées. L’offre n’est pas uniforme: un aperçu fiable indique donc le canton et renvoie toujours vers la source officielle.',
      'Un prix actuel est une observation du catalogue, pas une vente conclue. Un résultat n’entre dans l’historique final que lorsque la source publie un prix final vérifiable.',
      'Avant d’enchérir, vérifiez la catégorie de la plaque, l’échéance, les conditions de la plateforme et les exigences administratives sur le site cantonal.',
    ],
    evergreenBullets: ['Source officielle et date de la dernière mise à jour', 'Catégorie: enchère, vente directe, plaque souhaitée ou inscription future', 'Prix actuel distinct du prix final', 'Lien vers la fiche officielle avant tout paiement'],
    weeklyTitle: 'Mise à jour hebdomadaire des enchères de plaques suisses',
    weeklyUnavailable: 'La mise à jour automatique est indisponible pour le moment. Le guide reste valable; consultez la source cantonale pour les données actuelles.',
    weeklyInsufficient: 'Le flux public ne contient pas encore assez d’observations pour une mise à jour hebdomadaire fiable.',
    observed: (current, cantons) => `Le flux a observé ${current} annonces publiques dans ${cantons} cantons.`,
    finals: (count) => count ? `${count} résultats finaux avec un prix vérifié sont disponibles.` : 'Aucun résultat final avec un prix vérifié n’est encore disponible pour la période observée.',
    checkedAt: (date) => `Dernière lecture du flux: ${date}.`,
    highlight: 'Observations récentes',
  },
};

function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function validDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function publicRows(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((row) => isRecord(row) && typeof row.id === 'string' && row.id && typeof row.normalizedPlate === 'string' && row.normalizedPlate)
    .map((row) => ({
      id: row.id,
      canton: typeof row.canton === 'string' ? row.canton : row.platePrefix,
      plate: row.normalizedPlate,
      listingType: typeof row.listingType === 'string' ? row.listingType : 'auction',
      status: typeof row.auctionStatus === 'string' ? row.auctionStatus : 'active',
      currentPriceChf: finiteNumber(row.currentBidChf) ?? finiteNumber(row.startingPriceChf),
      finalPriceChf: finiteNumber(row.finalPriceChf),
      bidCount: finiteNumber(row.bidCount),
      endsAt: validDate(row.endsAt),
      sourceFetchedAt: validDate(row.sourceFetchedAt),
      finalPriceVerifiedAt: validDate(row.finalPriceVerifiedAt),
      confidence: row.dataConfidence === 'verified'
        ? 'verified'
        : row.dataConfidence === 'conflicting'
          ? 'conflicting'
          : 'partial',
      officialUrl: typeof row.officialDetailUrl === 'string' && row.officialDetailUrl.startsWith('https://')
        ? row.officialDetailUrl
        : typeof row.officialAuctionUrl === 'string' && row.officialAuctionUrl.startsWith('https://')
          ? row.officialAuctionUrl
          : undefined,
    }));
}

function finalRows(rows) {
  const latest = new Map();
  for (const row of rows) {
    if (!FINAL_STATUSES.has(row.status) || row.confidence !== 'verified' || row.finalPriceChf === undefined || !row.finalPriceVerifiedAt) continue;
    const previous = latest.get(row.id);
    if (!previous || Date.parse(row.finalPriceVerifiedAt || row.sourceFetchedAt || '') >= Date.parse(previous.finalPriceVerifiedAt || previous.sourceFetchedAt || '')) {
      latest.set(row.id, row);
    }
  }
  return [...latest.values()];
}

function displayDate(value, locale) {
  if (!value) return '—';
  return new Intl.DateTimeFormat(locale === 'it' ? 'it-CH' : locale === 'de' ? 'de-CH' : locale === 'fr' ? 'fr-CH' : 'en-CH', { dateStyle: 'medium', timeZone: 'Europe/Zurich' }).format(new Date(value));
}

function formatChf(value, locale) {
  if (value === undefined) return '—';
  return new Intl.NumberFormat(locale === 'it' ? 'it-CH' : locale === 'de' ? 'de-CH' : locale === 'fr' ? 'fr-CH' : 'en-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 }).format(value);
}

function buildEvergreen(locale) {
  const copy = COPY[locale];
  return {
    slug: 'aste-targhe-svizzera-guida',
    title: copy.evergreenTitle,
    excerpt: copy.evergreenExcerpt,
    paragraphs: copy.evergreenParagraphs,
    bullets: copy.evergreenBullets,
    kind: 'evergreen',
  };
}

function buildWeekly(locale, status, currentRows, finalSourceRows, generatedAt) {
  const copy = COPY[locale];
  const current = currentRows.filter((row) => (row.status === 'active' || row.status === 'upcoming') && row.confidence !== 'conflicting');
  const finals = finalRows(finalSourceRows);
  const cantons = new Set(current.map((row) => row.canton).filter(Boolean)).size;
  const highlights = [...current]
    .sort((left, right) => (Date.parse(left.endsAt || '') || Number.MAX_SAFE_INTEGER) - (Date.parse(right.endsAt || '') || Number.MAX_SAFE_INTEGER))
    .slice(0, 8)
    .map((row) => ({
      plate: row.plate,
      canton: row.canton,
      listingType: row.listingType,
      status: row.status,
      currentPriceChf: row.currentPriceChf,
      bidCount: row.bidCount,
      endsAt: row.endsAt,
      officialUrl: row.officialUrl,
      confidence: row.confidence,
    }));
  if (status === 'unavailable') {
    return { status, title: copy.weeklyTitle, excerpt: copy.weeklyUnavailable, paragraphs: [copy.weeklyUnavailable], highlights: [] };
  }
  if (current.length === 0 && finals.length === 0) {
    return { status: 'insufficient-data', title: copy.weeklyTitle, excerpt: copy.weeklyInsufficient, paragraphs: [copy.weeklyInsufficient], highlights: [] };
  }
  const date = displayDate(generatedAt, locale);
  return {
    status: 'ready',
    title: copy.weeklyTitle,
    excerpt: copy.observed(current.length, cantons),
    paragraphs: [copy.observed(current.length, cantons), copy.finals(finals.length), copy.checkedAt(date)],
    highlights,
  };
}

export function buildPlateAuctionEditorial({ snapshot = null, upstreamStatus = 'unavailable', generatedAt = new Date().toISOString() } = {}) {
  const rows = publicRows(snapshot?.auctions);
  const historyRows = publicRows(snapshot?.history);
  const allRows = historyRows.length ? [...rows, ...historyRows] : rows;
  const status = upstreamStatus === 'ready' ? 'ready' : upstreamStatus === 'insufficient-data' ? 'insufficient-data' : 'unavailable';
  return {
    schema: PLATE_AUCTION_EDITORIAL_SCHEMA,
    generatedAt,
    status,
    source: {
      upstreamGeneratedAt: typeof snapshot?.generatedAt === 'string' ? snapshot.generatedAt : null,
      currentRows: rows.length,
      historyRows: historyRows.length,
      finalRows: finalRows(allRows).length,
      cantons: new Set(rows.map((row) => row.canton).filter(Boolean)).size,
    },
    evergreen: Object.fromEntries(LOCALES.map((locale) => [locale, buildEvergreen(locale)])),
    weekly: Object.fromEntries(LOCALES.map((locale) => [locale, buildWeekly(locale, status, rows, allRows, generatedAt)])),
  };
}

export async function fetchPlateAuctionEditorialInput({
  url = process.env.PLATE_AUCTION_API_URL || DEFAULT_PLATE_AUCTION_API_URL,
  fetcher = globalThis.fetch,
  timeoutMs = 10_000,
} = {}) {
  if (typeof fetcher !== 'function') return { status: 'unavailable', snapshot: null, errorCode: 'fetch-unavailable' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { redirect: 'follow', signal: controller.signal });
    if (!response.ok) return { status: 'unavailable', snapshot: null, errorCode: `http-${response.status}` };
    const snapshot = await response.json();
    if (!isRecord(snapshot) || snapshot.schema !== 1 || !Array.isArray(snapshot.auctions)) {
      return { status: 'unavailable', snapshot: null, errorCode: 'invalid-snapshot' };
    }
    const hasRows = snapshot.auctions.length > 0 || (Array.isArray(snapshot.history) && snapshot.history.length > 0);
    return { status: hasRows ? 'ready' : 'insufficient-data', snapshot, errorCode: null };
  } catch (error) {
    return { status: 'unavailable', snapshot: null, errorCode: error?.name === 'AbortError' ? 'timeout' : 'fetch-failed' };
  } finally {
    clearTimeout(timer);
  }
}
