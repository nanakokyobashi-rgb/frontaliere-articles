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
import { describe, it, beforeEach, afterEach } from 'node:test';

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
