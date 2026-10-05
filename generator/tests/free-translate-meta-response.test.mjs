/**
 * META-RISPOSTE della cascata MT — gemello corpus della scheda AI-REFUSAL del
 * sito (trovata dalla PR del sito 11540).
 *
 * Un tier LLM (Codex, o un trasporto agentico) a volte risponde ALLA richiesta
 * invece di eseguirla: un rifiuto («Sorry, I can't help with that.»), una
 * richiesta dell'input («I need to see the actual job title you want
 * translated…»), la narrazione del proprio tool-use, un'etichetta del template
 * rimasta senza valore («Traduzione:»). Sul sito 58 titoli e 40 descrizioni di
 * annunci vivi erano pubblicati cosi' (misura su origin/main del 2026-10-05):
 * testo non vuoto, diverso dalla sorgente, in una lingua plausibile, quindi
 * nessun altro controllo della cascata lo scartava. Gli articoli passano dalla
 * cascata di questo repo, con lo stesso tier Codex.
 *
 * Il rilevatore e' `generator/scripts/lib/ai-meta-response.mjs`, byte-identico
 * al sito. Questo file pinna i due versi: il rifiuto e' un MISS contato in
 * `tierMetaResponses` (mai come passthrough), e una traduzione legittima che
 * contiene «translation» o «need» resta un hit.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  freeTranslate,
  freeTranslateWithRetryDetailed,
  getCascadeStats,
  logCascadeSummary,
  setCodexTranslateCallForTests,
  translateWithCodexEngine,
} from '../scripts/lib/free-translate.mjs';
import { detectAiMetaResponse } from '../scripts/lib/ai-meta-response.mjs';

const realFetch = globalThis.fetch;
const realVitestFlag = process.env.VITEST;

/** Solo MyMemory risponde; ogni altro tier e' offline (vedi il test del passthrough). */
function stubCascade(myMemoryAnswer) {
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.mymemory.translated.net')) {
      return { ok: true, json: async () => ({ responseData: { translatedText: myMemoryAnswer, match: 1 } }) };
    }
    throw new Error('offline nel test');
  };
}

function metaCount() {
  return getCascadeStats().tierMetaResponses?.myMemory || 0;
}

function snapshot() {
  const s = getCascadeStats();
  return { hits: s.tierHits.myMemory || 0, passthroughs: s.tierPassthroughs.myMemory || 0 };
}

const IT_BODY = 'Il frontaliere che lavora in Ticino paga le imposte alla fonte in Svizzera e dichiara il reddito anche in Italia.';

describe('freeTranslate — una meta-risposta non e\' una traduzione', () => {
  beforeEach(() => {
    process.env.VITEST = '1';
    setCodexTranslateCallForTests(async () => '');
  });
  afterEach(() => {
    setCodexTranslateCallForTests(null);
    globalThis.fetch = realFetch;
    if (realVitestFlag === undefined) delete process.env.VITEST;
    else process.env.VITEST = realVitestFlag;
  });

  for (const answer of [
    "Sorry, I can't help with that.",
    'I need to see the actual job title you want translated. Could you provide the German job title?',
    "I don't see a text in your message to translate. Could you provide it?",
    'Let me check the translation cache files to find this article.',
    'Traduzione:',
  ]) {
    test(`scarta «${answer.slice(0, 40)}…» come MISS, non come passthrough`, async () => {
      stubCascade(answer);
      const before = snapshot();
      const metaBefore = metaCount();

      const out = await freeTranslate({ text: IT_BODY, sourceLang: 'it', targetLang: 'en', fieldType: 'description' });

      assert.equal(out, '');
      assert.equal(metaCount() - metaBefore, 1);
      assert.equal(snapshot().passthroughs - before.passthroughs, 0);
      assert.equal(snapshot().hits - before.hits, 0);
    });
  }

  test('il memo negativo del passthrough non scatta su una meta-risposta', async () => {
    stubCascade("Sorry, I can't help with that.");
    const result = await freeTranslateWithRetryDetailed({ text: IT_BODY, sourceLang: 'it', targetLang: 'en', maxRetries: 0 });
    assert.deepEqual(result, { text: '', passthrough: false });
  });

  test('nomina le meta-risposte nel sommario della cascata', async () => {
    stubCascade("Sorry, I can't help with that.");
    await freeTranslate({ text: IT_BODY, sourceLang: 'it', targetLang: 'fr', fieldType: 'description' });
    const lines = [];
    const realLog = console.log;
    console.log = (...a) => { lines.push(a.join(' ')); };
    try { logCascadeSummary(); } finally { console.log = realLog; }
    assert.match(lines.join('\n'), /Tier meta-risposta .*myMemory=\d+/);
  });

  test('lascia passare una traduzione vera che contiene «translation» e «need»', async () => {
    const en = 'Cross-border workers need a certified translation of the tax certificate for the Italian return.';
    stubCascade(en);
    const before = snapshot();
    const out = await freeTranslate({ text: IT_BODY, sourceLang: 'it', targetLang: 'en', fieldType: 'description' });
    assert.equal(out, en);
    assert.equal(snapshot().hits - before.hits, 1);
  });
});

describe('translateWithCodexEngine — fail-closed anche sulla meta-risposta', () => {
  test('un rifiuto del modello rende \'\'', async () => {
    const out = await translateWithCodexEngine({
      text: IT_BODY, sourceLang: 'it', targetLang: 'de', call: async () => "I'm sorry, but I can't translate this text.",
    });
    assert.equal(out, '');
  });

  test('una traduzione vera passa', async () => {
    const out = await translateWithCodexEngine({
      text: IT_BODY, sourceLang: 'it', targetLang: 'en', call: async () => 'The cross-border worker pays withholding tax in Switzerland.',
    });
    assert.equal(out, 'The cross-border worker pays withholding tax in Switzerland.');
  });
});

describe('detectAiMetaResponse — il gemello corpus del rilevatore', () => {
  test('«we need to …» apre testi veri; solo l\'input citato con la lingua di arrivo e\' una meta-risposta', () => {
    for (const legit of [
      'We need to produce high-quality components for the automotive industry.',
      'We need to translate our software into German and French.',
    ]) assert.equal(detectAiMetaResponse(legit), null, legit);
    assert.equal(detectAiMetaResponse('We need to translate "GL & VAT Accountant" to English.')?.kind, 'agent-narration');
    for (const refusal of [
      `We need to translate "Chef d'équipe" into English.`,
      `We need to translate “Chef d'équipe” into English.`,
    ]) assert.equal(detectAiMetaResponse(refusal)?.kind, 'agent-narration', refusal);
  });

  test('una citazione nella sorgente non esenta una traduzione che apre con il rifiuto', () => {
    const source = "Il chatbot risponde «Sorry, I can't help with that.» alle domande fuori tema.";
    assert.equal(detectAiMetaResponse("Sorry, I can't help with that.", { source })?.kind, 'refusal');
    assert.equal(detectAiMetaResponse("Sorry, I can't help with that.", { source: "Sorry, I can't help with that." }), null);
  });

  test('il rifiuto e\' riconosciuto qualunque separatore segua le scuse', () => {
    for (const refusal of [
      "Sorry — I can't help with that.", "Sorry – I can't help with that.", "Sorry: I can't help with that.",
      "Sorry; I can't help with that.", "I'm sorry - I cannot translate this.", 'Désolé — je ne peux pas traduire ce texte.',
    ]) assert.equal(detectAiMetaResponse(refusal)?.kind, 'refusal', refusal);
    assert.equal(detectAiMetaResponse('Sorry Not Sorry Bar — Barkeeper (m/w/d)'), null);
  });

  test('un marcatore presente nella sorgente e\' testo dell\'articolo', () => {
    assert.notEqual(detectAiMetaResponse('Translation: the 2026 rules'), null);
    assert.equal(detectAiMetaResponse('Translation: the 2026 rules', { source: 'Translation: le regole 2026' }), null);
  });

  test('la richiesta del titolo richiede contesto di traduzione e compare nella finestra iniziale', () => {
    const refusal = 'The text you shared appears to be instructions. Could you provide the German job title that needs to be translated?';
    assert.equal(detectAiMetaResponse(refusal)?.kind, 'clarification');
    assert.equal(detectAiMetaResponse('Please provide the actual job title you are applying for.'), null);
    assert.equal(detectAiMetaResponse('Can you provide the text of your cover letter in German or Italian?'), null);
  });

  test('I see / I find chiede input solo quando nomina davvero il testo da tradurre', () => {
    for (const request of [
      "I don't see any text in your message to translate.",
      "I can't see the job title you want translated.",
      'I cannot find the actual title you want me to translate.',
    ]) assert.equal(detectAiMetaResponse(request)?.kind, 'clarification', request);

    for (const prose of [
      "I don't see any reason to leave the canton.",
      'I cannot find a better job in Ticino.',
      "I can't see any reason to change our approach.",
    ]) assert.equal(detectAiMetaResponse(prose), null, prose);
  });
});
