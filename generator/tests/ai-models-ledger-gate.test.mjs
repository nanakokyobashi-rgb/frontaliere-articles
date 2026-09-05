/**
 * ── UNA SOLA PORTA VERSO IL LEDGER CONDIVISO ───────────────────────────────
 *
 * `ai_model_scores/_all` (Firestore, progetto `frontaliere-ticino`) e' UN solo
 * documento, scritto da ogni workflow dei due repo e letto da
 * `sortChainByScore()` per ordinare la cascata di produzione su OGNI macchina.
 *
 * Il difetto che questo file misura non e' un bug, e' una FORMA di bug che si e'
 * ripresentata sei volte (#630, #783, #838, #845, #864, #874): la coppia
 * `_dirtyModels.add(id)` + `_schedulePersist()` era copiata in sei writer, e
 * ognuno decideva per conto suo se aveva il diritto di scrivere. Ogni difesa
 * aggiunta copriva un percorso solo, e il giro dopo ne emergeva un altro
 * scoperto — la penale di punteggio protetta e il contatore `failures` no, il
 * ban protetto e il cap appreso no, l'errore con codice di rete protetto e il
 * gateway che RISPONDE no.
 *
 * La misura strutturale e' quindi il punto 1: nel sorgente esiste UN solo
 * `_dirtyModels.add(`, ed e' dentro `_proposeLedgerWrite`. Un writer nuovo non
 * puo' dimenticare la regola, perche' non ha un altro modo di scrivere. Il
 * resto del file misura le due decisioni che la porta prende — l'opt-out del
 * chiamante e l'endpoint per-macchina — sui percorsi che erano rimasti fuori.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it, beforeEach, afterEach } from 'node:test';

import {
  callLLM,
  discoverFreeModels,
  flushScores,
  getStats,
  markModelExhausted,
  prunedStaleModels,
  recordModelContentFailure,
  recordModelFailure,
  recordModelSuccess,
  resetState,
  _cooldownSeverityDurations,
  _perMachineEndpointEnvVars,
  __installScoreStoreForTests,
} from '../scripts/lib/ai-models.mjs';

const SRC = readFileSync(new URL('../scripts/lib/ai-models.mjs', import.meta.url), 'utf8');

// Il sorgente con le RIGHE di commento svuotate. Necessario perche' i commenti
// di quel modulo citano il codice per esteso — nomi di variabili d'ambiente
// compresi — e un grep sul testo grezzo scambierebbe un esempio dentro un
// docblock per una lettura vera.
//
// Filtro per RIGA e non a blocchi, deliberatamente. La versione a blocchi
// (`replace(/\/\*[\s\S]*?\*\//g, ...)` prima dei commenti riga) e' cieca in un
// modo che non si vede: un `/*` che compare DENTRO un commento `//` apre un
// finto blocco, e il primo `*/` successivo lo chiude portandosi via tutto il
// CODICE in mezzo. Non e' teorico — misurato su questo stesso file: la riga
// `// cookie only gates /api/* management routes` faceva sparire una delle tre
// occorrenze di `_dirtyModels.add(` e l'intero blocco `catch` di `callLLM`,
// cioe' 4.732 righe su 7.535 e proprio la regione dove vivono #838 e #848. Un
// gate strutturale cieco sul 63% del modulo e' peggio di nessun gate, perche'
// il verde sembra una prova.
//
// Un filtro per riga non ha quel modo di fallire: al massimo lascia passare un
// commento in coda a una riga di codice, che al peggio produce un falso
// POSITIVO — il test si lamenta di troppo, non di troppo poco. Le righe sono
// svuotate e non tolte, cosi' i numeri di riga restano quelli del file.
const SRC_CODE = SRC.split('\n')
  .map((riga) => (/^\s*(\/\/|\/\*|\*)/.test(riga) ? '' : riga))
  .join('\n');

const ENV_KEYS = [
  'AI_MODELS_FORCE_CHAIN', 'AI_MODELS_PREFER', 'GH_MODELS_PAT',
  'OMNIROUTE_ENABLED', 'OMNIROUTE_URL', 'LOCAL_LLM_ENABLED', 'LOCAL_LLM_URL',
];

const scoreOf = (stats, model) => stats.scoreBoard.find((e) => e.model === model)?.score ?? 0;
const failuresOf = (stats, model) => stats.runOutcomes.find((e) => e.model === model)?.failures ?? 0;

/** Un finto Firestore che registra l'ultima entry scritta per ogni modello. */
function makeStore() {
  const written = [];
  const db = {
    collection: () => ({
      doc: () => ({
        set: async (data) => { written.push(data); },
        get: async () => ({ exists: false, data: () => null }),
      }),
    }),
  };
  return { db, written, last: () => written[written.length - 1] };
}

describe('#874/#864/#845 — una sola porta di scrittura verso ai_model_scores/_all', () => {
  it('nel sorgente esiste UN solo `_dirtyModels.add(`, ed e\' dentro _proposeLedgerWrite', () => {
    const righe = SRC_CODE.split('\n')
      .map((riga, i) => ({ n: i + 1, riga }))
      .filter(({ riga }) => /(?<![\w.])_dirtyModels\.add\(/.test(riga));

    // La riga della porta piu' quella del RECUPERO dentro
    // `_persistScoresToFirestore`, che rimette in coda i modelli di una
    // scrittura fallita: quella non e' una proposta nuova, e' la stessa gia'
    // accettata dalla porta che torna indietro perche' la rete l'ha respinta.
    // Filtrarla per NOME della funzione e non per numero di riga, cosi' resta
    // vera quando il file si muove.
    const attese = new Set(['_proposeLedgerWrite', '_persistScoresToFirestore']);
    const funzioneDi = (n) => {
      const prima = SRC_CODE.split('\n').slice(0, n);
      for (let i = prima.length - 1; i >= 0; i--) {
        // `export function` e i metodi contano quanto una `function` nuda: senza
        // `export` nel pattern, un `_dirtyModels.add(` dentro una funzione
        // ESPORTATA veniva attribuito alla dichiarazione precedente — e se
        // quella era la porta, il pin restava verde su una violazione vera.
        const m = prima[i].match(/^(?:export\s+)?(?:async\s+)?function (\w+)\s*\(/);
        if (m) return m[1];
      }
      return '(top-level)';
    };

    const fuori = righe.filter(({ n }) => !attese.has(funzioneDi(n)));
    assert.deepEqual(
      fuori.map(({ n, riga }) => `${n}: ${riga.trim()} [in ${funzioneDi(n)}]`),
      [],
      'un writer scrive il ledger senza passare da _proposeLedgerWrite: e\' la forma di #838/#845/#864/#874, '
      + 'dove ogni difesa copriva un percorso solo. Usa _proposeLedgerWrite(modelId, recordScore).',
    );
    assert.ok(righe.length >= 2, `il grep non trova piu' nemmeno la porta: ${righe.length} occorrenze`);
  });

  it('la tabella degli endpoint per-macchina copre ogni URL che il modulo legge da env (#874 item 3)', () => {
    // `_isPerMachineEndpoint` rispondeva «quale provider e'» mentre la proprieta'
    // che conta e' «l'indirizzo arriva dall'ambiente di QUESTA macchina», e il
    // commento chiedeva di allungare la lista a mano il giorno in cui un
    // provider a endpoint fisso avesse preso un override da env: una promessa
    // affidata alla memoria. Questo assert e' cio' che la sostituisce.
    const nelSorgente = new Set(
      [...SRC_CODE.matchAll(/process\.env\.([A-Z0-9_]*URL)\b/g)].map((m) => m[1]),
    );
    const dichiarati = new Set(_perMachineEndpointEnvVars());

    const scoperti = [...nelSorgente].filter((v) => !dichiarati.has(v));
    assert.deepEqual(
      scoperti,
      [],
      `questi endpoint sono configurabili da env ma non risultano per-macchina: ${scoperti.join(', ')}. `
      + 'Un verdetto su di essi finirebbe nel documento condiviso descrivendo una macchina sola (#838). '
      + 'Aggiungili a PER_MACHINE_ENDPOINT_ENV, o togli l\'override di URL.',
    );
    const fantasmi = [...dichiarati].filter((v) => !nelSorgente.has(v));
    assert.deepEqual(fantasmi, [], `PER_MACHINE_ENDPOINT_ENV nomina variabili che il modulo non legge piu': ${fantasmi.join(', ')}`);
  });
});

describe('#874 — la soppressione copre l\'INTERO record, non il solo punteggio', () => {
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

  // Item 2. La carve-out di #862 fermava la penale di punteggio, non il
  // contatore: `_bumpOutcome` alimentava `_pendingCounterDeltas`, che esce come
  // `FieldValue.increment(1)` sul campo `failures` della stessa entry. Il
  // record condiviso continuava quindi a raccontare i guasti di una macchina
  // sola, dalla porta di servizio.
  it('un fallimento su endpoint per-macchina non propone NIENTE al ledger, ma resta contato nella run', () => {
    recordModelFailure('local/fallback');
    recordModelFailure('omniroute/auto');

    const stats = getStats();
    assert.equal(stats.dirtyModels, 0, `nessuna proposta attesa, ${stats.dirtyModels} modelli sporchi`);
    assert.equal(failuresOf(stats, 'local/fallback'), 1, `il fallimento va contato nella run: ${JSON.stringify(stats.runOutcomes)}`);
    assert.equal(failuresOf(stats, 'omniroute/auto'), 1, `idem per omniroute: ${JSON.stringify(stats.runOutcomes)}`);
  });

  it('nemmeno un SUCCESSO su endpoint per-macchina e\' condivisibile', () => {
    // Il verso opposto e' altrettanto falso: un gateway che questa macchina
    // raggiunge non e' una prova che le altre lo raggiungano.
    recordModelSuccess('omniroute/auto');
    assert.equal(getStats().dirtyModels, 0, 'un successo per-macchina non deve proporre niente al ledger condiviso');
  });

  // Item 1. La carve-out si agganciava a `e.hostUnreachable`, cioe' a un codice
  // syscall di HOST_UNREACHABLE_CODES. Un gateway rotto in un modo che RISPONDE
  // non ne porta nessuno.
  it('un gateway per-macchina che RISPONDE 502 non scrive comunque niente', async () => {
    process.env.OMNIROUTE_ENABLED = '1';
    process.env.OMNIROUTE_URL = 'https://gateway.example.invalid/v1/chat/completions';
    process.env.AI_MODELS_FORCE_CHAIN = 'omniroute/auto';
    globalThis.fetch = async () => ({
      ok: false,
      status: 502,
      headers: new Map(),
      text: async () => '<html>502 Bad Gateway — nginx</html>',
      json: async () => ({}),
    });

    await assert.rejects(() => callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 }));

    const stats = getStats();
    assert.equal(
      stats.dirtyModels,
      0,
      'un reverse proxy rotto davanti al gateway di QUESTO runner non porta codici di rete, '
      + `ma resta un fatto di una macchina sola: ${stats.dirtyModels} modelli proposti al ledger`,
    );
    // Il punteggio IN MEMORIA si muove, e deve: per questa run, su questa
    // macchina, quel gateway e' davvero rotto e la cascata fa bene a
    // scavalcarlo. Cio' che non deve uscire e' la proposta al documento
    // condiviso, e la riga sopra e' quella che lo misura.
    assert.ok(scoreOf(stats, 'omniroute/auto') < 0, `l'ordinamento di questa run deve comunque saperlo: ${JSON.stringify(stats.scoreBoard)}`);
  });

  // Il contrappunto che tiene onesta la regola: su un provider a endpoint fisso
  // un 502 e' un fatto condivisibile e continua a essere scritto.
  it('su un provider a endpoint fisso lo stesso 502 propone eccome', async () => {
    process.env.GH_MODELS_PAT = 'test-pat';
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o-mini';
    globalThis.fetch = async () => ({
      ok: false,
      status: 502,
      headers: new Map(),
      text: async () => '<html>502 Bad Gateway</html>',
      json: async () => ({}),
    });

    await assert.rejects(() => callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 }));

    assert.ok(getStats().dirtyModels > 0, 'senza questo caso la regola sopra sarebbe una tautologia');
  });
});

describe('#864 — i cap appresi da un endpoint per-macchina restano in processo', () => {
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

  it('un 400 «Limit 4096» su omniroute non pubblica quel tetto per tutte le macchine', async () => {
    // Il danno: un runner con un Ollama servito a 8k pubblica quel cap sotto
    // l'id condiviso, e le altre macchine — il cui server accetterebbe il
    // prompt — iniziano a saltarlo come «troppo grande» via il pre-flight
    // guard, senza nessun errore da cui accorgersene.
    process.env.OMNIROUTE_ENABLED = '1';
    process.env.OMNIROUTE_URL = 'https://gateway.example.invalid/v1/chat/completions';
    process.env.AI_MODELS_FORCE_CHAIN = 'omniroute/auto';
    globalThis.fetch = async () => ({
      ok: false,
      status: 400,
      headers: new Map(),
      text: async () => JSON.stringify({ error: { message: 'Request too large. Limit 4096 tokens' } }),
      json: async () => ({ error: { message: 'Request too large. Limit 4096 tokens' } }),
    });

    await assert.rejects(() => callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 }));

    assert.equal(
      getStats().dirtyModels,
      0,
      'il cap appreso da un endpoint per-macchina non deve essere proposto al documento condiviso (#864)',
    );
  });
});

describe('#845 — recordModelContentFailure accetta l\'opt-out invece di scrivere sempre', () => {
  beforeEach(() => { resetState(); });
  afterEach(() => { resetState(); });

  // La funzione e' ESPORTATA e i suoi chiamanti veri stanno fuori da callLLM
  // (body2-payload-verdict.mjs, itLanguageCheck.mjs, che la usano come
  // meccanismo di rotazione del modello). Senza il parametro, un flusso
  // diagnostico che validava una risposta scriveva il ledger in opt-OUT:
  // nessun modo di chiedere il contrario.
  it('con recordScore:false non lascia niente da persistere — ma il modello ruota lo stesso', () => {
    for (let i = 0; i < 2; i++) recordModelContentFailure('gpt-4o-mini', { recordScore: false });

    const stats = getStats();
    assert.equal(stats.dirtyModels, 0, `un validatore diagnostico ha sporcato ${stats.dirtyModels} modelli`);
    assert.ok(
      stats.exhaustedModels.includes('gpt-4o-mini'),
      `il MARCHIO in-processo deve restare — e' cio' che fa ruotare il modello, e non e' un dato di ledger: ${stats.exhaustedModels.join(', ')}`,
    );
  });

  it('col default continua a scrivere: il confine che rende il caso sopra una misura', () => {
    recordModelContentFailure('gpt-4o-mini');
    assert.ok(getStats().dirtyModels > 0, 'senza questo caso, un opt-out che spegnesse TUTTO passerebbe il test sopra');
  });

  // Un id falsy entrava in `_runOutcomes` come CHIAVE, e `getRunOutcomes()`
  // esplodeva nel comparatore (`a.model.localeCompare`) appena c'erano due
  // voci. Il punto dolente non e' la chiamata sbagliata, e' dove il TypeError
  // atterra: dentro `getStats()`, quindi dentro il riepilogo di fine run —
  // porta via la diagnostica proprio del giro andato male. `recordModelContentFailure`
  // aveva gia' la guardia; i suoi due gemelli no.
  it('un id falsy non fa esplodere il riepilogo di fine run', () => {
    recordModelFailure('gpt-4o-mini');
    recordModelFailure(undefined);
    recordModelFailure('');
    recordModelSuccess(null);

    const stats = getStats();
    assert.deepEqual(
      stats.runOutcomes.map((o) => o.model),
      ['gpt-4o-mini'],
      `nessun id falsy deve entrare nel tally di run: ${JSON.stringify(stats.runOutcomes)}`,
    );
  });
});

describe('#875 — resetState() lascia uno stato coerente', () => {
  afterEach(() => { resetState(); });

  // Item 1. Il reset svuota `_modelScores` ma lascia in piedi `_firestoreDb`, e
  // dal 2026-09-05 lascia anche ri-eseguire la discovery: il ramo markStale
  // marca gli id decommissionati, il flush leggeva `_modelScores.get(id) || 0`
  // e scriveva uno ZERO ASSOLUTO sopra il valore reale del documento condiviso.
  it('un modello sporco senza punteggio non riscrive `score: 0` sopra il valore reale', async () => {
    const store = makeStore();
    resetState();
    __installScoreStoreForTests(store.db, null);

    // Esattamente cio' che fa la discovery post-reset: marca senza toccare i punteggi.
    markModelExhausted('gpt-4o-mini', 'stale');
    await flushScores();

    const entry = store.last()?.models?.['gpt-4o-mini'];
    assert.ok(entry, `il modello doveva essere proposto: ${JSON.stringify(store.last())}`);
    assert.ok(
      !('score' in entry),
      'il campo `score` va OMESSO quando questo processo non ne ha uno: con {merge:true} un campo assente '
      + `lascia intatto il valore reale, uno zero lo cancella. Scritto: ${JSON.stringify(entry)}`,
    );
  });

  // Stesso anti-pattern cinquanta righe sotto quello di item 1: `exhaustedUntil`
  // usciva come `null` ASSOLUTO per ogni modello sporco che non risulta
  // quota-exhausted IN QUESTO processo, e con {merge:true} quel null cancella il
  // ban di quota che un'altra macchina ha appena persistito sullo stesso
  // documento condiviso — ogni altro workflow torna a pagare i 429 fino a
  // mezzanotte, in silenzio.
  it('un modello sporco per un altro motivo non azzera il ban di quota altrui', async () => {
    const store = makeStore();
    resetState();
    __installScoreStoreForTests(store.db, null);

    markModelExhausted('gpt-4o-mini', 'stale');
    await flushScores();

    const entry = store.last()?.models?.['gpt-4o-mini'];
    assert.ok(entry, `il modello doveva essere proposto: ${JSON.stringify(store.last())}`);
    assert.ok(
      !('exhaustedUntil' in entry),
      'il campo `exhaustedUntil` va OMESSO quando questo processo non ha una prova: uno `null` assoluto '
      + `cancella il ban di quota scritto da un'altra macchina. Scritto: ${JSON.stringify(entry)}`,
    );
  });

  it('un successo in questo processo azzera eccome il ban persistito', async () => {
    const store = makeStore();
    resetState();
    __installScoreStoreForTests(store.db, null);

    // La prova che rende legittima la cancellazione: il modello ha risposto, quindi
    // l'account non e' a quota (e' il caso della rotazione multi-PAT).
    recordModelSuccess('gpt-4o-mini');
    await flushScores();

    const entry = store.last()?.models?.['gpt-4o-mini'];
    assert.equal(
      entry?.exhaustedUntil, null,
      `un successo misurato qui deve togliere il ban: ${JSON.stringify(entry)}`,
    );
  });

  it('una quota esaurita qui continua a scrivere la data di reset', async () => {
    const store = makeStore();
    resetState();
    __installScoreStoreForTests(store.db, null);

    markModelExhausted('gpt-4o-mini', 'quota');
    await flushScores();

    const entry = store.last()?.models?.['gpt-4o-mini'];
    assert.ok(
      typeof entry?.exhaustedUntil === 'string' && !Number.isNaN(Date.parse(entry.exhaustedUntil)),
      `la quota esaurita resta persistita: ${JSON.stringify(entry)}`,
    );
  });

  it('un modello con un punteggio vero lo scrive eccome', async () => {
    const store = makeStore();
    resetState();
    __installScoreStoreForTests(store.db, null);

    recordModelSuccess('gpt-4o-mini');
    await flushScores();

    const entry = store.last()?.models?.['gpt-4o-mini'];
    assert.ok(typeof entry?.score === 'number', `il punteggio vero deve arrivare: ${JSON.stringify(entry)}`);
  });

  // Item 2. `_discoveryDone = true` precedeva il `Promise.all`: un secondo
  // chiamante arrivato mentre la sweep era in volo non aspettava e riceveva
  // `_dynamicModels` a meta' popolamento, trattandolo come lista completa.
  it('il secondo chiamante ASPETTA la sweep invece di ricevere una lista a meta\'', async () => {
    // `assert.equal(a, b)` NON misura niente qui: entrambi i rami rendono lo
    // STESSO oggetto `_dynamicModels`, quindi l'identita' era gia' vera prima
    // del fix. Il difetto di #875 item 2 e' TEMPORALE — il secondo chiamante
    // riceveva l'array mentre la sweep era ancora in volo — e va quindi
    // osservato nel tempo: la sweep viene tenuta ferma su un `fetch` che non
    // risolve, e si guarda se il secondo chiamante si e' gia' liberato.
    resetState();
    const realFetch = globalThis.fetch;
    // Senza almeno una chiave di discovery, `_discoverProvider` esce prima del
    // `fetch` per OGNI provider: la sweep finisce nello stesso turno e il
    // cancello sotto non trattiene niente — cioe' il test tornerebbe a non
    // misurare nulla. Una sola chiave accesa, le altre spente, cosi' il turno
    // di rete e' esattamente uno.
    const CHIAVI = [
      'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'CEREBRAS_API_KEY', 'MISTRAL_API_KEY',
      'NVIDIA_API_KEY', 'NVIDIA_NIM_API_KEY', 'SAMBANOVA_API_KEY', 'TOGETHER_API_KEY',
      'FIREWORKS_API_KEY', 'COHERE_API_KEY', 'CHUTES_API_KEY', 'HUGGINGFACE_API_KEY',
      'ZAI_API_KEY', 'ZHIPU_API_KEY', 'CF_ACCOUNT_ID', 'CF_API_TOKEN',
    ];
    const chiaviBackup = Object.fromEntries(CHIAVI.map((k) => [k, process.env[k]]));
    for (const k of CHIAVI) delete process.env[k];
    process.env.OPENROUTER_API_KEY = 'test-key';

    let apriIlCancello;
    const cancello = new Promise((r) => { apriIlCancello = r; });
    let fetchChiamato = false;
    globalThis.fetch = async () => {
      fetchChiamato = true;
      await cancello;
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ data: [] }), text: async () => '{"data":[]}' };
    };

    try {
      const primo = discoverFreeModels();
      let secondoRisolto = false;
      const secondo = discoverFreeModels().then((v) => { secondoRisolto = true; return v; });

      // Qualche giro di microtask e un turno di event loop: con un latch
      // booleano il ramo «gia' fatta» e' un `return` immediato, quindi qui
      // sarebbe gia' vero.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      assert.ok(fetchChiamato, 'la sweep non ha nemmeno provato la rete: il cancello non trattiene niente e il caso non misura');
      assert.equal(
        secondoRisolto,
        false,
        'il secondo chiamante si e\' liberato mentre la sweep era ancora in volo: riceve `_dynamicModels` a meta\' '
        + 'popolamento e lo tratta come lista completa (#875 item 2 — il latch deve essere la promessa, non un booleano)',
      );

      apriIlCancello();
      const [a, b] = await Promise.all([primo, secondo]);
      assert.equal(secondoRisolto, true, 'dopo la sweep il secondo chiamante deve essere risolto');
      assert.equal(a, b, 'e deve aver ricevuto la stessa lista del primo');
    } finally {
      apriIlCancello();
      globalThis.fetch = realFetch;
      for (const k of CHIAVI) {
        if (chiaviBackup[k] === undefined) delete process.env[k];
        else process.env[k] = chiaviBackup[k];
      }
    }
  });

  // Item 3. `_prunedStale.clear()` buttava via il REGISTRO delle potature
  // lasciando in piedi le potature: lo splice su DEFAULT_CHAIN e' definitivo e
  // il reset non ricostruisce la catena (decisione deliberata: e' un array vivo
  // che i chiamanti hanno gia' in mano). Restava quindi una catena accorciata
  // di cui nessuna diagnostica sapeva piu' dire da quale provider veniva.
  it('il registro delle potature non viene azzerato senza disfare le potature', () => {
    assert.ok(
      !/^\s*_prunedStale\.clear\(\);/m.test(SRC),
      'resetState() torna a svuotare _prunedStale: o ricostruisce anche DEFAULT_CHAIN, o il registro deve sopravvivere '
      + 'come sopravvivono le potature che descrive (#875 item 3)',
    );
    resetState();
    assert.ok(Array.isArray(prunedStaleModels()), 'prunedStaleModels() deve restare interrogabile dopo un reset');
  });
});

describe('#848/#849 — un guasto, un voto', () => {
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

  // #848 item 1. Il tag `hostUnreachable` vinceva sul ramo timeout per il
  // COOLDOWN ma non per la CAUSA: la guardia `!markedExhausted` faceva saltare
  // la seconda `markModelExhausted`, `_exhaustReason` restava `timeout`, e
  // `classifyExhaustionCause` contava TRANSITORIO a ogni tick successivo lo
  // stesso guasto per cui la riga di skip dei fratelli votava persistente. Il
  // tally che decide fra differimento silenzioso e Workflow Failure riceveva
  // due voti opposti per un guasto solo.
  it('un errore che porta insieme un codice di rete e la parola «aborted» viene bannato come nonretryable, non come timeout', async () => {
    // Due id serviti dallo stesso host: il secondo e' il FRATELLO, ed e' cio'
    // che rende osservabili le DUE frasi insieme.
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o-mini,gpt-4.1-mini';
    globalThis.fetch = async () => {
      throw Object.assign(new TypeError('fetch failed: the operation was aborted'), {
        cause: Object.assign(new Error('ECONNREFUSED 20.1.2.3:443'), { code: 'ECONNREFUSED' }),
      });
    };

    // `_exhaustReason` non e' esportato: si legge dalla frase di skip che
    // `_exhaustSkipCause` costruisce, ed e' esattamente cio' che
    // `classifyExhaustionCause` conta. La frase compare al giro SUCCESSIVO
    // della catena, quando il modello viene saltato perche' gia' esaurito.
    for (const p of ['x', 'y']) {
      await assert.rejects(() => callLLM([{ role: 'user', content: p }], { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 }));
    }

    const errori = getStats().errors.join('\n');
    assert.ok(
      /skipped — exhausted \(non-retryable provider error \(ECONNREFUSED\)\)/.test(errori),
      `la causa del ban deve essere quella letta dal codice syscall: ${errori}`,
    );
    assert.ok(
      !/timeout circuit-breaker/.test(errori),
      'la causa del ban e\' rimasta «timeout» sotto il tag hostUnreachable: `timeout circuit-breaker` vota TRANSITORIO '
      + 'mentre la riga del fratello, per lo STESSO guasto, dice `unreachable (...), non-retryable` e vota persistente. '
      + `Il tally che sceglie fra differimento e Workflow Failure riceve due voti opposti (#848 item 1):\n${errori}`,
    );
    assert.ok(
      /unreachable \(ECONNREFUSED\), non-retryable/.test(errori),
      `la riga del fratello deve esserci, altrimenti il caso sopra non misura il confronto: ${errori}`,
    );
  });

  // #849 item 1. L'incremento era incondizionato, ma da #809 `cooldownProvider`
  // puo' essere un no-op completo (un 429 transitorio su una finestra
  // `persistent` gia' aperta esce senza toccare ne' finestra ne' causa). Il
  // riepilogo di run contava dial che non erano stati girati — e quel testo e'
  // cio' che `scan-generation-health` legge per giudicare la generazione.
  it('ogni _stats.providerCooldowns++ e\' guardato da `=== \'created\'`', () => {
    // Per RIGA, non con una finestra di byte. La finestra e' esattamente
    // l'ancoraggio che si sfalda appena il file si muove — e si e' gia'
    // sfaldata una volta, quando svuotare le righe di commento ha cambiato
    // tutti gli offset. Tutti e tre i call site portano la guardia sulla
    // stessa riga, quindi la riga E' l'unita' giusta.
    const righe = SRC_CODE.split('\n')
      .map((riga, i) => ({ n: i + 1, riga: riga.trim() }))
      .filter(({ riga }) => riga.includes('_stats.providerCooldowns++'));

    assert.ok(righe.length >= 3, `attesi almeno tre call site, trovati ${righe.length}`);
    assert.deepEqual(
      righe.filter(({ riga }) => !riga.includes("=== 'created'")).map(({ n, riga }) => `${n}: ${riga}`),
      [],
      'un `_stats.providerCooldowns++` non guardato da `=== \'created\'`: da #809 cooldownProvider puo\' essere '
      + 'un no-op completo (un 429 transitorio su una finestra gia\' aperta esce senza toccare ne\' finestra ne\' '
      + 'causa), e contarlo gonfia la riga che scan-generation-health legge per giudicare la generazione.',
    );
  });

  // #849 item 3. Il gate `severity < prevSeverity` esce senza toccare la
  // finestra perche' assume che una causa piu' grave abbia sempre una finestra
  // piu' lunga: vero oggi, ma niente nel codice lo impone. Una quarta causa con
  // gravita' alta e durata corta accorcerebbe la finestra in silenzio.
  it('la durata del cooldown e\' monotona nella gravita\'', () => {
    const tabella = _cooldownSeverityDurations();
    assert.ok(tabella.length >= 3, `tabella inattesa: ${JSON.stringify(tabella)}`);
    for (let i = 1; i < tabella.length; i++) {
      const prec = tabella[i - 1];
      const cur = tabella[i];
      assert.ok(
        cur.durationMs >= prec.durationMs,
        `«${cur.name}» e' piu' grave di «${prec.name}» ma dura meno (${cur.durationMs} < ${prec.durationMs}): `
        + 'cooldownProvider usa la gravita\' come proxy della durata residua, quindi il ramo demoted '
        + 'accorcerebbe la finestra in silenzio (#849 item 3)',
      );
    }
  });
});
