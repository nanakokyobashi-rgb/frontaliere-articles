/**
 * Una meta-risposta NON vince la gara fra istanze (`raceInstances`) — review
 * della PR 2166. Le istanze di Lingva, SimplyTranslate, LibreTranslate e Mozhi
 * corrono in parallelo e la prima risposta non vuota fermava le altre e
 * marcava la propria istanza come sana. Un «Sorry, I can't help with that.»
 * vinceva quindi la gara, veniva scartato solo dopo da `tryTier`, e la
 * traduzione valida delle altre istanze era gia' persa (lo stesso endpoint
 * vinceva di nuovo a ogni retry).
 *
 * File a se': lo stato di salute delle istanze e' globale di modulo, e
 * `node --test` isola ogni file nel suo processo. L'ambiente si prepara PRIMA
 * dell'import, che legge chiavi e URL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

for (const key of [
  'DEEPL_API_KEY', 'DEEPL_API_KEY_2', 'AZURE_TRANSLATOR_KEY', 'AZURE_TRANSLATOR_KEY_2',
  'GOOGLE_APPLICATION_CREDENTIALS', 'GSC_CLIENT_ID', 'GSC_CLIENT_SECRET', 'GSC_REFRESH_TOKEN',
  'HF_TOKEN', 'HUGGINGFACE_API_KEY', 'LIBRETRANSLATE_SELF_HOSTED_URL', 'MT_LOCAL_OPUSMT',
  'CODEX_AUTH_BROKER_SOCKET',
]) delete process.env[key];
process.env.VITEST = '1';

const { freeTranslate, getCascadeStats, getInstanceHealthStats } = await import('../scripts/lib/free-translate.mjs');

const EN = 'The cross-border worker pays withholding tax in Switzerland.';

test('il rifiuto di un\'istanza Mozhi non ferma le altre: vince la traduzione valida', async () => {
  let mozhiCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/translate?') && u.includes('engine=duckduckgo')) {
      // La prima istanza della gara rifiuta, le altre traducono.
      const text = mozhiCalls++ === 0 ? "Sorry, I can't help with that." : EN;
      return { ok: true, json: async () => ({ 'translated-text': text }) };
    }
    return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
  };
  try {
    const out = await freeTranslate({
      text: 'Il frontaliere paga le imposte alla fonte in Svizzera.', sourceLang: 'it', targetLang: 'en', fieldType: 'description',
    });
    assert.equal(out, EN);
    assert.equal(getCascadeStats().tierMetaResponses['mozhi:duckduckgo'], 1);
    // Solo l'istanza che ha rifiutato e' segnata come guasta; nessuna e' stata
    // promossa a sana dal rifiuto.
    const failed = Object.entries(getInstanceHealthStats())
      .filter(([u, h]) => u.includes('mozhi') && h.failures > 0)
      .map(([u]) => u);
    assert.equal(failed.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
