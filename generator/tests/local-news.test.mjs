/**
 * local-news.test.mjs — what the frontaliere section admits as local news.
 *
 * Owner decision of 2026-09-25: «Fai passare anche queste notizie: cronaca
 * nera, sport, cultura e incidenti stradali», in Ticino and in the provinces
 * of Varese, Como and VCO. The review of PR #1871 asked for the place to be
 * decided deterministically: the anchor gate of the scan also accepts Zurich,
 * Bern and the border comuni of Sondrio and Lecco.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LOCAL_NEWS_PROVINCES,
  countLocalNewsHits,
  hasLocalNewsSignal,
  isInLocalNewsArea,
  isLocalNews,
} from '../scripts/lib/local-news.mjs';

test('local news in Ticino and in the provinces of Varese, Como and VCO', () => {
  for (const text of [
    'Rapina in gioielleria a Chiasso, due arresti',
    'Incidente stradale a Lugano, nessun ferito grave',
    "Hockey, l'HC Lugano vince il derby con l'Ambrì",
    'Ecco i vincitori del Locarno Film Festival 2026',
    'Incidente a Porto Ceresio, strada chiusa per due ore',
    'Furto a Domodossola, fermato un uomo',
    'Mostra al museo di Varese fino a marzo',
    'Incidente in galleria sul Gottardo, coda di 5 km',
  ]) {
    assert.equal(isLocalNews(text), true, `non riconosciuta come cronaca locale: ${text}`);
  }
});

test('the same kinds of news elsewhere are not local', () => {
  for (const text of [
    'Festival a Zurigo, migliaia di visitatori',
    'Arresto a Sondrio per spaccio',
    'Concerto a Lecco sabato sera',
    'Omicidio a Milano, fermato il sospettato',
  ]) {
    assert.equal(isLocalNews(text), false, `presa per cronaca locale: ${text}`);
  }
});

test('Ticino comuni that are also ordinary words do not make a place', () => {
  assert.equal(isInLocalNewsArea('Tenero incontro al festival di Berna'), false);
  assert.equal(isInLocalNewsArea('Paradiso fiscale e omicidio a Roma'), false);
});

test('border comuni count only in the three provinces of the area', () => {
  assert.deepEqual([...LOCAL_NEWS_PROVINCES], ['VA', 'CO', 'VB']);
  assert.equal(isInLocalNewsArea('Festa a Cernobbio'), true); // CO
  assert.equal(isInLocalNewsArea('Festa a Tirano'), false); // SO
});

test('kind and place are both needed, and the hit count is zero outside the area', () => {
  assert.equal(hasLocalNewsSignal('Il Gran Consiglio approva il preventivo a Bellinzona'), false);
  assert.equal(isLocalNews('Il Gran Consiglio approva il preventivo a Bellinzona'), false);
  assert.equal(countLocalNewsHits('Incidente e poi un altro incidente a Zurigo'), 0);
  assert.equal(countLocalNewsHits('Incidente e poi un altro incidente a Lugano'), 2);
});

test('no stem fires inside a common unrelated word', () => {
  assert.equal(hasLocalNewsSignal('Trasporti pubblici: nuovi orari TILO'), false);
  assert.equal(hasLocalNewsSignal('I dati dimostrano una crescita'), false);
});
