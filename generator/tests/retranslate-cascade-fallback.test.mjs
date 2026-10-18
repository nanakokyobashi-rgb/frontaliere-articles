import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMPTY_CASCADE_RATE_THRESHOLD,
  emptyCascadeMetric,
  engineTranslator,
} from '../scripts/retranslate-blocking-bodies.mjs';
import { translateFieldFreeMt } from '../scripts/lib/article-free-mt.mjs';
import {
  recordTranslationProviderAttempt,
  summarizeTranslationOutcome,
} from '../scripts/lib/free-translate.mjs';

test('translateFieldFreeMt inoltra lo stesso outcome al motore della cascata', async () => {
  const translationOutcome = { tierAttempts: [] };
  let receivedOutcome = null;

  const translated = await translateFieldFreeMt({
    text: 'Testo italiano da tradurre.',
    sourceLang: 'it',
    targetLang: 'fr',
    fieldType: 'description',
    fieldName: 'body3',
    translationOutcome,
    translate: async ({ _outcome }) => {
      receivedOutcome = _outcome;
      return 'Texte italien à traduire.';
    },
  });

  assert.equal(translated, 'Texte italien à traduire.');
  assert.equal(receivedOutcome, translationOutcome);
});

test('la bonifica usa Codex locale solo dopo il vuoto della cascata', async () => {
  const calls = [];
  const outcome = { tierAttempts: [] };
  const translate = engineTranslator('cascade', {
    codexCall: async () => 'unused transport stub',
    cascadeTranslate: async (args) => {
      calls.push(['cascade', args.text]);
      return '';
    },
    codexTranslate: async (args) => {
      calls.push(['codex-local-fallback', args.text]);
      return 'Texte récupéré par Codex.';
    },
  });

  const translated = await translate({
    text: 'Testo italiano.',
    sourceLang: 'it',
    targetLang: 'fr',
    fieldType: 'description',
    _outcome: outcome,
  });

  assert.equal(translated, 'Texte récupéré par Codex.');
  assert.deepEqual(calls, [
    ['cascade', 'Testo italiano.'],
    ['codex-local-fallback', 'Testo italiano.'],
  ]);
  assert.deepEqual(summarizeTranslationOutcome(outcome).providers, [{
    provider: 'codex-local-fallback',
    attempts: 1,
    successes: 1,
    failures: 0,
    reasons: {},
  }]);
});

test('una cascata riuscita non spende il fallback Codex locale', async () => {
  let codexCalls = 0;
  const translate = engineTranslator('cascade', {
    codexCall: async () => 'unused transport stub',
    cascadeTranslate: async () => 'Traduction gratuite.',
    codexTranslate: async () => {
      codexCalls += 1;
      return 'Ne doit pas être utilisée.';
    },
  });

  assert.equal(await translate({ text: 'Testo.', sourceLang: 'it', targetLang: 'fr' }), 'Traduction gratuite.');
  assert.equal(codexCalls, 0);
});

test('il riepilogo nomina provider e cause senza includere payload o errori grezzi', () => {
  const outcome = { tierAttempts: [] };
  recordTranslationProviderAttempt(outcome, {
    provider: 'deepl',
    attempt: 1,
    status: 'failed',
    reasons: ['provider-error'],
  });
  recordTranslationProviderAttempt(outcome, {
    provider: 'lingva',
    attempt: 1,
    status: 'failed',
    reasons: ['source-passthrough'],
  });
  recordTranslationProviderAttempt(outcome, {
    provider: 'mozhiGoogle',
    attempt: 1,
    status: 'failed',
    reasons: ['structure:recoveryFailed'],
  });

  assert.deepEqual(summarizeTranslationOutcome(outcome), {
    attempts: 1,
    providers: [
      { provider: 'deepl', attempts: 1, successes: 0, failures: 1, reasons: { 'provider-error': 1 } },
      { provider: 'lingva', attempts: 1, successes: 0, failures: 1, reasons: { 'source-passthrough': 1 } },
      { provider: 'mozhiGoogle', attempts: 1, successes: 0, failures: 1, reasons: { 'structure:recoveryFailed': 1 } },
    ],
  });
});

test('l osservatore del lotto segnala una quota di campi vuoti sopra soglia', () => {
  const rows = [
    { reason: 'pulita' },
    { reason: 'campo-vuoto-dalla-cascata' },
    { reason: 'ri-fallita: italian-residue' },
    { reason: 'campo-vuoto-dalla-cascata' },
    { reason: 'pulita' },
  ];

  assert.equal(EMPTY_CASCADE_RATE_THRESHOLD, 0.2);
  assert.deepEqual(emptyCascadeMetric(rows), {
    count: 2,
    total: 5,
    rate: 0.4,
    threshold: 0.2,
    firing: true,
  });
  assert.equal(emptyCascadeMetric([{ reason: 'pulita' }]).firing, false);
  assert.equal(emptyCascadeMetric([]).firing, false);
});
