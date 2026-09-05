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
 * `tests.yml`. Fino al 2026-08-18 quel workflow aveva `branches-ignore: [main]` e
 * girava **solo sulle PR**; da allora gira anche sui push a `main`, perche' il
 * rescue `stuck-red` di `pr-autorebase.mjs` ha bisogno di una run `success` di
 * `tests.yml` su `main` da esibire.
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
  parseAggregateErrors,
  pickDecidingSample,
  deferralVerdicts,
  formatVerdictLine,
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


// ── I DUE VOTI DI DEFERRAL, LORDO CONTRO NETTO (issue #854 / #821) ──────────
//
// Il resto di questo file copre le marcature di `markModelExhausted`. I due
// predicati che decidono l'exit code di produzione leggono un ALTRO campione:
// l'array `errors` del messaggio aggregato di `callLLM`. Il modo
// `--deferral-verdicts` esiste per misurare quello, e questi casi sono
// l'osservatore che impedisce alla misura di degradare in silenzio: se il
// parser smette di leggere il messaggio aggregato, `flip: 0/40` è
// indistinguibile da «nessun verdetto cambia» — la risposta sbagliata alla
// domanda del punto 1 di #821, e per giunta rassicurante.

/**
 * La run 31823202761 (2026-08-14T17:45Z), ricomposta riga per riga nelle
 * proporzioni misurate e citate in `exhaustion-disposition.mjs`:
 *
 *   transient  = 53   (di cui 11 echi di un solo cooldown di provider)
 *   persistent = 52   (38 rifiuti su input cap, 12 «no API key», 2 × HTTP 404)
 *   ambiguo    =  1
 *   total      = 106
 *
 * Le righe sono quelle vere che `callLLM` mette in `errors`, non parafrasi: gli
 * echi passano da `providerCooldownSkipLine`, quindi il test fallisce anche se
 * a cambiare è la FORMA della riga invece del parser.
 */
function run31823202761Message() {
  const errors = [];
  for (let i = 0; i < 42; i++) errors.push(`github/model-${i}: 429 daily limit reached for this model`);
  for (let i = 0; i < 11; i++) errors.push(`github/sibling-${i}: skipped — provider github cooling down (rate-limited)`);
  for (let i = 0; i < 38; i++) errors.push(`or/model-${i}: request exceeds 8000 input cap (~9740 tokens estimated)`);
  for (let i = 0; i < 12; i++) errors.push(`cerebras/model-${i}: no API key configured`);
  errors.push('mistral/small: HTTP 404 model not found');
  errors.push('together/qwen: HTTP 404 model not found');
  errors.push('local/llama: empty response body');
  return 'All AI models failed. Chain: [a → b]. Errors: ' + errors.join(' | ')
    + ' | Prompt budget: 38 model(s) refused a ~9740-token request;'
    + ' the most permissive cap among them is 8000 tokens (over by ~1740).'
    + ' A retry must rebuild the prompt under 8000 tokens — resending the same messages cannot succeed.';
}

/** Il log come lo restituisce `gh run view --log`: righe prefissate da job/step/timestamp. */
function asRunLog(message) {
  return [
    'generate\tGenerate the article\t2026-08-14T17:44:58.1234567Z 🚫 Model github/gpt-4o marked as exhausted (quota) — will be skipped for rest of run',
    `generate\tGenerate the article\t2026-08-14T17:45:01.7654321Z ⚠️  Differito: tutti i modelli AI gratuiti sono temporaneamente esauriti (quota giornaliera). ${message}`,
    'generate\tGenerate the article\t2026-08-14T17:45:02.0000000Z Post job cleanup.',
  ].join('\n');
}

test('#854 — il campione del voto è il messaggio aggregato, e viene letto per intero', () => {
  const samples = parseAggregateErrors(asRunLog(run31823202761Message()));
  assert.equal(samples.length, 1, 'un solo messaggio aggregato in questo log');
  const [s] = samples;
  assert.equal(s.errors.length, 106, 'i 106 errori del tally, né uno in più né uno in meno');
  assert.equal(s.capRefusals, 38, 'il gate che arma il veto è `inputCapReport.count`');
  // Il report di budget NON deve entrare nella lista: è appeso con la stessa
  // ' | ' che separa gli errori, e come 107° riga gonfierebbe il denominatore.
  assert.ok(
    s.errors.every((e) => !e.includes('Prompt budget')),
    'la coda del report di budget non è un errore della cascata',
  );
});

test('#854 — sulla run 31823202761 ENTRAMBI i verdetti cambiano fra lordo e netto', () => {
  const v = deferralVerdicts(pickDecidingSample(asRunLog(run31823202761Message())));

  // I secchi ricontati con le regex IMPORTATE da ai-models.mjs: se una delle
  // due riformula, questi numeri si muovono qui invece che in produzione.
  assert.equal(v.transient, 53);
  assert.equal(v.persistent, 52);
  assert.equal(v.ambiguous, 1);
  assert.equal(v.total, 106);
  assert.equal(v.echoTotal, 11, 'gli 11 fratelli saltati sono UN solo guasto di provider');
  assert.equal(v.echoTransient, 11, 'e in una notte di quota vera votano TRANSITORIO');
  assert.equal(v.netTransient, 42);
  assert.equal(v.netPersistent, 52);
  assert.equal(v.echoDominated, false, '11 echi su 94 righe rimaste non sono la maggioranza delle prove');

  // 53 >= 52 → differimento concesso. UN VOTO, e undici di quei voti sono lo
  // stesso guasto contato dodici volte.
  assert.equal(v.grossTransientExhaustion, true);
  // 42 >= 52 → falso. È il verdetto che cambia.
  assert.equal(v.netTransientExhaustion, false);

  // Il veto di #313: `!(transient > persistent)` con ≥1 rifiuto su taglia.
  assert.equal(v.grossInputCapVeto, false, '53 > 52 al lordo → nessun veto → exit 0');
  assert.equal(v.netInputCapVeto, true, '42 > 52 è falso al netto → veto → exit 3');

  assert.equal(v.flipped, true);
  const line = formatVerdictLine(31823202761, v);
  assert.match(line, /FLIP/);
  // `agg=` distingue «cascata svuotata su un errore solo» da «parser che ne ha
  // letto uno su sette»: senza, un `tot=1` non è interpretabile.
  assert.match(line, /agg=1\b/);
  assert.match(line, /transientExhaustion L=si N=no/);
  assert.match(line, /inputCapVeto L=no N=si/);
});

test('#854 — senza echi i due verdetti coincidono: il modo non inventa flip', () => {
  const errors = [];
  for (let i = 0; i < 60; i++) errors.push(`p/model-${i}: 429 daily limit reached`);
  for (let i = 0; i < 40; i++) errors.push(`p/dead-${i}: no API key configured`);
  const msg = `All AI models failed. Chain: [a]. Errors: ${errors.join(' | ')}`;
  const v = deferralVerdicts(pickDecidingSample(asRunLog(msg)));
  assert.equal(v.echoTotal, 0);
  assert.equal(v.grossTransientExhaustion, v.netTransientExhaustion);
  assert.equal(v.grossInputCapVeto, v.netInputCapVeto);
  assert.equal(v.flipped, false, 'un flip su una cascata senza echi sarebbe la misura che misura sé stessa');
  assert.doesNotMatch(formatVerdictLine('x', v), /FLIP/);
});

test('#854 — senza rifiuti su taglia il veto non è armato, da nessuna delle due parti', () => {
  // Stesse proporzioni della run misurata, ma zero `Prompt budget:` → il gate
  // `cap.count > 0` di isInputCapDeferralVeto non scatta. Riportare la sola
  // maggioranza direbbe «il verdetto cambia» dove la produzione non cambia
  // niente, ed è il modo in cui una misura diventa un allarme che nessuno legge.
  const errors = [];
  for (let i = 0; i < 42; i++) errors.push(`p/model-${i}: 429 daily limit reached`);
  for (let i = 0; i < 11; i++) errors.push(`p/sib-${i}: skipped — provider github cooling down (rate-limited)`);
  for (let i = 0; i < 52; i++) errors.push(`p/dead-${i}: no API key configured`);
  const v = deferralVerdicts(pickDecidingSample(asRunLog(`All AI models failed. Chain: [a]. Errors: ${errors.join(' | ')}`)));
  assert.equal(v.capRefusals, 0);
  assert.equal(v.grossInputCapVeto, false);
  assert.equal(v.netInputCapVeto, false);
  // Ma il primo voto cambia lo stesso, e va visto.
  assert.equal(v.grossTransientExhaustion, true);
  assert.equal(v.netTransientExhaustion, false);
  assert.equal(v.flipped, true);
});

test('#854 — il campione è l\'ULTIMO messaggio aggregato, quello risalito al catch', () => {
  const first = 'All AI models failed. Chain: [a]. Errors: p/x: no API key configured';
  const last = 'All AI models failed. Chain: [b]. Errors: p/y: 429 daily limit reached';
  const log = `${asRunLog(first)}\n${asRunLog(last)}`;
  assert.equal(parseAggregateErrors(log).length, 2);
  assert.deepEqual(pickDecidingSample(log).errors, ['p/y: 429 daily limit reached']);
});

test('#854 — una run che non ha svuotato la cascata non ha un verdetto (e non è uno zero)', () => {
  // `null` e non un campione vuoto: un campione vuoto entrerebbe nel
  // denominatore di `flip: N/M` come «nessun cambiamento», che è esattamente
  // la risposta rassicurante e falsa che questo modo esiste per evitare.
  assert.equal(pickDecidingSample('generate\tstep\t2026-08-14T17:45:00Z Generated: true'), null);
  assert.equal(pickDecidingSample(''), null);
  assert.deepEqual(parseAggregateErrors(''), []);
});

test('#854 — `agg=` conta i messaggi aggregati della run, non solo quello che decide', () => {
  const first = 'All AI models failed. Chain: [a]. Errors: p/x: 429 daily limit reached | p/y: no API key configured';
  const last = 'All AI models failed. Chain: [b]. Errors: p/z: skipped — wall-clock deadline exceeded (timeout), aborted remaining chain (99 models left)';
  const sample = pickDecidingSample(`${asRunLog(first)}\n${asRunLog(last)}`);
  assert.equal(sample.aggregateCount, 2);
  const v = deferralVerdicts(sample);
  assert.equal(v.total, 1, 'il campione che decide è l\'ultimo, ed è povero');
  assert.equal(v.aggregateCount, 2, 'ma la riga deve dire che povero non vuol dire unico');
  assert.match(formatVerdictLine('x', v), /agg=2\b/);
});
