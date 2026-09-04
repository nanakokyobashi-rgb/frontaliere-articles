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

import {
  classifyHostUnreachable,
  classifyTransientResolver,
  callLLM,
  getStats,
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
    globalThis.fetch = async () => new Response('rate limit exceeded', { status: 429 });

    await assert.rejects(
      () => callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 }),
    );

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
  it('un 429 atterrato dopo non retrocede la causa a transitoria', async () => {
    delete process.env.AI_MODELS_FORCE_CHAIN;
    let releaseLate429;
    const late429 = new Promise((resolve) => { releaseLate429 = resolve; });
    globalThis.fetch = async (url, init) => {
      if (!String(url).includes('models.inference.ai.azure.com')) throw undiciFetchFailed('ENOTFOUND');
      ghCalls += 1;
      if (String(init?.body || '').includes('gpt-4o-mini')) throw undiciFetchFailed('ENOTFOUND');
      await late429;
      return new Response('rate limit exceeded', { status: 429 });
    };

    const opts = { maxRetriesPerModel: 2, backoffMs: 1, timeout: 5000 };
    // Il 429 e' in volo per primo ma resta appeso al gate.
    const rateLimited = callLLM([{ role: 'user', content: 'x' }], { ...opts, chain: ['gpt-4.1-mini'] })
      .then(() => null, (e) => e);
    // L'host muore mentre l'altro aspetta: la causa persistente viene scritta.
    const unreachable = await callLLM([{ role: 'user', content: 'x' }], { ...opts, chain: ['gpt-4o-mini'] })
      .then(() => null, (e) => e);
    assert.ok(unreachable, 'la chiamata sull\'host morto deve fallire');
    releaseLate429();
    assert.ok(await rateLimited, 'anche la chiamata rate-limited deve fallire');

    // Un terzo fratello, dopo entrambe: la causa che legge deve essere ancora
    // quella persistente.
    const later = await callLLM([{ role: 'user', content: 'x' }], { ...opts, chain: ['gpt-4o'] })
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
    delete process.env.AI_MODELS_FORCE_CHAIN;
    const OPTS_429 = { ...OPTS, maxRetriesPerModel: 2 };
    let release429;
    const late429 = new Promise((resolve) => { release429 = resolve; });
    globalThis.fetch = async (url, init) => {
      if (!String(url).includes('models.inference.ai.azure.com')) throw undiciFetchFailed('EAI_AGAIN');
      fetchCalls.push(String(url));
      // Solo `phi-4` porta il 429, e resta appeso al gate finche' la finestra
      // del flap non e' quasi scaduta: e' la forma reale — le chiamate corrono
      // in parallelo, e un 429 partito prima puo' atterrare molto dopo.
      if (String(init?.body || '').includes('phi-4')) {
        await late429;
        return new Response('rate limit exceeded', { status: 429 });
      }
      throw undiciFetchFailed('EAI_AGAIN');
    };

    const rateLimited = callLLM([{ role: 'user', content: 'x' }], { ...OPTS_429, chain: ['phi-4'] })
      .then(() => null, (e) => e);

    // Tre flap di fila sullo stesso provider: la finestra da 5 minuti si apre.
    await assert.rejects(() => callLLM([{ role: 'user', content: 'x' }], {
      ...OPTS, chain: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o'],
    }));
    const finestraFlap = getStats().activeCooldowns.github;
    assert.ok(
      Number.isFinite(finestraFlap) && finestraFlap > 60,
      `attesa la finestra finita del flap: ${JSON.stringify(getStats().activeCooldowns)}`,
    );

    // Il 429 atterra a finestra quasi finita: i suoi 60s cadrebbero OLTRE.
    mock.timers.tick(250_000);
    release429();
    assert.ok(await rateLimited, 'anche la chiamata rate-limited deve fallire');

    const primaDellaScadenza = ghCalls().length;
    mock.timers.tick(51_000); // 301s dall'apertura: la finestra del flap e' scaduta
    await assert.rejects(() => callLLM([{ role: 'user', content: 'x' }], { ...OPTS, chain: ['gpt-4.1'] }));

    assert.ok(
      ghCalls().length > primaDellaScadenza,
      `un 429 non deve prolungare la finestra di una causa piu' grave: attesi piu' di ${primaDellaScadenza} connect, visti ${ghCalls().length}`,
    );
  });
});
