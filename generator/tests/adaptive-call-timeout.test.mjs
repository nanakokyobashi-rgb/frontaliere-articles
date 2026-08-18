/**
 * ── IL TETTO CHE NESSUNO ABBASSAVA ──────────────────────────────────────────
 *
 * Su 14 run consecutive `success` di `generate-article.yml` (2026-08-18,
 * 09:01-11:06 UTC) quattro hanno perso 60,0 ± 0,003 s ciascuna in UNA sola
 * chiamata appesa, sempre su `nvidia/meta/llama-3.1-8b-instruct`: 240 s su 14
 * run, 17,1 s/run, 4,3 % della durata. I 60,0 s sono il `timeout: 60_000` del
 * chiamante (la chiamata di fact-check), non un giro di retry — entrambi i
 * loop dei provider gia' si rifiutano di ritentare un timeout, e il cap duro
 * non e' mai scattato.
 *
 * I due meccanismi che sembrano doverlo intercettare non lo intercettano:
 *
 *   - il ledger REGISTRA il timeout (`recordModelFailure` con `exhausted:true`,
 *     cioe' -50) ed e' inerte: quel modello vale +36819 nel documento
 *     `ai_model_scores/_all` (172.042 successi / 3.286 fallimenti, letto il
 *     2026-08-18 alle 11:25 Z), quindi -50 lo sposta dello 0,14 % e resta primo
 *     su 340 — il secondo sta a +120. Una somma cumulativa NON limitata non
 *     puo' essere smentita da niente di recente;
 *   - bandirlo sarebbe sbagliato: 98,1 % di successo storico, ~26 chiamate
 *     riuscite nella stessa run che poi perde 60 s, e una sonda diretta su
 *     integrate.api.nvidia.com ha risposto 5 volte su 5 in 1,2-5,3 s.
 *
 * Quello che si recupera non e' «quale modello», e' «quanto continuiamo ad
 * aspettare un modello che abbiamo gia' visto rispondere in fretta».
 *
 * ── COSA BLOCCA QUESTO FILE ─────────────────────────────────────────────────
 *
 * Il test comportamentale passa da `callSingleModel`, cioe' dal vero
 * `_callModel`, con la rete sostituita: prima si fanno rispondere in fretta
 * alcune chiamate (l'unica prova che il tetto accetta), poi si fa appendere la
 * successiva e si misura QUANDO muore. Senza la fix muore al numero del
 * chiamante; con la fix muore al tetto adattivo. E' la differenza che il bug
 * produce, quindi e' quella che il test misura — non la presenza di una
 * costante.
 *
 * ── DUE COSE CHE UN FETCH FINTO ROMPE, E COME SONO CHIUSE ───────────────────
 *
 * 1. **L'event loop si svuota mentre la chiamata e' appesa.** Tutti i timer di
 *    `_callModel` sono `unref()` di proposito (il cap duro e l'heartbeat non
 *    devono tenere vivo il processo), e anche `AbortSignal.timeout()` e'
 *    unref'd per contratto Node. Con la rete VERA resta comunque vivo il socket
 *    del fetch; con un fetch finto non resta niente, il runner conclude che il
 *    loop e' finito e su Node 22 uccide l'intero file con
 *    «Promise resolution is still pending but the event loop has already
 *    resolved» — quattro test rossi per un difetto solo. Il `keepAlive` qui
 *    sotto e' un timer ref'd che rimpiazza esattamente l'handle che il fetch
 *    finto non ha, e viene spento appena la chiamata si risolve: non sposta di
 *    un millisecondo il momento in cui l'abort scatta, che e' l'unica cosa che
 *    questo file misura. (Verificato: Node 26 in locale passava lo stesso, Node
 *    22 del CI no. Il verde locale non era una prova.)
 *
 * 2. **La soglia scritta a mano e' una corsa fra due orologi.** L'asserzione
 *    non confronta il tempo trascorso con una frazione fissa del numero del
 *    chiamante — su un runner lento quel confronto si inverte e il test diventa
 *    flaky. Confronta con il tetto REALMENTE applicato, che il codice espone su
 *    `err.adaptiveTimeoutMs`, e la precondizione «il tetto guadagnato e' sotto
 *    il numero del chiamante» e' verificata prima e fallisce con un messaggio
 *    che dice che la macchina era troppo lenta, invece di dire il falso.
 *
 * Le tre garanzie di degrado sono verificate una per una sulla funzione pura,
 * perche' sono esattamente cio' che rende la fix sicura: prova sottile → il
 * numero del chiamante resta intatto; il tetto non sale mai; il pavimento
 * vince comunque.
 */

// I knob si leggono a module-load: vanno impostati PRIMA dell'import.
process.env.AI_ADAPTIVE_TIMEOUT_MIN_SAMPLES = '2';
process.env.AI_ADAPTIVE_TIMEOUT_MULT = '4';
process.env.AI_ADAPTIVE_TIMEOUT_FLOOR_MS = '150';
process.env.GROQ_API_KEY = 'test-key-la-rete-e-sostituita';

import { strict as assert } from 'node:assert';
import { describe, it, before, after } from 'node:test';

const {
  callSingleModel,
  computeAdaptiveTimeoutMs,
  getCallLatencyStats,
  resetState,
} = await import('../scripts/lib/ai-models.mjs');

const MODEL = 'groq/llama-3.1-8b-instant';
/** Il numero del chiamante: cio' che si pagherebbe senza tetto adattivo. */
const CALLER_TIMEOUT_MS = 8_000;
/** Margine sopra il tetto applicato: copre lo scheduling, non una corsa. */
const SLACK_MS = 2_000;

let realFetch;
/** 'fast' → risponde subito; 'hang' → non risponde mai, muore solo sull'abort. */
let netMode = 'fast';

before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    if (netMode === 'fast') {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // nessun segnale: resterebbe appesa per sempre, ed e' il punto
      signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        reject(err);
      });
    });
  };
});

after(() => {
  globalThis.fetch = realFetch;
  resetState();
});

const call = () =>
  callSingleModel([{ role: 'user', content: 'ping' }], {
    model: MODEL,
    timeout: CALLER_TIMEOUT_MS,
    maxRetriesPerModel: 1,
    maxTokens: 16,
    cache: false,
  });

/**
 * Rimpiazza l'handle di rete che il fetch finto non ha. Senza, l'event loop si
 * svuota mentre la chiamata e' appesa (tutti i timer in gioco sono unref'd) e
 * il runner cancella il file intero. Non ritarda l'abort: e' un timer vuoto.
 */
async function withLoopAlive(fn) {
  const keepAlive = setInterval(() => {}, 25);
  try {
    return await fn();
  } finally {
    clearInterval(keepAlive);
  }
}

describe('tetto di chiamata adattivo', () => {
  it('uccide la chiamata appesa al tetto guadagnato, non al numero del chiamante', async () => {
    resetState();
    netMode = 'fast';

    // La prova: due risposte vere. Sotto AI_ADAPTIVE_TIMEOUT_MIN_SAMPLES il
    // tetto non ha titolo per dire niente, ed e' quella la prima garanzia.
    await withLoopAlive(call);
    await withLoopAlive(call);

    const observed = getCallLatencyStats()[MODEL];
    assert.ok(observed, 'le chiamate riuscite devono lasciare una misura di latenza');
    assert.ok(observed.samples >= 2, `attesi >= 2 campioni, visti ${observed.samples}`);

    // Precondizione esplicita invece di una soglia a occhio: se la macchina e'
    // cosi' lenta che il tetto guadagnato non sta sotto il numero del
    // chiamante, il test lo DICE — non finge un verdetto sul codice.
    const expectedCeiling = computeAdaptiveTimeoutMs(observed, CALLER_TIMEOUT_MS);
    assert.ok(
      expectedCeiling < CALLER_TIMEOUT_MS,
      `ambiente troppo lento per questo test: massimo osservato ${observed.maxMs}ms → tetto ${expectedCeiling}ms, non sotto i ${CALLER_TIMEOUT_MS}ms del chiamante`,
    );

    netMode = 'hang';
    const started = Date.now();
    let caught;
    try {
      await withLoopAlive(call);
      assert.fail('la chiamata appesa doveva fallire');
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - started;

    // Questa e' la marcatura che il codice mette SOLO quando ha stretto lui il
    // tetto: senza la fix non esiste, quindi da sola uccide il mutante — e non
    // dipende da nessun orologio.
    assert.equal(
      caught?.adaptiveTimeoutClamped,
      true,
      'un timeout scattato sotto un tetto che abbiamo stretto NOI va marcato, altrimenti il circuit-breaker bandisce il modello sulla nostra congettura',
    );
    assert.equal(
      caught.adaptiveTimeoutMs,
      expectedCeiling,
      `il tetto applicato (${caught.adaptiveTimeoutMs}ms) doveva essere quello guadagnato (${expectedCeiling}ms)`,
    );
    // E il fatto comportamentale: si e' smesso di aspettare al tetto, non al
    // numero del chiamante. Il confronto e' col tetto REALE piu' uno slack di
    // scheduling, non con una frazione fissa degli 8s: cosi' non e' una corsa.
    assert.ok(
      elapsed < expectedCeiling + SLACK_MS,
      `la chiamata appesa e' durata ${elapsed}ms contro un tetto di ${expectedCeiling}ms: il tetto adattivo non e' stato applicato (il chiamante chiedeva ${CALLER_TIMEOUT_MS}ms)`,
    );
  });

  it('con prova sottile lascia intatto il numero del chiamante', () => {
    assert.equal(computeAdaptiveTimeoutMs(undefined, 60_000), 60_000);
    assert.equal(computeAdaptiveTimeoutMs({ samples: 0, maxMs: 0 }, 60_000), 60_000);
    // Un campione sotto soglia non basta: e' la differenza fra «ha risposto
    // in fretta una volta» e «lo fa sempre».
    assert.equal(
      computeAdaptiveTimeoutMs({ samples: 1, maxMs: 1_000 }, 60_000, { minSamples: 2 }),
      60_000,
    );
  });

  it('non alza mai il tetto del chiamante', () => {
    // 4 x 30s = 120s guadagnati, ma il chiamante ne concede 30: vince il chiamante.
    assert.equal(
      computeAdaptiveTimeoutMs({ samples: 50, maxMs: 30_000 }, 30_000, { minSamples: 10, mult: 4, floorMs: 20_000 }),
      30_000,
    );
  });

  it('non scende mai sotto il pavimento, per quanto veloce sia stato il modello', () => {
    // 4 x 100ms = 400ms, ma il pavimento e' 20s: un modello velocissimo non si
    // guadagna un tetto che una singola coda di rete farebbe scattare.
    assert.equal(
      computeAdaptiveTimeoutMs({ samples: 50, maxMs: 100 }, 60_000, { minSamples: 10, mult: 4, floorMs: 20_000 }),
      20_000,
    );
    // E il caso che la fix esiste per recuperare: massimo osservato 5s, tetto
    // 20s (il pavimento), contro i 60s del chiamante → 40s recuperati per evento.
    assert.equal(
      computeAdaptiveTimeoutMs({ samples: 30, maxMs: 5_000 }, 60_000, { minSamples: 10, mult: 4, floorMs: 20_000 }),
      20_000,
    );
  });
});
