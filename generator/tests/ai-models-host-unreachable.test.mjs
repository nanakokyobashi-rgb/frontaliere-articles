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
 *   4. ECONNRESET e i timeout restano ritentabili. E' il confine che rende la
 *      regola sicura: un reset a meta' stream e' transitorio su un host vivo,
 *      e allargare l'insieme scambierebbe un retry legittimo per un ban.
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';

import {
  classifyHostUnreachable,
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
    assert.equal(classifyHostUnreachable(undiciFetchFailed('EAI_AGAIN')), 'EAI_AGAIN');
    assert.equal(classifyHostUnreachable(undiciAggregate('EHOSTUNREACH')), 'EHOSTUNREACH');
    // Errore nudo (non passato da fetch) — stessa classe, stessa risposta.
    assert.equal(classifyHostUnreachable(Object.assign(new Error('x'), { code: 'ENETUNREACH' })), 'ENETUNREACH');
  });

  it('NON classifica cio' + "'" + 'che e\' transitorio o gia\' coperto altrove', () => {
    // Un reset a meta' stream: l\'host e\' vivo, il retry ha senso.
    assert.equal(classifyHostUnreachable(undiciFetchFailed('ECONNRESET')), null);
    assert.equal(classifyHostUnreachable(undiciFetchFailed('EPIPE')), null);
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
