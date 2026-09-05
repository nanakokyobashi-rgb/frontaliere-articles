/**
 * ── UN HOST CHE SPARISCE COSTAVA PIU' DI UNO CHE RISPONDE «NO» (#475) ───────
 *
 * `GH_MODELS_BASE` (`models.inference.ai.azure.com`) e' la rotta ritirata
 * dietro OGNI id GitHub della catena. La sua misura e' cambiata due volte:
 *
 *   2026-08-18 → HTTP 404, corpo vuoto   (risponde, e nega la rotta)
 *   2026-09-04 → curl exit code 000      (non risponde affatto)
 *
 * Il 404 era gia' gestito: `classifyNonRetryableError` lo dichiara
 * non-ritentabile, quindi un round-trip morto per modello per run (#457).
 * Il `000` NO — e costa di piu' di cio' che ha sostituito. Senza uno status
 * HTTP non c'e' niente da classificare: `fetch` alza `TypeError: fetch failed`,
 * che non e' `nonRetryable` e non e' un timeout, quindi cadeva nel ramo
 * generico «Otherwise retry» e bruciava `maxRetriesPerModel` tentativi CON
 * backoff, per modello, per run.
 *
 * ── COSA BLOCCA QUESTO FILE ────────────────────────────────────────────────
 *
 * Non la stringa dell'endpoint — quella e' un dato esterno che cambia da solo.
 * Blocca il comportamento del CICLO, che e' cio' che il difetto abita:
 *
 *   1. un errore di connessione e' riconosciuto attraverso l'incapsulamento di
 *      undici (`cause`, e `AggregateError.errors` quando il DNS restituisce
 *      piu' indirizzi): `e.code` da solo e' `undefined` per ogni vero
 *      `fetch failed`, quindi una guardia scritta su `e.code` sembrerebbe
 *      giusta e non scatterebbe mai;
 *   2. un host irraggiungibile costa UN tentativo, non `maxRetriesPerModel`;
 *   3. i modelli FRATELLI dello stesso host non pagano ciascuno il proprio
 *      connect morto — il provider va in cooldown;
 *   4. ECONNRESET, i timeout e `EAI_AGAIN` (#770) restano ritentabili. E' il
 *      confine che rende la regola sicura: un reset a meta' stream e' transitorio
 *      su un host vivo, e allargare l'insieme scambierebbe un retry legittimo
 *      per un ban.
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { networkInterfaces } from 'node:os';
import { readFileSync } from 'node:fs';

import {
  classifyHostUnreachable,
  classifyResolverResetEvidence,
  classifyTransientResolver,
  callLLM,
  isQuotaExhaustedError,
  getStats,
  printRunSummary,
  resetState,
} from '../scripts/lib/ai-models.mjs';

// La forma REALE che undici produce: il codice syscall vive due livelli sotto.
function undiciFetchFailed(code) {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error(`${code} models.inference.ai.azure.com:443`), { code }),
  });
}

// Stessa cosa, ma con il DNS che ha restituito piu' indirizzi: undici prova
// ogni indirizzo e impacchetta i fallimenti in un AggregateError.
function undiciAggregate(code) {
  const agg = new AggregateError(
    [Object.assign(new Error('v6'), { code }), Object.assign(new Error('v4'), { code })],
    'all addresses failed',
  );
  return Object.assign(new TypeError('fetch failed'), { cause: agg });
}

describe('classifyHostUnreachable', () => {
  it('riconosce i codici di connessione attraverso il wrapping di undici', () => {
    assert.equal(classifyHostUnreachable(undiciFetchFailed('ENOTFOUND')), 'ENOTFOUND');
    assert.equal(classifyHostUnreachable(undiciFetchFailed('ECONNREFUSED')), 'ECONNREFUSED');
    assert.equal(classifyHostUnreachable(undiciAggregate('EHOSTUNREACH')), 'EHOSTUNREACH');
    // Errore nudo (non passato da fetch) — stessa classe, stessa risposta.
    assert.equal(classifyHostUnreachable(Object.assign(new Error('x'), { code: 'ENETUNREACH' })), 'ENETUNREACH');
  });

  it('NON classifica cio' + "'" + 'che e\' transitorio o gia\' coperto altrove', () => {
    // Un reset a meta' stream: l\'host e\' vivo, il retry ha senso.
    assert.equal(classifyHostUnreachable(undiciFetchFailed('ECONNRESET')), null);
    assert.equal(classifyHostUnreachable(undiciFetchFailed('EPIPE')), null);
    // #770 — `EAI_AGAIN` e' `getaddrinfo` che dice «riprova», non una risposta
    // autorevole come `ENOTFOUND`: sta nell'altra classe, non in questa.
    assert.equal(classifyHostUnreachable(undiciFetchFailed('EAI_AGAIN')), null);
    // Il timeout ha gia' il suo ramo, con la sua motivazione: non va rubato.
    assert.equal(classifyHostUnreachable(Object.assign(new Error('t'), { name: 'AbortError' })), null);
    assert.equal(classifyHostUnreachable(new Error('HTTP 404: ')), null);
    assert.equal(classifyHostUnreachable(null), null);
    assert.equal(classifyHostUnreachable(undefined), null);
  });

  it('non entra in ciclo su una catena di cause auto-referenziale', () => {
    const a = new Error('a');
    const b = new Error('b');
    a.cause = b;
    b.cause = a;
    assert.equal(classifyHostUnreachable(a), null);
  });
});

describe('classifyTransientResolver', () => {
  it('riconosce il flap del resolver attraverso il wrapping di undici', () => {
    assert.equal(classifyTransientResolver(undiciFetchFailed('EAI_AGAIN')), 'EAI_AGAIN');
    assert.equal(classifyTransientResolver(undiciAggregate('EAI_AGAIN')), 'EAI_AGAIN');
  });

  it('non ruba cio\' che appartiene alla classe irraggiungibile', () => {
    // Le due classi sono DISGIUNTE: se un codice cadesse in entrambe, l'ordine
    // di classificazione in callLLM deciderebbe il comportamento per caso.
    for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN']) {
      assert.equal(classifyTransientResolver(undiciFetchFailed(code)), null, code);
    }
    assert.equal(classifyTransientResolver(undiciFetchFailed('ECONNRESET')), null);
    assert.equal(classifyTransientResolver(null), null);
  });

  it('non entra in ciclo su una catena di cause auto-referenziale', () => {
    const a = new Error('a');
    const b = new Error('b');
    a.cause = b;
    b.cause = a;
    assert.equal(classifyTransientResolver(a), null);
  });
});

describe('callLLM contro un host che non accetta connessioni', () => {
  const ENV_KEYS = ['AI_MODELS_FORCE_CHAIN', 'GH_MODELS_PAT', 'AI_MODELS_PREFER'];
  let envBackup = {};
  let realFetch;
  let fetchCalls;
  // Solo le chiamate all'host GitHub. La model-discovery all'avvio passa dallo
  // stesso `globalThis.fetch` e contarla renderebbe il numero illeggibile —
  // ed e' proprio il numero cio' che questo test misura.
  const ghCalls = () => fetchCalls.filter((u) => u.includes('models.inference.ai.azure.com'));

  beforeEach(() => {
    envBackup = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.GH_MODELS_PAT = 'test-pat';
    // Due id GitHub: il secondo e' il FRATELLO, servito dallo stesso host.
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o-mini,gpt-4.1-mini';
    fetchCalls = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      fetchCalls.push(String(url));
      throw undiciFetchFailed('ENOTFOUND');
    };
    resetState();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
    resetState();
  });

  it('paga un solo connect morto per tutta la catena, non uno per tentativo', async () => {
    await assert.rejects(
      () => callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 3, backoffMs: 1, timeout: 5000 }),
    );

    const stats = getStats();

    // 1 — un tentativo, non `maxRetriesPerModel`. E' la meta' della fix che
    // riguarda il singolo modello: il ramo generico ne avrebbe fatti 3, con
    // due sleep di backoff in mezzo.
    assert.equal(stats.retries, 0, 'un connect rifiutato non va ritentato dentro la stessa chiamata');

    // 2 — e un solo connect in tutto: il fratello non ripaga il proprio, che
    // e' la meta' che riguarda l\'host. Con 12 id GitHub in catena questa e' la
    // differenza fra 1 e 36 round-trip morti per run.
    assert.equal(ghCalls().length, 1, `un solo connect atteso, visti ${ghCalls().length}: ${ghCalls().join(', ')}`);

    // 3 — il modello e' esaurito per la run e il provider e' in cooldown, cioe'
    // i fratelli vengono saltati PRIMA di comporre il numero.
    assert.ok(stats.exhaustedModels.includes('gpt-4o-mini'), `atteso gpt-4o-mini esaurito, visti: ${stats.exhaustedModels.join(', ')}`);
    assert.ok(stats.activeCooldowns.github > 0, `atteso un cooldown su github, visti: ${JSON.stringify(stats.activeCooldowns)}`);
  });

  it('il fratello saltato vota PERSISTENTE, non transitorio', async () => {
    // Il costo del cooldown non e' solo un connect risparmiato: la riga di skip
    // che produce finisce in `errors`, e `classifyExhaustionCause` la conta.
    // `cooling down` e' vocabolario TRANSITORIO li' dentro, e con 12 id GitHub
    // un host definitivamente morto aggiungerebbe fino a 11 voti transitori —
    // `transientExhaustion` e' `transient >= persistent` e la run 31823202761
    // si e' decisa per UN voto. Il risultato sarebbe `create-article.mjs` che
    // differisce: exit 0, run verde, nessun articolo, nessun alert, su un host
    // che non torna. Quindi questa causa si nomina `non-retryable`.
    const err = await callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 3, backoffMs: 1, timeout: 5000 })
      .then(() => null, (e) => e);

    assert.ok(err, 'la catena deve fallire');
    assert.match(err.message, /skipped — provider github unreachable \(ENOTFOUND\), non-retryable/);
    assert.doesNotMatch(err.message, /cooling down/, 'un host che non risponde non e\' un 429');
    assert.equal(err.exhaustionBreakdown.transient, 0, `nessun voto transitorio atteso: ${err.message}`);
    assert.ok(err.exhaustionBreakdown.persistent >= 1, `atteso almeno un voto persistente: ${JSON.stringify(err.exhaustionBreakdown)}`);
    assert.equal(err.transientExhaustion, false, 'una run senza articolo su un host morto non deve essere verde');
  });

  // ── #769: IL TAG NON DEVE DIPENDERE DA QUANTI TENTATIVI RESTANO ─────────
  // Il tag `hostUnreachable` veniva posato in un ramo che solo i tentativi
  // NON finali raggiungono: il `throw` dell'ultimo tentativo lo precedeva.
  // Con `maxRetriesPerModel: 1` il primo tentativo e' gia' l'ultimo, quindi
  // l'errore usciva nudo e il breaker di callLLM() non scattava — il conto
  // dei connect morti tornava a uno per id, che e' proprio cio' che #475 ha
  // tolto. Il test precedente non lo vedeva perche' passa 3.
  it('taglia i fratelli anche con maxRetriesPerModel: 1', async () => {
    await assert.rejects(
      () => callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 }),
    );

    const stats = getStats();
    assert.equal(ghCalls().length, 1, `un solo connect atteso anche con un solo tentativo, visti ${ghCalls().length}: ${ghCalls().join(', ')}`);
    assert.ok(stats.exhaustedModels.includes('gpt-4o-mini'), `atteso gpt-4o-mini esaurito, visti: ${stats.exhaustedModels.join(', ')}`);
    assert.ok(stats.activeCooldowns.github > 0, `atteso un cooldown su github, visti: ${JSON.stringify(stats.activeCooldowns)}`);
  });

  // Il tag e' una convenzione fra funzioni, e callLLM non deve dipenderne:
  // la causa e' LEGGIBILE dall'errore. Qui l'errore esce dal retry loop per
  // una porta che il tagging non attraversa (`nonRetryable`), come farebbe
  // un caller che quella convenzione non la conosce — claude-cli, o un
  // provider aggiunto domani. Il breaker deve scattare lo stesso.
  it('classifica la causa anche su un errore uscito senza tag', async () => {
    globalThis.fetch = async (url) => {
      fetchCalls.push(String(url));
      throw Object.assign(undiciFetchFailed('ENOTFOUND'), { nonRetryable: true });
    };

    const err = await callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 3, backoffMs: 1, timeout: 5000 })
      .then(() => null, (e) => e);

    assert.ok(err, 'la catena deve fallire');
    assert.equal(ghCalls().length, 1, `un solo connect atteso, visti ${ghCalls().length}: ${ghCalls().join(', ')}`);
    assert.ok(getStats().activeCooldowns.github > 0, `atteso un cooldown su github, visti: ${JSON.stringify(getStats().activeCooldowns)}`);
    assert.match(err.message, /skipped — provider github unreachable \(ENOTFOUND\), non-retryable/);
    assert.equal(err.transientExhaustion, false, 'una run senza articolo su un host morto non deve essere verde');
  });

  it('un ECONNRESET resta ritentabile — il confine della regola', async () => {
    globalThis.fetch = async (url) => {
      fetchCalls.push(String(url));
      throw undiciFetchFailed('ECONNRESET');
    };
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o-mini';

    await assert.rejects(
      () => callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 3, backoffMs: 1, timeout: 5000 }),
    );

    assert.equal(ghCalls().length, 3, `un reset transitorio va ritentato fino a maxRetriesPerModel, visti ${ghCalls().length} tentativi`);
    assert.equal(getStats().activeCooldowns.github, undefined, 'un reset non deve congelare il provider');
  });
});

/**
 * ── UN HICCUP DEL RESOLVER NON E' UN VERDETTO SULL'HOST (#770) ─────────────
 *
 * `EAI_AGAIN` viaggiava nello stesso insieme di `ENOTFOUND`, ma i due codici
 * non dicono la stessa cosa: `ENOTFOUND` e' una risposta AUTOREVOLE («questo
 * nome non esiste»), `EAI_AGAIN` e' letteralmente «riprova». Un singolo
 * inciampo del resolver sul runner costava quindi il modello esaurito per la
 * run PIU' i 60s di cooldown del provider — cioe' tutti i fratelli serviti da
 * quell'host — per un guasto che di norma passa al round-trip successivo.
 *
 * Cio' che #475 ha comprato non viene restituito, viene reso CONDIZIONALE: il
 * flap e' ritentabile finche' sembra un flap, e alla terza chiamata fallita di
 * fila sullo stesso provider smette di sembrarlo e prende il ramo di #475
 * senza modifiche.
 */
describe('callLLM contro un resolver che inciampa (#770)', () => {
  const ENV_KEYS = ['AI_MODELS_FORCE_CHAIN', 'GH_MODELS_PAT', 'AI_MODELS_PREFER'];
  let envBackup = {};
  let realFetch;
  let fetchCalls;
  const ghCalls = () => fetchCalls.filter((u) => u.includes('models.inference.ai.azure.com'));

  beforeEach(() => {
    envBackup = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.GH_MODELS_PAT = 'test-pat';
    fetchCalls = [];
    realFetch = globalThis.fetch;
    resetState();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
    resetState();
  });

  it('un flap non esaurisce il modello e non congela il provider', async () => {
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o-mini';
    globalThis.fetch = async (url) => {
      fetchCalls.push(String(url));
      throw undiciFetchFailed('EAI_AGAIN');
    };

    await assert.rejects(
      () => callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 3, backoffMs: 1, timeout: 5000 }),
    );

    const stats = getStats();
    // Il backoff del retry loop E' il «try again» che il codice chiede.
    assert.equal(ghCalls().length, 3, `un flap va ritentato fino a maxRetriesPerModel, visti ${ghCalls().length}`);
    assert.equal(stats.activeCooldowns.github, undefined, 'un hiccup del resolver non deve congelare il provider');
    assert.ok(!stats.exhaustedModels.includes('gpt-4o-mini'), `il modello non va bannato per un flap: ${stats.exhaustedModels.join(', ')}`);
    assert.equal(stats.resolverFlaps.github, 1, `atteso un flap contato: ${JSON.stringify(stats.resolverFlaps)}`);
  });

  it('alla terza chiamata fallita di fila il flap smette di essere un flap', async () => {
    // Tre id GitHub: tre tentativi di modello falliti sullo stesso provider.
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o-mini,gpt-4.1-mini,gpt-4o';
    globalThis.fetch = async (url) => {
      fetchCalls.push(String(url));
      throw undiciFetchFailed('EAI_AGAIN');
    };

    await assert.rejects(
      () => callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 }),
    );

    const stats = getStats();
    // Con maxRetriesPerModel: 1 ogni modello costa un connect: i primi due
    // sono flap ritentabili, il terzo scala e prende il ramo di #475.
    assert.equal(ghCalls().length, 3, `attesi 3 connect prima dell'escalation, visti ${ghCalls().length}`);
    assert.ok(stats.activeCooldowns.github > 0, `atteso il cooldown dopo l'escalation: ${JSON.stringify(stats.activeCooldowns)}`);
    assert.ok(stats.exhaustedModels.includes('gpt-4o'), `atteso il modello dell'escalation esaurito, visti: ${stats.exhaustedModels.join(', ')}`);
  });

  it('l\'escalation e\' per provider, non globale', async () => {
    // Il guasto che `EAI_AGAIN` descrive e' il nome dell'host, che i fratelli
    // dello STESSO provider condividono — non i modelli di un altro.
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o-mini,gpt-4.1-mini';
    globalThis.fetch = async (url) => {
      fetchCalls.push(String(url));
      throw undiciFetchFailed('EAI_AGAIN');
    };

    await assert.rejects(
      () => callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 }),
    );

    const stats = getStats();
    assert.equal(stats.resolverFlaps.github, 2, `attesi 2 flap sotto soglia: ${JSON.stringify(stats.resolverFlaps)}`);
    assert.equal(stats.activeCooldowns.github, undefined, 'sotto soglia il provider resta disponibile');
    assert.equal(stats.exhaustedModels.length, 0, `nessun ban sotto soglia, visti: ${stats.exhaustedModels.join(', ')}`);
  });
});

/**
 * ── #781: L'ESENZIONE SI DECIDE SULL'ENDPOINT, NON SULLA CLASSE ────────────
 *
 * Il breaker di #475 chiede «un connect rifiutato qui prova che un host e'
 * morto?». `_isLastResortProvider` risponde a un'altra domanda — «questo
 * provider ha una quota giornaliera?» — ed e' quella giusta per il ban da 429
 * e da timeout, non per questa.
 *
 * `local/` e `omniroute/` puntano di DEFAULT a 127.0.0.1: li' ECONNREFUSED
 * dice «il server non gira su questo runner», stato normale in CI. Ma i due
 * URL sono sovrascrivibili, e verso un host remoto lo stesso codice torna a
 * essere la prova che l'esenzione stava buttando via.
 */
describe('esenzione dal breaker: loopback vs host remoto', () => {
  const ENV_KEYS = [
    'AI_MODELS_FORCE_CHAIN', 'AI_MODELS_PREFER', 'GH_MODELS_PAT',
    'OMNIROUTE_ENABLED', 'OMNIROUTE_URL',
    'LOCAL_LLM_ENABLED', 'LOCAL_LLM_URL',
  ];
  let envBackup = {};
  let realFetch;

  beforeEach(() => {
    envBackup = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    realFetch = globalThis.fetch;
    resetState();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
    resetState();
  });

  // Un connect rifiutato verso un endpoint di loopback descrive UNA macchina,
  // e il ban lo scriverebbe nel ledger Firestore CONDIVISO da tutte le run.
  for (const [label, env, model, provider] of [
    ['omniroute', { OMNIROUTE_ENABLED: '1' }, 'omniroute/auto', 'omniroute'],
    ['local',     { LOCAL_LLM_ENABLED: '1' }, 'local/fallback', 'local'],
  ]) {
    it(`${label} su loopback resta esente — il server spento non e' un host morto`, async () => {
      Object.assign(process.env, env);
      process.env.AI_MODELS_FORCE_CHAIN = model;
      globalThis.fetch = async () => { throw undiciFetchFailed('ECONNREFUSED'); };

      await assert.rejects(
        () => callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 }),
      );

      const stats = getStats();
      assert.ok(!stats.exhaustedModels.includes(model), `${model} non va bannato su loopback, visti: ${stats.exhaustedModels.join(', ')}`);
      assert.equal(stats.activeCooldowns[provider], undefined, `nessun cooldown atteso su loopback: ${JSON.stringify(stats.activeCooldowns)}`);
    });

    it(`${label} verso un host REMOTO arma il breaker come ogni altro provider`, async () => {
      Object.assign(process.env, env);
      process.env.AI_MODELS_FORCE_CHAIN = model;
      process.env[label === 'omniroute' ? 'OMNIROUTE_URL' : 'LOCAL_LLM_URL'] =
        'https://gateway.example.invalid/v1/chat/completions';
      globalThis.fetch = async () => { throw undiciFetchFailed('ECONNREFUSED'); };

      await assert.rejects(
        () => callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 }),
      );

      const stats = getStats();
      assert.ok(stats.exhaustedModels.includes(model), `atteso ${model} esaurito su host remoto morto, visti: ${stats.exhaustedModels.join(', ')}`);
      assert.ok(stats.activeCooldowns[provider] > 0, `atteso il cooldown su host remoto morto: ${JSON.stringify(stats.activeCooldowns)}`);
    });
  }

  // Il 429 e il timeout restano esenti a prescindere dall'endpoint: quella
  // esenzione risponde alla domanda sulla QUOTA, che l'URL non tocca.
  it('un host remoto non toglie a omniroute l\'esenzione dal ban da 429', async () => {
    process.env.OMNIROUTE_ENABLED = '1';
    process.env.OMNIROUTE_URL = 'https://gateway.example.invalid/v1/chat/completions';
    process.env.AI_MODELS_FORCE_CHAIN = 'omniroute/auto';
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response('rate limit exceeded', { status: 429 }); };

    // DUE chiamate, non una (#813). Una sola `callLLM` conta UN 429 e il ban
    // scatta a MAX_CONSECUTIVE_429 = 2: con una chiamata sola questo assert
    // resterebbe verde anche sostituendo `_isLastResortProvider` con
    // `_isHostUnreachableExempt` nel ramo del 429 — cioe' non pinnerebbe
    // affatto l'esenzione che dice di misurare. La catena e' pinnata a un solo
    // id, quindi il contatore non si azzera fra le due chiamate.
    for (let i = 0; i < 2; i++) {
      await assert.rejects(
        () => callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 }),
      );
    }
    // Se il secondo 429 non venisse mai composto (un cooldown che salta l'id,
    // un reset del contatore) l'assert sotto tornerebbe verde per il motivo
    // sbagliato: il contatore non arriverebbe alla soglia nemmeno senza
    // esenzione.
    assert.ok(calls >= 2, `attesi due 429 contro omniroute, visti ${calls}`);

    const stats = getStats();
    assert.ok(!stats.exhaustedModels.includes('omniroute/auto'), `un 429 non deve bannare omniroute: ${stats.exhaustedModels.join(', ')}`);
  });
});

/**
 * ── #781: IL PERCORSO MULTI-PAT NON PRODUCE UN VERDETTO DI UNA SOLA IDENTITA' ─
 *
 * Il dubbio: `_callGitHub` prova PAT diversi, quindi un `hostUnreachable` che
 * esce di li' potrebbe descrivere UN account e mettere in cooldown l'intero
 * provider. Non e' cosi', e queste due prove pinnano il perche':
 *
 *   - solo `_isGhPatQuotaError` fa ruotare; un connect rifiutato propaga nudo
 *     l'errore del singolo tentativo, senza aggregazione;
 *   - i codici host-unreachable sono PRE-AUTENTICAZIONE verso un endpoint
 *     costante, quindi il PAT — che e' un header — non puo' cambiarne l'esito.
 *
 * Se una delle due cade, il breaker va ri-condizionato alla rotazione.
 */
describe('_callGitHub multi-PAT e il verdetto sull\'host', () => {
  const ENV_KEYS = ['AI_MODELS_FORCE_CHAIN', 'AI_MODELS_PREFER', 'GH_MODELS_PAT', 'GH_MODELS_PAT_2'];
  let envBackup = {};
  let realFetch;
  let auths;
  const ghAuths = () => auths;

  beforeEach(() => {
    envBackup = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.GH_MODELS_PAT = 'pat-uno';
    process.env.GH_MODELS_PAT_2 = 'pat-due';
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o-mini';
    auths = [];
    realFetch = globalThis.fetch;
    resetState();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
    resetState();
  });

  // Il connect e' identico per ogni identita': ruotare ripagherebbe N connect
  // morti verso lo stesso host — esattamente il costo che #475 ha tolto.
  it('un connect rifiutato non ruota sul secondo PAT e arma il breaker', async () => {
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('models.inference.ai.azure.com')) {
        auths.push(init?.headers?.Authorization || init?.headers?.authorization || '');
        throw undiciFetchFailed('ECONNREFUSED');
      }
      throw undiciFetchFailed('ECONNREFUSED');
    };

    await assert.rejects(
      () => callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 }),
    );

    assert.equal(ghAuths().length, 1, `un solo connect atteso, non uno per PAT: visti ${ghAuths().length}`);
    const stats = getStats();
    assert.ok(stats.exhaustedModels.includes('gpt-4o-mini'), `atteso il modello esaurito, visti: ${stats.exhaustedModels.join(', ')}`);
    assert.ok(stats.activeCooldowns.github > 0, `atteso il cooldown del provider: ${JSON.stringify(stats.activeCooldowns)}`);
  });

  // Il contrappunto: un errore che DIPENDE dall'identita' ruota, e non decide
  // niente sull'host. E' la riga che separa le due classi.
  it('un 429 del primo PAT ruota sul secondo invece di giudicare l\'host', async () => {
    globalThis.fetch = async (url, init) => {
      if (!String(url).includes('models.inference.ai.azure.com')) throw undiciFetchFailed('ECONNREFUSED');
      const auth = String(init?.headers?.Authorization || init?.headers?.authorization || '');
      auths.push(auth);
      if (auth.includes('pat-uno')) return new Response('rate limit exceeded', { status: 429 });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
    };

    const out = await callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 });

    assert.equal(out, 'ok');
    assert.equal(ghAuths().length, 2, `attesi due tentativi, uno per PAT: visti ${ghAuths().length}`);
    assert.ok(ghAuths()[1].includes('pat-due'), `il secondo tentativo deve usare il PAT #2: ${ghAuths()[1]}`);
    assert.equal(getStats().activeCooldowns.github, undefined, 'un 429 di un account non deve congelare il provider');
  });
});

/**
 * ── UNA CAUSA DI COOLDOWN SI PROMUOVE, NON SI RETROCEDE (#787) ─────────────
 *
 * `cooldownProvider` viene chiamata da due posti con due cause diverse — il
 * 429 e l'host irraggiungibile — e NON in un ordine garantito: dentro lo
 * stesso modello, il primo tentativo puo' prendere un 429 (che apre il
 * cooldown e ritenta) e il secondo trovare l'host morto.
 *
 * Il ramo di #475 usciva su `if (!isProviderCoolingDown(provider))`, cioe'
 * proprio quando la causa era gia' scritta — e restava quella del 429. La
 * frase che i fratelli lasciano in `errors` e' un VOTO: `cooling down` sta nel
 * vocabolario transitorio di `classifyExhaustionCause`, e con 12 id GitHub in
 * catena un host definitivamente morto tornava a votare «riprova domani».
 * Esito: `create-article.mjs` differisce, exit 0, run verde, nessun articolo,
 * nessun alert — esattamente cio' che il round 2 di #767 esisteva per evitare.
 */
describe('promozione della causa del cooldown (#787)', () => {
  // Tutti i PAT aggiuntivi vanno tolti, non solo il #2: con piu' di
  // un'identita' il 429 NON apre il cooldown (`_suppressExhaustionMark`,
  // la quota e' dell'account, non del provider) e lo scenario che questo
  // blocco misura non si formerebbe affatto. Il runner CI ne ha impostati
  // due, quindi senza questa riga il test passerebbe anche senza la fix.
  const ENV_KEYS = [
    'AI_MODELS_FORCE_CHAIN', 'GH_MODELS_PAT', 'AI_MODELS_PREFER',
    ...Array.from({ length: 8 }, (_, i) => `GH_MODELS_PAT_${i + 2}`),
  ];
  let envBackup = {};
  let realFetch;
  let ghCalls;

  beforeEach(() => {
    envBackup = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.GH_MODELS_PAT = 'test-pat';
    // Due id GitHub: il secondo e' il fratello che eredita la causa del primo.
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o-mini,gpt-4.1-mini';
    ghCalls = 0;
    realFetch = globalThis.fetch;
    resetState();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
    resetState();
  });

  it('un 429 seguito da un host morto fa votare i fratelli PERSISTENTE', async () => {
    globalThis.fetch = async (url) => {
      if (!String(url).includes('models.inference.ai.azure.com')) throw undiciFetchFailed('ENOTFOUND');
      ghCalls += 1;
      // 1° tentativo: 429 → apre il cooldown del provider con causa transitoria
      // e ritenta DENTRO lo stesso modello (nessun re-check pre-flight).
      if (ghCalls === 1) return new Response('rate limit exceeded', { status: 429 });
      // 2° tentativo: l'host non accetta piu' connessioni.
      throw undiciFetchFailed('ENOTFOUND');
    };

    const err = await callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 2, backoffMs: 1, timeout: 5000 })
      .then(() => null, (e) => e);

    assert.ok(err, 'la catena deve fallire');
    assert.equal(ghCalls, 2, `attesi due tentativi sul primo id e nessuno sul fratello, visti ${ghCalls}`);
    assert.ok(getStats().activeCooldowns.github > 0, `atteso il cooldown del provider: ${JSON.stringify(getStats().activeCooldowns)}`);
    // La riga del fratello nomina la causa NUOVA, non quella con cui il
    // cooldown era stato aperto.
    assert.match(err.message, /skipped — provider github unreachable \(ENOTFOUND\), non-retryable/);
    assert.doesNotMatch(err.message, /skipped — provider github cooling down/, 'la causa del 429 non deve sopravvivere all\'host morto');
    assert.equal(err.exhaustionBreakdown.transient, 0, `nessun voto transitorio atteso: ${err.message}`);
    assert.ok(err.exhaustionBreakdown.persistent >= 1, `atteso almeno un voto persistente: ${JSON.stringify(err.exhaustionBreakdown)}`);
    assert.equal(err.transientExhaustion, false, 'una run senza articolo su un host morto non deve essere verde');
  });

  // Il verso opposto della stessa regola. Le due cause non arrivano solo in
  // sequenza: le chiamate a `callLLM` corrono in parallelo, e un 429 partito
  // PRIMA che l'host morisse puo' atterrare DOPO. Il pre-flight non lo ferma —
  // il fratello aveva gia' superato il controllo del cooldown quando e' stato
  // lanciato. Senza l'ordine di gravita', quel 429 riscriverebbe la causa in
  // `cooling down (rate-limited)` e i fratelli successivi tornerebbero a
  // votare transitorio su un host che non risponde.
  // Due cose che questa prova deve possedere invece di sperarle (#830):
  //
  //   1. L'ORDINE DELLA CATENA. `opts.chain` non e' un pin: senza
  //      `AI_MODELS_FORCE_CHAIN` callLLM lo passa per `sortChainByScore` e
  //      `applyModelsPrefer`, che riordinano — e su un ordine riordinato il
  //      429 non atterra piu' sull'id che la prova crede. La catena va quindi
  //      forzata prima di OGNI chiamata (l'override viene letto quando la
  //      chiamata risolve la propria catena, non quando la promise nasce).
  //   2. CHE IL 429 ATTERRI DAVVERO. Se il cooldown dell'host morto si aprisse
  //      prima che la fetch rate-limited sia partita, il pre-flight salterebbe
  //      l'id e nessun 429 arriverebbe mai: le assertion sotto resterebbero
  //      verdi anche sul codice PRE-fix, cioe' la prova smetterebbe di essere
  //      una prova senza che nulla fallisca. Il gate `inFlight429` sequenzia
  //      le due cause, e `served429` verifica che il 429 sia stato servito.
  it('un 429 atterrato dopo non retrocede la causa a transitoria', async () => {
    let served429 = 0;
    let releaseLate429;
    let enter429;
    const late429 = new Promise((resolve) => { releaseLate429 = resolve; });
    const inFlight429 = new Promise((resolve) => { enter429 = resolve; });
    globalThis.fetch = async (url, init) => {
      if (!String(url).includes('models.inference.ai.azure.com')) throw undiciFetchFailed('ENOTFOUND');
      ghCalls += 1;
      if (String(init?.body || '').includes('gpt-4o-mini')) throw undiciFetchFailed('ENOTFOUND');
      enter429();
      await late429;
      served429 += 1;
      return new Response('rate limit exceeded', { status: 429 });
    };

    const opts = { maxRetriesPerModel: 2, backoffMs: 1, timeout: 5000 };
    // Il 429 e' in volo per primo ma resta appeso al gate.
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4.1-mini';
    const rateLimited = callLLM([{ role: 'user', content: 'x' }], opts)
      .then(() => null, (e) => e);
    // Da qui in poi la fetch del 429 e' entrata: il pre-flight non puo' piu'
    // cancellarla, e l'ordine fra le due cause smette di essere una corsa.
    await inFlight429;
    // L'host muore mentre l'altro aspetta: la causa persistente viene scritta.
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o-mini';
    const unreachable = await callLLM([{ role: 'user', content: 'x' }], opts)
      .then(() => null, (e) => e);
    assert.ok(unreachable, 'la chiamata sull\'host morto deve fallire');
    releaseLate429();
    assert.ok(await rateLimited, 'anche la chiamata rate-limited deve fallire');
    assert.ok(served429 >= 1, 'il 429 tardivo non e\' mai atterrato: la prova sarebbe vacua');

    // Un terzo fratello, dopo entrambe: la causa che legge deve essere ancora
    // quella persistente.
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o';
    const later = await callLLM([{ role: 'user', content: 'x' }], opts)
      .then(() => null, (e) => e);

    assert.ok(later, 'la catena deve fallire');
    assert.match(later.message, /skipped — provider github unreachable \(ENOTFOUND\), non-retryable/);
    assert.doesNotMatch(later.message, /cooling down/, 'il 429 tardivo non deve riscrivere la causa');
    assert.equal(later.transientExhaustion, false, 'la causa persistente deve reggere');
  });
});

/**
 * ── IL BAN DI UN HOST MORTO VALE PER L'INTERA RUN (#803) ───────────────────
 *
 * `PROVIDER_COOLDOWN_MS` e' 60_000 perche' nasce dal 429: il bucket di quota si
 * ricarica da solo, quindi dopo un minuto riprovare e' la cosa giusta. Un host
 * che non accetta connessioni non si ricarica da solo, e con la stessa finestra
 * la scadenza rimetteva in gioco il primo fratello ancora eleggibile: ricompone
 * il numero, fallisce, viene esaurito, riapre il cooldown. Il costo reale non
 * era «1 connect per run» (#767) ma **1 connect al minuto per provider**, e una
 * run del generatore dura minuti.
 *
 * Le prove qui vanno lette insieme, perche' cio' che pinnano e' un CONFINE, e
 * un confine ha due lati: la prima dice che la causa autoritativa NON scade; la
 * seconda che il flap del resolver escalato (#770), che arriva allo stesso ramo
 * con `e.hostUnreachable = 'EAI_AGAIN'`, prende invece una finestra finita — o
 * tre hiccup DNS spegnerebbero la catena tier-0 per una run intera; la terza
 * che il ban lungo non ha inghiottito nemmeno il 429, che deve continuare a
 * scadere dopo 60s.
 */
describe('durata del cooldown per causa (#803)', () => {
  // Come nel blocco della promozione: con piu' di un PAT il 429 non apre il
  // cooldown del provider (la quota e' dell'account), e la seconda prova
  // misurerebbe un cooldown che non c'e' mai stato.
  const ENV_KEYS = [
    'AI_MODELS_FORCE_CHAIN', 'GH_MODELS_PAT', 'AI_MODELS_PREFER',
    ...Array.from({ length: 8 }, (_, i) => `GH_MODELS_PAT_${i + 2}`),
  ];
  const OPTS = { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 };
  let envBackup = {};
  let realFetch;
  let fetchCalls;
  const ghCalls = () => fetchCalls.filter((u) => u.includes('models.inference.ai.azure.com'));

  beforeEach(() => {
    envBackup = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.GH_MODELS_PAT = 'test-pat';
    // Sei id GitHub: prima della fix ogni scadenza della finestra ne rimetteva
    // in gioco UNO, quindi la catena bastava a pagare un connect al minuto.
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o-mini,gpt-4.1-mini,gpt-4o,gpt-4.1,o4-mini,phi-4';
    fetchCalls = [];
    realFetch = globalThis.fetch;
    // Solo `Date`: i timer veri restano veri, cosi' il backoff e gli abort
    // interni non vengono congelati da un orologio che non avanza da solo.
    mock.timers.enable({ apis: ['Date'] });
    resetState();
  });

  afterEach(() => {
    mock.timers.reset();
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
    resetState();
  });

  it('un host irraggiungibile non viene ri-diallato a ogni scadenza dei 60s', async () => {
    globalThis.fetch = async (url) => {
      fetchCalls.push(String(url));
      throw undiciFetchFailed('ENOTFOUND');
    };

    await assert.rejects(() => callLLM([{ role: 'user', content: 'x' }], OPTS));
    assert.equal(ghCalls().length, 1, `un solo connect atteso dalla prima chiamata, visti ${ghCalls().length}`);

    // Cinque minuti di run, cioe' cinque scadenze della finestra da 60s, con
    // una chiamata dopo ciascuna — la forma di un generatore che macina.
    for (let minuto = 1; minuto <= 5; minuto++) {
      mock.timers.tick(61_000);
      await assert.rejects(() => callLLM([{ role: 'user', content: 'x' }], OPTS));
    }

    assert.equal(
      ghCalls().length, 1,
      `l'host morto va composto UNA volta per run, non a ogni scadenza: visti ${ghCalls().length} connect`,
    );
    assert.equal(
      getStats().activeCooldowns.github, Infinity,
      `il cooldown persistente non deve avere scadenza: ${JSON.stringify(getStats().activeCooldowns)}`,
    );
  });

  // Il flap del resolver arriva allo STESSO ramo dell'host morto — #770 gli
  // scrive `e.hostUnreachable = 'EAI_AGAIN'` quando smette di sembrare un
  // hiccup — ma non e' la stessa cosa: `EAI_AGAIN` e' il resolver che dice
  // «riprova», non un verdetto sull'host. Con il ban di run tre hiccup DNS su
  // un runner CI spegnerebbero il provider per ore, e su `github` l'intera
  // catena tier-0 con lui, in silenzio: `_resolverFlaps` si azzera solo su un
  // successo, che non puo' arrivare da un provider che non viene piu' composto.
  it('un flap escalato (#770) prende una finestra finita, non il ban di run', async () => {
    globalThis.fetch = async (url) => {
      fetchCalls.push(String(url));
      throw undiciFetchFailed('EAI_AGAIN');
    };

    await assert.rejects(() => callLLM([{ role: 'user', content: 'x' }], OPTS));
    const dopoEscalation = ghCalls().length;
    assert.equal(dopoEscalation, 3, `attesi 3 connect prima dell'escalation, visti ${dopoEscalation}`);
    // `activeCooldowns` e' il tempo che RESTA, in secondi.
    const rimasti = getStats().activeCooldowns.github;
    assert.ok(
      Number.isFinite(rimasti) && rimasti > 60,
      `la finestra del flap dev'essere finita e piu' lunga dei 60s del 429: ${JSON.stringify(getStats().activeCooldowns)}`,
    );

    // Dentro la finestra il provider resta fuori gioco — cio' che #770 compra.
    mock.timers.tick(61_000);
    await assert.rejects(() => callLLM([{ role: 'user', content: 'x' }], OPTS));
    assert.equal(
      ghCalls().length, dopoEscalation,
      `dentro la finestra del flap non si ricompone il numero: visti ${ghCalls().length} connect`,
    );

    // Scaduta, si riprova: e' l'unico modo in cui un resolver che si riallinea
    // a meta' run puo' essere scoperto.
    mock.timers.tick(5 * 60_000);
    await assert.rejects(() => callLLM([{ role: 'user', content: 'x' }], OPTS));
    assert.ok(
      ghCalls().length > dopoEscalation,
      `scaduta la finestra il resolver va ri-provato: visti ${ghCalls().length} connect, attesi piu' di ${dopoEscalation}`,
    );
  });

  it('un 429 continua a scadere dopo 60s — il ban lungo non si estende al transitorio', async () => {
    // `maxRetriesPerModel: 2` come il blocco della promozione (#787): il
    // cooldown da 429 vive nel ramo retryable di `_callOpenAICompatible`
    // (`attempt < opts.maxRetriesPerModel`), quindi con 1 — dove il primo
    // tentativo e' gia' l'ultimo — `cooldownProvider` non viene mai chiamata e
    // la prova guarderebbe una finestra che non e' mai stata aperta.
    const OPTS_429 = { ...OPTS, maxRetriesPerModel: 2 };
    globalThis.fetch = async (url) => {
      if (!String(url).includes('models.inference.ai.azure.com')) throw undiciFetchFailed('ENOTFOUND');
      fetchCalls.push(String(url));
      return new Response('rate limit exceeded', { status: 429 });
    };

    await assert.rejects(() => callLLM([{ role: 'user', content: 'x' }], OPTS_429));
    const primoGiro = ghCalls().length;
    assert.ok(primoGiro >= 1, 'il primo giro deve aver chiamato l\'host');
    const rimasti = getStats().activeCooldowns.github;
    assert.ok(
      Number.isFinite(rimasti) && rimasti > 0,
      `un 429 non e' un guasto persistente: la sua finestra dev'essere aperta e finita, vista ${JSON.stringify(getStats().activeCooldowns)}`,
    );

    mock.timers.tick(61_000);
    await assert.rejects(() => callLLM([{ role: 'user', content: 'x' }], OPTS_429));

    assert.ok(
      ghCalls().length > primoGiro,
      `scaduti i 60s il provider torna eleggibile: attesi piu' di ${primoGiro} connect, visti ${ghCalls().length}`,
    );
  });

  /**
   * Il terzo lato del confine (#809). L'ordine di gravita' vieta di RETROCEDERE
   * la causa, ma la finestra veniva riportata avanti prima di quel gate: un 429
   * atterrato su un cooldown da flap quasi scaduto ne spostava la scadenza di
   * altri 60s lasciandoci sopra la causa piu' grave. Con una catena a ~12 id
   * GitHub i 429 arrivano a raffica, quindi la finestra finita che #803 ha dato
   * al flap tornava a essere il ban di run che #803 gli aveva negato — e per
   * tutto quel tempo la riga di skip continuava a votare `non-retryable`, su un
   * resolver che aveva solo detto «riprova».
   */
  it('un 429 tardivo non prolunga la finestra del flap escalato (#809)', async () => {
    // Come nel blocco #787, la prova si compra le due cose che altrimenti
    // sarebbero speranze (#830): la catena e' pinnata prima di OGNI chiamata
    // (`opts.chain` da solo passa per `sortChainByScore` / `applyModelsPrefer`
    // e viene riordinato), e il 429 e' ancorato al tempo MOCKATO — entra prima
    // che la finestra del flap si apra, e viene servito solo dopo il tick, con
    // `at429` a dimostrarlo. Senza, un 429 mai atterrato lascerebbe l'ultima
    // assertion verde anche sul codice pre-fix.
    const OPTS_429 = { ...OPTS, maxRetriesPerModel: 2 };
    let served429 = 0;
    let at429 = null;
    let release429;
    let enter429;
    const late429 = new Promise((resolve) => { release429 = resolve; });
    const inFlight429 = new Promise((resolve) => { enter429 = resolve; });
    globalThis.fetch = async (url, init) => {
      if (!String(url).includes('models.inference.ai.azure.com')) throw undiciFetchFailed('EAI_AGAIN');
      fetchCalls.push(String(url));
      // Solo `phi-4` porta il 429, e resta appeso al gate finche' la finestra
      // del flap non e' quasi scaduta: e' la forma reale — le chiamate corrono
      // in parallelo, e un 429 partito prima puo' atterrare molto dopo.
      if (String(init?.body || '').includes('phi-4')) {
        enter429();
        await late429;
        served429 += 1;
        at429 = Date.now();
        return new Response('rate limit exceeded', { status: 429 });
      }
      throw undiciFetchFailed('EAI_AGAIN');
    };

    process.env.AI_MODELS_FORCE_CHAIN = 'phi-4';
    const rateLimited = callLLM([{ role: 'user', content: 'x' }], OPTS_429)
      .then(() => null, (e) => e);
    // Il 429 e' in volo PRIMA che la finestra si apra: e' l'unico ordine in cui
    // il pre-flight non lo cancella, e non dipende da chi vince una corsa.
    await inFlight429;
    const apertura = Date.now();

    // Tre flap di fila sullo stesso provider: la finestra da 5 minuti si apre.
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o-mini,gpt-4.1-mini,gpt-4o';
    await assert.rejects(() => callLLM([{ role: 'user', content: 'x' }], OPTS));
    const finestraFlap = getStats().activeCooldowns.github;
    assert.ok(
      Number.isFinite(finestraFlap) && finestraFlap > 60,
      `attesa la finestra finita del flap: ${JSON.stringify(getStats().activeCooldowns)}`,
    );

    // Il 429 atterra a finestra quasi finita: i suoi 60s cadrebbero OLTRE.
    mock.timers.tick(250_000);
    release429();
    assert.ok(await rateLimited, 'anche la chiamata rate-limited deve fallire');
    assert.ok(served429 >= 1, 'il 429 tardivo non e\' mai atterrato: la prova sarebbe vacua');
    assert.ok(
      at429 !== null && at429 - apertura >= 250_000,
      `il 429 deve atterrare DOPO il tick, sul tempo mockato: ${at429 - apertura}ms dall'apertura`,
    );

    const primaDellaScadenza = ghCalls().length;
    mock.timers.tick(51_000); // 301s dall'apertura: la finestra del flap e' scaduta
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4.1';
    await assert.rejects(() => callLLM([{ role: 'user', content: 'x' }], OPTS));

    assert.ok(
      ghCalls().length > primaDellaScadenza,
      `un 429 non deve prolungare la finestra di una causa piu' grave: attesi piu' di ${primaDellaScadenza} connect, visti ${ghCalls().length}`,
    );
  });
});


/**
 * ── #813: LOOPBACK IN TUTTE LE FORME, E LA MACCHINA E' PIU' GRANDE DEL LOOPBACK ─
 *
 * `_isLoopbackUrl` leggeva quattro forme (`localhost`, `::1`, `0.0.0.0`,
 * `127.*`) e ne mancavano altrettante che arrivano davvero: `[::]`, la forma
 * IPv4-mapped `::ffff:127.0.0.1`, e i nomi sotto `.localhost` che RFC 6761
 * riserva al loopback. Ma il buco piu' costoso non e' una forma: `PROVIDER.LOCAL`
 * e' documentato come «il runner CI o una VM self-hosted», e su una VM il
 * server locale si indirizza di routine con l'IP di interfaccia o
 * `host.docker.internal` — che loopback non sono. Li' ECONNREFUSED continua a
 * significare «il server non gira», cioe' la finestra per cui `local/` esiste,
 * e il ban lo rendeva irreversibile per la run: zero articoli invece che una
 * run degradata.
 */
describe('#813 — esenzione: le forme del loopback e la stessa macchina', () => {
  const ENV_KEYS = [
    'AI_MODELS_FORCE_CHAIN', 'AI_MODELS_PREFER', 'GH_MODELS_PAT',
    'LOCAL_LLM_ENABLED', 'LOCAL_LLM_URL',
  ];
  let envBackup = {};
  let realFetch;

  beforeEach(() => {
    envBackup = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.GH_MODELS_PAT = 'test-pat';
    process.env.LOCAL_LLM_ENABLED = '1';
    process.env.AI_MODELS_FORCE_CHAIN = 'local/fallback';
    realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw undiciFetchFailed('ECONNREFUSED'); };
    resetState();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
    resetState();
  });

  // Ogni voce e' una forma che `new URL()` produce davvero e che la guardia
  // precedente leggeva come «host remoto».
  for (const url of [
    'http://[::ffff:127.0.0.1]:8080/v1/chat/completions',
    'http://[::]:8080/v1/chat/completions',
    'http://[::1]:8080/v1/chat/completions',
    'http://llm.localhost:8080/v1/chat/completions',
    'http://127.0.0.53:8080/v1/chat/completions',
  ]) {
    it(`${url} e' loopback e resta esente`, async () => {
      process.env.LOCAL_LLM_URL = url;
      await assert.rejects(
        () => callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 }),
      );
      const stats = getStats();
      assert.ok(!stats.exhaustedModels.includes('local/fallback'), `nessun ban atteso su ${url}, visti: ${stats.exhaustedModels.join(', ')}`);
      assert.equal(stats.activeCooldowns.local, undefined, `nessun cooldown atteso su ${url}: ${JSON.stringify(stats.activeCooldowns)}`);
    });
  }

  it('un indirizzo di interfaccia di QUESTA macchina non e\' un host remoto morto', async () => {
    // Il caso della VM self-hosted, preso dalle interfacce reali del processo
    // invece che da un letterale: e' l'unica forma che non si puo' inventare.
    const own = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && !i.internal && i.family === 'IPv4');
    if (!own) return; // runner senza interfacce esterne: niente da misurare

    process.env.LOCAL_LLM_URL = `http://${own.address}:8080/v1/chat/completions`;
    await assert.rejects(
      () => callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 }),
    );
    const stats = getStats();
    assert.ok(!stats.exhaustedModels.includes('local/fallback'), `nessun ban atteso sul proprio IP, visti: ${stats.exhaustedModels.join(', ')}`);
    assert.equal(stats.activeCooldowns.local, undefined, `nessun cooldown atteso sul proprio IP: ${JSON.stringify(stats.activeCooldowns)}`);
  });

  it('host.docker.internal e\' la stessa macchina, vista da un container', async () => {
    process.env.LOCAL_LLM_URL = 'http://host.docker.internal:8080/v1/chat/completions';
    await assert.rejects(
      () => callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 }),
    );
    assert.ok(!getStats().exhaustedModels.includes('local/fallback'), 'nessun ban atteso su host.docker.internal');
  });

  // Il contrappunto che tiene onesta la regola: un host davvero remoto continua
  // ad armare il breaker, che e' cio' che #793 ha comprato.
  it('un gateway remoto arma ancora il breaker', async () => {
    process.env.LOCAL_LLM_URL = 'https://gateway.example.invalid/v1/chat/completions';
    await assert.rejects(
      () => callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 }),
    );
    const stats = getStats();
    assert.ok(stats.exhaustedModels.includes('local/fallback'), `atteso il ban su host remoto, visti: ${stats.exhaustedModels.join(', ')}`);
    assert.ok(stats.activeCooldowns.local > 0, `atteso il cooldown su host remoto: ${JSON.stringify(stats.activeCooldowns)}`);
  });
});

/**
 * ── #813: SI GIUDICA IL SOCKET APERTO, NON LA STRINGA CONFIGURATA ──────────
 *
 * `_callLocal` passa un `dispatcher`, e una `fetch` puo' passare per un proxy
 * d'ambiente: il connect rifiutato che torna indietro puo' venire dal proxy
 * locale, non dall'host. L'URL configurato dice «gateway remoto», il peer
 * effettivamente contattato dice `127.0.0.1:3128` — e il ban scriveva «host
 * morto» nel ledger CONDIVISO su un endpoint che nessuno ha mai chiamato.
 */
describe('#813 — il peer rifiutato decide, non l\'URL', () => {
  const ENV_KEYS = [
    'AI_MODELS_FORCE_CHAIN', 'AI_MODELS_PREFER', 'GH_MODELS_PAT',
    'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy',
    'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY', 'NODE_OPTIONS',
    ...Array.from({ length: 8 }, (_, i) => `GH_MODELS_PAT_${i + 2}`),
  ];
  let envBackup = {};
  let realFetch;

  // Un ECONNREFUSED che porta l'indirizzo del peer, come lo produce undici.
  const refusedFrom = (address, port) => Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error(`connect ECONNREFUSED ${address}:${port}`), {
      code: 'ECONNREFUSED', address, port, syscall: 'connect',
    }),
  });

  beforeEach(() => {
    envBackup = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.GH_MODELS_PAT = 'test-pat';
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o-mini';
    realFetch = globalThis.fetch;
    resetState();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
    resetState();
  });

  it('un connect rifiutato DA QUESTA MACCHINA non giudica l\'host remoto', async () => {
    globalThis.fetch = async () => { throw refusedFrom('127.0.0.1', 3128); };

    await assert.rejects(
      () => callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 }),
    );

    const stats = getStats();
    assert.ok(!stats.exhaustedModels.includes('gpt-4o-mini'), `il proxy locale spento non deve bannare il modello, visti: ${stats.exhaustedModels.join(', ')}`);
    assert.equal(stats.activeCooldowns.github, undefined, `nessun cooldown atteso: ${JSON.stringify(stats.activeCooldowns)}`);
  });

  it('un connect rifiutato dall\'host remoto arma il breaker come prima', async () => {
    globalThis.fetch = async () => { throw refusedFrom('20.20.20.20', 443); };

    await assert.rejects(
      () => callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 }),
    );

    const stats = getStats();
    assert.ok(stats.exhaustedModels.includes('gpt-4o-mini'), `atteso il ban sull'host remoto, visti: ${stats.exhaustedModels.join(', ')}`);
    assert.ok(stats.activeCooldowns.github > 0, `atteso il cooldown: ${JSON.stringify(stats.activeCooldowns)}`);
  });

  it('con un proxy d\'ambiente ONORATO dal runtime nessun connect parla dell\'host', async () => {
    // Qui l'errore NON porta indirizzi (il caso comune: il fallimento arriva
    // impacchettato dal dispatcher). L'unica cosa che si sa e' che il peer
    // contattato non era l'host di destinazione — e lo si sa solo perche' il
    // runtime legge davvero le variabili proxy.
    process.env.NODE_USE_ENV_PROXY = '1';
    process.env.HTTPS_PROXY = 'http://proxy.internal:3128';
    globalThis.fetch = async () => { throw undiciFetchFailed('ECONNREFUSED'); };

    await assert.rejects(
      () => callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 }),
    );

    const stats = getStats();
    assert.ok(!stats.exhaustedModels.includes('gpt-4o-mini'), `dietro un proxy nessun ban, visti: ${stats.exhaustedModels.join(', ')}`);
    assert.equal(stats.activeCooldowns.github, undefined, `nessun cooldown atteso dietro un proxy: ${JSON.stringify(stats.activeCooldowns)}`);
  });

  // La `fetch` globale di Node non legge le variabili proxy senza
  // `--use-env-proxy`/`NODE_USE_ENV_PROXY`, e questo modulo non installa
  // nessun `ProxyAgent`: un'immagine che esporta `HTTPS_PROXY` per git o apt
  // non deve spegnere il breaker di #475 su OGNI provider.
  it('HTTPS_PROXY senza NODE_USE_ENV_PROXY non esenta: la richiesta e\' diretta', async () => {
    process.env.HTTPS_PROXY = 'http://proxy.internal:3128';
    globalThis.fetch = async () => { throw undiciFetchFailed('ECONNREFUSED'); };

    await assert.rejects(
      () => callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 }),
    );

    const stats = getStats();
    assert.ok(stats.exhaustedModels.includes('gpt-4o-mini'), `senza proxy onorato il breaker resta armato, visti: ${stats.exhaustedModels.join(', ')}`);
    assert.ok(stats.activeCooldowns.github > 0, `atteso il cooldown: ${JSON.stringify(stats.activeCooldowns)}`);
  });

  // `HTTP_PROXY` non puo' intercettare un endpoint `https`: gli endpoint in
  // chiaro sono quelli di loopback, che rispondono gia' a valle.
  it('HTTP_PROXY da solo non esenta un endpoint https', async () => {
    process.env.NODE_USE_ENV_PROXY = '1';
    process.env.HTTP_PROXY = 'http://proxy.internal:3128';
    globalThis.fetch = async () => { throw undiciFetchFailed('ECONNREFUSED'); };

    await assert.rejects(
      () => callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 }),
    );

    assert.ok(getStats().exhaustedModels.includes('gpt-4o-mini'), 'HTTP_PROXY non intercetta https: il breaker resta armato');
  });

  it('NO_PROXY=* e\' una variabile impostata che non intercetta nulla', async () => {
    // Il confine: la sola PRESENZA della variabile non deve spegnere #475.
    process.env.NODE_USE_ENV_PROXY = '1';
    process.env.HTTPS_PROXY = 'http://proxy.internal:3128';
    process.env.NO_PROXY = '*';
    globalThis.fetch = async () => { throw undiciFetchFailed('ECONNREFUSED'); };

    await assert.rejects(
      () => callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 }),
    );

    assert.ok(getStats().exhaustedModels.includes('gpt-4o-mini'), 'senza proxy effettivo il breaker resta armato');
  });
});

/**
 * ── #813: IL FLAP DEL RESOLVER NON BANNA L'ULTIMA RISORSA ──────────────────
 *
 * L'escalation di #770 promuove tre `EAI_AGAIN` consecutivi sullo stesso
 * provider a verdetto sull'host. Con `LOCAL_LLM_URL`/`OMNIROUTE_URL` puntati a
 * un NOME DNS, un resolver che inciampa tre volte manda in ban + cooldown
 * proprio la riga finale della catena — quella che esiste per la finestra
 * «tutti gli altri esauriti» — su una prova che il codice stesso definisce
 * transitoria. Il contatore continua a salire: e' la conseguenza a non
 * applicarsi.
 */
describe('#813 — l\'escalation del flap salta i provider di ultima risorsa', () => {
  const ENV_KEYS = [
    'AI_MODELS_FORCE_CHAIN', 'AI_MODELS_PREFER', 'GH_MODELS_PAT',
    'OMNIROUTE_ENABLED', 'OMNIROUTE_URL',
  ];
  let envBackup = {};
  let realFetch;

  beforeEach(() => {
    envBackup = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.GH_MODELS_PAT = 'test-pat';
    process.env.OMNIROUTE_ENABLED = '1';
    process.env.OMNIROUTE_URL = 'https://gateway.example.invalid/v1/chat/completions';
    process.env.AI_MODELS_FORCE_CHAIN = 'omniroute/auto';
    realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw undiciFetchFailed('EAI_AGAIN'); };
    resetState();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
    resetState();
  });

  it('tre flap di fila non bannano omniroute e non lo congelano', async () => {
    for (let i = 0; i < 3; i++) {
      await assert.rejects(
        () => callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 }),
      );
    }

    const stats = getStats();
    assert.equal(stats.resolverFlaps.omniroute, 3, `i flap vanno comunque contati: ${JSON.stringify(stats.resolverFlaps)}`);
    assert.ok(!stats.exhaustedModels.includes('omniroute/auto'), `nessun ban da flap sull'ultima risorsa, visti: ${stats.exhaustedModels.join(', ')}`);
    assert.equal(stats.activeCooldowns.omniroute, undefined, `nessun cooldown da flap sull'ultima risorsa: ${JSON.stringify(stats.activeCooldowns)}`);
  });

  it('su un provider normale l\'escalation resta quella di #770', async () => {
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o-mini,gpt-4.1-mini,gpt-4o';

    await assert.rejects(
      () => callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 }),
    );

    const stats = getStats();
    assert.ok(stats.activeCooldowns.github > 0, `atteso il cooldown dopo l'escalation: ${JSON.stringify(stats.activeCooldowns)}`);
  });
});


/**
 * ── #818: IL CONTATORE DEVE MISURARE «TRE DI FILA, ADESSO» ─────────────────
 *
 * Follow-up di #770. Il confine fra flap e host morto era giusto; il contatore
 * che lo attraversa no, in tre modi che si sommano:
 *
 *   1. era azzerato SOLO da un successo, quindi tre flap sparsi su tutta la run
 *      con 429 e timeout in mezzo escalavano come tre consecutivi;
 *   2. non era azzerato dopo l'escalation, quindi scaduto il cooldown il PRIMO
 *      flap successivo bannava di nuovo all'istante;
 *   3. la riga che il flap lascia in `errors` e' `fetch failed`, che non matcha
 *      ne' `transientRe` ne' `persistentRe`: una catena svuotata interamente da
 *      flap sotto soglia dava `transient: 0` → `transientExhaustion: false` →
 *      nessun differimento e un Bug «Workflow Failure» aperto per un guasto che
 *      questo modulo definisce transitorio per costruzione;
 *   4. il ramo timeout scavalcava l'escalation: bastava la parola «aborted» nel
 *      messaggio del flap perche' `e.hostUnreachable` posato dall'escalation
 *      venisse ignorato — ne' ban ne' cooldown, e il contatore che sale per
 *      niente.
 */
describe('callLLM — il contatore dei flap del resolver (#818)', () => {
  const ENV_KEYS = ['AI_MODELS_FORCE_CHAIN', 'GH_MODELS_PAT', 'AI_MODELS_PREFER'];
  let envBackup = {};
  let realFetch;

  beforeEach(() => {
    envBackup = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.GH_MODELS_PAT = 'test-pat';
    realFetch = globalThis.fetch;
    resetState();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
    resetState();
  });

  const OPTS = { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 };
  const run = () => callLLM([{ role: 'user', content: 'x' }], OPTS).then(() => null, (e) => e);

  it('un fallimento di ALTRA classe chiude la striscia, come un successo', async () => {
    // Flap, guasto qualunque, flap, flap: due flap consecutivi alla fine, non
    // tre. Prima di #818 il contatore arrivava a 3 e bannava.
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o-mini,gpt-4.1-mini,gpt-4o,gpt-4.1';
    const script = ['EAI_AGAIN', 'other', 'EAI_AGAIN', 'EAI_AGAIN'];
    let i = 0;
    globalThis.fetch = async () => {
      const step = script[Math.min(i++, script.length - 1)];
      if (step === 'other') throw new Error('HTTP 503: upstream hiccup');
      throw undiciFetchFailed('EAI_AGAIN');
    };

    const err = await run();
    assert.ok(err, 'la catena deve fallire');
    const stats = getStats();
    assert.equal(stats.resolverFlaps.github, 2, `attesi 2 flap consecutivi: ${JSON.stringify(stats.resolverFlaps)}`);
    assert.equal(stats.activeCooldowns.github, undefined, 'sotto soglia il provider resta disponibile');
    assert.equal(stats.exhaustedModels.length, 0, `nessun ban atteso, visti: ${stats.exhaustedModels.join(', ')}`);
  });

  it('l\'escalation azzera il contatore che ha appena speso', async () => {
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o-mini,gpt-4.1-mini,gpt-4o';
    globalThis.fetch = async () => { throw undiciFetchFailed('EAI_AGAIN'); };

    const err = await run();
    assert.ok(err, 'la catena deve fallire');
    const stats = getStats();
    assert.ok(stats.activeCooldowns.github > 0, `atteso il cooldown dell'escalation: ${JSON.stringify(stats.activeCooldowns)}`);
    // Il conto riparte da zero: scaduto il cooldown servono di nuovo TRE flap,
    // non uno. Lasciarlo a `>= soglia` faceva del secondo ban un colpo istantaneo.
    assert.equal(stats.resolverFlaps.github, undefined, `contatore atteso azzerato: ${JSON.stringify(stats.resolverFlaps)}`);
  });

  it('una catena svuotata da flap sotto soglia vota TRANSITORIO', async () => {
    // La riga grezza e' `fetch failed`, che non vota: senza qualificazione
    // `transientExhaustion` restava falso e il chiamante apriva un Bug.
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o-mini,gpt-4.1-mini';
    globalThis.fetch = async () => { throw undiciFetchFailed('EAI_AGAIN'); };

    const err = await run();
    assert.ok(err, 'la catena deve fallire');
    assert.equal(err.exhaustionBreakdown.transient, 2, `attesi 2 voti transitori: ${err.message}`);
    assert.equal(err.exhaustionBreakdown.persistent, 0, `nessun voto persistente atteso: ${err.message}`);
    assert.equal(err.transientExhaustion, true, 'un flap sotto soglia e\' transitorio per costruzione');
    assert.equal(isQuotaExhaustedError(err), true, 'il chiamante deve differire, non aprire un Bug');
  });

  it('un flap ESCALATO vota persistente, come la riga di skip dei fratelli', async () => {
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o-mini,gpt-4.1-mini,gpt-4o';
    globalThis.fetch = async () => { throw undiciFetchFailed('EAI_AGAIN'); };

    const err = await run();
    assert.ok(err, 'la catena deve fallire');
    assert.match(err.message, /unreachable \(EAI_AGAIN\), non-retryable/);
    assert.ok(err.exhaustionBreakdown.persistent >= 1, `atteso almeno un voto persistente: ${JSON.stringify(err.exhaustionBreakdown)}`);
  });

  it('la parola «aborted» nel messaggio non scavalca l\'escalation', async () => {
    // Un abort scattato mentre il resolver ritenta dentro la stessa call: il
    // codice syscall dice `EAI_AGAIN`, il testo dice «aborted». Il tag posato
    // dall'escalation vince — altrimenti il contatore sale senza mai produrre
    // ne' ban ne' cooldown, cioe' l'effetto per cui esiste.
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o-mini,gpt-4.1-mini,gpt-4o';
    globalThis.fetch = async () => {
      throw Object.assign(new TypeError('fetch failed: the request was aborted'), {
        cause: Object.assign(new Error('EAI_AGAIN api.example:443'), { code: 'EAI_AGAIN' }),
      });
    };

    const err = await run();
    assert.ok(err, 'la catena deve fallire');
    const stats = getStats();
    assert.ok(stats.activeCooldowns.github > 0, `atteso il cooldown dopo l'escalation: ${JSON.stringify(stats.activeCooldowns)}`);
    assert.ok(stats.exhaustedModels.includes('gpt-4o'), `atteso il modello dell'escalation esaurito, visti: ${stats.exhaustedModels.join(', ')}`);
  });
});

/**
 * ── #838: IL BREAKER ARMA, MA IL VERDETTO NON E' CONDIVISIBILE ─────────────
 *
 * Follow-up di #813. Con `LOCAL_LLM_URL`/`OMNIROUTE_URL` puntati a un gateway
 * remoto morto, #781 ha ragione a far armare il breaker: quel connect e' una
 * prova. Ma l'id sotto cui la prova viene scritta (`local/fallback`,
 * `omniroute/auto`) sta in un documento CONDIVISO da tutte le macchine, mentre
 * l'host che descrive e' configurazione di QUESTA. Un runner mal configurato
 * affondava cosi' l'ultima riga della catena per tutti gli altri.
 *
 * Il taglio e' fra le due meta' del breaker, non fra i provider:
 *
 *   - in processo NON cambia niente: marchio di esaurimento e cooldown del
 *     provider restano, cioe' resta la meta' che evita un connect morto per
 *     ogni id fratello;
 *   - verso il ledger non parte niente: nessuna penale di punteggio, che e'
 *     l'unica meta' che ci finisce davvero (`exhaustedUntil` non viene scritto
 *     per un ban `nonretryable`, vedi _persistScoresToFirestore).
 *
 * Il fallimento resta CONTATO — un modello che fallisce senza comparire fra i
 * falliti rende invisibile il prossimo incidente.
 */
describe('#838 — endpoint per-macchina: ban di run si, ledger condiviso no', () => {
  const ENV_KEYS = [
    'AI_MODELS_FORCE_CHAIN', 'AI_MODELS_PREFER', 'GH_MODELS_PAT',
    'OMNIROUTE_ENABLED', 'OMNIROUTE_URL',
    'LOCAL_LLM_ENABLED', 'LOCAL_LLM_URL',
  ];
  let envBackup = {};
  let realFetch;

  beforeEach(() => {
    envBackup = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw undiciFetchFailed('ECONNREFUSED'); };
    resetState();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
    resetState();
  });

  const scoreOf = (stats, model) => stats.scoreBoard.find((e) => e.model === model)?.score ?? 0;
  const failuresOf = (stats, model) => stats.runOutcomes.find((e) => e.model === model)?.failures ?? 0;

  for (const [label, env, urlKey, model, provider] of [
    ['omniroute', { OMNIROUTE_ENABLED: '1' }, 'OMNIROUTE_URL', 'omniroute/auto', 'omniroute'],
    ['local',     { LOCAL_LLM_ENABLED: '1' }, 'LOCAL_LLM_URL', 'local/fallback', 'local'],
  ]) {
    it(`${label} verso un gateway remoto morto: esaurito e in cooldown, ma score invariato`, async () => {
      Object.assign(process.env, env);
      process.env.AI_MODELS_FORCE_CHAIN = model;
      process.env[urlKey] = 'https://gateway.example.invalid/v1/chat/completions';

      await assert.rejects(
        () => callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 }),
      );

      const stats = getStats();
      // La meta' in processo resta intera (e' cio' che #781 ha guadagnato).
      assert.ok(stats.exhaustedModels.includes(model), `il ban di run resta, visti: ${stats.exhaustedModels.join(', ')}`);
      assert.ok(stats.activeCooldowns[provider] > 0, `il cooldown resta: ${JSON.stringify(stats.activeCooldowns)}`);
      // La meta' condivisa no.
      assert.equal(scoreOf(stats, model), 0, `nessuna penale nel ledger condiviso per un endpoint per-macchina: ${JSON.stringify(stats.scoreBoard)}`);
      assert.equal(failuresOf(stats, model), 1, `il fallimento va comunque contato: ${JSON.stringify(stats.runOutcomes)}`);
    });
  }

  // Il contrappunto che tiene onesta la regola: su un provider il cui endpoint
  // e' una costante del modulo, un host morto E' un fatto condivisibile e la
  // penale continua a essere scritta esattamente come prima.
  it('su un provider a endpoint fisso la penale resta', async () => {
    process.env.GH_MODELS_PAT = 'test-pat';
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o-mini';

    await assert.rejects(
      () => callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 }),
    );

    const stats = getStats();
    assert.ok(stats.exhaustedModels.includes('gpt-4o-mini'), `atteso il ban, visti: ${stats.exhaustedModels.join(', ')}`);
    assert.ok(scoreOf(stats, 'gpt-4o-mini') < 0, `atteso il punteggio penalizzato: ${JSON.stringify(stats.scoreBoard)}`);
  });
});

/**
 * ── CHI CHIUDE LA STRISCIA, E CON CHE PROVA (#848 item 3) ───────────────────
 *
 * `_resolverFlaps` si azzera su QUALUNQUE fallimento di altra classe (#818).
 * La lettura alternativa — chiuderla solo sulle classi che PROVANO che il
 * resolver funziona — non si sceglie a occhio: su `github`, dodici fratelli e
 * una notte di quota, i 429 alternati ai flap possono impedire per sempre
 * all'escalation di scattare, ma restringere il reset comprerebbe quel caso
 * pagando dei falsi ban. Serve il numero, da run reali.
 *
 * Questo blocco blocca il METRO, non la decisione: il comportamento resta
 * quello di #818 (la striscia si chiude comunque), e in piu' ogni reset che
 * butta via una striscia VIVA viene classificato e contato in
 * `getStats().resolverFlapResets`. `silent` e' la classe che non prova niente
 * sul resolver, ed e' il numero che deciderà l'item.
 */
describe('classifyResolverResetEvidence — la prova che il fallimento porta sul resolver (#848)', () => {
  it('una risposta HTTP ricevuta prova che il nome e\' stato risolto', () => {
    assert.equal(classifyResolverResetEvidence(new Error('[gpt-4o] HTTP 503: upstream hiccup')), 'resolved');
    assert.equal(classifyResolverResetEvidence(new Error('[gpt-4o] HTTP 429: rate limited')), 'resolved');
  });

  it('un codice post-risoluzione prova la risoluzione, anche sotto l\'incapsulamento di undici', () => {
    assert.equal(classifyResolverResetEvidence(undiciFetchFailed('ECONNREFUSED')), 'resolved');
    assert.equal(classifyResolverResetEvidence(undiciFetchFailed('ECONNRESET')), 'resolved');
    assert.equal(classifyResolverResetEvidence(undiciAggregate('ECONNREFUSED')), 'resolved');
    // Risposta AUTORITATIVA del resolver: il nome non esiste, ma il resolver
    // ha risposto — che e' esattamente la domanda che questa funzione fa.
    assert.equal(classifyResolverResetEvidence(undiciFetchFailed('ENOTFOUND')), 'resolved');
  });

  it('un abort o un timeout senza risposta non prova niente', () => {
    assert.equal(classifyResolverResetEvidence(Object.assign(new Error('aborted'), { name: 'AbortError' })), 'silent');
    // `code: 23` e' il codice DOMException — un NUMERO, non un codice syscall
    // (la misura di #848 item 2, scritta accanto al ramo in ai-models.mjs).
    assert.equal(classifyResolverResetEvidence(Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError', code: 23 })), 'silent');
    // Il binario che manca non e' un fatto sulla rete.
    assert.equal(classifyResolverResetEvidence(Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })), 'silent');
    assert.equal(classifyResolverResetEvidence(new Error('Empty response from model')), 'silent');
  });
});

describe('callLLM — il reset della striscia si conta per classe (#848 item 3)', () => {
  const ENV_KEYS = ['AI_MODELS_FORCE_CHAIN', 'GH_MODELS_PAT', 'AI_MODELS_PREFER'];
  let envBackup = {};
  let realFetch;

  beforeEach(() => {
    envBackup = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.GH_MODELS_PAT = 'test-pat';
    realFetch = globalThis.fetch;
    resetState();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
    resetState();
  });

  const OPTS = { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 };
  const run = () => callLLM([{ role: 'user', content: 'x' }], OPTS).then(() => null, (e) => e);

  it('un 503 che chiude una striscia viva e\' contato come `resolved`', async () => {
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o-mini,gpt-4.1-mini,gpt-4o,gpt-4.1';
    const script = ['EAI_AGAIN', 'other', 'EAI_AGAIN', 'EAI_AGAIN'];
    let i = 0;
    globalThis.fetch = async () => {
      const step = script[Math.min(i++, script.length - 1)];
      if (step === 'other') throw new Error('HTTP 503: upstream hiccup');
      throw undiciFetchFailed('EAI_AGAIN');
    };

    assert.ok(await run(), 'la catena deve fallire');
    const row = getStats().resolverFlapResets.github;
    assert.ok(row, `atteso un reset contato: ${JSON.stringify(getStats().resolverFlapResets)}`);
    assert.equal(row.resolved, 1, `atteso un reset con prova: ${JSON.stringify(row)}`);
    assert.equal(row.silent, 0, `nessun reset cieco atteso: ${JSON.stringify(row)}`);
    assert.equal(row.streaksDiscarded, 1, `una sola striscia buttata via: ${JSON.stringify(row)}`);
  });

  it('un abort senza risposta che chiude una striscia viva e\' contato come `silent`', async () => {
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o-mini,gpt-4.1-mini,gpt-4o,gpt-4.1';
    const script = ['EAI_AGAIN', 'abort', 'EAI_AGAIN', 'EAI_AGAIN'];
    let i = 0;
    globalThis.fetch = async () => {
      const step = script[Math.min(i++, script.length - 1)];
      if (step === 'abort') throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      throw undiciFetchFailed('EAI_AGAIN');
    };

    assert.ok(await run(), 'la catena deve fallire');
    const row = getStats().resolverFlapResets.github;
    assert.ok(row, `atteso un reset contato: ${JSON.stringify(getStats().resolverFlapResets)}`);
    assert.equal(row.silent, 1, `atteso il reset cieco: ${JSON.stringify(row)}`);
    assert.equal(row.resolved, 0, `nessun reset con prova atteso: ${JSON.stringify(row)}`);
    // Il COMPORTAMENTO non cambia: la striscia si chiude comunque, e alla fine
    // restano due flap consecutivi, non tre. La misura non decide l'item.
    assert.equal(getStats().resolverFlaps.github, 2, `attesi 2 flap consecutivi: ${JSON.stringify(getStats().resolverFlaps)}`);
  });

  it('un reset a contatore gia\' vuoto non e\' un evento e non si conta', async () => {
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o-mini,gpt-4.1-mini';
    globalThis.fetch = async () => { throw new Error('HTTP 503: upstream hiccup'); };

    assert.ok(await run(), 'la catena deve fallire');
    assert.deepEqual(getStats().resolverFlapResets, {}, 'nessuna striscia viva, nessun conteggio');
  });

  it('un successo che chiude una striscia viva e\' contato come `success`', async () => {
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o-mini,gpt-4.1-mini';
    let first = true;
    globalThis.fetch = async () => {
      if (first) { first = false; throw undiciFetchFailed('EAI_AGAIN'); }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: 'ciao' } }] }),
      };
    };

    const out = await callLLM([{ role: 'user', content: 'x' }], OPTS);
    assert.ok(out, 'la seconda riga deve servire');
    const row = getStats().resolverFlapResets.github;
    assert.ok(row, `atteso un reset contato: ${JSON.stringify(getStats().resolverFlapResets)}`);
    assert.equal(row.success, 1, `atteso il reset da successo: ${JSON.stringify(row)}`);
  });

  // Il conteggio serve a decidere l'item solo se esce dal processo: senza una
  // riga nel riepilogo di fine run, harvestarlo vuol dire scaricare il log
  // intero di ogni run e cercare le `console.warn` per evento — e uno zero
  // raccolto cosi' non si distingue da un log troncato.
  const summaryOf = () => {
    const out = [];
    const orig = console.log;
    console.log = (...a) => out.push(a.map(String).join(' '));
    try { printRunSummary(); } finally { console.log = orig; }
    return out.join('\n');
  };
  const flapLineOf = (text) => text.split('\n').find((l) => l.includes('resolver flaps:'));

  it('il riepilogo di fine run porta il conteggio per classe', async () => {
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o-mini,gpt-4.1-mini,gpt-4o,gpt-4.1';
    const script = ['EAI_AGAIN', 'abort', 'EAI_AGAIN', 'EAI_AGAIN'];
    let i = 0;
    globalThis.fetch = async () => {
      const step = script[Math.min(i++, script.length - 1)];
      if (step === 'abort') throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      throw undiciFetchFailed('EAI_AGAIN');
    };

    assert.ok(await run(), 'la catena deve fallire');
    const line = flapLineOf(summaryOf());
    assert.ok(line, 'il riepilogo deve portare la riga dei flap');
    assert.match(line, /resets github silent=1 resolved=0 success=0 \(1 discarded\)/, line);
    // La striscia ancora viva a fine run e' l'altra meta' del fatto: dice
    // quanto mancava alla soglia quando il reset l'ha buttata via.
    assert.match(line, /open \[github=2\/3\]/, line);
  });

  it('una run senza reset stampa comunque la riga — e\' il denominatore', () => {
    const line = flapLineOf(summaryOf());
    assert.equal(line, '   resolver flaps: none this run', `riga vista: ${line}`);
  });

  // La riga corretta non serve a niente se la stampa solo il ramo che pubblica
  // un articolo: le run in cui una striscia di flap ha svuotato la catena
  // finiscono `deferred`/`error`, escono da `exitAfterFlush()` e sarebbero
  // proprio quelle assenti dal campione. Il denominatore vive nel WIRING, e
  // `create-article.mjs` non e' importabile qui (la sua closure tira dentro
  // sharp/undici/…, e in CI non c'e' `node_modules`): si pinna sul sorgente,
  // come fa gia' pre-spend-gate-telemetry.test.mjs per `PRESPEND_GATE_OUTCOME`.
  it('il riepilogo esce da `finalizeRunReport()`, cioe\' da ogni percorso terminale', () => {
    const src = readFileSync(
      new URL('../scripts/create-article.mjs', import.meta.url),
      'utf-8',
    );
    const start = src.indexOf('function finalizeRunReport(status, extra = {}) {');
    assert.notEqual(start, -1, 'delimitatore di finalizeRunReport da aggiornare');
    const endRel = src.slice(start).search(/\n\}\n/);
    assert.notEqual(endRel, -1, 'chiusura di finalizeRunReport non trovata');
    const finalize = src.slice(start, start + endRel + 2);

    assert.match(finalize, /\bprintRunSummary\(\)/, 'il riepilogo deve essere emesso da finalizeRunReport');
    // Un secondo call site rimetterebbe la riga sul solo ramo felice — e la
    // conterebbe due volte li', che e' l'altra meta' del denominatore rotto.
    const callSites = src.match(/^\s*printRunSummary\(\);/gm) || [];
    assert.equal(
      callSites.length,
      1,
      `atteso un solo call site di printRunSummary() in create-article.mjs, visti ${callSites.length}`,
    );
  });

  it('`resetState()` azzera anche il conteggio dei reset', async () => {
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o-mini,gpt-4.1-mini,gpt-4o,gpt-4.1';
    const script = ['EAI_AGAIN', 'other'];
    let i = 0;
    globalThis.fetch = async () => {
      if (script[Math.min(i++, script.length - 1)] === 'other') throw new Error('HTTP 503: upstream hiccup');
      throw undiciFetchFailed('EAI_AGAIN');
    };

    await run();
    assert.ok(getStats().resolverFlapResets.github, 'precondizione: un reset contato');
    resetState();
    assert.deepEqual(getStats().resolverFlapResets, {}, 'il conteggio muore con lo stato di run');
  });
});
