/**
 * canton-category-data.test.mjs — regole di degrado dell'aggregatore dei
 * servizi (P9f) e letture del dataset avvisi (P9g), sulle registrazioni dei
 * contratti REWIRE. La FORMA degli artefatti e' inchiodata da
 * rewire-json-contracts.test.mjs; qui si prova cosa ne esce per cantone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANTON_GROUPS,
  MIN_CANTONS_WITH_BLOCK,
  PLATE_AUCTIONS_MAX_AGE_MS,
  WEATHER_MAX_AGE_MS,
  buildCantonServices,
  shapePharmacyDuties,
  shapePlateAuctions,
  shapePremiums,
  shapeWeather,
  unmappedWeatherCities,
  viewThresholdFailures,
} from '../scripts/lib/canton-services-data.mjs';
import { CANTON_GROUP_CODES, cantonNoticesProblem, noticesFor } from '../scripts/lib/canton-notices-data.mjs';
import { contract, freshenRecording } from './lib/rewire-contracts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const recording = (id, nowMs) => {
  const c = contract(id);
  return freshenRecording(c, JSON.parse(fs.readFileSync(path.join(ROOT, c.fixture), 'utf8')), nowMs);
};
const NOW = Date.now();
const HOUR = 3600_000;

test('i gruppi cantonali dei due moduli sono quelli di canton-url-slugs.json', () => {
  const slugs = JSON.parse(fs.readFileSync(path.join(ROOT, 'generator/data/canton-url-slugs.json'), 'utf8'));
  const expected = Object.fromEntries(Object.keys(slugs.cantons).map((code) => [code, slugs.cantonGroups?.[code]?.members ?? [code]]));
  assert.deepEqual(
    Object.fromEntries(Object.entries(CANTON_GROUPS).map(([k, v]) => [k, [...v].sort()])),
    Object.fromEntries(Object.entries(expected).map(([k, v]) => [k, [...v].sort()])),
  );
  assert.deepEqual([...CANTON_GROUP_CODES].sort(), Object.keys(slugs.cantons).sort());
});

test('vista completa dalle quattro registrazioni: premi e aste per tutti, turni e meteo dove esistono', () => {
  const view = buildCantonServices(
    {
      premiums: recording('health-premiums', NOW),
      plateAuctions: recording('plate-auctions', NOW),
      pharmacyDuties: recording('pharmacy-duty-cantons', NOW),
      weather: recording('weather-snapshot', NOW),
    },
    CANTON_GROUPS,
    { nowMs: NOW },
  );
  assert.equal(view.counts.sourcesOk, 4);
  assert.equal(view.counts.byBlock.premiums, 24);
  assert.ok(view.counts.cantonsWithBlock >= MIN_CANTONS_WITH_BLOCK);
  assert.deepEqual(viewThresholdFailures(view), []);
  // BASILEA somma BS e BL; il meteo e' solo dove lo snapshot ha citta' del cantone
  assert.deepEqual(new Set(view.cantons.BASILEA.blocks.premiums.regions.map((r) => r.canton)), new Set(['BS', 'BL']));
  assert.equal(view.cantons.TI.blocks.weather.available, true);
  assert.equal(view.cantons.ZH.blocks.weather.available, false);
  assert.match(view.cantons.ZH.blocks.weather.reason, /nessuna citta'/);
  // turni: i gruppi con fonte ufficiale (TI GE JU BASILEA ZH SO) si', gli altri con il motivo
  assert.equal(view.cantons.GE.blocks.pharmacyDuties.available, true);
  assert.match(view.cantons.GR.blocks.pharmacyDuties.reason, /nessuna fonte ufficiale/);
});

test('premi: base dichiarata e cifre ordinate (min <= mediana <= max), anno vecchio = non disponibile', () => {
  const doc = recording('health-premiums', NOW);
  const block = shapePremiums(doc, ['TI'], { nowMs: NOW });
  assert.equal(block.available, true);
  assert.deepEqual(block.basis, { ageClass: 'ERW', franchiseChf: 300, accident: true, model: 'standard', unit: 'CHF/mese' });
  for (const r of block.regions) assert.ok(r.standardMin <= r.standardMedian && r.standardMedian <= r.standardMax, JSON.stringify(r));
  assert.match(shapePremiums({ ...doc, year: doc.year - 1 }, ['TI'], { nowMs: NOW }).reason, /piu' vecchi/);
  assert.match(shapePremiums(null, ['TI'], { nowMs: NOW }).reason, /non raggiungibile/);
});

test('aste: snapshot fermo oltre 24 h = non disponibile; solo aste non scadute', () => {
  const doc = recording('plate-auctions', NOW);
  const ok = shapePlateAuctions(doc, ['AG'], { nowMs: NOW });
  assert.equal(ok.available, true);
  assert.ok(ok.activeCount > 0);
  const later = shapePlateAuctions(doc, ['AG'], { nowMs: NOW + PLATE_AUCTIONS_MAX_AGE_MS + HOUR });
  assert.match(later.reason, /vecchio/);
});

test('turni: rilascio non fresco o turni gia\' finiti = non disponibile, mai turni scaduti', () => {
  const doc = recording('pharmacy-duty-cantons', NOW);
  const stale = structuredClone(doc);
  stale.cantons.TI.state = 'stale';
  assert.match(shapePharmacyDuties(stale, 'TI', { nowMs: NOW }).reason, /non pubblicabile/);
  const ok = shapePharmacyDuties(doc, 'TI', { nowMs: NOW });
  for (const d of ok.duties ?? []) assert.ok(Date.parse(d.endsAt) > NOW, `turno scaduto pubblicato: ${JSON.stringify(d)}`);
});

test('meteo: snapshot vecchio = non disponibile; una citta\' CH senza cantone viene segnalata, non assegnata', () => {
  const doc = recording('weather-snapshot', NOW);
  assert.match(shapeWeather(doc, ['TI'], { nowMs: NOW + WEATHER_MAX_AGE_MS + HOUR }).reason, /vecchio/);
  const withNew = structuredClone(doc);
  withNew.cities.chur = { cityId: 'chur', current: { temperature: 9 }, daily7: [] };
  assert.deepEqual(unmappedWeatherCities(withNew), ['chur']);
  assert.equal(shapeWeather(withNew, ['GR'], { nowMs: NOW }).available, false);
  // con il campo `canton` dello snapshot la citta' entra nel suo cantone, senza mappa
  withNew.cities.chur.canton = 'GR';
  withNew.cities.chur.name = 'Chur';
  assert.deepEqual(unmappedWeatherCities(withNew), []);
  assert.equal(shapeWeather(withNew, ['GR'], { nowMs: NOW }).cities[0].name, 'Chur');
});

test('soglie della vista: con una sola fonte raggiungibile non si scrive', () => {
  const view = buildCantonServices({ premiums: null, plateAuctions: null, pharmacyDuties: null, weather: recording('weather-snapshot', NOW) }, CANTON_GROUPS, { nowMs: NOW });
  assert.ok(viewThresholdFailures(view).length >= 1);
});

test('avvisi: la registrazione passa il contratto e noticesFor ordina per data con i senza data in coda', () => {
  const doc = recording('canton-notices', NOW);
  assert.equal(cantonNoticesProblem(doc, { nowMs: NOW }), null);
  const canton = doc.notices.find((n) => n.publishedAt === null)?.canton ?? doc.notices[0].canton;
  const list = noticesFor(doc, canton, { limit: 50 });
  assert.ok(list.length > 0);
  const firstNull = list.findIndex((n) => n.publishedAt === null);
  if (firstNull !== -1) assert.ok(list.slice(firstNull).every((n) => n.publishedAt === null));
  const dated = list.filter((n) => n.publishedAt);
  for (let i = 1; i < dated.length; i++) assert.ok(dated[i - 1].publishedAt >= dated[i].publishedAt);
  assert.ok(noticesFor(doc, canton, { category: 'fisco' }).every((n) => n.category === 'fisco'));
});
