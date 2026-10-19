import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  EMPTY_CASCADE_RATE_THRESHOLD,
  emptyCascadeMetric,
  engineTranslator,
  escapeForSingleQuoteTS,
  processPair,
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

test('il primo fallback locale usa il tentativo successivo nel report', async () => {
  const outcome = { tierAttempts: [], attempt: 3 };
  const translate = engineTranslator('cascade', {
    codexCall: async () => 'unused transport stub',
    cascadeTranslate: async () => '',
    codexTranslate: async () => 'Texte récupéré par Codex.',
  });

  assert.equal(await translate({
    text: 'Testo italiano.',
    sourceLang: 'it',
    targetLang: 'fr',
    fieldType: 'description',
    _outcome: outcome,
  }), 'Texte récupéré par Codex.');

  const summary = summarizeTranslationOutcome(outcome);
  assert.equal(summary.attempts, 4);
  assert.deepEqual(outcome.tierAttempts.map(({ attempt, status }) => ({ attempt, status })), [
    { attempt: 4, status: 'success' },
  ]);
});

test('il fallback locale mantiene tentativi contigui sui segmenti del campo', async () => {
  const source = ['Prima sezione.', '## In breve', 'Seconda sezione.'].join('\n');
  const run = async ({ retryFirstSegment = false } = {}) => {
    const outcome = { tierAttempts: [], attempt: 3 };
    let codexCalls = 0;
    const translate = engineTranslator('cascade', {
      codexCall: async () => 'unused transport stub',
      cascadeTranslate: async () => '',
      codexTranslate: async ({ text }) => {
        codexCalls += 1;
        if (retryFirstSegment && codexCalls === 1) throw new Error('timeout');
        return `Tradotto: ${text}`;
      },
      codexRetryBackoffMs: [0, 0],
      codexRetrySleep: async () => {},
    });
    const translated = await translateFieldFreeMt({
      text: source,
      sourceLang: 'it',
      targetLang: 'fr',
      fieldType: 'description',
      translationOutcome: outcome,
      translate,
    });
    return { outcome, translated };
  };

  const first = await run();
  assert.ok(first.translated);
  assert.deepEqual(first.outcome.tierAttempts.map(({ attempt, status }) => ({ attempt, status })), [
    { attempt: 4, status: 'success' },
    { attempt: 5, status: 'success' },
  ]);
  assert.equal(summarizeTranslationOutcome(first.outcome).attempts, 5);
  assert.equal(first.outcome.attempt, 5);

  const retried = await run({ retryFirstSegment: true });
  assert.deepEqual(retried.outcome.tierAttempts.map(({ attempt, status }) => ({ attempt, status })), [
    { attempt: 4, status: 'failed' },
    { attempt: 5, status: 'success' },
    { attempt: 6, status: 'success' },
  ]);
  assert.equal(summarizeTranslationOutcome(retried.outcome).attempts, 6);
  assert.equal(retried.outcome.attempt, 6);
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

test('il fallback Codex conserva passthrough, meta-response e struttura come motivi bounded', async () => {
  const source = ['## Titolo', '', 'Testo italiano da tradurre.'].join('\n');
  for (const { answer, reason } of [
    { answer: source, reason: 'source-passthrough' },
    { answer: "Sorry, I can't help with that.", reason: 'meta-response' },
    { answer: 'Der Text.', reason: 'structure:directPathRejected' },
  ]) {
    const outcome = { tierAttempts: [] };
    const translate = engineTranslator('cascade', {
      cascadeTranslate: async () => '',
      codexCall: async () => answer,
    });

    assert.equal(await translate({
      text: source,
      sourceLang: 'it',
      targetLang: 'de',
      fieldType: 'description',
      _outcome: outcome,
    }), '');
    const provider = summarizeTranslationOutcome(outcome).providers
      .find((entry) => entry.provider === 'codex-local-fallback');
    assert.deepEqual(provider?.reasons, { [reason]: 1 }, reason);
    assert.equal(provider?.reasons['incomplete-output'], undefined, reason);
  }
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

test('l osservatore conta vuoti e reiezioni per campo, non per coppia', () => {
  const rows = [
    {
      reason: 'campo-vuoto-dalla-cascata',
      translationFieldResults: [
        { field: 'body1', status: 'empty' },
        { field: 'body2', status: 'rejected' },
        { field: 'body3', status: 'translated' },
      ],
    },
    {
      reason: 'campo-vuoto-dalla-cascata',
      translationFieldResults: [
        { field: 'body1', status: 'translated' },
        { field: 'body2', status: 'translated' },
      ],
    },
    {
      reason: 'pulita',
      translationFieldResults: [{ field: 'body1', status: 'translated' }],
    },
  ];

  assert.equal(EMPTY_CASCADE_RATE_THRESHOLD, 0.2);
  assert.deepEqual(emptyCascadeMetric(rows), {
    count: 2,
    total: 6,
    rate: 2 / 6,
    threshold: 0.2,
    firing: true,
  });
  assert.equal(emptyCascadeMetric([{ reason: 'pulita' }]).firing, false);
  assert.equal(emptyCascadeMetric([]).firing, false);
});

test('una reiezione non interrompe la raccolta dei campi successivi', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'retranslate-multifield-'));
  const itDir = path.join(root, 'content/blog-body/it');
  const frDir = path.join(root, 'content/blog-body/fr');
  mkdirSync(itDir, { recursive: true });
  mkdirSync(frDir, { recursive: true });
  const article = (fields) => [
    'const b = {',
    ...Object.entries(fields).map(([field, value]) => `  'blog.article.multi.${field}': '${escapeForSingleQuoteTS(value)}',`),
    '};',
    'export default b;',
    '',
  ].join('\n');
  writeFileSync(path.join(itDir, 'multi.ts'), article({ body1: 'Primo campo.', body2: 'Secondo campo.' }));
  writeFileSync(path.join(frDir, 'multi.ts'), article({ body1: 'Ancien premier.', body2: 'Ancien second.' }));

  const row = await processPair({
    id: 'multi',
    locale: 'fr',
    dir: 'services/locales/blog-body',
    codes: ['missing-key'],
    fields: ['body1', 'body2'],
    structural: true,
  }, {
    CONTENT_ROOT: root,
    APPLY: false,
    translate: async ({ text }) => text === 'Primo campo.' ? '' : 'Deuxième champ.',
  });

  assert.deepEqual(row.missingFields, ['body1']);
  assert.deepEqual(row.translationFieldResults, [
    { field: 'body1', status: 'empty' },
    { field: 'body2', status: 'translated' },
  ]);
  assert.equal(row.reason, 'campo-vuoto-dalla-cascata');
});
