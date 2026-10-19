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
});
