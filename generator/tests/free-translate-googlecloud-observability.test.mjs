/**
 * Il tier Google Cloud Translation non lancia mai: su token mancante, 403/429,
 * risposta !ok o timeout rende '' e basta. `tryTier` conta come errore solo
 * un'eccezione, quindi il riepilogo della cascata stampava
 * `auth=OAuth2, 0/16000 daily chars used` sia per «mai chiamato» sia per
 * «ogni chiamata rifiutata». Misurato su batch-faq-articles (run 35958863091,
 * 2026-09-24): 0/36 FAQ tradotte con DeepL e Azure esauriti, e del terzo tier
 * a pagamento nessuna traccia del perche' non servisse.
 *
 * Il modulo legge le credenziali a import time: ogni caso gira in un processo
 * figlio con il proprio env e il proprio `fetch` finto, come i casi
 * subprocess di `free-translate-source-passthrough.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const MODULE_URL = new URL('../scripts/lib/free-translate.mjs', import.meta.url).href;
const IT = 'Il valico di Chiasso apre alle sei del mattino nei giorni feriali.';
const EN = 'The Chiasso crossing opens at six in the morning on weekdays.';

function runSummary({ tokenResponse, translateResponse }) {
  const childScript = `
    globalThis.fetch = async (url) => {
      const value = String(url);
      if (value.startsWith('https://oauth2.googleapis.com/token')) return ${tokenResponse};
      if (value.startsWith('https://translation.googleapis.com/')) return ${translateResponse};
      if (value.includes('api.mymemory.translated.net')) {
        return { ok: true, status: 200, json: async () => ({ responseData: { translatedText: ${JSON.stringify(EN)}, match: 1 } }) };
      }
      throw new Error('endpoint inatteso nel test: ' + value);
    };
    const { freeTranslateWithRetryDetailed, logCascadeSummary } = await import(${JSON.stringify(MODULE_URL)});
    await freeTranslateWithRetryDetailed({
      text: ${JSON.stringify(IT)}, sourceLang: 'it', targetLang: 'en', fieldType: 'description', maxRetries: 0,
    });
    logCascadeSummary();
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', childScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DEEPL_API_KEY: '',
      DEEPL_API_KEY_2: '',
      AZURE_TRANSLATOR_KEY: '',
      AZURE_TRANSLATOR_KEY_2: '',
      GSC_CLIENT_ID: 'test-client',
      GSC_CLIENT_SECRET: 'test-secret',
      GSC_REFRESH_TOKEN: 'test-refresh',
      HF_TOKEN: '',
      HUGGINGFACE_API_KEY: '',
      LIBRETRANSLATE_SELF_HOSTED_URL: '',
      MT_LOCAL_OPUSMT: '',
      VITEST: '1',
    },
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  return child.stdout.split('\n').find((line) => line.includes('Google Cloud Translation')) || '';
}

const TOKEN_OK = "({ ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) })";

test('un 403 del tier Google Cloud compare nel riepilogo con il suo status', () => {
  const line = runSummary({
    tokenResponse: TOKEN_OK,
    translateResponse: '({ ok: false, status: 403, json: async () => ({}) })',
  });
  assert.match(line, /auth=OAuth2, 0\/16000 daily chars used, 1 call\(s\) refused \(last: HTTP 403\)/);
});

test('un token OAuth non ottenibile e\' un rifiuto con il suo motivo, non un tier muto', () => {
  const line = runSummary({
    tokenResponse: "({ ok: false, status: 400, text: async () => JSON.stringify({ error: 'invalid_grant' }) })",
    translateResponse: "(() => { throw new Error('senza token la traduzione non va chiamata'); })()",
  });
  assert.match(line, /1 call\(s\) refused \(last: access-token-unavailable\)/);
});

test('un tier che traduce non riporta rifiuti', () => {
  const line = runSummary({
    tokenResponse: TOKEN_OK,
    translateResponse: `({ ok: true, status: 200, json: async () => ({ data: { translations: [{ translatedText: ${JSON.stringify(EN)} }] } }) })`,
  });
  assert.match(line, /auth=OAuth2, \d+\/16000 daily chars used$/);
  assert.doesNotMatch(line, /refused/);
});
