/**
 * Tier Codex Luna Max della cascata MT (decisione del proprietario del
 * 2026-09-25: «Quando deepl e azure translation sono fuori quota USA codex luna
 * Max»). Gemello di tests/free-translate-codex-tier.test.ts del sito.
 *
 * ── COSA PINNA ─────────────────────────────────────────────────────────────
 *
 *   · il tier entra SOLO quando DeepL e Azure sono fuori gioco per la run
 *     (chiavi esaurite), non quando falliscono su un testo solo;
 *   · senza lane (socket del broker assente) si salta in silenzio;
 *   · il budget per processo (FREE_TRANSLATE_CODEX_MAX_CALLS) e i fallimenti
 *     consecutivi fermano il tier con UNA riga di log;
 *   · la risposta passa da `tryTier`/`finalize` come ogni altro tier: un eco
 *     della sorgente e' rifiutato e contato in `tierPassthroughs.codex`, i
 *     token protetti tornano nella forma della lingua di arrivo.
 *
 * Nessuna rete e nessun Codex vero: `fetch` e' uno stub (DeepL, Azure e
 * MyMemory) e la chiamata a Codex passa da `setCodexTranslateCallForTests`.
 * Le chiavi DeepL/Azure sono lette all'import del modulo, quindi l'ambiente si
 * prepara PRIMA dell'import dinamico; `node --test` isola ogni file nel suo
 * processo, e lo stato dei tier (chiavi esaurite) prosegue fra i casi
 * nell'ordine in cui sono scritti.
 */
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
  'FREE_TRANSLATE_CODEX_MAX_CALLS', 'FREE_TRANSLATE_CODEX_MAX_MS',
]) delete process.env[key];
process.env.DEEPL_API_KEY = 'deepl-finta';
process.env.AZURE_TRANSLATOR_KEY = 'azure-finta';
process.env.CODEX_AUTH_BROKER_SOCKET = SOCKET;
// Salta le attese fra retry e chunk della cascata (vedi `delay`).
process.env.VITEST = '1';

const {
  freeTranslate,
  getCascadeStats,
  logCascadeSummary,
  setCodexTranslateCallForTests,
} = await import('../scripts/lib/free-translate.mjs');
const { AI_MODELS } = await import('../scripts/lib/ai-models.mjs');

after(() => {
  setCodexTranslateCallForTests(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const IT = 'Il permesso G si rinnova ogni cinque anni presso l\'ufficio della migrazione del Cantone Ticino.';
const EN = 'The G permit is renewed every five years at the migration office of the Canton of Ticino.';

const premium = { deepl: 200, azure: 200 };
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
  if (u.includes('api.mymemory.translated.net')) {
    return { ok: true, json: async () => ({ responseData: { translatedText: `MYMEMORY ${EN}`, match: 1 } }) };
  }
  throw new Error('offline nel test');
};
after(() => { globalThis.fetch = realFetch; });

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

test('DeepL sano: Codex non viene chiamato', async () => {
  const calls = stubCodex(`CODEX ${EN}`);
  assert.equal(await it(), `DEEPL ${EN}`);
  assert.equal(calls.length, 0);
});

test('DeepL e Azure giu\' su UN testo (5xx), chiavi non esaurite: niente Codex, scende ai tier free', async () => {
  premium.deepl = 500;
  premium.azure = 500;
  const calls = stubCodex(`CODEX ${EN}`);
  assert.equal(await it(), `MYMEMORY ${EN}`);
  assert.equal(calls.length, 0);
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

  const { messages, opts } = calls[0];
  const system = messages.find((m) => m.role === 'system').content;
  assert.match(system, /from Italian to English/);
  assert.match(system, /Translate only/);
  assert.match(system, /\*\*bold\*\*/);
  assert.match(system, /URLs/);
  assert.match(system, /ZQX0XQZ/);
  assert.match(system, /translated text only/);
  assert.equal(messages.find((m) => m.role === 'user').content, `BEGIN_TEXT\n${IT}\nEND_TEXT`);
  assert.deepEqual(opts.chain, [AI_MODELS.CODEX_CLI_PRIMARY]);
  assert.deepEqual(opts.prefer, [AI_MODELS.CODEX_CLI_PRIMARY]);
  assert.equal(opts.bypassForceChain, true);
  assert.ok(opts.deadlineMs > Date.now() && opts.deadlineMs <= Date.now() + 180_000);
});

test('la risposta passa da finalize: cornice tolta, token protetto rimesso nella lingua di arrivo', async () => {
  const calls = stubCodex((messages) => {
    const user = messages.find((m) => m.role === 'user').content;
    const token = /ZQX\d+XQZ/.exec(user)?.[0];
    assert.ok(token, 'il trigramma di genere deve arrivare mascherato');
    return `\`\`\`\nBEGIN_TEXT\nInfermiere diplomato ${token}\nEND_TEXT\n\`\`\``;
  });
  const out = await freeTranslate({ text: 'Pflegefachperson HF (m/w/d)', sourceLang: 'de', targetLang: 'it' });
  assert.equal(calls.length, 1);
  assert.match(out, /^Infermiere diplomato/);
  assert.doesNotMatch(out, /ZQX|BEGIN_TEXT|END_TEXT|```/);
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

test('le chiamate concorrenti non superano il budget', async () => {
  process.env.FREE_TRANSLATE_CODEX_MAX_CALLS = '3';
  try {
    const calls = stubCodex(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return `CODEX ${EN}`;
    });
    const out = await captureLog(() => Promise.all(Array.from({ length: 6 }, () => it())));
    assert.equal(calls.length, 3);
    assert.equal(out.value.filter((v) => v === `CODEX ${EN}`).length, 3);
  } finally {
    delete process.env.FREE_TRANSLATE_CODEX_MAX_CALLS;
  }
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
