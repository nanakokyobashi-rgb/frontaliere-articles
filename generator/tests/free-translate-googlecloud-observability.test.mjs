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
      GOOGLE_APPLICATION_CREDENTIALS: '',
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

test('preferisce il service account ADC con scope Cloud Translation al refresh token utente', () => {
  const childScript = `
    import { generateKeyPairSync } from 'node:crypto';
    import { unlinkSync, writeFileSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';

    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const credentialsPath = join(tmpdir(), 'frontaliere-google-translation-test.json');
    writeFileSync(credentialsPath, JSON.stringify({
      type: 'service_account',
      project_id: 'frontaliere-ticino',
      client_email: 'translation-test@frontaliere-ticino.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    }));
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;

    let tokenCalls = 0;
    let translationCalls = 0;
    globalThis.fetch = async (url, options = {}) => {
      const value = String(url);
      if (value === 'https://oauth2.googleapis.com/token') {
        tokenCalls += 1;
        if (!String(options.body || '').includes('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer')) {
          throw new Error('the ADC path must use a signed service-account assertion');
        }
        return { ok: true, status: 200, json: async () => ({ access_token: 'service-account-token', expires_in: 3600 }) };
      }
      if (value === 'https://translation.googleapis.com/language/translate/v2') {
        translationCalls += 1;
        if (!String(options.headers?.Authorization || '').includes('service-account-token')) throw new Error('ADC token missing');
        return { ok: true, status: 200, json: async () => ({ data: { translations: [{ translatedText: 'Hello from ADC' }] } }) };
      }
      throw new Error('endpoint inatteso nel test: ' + value);
    };

    const { freeTranslateWithRetryDetailed, logCascadeSummary } = await import(${JSON.stringify(MODULE_URL)});
    const translated = await freeTranslateWithRetryDetailed({
      text: 'Ciao', sourceLang: 'it', targetLang: 'en', fieldType: 'description', maxRetries: 0,
    });
    console.log('SERVICE_ACCOUNT_RESULT=' + translated.text);
    console.log('SERVICE_ACCOUNT_CALLS=' + tokenCalls + '/' + translationCalls);
    logCascadeSummary();
    unlinkSync(credentialsPath);
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
      GOOGLE_APPLICATION_CREDENTIALS: '',
      HF_TOKEN: '',
      HUGGINGFACE_API_KEY: '',
      LIBRETRANSLATE_SELF_HOSTED_URL: '',
      MT_LOCAL_OPUSMT: '',
      VITEST: '1',
    },
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.match(child.stdout, /SERVICE_ACCOUNT_RESULT=Hello from ADC/);
  assert.match(child.stdout, /SERVICE_ACCOUNT_CALLS=1\/1/);
  assert.match(child.stdout, /Google Cloud Translation: auth=service-account, \d+\/16000 daily chars used/);
});

/**
 * Service account valido per l'endpoint del token ma rifiutato da Cloud
 * Translation (ruolo mancante): il token non deve restare in cache per il
 * resto della run, o nessun campo arriva al fallback OAuth. Un 403 per il
 * tetto giornaliero del progetto invece non e' un problema di credenziale, e
 * OAuth addebita allo stesso progetto: niente fallback. Stesso comportamento
 * del gemello del sito (valerielinc-ops/frontaliere-si-o-no#10454).
 */
function runServiceAccountRejection({ refusal, concurrent = false }) {
  const childScript = `
    import { generateKeyPairSync } from 'node:crypto';
    import { unlinkSync, writeFileSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';

    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const credentialsPath = join(tmpdir(), 'frontaliere-google-translation-rejected-' + process.pid + '.json');
    writeFileSync(credentialsPath, JSON.stringify({
      type: 'service_account',
      project_id: 'frontaliere-ticino',
      client_email: 'translation-test@frontaliere-ticino.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    }));
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;

    const bearers = [];
    let saRejections = 0;
    let saExchanges = 0;
    let gate;
    globalThis.fetch = async (url, options = {}) => {
      const value = String(url);
      if (value === 'https://oauth2.googleapis.com/token') {
        const refresh = String(options.body || '').includes('grant_type=refresh_token');
        if (refresh) return { ok: true, status: 200, json: async () => ({ access_token: 'user-token', expires_in: 3600 }) };
        // Concurrent first-use exchanges resolve on one gate, in the same tick,
        // and each gets its own token, while the cache keeps only one.
        saExchanges += 1;
        const issued = saExchanges === 1 ? 'service-account-token-A' : 'service-account-token-B';
        if (${concurrent}) {
          gate ??= new Promise((resolve) => setTimeout(resolve, 10));
          await gate;
        }
        return { ok: true, status: 200, json: async () => ({ access_token: issued, expires_in: 3600 }) };
      }
      if (value === 'https://translation.googleapis.com/language/translate/v2') {
        const bearer = String(options.headers?.Authorization || '');
        bearers.push(bearer.includes('service-account-token') ? 'sa' : 'oauth');
        if (${refusal === 'quota'} || bearer.includes('service-account-token')) {
          // Concurrent fields: the second rejection arrives after the first one
          // already dropped the cached token.
          saRejections += 1;
          await new Promise((resolve) => setTimeout(resolve, saRejections === 1 ? 5 : 40));
          const body = ${JSON.stringify(refusal === 'quota'
            ? { error: { message: 'User Rate Limit Exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } }
            : { error: { status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } })};
          return { ok: false, status: 403, json: async () => body, text: async () => JSON.stringify(body) };
        }
        return { ok: true, status: 200, json: async () => ({ data: { translations: [{ translatedText: 'Hello via OAuth' }] } }) };
      }
      if (value.includes('api.mymemory.translated.net')) {
        return { ok: true, status: 200, json: async () => ({ responseData: { translatedText: 'fallback', match: 1 } }) };
      }
      throw new Error('endpoint inatteso nel test: ' + value);
    };

    const { translateWithGoogleCloud } = await import(${JSON.stringify(MODULE_URL)});
    const [first, second] = ${concurrent}
      ? await Promise.all([translateWithGoogleCloud('Ciao', 'it', 'en'), translateWithGoogleCloud('Buongiorno', 'it', 'en')])
      : [await translateWithGoogleCloud('Ciao', 'it', 'en'), await translateWithGoogleCloud('Buongiorno', 'it', 'en')];
    console.log('RESULTS=' + JSON.stringify([first, second]));
    console.log('BEARERS=' + bearers.join(','));
    unlinkSync(credentialsPath);
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
      GOOGLE_APPLICATION_CREDENTIALS: '',
      HF_TOKEN: '',
      HUGGINGFACE_API_KEY: '',
      LIBRETRANSLATE_SELF_HOSTED_URL: '',
      MT_LOCAL_OPUSMT: '',
      VITEST: '1',
    },
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  return child.stdout;
}

test('un token del service account rifiutato da Cloud Translation passa al fallback OAuth e non viene riusato', () => {
  const out = runServiceAccountRejection({ refusal: 'permission' });
  assert.match(out, /RESULTS=\["Hello via OAuth","Hello via OAuth"\]/);
  assert.match(out, /BEARERS=sa,oauth,oauth/);
});

test('il tetto giornaliero del progetto non attiva il fallback OAuth', () => {
  const out = runServiceAccountRejection({ refusal: 'quota' });
  assert.match(out, /RESULTS=\["",""\]/);
  assert.match(out, /BEARERS=sa,sa/);
});

test('due campi concorrenti con il token del service account rifiutato arrivano entrambi al fallback OAuth', () => {
  const out = runServiceAccountRejection({ refusal: 'permission', concurrent: true });
  assert.match(out, /RESULTS=\["Hello via OAuth","Hello via OAuth"\]/);
  assert.match(out, /BEARERS=sa,sa,oauth,oauth/);
});
