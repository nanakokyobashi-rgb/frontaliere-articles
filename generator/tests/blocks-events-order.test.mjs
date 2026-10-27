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

test('eventi: orari mancanti e fallback privi di identità non fondono record distinti', () => {
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
  assert.equal(fallbackOnly.render('it').keyFacts[0].value, '4');
});

test('eventi: un fallback non si associa a un ID con orari discordanti fra luoghi', () => {
  const tomorrow = new Date(NOW + DAY_MS).toISOString().slice(0, 10);
  const event = (label, title, extra = {}) => ({
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
      event('anchor-10', 'Evento condiviso', { id: 'shared-event', comune: 'Lugano', startTime: '10:00' }),
      event('anchor-11', 'Evento condiviso', { id: 'shared-event', comune: 'Bellinzona', startTime: '11:00' }),
      event('fallback-10', 'Evento condiviso', { comune: 'Lugano', startTime: '10:00' }),
      event('control-a', 'Evento di controllo A', { id: 'control-a', comune: 'Bellinzona' }),
      event('control-b', 'Evento di controllo B', { id: 'control-b', comune: 'Locarno' }),
    ],
  };

  const block = shapeEventsBlock(dataset, { canton: 'TI', members: ['TI'], nowMs: NOW });

  assert.equal(block.render('it').keyFacts[0].value, '4');
  assert.ok(block.render('it').items.some((item) => item.label === 'fallback-10'));
});

test('eventi: valori startTime non-stringa o malformati non provano una corrispondenza', () => {
  const tomorrow = new Date(NOW + DAY_MS).toISOString().slice(0, 10);
  const event = (label, title, extra = {}) => ({
    title,
    titleByLocale: { it: label },
    startDate: tomorrow,
    startTime: '10:00',
    canton: 'TI',
    comune: 'Lugano',
    ...extra,
  });
  const invalidTimes = [false, 0, {}, '25:00'];
  const events = invalidTimes.flatMap((startTime, index) => [
    event(`anchor-${index}`, `Evento malformato ${index}`, { id: `event-${index}`, startTime }),
    event(`fallback-${index}`, `Evento malformato ${index}`, { startTime }),
  ]);
  events.push(event('control', 'Evento di controllo', { id: 'control-event' }));
  const dataset = {
    generatedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    events,
  };

  const block = shapeEventsBlock(dataset, { canton: 'TI', members: ['TI'], nowMs: NOW });

  assert.equal(block.render('it').keyFacts[0].value, '9');
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

test('eventi: il rendering usa il fallback live per un dettaglio sorgente scaduto', () => {
  const tomorrow = new Date(NOW + DAY_MS).toISOString().slice(0, 10);
  const staleUrl = 'https://www.nw.ch/anlaesseaktuelles/94120';
  const dataset = {
    generatedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    events: [
      {
        id: 'nw-agenda:94120',
        sourceKey: 'nw-agenda',
        title: 'Alplertanz',
        titleByLocale: { it: 'Alplertanz' },
        startDate: tomorrow,
        startTime: '10:00',
        canton: 'NW',
        url: staleUrl,
      },
      {
        id: 'nw-agenda:control',
        title: 'Evento di controllo',
        titleByLocale: { it: 'Evento di controllo' },
        startDate: tomorrow,
        startTime: '11:00',
        canton: 'NW',
        url: 'https://events.example.org/control',
      },
      {
        id: 'nw-agenda:control-2',
        title: 'Secondo controllo',
        titleByLocale: { it: 'Secondo controllo' },
        startDate: tomorrow,
        startTime: '12:00',
        canton: 'NW',
        url: 'https://events.example.org/control-2',
      },
    ],
  };

  const block = shapeEventsBlock(dataset, { canton: 'NW', members: ['NW'], nowMs: NOW });

  assert.equal(block.render('it').items[0].url, 'https://www.nw.ch/');
  assert.notEqual(block.render('it').items[0].url, staleUrl);
});

test('eventi: URL equivalenti con query riordinata collassano nello stesso anchor', () => {
  const tomorrow = new Date(NOW + DAY_MS).toISOString().slice(0, 10);
  const event = (label, extra = {}) => ({
    title: 'Evento condiviso',
    titleByLocale: { it: label },
    startDate: tomorrow,
    startTime: '10:00',
    canton: 'TI',
    ...extra,
  });
  const firstUrl = 'https://events.example.org/programma?utm_source=calendar&giorno=2026-10-06';
  const reorderedUrl = 'https://events.example.org/programma?giorno=2026-10-06&utm_source=calendar';
  const dataset = {
    generatedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    events: [
      event('first-query-order', { url: firstUrl }),
      event('reordered-query', { url: reorderedUrl }),
      event('unrelated-a'),
      event('unrelated-b'),
    ],
  };

  const block = shapeEventsBlock(dataset, { canton: 'TI', members: ['TI'], nowMs: NOW });

  assert.equal(block.render('it').keyFacts[0].value, '3');
  assert.equal(block.render('it').items.find((item) => item.url)?.url, firstUrl);
});

test('eventi: un URL con percent-encoding malformato resta un anchor distinto', () => {
  const tomorrow = new Date(NOW + DAY_MS).toISOString().slice(0, 10);
  const event = (label, url, extra = {}) => ({
    title: 'Evento omonimo',
    titleByLocale: { it: label },
    startDate: tomorrow,
    startTime: '10:00',
    canton: 'TI',
    comune: 'Lugano',
    url,
    ...extra,
  });
  const malformedDeepLink = 'https://events.example.org/event/%E0%A4%A#dettaglio';
  const otherUrl = 'https://events.example.org/event/other';
  const dataset = {
    generatedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    events: [
      event('malformed-url', 'https://events.example.org/event/%E0%A4%A'),
      event('malformed-deep-link', malformedDeepLink),
      event('other-url', otherUrl),
      event('control-a', 'https://events.example.org/event/control-a', { title: 'Evento A' }),
      event('control-b', 'https://events.example.org/event/control-b', { title: 'Evento B' }),
    ],
  };

  const block = shapeEventsBlock(dataset, { canton: 'TI', members: ['TI'], nowMs: NOW });

  const items = block.render('it').items;
  assert.equal(block.render('it').keyFacts[0].value, '4');
  assert.equal(items.find((item) => item.label === 'malformed-deep-link')?.url, malformedDeepLink);
  assert.equal(items.find((item) => item.label === 'other-url')?.url, otherUrl);
});

test('eventi: riordina i gruppi secondo il record rappresentativo scelto', () => {
  const yesterday = new Date(NOW - DAY_MS).toISOString().slice(0, 10);
  const twoDaysAgo = new Date(NOW - 2 * DAY_MS).toISOString().slice(0, 10);
  const tomorrow = new Date(NOW + DAY_MS).toISOString().slice(0, 10);
  const event = (label, title, startDate, extra = {}) => ({
    title,
    titleByLocale: { it: label },
    startDate,
    endDate: tomorrow,
    startTime: '10:00',
    canton: 'TI',
    comune: title === 'Evento condiviso' ? 'Lugano' : 'Bellinzona',
    ...extra,
  });
  const dataset = {
    generatedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    events: [
      event('alias-ordinario', 'Evento condiviso', yesterday, { id: 'shared-event' }),
      event('indipendente', 'Evento indipendente', yesterday, { id: 'other-event', startTime: '11:00' }),
      event('alias-deep-link', 'Evento condiviso', twoDaysAgo, {
        id: 'shared-event',
        url: 'https://events.example.org/event/shared#dettaglio',
        startTime: '08:00',
      }),
      event('controllo-futuro', 'Evento di controllo', tomorrow, { id: 'future-event' }),
    ],
  };

  const block = shapeEventsBlock(dataset, { canton: 'TI', members: ['TI'], nowMs: NOW });

  assert.deepEqual(
    block.render('it').items.slice(0, 2).map((item) => item.label),
    ['indipendente', 'alias-deep-link'],
  );
});

test('eventi: il deep link prevale anche tra alias ID con URL canoniche diverse', () => {
  const tomorrow = new Date(NOW + DAY_MS).toISOString().slice(0, 10);
  const event = (label, extra = {}) => ({
    title: 'Evento condiviso',
    titleByLocale: { it: label },
    startDate: tomorrow,
    startTime: '10:00',
    canton: 'TI',
    id: 'event-shared',
    ...extra,
  });
  const deepLink = 'https://agenda.example.net/evento#spettacolo';
  const dataset = {
    generatedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    events: [
      event('plain-alias', { url: 'https://events.example.org/programme' }),
      event('deep-link-alias', { url: deepLink }),
      event('control-a', { id: 'event-a', title: 'Evento A' }),
      event('control-b', { id: 'event-b', title: 'Evento B' }),
    ],
  };

  const block = shapeEventsBlock(dataset, { canton: 'TI', members: ['TI'], nowMs: NOW });

  assert.equal(block.render('it').items.find((item) => item.url)?.url, deepLink);
});

test('eventi: non pubblica URL con credenziali né le preferisce per il fragment', () => {
  const tomorrow = new Date(NOW + DAY_MS).toISOString().slice(0, 10);
  const event = (label, extra = {}) => ({
    title: 'Evento condiviso',
    titleByLocale: { it: label },
    startDate: tomorrow,
    startTime: '10:00',
    canton: 'TI',
    ...extra,
  });
  const cleanUrl = 'https://events.example.org/event/shared';
  const dataset = {
    generatedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    events: [
      event('unlinked-alias', { id: 'event-fragment' }),
      event('credential-fragment-alias', {
        id: 'event-fragment',
        url: 'https://user:pass@events.example.org/event/private#fragment',
      }),
      event('clean-alias', { id: 'event-clean', url: cleanUrl }),
      event('credential-alias', {
        id: 'event-clean',
        url: 'https://user:pass@events.example.org/event/shared#private',
      }),
      event('credential-only', {
        title: 'Evento con URL privata',
        id: 'event-private',
        url: 'https://user:pass@events.example.org/event/private#private',
      }),
      event('control', { id: 'event-control', title: 'Evento di controllo' }),
    ],
  };

  const block = shapeEventsBlock(dataset, { canton: 'TI', members: ['TI'], nowMs: NOW });
  const items = block.render('it').items;

  const cleanAlias = items.find((item) => item.label === 'clean-alias');
  const unlinkedAlias = items.find((item) => item.label === 'unlinked-alias');
  const credentialOnly = items.find((item) => item.label === 'credential-only');
  assert.ok(cleanAlias);
  assert.equal(cleanAlias.url, cleanUrl);
  assert.ok(unlinkedAlias);
  assert.equal(unlinkedAlias.url, undefined);
  assert.ok(credentialOnly);
  assert.equal(credentialOnly.url, undefined);
});
