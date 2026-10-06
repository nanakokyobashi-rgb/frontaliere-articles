import { after, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

const ENV_KEYS = [
  'CODEX_AUTH_BROKER_SOCKET',
  'FREE_TRANSLATE_CODEX_TIER',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GSC_CLIENT_ID',
  'GSC_CLIENT_SECRET',
  'GSC_REFRESH_TOKEN',
  'HF_TOKEN',
  'HUGGINGFACE_API_KEY',
  'LIBRETRANSLATE_SELF_HOSTED_URL',
  'MT_LOCAL_OPUSMT',
];
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
for (const key of ENV_KEYS) delete process.env[key];
process.env.DEEPL_API_KEY = 'structure-test-deepl';
process.env.AZURE_TRANSLATOR_KEY = 'structure-test-azure';
process.env.VITEST = '1';

const {
  freeTranslate,
  getCascadeStats,
  hasTranslatableLineText,
} = await import('../scripts/lib/free-translate.mjs');

const realFetch = globalThis.fetch;
const savedPremiumEnv = {
  DEEPL_API_KEY: process.env.DEEPL_API_KEY,
  AZURE_TRANSLATOR_KEY: process.env.AZURE_TRANSLATOR_KEY,
  VITEST: process.env.VITEST,
};

afterEach(() => {
  globalThis.fetch = realFetch;
});

after(() => {
  globalThis.fetch = realFetch;
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const [key, value] of Object.entries(savedPremiumEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function makeFixture(name, lines, chars) {
  const base = lines.join('\n');
  assert.ok(base.length <= chars, name + ' fixture is longer than its live measurement');
  const text = base + 'x'.repeat(chars - base.length);
  assert.equal(text.length, chars);
  return {
    name,
    text,
    chars,
    lineCount: text.split('\n').length,
    nonEmptyLines: text.split('\n').filter((line) => line !== '').length,
  };
}

const LIVE_FIXTURES = [
  makeFixture('elenco di 4 punti', [
    '- Fatto uno',
    '- Fatto due',
    '- Fatto tre',
    '- Fatto quattro',
  ], 197),
  makeFixture('3 fatti + riga vuota + paragrafo', [
    '- Fatto uno',
    '- Fatto due',
    '- Fatto tre',
    '',
    'Paragrafo breve',
  ], 190),
  makeFixture('prime 12 righe di body1', [
    '## Titolo uno',
    '- Fatto uno',
    '- Fatto due',
    '- Fatto tre',
    '',
    '## Titolo due',
    '- Fatto quattro',
    '- Fatto cinque',
    '- Fatto sei',
    '',
    '- Fatto sette',
    '- Fatto otto',
  ], 488),
  makeFixture('elenco dei fatti', [
    '- Fatto 1',
    '- Fatto 2',
    '- Fatto 3',
    '- Fatto 4',
    '- Fatto 5',
    '- Fatto 6',
    '- Fatto 7',
    '- Fatto 8',
    '- Fatto 9',
  ], 403),
  makeFixture('body1 intero', Array.from({ length: 29 }, (_, index) => (
    new Set([3, 8, 17, 23, 27]).has(index)
      ? ''
      : 'Riga del body con testo tradotto'
  )), 2952),
];

function lineKinds(text) {
  return text.split('\n').map((line) => line === '');
}

function stubPremiumFailure() {
  return (url) => {
    const value = String(url);
    if (value.includes('api-free.deepl.com')) {
      return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
    }
    if (value.includes('api.cognitive.microsofttranslator.com')) {
      return Promise.resolve({ ok: false, status: 503, text: async () => '' });
    }
    return null;
  };
}

function stubMyMemory({ fold = false, failRecovery = false } = {}) {
  const calls = [];
  const premiumFailure = stubPremiumFailure();
  globalThis.fetch = async (url) => {
    const premium = premiumFailure(url);
    if (premium) return premium;
    const value = String(url);
    if (!value.includes('api.mymemory.translated.net')) throw new Error('offline nel test');
    const query = new URL(value).searchParams.get('q') || '';
    calls.push(query);
    if (failRecovery && calls.length > 1) {
      return { ok: true, json: async () => ({ responseData: { translatedText: '', match: 1 } }) };
    }
    const translated = fold && query.includes('\n') ? query.replace(/\n/g, ' ') : query;
    return {
      ok: true,
      json: async () => ({ responseData: { translatedText: 'T ' + translated, match: 1 } }),
    };
  };
  return calls;
}

test('i cinque ingressi live: un motore che conserva le righe resta a una chiamata', async () => {
  for (const fixture of LIVE_FIXTURES) {
    const calls = stubMyMemory();
    const translated = await freeTranslate({
      text: fixture.text,
      sourceLang: 'it',
      targetLang: 'de',
      fieldType: 'description',
    });

    assert.equal(calls.length, 1, fixture.name);
    assert.deepEqual(lineKinds(translated), lineKinds(fixture.text), fixture.name);
  }
});

test('i cinque ingressi live: un motore che fonde recupera per riga entro il tetto', async () => {
  for (const fixture of LIVE_FIXTURES.slice(0, 4)) {
    const calls = stubMyMemory({ fold: true });
    const translated = await freeTranslate({
      text: fixture.text,
      sourceLang: 'it',
      targetLang: 'de',
      fieldType: 'description',
    });

    assert.equal(calls.length, 1 + fixture.nonEmptyLines, fixture.name);
    assert.deepEqual(lineKinds(translated), lineKinds(fixture.text), fixture.name);
  }
});

test('un body oltre il tetto non accetta il testo fuso e conta il motivo dedicato', async () => {
  const fixture = LIVE_FIXTURES[4];
  const calls = stubMyMemory({ fold: true });
  const before = getCascadeStats().tierStructureFailures?.limitExceeded?.myMemory || 0;

  const translated = await freeTranslate({
    text: fixture.text,
    sourceLang: 'it',
    targetLang: 'de',
    fieldType: 'description',
  });

  assert.equal(calls.length, 1);
  assert.equal(translated, '');
  assert.equal(
    (getCascadeStats().tierStructureFailures?.limitExceeded?.myMemory || 0) - before,
    1,
  );
});

test('un recupero fallito fa proseguire la cascata e conta recoveryFailed', async () => {
  const source = [
    '- Prima riga della procedura',
    '- Seconda riga della procedura',
    '',
    'Paragrafo con una spiegazione abbastanza lunga.',
  ].join('\n');
  let deepLCalls = 0;
  let azureCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.includes('api-free.deepl.com')) {
      deepLCalls += 1;
      const text = new URLSearchParams(options.body).get('text') || '';
      if (deepLCalls === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ translations: [{ text: text.replace(/\n/g, ' ') }] }),
        };
      }
      return { ok: false, status: 503, json: async () => ({}) };
    }
    if (value.includes('api.cognitive.microsofttranslator.com')) {
      azureCalls += 1;
      const text = JSON.parse(options.body)[0].Text;
      return {
        ok: true,
        status: 200,
        json: async () => [{ translations: [{ text: 'AZURE ' + text }] }],
      };
    }
    throw new Error('offline nel test');
  };

  const beforeFailure = getCascadeStats().tierStructureFailures?.recoveryFailed?.deepl || 0;
  const beforeAzureHit = getCascadeStats().tierHits.azure || 0;
  const translated = await freeTranslate({
    text: source,
    sourceLang: 'it',
    targetLang: 'de',
    fieldType: 'description',
  });

  assert.equal(deepLCalls, 2);
  assert.equal(azureCalls, 1);
  assert.match(translated, /^AZURE /);
  assert.deepEqual(lineKinds(translated), lineKinds(source));
  assert.equal(
    (getCascadeStats().tierStructureFailures?.recoveryFailed?.deepl || 0) - beforeFailure,
    1,
  );
  assert.equal((getCascadeStats().tierHits.azure || 0) - beforeAzureHit, 1);
});

test('una sorgente a riga singola non paga chiamate di recupero', async () => {
  const source = 'Titolo breve della procedura';
  const calls = stubMyMemory({ fold: true });
  const translated = await freeTranslate({
    text: source,
    sourceLang: 'it',
    targetLang: 'de',
    fieldType: 'title',
  });

  assert.equal(calls.length, 1);
  assert.equal(translated, 'T ' + source);
});

test('hasTranslatableLineText conserva le righe brevi o prive di lettere', async () => {
  for (const [line, expected] of [
    ['OK', false],
    ['IT', false],
    ['—', false],
    ['1.', false],
    ['!!!', false],
    ['12345', false],
    ['Una riga traducibile', true],
  ]) {
    assert.equal(hasTranslatableLineText(line), expected, line);
  }

  const source = [
    'OK',
    'IT',
    '—',
    '1.',
    '12345',
    'Questa riga contiene testo traducibile e resta nel campo.',
    'x'.repeat(5000),
  ].join('\n');
  const calls = stubMyMemory();
  const translated = await freeTranslate({
    text: source,
    sourceLang: 'it',
    targetLang: 'de',
    fieldType: 'description',
  });

  assert.notEqual(translated, '');
  assert.deepEqual(lineKinds(translated), lineKinds(source));
  assert.equal(calls.some((query) => ['OK', 'IT', '—', '1.', '12345'].includes(query)), false);
});
