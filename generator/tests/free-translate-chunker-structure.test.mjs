import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

const realVitestFlag = process.env.VITEST;

for (const key of [
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CODEX_AUTH_BROKER_SOCKET',
  'FREE_TRANSLATE_CODEX_TIER',
  'FREE_TRANSLATE_CODEX_MAX_CALLS',
  'DEEPL_API_KEY',
  'DEEPL_API_KEY_2',
  'AZURE_TRANSLATOR_KEY',
  'AZURE_TRANSLATOR_KEY_2',
  'GSC_CLIENT_ID',
  'GSC_CLIENT_SECRET',
  'GSC_REFRESH_TOKEN',
  'LIBRETRANSLATE_SELF_HOSTED_URL',
  'HF_TOKEN',
  'HUGGINGFACE_API_KEY',
  'MT_LOCAL_OPUSMT',
]) delete process.env[key];
process.env.VITEST = '1';

const {
  freeTranslate,
  getCascadeStats,
  _chunkAtSentences,
  _recomposeChunkParts,
} = await import('../scripts/lib/free-translate.mjs');

const realFetch = globalThis.fetch;

function makeReproductionBody() {
  const lines = [
    '## In breve',
    '- La domanda va presentata prima della scadenza indicata dall autorita competente',
    '- Il termine vale anche per chi cambia datore di lavoro durante l anno',
    '',
    'Il frontaliere deve controllare i requisiti applicabili e conservare la documentazione necessaria per la domanda.',
    'La procedura richiede attenzione alle date, ai documenti allegati e alle comunicazioni ricevute dagli uffici.',
    '',
    '## Dettagli',
    '- La richiesta puo essere inviata online oppure allo sportello competente',
    '',
  ];
  const targetLength = 5_877;
  const prefix = `${lines.slice(0, 10).join('\n')}\n`;
  const lastLine = (`Nota finale: ${'informazione aggiuntiva '.repeat(45)}`).trimEnd();
  const middleLength = targetLength - prefix.length - lastLine.length - 1;
  const middlePrefix = 'Le informazioni pubblicate spiegano i passaggi principali e aiutano a evitare ritardi nella pratica ';
  const middle = `${middlePrefix}${'x'.repeat(middleLength - middlePrefix.length)}`;
  return `${prefix}${middle}\n${lastLine}`;
}

function structureOf(text) {
  return text.split('\n').map((line) => line === '');
}

async function translateWithStub(source, translateChunk) {
  process.env.VITEST = '1';
  const calls = [];
  const prefixByContent = new Map(source.split('\n').map((line) => {
    const match = String(line).match(/^(\s*(?:#{1,6}\s+|[-*+•]\s+|\d+[.)]\s+|>\s+|\|\s*))(.*)$/u);
    return [match ? match[2] : line, match?.[1] || ''];
  }));
  const translateLine = (line) => {
    const match = String(line).match(/^(\s*(?:#{1,6}\s+|[-*+•]\s+|\d+[.)]\s+|>\s+|\|\s*))(.*)$/u);
    const content = match ? match[2] : line;
    const prefix = match?.[1] || prefixByContent.get(content) || '';
    return `${prefix}[en] ${translateChunk(content)}`;
  };
  globalThis.fetch = async (url) => {
    if (!String(url).includes('api.mymemory.translated.net')) {
      throw new Error('offline nel test');
    }
    const query = new URL(url).searchParams.get('q') || '';
    calls.push(query);
    return {
      ok: true,
      json: async () => ({
        responseData: {
          translatedText: query.split('\n').map((line) => line ? translateLine(line) : line).join('\n'),
          match: 1,
        },
      }),
    };
  };
  const translated = await freeTranslate({
    text: source,
    sourceLang: 'it',
    targetLang: 'en',
    fieldType: 'description',
  });
  return { calls, translated };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realVitestFlag === undefined) delete process.env.VITEST;
  else process.env.VITEST = realVitestFlag;
});

test('il chunker conserva separatori, round-trip e limite per righe lunghe', () => {
  const rawSource = '  ## Titolo  \r\n- Punto uno\r\n- Punto due\r\n\r\n  Paragrafo con una frase. Seconda frase.  ';
  const source = '## Titolo\n- Punto uno\n- Punto due\n\nParagrafo con una frase. Seconda frase.';
  const chunks = _chunkAtSentences(rawSource, 25);

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(({ text }) => text.length <= 25));
  assert.equal(_recomposeChunkParts(chunks), source);
  assert.ok(chunks.some(({ separatorAfter }) => separatorAfter === '\n\n'));

  const longLine = 'parola '.repeat(80).trim();
  const longLineChunks = _chunkAtSentences(longLine, 40);
  assert.ok(longLineChunks.length > 1);
  assert.ok(longLineChunks.every(({ text }) => text.length <= 40));
  assert.equal(_recomposeChunkParts(longLineChunks), longLine);
});

test('il ramo lungo MyMemory traduce una riga per richiesta e ricompone i separatori', async () => {
  const source = makeReproductionBody();
  const { calls, translated } = await translateWithStub(source, (chunk) => chunk);

  assert.equal(source.length, 5_877);
  assert.equal(source.split('\n').length, 12);
  assert.equal(calls.length, 9);
  assert.ok(calls.reduce((sum, chunk) => sum + chunk.length, 0) < source.length);
  assert.equal(calls.reduce((sum, chunk) => sum + (chunk.match(/\n/g) || []).length, 0), 0);
  assert.equal(
    calls.some((chunk) => /^(?:#{1,6}\s|[-*+•]\s|\d+[.)]\s|>\s|\|)/u.test(chunk)),
    false,
  );
  assert.deepEqual(structureOf(translated), structureOf(source));
  assert.equal((translated.match(/\n/g) || []).length, 11);
});

test('un motore finto che perde gli a capo non appiattisce il ramo lungo per righe', async () => {
  const source = makeReproductionBody();
  const { calls, translated } = await translateWithStub(source, (chunk) => chunk.replace(/\n/g, ' '));

  assert.ok(calls.every((chunk) => !chunk.includes('\n')));
  assert.deepEqual(structureOf(translated), structureOf(source));
  assert.equal((translated.match(/\n/g) || []).length, 11);
});

test('il ramo breve MyMemory mantiene gli a capo nella chiamata singola', async () => {
  const source = '## Titolo\n- Punto uno\n- Punto due\n\nParagrafo breve.';
  const { calls, translated } = await translateWithStub(source, (chunk) => chunk);

  assert.equal(calls.length, 1);
  assert.equal((calls[0].match(/\n/g) || []).length, 4);
  assert.equal((translated.match(/\n/g) || []).length, 4);
});

test('_chunkAtSentences rifiuta un maxChars non intero positivo', () => {
  const source = 'parola '.repeat(120).trim();
  const expected = _chunkAtSentences(source);

  for (const maxChars of [0, 0.5, NaN, -1, Infinity, '480', null]) {
    assert.throws(
      () => _chunkAtSentences(source, maxChars),
      TypeError,
      String(maxChars),
    );
  }
  assert.deepEqual(_chunkAtSentences(source, undefined), expected);
});

test('_recomposeChunkParts fallisce esplicitamente se manca una parte tradotta', () => {
  const chunks = [
    { text: 'uno', separatorAfter: '\n' },
    { text: 'due', separatorAfter: '' },
  ];

  assert.throws(
    () => _recomposeChunkParts(chunks, ['primo']),
    /translatedParts.*one entry per chunk/,
  );
  assert.throws(
    () => _recomposeChunkParts(chunks, ['primo', undefined]),
    /translatedParts.*one entry per chunk/,
  );
  assert.throws(
    () => _recomposeChunkParts(chunks, ['primo', null]),
    /translatedParts.*one entry per chunk/,
  );
});

test('getCascadeStats restituisce copie profonde dei secchi annidati', () => {
  const photo = getCascadeStats();
  const expected = structuredClone(photo);

  photo.tierHits.myMemory = 101;
  photo.tierErrors.myMemory = 102;
  photo.tierPassthroughs.myMemory = 103;
  photo.tierPassthroughChunks.myMemory = 104;
  photo.tierMetaResponses.myMemory = 105;
  photo.tierStructureFailures.recoveryFailed.myMemory = 106;
  photo.byFieldType.description.calls = 107;

  assert.deepEqual(getCascadeStats(), expected);
});
