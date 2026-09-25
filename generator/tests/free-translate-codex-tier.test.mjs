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
 *     token protetti tornano nella forma della lingua di arrivo;
 *   · la cornice si toglie solo con i marcatori della chiamata: un testo che
 *     contiene davvero `END_TEXT` resta intero;
 *   · le chiamate del processo passano una alla volta, quindi le chiamate
 *     concorrenti non superano insieme il budget di tempo;
 *   · con FREE_TRANSLATE_CODEX_TIER=last (translate-pending, dopo Argos) il tier
 *     non prende il testo prima dei tier senza quota: lo traduce in coda, solo
 *     quando ogni altro tier lo ha lasciato non tradotto.
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
  getTranslationCascadeConfigurationKey,
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
// MyMemory che rimanda la sorgente: eco rifiutato, la cascata prosegue fino in fondo.
const free = { mymemoryEcho: false };
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
    const translatedText = free.mymemoryEcho ? new URL(u).searchParams.get('q') : `MYMEMORY ${EN}`;
    return { ok: true, json: async () => ({ responseData: { translatedText, match: 1 } }) };
  }
  throw new Error('offline nel test');
};
after(() => { globalThis.fetch = realFetch; });

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

test('le chiamate concorrenti passano una alla volta e non superano insieme il budget di tempo', async () => {
  // Orologio finto: ogni chiamata "dura" 10 s. Con 20 s di budget la prima
  // chiamata lascia 10 s, sotto il minimo di 15 s per chiamata: le altre non
  // partono. Lette in parallelo prima dell'await, tutte e tre avrebbero visto
  // 20 s di residuo e sarebbero partite.
  process.env.FREE_TRANSLATE_CODEX_MAX_MS = '20000';
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
  }
});

test('in coda le chiamate non si sovrappongono mai', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const calls = stubCodex(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return `CODEX ${EN}`;
  });
  const out = await captureLog(() => Promise.all(Array.from({ length: 4 }, () => it())));
  assert.deepEqual(out.value, Array(4).fill(`CODEX ${EN}`));
  assert.equal(calls.length, 4);
  assert.equal(maxInFlight, 1);
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

test('la fingerprint della cascata segue la lane Codex e la sua posizione (memo eventi)', () => {
  // Stato del tier azzerato: il caso precedente lo ha fermato con tre echi.
  stubCodex(`CODEX ${EN}`);
  const key = () => JSON.parse(getTranslationCascadeConfigurationKey());
  assert.equal(key().version, 2);
  assert.equal(key().codex, 'after-premium');
  process.env.FREE_TRANSLATE_CODEX_TIER = 'last';
  try {
    assert.equal(key().codex, 'last');
  } finally {
    delete process.env.FREE_TRANSLATE_CODEX_TIER;
  }
  process.env.CODEX_AUTH_BROKER_SOCKET = path.join(tmp, 'broker-scaduto.sock');
  try {
    assert.equal(key().codex, false);
  } finally {
    process.env.CODEX_AUTH_BROKER_SOCKET = SOCKET;
  }
  process.env.FREE_TRANSLATE_CODEX_MAX_CALLS = '0';
  try {
    assert.equal(key().codex, false);
  } finally {
    delete process.env.FREE_TRANSLATE_CODEX_MAX_CALLS;
  }
});

test('la fingerprint tratta come assente una lane fermata nella run (budget esaurito o breaker)', async () => {
  const key = () => JSON.parse(getTranslationCascadeConfigurationKey());
  process.env.FREE_TRANSLATE_CODEX_MAX_CALLS = '1';
  try {
    stubCodex(`CODEX ${EN}`);
    assert.equal(key().codex, 'after-premium');
    await captureLog(async () => [await it(), await it()]);
    // Seconda chiamata: budget di 1 esaurito, tier fermato.
    assert.equal(key().codex, false);
  } finally {
    delete process.env.FREE_TRANSLATE_CODEX_MAX_CALLS;
  }
  // Una run nuova (qui: il seam azzera lo stato) riparte con la lane viva.
  stubCodex(`CODEX ${EN}`);
  assert.equal(key().codex, 'after-premium');
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
