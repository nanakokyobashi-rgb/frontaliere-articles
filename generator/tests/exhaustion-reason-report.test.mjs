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
  parseAggregateExhaustion,
  deferralVerdicts,
  formatVerdictLine,
  splitErrorEntries,
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


/**
 * ── IL CONFRONTO LORDO/NETTO SU UNA RUN PASSATA (#854) ──────────────────────
 *
 * La misura che #821 chiede — «quanti verdetti di deferral cambiano fra secchi
 * lordi e netti» — si fa rileggendo il messaggio aggregato di `callLLM` dai log
 * e rifacendo il conto con LE STESSE regex della produzione
 * (`classifyExhaustionCause`, importata: niente copia locale delle due regex,
 * AGENTS.md #6).
 *
 * Questi casi sono l'osservatore di quel parser. Senza, il giorno in cui il
 * formato del messaggio cambia — o le due regex si spostano — il report smette
 * di trovare cascate e stampa `flip: 0/0` invece di fallire: uno zero che si
 * legge «nessun verdetto cambia» quando vuol dire «non ho letto niente».
 *
 * La fixture riproduce la MECCANICA della run 31823202761 passando per le regex
 * vere: 41 fallimenti transitori indipendenti, 52 persistenti, e 12 fratelli
 * GitHub saltati con `cooling down` — vocabolario TRANSITORIO, quindi contati
 * nel secchio E come echi. Al lordo sono 53 vs 52, la maggioranza che si decide
 * per un voto; al netto sono 41 vs 52. Un solo host morto ribalta l'exit code.
 */
const cascataConEchiGithub = (() => {
  const errors = [];
  for (let i = 0; i < 41; i++) errors.push(`t${i}: skipped — exhausted (daily limit)`);
  for (let i = 0; i < 52; i++) errors.push(`p${i}: skipped — no API key configured`);
  // Forma letterale di `providerCooldownSkipLine`: e' quella che
  // PROVIDER_COOLDOWN_SKIP_RE riconosce, e la `skipPhrase` che matcha
  // `transientRe`. Dodici id fratelli, UN solo 429.
  for (let i = 0; i < 12; i++) errors.push(`gh-${i}: skipped — provider github cooling down after 429`);
  // La catena elenca gli STESSI id che prefissano le righe di `errors`: e' cio'
  // che `callLLM` emette (ogni `errors.push` usa `chain[i]`), ed e' l'ancora su
  // cui il parser ricuce le righe spezzate da un ` | ` interno.
  const chain = errors.map((e) => e.slice(0, e.indexOf(':')));
  return '2026-08-14T04:08:01Z   ⚠️  Tentativo 1 fallito: All AI models failed. '
    + `Chain: [${chain.join(' → ')}]. Errors: ${errors.join(' | ')}`;
})();

test('il parser ricostruisce l\'array `errors` dal messaggio aggregato (#854)', () => {
  const found = parseAggregateExhaustion(cascataConEchiGithub);
  assert.equal(found.length, 1, 'una cascata svuotata, una voce');
  assert.equal(found[0].errors.length, 105, 'ogni riga di `errors` torna separata');
  assert.equal(found[0].capCount, 0, 'nessun rifiuto su taglia in questa cascata');

  const v = deferralVerdicts(found[0]);
  assert.equal(v.breakdown.transient, 53, `secchio transitorio: ${JSON.stringify(v.breakdown)}`);
  assert.equal(v.breakdown.persistent, 52, `secchio persistente: ${JSON.stringify(v.breakdown)}`);
  assert.equal(v.breakdown.total, 105, 'il totale sono le righe');
  assert.equal(v.breakdown.providerCooldownSkips.total, 12, 'i dodici echi sono contati');
  assert.equal(v.breakdown.providerCooldownSkips.transient, 12,
    '`cooling down` e\' vocabolario transitorio: l\'eco vota, ed e\' per questo che va tolto');
});

test('lordo e netto DIVERGONO sulla meccanica della run 31823202761 (#854)', () => {
  // Il numero che #854 esiste per produrre. Il lordo dice 53 >= 52 → verde con
  // differimento; il netto sa che dodici righe sono l'eco di UN 429 e conta
  // 41 vs 52 → rosso. Se questa asserzione cade, `flip: 0/N` non significa
  // piu' «nessun verdetto cambia».
  const v = deferralVerdicts(parseAggregateExhaustion(cascataConEchiGithub)[0]);
  assert.equal(v.grossTransient, true, 'il calcolo pre-#857 differiva su questa cascata');
  assert.equal(v.netTransient, false, 'quello di oggi no');
  assert.equal(v.flip, true, 'la cascata deve contare come flip');
  assert.match(formatVerdictLine(31823202761, v), /← FLIP/);
});

test('la coda `Prompt budget:` non e\' una riga di errore, ma e\' la premessa del veto', () => {
  // `callLLM` appende il report di taglia allo stesso messaggio con lo stesso
  // separatore ` | `. Contarlo aggiungerebbe una riga fantasma a ogni cascata
  // con rifiuti su taglia; ignorarlo del tutto perderebbe `inputCapReport`,
  // cioe' la premessa senza la quale `isInputCapDeferralVeto` non si applica.
  const msg = 'All AI models failed. Chain: [x → y]. Errors: '
    + 'x: skipped — exhausted (daily limit) | y: skipped — no API key'
    + ' | Prompt budget: 3 model(s) refused a ~9000-token request;'
    + ' the most permissive cap among them is 4000 tokens (over by ~5000).';
  const [c] = parseAggregateExhaustion(msg);
  assert.equal(c.errors.length, 2, 'due righe di errore, non tre');
  assert.equal(c.capCount, 3, 'e tre modelli che hanno rifiutato sulla taglia');

  // 1 vs 1: il pareggio. Con rifiuti su taglia #357 lo da' al persistente.
  const v = deferralVerdicts(c);
  assert.equal(v.grossVeto, true, 'il pareggio con cap.count > 0 e\' un veto');
  assert.equal(v.netVeto, true, 'e resta tale al netto: qui non ci sono echi');
});

test('senza `inputCapReport` il veto non si applica e non entra nel confronto', () => {
  // Distinguere «non si applica» da «si applica e dice no»: contare la prima
  // come `veto=false` gonfierebbe il denominatore del flip con cascate su cui
  // il predicato non ha nemmeno guardato i secchi.
  const [c] = parseAggregateExhaustion(
    'All AI models failed. Chain: [x]. Errors: x: skipped — no API key',
  );
  const v = deferralVerdicts(c);
  assert.equal(v.grossVeto, false);
  assert.equal(v.netVeto, false);
  assert.equal(v.flip, false, 'nessun verdetto da confrontare, nessun flip');
});

test('un ` | ` DENTRO il messaggio di un provider non diventa una riga in piu\' (#888 item 4)', () => {
  // La sola riga a testo libero di `errors` e' `${model}: ${msg.slice(0, 200)}`
  // (ai-models.mjs): il messaggio e' testo di provider ripassato tale e quale,
  // e puo' contenere il separatore con cui `callLLM` unisce l'array. Con uno
  // `split(' | ')` nudo quella singola riga ne diventava due, gonfiando `total`
  // E il secchio — cioe' proprio i numeri su cui il verdetto viene calibrato.
  const msg = 'All AI models failed. Chain: [gh/a → gh/b]. Errors: '
    + 'gh/a: 429 Too Many Requests | rate limit reached | retry-after: 30'
    + ' | gh/b: skipped — no API key configured';
  const [c] = parseAggregateExhaustion(msg);
  assert.equal(c.errors.length, 2, 'due modelli in catena, due righe: non quattro');
  assert.equal(c.errors[0],
    'gh/a: 429 Too Many Requests | rate limit reached | retry-after: 30',
    'la riga si ricuce integralmente, separatori interni compresi');

  // E il conteggio non e' gonfio: un solo 429, non tre frammenti di 429.
  const v = deferralVerdicts(c);
  assert.equal(v.breakdown.total, 2, 'il totale sono i modelli falliti, non i frammenti');
  assert.equal(v.breakdown.transient, 1, 'un solo esaurimento transitorio');
});

test('senza catena leggibile il parser degrada allo split nudo, non ricuce tutto', () => {
  // Senza ancore, ricucire ogni frammento nella riga precedente collasserebbe
  // la cascata in UNA voce — un conteggio a ZERO informazione, peggio di quello
  // gonfio che si vuole evitare. Meglio il comportamento storico.
  const [c] = parseAggregateExhaustion(
    'All AI models failed. Chain: []. Errors: a: 429 | b: no API key',
  );
  assert.equal(c.errors.length, 2, 'due frammenti, due righe');
  assert.deepEqual(splitErrorEntries('a: 429 | b: no key', []), ['a: 429', 'b: no key']);
  assert.deepEqual(splitErrorEntries('a: 429 | b: no key', null), ['a: 429', 'b: no key']);
});

test('la coda `Prompt budget:` resta un\'ancora anche quando la precede un ` | ` interno', () => {
  // Il report di taglia non e' prefissato da un modello della catena: se non
  // fosse riconosciuto come inizio-voce verrebbe ricucito nell'ultima riga di
  // errore, e `capCount` — la premessa di `isInputCapDeferralVeto` — tornerebbe
  // a 0 su ogni cascata con rifiuti su taglia.
  const [c] = parseAggregateExhaustion(
    'All AI models failed. Chain: [m/1]. Errors: '
    + 'm/1: HTTP 400 | body: {"error":"too long"}'
    + ' | Prompt budget: 4 model(s) refused a ~9000-token request;',
  );
  assert.equal(c.errors.length, 1, 'una sola riga di errore, ricucita');
  assert.equal(c.capCount, 4, 'e il report di taglia resta separato e leggibile');
});

test('un log senza cascate non produce voci (lo zero e\' vero, non vacuo)', () => {
  assert.deepEqual(parseAggregateExhaustion('run pulita, nessun esaurimento'), []);
  assert.deepEqual(parseAggregateExhaustion(undefined), []);
});
