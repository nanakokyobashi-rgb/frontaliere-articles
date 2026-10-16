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
