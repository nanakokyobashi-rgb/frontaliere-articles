/**
 * local-news.test.mjs — what the frontaliere section admits as local news.
 *
 * Owner decision of 2026-09-25: «Fai passare anche queste notizie: cronaca
 * nera, sport, cultura e incidenti stradali», in Ticino and in the provinces
 * of Varese, Como and VCO. The reviews of PR #1871 asked for the place to be
 * decided from a complete geographic source, filtered by canton and province
 * (the anchor gate of the scan also accepts Zurich, Bern and the border comuni
 * of Sondrio and Lecco), and for the kind to be matched on word boundaries.
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
    'Scontro fra due auto a Cantello: un incidente senza feriti',
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
    'Festa a Tirano, concerto in piazza',
  ]) {
    assert.equal(isLocalNews(text), false, `presa per cronaca locale: ${text}`);
  }
});

test('every Ticino comune and locality counts, from the BFS list', () => {
  // Localities that are not comuni of their own (aliases of the BFS list).
  assert.equal(isInLocalNewsArea('Furto in un negozio di Pregassona'), true);
  assert.equal(isInLocalNewsArea('Incendio in un capannone a Giubiasco'), true);
  // Two-part names: the whole and each part.
  assert.equal(isInLocalNewsArea('Sagra di Tenero-Contra'), true);
});

test('Ticino comuni that are also ordinary words count only after a locative', () => {
  assert.equal(isLocalNews('Incidente a Paradiso, strada chiusa'), true);
  assert.equal(isLocalNews('Concerto di Tenero in piazza'), true);
  assert.equal(isLocalNews('Rissa a Vaglio, due feriti'), true);
  assert.equal(isInLocalNewsArea('Tenero incontro al festival di Berna'), false);
  assert.equal(isInLocalNewsArea('Paradiso fiscale e omicidio a Roma'), false);
  assert.equal(isInLocalNewsArea('Al vaglio degli inquirenti un omicidio a Roma'), false);
  assert.equal(isLocalNews('Furto a Vira, fermato un uomo'), true);
  assert.equal(isInLocalNewsArea('Il governo vira sul salario minimo'), false);
  // Followed by another capitalised word, it is a different place.
  assert.equal(isInLocalNewsArea('Rapina a Sessa Aurunca'), false);
  assert.equal(isInLocalNewsArea('Incidente a Torricella Peligna'), false);
});

test('localities named by a common noun count only in their full form', () => {
  assert.equal(isInLocalNewsArea('Concerto a Locarno Monti'), true);
  assert.equal(isInLocalNewsArea('Sagra di paese in un borgo dei monti'), false);
});

test('places outside the area that contain a Ticino name do not count', () => {
  assert.equal(isInLocalNewsArea('Incidente a Castel San Pietro Terme'), false);
  assert.equal(isInLocalNewsArea('Incidente a Castel San Pietro'), true);
});

test('names that span the border of the area do not place a text', () => {
  // Lago Maggiore also touches Novara, the Lario Lecco, the Gottardo Uri,
  // San Bernardino is in Graubünden.
  for (const text of [
    'Incidente in galleria sul Gottardo, coda di 5 km',
    'Festival ad Arona sul Lago Maggiore',
    'Incidente sul Lario, chiusa la statale',
    'Incidente al San Bernardino, passo chiuso',
    'Rapina a Berna, fermati due uomini',
  ]) {
    assert.equal(isLocalNews(text), false, `presa per cronaca locale: ${text}`);
  }
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

test('a stem fires only at the start of a word', () => {
  for (const text of [
    'Trasporti pubblici: nuovi orari TILO',
    'I dati dimostrano una crescita',
    'Nuovo sportello per i frontalieri a Chiasso',
    'Concertazione sociale sul salario minimo a Lugano',
    'Una società multiculturale e plurilingue',
  ]) {
    assert.equal(hasLocalNewsSignal(text), false, `segnale dentro una parola: ${text}`);
  }
  assert.equal(hasLocalNewsSignal('Arrestato a Mendrisio'), true);
  assert.equal(hasLocalNewsSignal('Due squadre sportive a Lugano'), true);
});

test('ordinary economic words are not signals', () => {
  // investito (invested), rassegna stampa, esposizione al rischio, mostra (verb).
  for (const text of [
    "L'azienda ha investito 10 milioni a Lugano",
    'Rassegna stampa del Ticino',
    "Esposizione al rischio di cambio per chi lavora a Chiasso",
    "Il sondaggio mostra che i salari a Lugano crescono",
  ]) {
    assert.equal(isLocalNews(text), false, `presa per cronaca locale: ${text}`);
  }
});

test('kind and place must describe the same event', () => {
  // Third review of PR #1871: two independent scans of the whole text let an
  // arrest in Milan through on an incidental mention of Ticino.
  for (const text of [
    'Arresto a Milano, ricercato anche in Ticino',
    'Arresto a Milano. Il Ticino rafforza i controlli alla frontiera.',
    'La polizia ticinese ha arrestato un uomo a Milano',
    'Omicidio a Milano https://www.rsi.ch/news/ticino/omicidio-lugano-123',
    'Cronaca: omicidio a Milano',
  ]) {
    assert.equal(isLocalNews(text), false, `presa per cronaca locale: ${text}`);
  }
  assert.equal(countLocalNewsHits('Rapina a Lugano. Rapina a Milano.'), 1);
});

test('the place of the event: after a preposition, as a dateline, or the area in the same sentence', () => {
  for (const text of [
    'Lugano, rapina in banca',
    'Chiasso: due arresti per spaccio',
    'Incidente sulla A2 a Bellinzona', // a road is not a place
    'Concerto di Natale a Lugano', // nor is a feast day
    'Il Festival del film di Locarno apre con un record',
    'Rapina nel Luganese, due arresti', // after a preposition the adjective is a region
  ]) {
    assert.equal(isLocalNews(text), true, `non riconosciuta come cronaca locale: ${text}`);
  }
});

test('sport is placed by the club, not by the venue', () => {
  assert.equal(isLocalNews('Calcio, il Lugano pareggia a Basilea'), true);
  assert.equal(isLocalNews("Hockey: l'Ambrì vince a Zurigo"), true);
  assert.equal(isLocalNews('Calcio: il Basilea batte lo Young Boys a Berna'), false);
  // A demonym is a person, not a club.
  assert.equal(isLocalNews('Il tennista ticinese vince a Parigi'), false);
});

test('a demonym or a river does not place the event', () => {
  // Fourth review of PR #1871: with no place in the sentence, «ticinese» or
  // the river Ticino used to be enough.
  for (const text of [
    'Un ticinese arrestato',
    'La polizia ticinese ha arrestato due uomini',
    'Incidente sul fiume Ticino',
    'Incidente sul Ticino a Pavia',
  ]) {
    assert.equal(isLocalNews(text), false, `presa per cronaca locale: ${text}`);
  }
  assert.equal(isLocalNews('Incidente in Ticino, due feriti'), true);
});

test('the place of the event decides over the organiser or the owner', () => {
  // Fifth review of PR #1871: the nearest place was the organiser's.
  assert.equal(isLocalNews('Festival del Comune di Lugano a Zurigo'), false);
  assert.equal(isLocalNews('Arrestato un uomo fuggito da Chiasso a Milano'), false);
  // With no place of the event, the genitive place is where it happens.
  assert.equal(isLocalNews('Il Festival del film di Locarno apre con un record'), true);
  assert.equal(isLocalNews('Rapina in una gioielleria di Lugano, due arresti'), true);
  // A multi-word place with an article inside it.
  assert.equal(isLocalNews('Concerto al Palazzo dei Congressi di Lugano'), true);
});

test('the word «sport» counts, «sportello» does not', () => {
  assert.equal(hasLocalNewsSignal('Sport a Lugano'), true);
  assert.equal(isLocalNews('Sport a Lugano: il Lugano chiude la stagione'), true);
  assert.equal(hasLocalNewsSignal('Nuovo sportello a Chiasso'), false);
});
