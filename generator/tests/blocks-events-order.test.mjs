import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BLOCK_THRESHOLDS, DAY_MS } from '../scripts/lib/canton-hubs/blocks-common.mjs';
import { shapeEventsBlock } from '../scripts/lib/canton-hubs/blocks-events.mjs';

const NOW = Date.parse('2026-10-05T09:00:00.000Z');

test('eventi senza identità: indice sorgente stabile prima del limite righe', () => {
  const tomorrow = new Date(NOW + DAY_MS).toISOString().slice(0, 10);
  const maxRows = BLOCK_THRESHOLDS.events.maxRows;
  const dataset = {
    generatedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    events: Array.from({ length: maxRows + 2 }, (_, sourceIndex) => ({
      title: 'Evento senza identità',
      titleByLocale: { it: `Record sorgente ${sourceIndex}` },
      startDate: tomorrow,
      startTime: '10:00',
      canton: 'TI',
    })),
  };

  const block = shapeEventsBlock(dataset, { canton: 'TI', members: ['TI'], nowMs: NOW });

  assert.equal(block.available, true);
  assert.equal(block.render('it').keyFacts[0].value, String(maxRows + 2));
  assert.deepEqual(
    block.render('it').items.map((item) => item.label),
    Array.from({ length: maxRows }, (_, sourceIndex) => `Record sorgente ${sourceIndex}`),
    'a parità degli altri campi, l’ordine sorgente è il tie-break prima del taglio',
  );
});

test('eventi: ID separa gli omonimi nello stesso luogo e il fallback conserva l’ordine sorgente', () => {
  const tomorrow = new Date(NOW + DAY_MS).toISOString().slice(0, 10);
  const event = (label, extra = {}) => ({
    title: 'Evento condiviso',
    titleByLocale: { it: label },
    startDate: tomorrow,
    startTime: '10:00',
    canton: 'TI',
    ...extra,
  });
  const dataset = {
    generatedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    events: [
      event('source-0'),
      event('source-1'),
      event('id-b', { id: 'event-b', comune: 'Lugano' }),
      event('id-a', { id: 'event-a', comune: 'Lugano' }),
      event('id-a-duplicate', { id: 'event-a', comune: 'Lugano' }),
    ],
  };

  const block = shapeEventsBlock(dataset, { canton: 'TI', members: ['TI'], nowMs: NOW });

  assert.equal(block.available, true);
  assert.equal(block.render('it').keyFacts[0].value, '4', 'l’ID evita la collisione nello stesso luogo, il duplicato con lo stesso ID collassa');
  assert.deepEqual(
    block.render('it').items.map((item) => item.label),
    ['source-0', 'source-1', 'id-a', 'id-b'],
    'i record senza URL, luogo o ID rispettano l’ordine sorgente e gli ID danno un ordine stabile agli omonimi',
  );
});

test('eventi: il fallback per luogo si associa a un solo ID compatibile', () => {
  const tomorrow = new Date(NOW + DAY_MS).toISOString().slice(0, 10);
  const event = (label, extra = {}) => ({
    title: 'Evento condiviso',
    titleByLocale: { it: label },
    startDate: tomorrow,
    startTime: '10:00',
    canton: 'TI',
    ...extra,
  });
  const dataset = (events) => ({
    generatedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    events,
  });
  const shape = (events) => shapeEventsBlock(dataset(events), { canton: 'TI', members: ['TI'], nowMs: NOW });

  const uniqueCandidate = shape([
    event('without-id', { comune: 'Lugano' }),
    event('with-id', { id: 'event-a', comune: 'Lugano' }),
    event('other-a', { id: 'event-b', comune: 'Bellinzona' }),
    event('other-b', { id: 'event-c', comune: 'Locarno' }),
  ]);
  assert.equal(uniqueCandidate.render('it').keyFacts[0].value, '3');

  const ambiguousCandidates = shape([
    event('without-id', { comune: 'Lugano' }),
    event('id-a', { id: 'event-a', comune: 'Lugano' }),
    event('id-b', { id: 'event-b', comune: 'Lugano' }),
    event('other', { id: 'event-c', comune: 'Bellinzona' }),
  ]);
  assert.equal(ambiguousCandidates.render('it').keyFacts[0].value, '4');

  const ambiguousFallbacks = shape([
    event('without-id-a', { comune: 'Lugano' }),
    event('without-id-b', { comune: 'Lugano' }),
    event('id-a', { id: 'event-a', comune: 'Lugano' }),
    event('id-b', { id: 'event-b', comune: 'Lugano' }),
    event('other', { id: 'event-c', comune: 'Bellinzona' }),
  ]);
  assert.equal(ambiguousFallbacks.render('it').keyFacts[0].value, '5');
  assert.deepEqual(
    ambiguousFallbacks.render('it').items.slice(0, 2).map((item) => item.label),
    ['without-id-a', 'without-id-b'],
    'i fallback restano entrambi visibili quando due ID distinti sono compatibili',
  );
});

test('eventi: un orario mancante non associa un fallback a un ID', () => {
  const tomorrow = new Date(NOW + DAY_MS).toISOString().slice(0, 10);
  const event = (title, label, extra = {}) => ({
    title,
    titleByLocale: { it: label },
    startDate: tomorrow,
    startTime: '10:00',
    canton: 'TI',
    ...extra,
  });
  const dataset = {
    generatedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    events: [
      event('Concerto', 'anchor-without-time', { id: 'event-a', comune: 'Lugano', startTime: '' }),
      event('Concerto', 'fallback-with-time', { comune: 'Lugano', startTime: '11:00' }),
      event('Mercato', 'anchor-with-time', { id: 'event-b', comune: 'Bellinzona', startTime: '18:00' }),
      event('Mercato', 'fallback-without-time', { comune: 'Bellinzona', startTime: '' }),
      event('Altro', 'unrelated', { id: 'event-c', comune: 'Locarno', startTime: '20:00' }),
    ],
  };

  const block = shapeEventsBlock(dataset, { canton: 'TI', members: ['TI'], nowMs: NOW });

  assert.equal(block.render('it').keyFacts[0].value, '5');

  const fallbackOnly = shapeEventsBlock({
    ...dataset,
    events: [
      event('Seminario', 'without-time', { comune: 'Locarno', startTime: '' }),
      event('Seminario', 'with-time-a', { comune: 'Locarno', startTime: '20:00' }),
      event('Seminario', 'with-time-b', { comune: 'Locarno', startTime: '20:00' }),
      event('Altro', 'unrelated', { comune: 'Bellinzona', startTime: '16:00' }),
    ],
  }, { canton: 'TI', members: ['TI'], nowMs: NOW });
  assert.equal(fallbackOnly.render('it').keyFacts[0].value, '3');
});

test('eventi: tra URL equivalenti pubblica il deep link con fragment', () => {
  const tomorrow = new Date(NOW + DAY_MS).toISOString().slice(0, 10);
  const event = (label, extra = {}) => ({
    title: 'Evento condiviso',
    titleByLocale: { it: label },
    startDate: tomorrow,
    startTime: '10:00',
    canton: 'TI',
    ...extra,
  });
  const baseUrl = 'https://events.example.org/programma?giorno=2026-10-06';
  const detailUrl = `${baseUrl}#spettacolo-serale`;
  const dataset = {
    generatedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    events: [
      event('base-url', { id: 'event-a', url: baseUrl }),
      event('deep-link', { id: 'event-a', url: detailUrl }),
      event('unrelated-a'),
      event('unrelated-b'),
      event('unrelated-c'),
    ],
  };

  const block = shapeEventsBlock(dataset, { canton: 'TI', members: ['TI'], nowMs: NOW });

  assert.equal(block.render('it').keyFacts[0].value, '4');
  assert.equal(block.render('it').items.find((item) => item.url)?.url, detailUrl);
});
