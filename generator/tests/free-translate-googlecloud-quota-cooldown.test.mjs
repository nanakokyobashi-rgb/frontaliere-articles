/**
 * Pausa del tier Google Cloud dopo un rifiuto di quota (gemello del sito,
 * tests/free-translate-google-cloud-quota-cooldown.test.ts).
 *
 * Sul run translate-pending 37272320066 (2026-10-05) la cascata ha chiamato
 * Google Cloud per ogni testo dopo che il limite di frequenza del progetto lo
 * aveva rifiutato: 976 richieste rifiutate nel fix titoli e 2270 nel fix
 * descrizioni. Dopo un rifiuto di quota il tier aspetta una pausa che raddoppia
 * a ogni rifiuto e si azzera dopo un successo.
 *
 * Il modulo legge le credenziali a import time: ogni caso gira in un processo
 * figlio con il proprio env, il proprio `fetch` finto e un `Date.now` guidato.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const MODULE_URL = new URL('../scripts/lib/free-translate.mjs', import.meta.url).href;

/**
 * `steps` e' una lista di [avanzamento dell'orologio in ms, testo]; `answers`
 * la sequenza di risposte della traduzione (l'ultima si ripete). Rende quante
 * richieste sono arrivate a translation.googleapis.com dopo ogni passo e la
 * riga del riepilogo.
 */
function run({ answers, steps }) {
  const childScript = `
    let now = 1_700_000_000_000;
    Date.now = () => now;
    const answers = ${JSON.stringify(answers)};
    let calls = 0;
    globalThis.fetch = async (url) => {
      const value = String(url);
      if (value.startsWith('https://oauth2.googleapis.com/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
      }
      if (value.startsWith('https://translation.googleapis.com/')) {
        const answer = answers[Math.min(calls, answers.length - 1)];
        calls += 1;
        return {
          ok: answer.status === 200,
          status: answer.status,
          json: async () => answer.body,
          text: async () => JSON.stringify(answer.body),
        };
      }
      throw new Error('endpoint inatteso nel test: ' + value);
    };
    const { freeTranslate, translateWithGoogleCloud, logCascadeSummary } = await import(${JSON.stringify(MODULE_URL)});
    const seen = [];
    for (const [advance, text] of ${JSON.stringify(steps)}) {
      now += advance;
      const out = await translateWithGoogleCloud(text, 'it', 'en');
      seen.push({ calls, out });
    }
    const lines = [];
    const log = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    // Il riepilogo si stampa solo dopo una chiamata della cascata: un testo
    // passa da freeTranslate (gli altri tier non rispondono nel test).
    await freeTranslate({ text: 'Aiuto barista', sourceLang: 'it', targetLang: 'en' });
    logCascadeSummary();
    console.log = log;
    process.stdout.write(JSON.stringify({ seen, lines }));
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
  return JSON.parse(child.stdout.trim().split('\n').pop());
}

const QUOTA = { status: 403, body: { error: { code: 403, message: 'User Rate Limit Exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } } };
const SCOPE = { status: 403, body: { error: { code: 403, message: 'Request had insufficient authentication scopes.' } } };
const OK = { status: 200, body: { data: { translations: [{ translatedText: 'Cook' }] } } };

test('dopo un rifiuto di quota il tier non chiama l\'API finche\' la pausa non e\' passata', () => {
  const { seen, lines } = run({
    answers: [QUOTA],
    steps: [[0, 'Cercasi cameriere'], [1_000, 'Cuoco'], [1_000, 'Barista'], [60_000, 'Lavapiatti']],
  });
  assert.deepEqual(seen.map((s) => s.calls), [1, 1, 1, 2]);
  const summary = lines.find((line) => line.includes('Google Cloud Translation')) || '';
  assert.match(summary, /2 call\(s\) refused \(last: HTTP 403 quota\)/);
  // Cuoco e Barista, piu' il testo del riepilogo, che cade nella seconda pausa.
  assert.match(summary, /3 skipped in quota cooldown/);
});

test('la pausa raddoppia a ogni rifiuto successivo', () => {
  const { seen } = run({
    answers: [QUOTA],
    steps: [[0, 'Cercasi cameriere'], [61_000, 'Cuoco'], [61_000, 'Barista'], [60_000, 'Aiuto cuoco']],
  });
  assert.deepEqual(seen.map((s) => s.calls), [1, 2, 2, 3]);
});

test('un 429 vale come rifiuto di quota e un successo chiude la pausa', () => {
  const { seen } = run({
    answers: [{ status: 429, body: {} }, OK],
    steps: [[0, 'Cercasi cameriere'], [61_000, 'Cuoco'], [0, 'Barista']],
  });
  assert.deepEqual(seen.map((s) => s.calls), [1, 2, 3]);
  assert.equal(seen[2].out, 'Cook');
});

test('un rifiuto di credenziale non apre la pausa', () => {
  const { seen } = run({
    answers: [SCOPE],
    steps: [[0, 'Cercasi cameriere'], [0, 'Cuoco']],
  });
  assert.deepEqual(seen.map((s) => s.calls), [1, 2]);
});
