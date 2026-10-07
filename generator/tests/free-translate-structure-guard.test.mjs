import { after, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { maskProtectedTokens, restoreProtectedTokens } from '../scripts/lib/translation-glossary.mjs';

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
  hasSameLineStructure,
  lineStructuralSignature,
  normalizeStructuredBlock,
  numericDriftTokens,
  opaqueSpanSignature,
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

function translatePreservingLineMarker(line, prefix) {
  const match = String(line).match(/^(\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+))(.*)$/u);
  return match ? `${match[1]}${prefix}${match[2]}` : `${prefix}${line}`;
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
    const translated = fold && query.includes('\n')
      ? `T ${query.replace(/\n/g, ' ')}`
      : query.split('\n').map((line) => line
        ? translatePreservingLineMarker(line, 'T ')
        : line).join('\n');
    return {
      ok: true,
      json: async () => ({ responseData: { translatedText: translated, match: 1 } }),
    };
  };
  return calls;
}

function stubFoldedMyMemory(lineResponse) {
  const calls = [];
  const premiumFailure = stubPremiumFailure();
  globalThis.fetch = async (url) => {
    const premium = premiumFailure(url);
    if (premium) return premium;
    const value = String(url);
    if (!value.includes('api.mymemory.translated.net')) throw new Error('offline nel test');
    const query = new URL(value).searchParams.get('q') || '';
    calls.push(query);
    const translatedText = calls.length === 1
      ? query.replace(/\n/g, ' ')
      : lineResponse(query);
    return {
      ok: true,
      json: async () => ({ responseData: { translatedText, match: 1 } }),
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
        json: async () => [{
          translations: [{
            text: text.split('\n').map((line) => line
              ? translatePreservingLineMarker(line, 'AZURE ')
              : line).join('\n'),
          }],
        }],
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
  assert.match(translated, /^- AZURE /);
  assert.deepEqual(lineKinds(translated), lineKinds(source));
  assert.equal(
    (getCascadeStats().tierStructureFailures?.recoveryFailed?.deepl || 0) - beforeFailure,
    1,
  );
  assert.equal((getCascadeStats().tierHits.azure || 0) - beforeAzureHit, 1);
});

test('un recovery di righe brevi uguali rifiuta il passthrough del campo e conta una volta', async () => {
  const source = ['Ciao mondo', 'Buona sera', 'Tutto bene'].join('\n');
  const calls = stubFoldedMyMemory((line) => line);
  const before = getCascadeStats();

  const translated = await freeTranslate({
    text: source,
    sourceLang: 'it',
    targetLang: 'de',
    fieldType: 'description',
  });

  const after = getCascadeStats();
  assert.equal(calls.length, 4);
  assert.equal(translated, '');
  assert.equal((after.tierHits.myMemory || 0) - (before.tierHits.myMemory || 0), 0);
  assert.equal(
    (after.tierPassthroughs.myMemory || 0) - (before.tierPassthroughs.myMemory || 0),
    1,
  );
});

test('un recovery conserva una riga breve uguale accanto a righe tradotte', async () => {
  const source = ['Ciao mondo', 'Vai', 'Buona sera'].join('\n');
  const calls = stubFoldedMyMemory((line) => (
    line === 'Vai' ? line : `Tradotto ${line}`
  ));
  const before = getCascadeStats();

  const translated = await freeTranslate({
    text: source,
    sourceLang: 'it',
    targetLang: 'de',
    fieldType: 'description',
  });

  const after = getCascadeStats();
  assert.equal(calls.length, 4);
  assert.equal(translated, 'Tradotto Ciao mondo\nVai\nTradotto Buona sera');
  assert.equal((after.tierHits.myMemory || 0) - (before.tierHits.myMemory || 0), 1);
  assert.equal(
    (after.tierPassthroughs.myMemory || 0) - (before.tierPassthroughs.myMemory || 0),
    0,
  );
});

test('il recovery aggregato lascia passare una sola riga breve uguale', async () => {
  const source = ['No!', 'OK!', 'Sì!'].join('\n');
  const calls = stubFoldedMyMemory((line) => (line === 'No!' ? line : `Tradotto ${line}`));

  const translated = await freeTranslate({
    text: source,
    sourceLang: 'it',
    targetLang: 'de',
    fieldType: 'description',
  });

  assert.equal(calls.length, 4);
  assert.equal(translated, 'No!\nTradotto OK!\nTradotto Sì!');
});

test('il recovery aggregato rifiuta le righe uguali sostanziose insieme', async () => {
  const source = [
    'Uno due tre quattro',
    'cinque sei sette otto',
    'Riga tradotta',
    'Altra riga tradotta',
  ].join('\n');
  const before = getCascadeStats();
  const calls = stubFoldedMyMemory((line) => (
    line === 'Uno due tre quattro' || line === 'cinque sei sette otto'
      ? line
      : `Tradotto ${line}`
  ));

  const translated = await freeTranslate({
    text: source,
    sourceLang: 'it',
    targetLang: 'de',
    fieldType: 'description',
  });

  const after = getCascadeStats();
  assert.equal(calls.length, 5);
  assert.equal(translated, '');
  assert.equal((after.tierPassthroughs.myMemory || 0) - (before.tierPassthroughs.myMemory || 0), 1);
});

test('il recovery aggregato rifiuta quando le righe uguali sono piu della meta', async () => {
  const source = ['No!', 'OK!', 'Sì!', 'Riga tradotta'].join('\n');
  const before = getCascadeStats();
  const calls = stubFoldedMyMemory((line) => (
    line === 'Riga tradotta' ? `Tradotto ${line}` : line
  ));

  const translated = await freeTranslate({
    text: source,
    sourceLang: 'it',
    targetLang: 'de',
    fieldType: 'description',
  });

  const after = getCascadeStats();
  assert.equal(calls.length, 5);
  assert.equal(translated, '');
  assert.equal((after.tierPassthroughs.myMemory || 0) - (before.tierPassthroughs.myMemory || 0), 1);
});

test('il recovery aggregato rifiuta quando tutte le righe traducibili sono uguali', async () => {
  const source = ['No!', 'OK!', 'Sì!'].join('\n');
  const before = getCascadeStats();
  const calls = stubFoldedMyMemory((line) => line);

  const translated = await freeTranslate({
    text: source,
    sourceLang: 'it',
    targetLang: 'de',
    fieldType: 'description',
  });

  const after = getCascadeStats();
  assert.equal(calls.length, 4);
  assert.equal(translated, '');
  assert.equal((after.tierPassthroughs.myMemory || 0) - (before.tierPassthroughs.myMemory || 0), 1);
});

test('una riga traducibile che diventa solo marker viene rifiutata', async () => {
  const source = '- Prima riga\n- Seconda riga';
  const calls = stubFoldedMyMemory((line) => (
    line === 'Prima riga' ? '-' : `- Tradotto ${line}`
  ));

  const translated = await freeTranslate({
    text: source,
    sourceLang: 'it',
    targetLang: 'de',
    fieldType: 'description',
  });

  assert.equal(calls.length, 2);
  assert.equal(translated, '');
});

test('il recovery conserva l indentazione delle liste annidate', async () => {
  const source = '- Primo\n  - Annidato';
  const calls = [];
  globalThis.fetch = async (url) => {
    if (!String(url).includes('api.mymemory.translated.net')) throw new Error('offline nel test');
    const query = new URL(url).searchParams.get('q') || '';
    calls.push(query);
    const translatedText = calls.length === 1
      ? '- First\n- Nested'
      : `Tradotto ${query}`;
    return {
      ok: true,
      json: async () => ({ responseData: { translatedText, match: 1 } }),
    };
  };

  const translated = await freeTranslate({
    text: source,
    sourceLang: 'it',
    targetLang: 'de',
    fieldType: 'description',
  });

  assert.deepEqual(calls, ['- Primo\n  - Annidato', 'Primo', 'Annidato']);
  assert.equal(translated, '- Tradotto Primo\n  - Tradotto Annidato');
});

test('il recovery rifiuta una traduzione che perde URL o placeholder opachi', async () => {
  const source = '- Leggi https://example.com/CasePath\n- Seconda riga';
  const calls = [];
  globalThis.fetch = async (url) => {
    if (!String(url).includes('api.mymemory.translated.net')) throw new Error('offline nel test');
    const query = new URL(url).searchParams.get('q') || '';
    calls.push(query);
    const translatedText = calls.length === 1
      ? '- Lies https://example.com/casepath\n- Zweite'
      : 'Lies https://example.com/casepath';
    return {
      ok: true,
      json: async () => ({ responseData: { translatedText, match: 1 } }),
    };
  };

  const translated = await freeTranslate({
    text: source,
    sourceLang: 'it',
    targetLang: 'de',
    fieldType: 'description',
  });

  assert.equal(calls.length, 2);
  assert.equal(translated, '');
});

test('la guardia monolinea rifiuta la perdita di un URL opaco', async () => {
  const source = 'Leggi https://example.com/CasePath';
  const calls = [];
  globalThis.fetch = async (url) => {
    if (!String(url).includes('api.mymemory.translated.net')) throw new Error('offline nel test');
    const query = new URL(url).searchParams.get('q') || '';
    calls.push(query);
    return {
      ok: true,
      json: async () => ({ responseData: { translatedText: 'Lies die Seite', match: 1 } }),
    };
  };

  const translated = await freeTranslate({
    text: source,
    sourceLang: 'it',
    targetLang: 'de',
    fieldType: 'description',
  });

  assert.equal(calls.length, 2);
  assert.equal(translated, '');
});

test('la guardia strutturale misura i numeri alterati senza rifiutare la traduzione', async () => {
  const source = 'La regola vale dal 2026 e costa 42 CHF.';
  const calls = [];
  const before = getCascadeStats();
  globalThis.fetch = async (url) => {
    if (!String(url).includes('api.mymemory.translated.net')) throw new Error('offline nel test');
    const query = new URL(url).searchParams.get('q') || '';
    calls.push(query);
    return {
      ok: true,
      json: async () => ({
        responseData: { translatedText: 'Die Regel gilt ab 2025 und kostet 24 CHF.', match: 1 },
      }),
    };
  };

  const translated = await freeTranslate({
    text: source,
    sourceLang: 'it',
    targetLang: 'de',
    fieldType: 'description',
  });

  assert.equal(calls.length, 1);
  assert.equal(translated, 'Die Regel gilt ab 2025 und kostet 24 CHF.');
  assert.equal(
    (getCascadeStats().tierNumericDrift.myMemory || 0) - (before.tierNumericDrift.myMemory || 0),
    1,
  );
});

test('il recovery di righe brevi realmente tradotte resta un hit', async () => {
  const source = ['Ciao mondo', 'Buona sera', 'Tutto bene'].join('\n');
  const calls = stubFoldedMyMemory((line) => `Tradotto: ${line}`);
  const before = getCascadeStats();

  const translated = await freeTranslate({
    text: source,
    sourceLang: 'it',
    targetLang: 'de',
    fieldType: 'description',
  });

  const after = getCascadeStats();
  assert.equal(calls.length, 4);
  assert.match(translated, /Tradotto: Ciao mondo/);
  assert.equal((after.tierHits.myMemory || 0) - (before.tierHits.myMemory || 0), 1);
  assert.equal((after.tierPassthroughs.myMemory || 0) - (before.tierPassthroughs.myMemory || 0), 0);
});

test('il recovery di sole righe non traducibili conserva la sorgente e conta un hit', async () => {
  const source = ['12345', '—', '!!!', 'https://example.com', 'mail@example.com', '{name}'].join('\n');
  const calls = stubFoldedMyMemory((line) => line);
  const before = getCascadeStats();

  const translated = await freeTranslate({
    text: source,
    sourceLang: 'it',
    targetLang: 'de',
    fieldType: 'description',
  });

  const after = getCascadeStats();
  assert.equal(calls.length, 1);
  assert.equal(translated, source);
  assert.equal((after.tierHits.myMemory || 0) - (before.tierHits.myMemory || 0), 1);
  assert.equal((after.tierPassthroughs.myMemory || 0) - (before.tierPassthroughs.myMemory || 0), 0);
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

test('una sorgente monolinea rifiuta una risposta che aggiunge righe', async () => {
  const source = 'Titolo breve della procedura';
  let calls = 0;
  const premiumFailure = stubPremiumFailure();
  globalThis.fetch = async (url) => {
    const premium = premiumFailure(url);
    if (premium) return premium;
    if (!String(url).includes('api.mymemory.translated.net')) throw new Error('offline nel test');
    calls += 1;
    return {
      ok: true,
      json: async () => ({
        responseData: {
          translatedText: 'Titolo tradotto\nRiga inattesa',
          match: 1,
        },
      }),
    };
  };

  const translated = await freeTranslate({
    text: source,
    sourceLang: 'it',
    targetLang: 'de',
    fieldType: 'title',
  });

  assert.equal(calls, 2);
  assert.equal(translated, '');
});

test('una sorgente monolinea rifiuta un marcatore aggiunto anche senza newline', async () => {
  const source = 'Titolo breve della procedura';
  let calls = 0;
  const premiumFailure = stubPremiumFailure();
  globalThis.fetch = async (url) => {
    const premium = premiumFailure(url);
    if (premium) return premium;
    if (!String(url).includes('api.mymemory.translated.net')) throw new Error('offline nel test');
    calls += 1;
    return {
      ok: true,
      json: async () => ({
        responseData: { translatedText: '- Titolo tradotto', match: 1 },
      }),
    };
  };

  const translated = await freeTranslate({
    text: source,
    sourceLang: 'it',
    targetLang: 'de',
    fieldType: 'title',
  });

  assert.equal(calls, 2);
  assert.equal(translated, '');
});

test('hasTranslatableLineText conserva le righe brevi o prive di lettere', async () => {
  for (const [line, expected] of [
    ['OK', true],
    ['IT', true],
    ['Ja', true],
    ['No', true],
    ['Sì', true],
    ['## Sì', true],
    ['> No', true],
    ['| Ja |', true],
    ['Vai a 0NAV0', true],
    ['—', false],
    ['1.', false],
    ['!!!', false],
    ['12345', false],
    ['https://example.com', false],
    ['mail@example.com', false],
    ['{name}', false],
    ['{{name}}', false],
    ['%s', false],
    ['ZQX0XQZ', false],
    ['0NAV0', false],
    ['0M00Q0', false],
    ['Una riga traducibile', true],
  ]) {
    assert.equal(hasTranslatableLineText(line), expected, line);
  }

  const source = [
    'Vai a 0NAV0',
    '—',
    '1.',
    '12345',
    'https://example.com',
    'mail@example.com',
    'ZQX0XQZ',
    '0NAV0',
    '0M00Q0',
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
  assert.equal(calls.includes('Vai a 0NAV0'), true);
  assert.equal(
    calls.some((query) => [
      '—',
      '1.',
      '12345',
      'https://example.com',
      'mail@example.com',
      'ZQX0XQZ',
      '0NAV0',
      '0M00Q0',
    ].includes(query)),
    false,
  );
});

test('una riga breve traducibile non servita da MyMemory fa proseguire la cascata', async () => {
  const source = [
    'No',
    'Questa riga lunga permette di entrare nel ramo MyMemory a pezzi. '.repeat(120),
    'Sì',
  ].join('\n');
  const myMemoryCalls = [];
  const fallbackCalls = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes('api-free.deepl.com')) {
      return { ok: false, status: 503, json: async () => ({}) };
    }
    if (value.includes('api.cognitive.microsofttranslator.com')) {
      return { ok: false, status: 503, text: async () => '' };
    }
    if (value.includes('api.mymemory.translated.net')) {
      const query = new URL(value).searchParams.get('q') || '';
      myMemoryCalls.push(query);
      const shortLineMiss = query.trim() === 'Sì';
      return {
        ok: true,
        json: async () => ({ responseData: { translatedText: shortLineMiss ? '' : `MM ${query}`, match: 1 } }),
      };
    }
    if (value.includes('mozhi.adminforge.de/api/translate')) {
      const query = new URL(value).searchParams.get('text') || '';
      fallbackCalls.push(query);
      return {
        ok: true,
        json: async () => ({
          'translated-text': query.split('\n').map((line) => line ? `DE ${line}` : line).join('\n'),
        }),
      };
    }
    throw new Error('offline nel test');
  };

  const translated = await freeTranslate({
    text: source,
    sourceLang: 'it',
    targetLang: 'de',
    fieldType: 'description',
  });

  assert.match(translated, /^DE /);
  assert.ok(fallbackCalls.length > 0);
  assert.equal(myMemoryCalls.includes('No'), false);
  assert.ok(myMemoryCalls.some((query) => query.trim() === 'No' && query.length >= 3));
});

test('il recovery rifiuta i marker Markdown alterati e ricompone quelli corretti', async () => {
  const source = [
    '## Titolo',
    '- Punto',
    '1. Passo',
    '',
    'Paragrafo',
  ].join('\n');
  const perLine = new Map([
    ['Titolo', '## Titel'],
    ['Punto', '- Punkt'],
    ['Passo', '1. Schritt'],
    ['Paragrafo', 'Absatz'],
  ]);
  let calls = 0;
  const queries = [];
  globalThis.fetch = async (url) => {
    if (!String(url).includes('api.mymemory.translated.net')) throw new Error('offline nel test');
    const query = new URL(url).searchParams.get('q') || '';
    queries.push(query);
    calls += 1;
    const translatedText = calls === 1
      ? '# Titel\n* Punkt\n1) Schritt\n\nAbsatz'
      : perLine.get(query);
    return {
      ok: true,
      json: async () => ({ responseData: { translatedText, match: 1 } }),
    };
  };

  const translated = await freeTranslate({
    text: source,
    sourceLang: 'it',
    targetLang: 'de',
    fieldType: 'description',
  });

  assert.equal(calls, 5);
  assert.deepEqual(queries.slice(1), ['Titolo', 'Punto', 'Passo', 'Paragrafo']);
  assert.equal(translated, '## Titel\n- Punkt\n1. Schritt\n\nAbsatz');
});

test('la validazione del payload rifiuta una riga che conserva il prefisso ma non il testo', async () => {
  const source = '- Prima riga\n- Seconda riga';
  const calls = stubFoldedMyMemory((line) => (
    line === 'Prima riga' ? '- 123' : `- Tradotto ${line}`
  ));

  const translated = await freeTranslate({
    text: source,
    sourceLang: 'it',
    targetLang: 'de',
    fieldType: 'description',
  });

  assert.equal(calls.length, 2);
  assert.equal(translated, '');
});

test('una riga opaca alterata forza il recovery e conserva il valore sorgente', async () => {
  const source = 'https://example.com\nTesto traducibile';
  const calls = [];
  const premiumFailure = stubPremiumFailure();
  globalThis.fetch = async (url) => {
    const premium = premiumFailure(url);
    if (premium) return premium;
    if (!String(url).includes('api.mymemory.translated.net')) throw new Error('offline nel test');
    const query = new URL(url).searchParams.get('q') || '';
    calls.push(query);
    const translatedText = calls.length === 1
      ? 'https://changed.example\nTesto tradotto'
      : 'Testo tradotto';
    return {
      ok: true,
      json: async () => ({ responseData: { translatedText, match: 1 } }),
    };
  };

  const translated = await freeTranslate({
    text: source,
    sourceLang: 'it',
    targetLang: 'de',
    fieldType: 'description',
  });

  assert.deepEqual(calls, [source, 'Testo traducibile']);
  assert.equal(translated, 'https://example.com\nTesto tradotto');
});

test('il recovery riattacca il prefisso sorgente senza raddoppiarlo', async () => {
  const source = '- Punto\n## Titolo';
  const calls = [];
  globalThis.fetch = async (url) => {
    if (!String(url).includes('api.mymemory.translated.net')) throw new Error('offline nel test');
    const query = new URL(url).searchParams.get('q') || '';
    calls.push(query);
    const translatedText = calls.length === 1 ? 'Punto Titolo' : `- Tradotto ${query}`;
    return {
      ok: true,
      json: async () => ({ responseData: { translatedText, match: 1 } }),
    };
  };

  const translated = await freeTranslate({
    text: source,
    sourceLang: 'it',
    targetLang: 'de',
    fieldType: 'description',
  });

  assert.deepEqual(calls.slice(1), ['Punto', 'Titolo']);
  assert.equal(translated, '- Tradotto Punto\n## Tradotto Titolo');
});

test('la firma strutturale copre citazioni, tabelle e tutti i prefissi di elenco', async () => {
  const source = [
    '> Citazione',
    '| Cella | Valore |',
    '* Punto',
    '+ Altro',
    '• Simbolo',
  ].join('\n');
  const calls = [];
  globalThis.fetch = async (url) => {
    if (!String(url).includes('api.mymemory.translated.net')) throw new Error('offline nel test');
    const query = new URL(url).searchParams.get('q') || '';
    calls.push(query);
    const translatedText = calls.length === 1
      ? 'Citazione\nCella Valore\nPunto\nAltro\nSimbolo'
      : `Tradotto ${query}`;
    return {
      ok: true,
      json: async () => ({ responseData: { translatedText, match: 1 } }),
    };
  };

  const translated = await freeTranslate({
    text: source,
    sourceLang: 'it',
    targetLang: 'de',
    fieldType: 'description',
  });

  assert.deepEqual(calls.slice(1), ['Citazione', 'Cella | Valore |', 'Punto', 'Altro', 'Simbolo']);
  assert.equal(
    translated,
    '> Tradotto Citazione\n| Tradotto Cella | Valore |\n* Tradotto Punto\n+ Tradotto Altro\n• Tradotto Simbolo',
  );
});

test('la forma delle sentinelle di genere è osservata dal classificatore della cascata', () => {
  const masked = maskProtectedTokens('Tecnico (m/w/d), infermiere (f/m) e ruolo M/W/D');
  assert.ok(masked.tokens.length > 1);
  const restored = restoreProtectedTokens(masked.text, masked.tokens, 'it');
  assert.equal(restored, 'Tecnico (m/f/d), infermiere (m/f) e ruolo M/F/D');
  for (const token of masked.tokens) {
    assert.equal(hasTranslatableLineText(token.placeholder), false, token.placeholder);
  }
  assert.equal(hasTranslatableLineText('ZQX0_XQZ'), true);
});

test('D5: le localizzazioni numeriche reali passano, mentre i vincoli strutturali restano chiusi', () => {
  // Coppie brevi osservate nelle localizzazioni pubblicate del corpus.
  const accepted = [
    ['70.000', '70,000'],
    ['70.000', '70 000'],
    ['20%', '20 %'],
    ['1° luglio 2024', '1er juillet 2024'],
    ['1° luglio 2024', '1. Juli 2024'],
    ['1,80', '1.80'],
    ['dalle ore 17.00', 'from 5:00 PM'],
  ];
  for (const [source, translated] of accepted) {
    assert.equal(hasSameLineStructure(source, translated), true, `${source} → ${translated}`);
    assert.deepEqual(numericDriftTokens(source, translated), [], `${source} → ${translated}`);
  }

  assert.deepEqual(opaqueSpanSignature('70.000'), [], 'i numeri non sono span della guardia');
  assert.equal(lineStructuralSignature('1. Juli 2024').kind, 'ordered');
  assert.equal(normalizeStructuredBlock('  70.000  '), '  70.000');

  const rejected = [
    ['Leggi https://example.com/CasePath', 'Lies https://example.com/casepath'],
    ['Scrivi a User@example.com', 'Schreib an user@example.com'],
    ['Importo {{amount}}', 'Betrag'],
    ['una riga', 'una riga\nuna riga in più'],
    ['4500', '4501'],
  ];
  for (const [source, translated] of rejected) {
    assert.equal(hasSameLineStructure(source, translated), false, `${source} → ${translated}`);
  }

  assert.deepEqual(numericDriftTokens('Anno 2026', 'Jahr 2025'), ['2026']);
  assert.deepEqual(numericDriftTokens('Importo 70.000', 'Betrag 7.000'), ['70000']);
});
