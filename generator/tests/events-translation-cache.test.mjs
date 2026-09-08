import { test } from 'node:test';
import assert from 'node:assert/strict';

import { enrichEventsWithLocaleFallbackTranslations } from '../scripts/lib/events-utils.mjs';

const SAME_TITLE = 'Locarno Film Festival';

function event(id, title = SAME_TITLE) {
  return { id, titleByLocale: { it: title } };
}

test('deduplica eventi con lo stesso testo e riusa la cache nel secondo giro', async () => {
  let calls = 0;
  const cache = {};
  const translateFn = async () => `traduzione-${++calls}`;

  const first = await enrichEventsWithLocaleFallbackTranslations(
    [event('guidle:one'), event('guidle:two')],
    cache,
    { locales: ['it', 'en'], delayMs: 0, translateFn },
  );

  assert.equal(calls, 1, 'la traduzione pura va condivisa per testo, non ripetuta per evento');
  assert.equal(first[0].titleByLocale.en, 'traduzione-1');
  assert.equal(first[1].titleByLocale.en, 'traduzione-1');
  assert.deepEqual(Object.keys(cache).map((key) => JSON.parse(key)), [
    ['title', 'it', 'locarno film festival'],
  ]);

  const secondTranslateFn = async () => { throw new Error('il secondo giro deve usare la cache'); };
  const second = await enrichEventsWithLocaleFallbackTranslations(
    [event('guidle:one'), event('guidle:two')],
    cache,
    { locales: ['it', 'en'], delayMs: 0, translateFn: secondTranslateFn },
  );

  assert.equal(second[0].titleByLocale.en, 'traduzione-1');
  assert.equal(second[1].titleByLocale.en, 'traduzione-1');
});

test('ignora il marker legacy senza riscrivere la vecchia cache condivisa', async () => {
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

  assert.equal(calls, 1, 'la chiave legacy non deve impedire il dedup della traduzione pura');
  assert.equal(out[0].titleByLocale.en, 'traduzione-migrata-1');
  assert.equal(out[1].titleByLocale.en, 'traduzione-migrata-1');
  assert.deepEqual(cache['title::it::locarno film festival'], { en: 'Null' }, 'la chiave legacy morta resta intatta');
});

test('condivide il testo anche senza identità stabile dell’evento', async () => {
  let calls = 0;
  const cache = {};
  const events = [
    { titleByLocale: { it: SAME_TITLE } },
    { titleByLocale: { it: SAME_TITLE } },
  ];

  const out = await enrichEventsWithLocaleFallbackTranslations(events, cache, {
    locales: ['it', 'en'],
    delayMs: 0,
    translateFn: async () => `traduzione-${++calls}`,
  });

  assert.equal(calls, 1);
  assert.equal(out[0].titleByLocale.en, 'traduzione-1');
  assert.equal(out[1].titleByLocale.en, 'traduzione-1');
  assert.deepEqual(cache, { '["title","it","locarno film festival"]': { en: 'traduzione-1' } });
});

test('non usa sourceKey o url come identità quando il testo è uguale', async () => {
  let calls = 0;
  const cache = {};
  const events = [
    { sourceKey: 'guidle', url: 'https://events.test/one', titleByLocale: { it: SAME_TITLE } },
    { sourceKey: 'guidle', url: 'https://events.test/two', titleByLocale: { it: SAME_TITLE } },
  ];

  const out = await enrichEventsWithLocaleFallbackTranslations(events, cache, {
    locales: ['it', 'en'],
    delayMs: 0,
    translateFn: async () => `traduzione-${++calls}`,
  });

  assert.equal(calls, 1, 'sourceKey e url non devono disattivare il dedup della traduzione pura');
  assert.equal(out[0].titleByLocale.en, 'traduzione-1');
  assert.equal(out[1].titleByLocale.en, 'traduzione-1');
  assert.deepEqual(cache, { '["title","it","locarno film festival"]': { en: 'traduzione-1' } });
});

test('mantiene il memo negativo per evento senza perdere il dedup positivo', async () => {
  let calls = 0;
  const cache = {};
  const events = [
    { sourceKey: 'guidle', url: 'https://events.test/one', titleByLocale: { it: SAME_TITLE } },
    { sourceKey: 'guidle', url: 'https://events.test/two', titleByLocale: { it: SAME_TITLE } },
  ];

  const out = await enrichEventsWithLocaleFallbackTranslations(events, cache, {
    locales: ['it', 'en'],
    delayMs: 0,
    translateFn: async () => { calls += 1; return { text: '', passthrough: true }; },
  });

  assert.deepEqual(out.map((event) => event.titleByLocale), [{ it: SAME_TITLE }, { it: SAME_TITLE }]);
  assert.equal(calls, 2, 'un passthrough negativo descrive il singolo evento');
  assert.deepEqual(Object.keys(cache).map((key) => JSON.parse(key)).sort((a, b) => a[1].localeCompare(b[1])), [
    ['title', 'url:https://events.test/one', 'it', 'locarno film festival'],
    ['title', 'url:https://events.test/two', 'it', 'locarno film festival'],
  ]);
});

test('memoizza un passthrough esplicito senza pubblicare la sorgente nel target', async () => {
  const cache = {};
  const out = await enrichEventsWithLocaleFallbackTranslations(
    [{ id: 'guidle:identical', titleByLocale: { it: SAME_TITLE, en: SAME_TITLE } }],
    cache,
    {
      delayMs: 0,
      translateFn: async ({ targetLang }) => {
        if (targetLang === 'en') return { text: '', passthrough: true };
        return `traduzione-${targetLang}`;
      },
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

test('un duplicato successivo riusa il memo positivo invece di ripubblicare la sorgente', async () => {
  const cache = {};
  const first = await enrichEventsWithLocaleFallbackTranslations(
    [event('guidle:stable')],
    cache,
    {
      delayMs: 0,
      translateFn: async ({ targetLang }) => `traduzione-${targetLang}`,
    },
  );

  assert.equal(first[0].titleByLocale.en, 'traduzione-en');
  let secondCalls = 0;
  const second = await enrichEventsWithLocaleFallbackTranslations(
    [{ id: 'guidle:stable', titleByLocale: { it: SAME_TITLE, en: SAME_TITLE } }],
    cache,
    {
      delayMs: 0,
      translateFn: async () => {
        secondCalls += 1;
        return { text: '', passthrough: true };
      },
    },
  );

  assert.equal(second[0].titleByLocale.en, 'traduzione-en');
  assert.equal(secondCalls, 0, 'il memo positivo evita di ripagare la cascata quando il feed duplica la sorgente');
  assert.equal(Object.values(cache)[0].en, 'traduzione-en');
});

test('con soli due locali il duplicato resta sul percorso di traduzione', async () => {
  let calls = 0;
  const out = await enrichEventsWithLocaleFallbackTranslations(
    [{ id: 'guidle:two-locales', titleByLocale: { it: SAME_TITLE, en: SAME_TITLE } }],
    {},
    {
      locales: ['it', 'en'],
      delayMs: 0,
      translateFn: async ({ targetLang }) => { calls += 1; return `traduzione-${targetLang}`; },
    },
  );

  assert.equal(calls, 1);
  assert.equal(out[0].titleByLocale.en, 'traduzione-en');
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

test('non pubblica il testo sorgente quando il translator segnala passthrough esplicito', async () => {
  const cache = {};
  const out = await enrichEventsWithLocaleFallbackTranslations(
    [event('guidle:explicit-source')],
    cache,
    {
      locales: ['it', 'en'],
      delayMs: 0,
      translateFn: async ({ text }) => ({ text, passthrough: true }),
    },
  );

  assert.deepEqual(out[0].titleByLocale, { it: SAME_TITLE });
  assert.equal(cache['["title","id:guidle:explicit-source","it","locarno film festival"]'].en, null);
});
