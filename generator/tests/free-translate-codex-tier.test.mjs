/**
 * Tier Codex Luna Max della cascata MT (decisione del proprietario del
 * 2026-10-06: Codex è il primo provider, con fallback alla cascata MT storica).
 * Gemello di tests/free-translate-codex-tier.test.ts del sito.
 *
 * ── COSA PINNA ─────────────────────────────────────────────────────────────
 *
 *   · il tier entra per primo quando il broker e' disponibile; timeout/quota/auth
 *     fanno scattare il circuito per run e la cascata prosegue;
 *   · senza lane (socket del broker assente) si salta in silenzio;
 *   · il budget per processo (FREE_TRANSLATE_CODEX_MAX_CALLS) e i fallimenti
 *     consecutivi fermano il tier con UNA riga di log;
 *   · la risposta passa da `tryTier`/`finalize` come ogni altro tier: un eco
 *     della sorgente e' rifiutato e contato in `tierPassthroughs.codex`, i
 *     token protetti tornano nella forma della lingua di arrivo;
 *   · la cornice si toglie solo con i marcatori della chiamata: un testo che
 *     contiene davvero `END_TEXT` resta intero;
 *   · le chiamate del processo passano una alla volta, quindi le chiamate
 *     concorrenti non superano insieme il budget di tempo;
 *   · FREE_TRANSLATE_CODEX_TIER=last resta coperto come override legacy esplicito;
 *
 * Nessuna rete e nessun Codex vero: `fetch` e' uno stub (DeepL, Azure e
 * MyMemory) e la chiamata a Codex passa da `setCodexTranslateCallForTests`.
 * Le chiavi DeepL/Azure sono lette all'import del modulo, quindi l'ambiente si
 * prepara PRIMA dell'import dinamico; `node --test` isola ogni file nel suo
 * processo, e lo stato dei tier (chiavi esaurite) prosegue fra i casi
 * nell'ordine in cui sono scritti.
 */
import './lib/stdout-off-runner-pipe.mjs'; // stdout e' la pipe dei frame di node:test (issue 1819)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tier-'));
const SOCKET = path.join(tmp, 'broker.sock');
fs.writeFileSync(SOCKET, '');

for (const key of [
  'DEEPL_API_KEY_2', 'AZURE_TRANSLATOR_KEY_2', 'GSC_CLIENT_ID', 'GSC_CLIENT_SECRET',
  'GSC_REFRESH_TOKEN', 'HF_TOKEN', 'HUGGINGFACE_API_KEY', 'LIBRETRANSLATE_SELF_HOSTED_URL',
  'MT_LOCAL_OPUSMT', 'ENABLE_CODEX_ARTICLE_FALLBACK', 'AI_MODELS_PREFER', 'AI_MODELS_FORCE_CHAIN',
  'FREE_TRANSLATE_CODEX_MAX_CALLS', 'FREE_TRANSLATE_CODEX_MAX_MS', 'FREE_TRANSLATE_CODEX_LANES',
  'FREE_TRANSLATE_CODEX_BATCH_MAX_TEXTS',
]) delete process.env[key];
process.env.DEEPL_API_KEY = 'deepl-finta';
process.env.AZURE_TRANSLATOR_KEY = 'azure-finta';
process.env.CODEX_AUTH_BROKER_SOCKET = SOCKET;
// Salta le attese fra retry e chunk della cascata (vedi `delay`).
process.env.VITEST = '1';

const {
  freeTranslate,
  getCascadeStats,
  getTranslationCascadeConfigurationKey,
  logCascadeSummary,
  setCodexTranslateCallForTests,
  setCodexTranslateProcessDeadline,
  codexCallDeadlineMs,
  beginCodexTranslationCall,
  withCodexTranslationLane,
  fetchWithRefTimeout,
} = await import('../scripts/lib/free-translate.mjs');
const { AI_MODELS } = await import('../scripts/lib/ai-models.mjs');

after(() => {
  setCodexTranslateCallForTests(null);
  setCodexTranslateProcessDeadline(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const IT = 'Il permesso G si rinnova ogni cinque anni presso l\'ufficio della migrazione del Cantone Ticino.';
const EN = 'The G permit is renewed every five years at the migration office of the Canton of Ticino.';

const premium = { deepl: 200, azure: 200 };
// MyMemory che rimanda la sorgente: eco rifiutato, la cascata prosegue fino in fondo.
const free = { mymemoryEcho: false, googleEcho: false, mymemoryDown: false, lingvaEcho: false };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('api-free.deepl.com')) {
    if (premium.deepl === 200) return { ok: true, status: 200, json: async () => ({ translations: [{ text: `DEEPL ${EN}` }] }) };
    return { ok: false, status: premium.deepl, json: async () => ({}), text: async () => '' };
  }
  if (u.includes('api.cognitive.microsofttranslator.com')) {
    if (premium.azure === 200) return { ok: true, status: 200, json: async () => [{ translations: [{ text: `AZURE ${EN}` }] }] };
    return { ok: false, status: premium.azure, json: async () => ({}), text: async () => 'credenziali rifiutate' };
  }
  if (free.googleEcho && u.includes('translate.googleapis.com/translate_a/single')) {
    const q = new URL(u).searchParams.get('q');
    return { ok: true, status: 200, text: async () => JSON.stringify([[[q, q]]]) };
  }
  if (free.mymemoryDown && u.includes('api.mymemory.translated.net')) throw new Error('offline nel test');
  if (free.lingvaEcho && u.includes('/api/v1/')) {
    const q = decodeURIComponent(u.split('/').pop() || '');
    return { ok: true, status: 200, json: async () => ({ translation: q }) };
  }
  if (u.includes('api.mymemory.translated.net')) {
    const translatedText = free.mymemoryEcho ? new URL(u).searchParams.get('q') : `MYMEMORY ${EN}`;
    return { ok: true, json: async () => ({ responseData: { translatedText, match: 1 } }) };
  }
  throw new Error('offline nel test');
};
after(() => { globalThis.fetch = realFetch; });

test('il timeout HTTP referenziato risolve una fetch pendente senza handle di rete', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted by test')), { once: true });
  });
  try {
    await assert.rejects(
      fetchWithRefTimeout('https://stalled.invalid', {}, 10),
      /aborted by test/,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('il timeout HTTP referenziato resta attivo durante la lettura del body', async () => {
  const previousFetch = globalThis.fetch;
  try {
    for (const reader of ['json', 'text']) {
      globalThis.fetch = async (_url, { signal }) => ({
        ok: true,
        status: 200,
        [reader]: () => new Promise((_resolve, reject) => {
          const onAbort = () => reject(new Error(`body ${reader} aborted by test`));
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }),
      });
      let guard;
      try {
        const response = await fetchWithRefTimeout('https://stalled-body.invalid', {}, 10);
        const guardPromise = new Promise((_, reject) => {
          guard = setTimeout(() => reject(new Error(`body ${reader} guard expired`)), 100);
        });
        await assert.rejects(
          Promise.race([response[reader](), guardPromise]),
          new RegExp(`body ${reader} aborted by test`),
        );
      } finally {
        clearTimeout(guard);
      }
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

/** Suffisso dei marcatori della chiamata, letto dal messaggio utente. */
function markerOf(messages) {
  return /^BEGIN_TEXT_([A-Z0-9]{8})\n/.exec(messages.find((m) => m.role === 'user').content)?.[1];
}

/** Contatori del tier Codex: `getCascadeStats` copia solo il primo livello. */
function codexCounters() {
  const s = getCascadeStats();
  return {
    hits: s.tierHits.codex || 0,
    errors: s.tierErrors.codex || 0,
    passthroughs: s.tierPassthroughs.codex || 0,
  };
}

function stubCodex(answer) {
  const calls = [];
  setCodexTranslateCallForTests(async (messages, opts) => {
    calls.push({ messages, opts });
    return typeof answer === 'function' ? answer(messages, calls.length) : answer;
  });
  return calls;
}

function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  return Promise.resolve()
    .then(fn)
    .then((value) => ({ value, lines }), (error) => { throw error; })
    .finally(() => { console.log = orig; });
}

const it = (text = IT) => freeTranslate({ text, sourceLang: 'it', targetLang: 'en', fieldType: 'description' });

/** Testi distinti, tutti it→en: `Numero N` li distingue. */
const numbered = (count) => Array.from({ length: count }, (_, i) => `${IT} Numero ${i + 1}.`);
const translationOf = (text) => `${EN} [${/Numero (\d+)/.exec(text)?.[1] ?? '?'}]`;

const DATE_CASES = [
  {
    source: 'La domanda e\' valida dal 1° gennaio 2024 e il limite e\' di 42 giorni.',
    de: 'Der Antrag ist ab dem 1. Januar 2024 gültig und die Frist beträgt 42 Tage.',
  },
  {
    source: 'La scadenza e\' il 2 febbraio 2025 e il valore resta 7.',
    de: 'Die Frist ist am 2. Februar 2025 und der Wert bleibt 7.',
  },
  {
    source: 'Il contratto decorre dal 3 marzo 2026 e prevede 9 mesi.',
    de: 'Der Vertrag beginnt am 3. März 2026 und sieht 9 Monate vor.',
  },
];
const DATE_CASE_BY_SOURCE = new Map(DATE_CASES.map((item) => [item.source, item]));

function assertLocalizedDateRule(system) {
  assert.match(system, /Localize dates using the target language's customary format/);
  assert.match(system, /same calendar day, month, year and numeric values/);
  assert.match(system, /non-date numbers, amounts/);
  assert.doesNotMatch(system, /Copy unchanged:[^\n]*dates/);
}

function localizedDateAnswer(messages) {
  const system = messages.find((m) => m.role === 'system').content;
  assertLocalizedDateRule(system);
  const items = batchItems(messages);
  if (items) {
    return JSON.stringify({
      items: items.map(({ id, text }) => ({ id, text: DATE_CASE_BY_SOURCE.get(text)?.de ?? '' })),
    });
  }
  const user = messages.find((m) => m.role === 'user').content;
  const framed = /^BEGIN_TEXT_[A-Z0-9]{8}\n([\s\S]*)\nEND_TEXT_[A-Z0-9]{8}$/.exec(user);
  return DATE_CASE_BY_SOURCE.get(framed?.[1])?.de ?? '';
}

/** Richiesta di gruppo: il messaggio utente e' l'array JSON delle voci. */
function batchItems(messages) {
  const user = messages.find((m) => m.role === 'user').content;
  return user.startsWith('[') ? JSON.parse(user) : null;
}

/** Risponde come Codex: al testo singolo con la traduzione, al gruppo con lo schema a id. */
function codexAnswer(translate = translationOf) {
  return (messages) => {
    const items = batchItems(messages);
    if (items) return JSON.stringify({ items: items.map(({ id, text }) => ({ id, text: translate(text) })) });
    const user = messages.find((m) => m.role === 'user').content;
    return translate(/^BEGIN_TEXT_[A-Z0-9]{8}\n([\s\S]*)\nEND_TEXT_[A-Z0-9]{8}$/.exec(user)[1]);
  };
}

async function withLanes(lanes, body) {
  process.env.FREE_TRANSLATE_CODEX_LANES = String(lanes);
  try {
    return await body();
  } finally {
    delete process.env.FREE_TRANSLATE_CODEX_LANES;
  }
}

test('Codex primario: precede DeepL anche quando la chiave premium e\' sana', async () => {
  const calls = stubCodex(`CODEX ${EN}`);
  assert.equal(await it(), `CODEX ${EN}`);
  assert.equal(calls.length, 1);
});

test('Codex primario: precede anche il fallback quando DeepL/Azure rispondono 5xx', async () => {
  premium.deepl = 500;
  premium.azure = 500;
  const calls = stubCodex(`CODEX ${EN}`);
  assert.equal(await it(), `CODEX ${EN}`);
  assert.equal(calls.length, 1);
});

test('DeepL 456 e Azure 401: tier Codex, con il prompt stretto e la sola lane Codex', async () => {
  premium.deepl = 456;
  premium.azure = 401;
  const before = codexCounters();
  const calls = stubCodex(`CODEX ${EN}`);
  const { value, lines } = await captureLog(() => it());
  assert.equal(value, `CODEX ${EN}`);
  assert.equal(calls.length, 1);
  const after = codexCounters();
  assert.equal(after.hits - before.hits, 1);
  assert.equal(lines.filter((l) => l.includes('traduzioni via Codex Luna Max')).length, 1);
  assert.doesNotMatch(lines.join('\n'), /DeepL key|Azure key|HTTP 456|HTTP 401|credenziali rifiutate/);

  const { messages, opts } = calls[0];
  const system = messages.find((m) => m.role === 'system').content;
  assert.match(system, /from Italian to English/);
  assert.match(system, /Translate only/);
  assert.match(system, /\*\*bold\*\*/);
  assert.match(system, /URLs/);
  assert.match(system, /ZQX0XQZ/);
  assert.match(system, /translated text only/);
  const user = messages.find((m) => m.role === 'user').content;
  const framed = /^BEGIN_TEXT_([A-Z0-9]{8})\n([\s\S]*)\nEND_TEXT_\1$/.exec(user);
  assert.ok(framed, 'testo incorniciato dai marcatori della chiamata');
  assert.equal(framed[2], IT);
  assert.ok(system.includes(`between BEGIN_TEXT_${framed[1]} and END_TEXT_${framed[1]}`));
  assert.deepEqual(opts.chain, [AI_MODELS.CODEX_CLI_PRIMARY]);
  assert.deepEqual(opts.prefer, [AI_MODELS.CODEX_CLI_PRIMARY]);
  assert.equal(opts.bypassForceChain, true);
  assert.ok(opts.deadlineMs > Date.now() && opts.deadlineMs <= Date.now() + 180_000);
});

test('le date sono localizzate nella lingua di arrivo, con valori invariati, in singola e batch', async () => {
  const singleCalls = stubCodex(localizedDateAnswer);
  assert.equal(await freeTranslate({
    text: DATE_CASES[0].source,
    sourceLang: 'it',
    targetLang: 'de',
    fieldType: 'description',
  }), DATE_CASES[0].de);
  assert.equal(singleCalls.length, 1);

  await withLanes(1, async () => {
    const batchCalls = stubCodex(localizedDateAnswer);
    const { value } = await captureLog(() => Promise.all(DATE_CASES.map(({ source }) => freeTranslate({
      text: source,
      sourceLang: 'it',
      targetLang: 'de',
      fieldType: 'description',
    }))));
    assert.deepEqual(value, DATE_CASES.map(({ de }) => de));
    assert.equal(batchCalls.length, 2);
    assert.equal(batchItems(batchCalls[1].messages).length, 2);
  });
});

test('la risposta passa da finalize: cornice tolta, token protetto rimesso nella lingua di arrivo', async () => {
  const calls = stubCodex((messages) => {
    const user = messages.find((m) => m.role === 'user').content;
    const token = /ZQX\d+XQZ/.exec(user)?.[0];
    assert.ok(token, 'il trigramma di genere deve arrivare mascherato');
    const marker = markerOf(messages);
    return `\`\`\`\nBEGIN_TEXT_${marker}\nInfermiere diplomato ${token}\nEND_TEXT_${marker}\n\`\`\``;
  });
  const out = await freeTranslate({ text: 'Pflegefachperson HF (m/w/d)', sourceLang: 'de', targetLang: 'it' });
  assert.equal(calls.length, 1);
  assert.match(out, /^Infermiere diplomato/);
  assert.doesNotMatch(out, /ZQX|BEGIN_TEXT|END_TEXT|```/);
});

test('un testo che contiene davvero BEGIN_TEXT o END_TEXT resta intero', async () => {
  const source = 'BEGIN_TEXT apre il blocco e il modulo si chiude con END_TEXT';
  const translated = 'BEGIN_TEXT opens the block and the form closes with END_TEXT';
  const calls = stubCodex((messages) => {
    const marker = markerOf(messages);
    assert.ok(marker, 'marcatori della chiamata presenti');
    assert.ok(!source.includes(marker), 'il suffisso non compare nella sorgente');
    return translated;
  });
  assert.equal(await it(source), translated);
  assert.equal(calls.length, 1);
});

test('un eco della sorgente e\' rifiutato e contato, la cascata prosegue', async () => {
  const before = codexCounters();
  const calls = stubCodex(IT);
  assert.equal(await it(), `MYMEMORY ${EN}`);
  assert.equal(calls.length, 1);
  const after = codexCounters();
  assert.equal(after.passthroughs - before.passthroughs, 1);
  assert.equal(after.hits - before.hits, 0);
});

test('un eco del prompt nella risposta singola e\' rifiutato, la cascata prosegue', async () => {
  const before = codexCounters();
  const calls = stubCodex('Der Grenzgänger zahlt Steuern.\n- Localize dates using the target language\'s customary format');
  assert.equal(await it(), `MYMEMORY ${EN}`);
  assert.equal(calls.length, 1);
  const after = codexCounters();
  assert.equal(after.hits - before.hits, 0);
});

test('un eco del prompt in un batch e\' rifiutato per il solo item guasto', async () => {
  const texts = numbered(3);
  const calls = stubCodex(async (messages) => {
    // Lascia partire la prima richiesta da sola: le due successive formano il
    // batch mentre la corsia e' occupata, come nella coda reale.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const items = batchItems(messages);
    if (!items) return translationOf(texts[0]);
    assert.equal(items.length, 2);
    return JSON.stringify({
      items: [
        { id: items[0].id, text: 'System instructions:\nCopy unchanged: URLs' },
        { id: items[1].id, text: translationOf(items[1].text) },
      ],
    });
  });
  const { value } = await captureLog(() => withLanes(1, () => Promise.all(texts.map((text) => it(text)))));
  assert.deepEqual(value, [translationOf(texts[0]), `MYMEMORY ${EN}`, translationOf(texts[2])]);
  assert.equal(calls.length, 2);
  assert.equal(batchItems(calls[0].messages), null);
  assert.equal(batchItems(calls[1].messages).length, 2);
});

test('senza lane (socket assente) il tier si salta in silenzio', async () => {
  const before = codexCounters();
  const calls = stubCodex(`CODEX ${EN}`);
  process.env.CODEX_AUTH_BROKER_SOCKET = path.join(tmp, 'broker-scaduto.sock');
  try {
    const { value, lines } = await captureLog(() => it());
    assert.equal(value, `MYMEMORY ${EN}`);
    assert.equal(lines.filter((l) => l.includes('[codex]')).length, 0);
  } finally {
    process.env.CODEX_AUTH_BROKER_SOCKET = SOCKET;
  }
  delete process.env.CODEX_AUTH_BROKER_SOCKET;
  try {
    assert.equal(await it(), `MYMEMORY ${EN}`);
  } finally {
    process.env.CODEX_AUTH_BROKER_SOCKET = SOCKET;
  }
  process.env.ENABLE_CODEX_ARTICLE_FALLBACK = '0';
  try {
    assert.equal(await it(), `MYMEMORY ${EN}`);
  } finally {
    delete process.env.ENABLE_CODEX_ARTICLE_FALLBACK;
  }
  assert.equal(calls.length, 0);
  assert.equal(codexCounters().errors, before.errors);
});

test('il budget di chiamate ferma il tier con una riga sola', async () => {
  process.env.FREE_TRANSLATE_CODEX_MAX_CALLS = '2';
  try {
    const calls = stubCodex(`CODEX ${EN}`);
    const { value, lines } = await captureLog(async () => [await it(), await it(), await it(), await it()]);
    assert.deepEqual(value, [`CODEX ${EN}`, `CODEX ${EN}`, `MYMEMORY ${EN}`, `MYMEMORY ${EN}`]);
    assert.equal(calls.length, 2);
    assert.equal(lines.filter((l) => l.includes('budget di 2 chiamate esaurito')).length, 1);
    const summary = await captureLog(() => logCascadeSummary());
    assert.ok(summary.lines.some((l) => l.includes('Codex Luna Max: 2/2 calls')));
  } finally {
    delete process.env.FREE_TRANSLATE_CODEX_MAX_CALLS;
  }
});

test('un retry di trasporto fisico consuma una voce del ledger condiviso', async () => {
  process.env.FREE_TRANSLATE_CODEX_MAX_CALLS = '2';
  try {
    const calls = stubCodex(`CODEX ${EN}`);
    assert.equal(await it(), `CODEX ${EN}`);
    assert.equal(getCascadeStats().codexTranslation.calls, 1);
    assert.equal(typeof calls[0].opts.onCodexTransportRetry, 'function');
    assert.equal(calls[0].opts.onCodexTransportRetry(), true);
    assert.equal(getCascadeStats().codexTranslation.calls, 2);
    assert.equal(await it(), `MYMEMORY ${EN}`);
    assert.equal(calls.length, 1, 'il secondo testo non deve superare il budget fisico');
  } finally {
    delete process.env.FREE_TRANSLATE_CODEX_MAX_CALLS;
  }
});

test('le recovery non batch condividono le corsie Codex con il scheduler', async () => {
  process.env.FREE_TRANSLATE_CODEX_LANES = '1';
  try {
    setCodexTranslateCallForTests(null);
    let inFlight = 0;
    let maxInFlight = 0;
    const run = (value) => withCodexTranslationLane({
      run: async ({ deadlineMs }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return `${value}:${deadlineMs > Date.now()}`;
      },
    });
    assert.deepEqual(await Promise.all([run('a'), run('b'), run('c')]), ['a:true', 'b:true', 'c:true']);
    assert.equal(maxInFlight, 1);
  } finally {
    delete process.env.FREE_TRANSLATE_CODEX_LANES;
    setCodexTranslateCallForTests(null);
  }
});

test('una recovery multi-step addebita ogni chiamata iniziale alla lane condivisa', async () => {
  process.env.FREE_TRANSLATE_CODEX_MAX_CALLS = '2';
  setCodexTranslateCallForTests(null);
  try {
    const admissions = await withCodexTranslationLane({
      run: async ({ admitCall }) => {
        const first = admitCall();
        const second = admitCall();
        const refused = admitCall();
        assert.ok(first);
        assert.ok(second);
        assert.equal(refused, null);
        first.finish();
        second.finish();
        return [first.deadlineMs, second.deadlineMs];
      },
    });
    assert.equal(admissions.length, 2);
    assert.equal(getCascadeStats().codexTranslation.calls, 2);
  } finally {
    delete process.env.FREE_TRANSLATE_CODEX_MAX_CALLS;
    setCodexTranslateCallForTests(null);
  }
});

test('un retry fisico non usa una deadline piu\' lunga della chiamata fallita', async () => {
  process.env.FREE_TRANSLATE_CODEX_MAX_CALLS = '2';
  setCodexTranslateCallForTests(null);
  try {
    const result = await withCodexTranslationLane({
      run: async ({ reserveTransportRetry }) => reserveTransportRetry(Date.now() + 10_000),
    });
    assert.equal(result, false);
    assert.equal(getCascadeStats().codexTranslation.calls, 1);
  } finally {
    delete process.env.FREE_TRANSLATE_CODEX_MAX_CALLS;
    setCodexTranslateCallForTests(null);
  }
});

test('le richieste concorrenti non superano il budget, anche quando traducono piu\' testi', async () => {
  // Una corsia: il primo testo parte da solo, i cinque successivi insieme
  // nella seconda richiesta, e il settimo trova il budget di 2 esaurito.
  process.env.FREE_TRANSLATE_CODEX_MAX_CALLS = '2';
  try {
    await withLanes(1, async () => {
      const texts = numbered(7);
      const answer = codexAnswer();
      const calls = stubCodex(async (messages) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return answer(messages);
      });
      const { value } = await captureLog(() => Promise.all(texts.map((text) => it(text))));
      assert.equal(calls.length, 2);
      assert.equal(batchItems(calls[0].messages), null);
      assert.equal(batchItems(calls[1].messages).length, 5);
      assert.deepEqual(value.slice(0, 6), texts.slice(0, 6).map(translationOf));
      assert.equal(value[6], `MYMEMORY ${EN}`);
    });
  } finally {
    delete process.env.FREE_TRANSLATE_CODEX_MAX_CALLS;
  }
});

test('con una corsia le richieste passano una alla volta e non superano insieme il budget di tempo', async () => {
  // Orologio finto: ogni chiamata "dura" 10 s. Con 20 s di budget la prima
  // chiamata lascia 10 s, sotto il minimo di 15 s per chiamata: le altre non
  // partono. Lette in parallelo prima dell'await, tutte e tre avrebbero visto
  // 20 s di residuo e sarebbero partite.
  process.env.FREE_TRANSLATE_CODEX_MAX_MS = '20000';
  process.env.FREE_TRANSLATE_CODEX_LANES = '1';
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    let inFlight = 0;
    let maxInFlight = 0;
    const calls = stubCodex(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      offset += 10_000;
      inFlight -= 1;
      return `CODEX ${EN}`;
    });
    const { value, lines } = await captureLog(() => Promise.all([it(), it(), it()]));
    assert.equal(calls.length, 1);
    assert.equal(maxInFlight, 1);
    assert.deepEqual(value, [`CODEX ${EN}`, `MYMEMORY ${EN}`, `MYMEMORY ${EN}`]);
    assert.equal(lines.filter((l) => l.includes('budget di 20s esaurito')).length, 1);
  } finally {
    Date.now = realNow;
    delete process.env.FREE_TRANSLATE_CODEX_MAX_MS;
    delete process.env.FREE_TRANSLATE_CODEX_LANES;
  }
});

test('il budget di tempo conta l\'orologio: due richieste parallele di 10 s ne costano 10', async () => {
  // Con la somma delle durate due richieste parallele avrebbero speso 20 s e
  // fermato il tier; a orologio ne hanno spesi 10, e la terza parte.
  process.env.FREE_TRANSLATE_CODEX_MAX_MS = '30000';
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    let started = 0;
    let release = () => {};
    const bothStarted = new Promise((resolve) => { release = resolve; });
    const answer = codexAnswer();
    const calls = stubCodex(async (messages) => {
      started += 1;
      if (started === 2) {
        offset += 10_000;
        release();
      }
      if (started <= 2) await bothStarted;
      return answer(messages);
    });
    const [a, b, c] = numbered(3);
    const first = await captureLog(() => Promise.all([it(a), it(b)]));
    assert.deepEqual(first.value, [translationOf(a), translationOf(b)]);
    const third = await captureLog(() => it(c));
    assert.equal(third.value, translationOf(c));
    assert.equal(calls.length, 3);
  } finally {
    Date.now = realNow;
    delete process.env.FREE_TRANSLATE_CODEX_MAX_MS;
  }
});

test('mai piu\' richieste in volo delle corsie del processo', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const answer = codexAnswer();
  const calls = stubCodex(async (messages) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return answer(messages);
  });
  const texts = numbered(6);
  const out = await captureLog(() => Promise.all(texts.map((text) => it(text))));
  assert.deepEqual(out.value, texts.map(translationOf));
  // Default: due corsie. I primi due testi partono da soli; al primo posto
  // libero la coda di 4 si divide per le 2 corsie (gruppo di 2), poi i due
  // testi rimasti partono uno per corsia.
  assert.equal(maxInFlight, 2);
  assert.deepEqual(calls.map((c) => batchItems(c.messages)?.length ?? 1), [1, 1, 2, 1, 1]);
});

test('una voce di gruppo avvolta in una cornice di codice arriva senza cornice', async () => {
  await withLanes(1, async () => {
    const answer = codexAnswer();
    const fence = '```';
    const calls = stubCodex((messages) => {
      const items = batchItems(messages);
      if (!items) return answer(messages);
      return JSON.stringify({ items: items.map(({ id, text }) => ({ id, text: `${fence}\n${translationOf(text)}\n${fence}` })) });
    });
    const texts = numbered(3);
    const { value } = await captureLog(() => Promise.all(texts.map((text) => it(text))));
    assert.equal(calls.length, 2);
    assert.deepEqual(value, texts.map(translationOf));
  });
});

test('il JSON batch recintato passa dalla riparazione comune', async () => {
  await withLanes(1, async () => {
    const answer = codexAnswer();
    const calls = stubCodex((messages) => {
      const items = batchItems(messages);
      if (!items) return answer(messages);
      const payload = JSON.stringify({ items: items.map(({ id, text }) => ({ id, text: translationOf(text) })) });
      const fence = '```';
      return `${fence}json\n${payload}\n${fence}`;
    });
    const texts = numbered(3);
    const { value } = await captureLog(() => Promise.all(texts.map((text) => it(text))));
    assert.equal(calls.length, 2);
    assert.deepEqual(value, texts.map(translationOf));
  });
});

test('la fixture articolo 3 body + meta + FAQ su EN/DE/FR resta in pochi batch', async () => {
  process.env.FREE_TRANSLATE_CODEX_MAX_CALLS = '12';
  try {
    await withLanes(2, async () => {
      const fields = ['meta:title', 'meta:excerpt', 'body1', 'body2', 'body3', 'faq.q', 'faq.a'];
      const locales = ['en', 'de', 'fr'];
      const calls = stubCodex((messages) => {
        const items = batchItems(messages);
        if (items) return JSON.stringify({ items: items.map(({ id, text }) => ({ id, text: `CODEX ${text}` })) });
        return 'CODEX testo singolo';
      });
      const results = await Promise.all(locales.flatMap((locale) => fields.map((field) => freeTranslate({
        text: `${IT} [${locale}/${field}]`,
        sourceLang: 'it',
        targetLang: locale,
        fieldType: field.startsWith('meta:') ? 'title' : 'description',
      }))));
      assert.equal(results.length, 21);
      assert.ok(results.every((value) => value.startsWith('CODEX')));
      assert.equal(calls.length, 8, 'la fixture misurata deve usare 8 richieste batch, non una per segmento');
      assert.ok(calls.length <= 12);
    });
  } finally {
    delete process.env.FREE_TRANSLATE_CODEX_MAX_CALLS;
  }
});

test('un articolo completo da 42 campi resta su Codex oltre il vecchio budget di 16', async () => {
  delete process.env.FREE_TRANSLATE_CODEX_MAX_CALLS;
  await withLanes(2, async () => {
    const fields = [
      ['meta:title', 120],
      ['meta:excerpt', 1400],
      ['body1', 1400],
      ['body2', 1400],
      ['body3', 1400],
      ['faq.q', 1400],
      ['faq.a', 1400],
      ['keyFacts.heading', 120],
      ['keyFacts.one', 300],
      ['keyFacts.two', 300],
      ['keyFacts.three', 300],
      ['source', 250],
      ['cta', 120],
      ['related', 300],
    ];
    const locales = ['en', 'de', 'fr'];
    const before = getCascadeStats();
    const calls = stubCodex((messages) => {
      const items = batchItems(messages);
      if (items) {
        return JSON.stringify({ items: items.map(({ id, text }) => ({ id, text: `CODEX ${text}` })) });
      }
      return 'CODEX testo singolo';
    });
    const unit = `${IT} `;
    const results = await Promise.all(locales.flatMap((locale) => fields.map(([field, chars]) => freeTranslate({
      text: `${unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars)} [${locale}/${field}]`,
      sourceLang: 'it',
      targetLang: locale,
      fieldType: field.startsWith('meta:') || field.endsWith('heading') ? 'title' : 'description',
    }))));
    const after = getCascadeStats();
    assert.equal(results.length, 42);
    assert.equal(after.tierHits.codex - before.tierHits.codex, 42);
    assert.equal(after.tierHits.myMemory - before.tierHits.myMemory, 0);
    assert.ok(calls.length >= 16, `la fixture deve esercitare il budget misurato: ${calls.length}`);
    assert.ok(calls.length <= 32, `il batching deve restare nel budget predefinito: ${calls.length}`);
  });
});

test('FREE_TRANSLATE_CODEX_BATCH_MAX_TEXTS=1 con una corsia torna una richiesta per testo, una alla volta', async () => {
  process.env.FREE_TRANSLATE_CODEX_BATCH_MAX_TEXTS = '1';
  try {
    await withLanes(1, async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      const answer = codexAnswer();
      const calls = stubCodex(async (messages) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return answer(messages);
      });
      const texts = numbered(4);
      const { value } = await captureLog(() => Promise.all(texts.map((text) => it(text))));
      assert.deepEqual(value, texts.map(translationOf));
      assert.equal(calls.length, 4);
      assert.equal(maxInFlight, 1);
      assert.ok(calls.every((c) => batchItems(c.messages) === null));
    });
  } finally {
    delete process.env.FREE_TRANSLATE_CODEX_BATCH_MAX_TEXTS;
  }
});

test('con le corsie occupate i testi in coda partono insieme, con lo schema a id e le regole del testo singolo', async () => {
  await withLanes(1, async () => {
    const calls = stubCodex(codexAnswer());
    const texts = numbered(4);
    const { value } = await captureLog(() => Promise.all(texts.map((text) => it(text))));
    assert.deepEqual(value, texts.map(translationOf));
    assert.equal(calls.length, 2);
    const { messages, opts } = calls[1];
    assert.deepEqual(batchItems(messages), texts.slice(1).map((text, i) => ({ id: i + 1, text })));
    const system = messages.find((m) => m.role === 'system').content;
    assert.match(system, /from Italian to English/);
    assert.match(system, /Translate each item on its own/);
    assert.match(system, /ZQX0XQZ/);
    assert.equal(opts.jsonMode, true);
    assert.equal(opts.deferJsonValidation, true);
    assert.deepEqual(opts.jsonSchema.schema.properties.items.items.required, ['id', 'text']);
    assert.deepEqual(opts.chain, [AI_MODELS.CODEX_CLI_PRIMARY]);
    assert.equal(opts.bypassForceChain, true);
    assert.equal(opts.retryCodexTransport, true);
    assert.equal(opts.codexTransportRetries, 2);
  });
});

test('una voce mancante, vuota o con un id estraneo scende al tier successivo, le altre restano', async () => {
  await withLanes(1, async () => {
    const answer = codexAnswer();
    const calls = stubCodex((messages) => {
      const items = batchItems(messages);
      if (!items) return answer(messages);
      return JSON.stringify({ items: [
        { id: 1, text: translationOf(items[0].text) },
        { id: 2, text: '' },
        { id: 99, text: 'estranea' },
      ] });
    });
    const texts = numbered(4);
    const { value } = await captureLog(() => Promise.all(texts.map((text) => it(text))));
    assert.equal(calls.length, 2);
    assert.deepEqual(value, [translationOf(texts[0]), translationOf(texts[1]), `MYMEMORY ${EN}`, `MYMEMORY ${EN}`]);
  });
});

test('testi identici in coda diventano una voce sola', async () => {
  await withLanes(1, async () => {
    const calls = stubCodex(codexAnswer());
    const [a, b] = numbered(2);
    const { value } = await captureLog(() => Promise.all([it(a), it(b), it(b), it(b)]));
    assert.deepEqual(value, [translationOf(a), translationOf(b), translationOf(b), translationOf(b)]);
    // Tre copie dello stesso testo: una voce, quindi il prompt del testo singolo.
    assert.equal(calls.length, 2);
    assert.equal(batchItems(calls[1].messages), null);
  });
});

test('una richiesta di gruppo fallita e\' un errore per ogni suo testo e un fallimento solo', async () => {
  await withLanes(1, async () => {
    const before = codexCounters();
    const answer = codexAnswer();
    const calls = stubCodex((messages) => {
      if (batchItems(messages)) throw new Error('broker non raggiungibile');
      return answer(messages);
    });
    const texts = numbered(4);
    const { value, lines } = await captureLog(() => Promise.all(texts.map((text) => it(text))));
    assert.equal(calls.length, 2);
    assert.deepEqual(value, [translationOf(texts[0]), `MYMEMORY ${EN}`, `MYMEMORY ${EN}`, `MYMEMORY ${EN}`]);
    assert.equal(codexCounters().errors - before.errors, 3);
    assert.equal(lines.filter((l) => l.includes('fallimenti consecutivi')).length, 0);
  });
});

test('tre fallimenti consecutivi fermano il tier, contati come errori del tier', async () => {
  const before = codexCounters();
  const calls = stubCodex(() => { throw new Error('broker non raggiungibile'); });
  const { value, lines } = await captureLog(async () => [await it(), await it(), await it(), await it()]);
  assert.deepEqual(value, Array(4).fill(`MYMEMORY ${EN}`));
  assert.equal(calls.length, 3);
  assert.equal(codexCounters().errors - before.errors, 3);
  assert.equal(lines.filter((l) => l.includes('3 fallimenti consecutivi')).length, 1);
  // Il messaggio dell'errore non finisce nel log.
  assert.ok(lines.every((l) => !l.includes('broker non raggiungibile')));
});

test('tre echi di fila fermano il tier come tre fallimenti, e restano contati come passthrough', async () => {
  const before = codexCounters();
  const calls = stubCodex(IT);
  const { value, lines } = await captureLog(async () => [await it(), await it(), await it(), await it()]);
  assert.deepEqual(value, Array(4).fill(`MYMEMORY ${EN}`));
  assert.equal(calls.length, 3);
  assert.equal(codexCounters().passthroughs - before.passthroughs, 3);
  assert.equal(lines.filter((l) => l.includes('3 fallimenti consecutivi')).length, 1);
});

test('tre rifiuti di fila fermano il tier come tre fallimenti (review della PR 2166)', async () => {
  // Un rifiuto non e' un eco della sorgente: prima di questa guardia la lane lo
  // contava come traduzione riuscita, azzerava lo streak e non si fermava mai.
  const calls = stubCodex("Sorry, I can't help with that.");
  const { value, lines } = await captureLog(async () => [await it(), await it(), await it(), await it()]);
  assert.deepEqual(value, Array(4).fill(`MYMEMORY ${EN}`));
  assert.equal(calls.length, 3);
  assert.equal(lines.filter((l) => l.includes('3 fallimenti consecutivi')).length, 1);
});

test('la fingerprint della cascata segue la lane Codex e la sua posizione (memo eventi)', async () => {
  // Stato del tier azzerato: il caso precedente lo ha fermato con tre echi.
  stubCodex(`CODEX ${EN}`);
  const key = async () => JSON.parse(await getTranslationCascadeConfigurationKey());
  assert.equal((await key()).version, 5);
  assert.equal((await key()).codex, 'primary');
  process.env.FREE_TRANSLATE_CODEX_TIER = 'last';
  try {
    assert.equal((await key()).codex, 'last');
  } finally {
    delete process.env.FREE_TRANSLATE_CODEX_TIER;
  }
  process.env.CODEX_AUTH_BROKER_SOCKET = path.join(tmp, 'broker-scaduto.sock');
  try {
    assert.equal((await key()).codex, false);
  } finally {
    process.env.CODEX_AUTH_BROKER_SOCKET = SOCKET;
  }
  process.env.FREE_TRANSLATE_CODEX_MAX_CALLS = '0';
  try {
    assert.equal((await key()).codex, false);
  } finally {
    delete process.env.FREE_TRANSLATE_CODEX_MAX_CALLS;
  }
  // Stessa guardia del modello della lane (isModelAvailable): con il
  // kill-switch spento la lane non serve, anche con socket e budget (review
  // di #1869, 5316061360).
  process.env.ENABLE_CODEX_ARTICLE_FALLBACK = '0';
  try {
    assert.equal((await key()).codex, false);
  } finally {
    delete process.env.ENABLE_CODEX_ARTICLE_FALLBACK;
  }
  assert.equal((await key()).codex, 'primary');
});

test('la fingerprint tratta come assente una lane fermata nella run (budget esaurito o breaker)', async () => {
  const key = async () => JSON.parse(await getTranslationCascadeConfigurationKey());
  process.env.FREE_TRANSLATE_CODEX_MAX_CALLS = '1';
  try {
    stubCodex(`CODEX ${EN}`);
    assert.equal((await key()).codex, 'primary');
    await captureLog(() => it());
    // L'unica chiamata ha consumato il budget: la lane non puo' piu' servire
    // la run anche se lo stop si registra solo al tentativo successivo.
    assert.equal((await key()).codex, false);
    await captureLog(() => it());
    assert.equal((await key()).codex, false);
  } finally {
    delete process.env.FREE_TRANSLATE_CODEX_MAX_CALLS;
  }
  // Budget di tempo: una chiamata che lascia meno del minimo per la prossima
  // (15 s) rende la lane assente, anche senza stop registrato.
  process.env.FREE_TRANSLATE_CODEX_MAX_MS = '20000';
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    stubCodex(async () => { offset += 10_000; return `CODEX ${EN}`; });
    assert.equal((await key()).codex, 'primary');
    await captureLog(() => it());
    assert.equal((await key()).codex, false);
  } finally {
    Date.now = realNow;
    delete process.env.FREE_TRANSLATE_CODEX_MAX_MS;
  }
  // Una run nuova (qui: il seam azzera lo stato) riparte con la lane viva.
  stubCodex(`CODEX ${EN}`);
  assert.equal((await key()).codex, 'primary');
});

test('FREE_TRANSLATE_CODEX_TIER=last: Codex non prende il testo prima dei tier senza quota', async () => {
  // DeepL e Azure sono fuori gioco dai casi precedenti: nella posizione di
  // default Codex risponderebbe qui, prima di MyMemory.
  process.env.FREE_TRANSLATE_CODEX_TIER = 'last';
  try {
    const calls = stubCodex(`CODEX ${EN}`);
    assert.equal(await it(), `MYMEMORY ${EN}`);
    assert.equal(calls.length, 0);
  } finally {
    delete process.env.FREE_TRANSLATE_CODEX_TIER;
  }
});

test('FREE_TRANSLATE_CODEX_TIER=last: Codex traduce in coda il testo che ogni altro tier ha lasciato', async () => {
  process.env.FREE_TRANSLATE_CODEX_TIER = 'last';
  free.mymemoryEcho = true;
  try {
    const calls = stubCodex(`CODEX ${EN}`);
    const { value, lines } = await captureLog(() => it());
    assert.equal(value, `CODEX ${EN}`);
    assert.equal(calls.length, 1);
    assert.equal(lines.filter((l) => l.includes('testi che nessun altro tier ha tradotto')).length, 1);
  } finally {
    free.mymemoryEcho = false;
    delete process.env.FREE_TRANSLATE_CODEX_TIER;
  }
});

test('FREE_TRANSLATE_CODEX_TIER=last: un testo rimandato identico da due motori non arriva a Codex', async () => {
  // Un nome o una sigla: ogni motore lo rimanda identico, Codex farebbe lo
  // stesso e tre echi di fila spegnerebbero il tier per i testi veri.
  process.env.FREE_TRANSLATE_CODEX_TIER = 'last';
  free.mymemoryEcho = true;
  free.googleEcho = true;
  try {
    const calls = stubCodex(`CODEX ${EN}`);
    const { value, lines } = await captureLog(async () => {
      const out = await it();
      logCascadeSummary();
      return out;
    });
    assert.equal(value, '');
    assert.equal(calls.length, 0);
    assert.ok(lines.some((l) => /Codex Luna Max \(last\): \d+ texts not sent/.test(l)), lines.join('\n'));
  } finally {
    free.mymemoryEcho = false;
    free.googleEcho = false;
    delete process.env.FREE_TRANSLATE_CODEX_TIER;
  }
});

test('FREE_TRANSLATE_CODEX_TIER=last: l\'eco di un\'istanza in gara (Lingva) conta come motore', async () => {
  // Le istanze in gara hanno un outcome proprio: senza il set condiviso
  // Lingva non entrava fra i motori e Codex partiva lo stesso.
  process.env.FREE_TRANSLATE_CODEX_TIER = 'last';
  free.lingvaEcho = true;
  free.mymemoryEcho = true;
  try {
    const calls = stubCodex(`CODEX ${EN}`);
    const lingvaBefore = getCascadeStats().tierPassthroughs.lingva || 0;
    assert.equal(await it(), '');
    assert.ok((getCascadeStats().tierPassthroughs.lingva || 0) - lingvaBefore >= 1);
    assert.equal(calls.length, 0);
  } finally {
    free.lingvaEcho = false;
    free.mymemoryEcho = false;
    delete process.env.FREE_TRANSLATE_CODEX_TIER;
  }
});

test('FREE_TRANSLATE_CODEX_TIER=last: gli echi di UN solo motore (endpoint e tentativi) non bastano a saltare Codex', async () => {
  // Google gratuito prova due endpoint e tre tentativi: sono piu' echi dello
  // stesso motore, non due motori che concordano.
  process.env.FREE_TRANSLATE_CODEX_TIER = 'last';
  free.googleEcho = true;
  free.mymemoryDown = true;
  try {
    const calls = stubCodex(`CODEX ${EN}`);
    const googleEchoesBefore = getCascadeStats().tierPassthroughs.google || 0;
    assert.equal(await it(), `CODEX ${EN}`);
    assert.ok((getCascadeStats().tierPassthroughs.google || 0) - googleEchoesBefore >= 2);
    assert.equal(calls.length, 1);
  } finally {
    free.googleEcho = false;
    free.mymemoryDown = false;
    delete process.env.FREE_TRANSLATE_CODEX_TIER;
  }
});

test('senza FREE_TRANSLATE_CODEX_TIER la posizione resta quella di default, senza secondo tentativo in coda', async () => {
  free.mymemoryEcho = true;
  try {
    const calls = stubCodex(`CODEX ${EN}`);
    assert.equal(await it(), `CODEX ${EN}`);
    assert.equal(calls.length, 1);
    const failing = stubCodex(() => { throw new Error('broker non raggiungibile'); });
    assert.equal(await it(), '');
    assert.equal(failing.length, 1);
  } finally {
    free.mymemoryEcho = false;
  }
});

// ── Scadenza del processo (run 36309380063 e 36305591991) ─────────────────
// create-article ucciso dal `timeout` del workflow a 657 s con l'articolo IT
// pronto e le traduzioni Codex ancora in corso: il budget del tier (300 s
// cumulati) non conosceva l'orologio del processo.

test('clamp della deadline: minimo fra tetto della chiamata, budget del tier e scadenza del processo', () => {
  const now = 1_000_000;
  // Senza scadenza del processo: invariato rispetto a prima (tetto 180 s).
  assert.equal(codexCallDeadlineMs({ now, budgetRemainingMs: 300_000, processDeadlineMs: null }), now + 180_000);
  // Il budget del tier resta un limite.
  assert.equal(codexCallDeadlineMs({ now, budgetRemainingMs: 40_000, processDeadlineMs: null }), now + 40_000);
  // La scadenza del processo vince quando e' la piu' vicina.
  assert.equal(codexCallDeadlineMs({ now, budgetRemainingMs: 300_000, processDeadlineMs: now + 60_000 }), now + 60_000);
  // E non allunga mai la finestra oltre gli altri due limiti.
  assert.equal(codexCallDeadlineMs({ now, budgetRemainingMs: 300_000, processDeadlineMs: now + 900_000 }), now + 180_000);
  // Sotto il minimo per chiamata (15 s) la chiamata non si avvia.
  assert.equal(codexCallDeadlineMs({ now, budgetRemainingMs: 300_000, processDeadlineMs: now + 14_999 }), null);
  assert.equal(codexCallDeadlineMs({ now, budgetRemainingMs: 300_000, processDeadlineMs: now - 1 }), null);
  assert.equal(codexCallDeadlineMs({ now, budgetRemainingMs: 300_000, processDeadlineMs: now + 15_000 }), now + 15_000);
});

test('le recovery condividono il budget Codex di chiamate e tempo', () => {
  process.env.FREE_TRANSLATE_CODEX_MAX_CALLS = '2';
  process.env.FREE_TRANSLATE_CODEX_MAX_MS = '20000';
  setCodexTranslateCallForTests(null);
  try {
    const first = beginCodexTranslationCall({ now: 1_000, processDeadlineMs: null });
    assert.ok(first);
    assert.equal(getCascadeStats().codexTranslation.calls, 1);
    first.finish(11_000);

    // Restano 10 s, sotto il minimo sicuro di 15 s: il secondo tentativo non
    // deve partire neppure se il cap di chiamate non e' ancora esaurito.
    assert.equal(beginCodexTranslationCall({ now: 11_000, processDeadlineMs: null }), null);
    assert.match(getCascadeStats().codexTranslation.stopReason, /900|budget/);
  } finally {
    delete process.env.FREE_TRANSLATE_CODEX_MAX_CALLS;
    delete process.env.FREE_TRANSLATE_CODEX_MAX_MS;
    setCodexTranslateCallForTests(null);
  }
});

test('scadenza del processo lontana: la deadline passata a Codex non la supera', async () => {
  const deadline = Date.now() + 60_000;
  setCodexTranslateProcessDeadline(deadline);
  try {
    const calls = stubCodex(`CODEX ${EN}`);
    assert.equal(await it(), `CODEX ${EN}`);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].opts.deadlineMs <= deadline, 'la deadline della chiamata supera la scadenza del processo');
    assert.ok(calls[0].opts.deadlineMs > Date.now());
  } finally {
    setCodexTranslateProcessDeadline(null);
  }
});

test('scadenza del processo sotto il minimo per chiamata: Codex non parte, una riga, la cascata prosegue', async () => {
  setCodexTranslateProcessDeadline(Date.now() + 10_000);
  try {
    const calls = stubCodex(`CODEX ${EN}`);
    const { value, lines } = await captureLog(async () => [await it(), await it()]);
    assert.deepEqual(value, [`MYMEMORY ${EN}`, `MYMEMORY ${EN}`]);
    assert.equal(calls.length, 0);
    assert.equal(lines.filter((l) => l.includes('scadenza del processo')).length, 1);
    // Una lane che non puo' piu' servire la run vale come assente anche per
    // la fingerprint della cascata.
    assert.equal(JSON.parse(await getTranslationCascadeConfigurationKey()).codex, false);
  } finally {
    setCodexTranslateProcessDeadline(null);
  }
});

test('la scadenza si rivaluta in coda: la chiamata che la consuma ferma le successive', async () => {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  setCodexTranslateProcessDeadline(realNow() + 30_000);
  // Una corsia: la seconda e la terza aspettano la prima, come prima delle corsie.
  process.env.FREE_TRANSLATE_CODEX_LANES = '1';
  try {
    const calls = stubCodex(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      offset += 20_000;
      return `CODEX ${EN}`;
    });
    const { value } = await captureLog(() => Promise.all([it(), it(), it()]));
    assert.equal(calls.length, 1);
    assert.deepEqual(value, [`CODEX ${EN}`, `MYMEMORY ${EN}`, `MYMEMORY ${EN}`]);
  } finally {
    Date.now = realNow;
    setCodexTranslateProcessDeadline(null);
    delete process.env.FREE_TRANSLATE_CODEX_LANES;
  }
});

// ── Titoli di template nel prompt (gemello del test del sito) ──────────────
//
// Lotto 1 della bonifica Codex (#2121, 20 coppie de): con la sola regola «tieni
// il Markdown dei titoli» Codex rendeva `## Fatti chiave` come `## Eckdaten` e
// `## In breve` come `## Kurz zusammengefasst`, e la guardia dei Fatti chiave
// riconosce solo il titolo canonico. I valori attesi sono scritti qui a mano
// apposta: la tabella del modulo si genera da ai-search-template.mjs, e un
// cambio di quel modulo deve passare da questo test.
const TEMPLATE_EXPECTED = {
  it: ['## In breve', '## Fatti chiave'],
  en: ['## TL;DR', '## Key facts'],
  de: ['## Auf einen Blick', '## Wichtige Fakten'],
  fr: ['## En bref', '## Faits clés'],
};
const promptModule = await import('../scripts/lib/free-translate.mjs');
const templateModule = await import('../scripts/lib/ai-search-template.mjs');
const systemOf = (messages) => messages.find((m) => m.role === 'system').content;
const templateRule = (target) => {
  const [tldr, keyFacts] = TEMPLATE_EXPECTED[target];
  return `write the heading line "## In breve" as "${tldr}" and "## Fatti chiave" as "${keyFacts}", exactly, never with a synonym.`;
};

test('titoli di template: la tabella del tier coincide con ai-search-template.mjs', () => {
  const table = promptModule.CODEX_TEMPLATE_HEADINGS;
  assert.deepEqual(Object.keys(table).sort(), ['de', 'en', 'fr', 'it']);
  for (const [lang, headings] of Object.entries(table)) {
    assert.deepEqual([...headings], [templateModule.getTldrHeading(lang), templateModule.getKeyFactsHeading(lang)], lang);
    assert.deepEqual([...headings], TEMPLATE_EXPECTED[lang], lang);
  }
});

test('titoli di template: richiesta singola e a gruppi it→en/de/fr portano il canonico della lingua di arrivo', () => {
  for (const target of ['en', 'de', 'fr']) {
    const single = systemOf(promptModule.codexTranslatePromptsForTests.single('## In breve\n- uno', 'it', target));
    const batch = systemOf(promptModule.codexTranslatePromptsForTests.batch(['## In breve\n- uno', '## Fatti chiave\n- x: y'], 'it', target));
    assert.ok(single.includes(templateRule(target)), `singola it→${target}`);
    assert.ok(batch.includes(templateRule(target)), `gruppo it→${target}`);
  }
  assert.ok(!systemOf(promptModule.codexTranslatePromptsForTests.single('testo', 'it', 'es')).includes('Template headings'));
});

test('titoli di template: la bonifica (`translateWithCodexEngine`) manda la regola a Codex', async () => {
  const seen = [];
  await promptModule.translateWithCodexEngine({
    text: '## In breve\n- Il permesso G si rinnova ogni cinque anni.\n\n## Fatti chiave\n- **Cosa**: rinnovo del permesso G.',
    sourceLang: 'it',
    targetLang: 'de',
    call: async (messages) => {
      seen.push(messages);
      return '## Auf einen Blick\n- Die Bewilligung G wird alle fünf Jahre erneuert.\n\n## Wichtige Fakten\n- **Was**: Erneuerung der Bewilligung G.';
    },
  });
  assert.equal(seen.length, 1);
  assert.ok(systemOf(seen[0]).includes(templateRule('de')));
});
