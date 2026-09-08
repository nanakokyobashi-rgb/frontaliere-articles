import { test } from 'node:test';
import assert from 'node:assert/strict';

import { enrichEventsWithLocaleFallbackTranslations } from '../scripts/lib/events-utils.mjs';

const SAME_TITLE = 'Locarno Film Festival';

function event(id, title = SAME_TITLE) {
  return { id, titleByLocale: { it: title } };
}

test('separa nel keyspace due eventi distinti con lo stesso titolo e riusa ciascun risultato al secondo giro', async () => {
  let calls = 0;
  const cache = {};
  const translateFn = async () => `traduzione-${++calls}`;

  const first = await enrichEventsWithLocaleFallbackTranslations(
    [event('guidle:one'), event('guidle:two')],
    cache,
    { locales: ['it', 'en'], delayMs: 0, translateFn },
  );

  assert.equal(calls, 2);
  assert.equal(first[0].titleByLocale.en, 'traduzione-1');
  assert.equal(first[1].titleByLocale.en, 'traduzione-2');
  assert.equal(Object.keys(cache).length, 2);
  assert.deepEqual(
    Object.keys(cache).map((key) => JSON.parse(key)[1]).sort(),
    ['id:guidle:one', 'id:guidle:two'],
  );

  const secondTranslateFn = async () => { throw new Error('il secondo giro deve usare la cache'); };
  const second = await enrichEventsWithLocaleFallbackTranslations(
    [event('guidle:one'), event('guidle:two')],
    cache,
    { locales: ['it', 'en'], delayMs: 0, translateFn: secondTranslateFn },
  );

  assert.equal(second[0].titleByLocale.en, 'traduzione-1');
  assert.equal(second[1].titleByLocale.en, 'traduzione-2');
});

test('un marker nella vecchia cache non riunisce eventi omonimi durante la migrazione', async () => {
  let calls = 0;
  const cache = { 'title::it::locarno film festival': { en: 'Null' } };
  const out = await enrichEventsWithLocaleFallbackTranslations(
    [event('guidle:one'), event('guidle:two')],
    cache,
    {
      locales: ['it', 'en'],
      delayMs: 0,
      translateFn: async () => `traduzione-migrata-${++calls}`,
    },
  );

  assert.equal(calls, 2, 'il marker legacy non è una traduzione condivisibile');
  assert.equal(out[0].titleByLocale.en, 'traduzione-migrata-1');
  assert.equal(out[1].titleByLocale.en, 'traduzione-migrata-2');
  assert.equal(cache['title::it::locarno film festival'].en, 'traduzione-migrata-1');
});

test('memoizza un titolo già identico nel locale target senza chiamare la cascata', async () => {
  const cache = {};
  const out = await enrichEventsWithLocaleFallbackTranslations(
    [{ id: 'guidle:identical', titleByLocale: { it: SAME_TITLE, en: SAME_TITLE } }],
    cache,
    {
      locales: ['it', 'en'],
      delayMs: 0,
      translateFn: async () => { throw new Error('un’identità già presente non va ritradotta'); },
    },
  );

  assert.equal(out[0].titleByLocale.en, SAME_TITLE);
  assert.equal(Object.values(cache)[0].en, null);
});

test('non congela un duplicato del feed copiato in tutti i locali', async () => {
  let calls = 0;
  const out = await enrichEventsWithLocaleFallbackTranslations(
    [{
      id: 'guidle:duplicated-feed',
      titleByLocale: { it: SAME_TITLE, en: SAME_TITLE, de: SAME_TITLE, fr: SAME_TITLE },
    }],
    {},
    {
      locales: ['it', 'en', 'de', 'fr'],
      delayMs: 0,
      translateFn: async ({ targetLang }) => `traduzione-${targetLang}-${++calls}`,
    },
  );

  assert.equal(calls, 3);
  assert.match(out[0].titleByLocale.de, /^traduzione-de-/);
  assert.match(out[0].titleByLocale.fr, /^traduzione-fr-/);
});

test('memoizza il passthrough legittimo del titolo e non ripaga la cascata al secondo giro', async () => {
  const cache = {};
  const first = await enrichEventsWithLocaleFallbackTranslations(
    [event('myswitzerland:locarno')],
    cache,
    {
      locales: ['it', 'en'],
      delayMs: 0,
      translateFn: async () => ({ text: '', passthrough: true }),
    },
  );

  assert.deepEqual(first[0].titleByLocale, { it: SAME_TITLE });
  assert.equal(Object.values(cache)[0].en, null);

  const second = await enrichEventsWithLocaleFallbackTranslations(
    [event('myswitzerland:locarno')],
    cache,
    { locales: ['it', 'en'], delayMs: 0, translateFn: async () => { throw new Error('cache miss'); } },
  );

  assert.deepEqual(second[0].titleByLocale, { it: SAME_TITLE });
});

test('non memoizza un vuoto che non è un passthrough, così il secondo giro può recuperare', async () => {
  const cache = {};
  const first = await enrichEventsWithLocaleFallbackTranslations(
    [event('guidle:transient')],
    cache,
    {
      locales: ['it', 'en'],
      delayMs: 0,
      translateFn: async () => ({ text: '', passthrough: false }),
    },
  );

  assert.deepEqual(first[0].titleByLocale, { it: SAME_TITLE });
  assert.deepEqual(cache, {});

  const second = await enrichEventsWithLocaleFallbackTranslations(
    [event('guidle:transient')],
    cache,
    { locales: ['it', 'en'], delayMs: 0, translateFn: async () => 'Festival del cinema di Locarno' },
  );

  assert.equal(second[0].titleByLocale.en, 'Festival del cinema di Locarno');
});

test('non memoizza il passthrough di un testo lungo, dove potrebbe essere un eco parziale del ramo a chunk', async () => {
  const longTitle = Array.from({ length: 33 }, (_, index) => `parola${index}`).join(' ');
  const cache = {};

  const out = await enrichEventsWithLocaleFallbackTranslations(
    [event('guidle:long', longTitle)],
    cache,
    {
      locales: ['it', 'en'],
      delayMs: 0,
      translateFn: async () => ({ text: '', passthrough: true }),
    },
  );

  assert.deepEqual(out[0].titleByLocale, { it: longTitle });
  assert.deepEqual(cache, {});
});
