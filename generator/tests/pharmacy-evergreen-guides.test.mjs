import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildPharmacyEvergreenGuides,
  EXPECTED_MIN_RECORD_COUNTS,
  EXPECTED_DUTY_REGIONS,
  EXPECTED_DUTY_SOURCE_REGIONS,
  PHARMACY_GUIDE_IDS,
  PHARMACY_LOCALES,
  PHARMACY_ROUTES,
  SNAPSHOT_FUTURE_TOLERANCE_MS,
  loadPharmacySnapshots,
  validatePharmacySnapshots,
} from '../scripts/lib/pharmacy-evergreen-guides-content.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, '..', 'data');
const CATALOG_PATH = path.join(DATA_DIR, 'pharmacy-catalog-snapshot.json');
const DUTY_PATH = path.join(DATA_DIR, 'pharmacy-duty-snapshot.json');
const PRODUCER_PATH = path.join(HERE, '..', 'scripts', 'generate-pharmacy-evergreen-guides.mjs');

function readFixturePair() {
  return {
    catalog: JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8')),
    duty: JSON.parse(fs.readFileSync(DUTY_PATH, 'utf8')),
  };
}

function allArticleText(guide, locale) {
  return Object.values(guide.content[locale])
    .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
    .join('\n');
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const NOT_NATIONWIDE = {
  it: 'non è una copertura nazionale',
  en: 'not nationwide coverage',
  de: 'keine landesweite Abdeckung',
  fr: 'pas d’une couverture nationale',
};

const NO_ITALIAN_DUTY_CLAIM = {
  it: 'alcun claim di turno',
  en: 'No Italian on-duty claim',
  de: 'kein Notdienst-Anspruch',
  fr: 'Aucune couverture de garde italienne',
};

const SWISS_CANTON_URLS = [
  'https://www.notfall-apotheken-zh.ch/',
  'https://apobern.ch/dienstleistungen/notfalldienst/',
  'https://www.apoluzern.ch/apotheken/notfalldienst',
  'https://www.ur.ch/dienstleistungen/3677',
  'https://www.sz.ch/gesundheit-soziales/gesundheit/notfall.html/',
  'https://www.zg.ch/behoerden/gesundheit/medizinische-versorgung/notfall',
  'https://avso.ch/notfalldienst-apotheken/',
  'https://www.bs.ch/gd/md/hoheitliche-funktionen/kantonsapothekerin/liste-der-apotheken-basel-stadt',
  'https://apotheken-aargau.ch/notfall/',
  'https://www.apotheken-thurgau.ch/pikettdienst/',
  'https://notfall.apotheke-chur.ch/',
  'https://www.pharmavalais.ch/pharmacie-valais/pharmacie-garde-51.html',
  'https://www.pharmaciesfribourg.ch/fr/prestations-et-conseils/pharmacie-de-garde',
  'https://www.onp.ch/Service-de-garde',
  'https://www.jura.ch/fr/Autorites/Administration/CHA/SIC/Urgences/Numeros-d-urgence-Urgence.html',
  'https://garde.svph.ch',
  'https://pharmageneve.swiss/pharmacie-de-garde/',
];

const ITALIAN_SOURCE_URLS = [
  'https://www.ats-insubria.it/farmacie',
  'https://www.turnifarmacie.it/',
  'https://www.aslvco.it/wp-content/uploads/2026/03/3017434.pdf',
  'https://farmacia-aperta.eu/',
];

const ANNUAL_SOURCE_NOTES = {
  it: 'documento annuale, edizione 2026',
  en: 'annual document, edition 2026',
  de: 'Jahresdokument, Ausgabe 2026',
  fr: 'document annuel, édition 2026',
};

test('pharmacy evergreen: ogni guida localizzata espone scope, fonti, semantica e link operativi', () => {
  const snapshots = loadPharmacySnapshots();
  const guides = buildPharmacyEvergreenGuides(snapshots);
  const officialUrls = [
    snapshots.catalog.catalogues[0].sourceUrl,
    snapshots.catalog.catalogues[1].sourceUrl,
    snapshots.duty.sourceUrl,
    ...EXPECTED_DUTY_SOURCE_REGIONS,
  ];

  assert.deepEqual(guides.map((guide) => guide.id), PHARMACY_GUIDE_IDS);
  for (const guide of guides) {
    assert.ok(['bellinzona.webp', 'lugano-view.webp', 'mendrisio.webp', 'castelgrande.webp'].includes(guide.image));
    assert.doesNotMatch(guide.id, /-20\d\d-\d\d-\d\d/);
    assert.deepEqual(Object.keys(guide.content).sort(), [...PHARMACY_LOCALES].sort());

    for (const locale of PHARMACY_LOCALES) {
      const text = allArticleText(guide, locale);
      for (const url of officialUrls) assert.match(text, new RegExp(escaped(url)), `${guide.id}/${locale}: ${url}`);
      for (const route of Object.values(PHARMACY_ROUTES[locale])) {
        assert.match(text, new RegExp(escaped(route)), `${guide.id}/${locale}: route ${route}`);
      }
      for (const region of EXPECTED_DUTY_REGIONS) {
        assert.match(text, new RegExp(escaped(region)), `${guide.id}/${locale}: area ${region}`);
      }
      assert.match(text, /Locarnese/);
      assert.match(text, new RegExp(escaped(NOT_NATIONWIDE[locale]), 'i'));
      assert.match(text, new RegExp(escaped(NO_ITALIAN_DUTY_CLAIM[locale]), 'i'));
    }
  }

  const it = allArticleText(guides[0], 'it');
  assert.match(it, /catalogo/i);
  assert.match(it, /orari di apertura/i);
  assert.match(it, /turno verificato/i);
  assert.match(it, /timestamp/i);
  const en = allArticleText(guides[0], 'en');
  assert.match(en, /directory/i);
  assert.match(en, /opening hours/i);
  assert.match(en, /verified duty/i);
  assert.match(en, /timestamp/i);
});

test('pharmacy evergreen: il builder è idempotente e non muta gli snapshot', () => {
  const snapshots = readFixturePair();
  const before = JSON.stringify(snapshots);
  const once = buildPharmacyEvergreenGuides(snapshots);
  const twice = buildPharmacyEvergreenGuides(snapshots);

  assert.equal(JSON.stringify(once), JSON.stringify(twice));
  assert.equal(JSON.stringify(snapshots), before);
  assert.equal(once[0]._snapshotUpdatedAt, '2026-09-15T09:40:29.571Z');
  assert.equal(once[0].date, '2026-09-15');
});

test('pharmacy evergreen: il clock di validazione del builder è iniettato', () => {
  const snapshots = readFixturePair();
  const nowMs = Date.parse('2026-09-15T09:41:00.000Z');
  let calls = 0;
  const guides = buildPharmacyEvergreenGuides(snapshots, {
    now: () => {
      calls += 1;
      return nowMs;
    },
  });

  assert.equal(guides.length, 5);
  assert.equal(calls, 1, 'la validazione deve usare il clock esplicito una sola volta');
});

test('pharmacy evergreen: la guida Svizzera collega ogni fonte senza inventare un calendario', () => {
  const guide = buildPharmacyEvergreenGuides(loadPharmacySnapshots())
    .find((item) => item.id === 'farmacie-turno-svizzera-confine-italiano');
  assert.ok(guide, 'la quinta guida stabile deve essere prodotta');

  for (const locale of PHARMACY_LOCALES) {
    const text = allArticleText(guide, locale);
    for (const url of [...SWISS_CANTON_URLS, ...ITALIAN_SOURCE_URLS]) {
      assert.match(text, new RegExp(escaped(url)), `${locale}: ${url}`);
    }
    assert.match(text, /Mendrisiotto.*Luganese.*Bellinzonese.*Biasca e Valli.*Locarnese/s);
    assert.match(text, new RegExp(escaped(ANNUAL_SOURCE_NOTES[locale]), 'i'));
    assert.match(text, /Locarnese/);
    assert.match(text, /OW.*NW.*GL.*AR.*AI.*BL.*SH.*SG/s);
    assert.match(text, /144/);
  }
});

test('pharmacy evergreen: snapshot mancante — il producer chiude prima della scrittura', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmacy-evergreen-'));
  try {
    assert.throws(
      () => loadPharmacySnapshots({
        catalogPath: path.join(tempDir, 'missing-catalog.json'),
        dutyPath: DUTY_PATH,
      }),
      /catalogo farmacia snapshot.*assente/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('pharmacy evergreen: scope inatteso o fonte in errore — guardia fail-closed', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmacy-evergreen-'));
  try {
    const { catalog, duty } = readFixturePair();

    const wrongProvinceCatalog = structuredClone(catalog);
    wrongProvinceCatalog.catalogues[1].provinces = ['CO', 'VA'];
    const wrongProvinceCatalogPath = path.join(tempDir, 'wrong-provinces.json');
    fs.writeFileSync(wrongProvinceCatalogPath, JSON.stringify(wrongProvinceCatalog));
    assert.throws(
      () => loadPharmacySnapshots({ catalogPath: wrongProvinceCatalogPath, dutyPath: DUTY_PATH }),
      /catalogo italiano\.provinces.*fuori perimetro/,
    );

    const wrongDuty = structuredClone(duty);
    wrongDuty.scope.includedRegions = [...EXPECTED_DUTY_REGIONS, 'Sopraceneri'];
    const wrongDutyPath = path.join(tempDir, 'wrong-duty-scope.json');
    fs.writeFileSync(wrongDutyPath, JSON.stringify(wrongDuty));
    assert.throws(
      () => loadPharmacySnapshots({ catalogPath: CATALOG_PATH, dutyPath: wrongDutyPath }),
      /turni snapshot\.scope\.includedRegions.*fuori perimetro/,
    );

    const sourceErrorDuty = structuredClone(duty);
    sourceErrorDuty.errors = ['OFCT source unavailable'];
    const sourceErrorDutyPath = path.join(tempDir, 'source-error-duty.json');
    fs.writeFileSync(sourceErrorDutyPath, JSON.stringify(sourceErrorDuty));
    assert.throws(
      () => loadPharmacySnapshots({ catalogPath: CATALOG_PATH, dutyPath: sourceErrorDutyPath }),
      /turni snapshot\.errors contiene errori/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('pharmacy evergreen: completezza e warning sono guardati fail-closed', () => {
  const snapshots = readFixturePair();

  const missingCompleteness = structuredClone(snapshots);
  delete missingCompleteness.catalog.catalogues[0].completeness;
  assert.throws(
    () => validatePharmacySnapshots(missingCompleteness),
    /catalogo Ticino\.completeness.*prova di completezza/,
  );

  const partial = structuredClone(snapshots);
  partial.catalog.catalogues[0].completeness.status = 'partial';
  assert.throws(
    () => validatePharmacySnapshots(partial),
    /catalogo Ticino\.completeness\.status.*complete/,
  );

  const belowFloor = structuredClone(snapshots);
  belowFloor.catalog.catalogues[0].recordCount = EXPECTED_MIN_RECORD_COUNTS.ticino - 1;
  belowFloor.catalog.catalogues[0].completeness.verifiedRecordCount = EXPECTED_MIN_RECORD_COUNTS.ticino - 1;
  assert.throws(
    () => validatePharmacySnapshots(belowFloor),
    /minimumRecordCount|completeness.*soglia/,
  );

  const truncated = structuredClone(snapshots);
  truncated.duty.completeness.truncated = true;
  assert.throws(
    () => validatePharmacySnapshots(truncated),
    /turni snapshot\.completeness\.truncated.*false/,
  );

  const unknownWarning = structuredClone(snapshots);
  unknownWarning.duty.warnings = ['source-partial'];
  assert.throws(
    () => validatePharmacySnapshots(unknownWarning),
    /turni snapshot\.warnings contiene warning non ammessi/,
  );
});

test('pharmacy evergreen: timestamp futuro oltre la tolleranza blocca il producer', () => {
  const snapshots = readFixturePair();
  const nowMs = Date.parse('2026-09-15T09:41:00.000Z');
  const future = structuredClone(snapshots);
  future.catalog.catalogues[0].fetchedAt = new Date(
    nowMs + SNAPSHOT_FUTURE_TOLERANCE_MS + 1,
  ).toISOString();
  assert.throws(
    () => validatePharmacySnapshots(future, { nowMs }),
    /catalogo Ticino\.fetchedAt è nel futuro oltre la tolleranza/,
  );

  const withinTolerance = structuredClone(snapshots);
  withinTolerance.catalog.catalogues[0].fetchedAt = new Date(
    nowMs + SNAPSHOT_FUTURE_TOLERANCE_MS,
  ).toISOString();
  assert.doesNotThrow(
    () => validatePharmacySnapshots(withinTolerance, { nowMs }),
    'un clock skew entro la tolleranza esplicita resta accettabile',
  );
});

test('pharmacy evergreen: il producer usa il registrar condiviso e la sezione senza union P0', () => {
  const source = fs.readFileSync(PRODUCER_PATH, 'utf8');
  assert.match(source, /registerArticleFiles\(guide, \{ skipNews: true \}\)/);
  assert.match(source, /--section=svizzera/);
  assert.match(source, /registerArticleFiles/);
  assert.doesNotMatch(source, /blogArticleIds|BlogArticleId/);
  assert.doesNotMatch(source, /content\/blog-articles-data\.ts/);
  assert.match(source, /acquirePharmacyEvergreenRefresh/);
  assert.match(source, /transaction\.commit\(\)/);
  assert.match(source, /transaction\.rollback\(\)/);
});
