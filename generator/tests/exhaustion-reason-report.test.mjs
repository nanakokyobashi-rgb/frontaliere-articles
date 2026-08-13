/**
 * exhaustion-reason-report.test.mjs — l'osservatore che manca sull'altro lato:
 * un esaurimento senza motivo distinto che viene persistito a tempo
 * indeterminato oggi non fa fallire niente.
 *
 * ## Il difetto che copre
 *
 * `markModelExhausted` (ai-models.mjs) mette un modello fuori dal roster e, per
 * un solo motivo su cinque, **persiste** lo stato su Firestore — condiviso da
 * tutti i workflow. La issue #203 misurava 39-58 modelli su 101 bruciati in un
 * run e nessuna ripartizione per motivo, quindi «ogni rimedio è una scommessa».
 *
 * Rimisurato il 2026-08-13, la ripartizione ora esiste in `_exhaustReason`
 * (`quota` | `timeout` | `content` | `stale` | `nonretryable`) e la persistenza
 * è già gatata su `quota` con scadenza alla mezzanotte UTC. Quello che NON
 * esiste è un guard: niente impedisce a un motivo nuovo — o a nessun motivo — di
 * scivolare nel ramo che persiste. E una persistenza senza scadenza nota è un
 * ban permanente su prove nulle, che è il difetto che #203 descrive.
 *
 * La metà più importante di questi test è quella negativa: il piano `quota`
 * DEVE avere una scadenza finita e vicina. Un test che verificasse solo «i
 * motivi ignoti non persistono» resterebbe verde anche se la quota diventasse
 * eterna, cioè proprio il caso che avvelena i run successivi.
 *
 * `nowMs` è iniettato: una scadenza confrontata con l'orologio reale è un test
 * che cambia risposta a seconda dell'ora in cui gira — e questo girerebbe rosso
 * solo intorno a mezzanotte UTC, che è il modo più affidabile di non accorgersene.
 *
 * ## Dove gira
 *
 * `npm test` del corpus (`node --test generator/tests/*.test.mjs`), quindi dentro
 * `tests.yml` — che ha `branches-ignore: [main]`: **gira sulle PR, NON sui push
 * a `main`**.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  persistencePlan,
  nextUtcMidnightMs,
  parseExhaustionEvents,
  summariseExhaustion,
  auditExhaustion,
  formatRunLine,
  KNOWN_REASONS,
  PERSISTED_REASONS,
} from '../../scripts/ci/exhaustion-reason-report.mjs';

const NOW = Date.parse('2026-08-13T14:30:00Z');
const DAY = 86_400_000;

test('la quota persiste, ma con una scadenza finita e a meno di 24 ore', () => {
  const plan = persistencePlan('quota', NOW);
  assert.equal(plan.persist, true);
  assert.equal(plan.verdict, 'quota-daily');
  assert.equal(typeof plan.untilMs, 'number');
  assert.ok(Number.isFinite(plan.untilMs), 'una persistenza senza scadenza finita è un ban permanente');
  assert.ok(plan.untilMs > NOW, 'la scadenza deve stare nel futuro');
  assert.ok(plan.untilMs - NOW <= DAY, 'la quota giornaliera non può durare più di un giorno');
  assert.equal(plan.untilMs, Date.parse('2026-08-14T00:00:00Z'));
});

test('gli altri motivi noti NON sopravvivono al processo', () => {
  // Descrivono l'esito di UNA chiamata in QUESTO run: un timeout su una
  // generazione da 20 minuti non dice niente sullo stesso modello che serve un
  // prompt piccolo di un altro workflow fra dieci secondi.
  for (const reason of KNOWN_REASONS.filter((r) => !PERSISTED_REASONS.has(r))) {
    const plan = persistencePlan(reason, NOW);
    assert.equal(plan.persist, false, `\`${reason}\` non deve sopravvivere al processo`);
    assert.equal(plan.untilMs, null);
    assert.equal(plan.verdict, 'in-process');
  }
});

test('un esaurimento SENZA motivo distinto non viene mai persistito', () => {
  // Il cuore dell'osservatore: un motivo che non si sa leggere non ha una
  // scadenza nota, quindi non può essere persistito «con cautela». Mai.
  for (const bad of ['', '   ', undefined, null, 0, {}, 'motivo-inventato', 'QUOTA_EXCEEDED']) {
    const plan = persistencePlan(bad, NOW);
    assert.equal(plan.persist, false, `motivo ${JSON.stringify(bad)} non deve persistere`);
    assert.equal(plan.untilMs, null);
    assert.equal(plan.verdict, 'unknown-reason');
  }
});

test('INVARIANTE: nessun piano può persistere senza scadenza', () => {
  // Vale su ogni input, non solo su quelli noti. È la condizione che rende
  // «persistito a tempo indeterminato» impossibile invece che improbabile.
  const inputs = [...KNOWN_REASONS, '', 'x', undefined, null, 'Quota', ' QUOTA '];
  for (const r of inputs) {
    const plan = persistencePlan(r, NOW);
    assert.ok(
      !(plan.persist && plan.untilMs === null),
      `\`${String(r)}\` produce una persistenza senza scadenza: è il ban permanente di #203`,
    );
  }
});

test('il motivo è normalizzato, non interpretato', () => {
  assert.equal(persistencePlan(' QUOTA ', NOW).verdict, 'quota-daily');
  assert.equal(persistencePlan('Stale', NOW).verdict, 'in-process');
});

test('nextUtcMidnightMs è la mezzanotte UTC SUCCESSIVA, anche a ridosso', () => {
  assert.equal(nextUtcMidnightMs(Date.parse('2026-08-13T23:59:59Z')), Date.parse('2026-08-14T00:00:00Z'));
  assert.equal(nextUtcMidnightMs(Date.parse('2026-08-13T00:00:00Z')), Date.parse('2026-08-14T00:00:00Z'));
});

test('audit: un motivo non dichiarato viene segnalato, non ingoiato', () => {
  const events = [
    { model: 'openai/gpt-x', reason: 'quota' },
    { model: 'meta/llama-y', reason: 'boh' },
    { model: 'mistral/z', reason: '' },
  ];
  const findings = auditExhaustion(events, NOW);
  assert.deepEqual(findings.map((f) => f.model).sort(), ['meta/llama-y', 'mistral/z']);
  assert.ok(findings.every((f) => f.kind === 'unknown-reason'));
});

test('audit: niente da segnalare quando ogni motivo è dichiarato', () => {
  const events = KNOWN_REASONS.map((r, i) => ({ model: `m${i}`, reason: r }));
  assert.deepEqual(auditExhaustion(events, NOW), []);
});

test('il parser legge le righe vere di markModelExhausted', () => {
  // Forma letterale emessa da ai-models.mjs, id con slash e punti compresi.
  const log = [
    '2026-08-13T19:35:02Z 🚫 Model openrouter/meta-llama/llama-3.3-70b:free marked as exhausted (stale) — will be skipped for rest of run',
    '2026-08-13T19:35:03Z 🚫 Model github/gpt-4.1-mini marked as exhausted (quota) — will be skipped for rest of run',
    '2026-08-13T19:35:04Z qualche altra riga di log senza marker',
    '2026-08-13T19:35:05Z 🚫 Model cerebras/llama3.1-8b marked as exhausted (content) — will be skipped for rest of run',
  ].join('\n');
  const events = parseExhaustionEvents(log);
  assert.deepEqual(events, [
    { model: 'openrouter/meta-llama/llama-3.3-70b:free', reason: 'stale' },
    { model: 'github/gpt-4.1-mini', reason: 'quota' },
    { model: 'cerebras/llama3.1-8b', reason: 'content' },
  ]);
});

test('il parser non inventa eventi su un log che non ne ha', () => {
  assert.deepEqual(parseExhaustionEvents(''), []);
  assert.deepEqual(parseExhaustionEvents('Generated: true\nPush prosegue'), []);
});

test('il sommario separa le righe dai modelli distinti', () => {
  // La differenza è essa stessa un segnale: la run 31728613355 aveva 45 righe e
  // 23 modelli distinti, cioè una discovery che gira due volte.
  const events = [
    { model: 'a', reason: 'stale' },
    { model: 'a', reason: 'stale' },
    { model: 'b', reason: 'quota' },
  ];
  const s = summariseExhaustion(events);
  assert.equal(s.lines, 3);
  assert.equal(s.distinctModels, 2);
  assert.equal(s.distinctReasons, 2);
  assert.deepEqual(s.byReason, { stale: 2, quota: 1 });
  assert.deepEqual(s.persistedModels, ['b'], 'solo la quota finisce nello stato condiviso');
});

test('il sommario di un run pulito non riporta motivi', () => {
  const s = summariseExhaustion([]);
  assert.equal(s.lines, 0);
  assert.equal(s.distinctModels, 0);
  assert.equal(s.distinctReasons, 0);
  assert.deepEqual(s.persistedModels, []);
  assert.match(formatRunLine(123, s), /run 123/);
});
