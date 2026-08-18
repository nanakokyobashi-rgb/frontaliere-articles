/**
 * score-ledger-persistence.test.mjs — il ledger dei punteggi perdeva i successi,
 * e niente lo faceva vedere.
 *
 * ## Il difetto, misurato il 2026-08-18
 *
 * Il documento condiviso `ai_model_scores/_all` (Firestore, progetto
 * `frontaliere-ticino`) e' la memoria che `sortChainByScore()` usa per decidere
 * quale modello viene provato per primo, ed e' scritto da OGNI workflow dei due
 * repo. Su `claude-cli/haiku` diceva `score -3, successes 0, failures 1`, cioe'
 * un solo fallimento in tutta la sua vita. La run 32134269129 (corpus,
 * 11:56:51→12:17:43Z) gli aveva applicato 4 successi e 4 fallimenti, portando il
 * punteggio in memoria a -207: nel ledger non e' arrivato NIENTE di quella run.
 *
 * Due meccanismi indipendenti la producevano, e questo file li copre entrambi.
 *
 * 1. **Il flush non era su nessun percorso di uscita riuscito.** Dentro
 *    `ai-models.mjs` l'unico `await flushScores()` sta sul ramo «tutti i modelli
 *    hanno fallito»; `create-article.mjs` importava `flushScores` alla riga 68 e
 *    non lo chiamava mai, con 12 `process.exit(...)` che saltano `beforeExit`.
 *    Il debounce da 30s vive su un timer `unref()`ato, quindi non tiene vivo il
 *    processo. Asimmetria netta: i fallimenti del ramo terminale arrivavano al
 *    ledger, i successi di una run riuscita no — un ledger pessimista per
 *    costruzione, che e' il peggior difetto possibile in un ordinatore di catena.
 *
 * 2. **I contatori erano scritti come valori ASSOLUTI.** `{merge: true}` protegge
 *    modelli diversi fra loro, non due processi che scrivono lo STESSO modello:
 *    entrambi caricano N, uno scrive N+4, l'altro riscrive N. Il secondo
 *    scrittore esiste davvero ed e' quotidiano — `smoke-test-ai-models.mjs` del
 *    sito fa un ping per modello di `DEFAULT_CHAIN` e, poiche' `callLLM()`
 *    auto-inizializza lo store al primo uso, i suoi esiti finiscono nello stesso
 *    documento del routing di produzione.
 *
 * ## Cosa asserisce
 *
 * La perdita e' riprodotta IN PROCESSO: due istanze del modulo (import con query
 * string diversa, quindi due stati di modulo distinti = due processi) contro un
 * unico documento finto con le semantiche vere di `set(..., {merge: true})` e del
 * sentinel `FieldValue.increment`. E' il solo modo di distinguere «il successo
 * non e' mai stato scritto» da «e' stato scritto e poi sovrascritto»: sul log di
 * produzione i due casi sono indistinguibili.
 *
 * Il finto Firestore non e' un mock del percorso di scrittura, e' un mock del
 * DATABASE: il codice sotto test esegue lo stesso `_persistScoresToFirestore()`
 * che gira in produzione. Serviva un seam (`__installScoreStoreForTests`) perche'
 * `initScoreStore()` in assenza di credenziale mette `_firestoreDb = null` ed
 * esce: un test senza seam passerebbe a vuoto sul percorso solo-memoria, che e'
 * esattamente la forma del bug che sta coprendo.
 *
 * ## Dove gira
 *
 * `npm test` del corpus (`node --test generator/tests/*.test.mjs`), quindi dentro
 * `tests.yml`, che dal 2026-08-18 gira anche sui push a `main` e non solo sulle PR.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(HERE, '..', 'scripts');
const AI_MODELS = join(SCRIPTS_DIR, 'lib', 'ai-models.mjs');

const HAIKU = 'claude-cli/haiku';
const ENC_HAIKU = 'claude-cli__haiku';

// ── Firestore finto ─────────────────────────────────────────────────────────
//
// Implementa le due semantiche da cui dipende la correzione, e nient'altro:
//   • `set(data, {merge:true})` fonde ricorsivamente le mappe (e' cosi' che il
//     campo `models` sopravvive a un writer che ne nomina una sola voce);
//   • il sentinel prodotto da `FieldValue.increment(n)` somma invece di
//     sostituire, ed e' applicato dal DOCUMENTO — cioe' lato server, che e' il
//     punto: e' quello a renderlo immune alla corsa fra due processi.

function makeFieldValue() {
  return { increment: (n) => ({ __increment: n }) };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function mergeInto(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(v) && typeof v.__increment === 'number') {
      target[k] = (typeof target[k] === 'number' ? target[k] : 0) + v.__increment;
    } else if (isPlainObject(v)) {
      if (!isPlainObject(target[k])) target[k] = {};
      mergeInto(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

/**
 * @param {object} [opts]
 * @param {number} [opts.delayMs] ritardo prima che la scrittura atterri
 * @param {number} [opts.failTimes] quante delle prime scritture devono fallire
 */
function makeFakeFirestore({ delayMs = 0, failTimes = 0 } = {}) {
  const store = new Map(); // "collection/doc" → data
  const state = { writes: 0, failuresLeft: failTimes, lastPayloads: [] };
  const api = {
    collection: (c) => ({
      doc: (d) => {
        const key = `${c}/${d}`;
        return {
          async get() {
            const data = store.get(key);
            return { exists: data !== undefined, data: () => data };
          },
          async set(data, opts = {}) {
            state.writes++;
            state.lastPayloads.push(JSON.parse(JSON.stringify(data)));
            if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
            if (state.failuresLeft > 0) {
              state.failuresLeft--;
              throw new Error('fake firestore: write rejected');
            }
            const base = opts.merge ? (store.get(key) || {}) : {};
            store.set(key, mergeInto(base, data));
          },
        };
      },
    }),
    _state: state,
    _seed(key, data) { store.set(key, data); },
    _model(id = ENC_HAIKU) { return store.get('ai_model_scores/_all')?.models?.[id]; },
  };
  return api;
}

function seedHaiku(db, { successes = 10, failures = 3, score = -3 } = {}) {
  db._seed('ai_model_scores/_all', {
    models: { [ENC_HAIKU]: { modelId: HAIKU, score, successes, failures } },
  });
}

// Due istanze del modulo = due processi. La query string cambia lo specifier, e
// il module registry di Node tiene due copie separate dello stato di modulo.
let instanceSeq = 0;
async function freshInstance() {
  return import(`../scripts/lib/ai-models.mjs?ledger-test=${instanceSeq++}`);
}

test('due run concorrenti sullo stesso modello: nessuna delle due perde i propri esiti', async () => {
  const db = makeFakeFirestore();
  const fv = makeFieldValue();
  seedHaiku(db, { successes: 10, failures: 3 });

  const runA = await freshInstance();
  const runB = await freshInstance();
  runA.__installScoreStoreForTests(db, fv);
  runB.__installScoreStoreForTests(db, fv);

  // A serve quattro volte; B, che gira in parallelo, incassa un fallimento.
  for (let i = 0; i < 4; i++) runA.recordModelSuccess(HAIKU);
  runB.recordModelFailure(HAIKU);

  await runA.flushScores();
  await runB.flushScores();

  const entry = db._model();
  assert.equal(entry.successes, 14,
    'i 4 successi di A devono sopravvivere alla scrittura di B — con una scrittura assoluta B rimetterebbe il proprio totale (0) e li cancellerebbe');
  assert.equal(entry.failures, 4, 'e il fallimento di B non deve perdersi a sua volta');

  runA.resetState();
  runB.resetState();
});

test('il delta si azzera dopo una scrittura riuscita: un secondo flush non raddoppia', async () => {
  const db = makeFakeFirestore();
  seedHaiku(db, { successes: 10, failures: 3 });
  const run = await freshInstance();
  run.__installScoreStoreForTests(db, makeFieldValue());

  run.recordModelSuccess(HAIKU);
  run.recordModelSuccess(HAIKU);
  await run.flushScores();
  assert.equal(db._model().successes, 12);

  run.recordModelFailure(HAIKU);
  await run.flushScores();
  assert.equal(db._model().successes, 12, "i due successi gia' scritti non vanno riapplicati");
  assert.equal(db._model().failures, 4);

  run.resetState();
});

test('una scrittura fallita restituisce il delta, e il flush successivo lo recupera intero', async () => {
  const db = makeFakeFirestore({ failTimes: 1 });
  seedHaiku(db, { successes: 10, failures: 3 });
  const run = await freshInstance();
  run.__installScoreStoreForTests(db, makeFieldValue());

  run.recordModelSuccess(HAIKU);
  run.recordModelSuccess(HAIKU);
  await run.flushScores();               // rifiutata
  assert.equal(db._model().successes, 10, 'la scrittura rifiutata non deve aver toccato il documento');

  await run.flushScores();               // ritentata
  assert.equal(db._model().successes, 12,
    'esattamente due, non zero (delta perso) e non quattro (delta riapplicato due volte)');

  run.resetState();
});

test('un modello sporco senza esiti non riscrive i contatori', async () => {
  // markModelExhausted() sporca il modello per aggiornare score/lastUsed e non
  // tocca i contatori. Con la scrittura assoluta quel percorso rimetteva il
  // totale locale — tipicamente 0 — sopra il valore di un altro processo: un
  // ledger azzerato da un evento che non e' nemmeno una chiamata.
  const db = makeFakeFirestore();
  seedHaiku(db, { successes: 10, failures: 3 });
  const run = await freshInstance();
  run.__installScoreStoreForTests(db, makeFieldValue());

  run.markModelExhausted(HAIKU, 'stale');
  await run.flushScores();

  assert.equal(db._model().successes, 10, 'nessun esito da registrare ⇒ contatore intatto');
  assert.equal(db._model().failures, 3);
  const payload = db._state.lastPayloads.at(-1).models[ENC_HAIKU];
  assert.ok(!('successes' in payload), 'il campo non va proprio scritto, non scritto a zero');
  assert.ok(!('failures' in payload));

  run.resetState();
});

test('flushScoresBeforeExit attende davvero la scrittura invece di lanciarla e uscire', async () => {
  const db = makeFakeFirestore({ delayMs: 40 });
  const run = await freshInstance();
  run.__installScoreStoreForTests(db, makeFieldValue());

  run.recordModelSuccess(HAIKU);
  const ok = await run.flushScoresBeforeExit();

  assert.equal(ok, true);
  assert.equal(db._model().successes, 1,
    'al ritorno la scrittura deve essere ATTERRATA: _persistScoresToFirestore svuota _dirtyModels prima di await, quindi un fire-and-forget seguito da process.exit perde il dato E lo marca pulito');
  assert.equal(run.getStats().dirtyModels, 0);

  run.resetState();
});

test('flushScoresBeforeExit non appende un\'uscita quando Firestore non risponde', async () => {
  const db = makeFakeFirestore({ delayMs: 300 });
  const run = await freshInstance();
  run.__installScoreStoreForTests(db, makeFieldValue());

  run.recordModelSuccess(HAIKU);
  const started = Date.now();
  const ok = await run.flushScoresBeforeExit(30);
  const elapsed = Date.now() - started;

  assert.equal(ok, false, 'deve dichiarare di aver rinunciato, non fingere di aver scritto');
  assert.ok(elapsed < 250, `l'uscita non puo' restare appesa al ledger (attesa ${elapsed}ms)`);

  run.resetState();
});

test('il riepilogo di fine run nomina i modelli chiamati in QUESTA run', async () => {
  const run = await freshInstance();
  run.resetState();
  for (let i = 0; i < 4; i++) run.recordModelSuccess(HAIKU);
  run.recordModelFailure(HAIKU);
  run.recordModelSuccess('nvidia/meta/llama-3.1-8b-instruct');

  const printed = [];
  const orig = console.log;
  console.log = (...a) => printed.push(a.join(' '));
  try { run.printRunSummary(); } finally { console.log = orig; }

  const out = printed.join('\n');
  const modelsLine = out.split('\n').find((l) => l.includes('models:'));
  assert.ok(modelsLine, 'il riepilogo deve avere una riga `models:` grep-abile');
  assert.match(modelsLine, /claude-cli\/haiku 4ok\/1ko/);
  assert.match(modelsLine, /nvidia\/meta\/llama-3\.1-8b-instruct 1ok\/0ko/);
  assert.match(modelsLine, /ledger=(firestore|memory) pending=\d+/);

  // La riga `last-resort:` non cambia forma: altri test ci fanno match di
  // sottostringa, e la riga nuova le sta SOTTO invece di alterarla.
  const lrIdx = out.indexOf('   last-resort: ');
  assert.ok(lrIdx >= 0, 'la riga last-resort deve restare, con lo stesso rientro');
  assert.ok(out.indexOf('   models: ') > lrIdx, 'la riga nuova va dopo, non al posto di quella');
  assert.match(out, /last-resort: omniroute\/local\/claude-cli not reached this run/);

  run.resetState();
});

test('la riga `models:` e\' il delta della run, non una ristampa del ledger', async () => {
  // `_modelScores` viene precaricato da Firestore all'avvio (270 voci il
  // 2026-08-18): una riga costruita da li' descriverebbe il ledger e non la run.
  // Qui il modello sporcato senza chiamate non deve comparire.
  const run = await freshInstance();
  run.resetState();
  run.recordModelSuccess(HAIKU);
  run.markModelExhausted('groq/llama-3.3-70b-versatile', 'stale');

  const outcomes = run.getRunOutcomes();
  assert.deepEqual(outcomes.map((o) => o.model), [HAIKU]);

  run.resetState();
});

test('chi importa il flush lo chiama: nessun altro entrypoint puo\' rifare il difetto', async () => {
  // Il difetto originale in una riga: `create-article.mjs` importava
  // `flushScores` e non lo invocava mai. Un import inerte non fa fallire niente,
  // quindi serve un guard esplicito.
  const offenders = [];
  // Anche `generator/scripts/lib/`: sul gemello del sito e' proprio da una
  // sottocartella che `shared-jobs-crawler.mjs` importa il flush, quindi una
  // scansione del solo livello superiore avrebbe un punto cieco.
  const files = [SCRIPTS_DIR, join(SCRIPTS_DIR, 'lib')].flatMap((dir) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
      .map((e) => join(dir, e.name)));

  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const imported = /import\s*\{[^}]*\bflush(Scores|ScoresBeforeExit)\b[^}]*\}\s*from\s*['"][^'"]*ai-models\.mjs['"]/.test(src);
    if (!imported) continue;
    const called = /\bflushScores(BeforeExit)?\s*\(/.test(src.replace(/import\s*\{[^}]*\}\s*from[^\n]*\n/g, ''));
    if (!called) offenders.push(file.slice(SCRIPTS_DIR.length + 1));
  }

  assert.deepEqual(offenders, [],
    `questi file importano il flush del ledger senza chiamarlo mai: ${offenders.join(', ')}`);
});

test('ai-models.mjs non riprende a scrivere i contatori come valori assoluti', async () => {
  // Guard di forma sul solo punto che costruisce il payload: un ritorno a
  // `successes: details.successes` sarebbe invisibile ai test funzionali qui
  // sopra solo se qualcuno rimuovesse anche il seam, ma e' una riga sola e vale
  // ancorarla — il difetto e' costato un ledger intero.
  const src = readFileSync(AI_MODELS, 'utf8');
  const persistBody = src.slice(src.indexOf('async function _persistScoresToFirestore'));
  const head = persistBody.slice(0, persistBody.indexOf('\n}\n'));
  assert.match(head, /_firestoreFieldValue\.increment\(counterDelta\.successes\)/);
  assert.match(head, /_firestoreFieldValue\.increment\(counterDelta\.failures\)/);

  // E la riga `last-resort:` continua a dire "N served/N failed": nessun test
  // qui puo' raggiungerla (il tier si attiva solo da callLLM), ma e' la forma
  // che altri test cercano per sottostringa.
  const tierFn = src.slice(src.indexOf('function _formatLastResortTier'));
  assert.match(tierFn.slice(0, 600), /\$\{t\.served\} served`, `\$\{t\.failed\} failed/);
});
