/**
 * GUARDIA «uscita == sorgente» della cascata MT — gemello corpus della fix
 * aperta sul sito (voce `identical` del manifest, `sitePath:
 * scripts/lib/free-translate.mjs`).
 *
 * ── COSA PINNA ─────────────────────────────────────────────────────────────
 *
 * La cascata poteva rendere la SORGENTE ITALIANA verbatim e nessuno se ne
 * accorgeva. Il predicato di scarto a valle — `translateFieldFreeMt` in
 * `lib/article-free-mt.mjs`, che chiama `hasUsableContentText` — butta via tre
 * cose: il contenuto vuoto, il marker di fallimento `null`, la sentinella nav
 * mangled. Un passthrough italiano non e' nessuna delle tre: e' testo
 * perfettamente valido, quindi passava. Da cui il fatto che il 2026-09-06 la
 * stessa classe di difetto abbia colpito tre scrittori diversi
 * (`retranslate-blocking-bodies.mjs` #994, `repair-object-object-bodies.mjs`
 * valerielinc-ops#7704, `batch-add-faq-to-articles.mjs` valerielinc-ops#7710):
 * ognuno doveva difendersi da solo, e nessuno lo faceva.
 *
 * Misura del difetto su questo repo (2026-09-06, `content/blog-body` +
 * `content/blog-body-ch`): 27 campi body su 51'141 sono l'italiano verbatim
 * sotto `/en/`, `/de/`, `/fr/`. La guardia li intercetta 27 su 27.
 *
 * ── PERCHE' LE ASSERZIONI GUARDANO LA RAGIONE ──────────────────────────────
 *
 * `freeTranslate` rende '' per DUE motivi diversi — «ho rifiutato una
 * non-traduzione» e «i motori sono giu'» — e sul solo valore di ritorno sono
 * indistinguibili. Un test sul solo esito sarebbe verde contro una guardia
 * troppo entusiasta che etichetta come passthrough un fallimento di rete:
 * l'ultimo caso di questo file pinna proprio quella differenza.
 *
 * ── FALSIFICAZIONE, misurata sul gemello del sito nei due versi ────────────
 *
 *   · aggancio rimosso da `tryTier` (difetto reintrodotto) → 3 rossi, i casi
 *     inversi restano verdi;
 *   · `isSourcePassthrough` forzata a `false` (regola spenta) → 4 rossi, i casi
 *     inversi restano verdi;
 *   · `isSourcePassthrough` forzata a `true` (rifiuta tutto) → 3 rossi, tutti
 *     nei casi inversi: le asserzioni che pinnano il comportamento legittimo
 *     mordono davvero, non sono decorative.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  freeTranslate,
  freeTranslateWithRetryDetailed,
  getCascadeStats,
  logCascadeSummary,
  isSourcePassthrough,
  asTranslationResult,
} from '../scripts/lib/free-translate.mjs';
import { setLocalOpusMtForTests } from '../scripts/lib/local-opus-mt.mjs';

const IT = [
  '## In breve',
  '- I frontalieri residenti entro venti chilometri dal confine restano nel vecchio regime fiscale',
  '- La soglia dei quarantacinque giorni di telelavoro vale dal primo gennaio',
  '',
  'Chi ha iniziato a lavorare in Svizzera dopo il 2023 rientra fra i nuovi frontalieri e paga le imposte in entrambi i Paesi.',
].join('\n');

const EN = [
  '## In brief',
  '- Cross-border workers living within twenty kilometres of the border stay in the old tax regime',
  '- The forty-five day teleworking threshold applies from the first of January',
  '',
  'Anyone who started working in Switzerland after 2023 falls under the new cross-border worker rules and pays tax in both countries.',
].join('\n');

const realFetch = globalThis.fetch;
const realVitestFlag = process.env.VITEST;

test('non usa più il flag outcomeNoted morto nel percorso Azure', () => {
  const source = readFileSync(new URL('../scripts/lib/free-translate.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /outcomeNoted/);
});

/**
 * Pilota la cascata dal basso: `translateWithMyMemory` e' l'unico tier
 * raggiungibile senza credenziali (DeepL, Azure, Google Cloud e LibreTranslate
 * self-hosted escono '' da soli quando la chiave o l'URL non sono in env), e
 * tutti i tier SOTTO di lui parlano via `fetch`. Uno stub che risponde solo
 * all'endpoint MyMemory e respinge tutto il resto rende il test deterministico
 * e OFFLINE: senza, il caso «passthrough rifiutato» proseguirebbe la cascata
 * fino a endpoint pubblici veri e il verdetto dipenderebbe dalla rete.
 */
function stubCascade(myMemoryAnswer) {
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.mymemory.translated.net')) {
      if (myMemoryAnswer === null) return { ok: false, status: 503 };
      return {
        ok: true,
        json: async () => ({ responseData: { translatedText: myMemoryAnswer, match: 1 } }),
      };
    }
    throw new Error('offline nel test');
  };
}

/** Delta dei contatori: sono globali di modulo e non c'e' un reset esportato. */
function snapshot() {
  const s = getCascadeStats();
  return { hits: s.tierHits.myMemory || 0, passthroughs: s.tierPassthroughs.myMemory || 0 };
}

describe('freeTranslate — guardia «uscita == sorgente»', () => {
  beforeEach(() => {
    // Il tier MyMemory distanzia le chiamate di un secondo, tranne quando sa di
    // avere una `fetch` finta davanti. Qui ce l'ha: senza questo flag il file
    // pagherebbe secondi di attesa per un'API che non esiste.
    process.env.VITEST = '1';
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realVitestFlag === undefined) delete process.env.VITEST;
    else process.env.VITEST = realVitestFlag;
  });

  test('rifiuta il motore che rende la sorgente verbatim, e lo dice come passthrough non come errore', async () => {
    stubCascade(IT); // IL DIFETTO: il motore risponde 200 con l'italiano d'ingresso.
    const before = snapshot();

    const out = await freeTranslate({ text: IT, sourceLang: 'it', targetLang: 'en', fieldType: 'description' });
    const after = snapshot();

    assert.equal(out, '');
    // La RAGIONE, non solo l'esito: il tier e' contato come passthrough e NON
    // come hit.
    assert.equal(after.passthroughs - before.passthroughs, 1);
    assert.equal(after.hits - before.hits, 0);
  });

  test('rifiuta anche il passthrough con spaziatura e maiuscole cambiate (confronto normalizzato, non `===`)', async () => {
    stubCascade(IT.replace(/ /g, '  ').replace('## In breve', '## IN BREVE'));
    const before = snapshot();

    const out = await freeTranslate({ text: IT, sourceLang: 'it', targetLang: 'de', fieldType: 'description' });

    assert.equal(out, '');
    assert.equal(snapshot().passthroughs - before.passthroughs, 1);
  });

  test('nomina il passthrough nel sommario della cascata', async () => {
    stubCascade(IT);
    await freeTranslate({ text: IT, sourceLang: 'it', targetLang: 'fr', fieldType: 'description' });

    const lines = [];
    const realLog = console.log;
    console.log = (...a) => { lines.push(a.join(' ')); };
    try {
      logCascadeSummary();
    } finally {
      console.log = realLog;
    }

    const summary = lines.join('\n');
    assert.match(summary, /Tier passthrough/);
    assert.match(summary, /myMemory=\d+/);
  });

  // ── IL VERSO INVERSO: cio' che NON deve cambiare ───────────────────────────

  test('lascia passare una traduzione vera e la conta come hit', async () => {
    stubCascade(EN);
    const before = snapshot();

    const out = await freeTranslate({ text: IT, sourceLang: 'it', targetLang: 'en', fieldType: 'description' });
    const after = snapshot();

    assert.notEqual(out, '');
    assert.match(out, /Cross-border workers/);
    assert.equal(after.hits - before.hits, 1);
    assert.equal(after.passthroughs - before.passthroughs, 0);
  });

  test('non tocca il passthrough LEGITTIMO sourceLang === targetLang', async () => {
    let called = false;
    globalThis.fetch = async () => { called = true; throw new Error('nessun tier va chiamato'); };
    const before = snapshot();

    const out = await freeTranslate({ text: IT, sourceLang: 'it', targetLang: 'it', fieldType: 'description' });

    // Questo ramo esce PRIMA della cascata ed e' l'identita' voluta: renderla
    // '' spegnerebbe ogni chiamante che normalizza testo senza tradurlo.
    assert.equal(out, IT);
    assert.equal(called, false);
    assert.equal(snapshot().passthroughs - before.passthroughs, 0);
  });

  test('non spaccia un motore GIU\' per un passthrough', async () => {
    stubCascade(null); // ogni tier fallisce davvero
    const before = snapshot();

    const out = await freeTranslate({ text: IT, sourceLang: 'it', targetLang: 'en', fieldType: 'description' });
    const after = snapshot();

    assert.equal(out, '');
    assert.equal(after.passthroughs - before.passthroughs, 0);
    assert.equal(after.hits - before.hits, 0);
  });

  test('il dettaglio del retry non memoizza un eco quando altri endpoint sono indisponibili', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).includes('api.mymemory.translated.net')) {
        return {
          ok: true,
          json: async () => ({ responseData: { translatedText: IT, match: 1 } }),
        };
      }
      return { ok: false, status: 503 };
    };

    const out = await freeTranslateWithRetryDetailed({
      text: IT,
      sourceLang: 'it',
      targetLang: 'en',
      fieldType: 'description',
      maxRetries: 0,
    });

    assert.deepEqual(out, { text: '', passthrough: false });
  });

  test('un errore nella stessa chiamata impedisce il memo del passthrough', async () => {
    stubCascade(IT);

    const out = await freeTranslateWithRetryDetailed({
      text: IT,
      sourceLang: 'it',
      targetLang: 'en',
      fieldType: 'description',
      maxRetries: 0,
    });

    assert.deepEqual(out, { text: '', passthrough: false });
  });

  test('un HTTP failure del self-hosted LibreTranslate impedisce il memo del passthrough', () => {
    const moduleUrl = new URL('../scripts/lib/free-translate.mjs', import.meta.url).href;
    const childScript = `
      globalThis.fetch = async (url) => {
        const value = String(url);
        if (value.startsWith('http://self-hosted.test/')) return { ok: false, status: 503 };
        if (value.includes('api.mymemory.translated.net')) {
          return { ok: true, json: async () => ({ responseData: { translatedText: ${JSON.stringify(IT)}, match: 1 } }) };
        }
        if (value.includes('translate.googleapis.com')) {
          return { ok: true, text: async () => JSON.stringify([[ [${JSON.stringify(IT)}] ]]) };
        }
        if (value.includes('clients5.google.com')) {
          return { ok: true, text: async () => JSON.stringify({ sentences: [{ trans: ${JSON.stringify(IT)} }] }) };
        }
        if (value.includes('/api/v1/')) return { ok: true, json: async () => ({ translation: ${JSON.stringify(IT)} }) };
        if (value.includes('/api/translate')) return { ok: true, json: async () => ({ 'translated-text': ${JSON.stringify(IT)} }) };
        if (value.includes('/translate')) return { ok: true, json: async () => ({ translatedText: ${JSON.stringify(IT)} }) };
        throw new Error('endpoint inatteso nel test');
      };
      const { freeTranslateWithRetryDetailed } = await import(${JSON.stringify(moduleUrl)});
      const out = await freeTranslateWithRetryDetailed({
        text: ${JSON.stringify(IT)}, sourceLang: 'it', targetLang: 'en', fieldType: 'description', maxRetries: 0,
      });
      if (JSON.stringify(out) !== JSON.stringify({ text: '', passthrough: false })) {
        console.error(JSON.stringify(out));
        process.exit(1);
      }
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', childScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DEEPL_API_KEY: '',
        DEEPL_API_KEY_2: '',
        AZURE_TRANSLATOR_KEY: '',
        AZURE_TRANSLATOR_KEY_2: '',
        GSC_CLIENT_ID: '',
        GSC_CLIENT_SECRET: '',
        GSC_REFRESH_TOKEN: '',
        HF_TOKEN: '',
        HUGGINGFACE_API_KEY: '',
        LIBRETRANSLATE_SELF_HOSTED_URL: 'http://self-hosted.test',
        VITEST: '1',
      },
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
  });

  test('un tier opzionale disabilitato non blocca il memo del passthrough', () => {
    const moduleUrl = new URL('../scripts/lib/free-translate.mjs', import.meta.url).href;
    const childScript = `
      globalThis.fetch = async (url) => {
        const value = String(url);
        if (value.includes('api.mymemory.translated.net')) {
          return { ok: true, json: async () => ({ responseData: { translatedText: ${JSON.stringify(IT)}, match: 1 } }) };
        }
        if (value.includes('translate.googleapis.com')) {
          return { ok: true, text: async () => JSON.stringify([[ [${JSON.stringify(IT)}] ]]) };
        }
        if (value.includes('clients5.google.com')) {
          return { ok: true, text: async () => JSON.stringify({ sentences: [{ trans: ${JSON.stringify(IT)} }] }) };
        }
        if (value.includes('/api/v1/')) return { ok: true, json: async () => ({ translation: ${JSON.stringify(IT)} }) };
        if (value.includes('/api/translate')) return { ok: true, json: async () => ({ 'translated-text': ${JSON.stringify(IT)} }) };
        if (value.includes('/translate')) return { ok: true, json: async () => ({ translatedText: ${JSON.stringify(IT)} }) };
        throw new Error('endpoint inatteso nel test');
      };
      const { freeTranslateWithRetryDetailed } = await import(${JSON.stringify(moduleUrl)});
      const out = await freeTranslateWithRetryDetailed({
        text: ${JSON.stringify(IT)}, sourceLang: 'it', targetLang: 'en', fieldType: 'description', maxRetries: 0,
      });
      if (JSON.stringify(out) !== JSON.stringify({ text: '', passthrough: true })) {
        console.error(JSON.stringify(out));
        process.exit(1);
      }
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', childScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DEEPL_API_KEY: '',
        DEEPL_API_KEY_2: '',
        AZURE_TRANSLATOR_KEY: '',
        AZURE_TRANSLATOR_KEY_2: '',
        GSC_CLIENT_ID: '',
        GSC_CLIENT_SECRET: '',
        GSC_REFRESH_TOKEN: '',
        HF_TOKEN: '',
        HUGGINGFACE_API_KEY: '',
        LIBRETRANSLATE_SELF_HOSTED_URL: '',
        MT_LOCAL_OPUSMT: '',
        VITEST: '1',
      },
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
  });

  test('una risposta 200 vuota del self-hosted LibreTranslate non è un passthrough', () => {
    const moduleUrl = new URL('../scripts/lib/free-translate.mjs', import.meta.url).href;
    const childScript = `
      globalThis.fetch = async (url) => {
        const value = String(url);
        if (value.includes('self-hosted.test')) return { ok: true, json: async () => ({}) };
        if (value.includes('api-free.deepl.com')) {
          return { ok: true, json: async () => ({ translations: [{ text: ${JSON.stringify(IT)} }] }) };
        }
        if (value.includes('cognitive.microsofttranslator.com')) {
          return { ok: true, json: async () => [{ translations: [{ text: ${JSON.stringify(IT)} }] }] };
        }
        if (value.includes('oauth2.googleapis.com/token')) {
          return { ok: true, json: async () => ({ access_token: 'test-token', expires_in: 3600 }) };
        }
        if (value.includes('translation.googleapis.com')) {
          return { ok: true, json: async () => ({ data: { translations: [{ translatedText: ${JSON.stringify(IT)} }] } }) };
        }
        if (value.includes('router.huggingface.co')) {
          return { ok: true, json: async () => ([{ translation_text: ${JSON.stringify(IT)} }]) };
        }
        if (value.includes('api.mymemory.translated.net')) {
          return { ok: true, json: async () => ({ responseData: { translatedText: ${JSON.stringify(IT)}, match: 1 } }) };
        }
        if (value.includes('translate.googleapis.com')) {
          return { ok: true, text: async () => JSON.stringify([[ [${JSON.stringify(IT)}] ]]) };
        }
        if (value.includes('clients5.google.com')) {
          return { ok: true, text: async () => JSON.stringify({ sentences: [{ trans: ${JSON.stringify(IT)} }] }) };
        }
        if (value.includes('/api/v1/')) return { ok: true, json: async () => ({ translation: ${JSON.stringify(IT)} }) };
        if (value.includes('/api/translate')) return { ok: true, json: async () => ({ 'translated-text': ${JSON.stringify(IT)} }) };
        if (value.includes('/translate')) return { ok: true, json: async () => ({ translatedText: ${JSON.stringify(IT)} }) };
        throw new Error('endpoint inatteso nel test');
      };
      const { freeTranslateWithRetryDetailed } = await import(${JSON.stringify(moduleUrl)});
      const out = await freeTranslateWithRetryDetailed({
        text: ${JSON.stringify(IT)}, sourceLang: 'it', targetLang: 'en', fieldType: 'description', maxRetries: 0,
      });
      if (JSON.stringify(out) !== JSON.stringify({ text: '', passthrough: false })) {
        console.error(JSON.stringify(out));
        process.exit(1);
      }
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', childScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DEEPL_API_KEY: 'test-key',
        DEEPL_API_KEY_2: '',
        AZURE_TRANSLATOR_KEY: 'test-key',
        AZURE_TRANSLATOR_KEY_2: '',
        GSC_CLIENT_ID: 'test-client',
        GSC_CLIENT_SECRET: 'test-secret',
        GSC_REFRESH_TOKEN: 'test-refresh',
        HF_TOKEN: 'test-token',
        HUGGINGFACE_API_KEY: '',
        LIBRETRANSLATE_SELF_HOSTED_URL: 'http://self-hosted.test',
        MT_LOCAL_OPUSMT: '',
        VITEST: '1',
      },
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
  });

  test('tier opzionali non configurati non bloccano il memo del passthrough', () => {
    const moduleUrl = new URL('../scripts/lib/free-translate.mjs', import.meta.url).href;
    const childScript = `
      globalThis.fetch = async (url) => {
        const value = String(url);
        if (value.includes('api.mymemory.translated.net')) {
          return { ok: true, json: async () => ({ responseData: { translatedText: ${JSON.stringify(IT)}, match: 1 } }) };
        }
        if (value.includes('translate.googleapis.com')) {
          return { ok: true, text: async () => JSON.stringify([[ [${JSON.stringify(IT)}] ]]) };
        }
        if (value.includes('clients5.google.com')) {
          return { ok: true, text: async () => JSON.stringify({ sentences: [{ trans: ${JSON.stringify(IT)} }] }) };
        }
        if (value.includes('/api/v1/')) return { ok: true, json: async () => ({ translation: ${JSON.stringify(IT)} }) };
        if (value.includes('/api/translate')) return { ok: true, json: async () => ({ 'translated-text': ${JSON.stringify(IT)} }) };
        if (value.includes('/translate')) return { ok: true, json: async () => ({ translatedText: ${JSON.stringify(IT)} }) };
        throw new Error('endpoint inatteso nel test');
      };
      const { freeTranslateWithRetryDetailed } = await import(${JSON.stringify(moduleUrl)});
      const out = await freeTranslateWithRetryDetailed({
        text: ${JSON.stringify(IT)}, sourceLang: 'it', targetLang: 'en', fieldType: 'description', maxRetries: 0,
      });
      if (JSON.stringify(out) !== JSON.stringify({ text: '', passthrough: true })) {
        console.error(JSON.stringify(out));
        process.exit(1);
      }
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', childScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DEEPL_API_KEY: '',
        DEEPL_API_KEY_2: '',
        AZURE_TRANSLATOR_KEY: '',
        AZURE_TRANSLATOR_KEY_2: '',
        GSC_CLIENT_ID: '',
        GSC_CLIENT_SECRET: '',
        GSC_REFRESH_TOKEN: '',
        HF_TOKEN: '',
        HUGGINGFACE_API_KEY: '',
        LIBRETRANSLATE_SELF_HOSTED_URL: '',
        MT_LOCAL_OPUSMT: '',
        VITEST: '1',
      },
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
  });

  test('la cascata reale memoizza un eco del self-hosted senza errori', () => {
    const moduleUrl = new URL('../scripts/lib/free-translate.mjs', import.meta.url).href;
    const childScript = `
      let selfHostedCalls = 0;
      globalThis.fetch = async (url) => {
        const value = String(url);
        if (value.startsWith('http://self-hosted.test/')) {
          selfHostedCalls += 1;
          return { ok: true, json: async () => ({ translatedText: ${JSON.stringify(IT)} }) };
        }
        if (value.includes('api.mymemory.translated.net')) {
          return { ok: true, json: async () => ({ responseData: { translatedText: ${JSON.stringify(IT)}, match: 1 } }) };
        }
        if (value.includes('translate.googleapis.com')) {
          return { ok: true, text: async () => JSON.stringify([[ [${JSON.stringify(IT)}] ]]) };
        }
        if (value.includes('clients5.google.com')) {
          return { ok: true, text: async () => JSON.stringify({ sentences: [{ trans: ${JSON.stringify(IT)} }] }) };
        }
        if (value.includes('/api/v1/')) return { ok: true, json: async () => ({ translation: ${JSON.stringify(IT)} }) };
        if (value.includes('/api/translate')) return { ok: true, json: async () => ({ 'translated-text': ${JSON.stringify(IT)} }) };
        if (value.includes('/translate')) return { ok: true, json: async () => ({ translatedText: ${JSON.stringify(IT)} }) };
        throw new Error('endpoint inatteso nel test');
      };
      const { freeTranslateWithRetryDetailed } = await import(${JSON.stringify(moduleUrl)});
      const out = await freeTranslateWithRetryDetailed({
        text: ${JSON.stringify(IT)}, sourceLang: 'it', targetLang: 'en', fieldType: 'description', maxRetries: 0,
      });
      if (selfHostedCalls === 0 || JSON.stringify(out) !== JSON.stringify({ text: '', passthrough: true })) {
        console.error(JSON.stringify({ selfHostedCalls, out }));
        process.exit(1);
      }
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', childScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DEEPL_API_KEY: '',
        DEEPL_API_KEY_2: '',
        AZURE_TRANSLATOR_KEY: '',
        AZURE_TRANSLATOR_KEY_2: '',
        GSC_CLIENT_ID: '',
        GSC_CLIENT_SECRET: '',
        GSC_REFRESH_TOKEN: '',
        HF_TOKEN: '',
        HUGGINGFACE_API_KEY: '',
        LIBRETRANSLATE_SELF_HOSTED_URL: 'http://self-hosted.test',
        MT_LOCAL_OPUSMT: '',
        VITEST: '1',
      },
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
  });

  test('un target non mappato invalida il passthrough della cascata reale', () => {
    const moduleUrl = new URL('../scripts/lib/free-translate.mjs', import.meta.url).href;
    const childScript = `
      const source = ${JSON.stringify(IT)};
      globalThis.fetch = async (url) => {
        const value = String(url);
        if (value.includes('api-free.deepl.com')) {
          return { ok: true, json: async () => ({ translations: [{ text: source }] }) };
        }
        if (value.includes('api.mymemory.translated.net')) {
          return { ok: true, json: async () => ({ responseData: { translatedText: source, match: 1 } }) };
        }
        if (value.includes('translate.googleapis.com')) {
          return { ok: true, text: async () => JSON.stringify([[ [source] ]]) };
        }
        if (value.includes('clients5.google.com')) {
          return { ok: true, text: async () => JSON.stringify({ sentences: [{ trans: source }] }) };
        }
        if (value.includes('/api/v1/')) return { ok: true, json: async () => ({ translation: source }) };
        if (value.includes('/api/translate')) {
          return { ok: true, json: async () => ({ 'translated-text': source, translated_text: source }) };
        }
        if (value.includes('/translate')) return { ok: true, json: async () => ({ translatedText: source }) };
        throw new Error('endpoint inatteso nel test');
      };
      const { freeTranslateWithRetryDetailed } = await import(${JSON.stringify(moduleUrl)});
      const out = await freeTranslateWithRetryDetailed({
        text: source, sourceLang: 'it', targetLang: '', fieldType: 'description', maxRetries: 0,
      });
      if (JSON.stringify(out) !== JSON.stringify({ text: '', passthrough: false })) {
        console.error(JSON.stringify(out));
        process.exit(1);
      }
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', childScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DEEPL_API_KEY: 'test-key',
        DEEPL_API_KEY_2: '',
        AZURE_TRANSLATOR_KEY: '',
        AZURE_TRANSLATOR_KEY_2: '',
        GSC_CLIENT_ID: '',
        GSC_CLIENT_SECRET: '',
        GSC_REFRESH_TOKEN: '',
        HF_TOKEN: '',
        HUGGINGFACE_API_KEY: '',
        LIBRETRANSLATE_SELF_HOSTED_URL: '',
        MT_LOCAL_OPUSMT: '',
        VITEST: '1',
      },
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
  });

  test('un retry finale non diventa passthrough se la cascata ha tier opzionali non configurati', async () => {
    let myMemoryCalls = 0;
    globalThis.fetch = async (url) => {
      const value = String(url);
      const finalAttempt = myMemoryCalls >= 1;
      if (value.includes('api.mymemory.translated.net')) {
        myMemoryCalls += 1;
        if (!finalAttempt) return { ok: false, status: 503 };
        return {
          ok: true,
          json: async () => ({ responseData: { translatedText: IT, match: 1 } }),
        };
      }
      if (!finalAttempt) return { ok: false, status: 503 };
      if (value.includes('/api/v1/')) {
        return { ok: true, json: async () => ({ translation: IT }) };
      }
      if (value.includes('/api/translate')) {
        return { ok: true, json: async () => ({ 'translated-text': IT }) };
      }
      if (value.includes('translate.googleapis.com')) {
        return { ok: true, text: async () => JSON.stringify([[ [IT] ]]) };
      }
      if (value.includes('clients5.google.com')) {
        return { ok: true, text: async () => JSON.stringify({ sentences: [{ trans: IT }] }) };
      }
      if (value.includes('/translate')) {
        return { ok: true, json: async () => ({ translatedText: IT }) };
      }
      return { ok: false, status: 503 };
    };

    const out = await freeTranslateWithRetryDetailed({
      text: IT,
      sourceLang: 'it',
      targetLang: 'en',
      fieldType: 'description',
      maxRetries: 1,
    });

    assert.deepEqual(out, { text: '', passthrough: false });
  });

  test('un fallimento del local Opus-MT entra nell’esito della chiamata', async () => {
    const oldFlag = process.env.MT_LOCAL_OPUSMT;
    process.env.MT_LOCAL_OPUSMT = '1';
    setLocalOpusMtForTests(async () => { throw new Error('modello non disponibile'); });
    globalThis.fetch = async (url) => {
      if (String(url).includes('api.mymemory.translated.net')) {
        return {
          ok: true,
          json: async () => ({ responseData: { translatedText: 'vera traduzione', match: 1 } }),
        };
      }
      throw new Error('offline nel test');
    };

    try {
      const outcome = { passthroughs: 0, errors: 0, incomplete: false };
      const out = await freeTranslate({
        text: IT,
        sourceLang: 'it',
        targetLang: 'en',
        fieldType: 'description',
        _outcome: outcome,
      });

      assert.equal(out, 'vera traduzione');
      assert.equal(outcome.incomplete, true);
    } finally {
      setLocalOpusMtForTests(null);
      if (oldFlag === undefined) delete process.env.MT_LOCAL_OPUSMT;
      else process.env.MT_LOCAL_OPUSMT = oldFlag;
    }
  });
});

test('un passthrough esplicito non conserva il testo sorgente nel risultato normalizzato', () => {
  assert.deepEqual(
    asTranslationResult({ text: IT, passthrough: true }),
    { text: '', passthrough: true },
  );
});

describe('isSourcePassthrough', () => {
  test('e\' vero solo quando i due testi sono lo stesso testo', () => {
    assert.equal(isSourcePassthrough(IT, IT), true);
    assert.equal(isSourcePassthrough(IT, `  ${IT.toUpperCase()}  `), true);
    assert.equal(isSourcePassthrough(IT, EN), false);
    assert.equal(isSourcePassthrough(IT, `${IT} coda in piu'`), false);
  });

  test('una sorgente vuota non e\' un passthrough', () => {
    // Altrimenti ogni chiamata con testo vuoto verrebbe contata come rifiuto e
    // il bucket direbbe che la guardia lavora dove non c'e' niente da tradurre.
    assert.equal(isSourcePassthrough('', ''), false);
    assert.equal(isSourcePassthrough('   ', 'qualcosa'), false);
  });
});
