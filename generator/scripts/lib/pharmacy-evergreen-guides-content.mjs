/**
 * Deterministic content builder for the evergreen pharmacy guides.
 *
 * The producer deliberately consumes small, checked-in metadata snapshots
 * rather than importing the site's pharmacy data.  The publisher/site
 * boundary is HTTP; these snapshots are the publisher's refreshable editorial
 * input and are validated before any article is built.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PHARMACY_LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);

export const PHARMACY_GUIDE_IDS = Object.freeze([
  'farmacie-turno-ticino-guida',
  'farmacie-ticino-elenco-contatti',
  'farmacie-confine-italia-como-varese-verbano',
  'farmacia-aperta-turno-elenco',
  'farmacie-turno-svizzera-confine-italiano',
]);

export const EXPECTED_DUTY_REGIONS = Object.freeze([
  'Mendrisiotto',
  'Luganese',
  'Bellinzonese',
  'Biasca e Valli',
  'Locarnese',
]);

export const EXPECTED_DUTY_SOURCE_REGIONS = Object.freeze([
  'https://www.ofct.ch/mendrisiotto/',
  'https://www.ofct.ch/luganese/',
  'https://www.ofct.ch/bellinzonese/',
  'https://www.ofct.ch/biasca-e-valli/',
  'https://www.farmacielocarnese.ch/',
]);

export const EXPECTED_LOCARNESE_SOURCE_NOTE =
  "Fonte associativa regionale attiva per gli intervalli di turno. Il parser dedicato legge la tabella HTML server-rendered e pubblica un intervallo solo quando Farmacia e Località risolvono un'unica identità nel catalogo cantonale; la fonte non pubblica un'anagrafica completa e non fornisce indirizzi da copiare.";

export const EXPECTED_ITALY_PROVINCES = Object.freeze(['CO', 'VA', 'VB']);

// These floors are the last verified complete row counts of the checked-in
// snapshots. A refresh that silently returns a shorter page is not editorial
// freshness; it is a truncated source and must stop before article generation.
export const EXPECTED_MIN_RECORD_COUNTS = Object.freeze({
  ticino: 207,
  'italy-border': 542,
  duty: 55,
});

// The current official snapshots carry no warnings. Keeping the allow-list
// explicit makes a future source warning a deliberate schema change instead
// of an accidental publication path.
export const ALLOWED_SNAPSHOT_WARNINGS = Object.freeze([]);
export const SNAPSHOT_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export const PHARMACY_ROUTES = Object.freeze({
  it: Object.freeze({
    hub: '/farmacie/',
    ticino: '/farmacie/ticino/',
    italy: '/farmacie/italia/',
    duty: '/farmacie-di-turno/',
  }),
  en: Object.freeze({
    hub: '/en/pharmacies/',
    ticino: '/en/pharmacies/ticino/',
    italy: '/en/pharmacies/italy/',
    duty: '/en/on-duty-pharmacies/',
  }),
  de: Object.freeze({
    hub: '/de/apotheken/',
    ticino: '/de/apotheken/ticino/',
    italy: '/de/apotheken/italien/',
    duty: '/de/notdienst-apotheken/',
  }),
  fr: Object.freeze({
    hub: '/fr/pharmacies/',
    ticino: '/fr/pharmacies/ticino/',
    italy: '/fr/pharmacies/italie/',
    duty: '/fr/pharmacies-de-garde/',
  }),
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const DEFAULT_CATALOG_PATH = path.join(REPO_ROOT, 'generator', 'data', 'pharmacy-catalog-snapshot.json');
const DEFAULT_DUTY_PATH = path.join(REPO_ROOT, 'generator', 'data', 'pharmacy-duty-snapshot.json');

const EXPECTED_TICINO_SOURCE =
  'https://www4.ti.ch/fileadmin/DSS/DSP/UFC/PDF/Elenchi_e_Indirizzi/Lista_Farmacie.pdf';
const EXPECTED_ITALY_SOURCE = 'https://www.dati.salute.gov.it/it/dataset/farmacie/';
const EXPECTED_OFCT_SOURCE = 'https://www.ofct.ch/farmacieturno/';

function snapshotError(message) {
  return new Error(`[pharmacy-snapshot] ${message}`);
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw snapshotError(`${label} mancante`);
  }
  return value;
}

function requireIsoTimestamp(value, label, nowMs = Date.now()) {
  requireString(value, label);
  if (!Number.isFinite(nowMs)) {
    throw snapshotError('clock di validazione non valido');
  }
  const timestampMs = Date.parse(value);
  if (Number.isNaN(timestampMs) || !value.endsWith('Z')) {
    throw snapshotError(`${label} non è un timestamp ISO UTC: ${value}`);
  }
  if (timestampMs > nowMs + SNAPSHOT_FUTURE_TOLERANCE_MS) {
    throw snapshotError(
      `${label} è nel futuro oltre la tolleranza di ${SNAPSHOT_FUTURE_TOLERANCE_MS / 1000}s: ${value}`,
    );
  }
  return value;
}

function requirePositiveCount(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw snapshotError(`${label} deve essere un intero positivo`);
  }
  return value;
}

function requireEmptyErrors(value, label) {
  if (!Array.isArray(value)) throw snapshotError(`${label} deve essere un array`);
  if (value.length > 0) {
    throw snapshotError(`${label} contiene errori: ${value.join(' | ')}`);
  }
}

function requireAllowedWarnings(value, label) {
  if (!Array.isArray(value)) throw snapshotError(`${label} deve essere un array`);
  const unexpected = value.filter((warning) => !ALLOWED_SNAPSHOT_WARNINGS.includes(warning));
  if (unexpected.length > 0) {
    throw snapshotError(`${label} contiene warning non ammessi: ${unexpected.join(' | ')}`);
  }
}

function requireCompleteScope(value, label, expectedKey, recordCount) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw snapshotError(`${label} mancante: serve la prova di completezza dello scope`);
  }
  if (value.status !== 'complete') {
    throw snapshotError(`${label}.status deve essere complete, ricevuto ${value.status}`);
  }
  if (value.truncated !== false) {
    throw snapshotError(`${label}.truncated deve essere false`);
  }
  if (value.verifiedRecordCount !== recordCount) {
    throw snapshotError(
      `${label}.verifiedRecordCount non combacia con recordCount (${recordCount}), ricevuto ${value.verifiedRecordCount}`,
    );
  }
  const expectedMinimum = EXPECTED_MIN_RECORD_COUNTS[expectedKey];
  if (!Number.isInteger(value.minimumRecordCount) || value.minimumRecordCount < expectedMinimum) {
    throw snapshotError(
      `${label}.minimumRecordCount deve essere almeno ${expectedMinimum}, ricevuto ${value.minimumRecordCount}`,
    );
  }
  if (recordCount < value.minimumRecordCount) {
    throw snapshotError(
      `${label}: recordCount ${recordCount} sotto la soglia dichiarata ${value.minimumRecordCount}`,
    );
  }
}

function sameItems(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((item, index) => item === expected[index]);
}

function sameSet(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && expected.every((item) => actual.includes(item));
}

function requireExactArray(actual, expected, label, { ordered = false } = {}) {
  const equal = ordered ? sameItems(actual, expected) : sameSet(actual, expected);
  if (!equal) {
    throw snapshotError(
      `${label} fuori perimetro: atteso ${JSON.stringify(expected)}, ricevuto ${JSON.stringify(actual)}`,
    );
  }
}

function readRequiredJson(file, label) {
  if (!file || !existsSync(file)) {
    throw snapshotError(`${label} assente: ${file || '(path vuoto)'}`);
  }
  let value;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw snapshotError(`${label} non è JSON valido: ${error.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw snapshotError(`${label} deve contenere un oggetto JSON`);
  }
  return value;
}

function validateCatalogueSnapshot(catalog, { nowMs = Date.now() } = {}) {
  if (catalog.version !== 1) throw snapshotError('catalogo snapshot: versione non supportata');
  requireEmptyErrors(catalog.errors, 'catalogo snapshot.errors');
  requireAllowedWarnings(catalog.warnings, 'catalogo snapshot.warnings');
  if (!Array.isArray(catalog.catalogues)) {
    throw snapshotError('catalogo snapshot.catalogues mancante');
  }
  if (catalog.catalogues.length !== 2) {
    throw snapshotError(`catalogo snapshot.catalogues deve contenere 2 scope, ricevuti ${catalog.catalogues.length}`);
  }

  const byId = new Map(catalog.catalogues.map((entry) => [entry?.id, entry]));
  if (byId.size !== 2 || !byId.has('ticino') || !byId.has('italy-border')) {
    throw snapshotError('catalogo snapshot: attesi esattamente gli scope ticino e italy-border');
  }

  const ticino = byId.get('ticino');
  if (ticino.country !== 'CH' || ticino.canton !== 'Ticino') {
    throw snapshotError('catalogo Ticino: scope atteso CH/Ticino non presente');
  }
  if (ticino.sourceUrl !== EXPECTED_TICINO_SOURCE) {
    throw snapshotError(`catalogo Ticino: fonte inattesa ${ticino.sourceUrl}`);
  }
  requireIsoTimestamp(ticino.fetchedAt, 'catalogo Ticino.fetchedAt', nowMs);
  requirePositiveCount(ticino.recordCount, 'catalogo Ticino.recordCount');
  requireCompleteScope(ticino.completeness, 'catalogo Ticino.completeness', 'ticino', ticino.recordCount);

  const italy = byId.get('italy-border');
  if (italy.country !== 'IT') {
    throw snapshotError('catalogo italiano: country IT atteso');
  }
  requireExactArray(italy.provinces, EXPECTED_ITALY_PROVINCES, 'catalogo italiano.provinces');
  if (italy.sourceUrl !== EXPECTED_ITALY_SOURCE) {
    throw snapshotError(`catalogo italiano: fonte inattesa ${italy.sourceUrl}`);
  }
  requireIsoTimestamp(italy.fetchedAt, 'catalogo italiano.fetchedAt', nowMs);
  requirePositiveCount(italy.recordCount, 'catalogo italiano.recordCount');
  requireCompleteScope(italy.completeness, 'catalogo italiano.completeness', 'italy-border', italy.recordCount);

  return { ticino, italy };
}

function validateDutySnapshot(duty, { nowMs = Date.now() } = {}) {
  if (duty.version !== 1) throw snapshotError('turni snapshot: versione non supportata');
  requireEmptyErrors(duty.errors, 'turni snapshot.errors');
  requireAllowedWarnings(duty.warnings, 'turni snapshot.warnings');
  if (duty.sourceUrl !== EXPECTED_OFCT_SOURCE) {
    throw snapshotError(`turni snapshot: fonte inattesa ${duty.sourceUrl}`);
  }
  if (duty.sourceType !== 'official') {
    throw snapshotError(`turni snapshot: sourceType deve essere official, ricevuto ${duty.sourceType}`);
  }
  requireExactArray(duty.sourceRegions, EXPECTED_DUTY_SOURCE_REGIONS, 'turni snapshot.sourceRegions', { ordered: true });
  requireIsoTimestamp(duty.fetchedAt, 'turni snapshot.fetchedAt', nowMs);
  requirePositiveCount(duty.recordCount, 'turni snapshot.recordCount');
  requireCompleteScope(duty.completeness, 'turni snapshot.completeness', 'duty', duty.recordCount);
  if (duty.verifiedDuty !== true) {
    throw snapshotError('turni snapshot: verifiedDuty deve essere true');
  }
  requireExactArray(duty.statusValues, ['verified', 'expired'], 'turni snapshot.statusValues', { ordered: true });

  const scope = duty.scope;
  if (!scope || scope.country !== 'CH' || scope.canton !== 'Ticino') {
    throw snapshotError('turni snapshot: scope atteso CH/Ticino non presente');
  }
  requireExactArray(scope.includedRegions, EXPECTED_DUTY_REGIONS, 'turni snapshot.scope.includedRegions', { ordered: true });
  requireExactArray(scope.excludedRegions, [], 'turni snapshot.scope.excludedRegions', { ordered: true });
  if (duty.sourceNotes?.Locarnese !== EXPECTED_LOCARNESE_SOURCE_NOTE) {
    throw snapshotError('turni snapshot.sourceNotes.Locarnese non descrive il matching univoco col catalogo');
  }

  return duty;
}

/**
 * Validate an already loaded pair of snapshots.  This function is deliberately
 * strict: a source error, a missing catalogue, or a broadened duty scope must
 * stop publication before the registrar is reached.
 */
export function validatePharmacySnapshots(snapshots, { nowMs = Date.now() } = {}) {
  if (!snapshots || typeof snapshots !== 'object') {
    throw snapshotError('bundle snapshot mancante');
  }
  if (!snapshots.catalog || !snapshots.duty) {
    throw snapshotError('bundle snapshot incompleto: servono catalog e duty');
  }
  const catalog = validateCatalogueSnapshot(snapshots.catalog, { nowMs });
  const duty = validateDutySnapshot(snapshots.duty, { nowMs });
  return { catalog, duty };
}

/** Load and validate the publisher-local snapshot pair. */
export function loadPharmacySnapshots({ catalogPath = DEFAULT_CATALOG_PATH, dutyPath = DEFAULT_DUTY_PATH } = {}) {
  const catalog = readRequiredJson(catalogPath, 'catalogo farmacia snapshot');
  const duty = readRequiredJson(dutyPath, 'turni farmacia snapshot');
  const snapshots = { catalog, duty };
  // Validate at the I/O boundary, but return the raw pair so callers can pass
  // it through the same public builder path without changing its shape.
  validatePharmacySnapshots(snapshots);
  return snapshots;
}

function latestSnapshotTimestamp(snapshots) {
  return [
    snapshots.catalog.ticino.fetchedAt,
    snapshots.catalog.italy.fetchedAt,
    snapshots.duty.fetchedAt,
  ].sort().at(-1);
}

const COPY = {
  it: {
    inBrief: 'In breve',
    facts: 'Fatti chiave',
    scope: 'Perimetro, fonti e timestamp',
    distinction: 'Catalogo, orari e turno: tre dati diversi',
    sources: 'Fonti ufficiali e percorsi utili',
    snapshotIntro: 'Questa guida usa snapshot separati: un catalogo anagrafico ticinese, un catalogo italiano filtrato e un dataset di turni regionali (OFCT e fonte associativa del Locarnese). Le fonti non vengono fuse in un unico stato di apertura.',
    catalogue: 'catalogo',
    openingHours: 'orari di apertura',
    duty: 'turno verificato',
    ticinoDirectory: 'Elenco ufficiale delle farmacie del Ticino',
    italyDirectory: 'Dataset ufficiale italiano filtrato sulle province CO, VA e VB',
    dutySource: 'Fonti regionali per i turni del Ticino',
    lastFetch: 'Ultimo recupero degli snapshot',
    timestampMeaning: 'Il timestamp indica quando è stato recuperato lo snapshot della fonte; non indica l’orario di apertura e non dimostra che una sede sia aperta in questo momento.',
    notNationwide: 'Questa non è una copertura nazionale: il perimetro è limitato al Ticino e alle province italiane CO, VA e VB.',
    locarnese: 'Il Locarnese è incluso come quinta regione di turno tramite la fonte associativa regionale farmacielocarnese.ch. Il suo intervallo viene pubblicato solo dopo un matching univoco con il catalogo cantonale; la fonte non sostituisce l’anagrafica.',
    locarneseSource: 'Per il Locarnese: fonte associativa regionale [farmacielocarnese.ch](https://www.farmacielocarnese.ch/); il parser pubblica l’intervallo solo dopo il matching univoco di Farmacia e Località con il catalogo cantonale e non copia indirizzi dalla fonte.',
    noItalianDuty: 'Per l’Italia non viene fatto alcun claim di turno: il catalogo italiano è anagrafico e non prova una farmacia aperta o di turno.',
    catalogueMeaning: 'La presenza nell’elenco indica una voce del catalogo ufficiale, non che la farmacia sia aperta ora.',
    hoursMeaning: 'Gli orari compaiono solo quando la pagina o la fonte li pubblica; non vengono dedotti dal catalogo né dal timestamp.',
    dutyMeaning: 'Un turno verificato è un intervallo regionale pubblicato dall’OFCT o dalla fonte associativa pertinente; non equivale a un’apertura continua. Prima di partire, verifica sempre per telefono.',
    routes: 'Apri le pagine operative del sito:',
    routeHub: 'hub farmacie',
    routeTicino: 'elenco Ticino',
    routeItaly: 'elenco province italiane',
    routeDuty: 'farmacie di turno',
    officialList: 'lista ufficiale',
    officialDataset: 'dataset del Ministero della Salute',
    ofctHub: 'fonte OFCT',
    regionLinks: 'fonti regionali per area',
    verify: 'Per un caso concreto, apri il percorso locale, controlla la scheda disponibile e contatta la farmacia: un elenco statico non sostituisce la verifica diretta.',
  },
  en: {
    inBrief: 'In brief',
    facts: 'Key facts',
    scope: 'Scope, sources and timestamp',
    distinction: 'Directory, opening hours and duty: three different data points',
    sources: 'Official sources and useful routes',
    snapshotIntro: 'This guide uses separate snapshots: a Ticino address directory, a filtered Italian directory and a regional duty dataset (OFCT and the Locarnese association source). The sources are not merged into one opening status.',
    catalogue: 'directory',
    openingHours: 'opening hours',
    duty: 'verified duty',
    ticinoDirectory: 'Official Ticino pharmacy list',
    italyDirectory: 'Official Italian dataset filtered to provinces CO, VA and VB',
    dutySource: 'Regional sources for Ticino duty coverage',
    lastFetch: 'Latest snapshot retrieval',
    timestampMeaning: 'The timestamp records when the source snapshot was retrieved; it is not an opening time and does not prove that a pharmacy is open now.',
    notNationwide: 'This is not nationwide coverage: the perimeter is limited to Ticino and the Italian provinces CO, VA and VB.',
    locarnese: 'Locarnese is included as the fifth duty region through the regional association source farmacielocarnese.ch. Its interval is published only after a unique match with the cantonal directory; the source does not replace the directory.',
    locarneseSource: 'For Locarnese: regional association source [farmacielocarnese.ch](https://www.farmacielocarnese.ch/); the parser publishes an interval only after a unique Farmacia-and-locality match with the cantonal directory and copies no address from the source.',
    noItalianDuty: 'No Italian on-duty claim is made: the Italian catalogue is an address directory and does not prove that a pharmacy is open or on duty.',
    catalogueMeaning: 'A directory record means that the official catalogue contains the entry; it does not mean that the pharmacy is open now.',
    hoursMeaning: 'Opening hours are shown only when the page or source publishes them; they are not inferred from the directory or its timestamp.',
    dutyMeaning: 'Verified duty means a regional interval published by OFCT or the relevant association source; it is not the same as continuous opening. Check by phone before travelling.',
    routes: 'Open the site’s operational pages:',
    routeHub: 'pharmacy hub',
    routeTicino: 'Ticino directory',
    routeItaly: 'Italian provinces directory',
    routeDuty: 'on-duty pharmacies',
    officialList: 'official list',
    officialDataset: 'Ministry of Health dataset',
    ofctHub: 'OFCT source',
    regionLinks: 'regional sources by area',
    verify: 'For a specific case, open the local route, read the available record and contact the pharmacy: a static directory does not replace direct confirmation.',
  },
  de: {
    inBrief: 'Kurz erklärt',
    facts: 'Wichtige Fakten',
    scope: 'Geltungsbereich, Quellen und Zeitstempel',
    distinction: 'Verzeichnis, Öffnungszeiten und Notdienst: drei verschiedene Angaben',
    sources: 'Offizielle Quellen und nützliche Wege',
    snapshotIntro: 'Dieser Leitfaden nutzt getrennte Snapshots: ein Tessiner Adressverzeichnis, ein gefiltertes italienisches Verzeichnis und einen regionalen Notdienst-Datensatz (OFCT und die Verbandsquelle des Locarnese). Die Quellen werden nicht zu einem einzigen Öffnungsstatus zusammengeführt.',
    catalogue: 'Verzeichnis',
    openingHours: 'Öffnungszeiten',
    duty: 'bestätigter Notdienst',
    ticinoDirectory: 'Offizielle Apothekenliste des Tessins',
    italyDirectory: 'Offizieller italienischer Datensatz, gefiltert auf CO, VA und VB',
    dutySource: 'Regionale Quellen für Tessiner Notdienste',
    lastFetch: 'Letzter Abruf der Snapshots',
    timestampMeaning: 'Der Zeitstempel bezeichnet den Abruf des Quellen-Snapshots; er ist keine Öffnungszeit und beweist nicht, dass eine Apotheke jetzt geöffnet ist.',
    notNationwide: 'Dies ist keine landesweite Abdeckung: Der Umfang beschränkt sich auf das Tessin und die italienischen Provinzen CO, VA und VB.',
    locarnese: 'Das Locarnese ist als fünfte Notdienstregion über die regionale Verbandsquelle farmacielocarnese.ch enthalten. Das Intervall wird erst nach einem eindeutigen Abgleich mit dem kantonalen Verzeichnis veröffentlicht; die Quelle ersetzt das Verzeichnis nicht.',
    locarneseSource: 'Für Locarnese: regionale Verbandsquelle [farmacielocarnese.ch](https://www.farmacielocarnese.ch/); der Parser veröffentlicht ein Intervall erst nach einem eindeutigen Abgleich von Farmacia und Ort mit dem kantonalen Verzeichnis und übernimmt keine Adresse aus der Quelle.',
    noItalianDuty: 'Für Italien wird kein Notdienst-Anspruch gemacht: Das italienische Verzeichnis ist eine Adressliste und beweist weder Öffnung noch Notdienst.',
    catalogueMeaning: 'Ein Eintrag bedeutet, dass die offizielle Liste die Apotheke führt; daraus folgt nicht, dass sie jetzt geöffnet ist.',
    hoursMeaning: 'Öffnungszeiten werden nur angezeigt, wenn die Seite oder Quelle sie veröffentlicht; sie werden nicht aus Verzeichnis oder Zeitstempel abgeleitet.',
    dutyMeaning: 'Ein bestätigter Notdienst ist ein von der OFCT oder der zuständigen Verbandsquelle veröffentlichtes regionales Zeitintervall; er bedeutet keine durchgehende Öffnung. Vor der Fahrt telefonisch prüfen.',
    routes: 'Nützliche Seiten auf der Website:',
    routeHub: 'Apotheken-Hub',
    routeTicino: 'Verzeichnis Tessin',
    routeItaly: 'Verzeichnis italienische Provinzen',
    routeDuty: 'Notdienst-Apotheken',
    officialList: 'offizielle Liste',
    officialDataset: 'Datensatz des Gesundheitsministeriums',
    ofctHub: 'OFCT-Quelle',
    regionLinks: 'regionale Quellen nach Gebiet',
    verify: 'Für einen konkreten Fall den lokalen Weg öffnen, den verfügbaren Eintrag lesen und die Apotheke kontaktieren: Ein statisches Verzeichnis ersetzt keine direkte Bestätigung.',
  },
  fr: {
    inBrief: 'En bref',
    facts: 'Faits clés',
    scope: 'Périmètre, sources et horodatage',
    distinction: 'Répertoire, horaires et garde : trois données différentes',
    sources: 'Sources officielles et parcours utiles',
    snapshotIntro: 'Ce guide utilise des instantanés séparés : un répertoire d’adresses tessinois, un répertoire italien filtré et un jeu de données de gardes régionales (OFCT et source de l’association du Locarnese). Les sources ne sont pas fusionnées en un seul statut d’ouverture.',
    catalogue: 'répertoire',
    openingHours: 'horaires d’ouverture',
    duty: 'garde vérifiée',
    ticinoDirectory: 'Liste officielle des pharmacies du Tessin',
    italyDirectory: 'Jeu de données italien officiel filtré sur les provinces CO, VA et VB',
    dutySource: 'Sources régionales pour les gardes tessinoises',
    lastFetch: 'Dernier téléchargement des instantanés',
    timestampMeaning: 'L’horodatage indique quand l’instantané de la source a été téléchargé ; ce n’est pas un horaire d’ouverture et il ne prouve pas qu’une pharmacie est ouverte maintenant.',
    notNationwide: 'Il ne s’agit pas d’une couverture nationale : le périmètre se limite au Tessin et aux provinces italiennes CO, VA et VB.',
    locarnese: 'Le Locarnese est inclus comme cinquième région de garde via la source de l’association régionale farmacielocarnese.ch. Son intervalle n’est publié qu’après une correspondance unique avec le répertoire cantonal ; la source ne remplace pas le répertoire.',
    locarneseSource: 'Pour le Locarnese : source de l’association régionale [farmacielocarnese.ch](https://www.farmacielocarnese.ch/) ; le parseur ne publie l’intervalle qu’après une correspondance unique de Farmacia et de la localité avec le répertoire cantonal et ne copie aucune adresse depuis la source.',
    noItalianDuty: 'Aucune couverture de garde italienne n’est revendiquée : le répertoire italien est une liste d’adresses et ne prouve ni l’ouverture ni la garde d’une pharmacie.',
    catalogueMeaning: 'La présence dans le répertoire signifie que la liste officielle contient l’entrée ; elle ne signifie pas que la pharmacie est ouverte maintenant.',
    hoursMeaning: 'Les horaires ne sont affichés que lorsque la page ou la source les publie ; ils ne sont pas déduits du répertoire ou de son horodatage.',
    dutyMeaning: 'Une garde vérifiée est un intervalle régional publié par l’OFCT ou la source associative pertinente ; ce n’est pas une ouverture continue. Vérifier par téléphone avant de se déplacer.',
    routes: 'Pages opérationnelles du site :',
    routeHub: 'hub pharmacies',
    routeTicino: 'répertoire du Tessin',
    routeItaly: 'répertoire des provinces italiennes',
    routeDuty: 'pharmacies de garde',
    officialList: 'liste officielle',
    officialDataset: 'jeu de données du ministère de la Santé',
    ofctHub: 'source OFCT',
    regionLinks: 'sources régionales par zone',
    verify: 'Pour un cas précis, ouvrir le parcours local, lire la fiche disponible et contacter la pharmacie : un répertoire statique ne remplace pas une confirmation directe.',
  },
};

const SWISS_CANTON_SOURCES = Object.freeze([
  ['ZH', 'Zürich', 'https://www.notfall-apotheken-zh.ch/'],
  ['BE', 'Bern', 'https://apobern.ch/dienstleistungen/notfalldienst/'],
  ['LU', 'Luzern', 'https://www.apoluzern.ch/apotheken/notfalldienst'],
  ['UR', 'Uri', 'https://www.ur.ch/dienstleistungen/3677'],
  ['SZ', 'Schwyz', 'https://www.sz.ch/gesundheit-soziales/gesundheit/notfall.html/'],
  ['ZG', 'Zug', 'https://www.zg.ch/behoerden/gesundheit/medizinische-versorgung/notfall'],
  ['SO', 'Solothurn', 'https://avso.ch/notfalldienst-apotheken/'],
  ['BS', 'Basel-Stadt', 'https://www.bs.ch/gd/md/hoheitliche-funktionen/kantonsapothekerin/liste-der-apotheken-basel-stadt'],
  ['AG', 'Aargau', 'https://apotheken-aargau.ch/notfall/'],
  ['TG', 'Thurgau', 'https://www.apotheken-thurgau.ch/pikettdienst/'],
  ['GR', 'Graubünden', 'https://notfall.apotheke-chur.ch/'],
  ['VS', 'Valais', 'https://www.pharmavalais.ch/pharmacie-valais/pharmacie-garde-51.html'],
  ['FR', 'Fribourg', 'https://www.pharmaciesfribourg.ch/fr/prestations-et-conseils/pharmacie-de-garde'],
  ['NE', 'Neuchâtel', 'https://www.onp.ch/Service-de-garde'],
  ['JU', 'Jura', 'https://www.jura.ch/fr/Autorites/Administration/CHA/SIC/Urgences/Numeros-d-urgence-Urgence.html'],
  ['VD', 'Vaud', 'https://garde.svph.ch'],
  ['GE', 'Genève', 'https://pharmageneve.swiss/pharmacie-de-garde/'],
]);

const ITALIAN_BORDER_SOURCES = Object.freeze([
  { label: 'ATS Insubria', url: 'https://www.ats-insubria.it/farmacie' },
  { label: 'Varese (portale turni Federfarma Lombardia)', url: 'https://www.turnifarmacie.it/' },
  {
    label: 'Verbano-Cusio-Ossola (documento turni)',
    url: 'https://www.aslvco.it/wp-content/uploads/2026/03/3017434.pdf',
    validity: '2026',
  },
]);

function swissCantonSourceAppendix(locale) {
  const text = {
    it: {
      heading: 'Svizzera: come verificare la fonte aggiornata per cantone',
      intro: 'Questi sono link ufficiali navigabili o di associazioni cantonali. Aprili al momento della necessità: possono offrire ricerca, piano del giorno, contatto o un avviso, ma questa guida non li trasforma in un calendario unico né promette un orario o una farmacia aperta.',
      ticino: 'Per il Ticino pubblichiamo dati di turno verificati per le cinque regioni Mendrisiotto, Luganese, Bellinzonese, Biasca e Valli e Locarnese; per ogni altra area non deduciamo copertura.',
      partialSource: 'Per SZ (Svitto) è disponibile il link navigabile qui sopra, ma in questa guida non lo trattiamo come roster pubblico o feed di turno: non dichiariamo copertura attiva né orari.',
      noFeed: 'OW (Obvaldo), NW (Nidvaldo), GL (Glarona), AR (Appenzello Esterno), AI (Appenzello Interno), BL (Basilea Campagna), SH (Sciaffusa) e SG (San Gallo): in questa guida non è rappresentato un roster pubblico o un feed verificato. Non dichiariamo copertura attiva; contatta la farmacia o l’autorità sanitaria locale. In un’emergenza medica chiama il 144.',
      border: 'Confine italiano (CO, VA, VB): consulta direttamente le fonti locali. I documenti possono cambiare o scadere; non inferiamo un turno o un orario dalla loro presenza.',
      aggregator: 'Farmacia Aperta è un link-out esterno di orientamento, non una fonte ufficiale né una prova di apertura o turno.',
      annualDocument: (edition) => `documento annuale, edizione ${edition}: verifica la versione corrente prima dell’uso`,
    },
    en: {
      heading: 'Switzerland: how to check the current source by canton',
      intro: 'These are navigable official or cantonal pharmacists’ association links. Open them when needed: they may offer a search, daily plan, contact or notice, but this guide does not turn them into one calendar and does not promise an opening time or an open pharmacy.',
      ticino: 'For Ticino, we publish verified duty data for the five regions Mendrisiotto, Luganese, Bellinzonese, Biasca e Valli and Locarnese; we infer no coverage for any other area.',
      partialSource: 'For SZ (Schwyz), the navigable link above is available, but this guide does not treat it as a public roster or duty feed: we make no active-coverage or hours claim.',
      noFeed: 'OW (Obwalden), NW (Nidwalden), GL (Glarus), AR (Appenzell Ausserrhoden), AI (Appenzell Innerrhoden), BL (Basel-Landschaft), SH (Schaffhausen) and SG (St. Gallen): this guide represents no public roster or verified feed. We make no active-coverage claim; contact the local pharmacy or cantonal health authority. For a medical emergency, call 144.',
      border: 'Italian border (CO, VA, VB): consult the local sources directly. Documents may change or expire; we infer no duty or opening time from their presence.',
      aggregator: 'Farmacia Aperta is an external orientation link, not an official source or evidence of opening or duty.',
      annualDocument: (edition) => `annual document, edition ${edition}: check the current version before use`,
    },
    de: {
      heading: 'Schweiz: aktuelle Quelle je Kanton prüfen',
      intro: 'Dies sind aufrufbare offizielle Links oder Links kantonaler Apothekerverbände. Bei Bedarf direkt öffnen: Sie können Suche, Tagesplan, Kontakt oder Hinweis bieten; dieser Leitfaden macht daraus keinen einheitlichen Kalender und verspricht keine Öffnungszeit oder geöffnete Apotheke.',
      ticino: 'Für das Tessin veröffentlichen wir bestätigte Notdienst-Daten für die fünf Regionen Mendrisiotto, Luganese, Bellinzonese, Biasca e Valli und Locarnese; für jedes andere Gebiet wird keine Abdeckung abgeleitet.',
      partialSource: 'Für SZ (Schwyz) ist der aufrufbare Link oben vorhanden, aber dieser Leitfaden behandelt ihn nicht als öffentliches Verzeichnis oder Notdienst-Feed: Es wird weder aktive Abdeckung noch Öffnungszeit behauptet.',
      noFeed: 'OW (Obwalden), NW (Nidwalden), GL (Glarus), AR (Appenzell Ausserrhoden), AI (Appenzell Innerrhoden), BL (Basel-Landschaft), SH (Schaffhausen) und SG (St. Gallen): Dieser Leitfaden bildet kein öffentliches Verzeichnis und keinen bestätigten Feed ab. Es wird keine aktive Abdeckung behauptet; lokale Apotheke oder kantonale Gesundheitsbehörde kontaktieren. Bei einem medizinischen Notfall 144 anrufen.',
      border: 'Italienische Grenze (CO, VA, VB): lokale Quellen direkt prüfen. Dokumente können sich ändern oder ablaufen; aus ihrem Vorhandensein wird kein Notdienst und keine Öffnungszeit abgeleitet.',
      aggregator: 'Farmacia Aperta ist ein externer Orientierungslink, keine offizielle Quelle und kein Nachweis für Öffnung oder Notdienst.',
      annualDocument: (edition) => `Jahresdokument, Ausgabe ${edition}: vor der Nutzung die aktuelle Version prüfen`,
    },
    fr: {
      heading: 'Suisse : vérifier la source à jour par canton',
      intro: 'Voici des liens officiels navigables ou de sociétés cantonales de pharmaciens. Ouvrez-les au moment du besoin : ils peuvent proposer une recherche, un plan du jour, un contact ou un avis, mais ce guide ne les transforme pas en calendrier unique et ne promet ni horaire ni pharmacie ouverte.',
      ticino: 'Pour le Tessin, nous publions des données de garde vérifiées pour les cinq régions du Mendrisiotto, du Luganese, du Bellinzonese, de Biasca e Valli et du Locarnese ; aucune couverture n’est déduite pour une autre zone.',
      partialSource: 'Pour SZ (Schwyz), le lien navigable ci-dessus est disponible, mais ce guide ne le traite pas comme un roster public ou un flux de garde : aucune couverture active ni horaire n’est revendiqué.',
      noFeed: 'OW (Obwald), NW (Nidwald), GL (Glaris), AR (Appenzell Rhodes-Extérieures), AI (Appenzell Rhodes-Intérieures), BL (Bâle-Campagne), SH (Schaffhouse) et SG (Saint-Gall) : ce guide ne représente aucun roster public ni flux vérifié. Aucune couverture active n’est revendiquée ; contacter la pharmacie ou l’autorité sanitaire cantonale locale. En cas d’urgence médicale, appeler le 144.',
      border: 'Frontière italienne (CO, VA, VB) : consulter directement les sources locales. Les documents peuvent changer ou expirer ; aucune garde ni horaire n’est déduit de leur présence.',
      aggregator: 'Farmacia Aperta est un lien externe d’orientation, pas une source officielle ni une preuve d’ouverture ou de garde.',
      annualDocument: (edition) => `document annuel, édition ${edition} : vérifier la version courante avant utilisation`,
    },
  }[locale];
  const cantonLinks = SWISS_CANTON_SOURCES
    .map(([code, name, url]) => `- [${code} — ${name}](${url})`)
    .join('\n');
  const borderLinks = ITALIAN_BORDER_SOURCES
    .map(({ label, url, validity }) => `- [${label}](${url})${validity ? ` — ${text.annualDocument(validity)}` : ''}`)
    .join('\n');

  return `## ${text.heading}
${text.intro}

${cantonLinks}

${text.ticino}

${text.partialSource}

${text.noFeed}

## ${text.border}
${borderLinks}
- [Farmacia Aperta](https://farmacia-aperta.eu/)

${text.aggregator}`;
}

const GUIDE_SPECS = Object.freeze([
  {
    id: 'farmacie-turno-ticino-guida',
    image: 'bellinzona.webp',
    slugs: {
      it: 'farmacie-turno-ticino-guida',
      en: 'ticino-on-duty-pharmacies-guide',
      de: 'notdienst-apotheken-tessin-leitfaden',
      fr: 'guide-pharmacies-garde-tessin',
    },
    seo: {
      title: 'Farmacie di turno in Ticino: guida a fonti e copertura',
      keywords: 'farmacie di turno Ticino, OFCT, farmacia aperta, turni regionali, Mendrisiotto, Luganese, Bellinzonese, Locarnese',
      headline: 'Farmacie di turno in Ticino: come leggere fonti e copertura',
      breadcrumbName: 'Farmacie di turno in Ticino',
    },
    imageAlt: {
      it: 'Vista di Bellinzona in Ticino',
      en: 'View of Bellinzona in Ticino',
      de: 'Blick auf Bellinzona im Tessin',
      fr: 'Vue de Bellinzone au Tessin',
    },
    copy: {
      it: {
        title: 'Farmacie di turno in Ticino: guida a fonti e copertura',
        focus: 'Questa guida spiega dove leggere i turni di farmacia del Ticino e come interpretare correttamente una copertura regionale.',
        detailHeading: 'Che cosa significa “di turno” qui',
        detail: 'Il dato di turno combina le pagine ufficiali dell’Ordine dei farmacisti del Cantone Ticino (OFCT) e la fonte associativa regionale del Locarnese. Lo snapshot pubblicato per questa guida copre le cinque regioni ticinesi: Mendrisiotto, Luganese, Bellinzonese, Biasca e Valli e Locarnese.',
        advice: 'Se cerchi una farmacia aperta adesso, usa la pagina di turno della tua area e verifica l’intervallo indicato. Il catalogo anagrafico e gli orari ordinari sono superfici diverse dal turno verificato.',
        faq: [
          { q: 'Quali regioni ticinesi sono coperte dai turni?', a: 'Lo snapshot dei turni copre cinque regioni: Mendrisiotto, Luganese, Bellinzonese, Biasca e Valli e Locarnese. Per il Locarnese l’intervallo arriva dalla fonte associativa regionale e viene pubblicato solo dopo il matching con il catalogo cantonale.' },
          { q: 'Il turno significa che la farmacia è aperta senza interruzioni?', a: 'No. Il turno è un intervallo regionale pubblicato dalla fonte pertinente; bisogna controllare la pagina e verificare per telefono.' },
          { q: 'Il sito mostra turni delle farmacie italiane?', a: 'No. Il catalogo italiano è anagrafico e questa guida non fa alcun claim di turno italiano.' },
        ],
      },
      en: {
        title: 'Ticino on-duty pharmacies: a guide to sources and coverage',
        focus: 'This guide explains where to read Ticino pharmacy duty information and how to interpret regional coverage correctly.',
        detailHeading: 'What “on duty” means here',
        detail: 'The duty data combines the official pages of the Ticino pharmacists’ association (OFCT) and the regional association source for Locarnese. The snapshot used for this guide covers the five Ticino regions: Mendrisiotto, Luganese, Bellinzonese, Biasca e Valli and Locarnese.',
        advice: 'If you need a pharmacy open now, use the duty page for your area and check the stated interval. The address directory and ordinary opening hours are different surfaces from verified duty.',
        faq: [
          { q: 'Which Ticino regions are covered by the duty data?', a: 'The duty snapshot covers five regions: Mendrisiotto, Luganese, Bellinzonese, Biasca e Valli and Locarnese. Locarnese comes from the regional association source and is published only after matching the cantonal directory.' },
          { q: 'Does duty mean that a pharmacy is open continuously?', a: 'No. Duty is a regional interval published by the relevant source; check the page and confirm by phone.' },
          { q: 'Does the site show Italian pharmacy duty services?', a: 'No. The Italian catalogue is an address directory and this guide makes no Italian on-duty claim.' },
        ],
      },
      de: {
        title: 'Notdienst-Apotheken im Tessin: Quellen und Abdeckung',
        focus: 'Dieser Leitfaden erklärt, wo der Tessiner Apotheken-Notdienst veröffentlicht wird und wie die regionale Abdeckung zu lesen ist.',
        detailHeading: 'Was „Notdienst“ hier bedeutet',
        detail: 'Die Notdienst-Daten verbinden die offiziellen Seiten des Tessiner Apothekerverbands (OFCT) mit der regionalen Verbandsquelle des Locarnese. Der für diesen Leitfaden verwendete Snapshot umfasst die fünf Tessiner Regionen Mendrisiotto, Luganese, Bellinzonese, Biasca e Valli und Locarnese.',
        advice: 'Wenn eine jetzt geöffnete Apotheke gesucht wird, die Notdienstseite des Gebiets öffnen und das angegebene Intervall prüfen. Adressverzeichnis und normale Öffnungszeiten sind andere Daten als der bestätigte Notdienst.',
        faq: [
          { q: 'Welche Tessiner Regionen deckt der Notdienst-Snapshot ab?', a: 'Der Snapshot deckt fünf Regionen ab: Mendrisiotto, Luganese, Bellinzonese, Biasca e Valli und Locarnese. Für das Locarnese stammt das Intervall aus der regionalen Verbandsquelle und wird erst nach dem Abgleich mit dem kantonalen Verzeichnis veröffentlicht.' },
          { q: 'Bedeutet Notdienst eine durchgehende Öffnung?', a: 'Nein. Der Notdienst ist ein von der zuständigen Quelle veröffentlichtes regionales Zeitintervall; Seite prüfen und telefonisch bestätigen.' },
          { q: 'Zeigt die Website italienische Notdienste?', a: 'Nein. Das italienische Verzeichnis ist eine Adressliste; dieser Leitfaden macht keinen Anspruch auf italienischen Notdienst.' },
        ],
      },
      fr: {
        title: 'Pharmacies de garde au Tessin : sources et couverture',
        focus: 'Ce guide indique où consulter les gardes des pharmacies au Tessin et comment comprendre leur couverture régionale.',
        detailHeading: 'Ce que signifie « de garde » ici',
        detail: 'Les données de garde combinent les pages officielles de l’association des pharmaciens du Tessin (OFCT) et la source de l’association régionale du Locarnese. L’instantané utilisé ici couvre les cinq régions tessinoises : le Mendrisiotto, le Luganese, le Bellinzonese, Biasca e Valli et le Locarnese.',
        advice: 'Pour trouver une pharmacie ouverte maintenant, ouvrir la page de garde de la zone et vérifier l’intervalle indiqué. Le répertoire d’adresses et les horaires ordinaires sont des données différentes de la garde vérifiée.',
        faq: [
          { q: 'Quelles régions tessinoises sont couvertes par les gardes ?', a: 'L’instantané couvre cinq régions : le Mendrisiotto, le Luganese, le Bellinzonese, Biasca e Valli et le Locarnese. Pour le Locarnese, l’intervalle provient de la source de l’association régionale et n’est publié qu’après le rapprochement avec le répertoire cantonal.' },
          { q: 'Une garde signifie-t-elle une ouverture continue ?', a: 'Non. La garde est un intervalle régional publié par la source concernée ; consulter la page et confirmer par téléphone.' },
          { q: 'Le site indique-t-il les gardes des pharmacies italiennes ?', a: 'Non. Le répertoire italien est une liste d’adresses et ce guide ne revendique aucune garde italienne.' },
        ],
      },
    },
  },
  {
    id: 'farmacie-ticino-elenco-contatti',
    image: 'lugano-view.webp',
    slugs: {
      it: 'farmacie-ticino-elenco-contatti',
      en: 'ticino-pharmacy-directory-contacts',
      de: 'apotheken-tessin-verzeichnis-kontakte',
      fr: 'repertoire-pharmacies-tessin-contacts',
    },
    seo: {
      title: 'Farmacie in Ticino: elenco e contatti',
      keywords: 'farmacie Ticino elenco, contatti farmacie Ticino, lista ufficiale farmacie, farmacia Lugano, farmacia Bellinzona',
      headline: 'Farmacie in Ticino: elenco ufficiale e contatti',
      breadcrumbName: 'Farmacie in Ticino',
    },
    imageAlt: {
      it: 'Panorama di Lugano in Ticino',
      en: 'Panorama of Lugano in Ticino',
      de: 'Panorama von Lugano im Tessin',
      fr: 'Panorama de Lugano au Tessin',
    },
    copy: {
      it: {
        title: 'Farmacie in Ticino: elenco e contatti',
        focus: 'Un punto di partenza per cercare le farmacie presenti nel catalogo ticinese e raggiungere le schede locali disponibili.',
        detailHeading: 'Che cosa contiene l’elenco',
        detail: 'Il catalogo Ticino deriva dalla lista ufficiale del Cantone e, nello snapshot corrente, contiene {{TICINO_COUNT}} record. Un record serve per orientarsi tra nomi, indirizzi e contatti pubblicati; non è una conferma di apertura in tempo reale e non sostituisce la telefonata.',
        advice: 'Per una ricerca pratica, parti dal percorso Ticino, usa la scheda della farmacia e controlla quali informazioni sono effettivamente pubblicate. Se ti serve un turno, passa alla fonte regionale pertinente: non confondere il catalogo con il servizio di turno.',
        faq: [
          { q: 'Quante voci contiene lo snapshot del catalogo Ticino?', a: 'Lo snapshot corrente contiene {{TICINO_COUNT}} record della lista ufficiale del Cantone. Il numero può cambiare al prossimo aggiornamento.' },
          { q: 'Un contatto nel catalogo significa che la farmacia è aperta?', a: 'No. Il catalogo è un elenco anagrafico; per apertura, orari o turno bisogna leggere la fonte disponibile e verificare direttamente.' },
          { q: 'Dove si controllano le farmacie di turno?', a: 'I turni verificati sono pubblicati nelle fonti regionali delle cinque aree coperte: Mendrisiotto, Luganese, Bellinzonese, Biasca e Valli e Locarnese.' },
        ],
      },
      en: {
        title: 'Pharmacies in Ticino: directory and contacts',
        focus: 'A starting point for finding pharmacies present in the Ticino directory and opening the local records that are available.',
        detailHeading: 'What the directory contains',
        detail: 'The Ticino directory comes from the official cantonal list and the current snapshot contains {{TICINO_COUNT}} records. A record helps with names, addresses and published contacts; it is not real-time proof of opening and does not replace a phone call.',
        advice: 'For a practical search, start with the Ticino route, open the pharmacy record and check which details are actually published. If you need duty information, move to the relevant regional source: do not treat the directory as a duty service.',
        faq: [
          { q: 'How many records are in the Ticino directory snapshot?', a: 'The current snapshot contains {{TICINO_COUNT}} records from the official cantonal list. The count may change at the next refresh.' },
          { q: 'Does a directory contact mean that a pharmacy is open?', a: 'No. The directory is an address record; for opening, hours or duty, read the available source and confirm directly.' },
          { q: 'Where can duty pharmacies be checked?', a: 'Verified duty is published on the regional sources for the five covered areas: Mendrisiotto, Luganese, Bellinzonese, Biasca e Valli and Locarnese.' },
        ],
      },
      de: {
        title: 'Apotheken im Tessin: Verzeichnis und Kontakte',
        focus: 'Ein Ausgangspunkt für die Suche nach Apotheken im Tessiner Verzeichnis und für den Aufruf der verfügbaren lokalen Einträge.',
        detailHeading: 'Was das Verzeichnis enthält',
        detail: 'Das Tessiner Verzeichnis basiert auf der offiziellen kantonalen Liste; der aktuelle Snapshot enthält {{TICINO_COUNT}} Einträge. Ein Eintrag hilft bei Namen, Adressen und veröffentlichten Kontakten, beweist aber keine aktuelle Öffnung und ersetzt keinen Anruf.',
        advice: 'Für die Suche zuerst den Tessin-Weg öffnen, den Apothekeneintrag lesen und die tatsächlich veröffentlichten Angaben prüfen. Für Notdienstinformationen zur zuständigen regionalen Quelle wechseln: Das Verzeichnis ist kein Notdienst.',
        faq: [
          { q: 'Wie viele Einträge enthält der Tessiner Verzeichnis-Snapshot?', a: 'Der aktuelle Snapshot enthält {{TICINO_COUNT}} Einträge aus der offiziellen kantonalen Liste. Die Zahl kann sich beim nächsten Abruf ändern.' },
          { q: 'Bedeutet ein Kontakt im Verzeichnis, dass die Apotheke geöffnet ist?', a: 'Nein. Das Verzeichnis ist eine Adressliste; Öffnung, Zeiten oder Notdienst müssen anhand der verfügbaren Quelle und direkt bestätigt werden.' },
          { q: 'Wo lässt sich der Notdienst prüfen?', a: 'Bestätigter Notdienst steht auf den regionalen Quellen für die fünf Gebiete Mendrisiotto, Luganese, Bellinzonese, Biasca e Valli und Locarnese.' },
        ],
      },
      fr: {
        title: 'Pharmacies au Tessin : répertoire et contacts',
        focus: 'Un point de départ pour rechercher les pharmacies présentes dans le répertoire tessinois et ouvrir les fiches locales disponibles.',
        detailHeading: 'Ce que contient le répertoire',
        detail: 'Le répertoire tessinois provient de la liste cantonale officielle et l’instantané actuel contient {{TICINO_COUNT}} entrées. Une entrée aide à trouver les noms, adresses et contacts publiés ; elle ne prouve pas une ouverture en temps réel et ne remplace pas un appel.',
        advice: 'Pour une recherche pratique, ouvrir le parcours du Tessin, consulter la fiche et vérifier les informations effectivement publiées. Pour une garde, passer par la source régionale concernée : le répertoire n’est pas un service de garde.',
        faq: [
          { q: 'Combien d’entrées contient l’instantané du répertoire tessinois ?', a: 'L’instantané actuel contient {{TICINO_COUNT}} entrées issues de la liste cantonale officielle. Le nombre peut changer lors du prochain rafraîchissement.' },
          { q: 'Un contact dans le répertoire signifie-t-il que la pharmacie est ouverte ?', a: 'Non. Le répertoire est une liste d’adresses ; pour l’ouverture, les horaires ou la garde, consulter la source disponible et confirmer directement.' },
          { q: 'Où vérifier les pharmacies de garde ?', a: 'Les gardes vérifiées sont publiées sur les sources régionales des cinq zones couvertes : Mendrisiotto, Luganese, Bellinzonese, Biasca e Valli et Locarnese.' },
        ],
      },
    },
  },
  {
    id: 'farmacie-confine-italia-como-varese-verbano',
    image: 'mendrisio.webp',
    slugs: {
      it: 'farmacie-confine-italia-como-varese-verbano',
      en: 'border-pharmacies-como-varese-verbano',
      de: 'grenzapotheken-como-varese-verbano',
      fr: 'pharmacies-frontiere-come-varese-verbano',
    },
    seo: {
      title: 'Farmacie al confine: Como, Varese e Verbano',
      keywords: 'farmacie confine Italia Svizzera, farmacie Como, farmacie Varese, farmacie Verbano, farmacie Ticino',
      headline: 'Farmacie al confine: il catalogo per Como, Varese e Verbano',
      breadcrumbName: 'Farmacie al confine',
    },
    imageAlt: {
      it: 'Paesaggio del Mendrisiotto vicino al confine',
      en: 'Mendrisiotto landscape near the border',
      de: 'Landschaft des Mendrisiotto nahe der Grenze',
      fr: 'Paysage du Mendrisiotto près de la frontière',
    },
    copy: {
      it: {
        title: 'Farmacie al confine: Como, Varese e Verbano',
        focus: 'Come usare il catalogo delle farmacie italiane di confine insieme all’elenco ticinese, senza trasformare un’anagrafica in una promessa di apertura.',
        detailHeading: 'Il perimetro italiano del catalogo',
        detail: 'Il dataset italiano è filtrato sulle province CO, VA e VB, cioè Como, Varese e Verbano-Cusio-Ossola; lo snapshot corrente contiene {{ITALY_COUNT}} record. È un catalogo di sedi e contatti pubblicati, non una copertura italiana completa e non un elenco di turni.',
        advice: 'Per confrontare le due sponde, usa i percorsi Ticino e Italia e leggi separatamente la fonte di ciascun catalogo. Per un’apertura o un turno in Italia verifica la farmacia e le autorità locali: questa guida non fa alcun claim di turno italiano.',
        faq: [
          { q: 'Quali province italiane sono incluse?', a: 'Il catalogo è limitato a CO, VA e VB: Como, Varese e Verbano-Cusio-Ossola.' },
          { q: 'Quanti record ha lo snapshot italiano?', a: 'Lo snapshot corrente contiene {{ITALY_COUNT}} record filtrati sulle tre province di confine. Il dato può cambiare al prossimo aggiornamento.' },
          { q: 'Il catalogo italiano mostra le farmacie di turno?', a: 'No. È un elenco anagrafico; non viene fatta alcuna dichiarazione di turno o apertura italiana.' },
        ],
      },
      en: {
        title: 'Border pharmacies: Como, Varese and Verbano',
        focus: 'How to use the Italian border pharmacy catalogue alongside the Ticino directory without turning an address record into an opening promise.',
        detailHeading: 'The Italian catalogue perimeter',
        detail: 'The Italian dataset is filtered to provinces CO, VA and VB: Como, Varese and Verbano-Cusio-Ossola. The current snapshot contains {{ITALY_COUNT}} records. It is a directory of published locations and contacts, not nationwide Italian coverage and not a duty list.',
        advice: 'To compare the two sides of the border, use the Ticino and Italy routes and read each catalogue’s source separately. For opening or duty information in Italy, check the pharmacy and local authorities: this guide makes no Italian on-duty claim.',
        faq: [
          { q: 'Which Italian provinces are included?', a: 'The catalogue is limited to CO, VA and VB: Como, Varese and Verbano-Cusio-Ossola.' },
          { q: 'How many records are in the Italian snapshot?', a: 'The current snapshot contains {{ITALY_COUNT}} records filtered to the three border provinces. The count may change at the next refresh.' },
          { q: 'Does the Italian catalogue show on-duty pharmacies?', a: 'No. It is an address directory; it makes no statement about Italian duty or opening.' },
        ],
      },
      de: {
        title: 'Grenzapotheken: Como, Varese und Verbano',
        focus: 'Wie das italienische Grenzapotheken-Verzeichnis zusammen mit dem Tessiner Verzeichnis genutzt wird, ohne einen Adresseneintrag als Öffnungszusage zu verstehen.',
        detailHeading: 'Der italienische Katalogumfang',
        detail: 'Der italienische Datensatz ist auf die Provinzen CO, VA und VB gefiltert: Como, Varese und Verbano-Cusio-Ossola. Der aktuelle Snapshot enthält {{ITALY_COUNT}} Einträge. Er ist ein Verzeichnis veröffentlichter Standorte und Kontakte, keine landesweite italienische Abdeckung und keine Notdienstliste.',
        advice: 'Für den Vergleich beider Grenzseiten die Tessin- und Italien-Wege öffnen und die Quellen getrennt lesen. Öffnung oder Notdienst in Italien bei der Apotheke und den lokalen Stellen prüfen: Dieser Leitfaden erhebt keinen Anspruch auf italienischen Notdienst.',
        faq: [
          { q: 'Welche italienischen Provinzen sind enthalten?', a: 'Der Katalog ist auf CO, VA und VB beschränkt: Como, Varese und Verbano-Cusio-Ossola.' },
          { q: 'Wie viele Einträge enthält der italienische Snapshot?', a: 'Der aktuelle Snapshot enthält {{ITALY_COUNT}} auf die drei Grenzprovinzen gefilterte Einträge. Die Zahl kann sich beim nächsten Abruf ändern.' },
          { q: 'Zeigt der italienische Katalog Notdienst-Apotheken?', a: 'Nein. Es handelt sich um ein Adressverzeichnis; zu italienischem Notdienst oder Öffnung wird keine Aussage gemacht.' },
        ],
      },
      fr: {
        title: 'Pharmacies à la frontière : Côme, Varèse et Verbano',
        focus: 'Comment utiliser le catalogue des pharmacies italiennes de la frontière avec le répertoire tessinois, sans transformer une adresse en promesse d’ouverture.',
        detailHeading: 'Le périmètre du catalogue italien',
        detail: 'Le jeu de données italien est filtré sur les provinces CO, VA et VB : Côme, Varèse et Verbano-Cusio-Ossola. L’instantané actuel contient {{ITALY_COUNT}} entrées. Il s’agit d’un répertoire de sites et de contacts publiés, pas d’une couverture italienne nationale ni d’une liste de gardes.',
        advice: 'Pour comparer les deux côtés de la frontière, utiliser les parcours du Tessin et de l’Italie et lire séparément la source de chaque répertoire. Pour l’ouverture ou la garde en Italie, vérifier auprès de la pharmacie et des autorités locales : ce guide ne revendique aucune garde italienne.',
        faq: [
          { q: 'Quelles provinces italiennes sont incluses ?', a: 'Le catalogue se limite à CO, VA et VB : Côme, Varèse et Verbano-Cusio-Ossola.' },
          { q: 'Combien d’entrées compte l’instantané italien ?', a: 'L’instantané actuel contient {{ITALY_COUNT}} entrées filtrées sur les trois provinces frontalières. Le nombre peut changer lors du prochain rafraîchissement.' },
          { q: 'Le catalogue italien indique-t-il les pharmacies de garde ?', a: 'Non. C’est un répertoire d’adresses ; aucune information de garde ou d’ouverture italienne n’est revendiquée.' },
        ],
      },
    },
  },
  {
    id: 'farmacia-aperta-turno-elenco',
    image: 'castelgrande.webp',
    slugs: {
      it: 'farmacia-aperta-turno-elenco',
      en: 'open-pharmacy-duty-directory-guide',
      de: 'apotheke-geoeffnet-notdienst-verzeichnis',
      fr: 'pharmacie-ouverte-garde-repertoire',
    },
    seo: {
      title: 'Farmacia aperta o di turno: come leggere l’elenco',
      keywords: 'farmacia aperta Ticino, farmacia di turno, elenco farmacie, orari farmacia, OFCT',
      headline: 'Farmacia aperta o di turno: come leggere l’elenco',
      breadcrumbName: 'Farmacia aperta o di turno',
    },
    imageAlt: {
      it: 'Castelgrande a Bellinzona, Ticino',
      en: 'Castelgrande in Bellinzona, Ticino',
      de: 'Castelgrande in Bellinzona, Tessin',
      fr: 'Castelgrande à Bellinzone, Tessin',
    },
    copy: {
      it: {
        title: 'Farmacia aperta o di turno: come leggere l’elenco',
        focus: 'La differenza pratica tra trovare una farmacia nel catalogo, leggere un orario pubblicato e verificare un turno OFCT.',
        detailHeading: 'Tre domande prima di partire',
        detail: 'Primo: la farmacia compare nell’elenco anagrafico? Secondo: la scheda pubblica un orario? Terzo: esiste un turno verificato per la sua area e per l’intervallo indicato? Solo la terza risposta riguarda il turno; le altre due non lo sostituiscono.',
        advice: 'Apri il percorso corretto, controlla la data di recupero dello snapshot e la fonte indicata, poi chiama la farmacia. La pagina non interpreta automaticamente un record come “aperto ora”, né estende i turni alle province italiane.',
        faq: [
          { q: 'Un elenco di farmacie indica quale sede è aperta ora?', a: 'No. Il catalogo identifica sedi e contatti; gli orari sono mostrati solo se pubblicati e il turno deve risultare dalla fonte regionale pertinente.' },
          { q: 'Che cosa distingue un turno verificato?', a: 'È un intervallo regionale pubblicato dalla fonte pertinente per le cinque aree coperte: Mendrisiotto, Luganese, Bellinzonese, Biasca e Valli e Locarnese.' },
          { q: 'La guida copre tutta l’Italia?', a: 'No. Il catalogo italiano è limitato alle province CO, VA e VB e non viene fatta alcuna dichiarazione di turno italiano.' },
        ],
      },
      en: {
        title: 'Open or on duty? How to read the pharmacy directory',
        focus: 'The practical difference between finding a pharmacy in a directory, reading published hours and checking OFCT duty information.',
        detailHeading: 'Three questions before you travel',
        detail: 'First: does the pharmacy appear in the address directory? Second: does its record publish hours? Third: is there verified duty for its area and the stated interval? Only the third answer concerns duty; the other two do not replace it.',
        advice: 'Open the correct route, check the snapshot retrieval time and the named source, then call the pharmacy. The page does not automatically interpret a record as open now and does not extend duty coverage to the Italian provinces.',
        faq: [
          { q: 'Does a pharmacy directory show which branch is open now?', a: 'No. The directory identifies locations and contacts; hours appear only when published, and duty must come from the relevant regional source.' },
          { q: 'What makes duty verified?', a: 'It is a regional interval published by the relevant source for the five covered areas: Mendrisiotto, Luganese, Bellinzonese, Biasca e Valli and Locarnese.' },
          { q: 'Does this guide cover all of Italy?', a: 'No. The Italian catalogue is limited to provinces CO, VA and VB and makes no Italian on-duty claim.' },
        ],
      },
      de: {
        title: 'Apotheke geöffnet oder Notdienst? Das Verzeichnis richtig lesen',
        focus: 'Der praktische Unterschied zwischen einem Verzeichniseintrag, veröffentlichten Öffnungszeiten und OFCT-Notdienstangaben.',
        detailHeading: 'Drei Fragen vor der Fahrt',
        detail: 'Erstens: Steht die Apotheke im Adressverzeichnis? Zweitens: veröffentlicht der Eintrag Öffnungszeiten? Drittens: gibt es für das Gebiet und das genannte Intervall einen bestätigten Notdienst? Nur die dritte Antwort betrifft den Notdienst; die anderen ersetzen ihn nicht.',
        advice: 'Den passenden Weg öffnen, Abrufzeitpunkt und Quelle des Snapshots prüfen und anschließend die Apotheke anrufen. Die Seite deutet einen Eintrag nicht automatisch als jetzt geöffnet und überträgt den Notdienst nicht auf italienische Provinzen.',
        faq: [
          { q: 'Zeigt ein Apothekenverzeichnis, welche Filiale jetzt geöffnet ist?', a: 'Nein. Das Verzeichnis nennt Standorte und Kontakte; Zeiten erscheinen nur bei Veröffentlichung, und Notdienst muss aus der zuständigen regionalen Quelle stammen.' },
          { q: 'Was macht einen Notdienst bestätigt?', a: 'Es handelt sich um ein von der zuständigen regionalen Quelle veröffentlichtes Intervall für die fünf Gebiete Mendrisiotto, Luganese, Bellinzonese, Biasca e Valli und Locarnese.' },
          { q: 'Deckt dieser Leitfaden ganz Italien ab?', a: 'Nein. Das italienische Verzeichnis ist auf CO, VA und VB beschränkt und macht keine Aussage zu italienischem Notdienst.' },
        ],
      },
      fr: {
        title: 'Pharmacie ouverte ou de garde ? Comment lire le répertoire',
        focus: 'La différence pratique entre trouver une pharmacie dans un répertoire, lire des horaires publiés et vérifier une garde OFCT.',
        detailHeading: 'Trois questions avant de partir',
        detail: 'Première question : la pharmacie figure-t-elle dans le répertoire d’adresses ? Deuxième : sa fiche publie-t-elle des horaires ? Troisième : une garde vérifiée existe-t-elle pour sa zone et l’intervalle indiqué ? Seule la troisième réponse concerne la garde ; les deux autres ne la remplacent pas.',
        advice: 'Ouvrir le parcours adapté, vérifier l’heure de téléchargement de l’instantané et la source indiquée, puis appeler la pharmacie. La page ne transforme pas automatiquement une entrée en pharmacie ouverte et n’étend pas les gardes aux provinces italiennes.',
        faq: [
          { q: 'Un répertoire indique-t-il quelle pharmacie est ouverte maintenant ?', a: 'Non. Le répertoire identifie les sites et les contacts ; les horaires ne sont affichés que s’ils sont publiés et la garde doit provenir de la source régionale concernée.' },
          { q: 'Qu’est-ce qu’une garde vérifiée ?', a: 'C’est un intervalle régional publié par la source concernée pour les cinq zones couvertes : Mendrisiotto, Luganese, Bellinzonese, Biasca e Valli et Locarnese.' },
          { q: 'Ce guide couvre-t-il toute l’Italie ?', a: 'Non. Le répertoire italien se limite aux provinces CO, VA et VB et ne revendique aucune garde italienne.' },
        ],
      },
    },
  },
  {
    id: 'farmacie-turno-svizzera-confine-italiano',
    image: 'lugano-view.webp',
    slugs: {
      it: 'farmacie-turno-svizzera-confine-italiano',
      en: 'on-duty-pharmacies-switzerland-italian-border',
      de: 'notdienst-apotheken-schweiz-italienische-grenze',
      fr: 'pharmacies-garde-suisse-frontiere-italienne',
    },
    seo: {
      title: 'Farmacie di turno in Svizzera e confine italiano: fonti per cantone',
      keywords: 'farmacie di turno Svizzera, farmacia di guardia cantone, farmacia aperta confine Italia, OFCT Ticino, farmacie Varese Como, Locarnese',
      headline: 'Farmacie di turno in Svizzera: verifica per cantone e confine italiano',
      breadcrumbName: 'Farmacie di turno Svizzera',
    },
    imageAlt: {
      it: 'Vista di Lugano e del suo lago',
      en: 'View of Lugano and its lake',
      de: 'Blick auf Lugano und seinen See',
      fr: 'Vue de Lugano et de son lac',
    },
    copy: {
      it: {
        title: 'Farmacie di turno in Svizzera e confine italiano: fonti per cantone',
        focus: 'Una guida per verificare la fonte aggiornata nel cantone giusto, senza inventare calendari né trasformare un link in una promessa di apertura.',
        detailHeading: 'Che cosa è verificato e che cosa no',
        detail: 'Il dato di turno verificato pubblicato dal nostro dataset riguarda cinque regioni ticinesi: Mendrisiotto, Luganese, Bellinzonese, Biasca e Valli e Locarnese. Per il Locarnese la fonte è associativa regionale; per gli altri cantoni proponiamo link ufficiali navigabili quando disponibili, ma non pubblichiamo un roster unificato, una copertura attiva o orari dedotti.',
        advice: 'Apri la fonte del cantone o della provincia prima di spostarti, segui le istruzioni che pubblica e chiama la farmacia. Se una fonte non espone un feed o un roster pubblico, la guida lo dice invece di colmare il vuoto con supposizioni.',
        seoDescription: 'Farmacie di turno in Svizzera e confine CO/VA/VB: fonti cantonali da verificare, cinque regioni ticinesi verificate e limiti espliciti.',
        ogDescription: 'Guida alle fonti per le farmacie di turno in Svizzera e al confine italiano: nessun calendario inventato, verifiche locali prima di partire.',
        faq: [
          { q: 'La guida mostra un calendario nazionale delle farmacie di turno?', a: 'No. Indica dove verificare la fonte aggiornata per cantone. Il dataset pubblicato contiene dati verificati per cinque regioni ticinesi: Mendrisiotto, Luganese, Bellinzonese, Biasca e Valli e Locarnese; per il Locarnese la fonte è associativa regionale.' },
          { q: 'La presenza di un link cantonale significa che una farmacia è aperta?', a: 'No. Un link è un percorso di verifica: non promette orari, turno o copertura attiva.' },
          { q: 'Come verifico Como, Varese e Verbano-Cusio-Ossola?', a: 'Apri ATS Insubria o il documento locale indicato, controlla l’aggiornamento e conferma direttamente con la farmacia. Questa guida non deduce un turno italiano.' },
        ],
      },
      en: {
        title: 'On-duty pharmacies in Switzerland and the Italian border: sources by canton',
        focus: 'A guide to checking the current source in the right canton, without inventing calendars or turning a link into an opening promise.',
        detailHeading: 'What is verified and what is not',
        detail: 'The verified duty data published by our dataset concerns five Ticino regions: Mendrisiotto, Luganese, Bellinzonese, Biasca e Valli and Locarnese. Locarnese uses a regional association source; for other cantons we provide navigable official links where available, but publish no unified roster, active coverage or inferred hours.',
        advice: 'Open the cantonal or provincial source before travelling, follow its published instructions and call the pharmacy. Where a source exposes no public feed or roster, the guide says so rather than filling the gap with assumptions.',
        seoDescription: 'On-duty pharmacies in Switzerland and the CO/VA/VB border: cantonal sources to check, five verified Ticino regions and explicit limits.',
        ogDescription: 'A source guide for on-duty pharmacies in Switzerland and at the Italian border: no invented calendar, verify locally before travelling.',
        faq: [
          { q: 'Does this guide show a nationwide on-duty pharmacy calendar?', a: 'No. It explains where to check the current source by canton. The published dataset has verified data for five Ticino regions: Mendrisiotto, Luganese, Bellinzonese, Biasca e Valli and Locarnese; Locarnese uses a regional association source.' },
          { q: 'Does a cantonal link mean that a pharmacy is open?', a: 'No. A link is a route for verification; it does not promise hours, duty or active coverage.' },
          { q: 'How do I check Como, Varese and Verbano-Cusio-Ossola?', a: 'Open ATS Insubria or the named local document, check its update and confirm directly with the pharmacy. This guide infers no Italian duty.' },
        ],
      },
      de: {
        title: 'Notdienst-Apotheken in der Schweiz und an der italienischen Grenze: Quellen je Kanton',
        focus: 'Ein Leitfaden zur Prüfung der aktuellen Quelle im richtigen Kanton, ohne Kalender zu erfinden oder einen Link als Öffnungszusage zu lesen.',
        detailHeading: 'Was bestätigt ist und was nicht',
        detail: 'Die bestätigten Notdienst-Daten unseres Datensatzes betreffen fünf Tessiner Regionen: Mendrisiotto, Luganese, Bellinzonese, Biasca e Valli und Locarnese. Für das Locarnese wird eine regionale Verbandsquelle genutzt; für andere Kantone nennen wir verfügbare aufrufbare offizielle Links, veröffentlichen aber kein einheitliches Verzeichnis, keine aktive Abdeckung und keine abgeleiteten Öffnungszeiten.',
        advice: 'Vor der Fahrt die kantonale oder provinzialen Quelle öffnen, ihren veröffentlichten Anweisungen folgen und die Apotheke anrufen. Wenn eine Quelle keinen öffentlichen Feed oder kein Verzeichnis bietet, benennt der Leitfaden dies statt die Lücke mit Annahmen zu füllen.',
        seoDescription: 'Notdienst-Apotheken in der Schweiz und an der Grenze CO/VA/VB: kantonale Quellen prüfen, fünf bestätigte Tessiner Gebiete und klare Grenzen.',
        ogDescription: 'Quellenleitfaden für Notdienst-Apotheken in der Schweiz und an der italienischen Grenze: kein erfundener Kalender, lokal vor der Fahrt prüfen.',
        faq: [
          { q: 'Zeigt dieser Leitfaden einen landesweiten Notdienst-Kalender?', a: 'Nein. Er erklärt, wo die aktuelle Quelle je Kanton geprüft wird. Im veröffentlichten Datensatz gibt es bestätigte Daten für fünf Tessiner Regionen: Mendrisiotto, Luganese, Bellinzonese, Biasca e Valli und Locarnese; für das Locarnese stammt die Quelle aus einem regionalen Verband.' },
          { q: 'Bedeutet ein kantonaler Link, dass eine Apotheke geöffnet ist?', a: 'Nein. Ein Link ist ein Prüfweg; er verspricht weder Öffnungszeit noch Notdienst oder aktive Abdeckung.' },
          { q: 'Wie prüfe ich Como, Varese und Verbano-Cusio-Ossola?', a: 'ATS Insubria oder das genannte lokale Dokument öffnen, Aktualität prüfen und direkt bei der Apotheke bestätigen. Dieser Leitfaden leitet keinen italienischen Notdienst ab.' },
        ],
      },
      fr: {
        title: 'Pharmacies de garde en Suisse et à la frontière italienne : sources par canton',
        focus: 'Un guide pour vérifier la source à jour dans le bon canton, sans inventer de calendrier ni transformer un lien en promesse d’ouverture.',
        detailHeading: 'Ce qui est vérifié et ce qui ne l’est pas',
        detail: 'Les données de garde vérifiées publiées par notre jeu de données concernent cinq régions tessinoises : le Mendrisiotto, le Luganese, le Bellinzonese, Biasca e Valli et le Locarnese. Pour le Locarnese, la source est celle d’une association régionale ; pour les autres cantons, nous proposons des liens officiels navigables lorsqu’ils sont disponibles, mais aucun roster unique, aucune couverture active ni horaire déduit.',
        advice: 'Ouvrir la source cantonale ou provinciale avant le déplacement, suivre ses indications publiées et appeler la pharmacie. Lorsqu’une source n’expose aucun flux ni roster public, le guide le dit au lieu de combler le manque par des suppositions.',
        seoDescription: 'Pharmacies de garde en Suisse et frontière CO/VA/VB : sources cantonales à vérifier, cinq régions tessinoises vérifiées et limites explicites.',
        ogDescription: 'Guide des sources pour les pharmacies de garde en Suisse et à la frontière italienne : aucun calendrier inventé, vérification locale avant le déplacement.',
        faq: [
          { q: 'Ce guide affiche-t-il un calendrier national des pharmacies de garde ?', a: 'Non. Il indique où vérifier la source à jour par canton. Le jeu de données publié contient des données vérifiées pour cinq régions tessinoises : le Mendrisiotto, le Luganese, le Bellinzonese, Biasca e Valli et le Locarnese ; pour le Locarnese, la source est associative régionale.' },
          { q: 'Un lien cantonal signifie-t-il qu’une pharmacie est ouverte ?', a: 'Non. Un lien est un parcours de vérification ; il ne promet ni horaire, ni garde, ni couverture active.' },
          { q: 'Comment vérifier Côme, Varèse et Verbano-Cusio-Ossola ?', a: 'Ouvrir ATS Insubria ou le document local indiqué, vérifier sa mise à jour et confirmer directement auprès de la pharmacie. Ce guide ne déduit aucune garde italienne.' },
        ],
      },
    },
  },
]);

function sourceAndRoutes(copy, locale, snapshots) {
  const routes = PHARMACY_ROUTES[locale];
  const { ticino, italy } = snapshots.catalog;
  const duty = snapshots.duty;
  const regionLinks = EXPECTED_DUTY_REGIONS.map((region, index) => {
    const url = duty.sourceRegions[index];
    return `[${region}](${url})`;
  }).join(', ');
  const sourceLines = {
    it: [
      `- **${copy.ticinoDirectory}**: ${ticino.recordCount} record, recuperati alle ${ticino.fetchedAt}. [${copy.officialList}](${ticino.sourceUrl})`,
      `- **${copy.italyDirectory}**: ${italy.recordCount} record, recuperati alle ${italy.fetchedAt}. [${copy.officialDataset}](${italy.sourceUrl})`,
      `- **${copy.dutySource}**: aree ${EXPECTED_DUTY_REGIONS.join(', ')}, recuperate alle ${duty.fetchedAt}. [${copy.ofctHub}](${duty.sourceUrl})`,
    ],
    en: [
      `- **${copy.ticinoDirectory}**: ${ticino.recordCount} records, retrieved at ${ticino.fetchedAt}. [${copy.officialList}](${ticino.sourceUrl})`,
      `- **${copy.italyDirectory}**: ${italy.recordCount} records, retrieved at ${italy.fetchedAt}. [${copy.officialDataset}](${italy.sourceUrl})`,
      `- **${copy.dutySource}**: areas ${EXPECTED_DUTY_REGIONS.join(', ')}, retrieved at ${duty.fetchedAt}. [${copy.ofctHub}](${duty.sourceUrl})`,
    ],
    de: [
      `- **${copy.ticinoDirectory}**: ${ticino.recordCount} Einträge, abgerufen um ${ticino.fetchedAt}. [${copy.officialList}](${ticino.sourceUrl})`,
      `- **${copy.italyDirectory}**: ${italy.recordCount} Einträge, abgerufen um ${italy.fetchedAt}. [${copy.officialDataset}](${italy.sourceUrl})`,
      `- **${copy.dutySource}**: Gebiete ${EXPECTED_DUTY_REGIONS.join(', ')}, abgerufen um ${duty.fetchedAt}. [${copy.ofctHub}](${duty.sourceUrl})`,
    ],
    fr: [
      `- **${copy.ticinoDirectory}** : ${ticino.recordCount} entrées, téléchargées à ${ticino.fetchedAt}. [${copy.officialList}](${ticino.sourceUrl})`,
      `- **${copy.italyDirectory}** : ${italy.recordCount} entrées, téléchargées à ${italy.fetchedAt}. [${copy.officialDataset}](${italy.sourceUrl})`,
      `- **${copy.dutySource}** : zones ${EXPECTED_DUTY_REGIONS.join(', ')}, téléchargées à ${duty.fetchedAt}. [${copy.ofctHub}](${duty.sourceUrl})`,
    ],
  }[locale];
  const timestampSummary = {
    it: `cataloghi ${ticino.fetchedAt}; turni ${duty.fetchedAt}`,
    en: `directories ${ticino.fetchedAt}; duty ${duty.fetchedAt}`,
    de: `Verzeichnisse ${ticino.fetchedAt}; Notdienst ${duty.fetchedAt}`,
    fr: `répertoires ${ticino.fetchedAt} ; gardes ${duty.fetchedAt}`,
  }[locale];

  return `## ${copy.scope}
${copy.snapshotIntro}

${sourceLines.join('\n')}

**${copy.lastFetch}**: ${timestampSummary}. ${copy.timestampMeaning}

${copy.notNationwide}
${copy.locarnese}
${copy.locarneseSource}
${copy.noItalianDuty}

## ${copy.sources}
- [${copy.routeHub}](${routes.hub})
- [${copy.routeTicino}](${routes.ticino})
- [${copy.routeItaly}](${routes.italy})
- [${copy.routeDuty}](${routes.duty})
- **${copy.regionLinks}**: ${regionLinks}

${copy.verify}`;
}

function buildFacts(copy, locale, snapshots) {
  const { ticino, italy } = snapshots.catalog;
  const duty = snapshots.duty;
  const regionText = EXPECTED_DUTY_REGIONS.join(', ');
  const facts = {
    it: [
      `**Ambito**: Ticino e province italiane CO, VA e VB.`,
      `**Catalogo Ticino**: ${ticino.recordCount} record dalla lista ufficiale.`,
      `**Catalogo italiano**: ${italy.recordCount} record filtrati sulle tre province di confine.`,
      `**Turni verificati**: fonti regionali per ${regionText}.`,
    ],
    en: [
      `**Perimeter**: Ticino and Italian provinces CO, VA and VB.`,
      `**Ticino directory**: ${ticino.recordCount} records from the official list.`,
      `**Italian directory**: ${italy.recordCount} records filtered to the three border provinces.`,
      `**Verified duty**: regional sources for ${regionText}.`,
    ],
    de: [
      `**Umfang**: Tessin und italienische Provinzen CO, VA und VB.`,
      `**Tessiner Verzeichnis**: ${ticino.recordCount} Einträge aus der offiziellen Liste.`,
      `**Italienisches Verzeichnis**: ${italy.recordCount} auf die drei Grenzprovinzen gefilterte Einträge.`,
      `**Bestätigter Notdienst**: regionale Quellen für ${regionText}.`,
    ],
    fr: [
      `**Périmètre** : Tessin et provinces italiennes CO, VA et VB.`,
      `**Répertoire tessinois** : ${ticino.recordCount} entrées de la liste officielle.`,
      `**Répertoire italien** : ${italy.recordCount} entrées filtrées sur les trois provinces frontalières.`,
      `**Garde vérifiée** : sources régionales pour ${regionText}.`,
    ],
  };
  void locale;
  return facts[locale];
}

function buildLocalizedMeta(locale, localized, snapshots) {
  const { ticino, italy } = snapshots.catalog;
  const countText = {
    it: `${ticino.recordCount} record Ticino e ${italy.recordCount} nelle province CO, VA e VB`,
    en: `${ticino.recordCount} Ticino records and ${italy.recordCount} records in provinces CO, VA and VB`,
    de: `${ticino.recordCount} Einträge im Tessin und ${italy.recordCount} Einträge in den Provinzen CO, VA und VB`,
    fr: `${ticino.recordCount} entrées au Tessin et ${italy.recordCount} entrées dans les provinces CO, VA et VB`,
  }[locale];
  const defaultSeoDescription = {
    it: 'Farmacie in Ticino e nel confine CO/VA/VB: turni regionali verificati nelle cinque regioni ticinesi, incluso il Locarnese, e limiti del dato. Non è copertura nazionale.',
    en: 'Ticino and CO/VA/VB pharmacy directories: verified regional duty in all five Ticino regions, including Locarnese, with clear data limits. Not nationwide coverage.',
    de: 'Apotheken im Tessin und CO/VA/VB: bestätigter regionaler Notdienst in allen fünf Tessiner Regionen einschliesslich Locarnese und klare Datengrenzen. Keine landesweite Abdeckung.',
    fr: 'Pharmacies du Tessin et de CO/VA/VB : gardes régionales vérifiées dans les cinq régions tessinoises, y compris le Locarnese, et limites claires. Pas de couverture nationale.',
  }[locale];
  const defaultOgDescription = {
    it: `Cataloghi farmacia Ticino e CO/VA/VB: ${countText}; fonti, timestamp e limiti restano espliciti.`,
    en: `Ticino and CO/VA/VB pharmacy directories: ${countText}; sources, timestamps and limits are explicit.`,
    de: `Apothekenverzeichnisse Tessin und CO/VA/VB: ${countText}; Quellen, Zeitstempel und Grenzen sind klar.`,
    fr: `Répertoires du Tessin et de CO/VA/VB : ${countText} ; sources, horodatage et limites sont explicites.`,
  }[locale];
  const dutySummary = {
    it: 'turni regionali verificati nelle cinque aree ticinesi',
    en: 'regional duty verified in the five Ticino areas',
    de: 'regionaler Notdienst in den fünf Tessiner Gebieten bestätigt',
    fr: 'gardes régionales vérifiées dans les cinq zones tessinoises',
  }[locale];
  return {
    excerpt: `${localized.focus} ${countText}; ${dutySummary}.`,
    seoDescription: localized.seoDescription || defaultSeoDescription,
    ogDescription: localized.ogDescription || defaultOgDescription,
  };
}

function refreshSnapshotPlaceholders(value, snapshots) {
  return value
    .replaceAll('{{TICINO_COUNT}}', String(snapshots.catalog.ticino.recordCount))
    .replaceAll('{{ITALY_COUNT}}', String(snapshots.catalog.italy.recordCount));
}

function buildSeo(spec, snapshots) {
  const { ticino, italy } = snapshots.catalog;
  const regionCount = EXPECTED_DUTY_REGIONS.length;
  return {
    ...spec.seo,
    description: `${spec.seo.title}: ${ticino.recordCount} record Ticino e ${italy.recordCount} in CO, VA e VB; turni regionali verificati in ${regionCount} aree ticinesi. Non è copertura nazionale.`,
    ogTitle: spec.seo.title,
    ogDescription: `Cataloghi farmacia per Ticino e confine italiano (${ticino.recordCount} e ${italy.recordCount} record), con turni regionali verificati in ${regionCount} aree ticinesi. Fonti e timestamp chiari.`,
  };
}

/**
 * Build the five localized, stable-id guide payloads.  Content depends only
 * on the validated snapshots; the validation clock is injected explicitly.
 */
export function buildPharmacyEvergreenGuides(snapshots, { now = Date.now } = {}) {
  if (typeof now !== 'function') throw snapshotError('clock di validazione non valido');
  const validated = validatePharmacySnapshots(snapshots, { nowMs: now() });
  const snapshotUpdatedAt = latestSnapshotTimestamp(validated);
  const date = snapshotUpdatedAt.slice(0, 10);

  return GUIDE_SPECS.map((spec) => ({
    id: spec.id,
    category: 'pratico',
    date,
    image: spec.image,
    hasCalculator: false,
    author: { slug: 'redazione', name: 'Redazione Frontaliere Ticino' },
    seo: buildSeo(spec, validated),
    slugs: { ...spec.slugs },
    imageAlt: { ...spec.imageAlt },
    content: Object.fromEntries(PHARMACY_LOCALES.map((locale) => {
      const copy = COPY[locale];
      const localized = spec.copy[locale];
      const facts = buildFacts(copy, locale, validated);
      const sourceBlock = sourceAndRoutes(copy, locale, validated);
      const meta = buildLocalizedMeta(locale, localized, validated);
      const detail = refreshSnapshotPlaceholders(localized.detail, validated);
      const faq = localized.faq.map((item) => ({
        q: refreshSnapshotPlaceholders(item.q, validated),
        a: refreshSnapshotPlaceholders(item.a, validated),
      }));
      return [locale, {
        title: localized.title,
        excerpt: meta.excerpt,
        seoDescription: meta.seoDescription,
        ogDescription: meta.ogDescription,
        body1: `## ${copy.inBrief}\n- ${facts.join('\n- ')}\n\n${localized.focus}`,
        body2: `## ${localized.detailHeading}\n${detail}\n\n${localized.advice}\n\n## ${copy.distinction}\n- **${copy.catalogue}**: ${copy.catalogueMeaning}\n- **${copy.openingHours}**: ${copy.hoursMeaning}\n- **${copy.duty}**: ${copy.dutyMeaning}`,
      body3: `${sourceBlock}${spec.id === 'farmacie-turno-svizzera-confine-italiano' ? `\n\n${swissCantonSourceAppendix(locale)}` : ''}`,
        faq,
      }];
    })),
    _snapshotUpdatedAt: snapshotUpdatedAt,
    _deterministicBodySections: ['body1', 'body2', 'body3'],
  }));
}

export { DEFAULT_CATALOG_PATH, DEFAULT_DUTY_PATH };
