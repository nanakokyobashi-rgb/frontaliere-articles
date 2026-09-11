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
 * La misura strutturale e' quindi il punto 1: nel sorgente OGNI riferimento a
 * `_dirtyModels` sta in una funzione dichiarata, e la sola che lo PROPONGA e'
 * `_proposeLedgerWrite` (`_persistScoresToFirestore` rimette in coda cio' che
 * la rete ha respinto, e svuota la coda che sta per spedire: non e' una
 * proposta nuova). Nominare il Set e mutarlo sono due diritti separati, e i
 * lettori dell'allowlist hanno solo il primo — un writer nuovo non puo'
 * dimenticare la regola, perche' non ha un altro modo di scrivere. Il resto del file misura le due decisioni
 * che la porta prende — l'opt-out del chiamante e l'endpoint per-macchina — sui
 * percorsi che erano rimasti fuori.
 *
 * Il pin cercava la STRINGA `_dirtyModels.add(` (#1047): provava l'assenza di
 * una forma testuale, non l'unicita' della porta. Un alias, un `bind` o il Set
 * passato a una helper sono secondi ingressi REALI sul documento condiviso e
 * non contengono quella stringa — il gate restava verde su tutti e tre. L'unita'
 * di misura e' ora il riferimento all'identificatore, vincolato a un'allowlist
 * di funzioni; il meccanismo sta in `lib/identifier-scope.mjs`, dove puo' essere
 * alimentato con un sorgente sintetico che DEVE far rosso.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it, beforeEach, afterEach } from 'node:test';

import {
  callLLM,
  callSingleModel,
  discoverFreeModels,
  flushScores,
  __learnRequestTokenLimitForTests,
  __restoreScoreEntriesForTests,
  getDeclaredRequestTokenLimit,
  getStats,
  markModelExhausted,
  prunedStaleModels,
  recordModelContentFailure,
  recordModelFailure,
  recordModelSuccess,
  resetState,
  _cooldownSeverityDurations,
  _perMachineEndpointEnvVars,
  _restorableExhaustUntil,
  _exhaustSkipCause,
  _safeDiagnosticValue,
  __installScoreStoreForTests,
  EXHAUST_RESTORE_MAX_AHEAD_MS,
} from '../scripts/lib/ai-models.mjs';

import { describeOpaqueRead, scanEnvReads, stripCommentLines } from './lib/env-reads.mjs';
import { pinIdentifierToFunctions } from './lib/identifier-scope.mjs';

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
const SRC_CODE = stripCommentLines(SRC);

/**
 * Trova ogni chiamata a un metodo di un binding, compresi optional chaining e
 * chiavi statiche computed. `matchAll` e' intenzionale: piu' mutazioni sulla
 * stessa riga sono piu' ingressi, non una sola occorrenza da consumare con
 * `RegExp#exec`.
 */
function mutationMethods(text, identifier) {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `(?<![\\w$.])${escaped}(?:(?:\\?\\.|\\.)([A-Za-z_$][\\w$]*)|\\[\\s*(['"])([A-Za-z_$][\\w$]*)\\2\\s*\\])\\s*\\(`,
    'g',
  );
  return [...text.matchAll(re)].map((match) => match[1] ?? match[3]);
}

const ENV_KEYS = [
  'AI_MODELS_FORCE_CHAIN', 'AI_MODELS_PREFER', 'GH_MODELS_PAT',
  'OMNIROUTE_ENABLED', 'OMNIROUTE_URL', 'LOCAL_LLM_ENABLED', 'LOCAL_LLM_URL',
];

/**
 * Il nome di una variabile d'ambiente che porta un INDIRIZZO. Non il solo
 * suffisso `_URL`: un override per-macchina battezzato `*_ENDPOINT`, `*_HOST` o
 * `*_BASE` sarebbe lo STESSO fatto.
 */
const ENDPOINT_ENV_RE = /^[A-Z0-9_]*(?:URL|ENDPOINT|HOST|BASE)$/;

/**
 * Il verdetto del gate su un sorgente qualunque, cosi' che l'assert vero e i
 * casi negativi qui sotto attraversino lo STESSO codice: un osservatore che
 * misura una copia dell'assert non misura l'assert.
 */
function endpointGateViolations(code, dichiarati) {
  const { names, opaque } = scanEnvReads(code);
  const nelSorgente = [...names].filter((v) => ENDPOINT_ENV_RE.test(v));
  return {
    scoperti: nelSorgente.filter((v) => !dichiarati.has(v)),
    fantasmi: [...dichiarati].filter((v) => !names.has(v)),
    opachi: opaque,
  };
}

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
  // #1047. Il pin misurava la STRINGA `_dirtyModels.add(`, cioe' provava
  // l'assenza di una forma testuale e non l'unicita' della porta. Un alias
  // (`const d = _dirtyModels`), un `bind`, o il Set passato a una helper sono
  // secondi ingressi REALI sul documento condiviso e non contengono quella
  // stringa: il gate sarebbe rimasto verde su tutti e tre. L'unita' di misura
  // e' ora ogni RIFERIMENTO all'identificatore, vincolato a un'allowlist —
  // tutte e tre le forme devono nominarlo, quindi cadono tutte nella rete.
  const PORTE_DIRTY_MODELS = {
    functions: [
      // La porta.
      '_proposeLedgerWrite',
      // Il RECUPERO di una scrittura fallita, piu' la lettura della coda: non
      // e' una proposta nuova, e' la stessa gia' accettata dalla porta che
      // torna indietro perche' la rete l'ha respinta.
      '_persistScoresToFirestore',
      // Sola lettura: quanto resta in coda prima di uscire dal processo.
      'flushScoresBeforeExit',
      // Sola lettura: il riepilogo diagnostico.
      'getStats',
      // Lo svuotamento del reset.
      'resetState',
    ],
    // A livello di modulo l'unica riga ammessa e' la dichiarazione. Ammettere
    // il top-level in blocco riaprirebbe la porta dal lato piu' comodo: un
    // alias di modulo e' una riga sola e non sta dentro nessuna funzione.
    declaration: /^const _dirtyModels = new Set\(\);$/,
  };

  // Lo scope dice chi puo' NOMINARE il Set; da solo non dice chi puo'
  // SCRIVERLO. L'allowlist qui sopra contiene tre voci che sono sola lettura
  // (`flushScoresBeforeExit`, `getStats`, `resetState` per la parte che legge):
  // senza questo secondo vincolo un `_dirtyModels.add(id)` infilato in una di
  // loro sarebbe verde, ed e' esattamente il secondo ingresso sul documento
  // condiviso di #838/#845/#864/#874. Il pin PRE-#1047 lo faceva rosso perche'
  // filtrava per stringa; allargare la rete agli alias non deve costare la
  // forma. Stesso vincolo del gemello `_exhaust*` piu' sotto.
  const SCRITTORI_DIRTY_MODELS = {
    add: [
      '_proposeLedgerWrite',        // la porta
      '_persistScoresToFirestore',  // il RIMESSAGGIO in coda di una scrittura respinta dalla rete
    ],
    delete: [],
    clear: [
      '_persistScoresToFirestore',  // svuota la coda che sta per spedire
      'resetState',
    ],
  };
  it('ogni riferimento a `_dirtyModels` sta in una funzione dell\'allowlist (#1047)', () => {
    const { scoperti, fantasmi, riferimenti } = pinIdentifierToFunctions(SRC, '_dirtyModels', PORTE_DIRTY_MODELS);

    assert.deepEqual(
      scoperti,
      [],
      'qualcuno nomina _dirtyModels fuori dalla porta: e\' la forma di #838/#845/#864/#874, dove ogni difesa '
      + 'copriva un percorso solo. Non basta evitare `.add(` — un alias, un bind o il Set passato a una helper '
      + 'sono lo stesso secondo ingresso sul documento condiviso. Usa _proposeLedgerWrite(modelId, recordScore).',
    );
    // Un'allowlist che nomina funzioni sparite e' un pin che ha smesso di
    // misurare senza dirlo: il verde verrebbe dall'assenza del codice, non
    // dalla sua correttezza.
    assert.deepEqual(fantasmi, [], `l'allowlist nomina funzioni che non toccano piu' _dirtyModels: ${fantasmi.join(', ')}`);
    assert.ok(riferimenti.length >= 5, `il pin non trova piu' nemmeno la porta: ${riferimenti.length} riferimenti`);

    // La MUTAZIONE resta pinnata anche per FORMA: nominare il Set e scriverlo
    // sono due diritti diversi, e i lettori dell'allowlist hanno solo il primo.
    const scritture = riferimenti.flatMap((r) => mutationMethods(r.text, '_dirtyModels')
      .map((metodo) => ({ ...r, metodo })));
    assert.deepEqual(
      scritture
        .filter(({ metodo, fn }) => !SCRITTORI_DIRTY_MODELS[metodo]?.includes(fn))
        .map(({ line, text, fn }) => `${line}: ${text} [in ${fn}]`),
      [],
      'una mutazione di _dirtyModels fuori dai suoi scrittori: e\' un secondo ingresso sul documento condiviso '
      + 'dai due repo, la forma di #838/#845/#864/#874. Usa _proposeLedgerWrite(modelId, recordScore).',
    );
    assert.equal(
      scritture.length,
      4,
      `le mutazioni del Set devono restare quattro (add nella porta e nel rimessaggio, clear prima dello spedire e `
      + `nel reset), trovate ${scritture.length}: ${scritture.map((s) => `${s.line} [in ${s.fn}]`).join(', ')}`,
    );
    assert.deepEqual(
      scritture.map(({ metodo }) => metodo).sort(),
      ['add', 'add', 'clear', 'clear'],
      'il pin deve riconoscere tutte le mutazioni, non solo la prima per riga',
    );
  });

  // L'OSSERVATORE del pin qui sopra: un gate che nessuno ha mai visto dire di
  // no non e' una prova. Le tre forme sono quelle che erano verdi prima di
  // #1047, alimentate al pin come sorgente sintetico.
  it('il pin vede alias, bind e il Set passato a una helper (#1047)', () => {
    const pin = (code) => pinIdentifierToFunctions(code, '_dirtyModels', {
      functions: ['_proposeLedgerWrite'],
      declaration: /^const _dirtyModels = new Set\(\);$/,
    });
    const base = 'const _dirtyModels = new Set();\n'
      + 'function _proposeLedgerWrite(id) {\n  _dirtyModels.add(id);\n}\n';

    assert.equal(pin(base).scoperti.length, 0, 'il sorgente conforme deve passare');

    assert.deepEqual(
      pin(`${base}function scorciatoia(id) {\n  const d = _dirtyModels;\n  d.add(id);\n}\n`).scoperti,
      ['6: const d = _dirtyModels; [in scorciatoia]'],
      'un ALIAS del Set deve far rosso: `d.add(id)` scrive il documento condiviso quanto la porta',
    );
    assert.deepEqual(
      pin(`${base}function scorciatoia() {\n  return _dirtyModels.add.bind(_dirtyModels);\n}\n`).scoperti,
      ['6: return _dirtyModels.add.bind(_dirtyModels); [in scorciatoia]'],
      'un metodo BINDATO fuori dalla porta deve far rosso',
    );
    assert.deepEqual(
      pin(`${base}function scorciatoia(id) {\n  _dirtyModels?.add(id);\n}\n`).scoperti,
      ['6: _dirtyModels?.add(id); [in scorciatoia]'],
      'un accesso con optional chaining deve far rosso quanto la forma puntata',
    );
    assert.deepEqual(
      pin(`${base}function scorciatoia(id) {\n  _dirtyModels['add'](id);\n}\n`).scoperti,
      ["6: _dirtyModels['add'](id); [in scorciatoia]"],
      'un accesso computed statico deve far rosso quanto la forma puntata',
    );
    const formeMutazione = 'const _dirtyModels = new Set();\n'
      + 'function _proposeLedgerWrite(id) {\n'
      + '  _dirtyModels?.add(id); _dirtyModels["add"](id);\n'
      + '}\n';
    const formeRefs = pinIdentifierToFunctions(formeMutazione, '_dirtyModels', {
      functions: ['_proposeLedgerWrite'],
      declaration: /^const _dirtyModels = new Set\(\);$/,
    }).riferimenti;
    assert.deepEqual(
      formeRefs.flatMap((r) => mutationMethods(r.text, '_dirtyModels')),
      ['add', 'add'],
      'il contatore deve vedere due mutazioni sulla stessa riga, incluse optional e computed',
    );
    assert.deepEqual(
      pin(`${base}function scorciatoia(id) {\n  riempi([..._dirtyModels], id);\n}\n`).scoperti,
      ['6: riempi([..._dirtyModels], id); [in scorciatoia]'],
      'il Set passato a una helper deve far rosso: lo spread non e\' un accesso a proprieta\'',
    );
    assert.deepEqual(
      pin(`${base}const aggiungi = (id) => _dirtyModels.add(id);\n`).scoperti,
      ['5: const aggiungi = (id) => _dirtyModels.add(id); [in (top-level)]'],
      'a livello di modulo passa solo la dichiarazione, non una seconda porta scritta come arrow',
    );

    // Il caso che l'euristica «risali alla function dichiarata piu' sopra»
    // sbagliava: la riga sta DOPO la fine della porta, non dentro. Le veniva
    // attribuito `_proposeLedgerWrite` e il pin restava verde.
    assert.deepEqual(
      pin(`${base}globalThis.scrivi = (id) => _dirtyModels.add(id);\n`).scoperti,
      ['5: globalThis.scrivi = (id) => _dirtyModels.add(id); [in (top-level)]'],
      'una riga fuori da ogni funzione non deve ereditare il nome della funzione chiusa sopra di lei',
    );

    assert.deepEqual(
      pin('const _dirtyModels = new Set();\n').fantasmi,
      ['_proposeLedgerWrite'],
      'un\'allowlist che nomina una funzione sparita deve farsi notare, non passare per assenza di codice',
    );
  });

  it('il pin non conta le menzioni in prosa, e non inventa uno scope su un sorgente sbilanciato', () => {
    const conforme = 'const _dirtyModels = new Set();\n'
      + '// `_dirtyModels.add(id)` e\' la porta.\n'
      + '/**\n * Anche qui si parla di _dirtyModels.\n */\n'
      + 'function _proposeLedgerWrite(id) {\n  _dirtyModels.add(id);\n}\n';
    assert.deepEqual(
      pinIdentifierToFunctions(conforme, '_dirtyModels', {
        functions: ['_proposeLedgerWrite'],
        declaration: /^const _dirtyModels = new Set\(\);$/,
      }).scoperti,
      [],
      'una citazione in un commento non e\' un uso',
    );

    const inline = 'const _dirtyModels = new Set();\n'
      + 'function _proposeLedgerWrite(id) {\n'
      + '  _dirtyModels.add(id); // _dirtyModels.add("commento")\n'
      + '}\n';
    const inlinePin = pinIdentifierToFunctions(inline, '_dirtyModels', {
      functions: ['_proposeLedgerWrite'],
      declaration: /^const _dirtyModels = new Set\(\);$/,
    });
    assert.deepEqual(
      inlinePin.riferimenti.map(({ text }) => text),
      ['const _dirtyModels = new Set();', '_dirtyModels.add(id);'],
      'un commento inline non deve diventare una seconda mutazione sulla stessa riga',
    );

    assert.throws(
      () => pinIdentifierToFunctions('function f() {\n  _dirtyModels.add(1);\n', '_dirtyModels', {
        functions: [], declaration: /^$/,
      }),
      /sbilanciata/,
      'su un sorgente che il lettore non sa chiudere il pin deve lanciare, non rendere un\'attribuzione inventata',
    );
  });

  it('la tabella degli endpoint per-macchina copre ogni URL che il modulo legge da env (#874 item 3)', () => {
    // `_isPerMachineEndpoint` rispondeva «quale provider e'» mentre la proprieta'
    // che conta e' «l'indirizzo arriva dall'ambiente di QUESTA macchina», e il
    // commento chiedeva di allungare la lista a mano il giorno in cui un
    // provider a endpoint fisso avesse preso un override da env: una promessa
    // affidata alla memoria. Questo assert e' cio' che la sostituisce.
    // Non solo `*_URL`: un override per-macchina battezzato `*_ENDPOINT`,
    // `*_HOST` o `*_BASE` sarebbe lo STESSO fatto — l'indirizzo viene
    // dall'ambiente di questa macchina — e cercare il solo suffisso `_URL`
    // avrebbe lasciato la tabella corta col verde addosso, cioe' il modo di
    // fallire che questo assert esiste per chiudere. Oggi i quattro suffissi
    // rendono lo stesso insieme; e' quando smetteranno di renderlo che serve.
    const { scoperti, fantasmi } = endpointGateViolations(SRC_CODE, new Set(_perMachineEndpointEnvVars()));
    assert.deepEqual(
      scoperti,
      [],
      `questi endpoint sono configurabili da env ma non risultano per-macchina: ${scoperti.join(', ')}. `
      + 'Un verdetto su di essi finirebbe nel documento condiviso descrivendo una macchina sola (#838). '
      + 'Aggiungili a PER_MACHINE_ENDPOINT_ENV, o togli l\'override di URL.',
    );
    assert.deepEqual(fantasmi, [], `PER_MACHINE_ENDPOINT_ENV nomina variabili che il modulo non legge piu': ${fantasmi.join(', ')}`);
  });

  // #1046. La meta' che mancava: la scansione non deve TACERE su una lettura
  // che non sa risolvere. `process.env[cfg.urlEnv]` e' gia' una forma presente
  // nel modulo, e con la vecchia regex passava senza lasciare traccia — cioe'
  // la tabella poteva restare corta col test verde, dall'altra porta.
  it('nessuna lettura di process.env resta non risolta e non dichiarata', () => {
    const opachi = scanEnvReads(SRC_CODE).opaque;
    assert.deepEqual(
      opachi.map(describeOpaqueRead),
      [],
      'queste letture di process.env non sono risolvibili leggendo il sorgente, quindi la tabella '
      + 'PER_MACHINE_ENDPOINT_ENV non puo\' essere dimostrata completa. Rendi la chiave letterale, '
      + 'oppure annota la riga con `// env-scan: <motivo per cui non e\' un endpoint>`.',
    );
  });

  // L'OSSERVATORE dell'assert qui sopra: un gate che passa su un input che DEVE
  // far rosso non e' una prova. Queste tre forme erano tutte verdi prima di
  // #1046, e sono le stesse che il modulo puo' assumere domani.
  it('l\'assert vede la destrutturazione e la chiave letterale, e non tace sulla dinamica (#1046)', () => {
    const tabella = new Set(['LOCAL_LLM_URL']);
    const finto = (code) => endpointGateViolations(stripCommentLines(code), tabella);

    assert.deepEqual(
      finto('const { PIPPO_URL } = process.env;\nconst u = process.env.LOCAL_LLM_URL;\n').scoperti,
      ['PIPPO_URL'],
      'una destrutturazione di process.env lascia la tabella corta senza far rosso',
    );
    assert.deepEqual(
      finto('const u = process.env[\'PIPPO_URL\'] || process.env.LOCAL_LLM_URL;\n').scoperti,
      ['PIPPO_URL'],
      'un accesso indicizzato con letterale lascia la tabella corta senza far rosso',
    );
    // Anche la forma su piu' righe, che e' quella che una destrutturazione
    // lunga prende appena supera la larghezza della riga.
    assert.deepEqual(
      finto('const {\n  PIPPO_ENDPOINT,\n  ALTRO_HOST,\n} = process.env;\nprocess.env.LOCAL_LLM_URL;\n').scoperti,
      ['PIPPO_ENDPOINT', 'ALTRO_HOST'],
    );

    const dinamica = finto('const u = process.env[cfg.urlEnv];\nprocess.env.LOCAL_LLM_URL;\n');
    assert.equal(dinamica.opachi.length, 1, 'una chiave dinamica deve essere segnalata, non ignorata');
    assert.match(dinamica.opachi[0].form, /dinamica/);

    const alias = finto('const env = process.env;\nprocess.env.LOCAL_LLM_URL;\n');
    assert.equal(alias.opachi.length, 1, 'un alias dell\'intero process.env sfugge all\'enumerazione');

    const forwarding = finto([
      'const child = { ...process.env };',
      'const options = { env: process.env };',
      'const keys = Object.keys(process.env);',
      'const { env } = process;',
      'process.env.LOCAL_LLM_URL;',
    ].join('\n'));
    assert.equal(
      forwarding.opachi.length,
      4,
      'ogni forma di forwarding dell\'intero ambiente deve essere rumorosa, non passare in silenzio',
    );
    assert.deepEqual(forwarding.scoperti, [], 'il forwarding opaco non deve inventare un nome di endpoint');

    const typed = finto([
      'const { PIPPO_URL }: NodeJS.ProcessEnv = process.env;',
      'process.env.LOCAL_LLM_URL;',
    ].join('\n'));
    assert.deepEqual(
      typed.scoperti,
      ['PIPPO_URL'],
      'una destrutturazione tipizzata deve restare una lettura statica del nome',
    );
    assert.deepEqual(typed.opachi, [], 'il tipo fra `}` e `=` non deve trasformare la lettura in opaca');

    const trailing = stripCommentLines([
      'const real = process.env.LOCAL_LLM_URL; // process.env.PIPPO_URL',
      'const dynamic = process.env[cfg.urlEnv]; // process.env[OTHER_URL]',
      'const onlyComment = 1; // const { GHOST_URL } = process.env;',
    ].join('\n'));
    const trailingScan = scanEnvReads(trailing);
    assert.deepEqual([...trailingScan.names], ['LOCAL_LLM_URL'],
      'un nome citato solo nel commento in coda non deve diventare una lettura');
    assert.equal(trailingScan.opaque.length, 1,
      'il commento in coda non deve aggiungere una seconda lettura opaca');

    const markerInCode = scanEnvReads("const note = 'env-scan: documentazione';\nprocess.env[cfg.urlEnv];");
    assert.equal(markerInCode.opaque.length, 1,
      'env-scan dentro una stringa non deve esentare una lettura dinamica');

    // E l'esenzione esplicita spegne il rumore, ma solo con un motivo scritto.
    assert.deepEqual(
      finto('const u = process.env[cfg.urlEnv]; // env-scan: chiave da una tabella di provider\nprocess.env.LOCAL_LLM_URL;\n').opachi,
      [],
    );
    assert.equal(
      finto('const u = process.env[cfg.urlEnv]; // env-scan:\nprocess.env.LOCAL_LLM_URL;\n').opachi.length,
      1,
      'un\'esenzione senza motivo scritto non e\' un\'esenzione',
    );

    // E il verso opposto resta sorvegliato: una variabile dichiarata che il
    // sorgente non legge piu' e' un fantasma.
    assert.deepEqual(finto('const x = 1;\n').fantasmi, ['LOCAL_LLM_URL']);
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

  it('un 413 «Limit 4096» su omniroute non pubblica quel tetto per tutte le macchine', async () => {
    // Il danno: un runner con un Ollama servito a 8k pubblica quel cap sotto
    // l'id condiviso, e le altre macchine — il cui server accetterebbe il
    // prompt — iniziano a saltarlo come «troppo grande» via il pre-flight
    // guard, senza nessun errore da cui accorgersene.
    process.env.OMNIROUTE_ENABLED = '1';
    process.env.OMNIROUTE_URL = 'https://gateway.example.invalid/v1/chat/completions';
    process.env.AI_MODELS_FORCE_CHAIN = 'omniroute/auto';
    globalThis.fetch = async () => ({
      ok: false,
      // 413 e non 400: `classifyNonRetryableError(400, ...)` rende
      // `nonRetryable: false`, quindi il ramo che IMPARA il cap non viene
      // nemmeno raggiunto e il caso non misurerebbe #864.
      status: 413,
      headers: new Map(),
      text: async () => JSON.stringify({ error: { message: 'tokens_limit_reached. Limit 4096 tokens' } }),
      json: async () => ({ error: { message: 'tokens_limit_reached. Limit 4096 tokens' } }),
    });

    await assert.rejects(() => callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 }));

    assert.equal(
      getStats().dirtyModels,
      0,
      'il cap appreso da un endpoint per-macchina non deve essere proposto al documento condiviso (#864)',
    );
  });

  // La meta' che il gate NON deve spegnere. Con `recordScore:false` gatato
  // attorno alla chiamata, il cap non veniva appreso nemmeno in processo:
  // una run diagnostica ripagava il 400 «Request too large» per OGNI id
  // fratello, cioe' proprio il chiamante che la catena la percorre tutta.
  it('in opt-out il cap si impara lo stesso: e\' il ledger a essere spento, non la memoria di processo', async () => {
    process.env.GH_MODELS_PAT = 'test-pat';
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o-mini';
    globalThis.fetch = async () => ({
      ok: false,
      status: 413,
      headers: new Map(),
      text: async () => JSON.stringify({ error: { message: 'tokens_limit_reached. Limit 2048 tokens' } }),
      json: async () => ({ error: { message: 'tokens_limit_reached. Limit 2048 tokens' } }),
    });

    // 2048 e non 4096: `getDeclaredRequestTokenLimit` rende il MINIMO fra il cap
    // dichiarato staticamente per il modello (4000 per gpt-4o-mini) e quello
    // appreso, quindi un valore piu' alto del dichiarato resterebbe invisibile e
    // il caso non misurerebbe niente.
    const prima = getDeclaredRequestTokenLimit('gpt-4o-mini');
    await assert.rejects(() => callLLM([{ role: 'user', content: 'x' }], {
      maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000, recordScore: false,
    }));

    assert.equal(getStats().dirtyModels, 0, 'in opt-out il ledger non si tocca');
    assert.equal(
      getDeclaredRequestTokenLimit('gpt-4o-mini'),
      2048,
      `il cap deve essere noto IN PROCESSO anche in opt-out (era ${prima}), altrimenti ogni id fratello ripaga lo stesso 400 (#864)`,
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
    __learnRequestTokenLimitForTests('gpt-4o-mini', 'tokens_limit_reached. Limit 2048 tokens');
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

/**
 * ── #895 — LO STESSO MEMO NON PUO' RISPONDERE A DUE DOMANDE ────────────────
 *
 * Follow-up di #881. Le porte chiuse la' erano sul ledger; qui si chiude cio'
 * che restava della stessa forma: un memo che PRECEDE la porta (item 1) e una
 * coppia di stato con due writer (item 2).
 *
 * Onesta' sulla portata dell'item 1. Oggi ogni chiamata che impara un cap
 * passa subito dopo da `recordModelFailure` con lo STESSO `recordScore`,
 * quindi il modello diventa sporco per il fallimento e il cap — che il flush
 * legge da `_learnedRequestTokenLimits` per qualunque modello sporco — esce
 * comunque. La perdita descritta nella issue e' percio' mascherata da una
 * coincidenza fra due percorsi, non da un invariante: basta che il ramo del
 * fallimento venga gatato diversamente perche' il cap resti in processo per
 * sempre. Il caso qui sotto e' quindi un PIN sulla post-condizione («un cap
 * imparato in opt-out raggiunge il ledger alla prima chiamata che registra»),
 * non la riproduzione di un rosso: era rosso solo attraverso un percorso che
 * non e' quello di cui parla l'item.
 */
describe('#895 — il memo del cap appreso e la porta del ledger sono due cose diverse', () => {
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

  it('un cap imparato in opt-out arriva al ledger alla prima chiamata che registra', async () => {
    process.env.GH_MODELS_PAT = 'test-pat';
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o-mini';
    // 413 e non 401/402: `classifyNonRetryableError` rende `markExhausted:false`,
    // quindi il modello resta eleggibile e la SECONDA chiamata ripercorre il
    // ramo che impara — cioe' esattamente il punto che l'item descrive.
    globalThis.fetch = async () => ({
      ok: false,
      status: 413,
      headers: new Map(),
      text: async () => JSON.stringify({ error: { message: 'tokens_limit_reached. Limit 2048 tokens' } }),
      json: async () => ({ error: { message: 'tokens_limit_reached. Limit 2048 tokens' } }),
    });
    const opts = { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 };
    const store = makeStore();
    __installScoreStoreForTests(store.db, null);

    await assert.rejects(() => callLLM([{ role: 'user', content: 'x' }], { ...opts, recordScore: false }));
    await flushScores();
    assert.equal(
      store.last()?.models?.['gpt-4o-mini'],
      undefined,
      `in opt-out non deve uscire niente verso l'aggregato (#864): ${JSON.stringify(store.last())}`,
    );
    // 2048 e non 4096: `getDeclaredRequestTokenLimit` rende il MINIMO fra il cap
    // dichiarato staticamente (4000 per gpt-4o-mini) e quello appreso.
    assert.equal(getDeclaredRequestTokenLimit('gpt-4o-mini'), 2048, 'il cap deve essere noto IN PROCESSO anche in opt-out (#864)');

    // Stesso modello, STESSO limite, questa volta un chiamante di produzione:
    // e' la chiamata su cui la guardia di idempotenza del memo si chiudeva.
    await assert.rejects(() => callLLM([{ role: 'user', content: 'x' }], opts));
    await flushScores();
    assert.equal(
      store.last()?.models?.['gpt-4o-mini']?.maxRequestTokens,
      2048,
      `il cap doveva atterrare nel documento condiviso: ${JSON.stringify(store.last())}`,
    );
  });

  it('callSingleModel accompagna ogni cap imparato con recordModelFailure', async () => {
    process.env.GH_MODELS_PAT = 'test-pat';
    const model = 'gpt-4o-mini';
    globalThis.fetch = async () => ({
      ok: false,
      status: 413,
      headers: new Map(),
      text: async () => JSON.stringify({ error: { message: 'tokens_limit_reached. Limit 2048 tokens' } }),
      json: async () => ({ error: { message: 'tokens_limit_reached. Limit 2048 tokens' } }),
    });
    const store = makeStore();
    __installScoreStoreForTests(store.db, null);

    await assert.rejects(() => callSingleModel([{ role: 'user', content: 'x' }], {
      model,
      maxRetriesPerModel: 1,
      backoffMs: 1,
      timeout: 5000,
    }));
    await flushScores();

    const entry = store.last()?.models?.[model];
    assert.equal(entry?.maxRequestTokens, 2048, `il cap manca dal record: ${JSON.stringify(store.last())}`);
    assert.equal(entry?.failures, 1, `callSingleModel non ha registrato il fallimento compagno: ${JSON.stringify(entry)}`);
  });

  it('la sola ri-proposta di un cap non serializza un exhaustedUntil globale', async () => {
    const model = 'openrouter/cap-only-1214';
    const encoded = model.replace(/\//g, '__');
    const store = makeStore();
    __installScoreStoreForTests(store.db, null);

    // Il modello e' gia' esausto in-processo, ma questo ban arriva da un
    // chiamante che ha esplicitamente disattivato il ledger. La proposta che
    // segue riguarda solo il cap imparato e non puo' trasformare quel marchio
    // locale in un ban condiviso.
    markModelExhausted(model, 'quota', 'diagnostic-only', { recordScore: false });
    __learnRequestTokenLimitForTests(model, 'tokens_limit_reached. Limit 2048 tokens');
    await flushScores();

    const entry = store.last()?.models?.[encoded];
    assert.equal(entry?.maxRequestTokens, 2048, `il cap deve essere scritto: ${JSON.stringify(store.last())}`);
    assert.equal(
      Object.hasOwn(entry || {}, 'exhaustedUntil'),
      false,
      `la ri-proposta del solo cap ha pubblicato un ban globale: ${JSON.stringify(entry)}`,
    );
  });

  it('conserva la proposta quota arrivata durante una write cap-only', async () => {
    const model = 'openrouter/cap-quota-race-1214';
    const written = [];
    let releaseFirstWrite;
    let firstWriteStarted;
    const firstWrite = new Promise((resolve) => { firstWriteStarted = resolve; });
    const firstWriteReleased = new Promise((resolve) => { releaseFirstWrite = resolve; });
    const db = {
      collection: () => ({
        doc: () => ({
          set: async (data) => {
            written.push(data);
            if (written.length === 1) {
              firstWriteStarted();
              await firstWriteReleased;
            }
          },
          get: async () => ({ exists: false, data: () => null }),
        }),
      }),
    };

    __installScoreStoreForTests(db, null);
    __learnRequestTokenLimitForTests(model, 'tokens_limit_reached. Limit 2048 tokens');
    const inFlight = flushScores();
    await firstWrite;

    // This proposal happens after the cap-only payload was assembled but
    // before its network write lands. The next flush must carry the quota ban.
    markModelExhausted(model, 'quota', 'arrived-during-write');
    releaseFirstWrite();
    await inFlight;
    await flushScores();

    const firstEntry = written[0]?.models?.[model.replace(/\//g, '__')];
    const secondEntry = written[1]?.models?.[model.replace(/\//g, '__')];
    assert.equal(written.length, 2, `la proposta nuova deve restare sporca: ${JSON.stringify(written)}`);
    assert.equal(
      Object.hasOwn(firstEntry || {}, 'exhaustedUntil'),
      false,
      `la prima write deve restare cap-only: ${JSON.stringify(firstEntry)}`,
    );
    assert.equal(secondEntry?.maxRequestTokens, 2048, `il secondo giro deve conservare il cap: ${JSON.stringify(secondEntry)}`);
    assert.ok(
      typeof secondEntry?.exhaustedUntil === 'string' && !Number.isNaN(Date.parse(secondEntry.exhaustedUntil)),
      `la quota arrivata durante la write cap-only deve arrivare al giro successivo: ${JSON.stringify(secondEntry)}`,
    );
  });

  it('il secondo ciclo load/re-learn riusa la chiave canonica anche dopo resetState', async () => {
    const model = 'cerebras/meta/llama-3.1-8b-instruct-1214';
    const encoded = model.replace(/\//g, '__');
    const body = 'tokens_limit_reached. Limit 2048 tokens';
    const store = makeStore();

    __installScoreStoreForTests(store.db, null);
    __restoreScoreEntriesForTests({
      [encoded]: { modelId: encoded, maxRequestTokens: 2048 },
    });
    assert.equal(getDeclaredRequestTokenLimit(model), 2048, 'il primo load deve decodificare data.modelId');
    __learnRequestTokenLimitForTests(model, body);
    assert.equal(getStats().dirtyModels, 0, 'il primo re-learn dello stesso cap non deve sporcare il ledger');
    await flushScores();
    assert.equal(store.written.length, 0, 'nessuna riscrittura era necessaria dopo il primo load');

    resetState();
    __installScoreStoreForTests(store.db, null);
    // Secondo load: l'id canonico manca dal payload e deve arrivare dalla
    // decodifica della chiave del campo Firestore.
    __restoreScoreEntriesForTests({
      [encoded]: { maxRequestTokens: 2048 },
    });
    assert.equal(getDeclaredRequestTokenLimit(model), 2048, 'il secondo load deve decodificare la chiave del campo');
    __learnRequestTokenLimitForTests(model, body);
    assert.equal(getStats().dirtyModels, 0, 'il secondo re-learn non deve aprire una nuova proposta');
    await flushScores();
    assert.equal(store.written.length, 0, 'il secondo ciclo non deve riscrivere il cap invariato');
  });

  // Item 2. Gemello strutturale del pin su `_dirtyModels` in cima al file,
  // sull'ALTRA coppia di stato che aveva due writer: `_exhaustReason` /
  // `_exhaustDetail`. Il ramo `else` del breaker host-unreachable ne ricopiava a
  // mano gli interni — deliberatamente, per non emettere una seconda riga
  // `🚫 Model … marked as exhausted` che `exhaustion-reason-report.mjs` conta
  // con una regex globale — ma un campo aggiunto domani a `markModelExhausted`
  // non sarebbe sceso di la', e nessun test lo avrebbe notato.
  //
  // Anche qui (#1047) l'unita' di misura e' il RIFERIMENTO e non la stringa
  // `.set(`: `const r = _exhaustReason; r.set(id, 'quota')` e' lo stesso
  // secondo writer, e la vecchia forma non lo vedeva. L'allowlist include i
  // lettori perche' e' l'unico modo di pinnare anche l'alias — chi aggiunge una
  // lettura nuova allarga la lista, cioe' decide di guardare la coppia in
  // faccia invece di ereditarne una copia.
  //
  // Le due meta' della coppia hanno lettori diversi, e l'allowlist e' per
  // identificatore proprio per questo: una lista unica lascerebbe passare una
  // lettura di `_exhaustDetail` in una funzione che oggi tocca solo la causa.
  const PORTE_EXHAUST = {
    _exhaustReason: {
      functions: [
        '_setExhaustReason',         // la porta di scrittura
        '_persistScoresToFirestore', // legge la causa per decidere se persistere
        '_exhaustSkipCause',         // traduce la causa in parole
        '_shouldSkipExhausted',      // legge la causa per decidere la rotazione PAT
        'resetState',
      ],
      declaration: /^const _exhaustReason = new Map\(\);$/,
    },
    _exhaustDetail: {
      functions: ['_setExhaustReason', '_exhaustSkipCause', 'resetState'],
      declaration: /^const _exhaustDetail = new Map\(\);$/,
    },
  };

  // Nominare la coppia e mutarla sono due diritti diversi anche qui. In
  // particolare `delete` non e' una lettura: consentirlo a
  // `_shouldSkipExhausted` riaprirebbe il secondo writer che questo pin deve
  // impedire. `clear` resta confinato al reset, mentre entrambe le `.set` sono
  // della porta `_setExhaustReason`.
  const SCRITTORI_EXHAUST = {
    _exhaustReason: { set: ['_setExhaustReason'], delete: [], clear: ['resetState'] },
    _exhaustDetail: { set: ['_setExhaustReason'], delete: [], clear: ['resetState'] },
  };

  it('nel sorgente la CAUSA dell\'esaurimento si scrive solo dentro _setExhaustReason', () => {
    for (const [nome, porte] of Object.entries(PORTE_EXHAUST)) {
      const { scoperti, fantasmi, riferimenti } = pinIdentifierToFunctions(SRC, nome, porte);
      assert.deepEqual(
        scoperti,
        [],
        `la causa di un esaurimento passa da piu' di una porta (${nome}): e' la forma che #881 ha chiuso per `
        + '_dirtyModels (#895 item 2) e che #1047 ha smesso di misurare per stringa. Usa '
        + '_setExhaustReason(modelId, reason, detail).',
      );
      assert.deepEqual(fantasmi, [], `l'allowlist nomina funzioni che non toccano piu' ${nome}: ${fantasmi.join(', ')}`);
      assert.ok(riferimenti.length >= 3, `il pin non trova piu' nemmeno la porta di ${nome}: ${riferimenti.length}`);
    }

    // La scrittura vera e propria resta pinnata anche per FORMA: la porta e'
    // una, e tutte le mutazioni (`set`, `delete`, `clear`) devono rispettare
    // la tabella metodo→funzione, non solo le due `.set(` che esistono oggi.
    const scritture = Object.entries(SCRITTORI_EXHAUST).flatMap(([nome]) =>
      pinIdentifierToFunctions(SRC, nome, PORTE_EXHAUST[nome]).riferimenti.flatMap((r) =>
        mutationMethods(r.text, nome)
          .filter((metodo) => ['set', 'delete', 'clear'].includes(metodo))
          .map((metodo) => ({ ...r, nome, metodo }))));
    assert.deepEqual(
      scritture
        .filter(({ nome, metodo, fn }) => !SCRITTORI_EXHAUST[nome]?.[metodo]?.includes(fn))
        .map(({ line, text, fn }) => `${line}: ${text} [in ${fn}]`),
      [],
      'una mutazione sulla coppia della causa fuori dalla funzione autorizzata',
    );
    assert.deepEqual(
      scritture.map(({ nome, metodo, fn }) => `${nome}.${metodo}:${fn}`).sort(),
      [
        '_exhaustDetail.clear:resetState',
        '_exhaustDetail.set:_setExhaustReason',
        '_exhaustReason.clear:resetState',
        '_exhaustReason.set:_setExhaustReason',
      ],
      'la tabella deve contare ogni mutazione, anche clear, senza concedere delete ai lettori',
    );

    const lettore = 'const _exhaustReason = new Map();\n'
      + 'function _setExhaustReason(model, reason) {\n  _exhaustReason.set(model, reason);\n}\n'
      + 'function _shouldSkipExhausted(model) {\n  _exhaustReason.delete(model);\n}\n';
    const lettoreRefs = pinIdentifierToFunctions(lettore, '_exhaustReason', {
      functions: ['_setExhaustReason', '_shouldSkipExhausted'],
      declaration: /^const _exhaustReason = new Map\(\);$/,
    }).riferimenti;
    const violazioneLettore = lettoreRefs.flatMap((r) => mutationMethods(r.text, '_exhaustReason')
      .filter((metodo) => ['set', 'delete', 'clear'].includes(metodo))
      .map((metodo) => ({ ...r, metodo })))
      .filter(({ metodo, fn }) => !SCRITTORI_EXHAUST._exhaustReason[metodo]?.includes(fn));
    assert.deepEqual(
      violazioneLettore.map(({ text, fn }) => `${text} [in ${fn}]`),
      ['_exhaustReason.delete(model); [in _shouldSkipExhausted]'],
      'un delete dentro un lettore deve essere rosso, anche se il pin di scope lo conosce',
    );
  });

  it('resetState() non lascia in piedi il DETTAGLIO di una causa appena buttata via', async () => {
    // `_exhaustDetail` e' l'altra meta' della coppia scritta dalla porta:
    // sopravviveva al reset e si riattaccava al marchio successivo. La riga di
    // skip che ne esce finisce in `errors`, cioe' nel messaggio su cui
    // `classifyExhaustionCause` decide fra differimento e Workflow Failure.
    process.env.GH_MODELS_PAT = 'test-pat';
    process.env.AI_MODELS_FORCE_CHAIN = 'gpt-4o-mini';

    markModelExhausted('gpt-4o-mini', 'nonretryable', 'HTTP 402');
    resetState();
    markModelExhausted('gpt-4o-mini', 'nonretryable');
    const expectedCause = _exhaustSkipCause('gpt-4o-mini');

    await assert.rejects(
      () => callLLM([{ role: 'user', content: 'x' }], { maxRetriesPerModel: 1, backoffMs: 1, timeout: 5000 }),
      (e) => {
        const message = String(e.message);
        assert.ok(expectedCause, '_exhaustSkipCause() deve produrre una causa verificabile');
        assert.ok(
          message.includes(`skipped — exhausted (${expectedCause})`),
          `la causa prodotta da _exhaustSkipCause() non e\' arrivata al reject: ${message}`,
        );
        assert.ok(
          !message.includes('HTTP 402'),
          `dettaglio sopravvissuto al reset e riattaccato a un marchio nuovo: ${message}`,
        );
        return true;
      },
    );
  });
});

/**
 * ── UN BAN PERSISTITO NON PUO' ESSERE ASSORBENTE (#1045) ────────────────────
 *
 * `exhaustedUntil` vive nello stesso documento condiviso, e ha una asimmetria
 * che il resto del file non copre: lo scrive chiunque, ma lo AZZERA un solo
 * writer, e solo dietro un successo di QUEL modello in questo processo. Un
 * valore datato avanti nel futuro (clock skew di un runner, residuo di una
 * versione precedente) fa saltare il modello in pre-flight su ogni macchina
 * dei due repo — quindi nessun successo, quindi nessuno che possa azzerarlo.
 * Il tetto sul restore e' cio' che rompe il ciclo.
 */
describe('restore di exhaustedUntil: tetto sulla distanza nel futuro', () => {
  const now = new Date('2026-03-05T09:00:00.000Z');

  it('ripristina un ban a poche ore (mezzanotte UTC successiva: il caso legittimo)', () => {
    const until = new Date('2026-03-06T00:00:00.000Z');
    assert.deepEqual(_restorableExhaustUntil(until.toISOString(), now), {
      until,
      reason: 'restore',
    });
  });

  it('IGNORA un ban a 10 anni invece di ripristinarlo', () => {
    const until = new Date(now.getTime() + 10 * 365 * 24 * 3_600_000);
    const { reason } = _restorableExhaustUntil(until.toISOString(), now);
    assert.equal(
      reason,
      'too-far-ahead',
      'un exhaustedUntil oltre il tetto e\' assorbente: nessun writer resta capace di toglierlo',
    );
  });

  it('ignora un ban gia\' scaduto, come prima', () => {
    const until = new Date(now.getTime() - 3_600_000);
    assert.deepEqual(_restorableExhaustUntil(until.toISOString(), now), { until, reason: 'expired' });
  });

  it('il tetto sta appena sopra le 24h del writer, per il clock skew', () => {
    assert.ok(
      EXHAUST_RESTORE_MAX_AHEAD_MS > 24 * 3_600_000,
      'il writer scrive la mezzanotte UTC successiva: un tetto <= 24h scarterebbe ban legittimi',
    );
    assert.ok(EXHAUST_RESTORE_MAX_AHEAD_MS <= 48 * 3_600_000, 'un tetto largo giorni non e\' un tetto');
    // Al limite esatto si ripristina; un millisecondo oltre no.
    assert.equal(
      _restorableExhaustUntil(new Date(now.getTime() + EXHAUST_RESTORE_MAX_AHEAD_MS).toISOString(), now).reason,
      'restore',
    );
    assert.equal(
      _restorableExhaustUntil(new Date(now.getTime() + EXHAUST_RESTORE_MAX_AHEAD_MS + 1).toISOString(), now).reason,
      'too-far-ahead',
    );
  });

  it('accetta un Firestore Timestamp (toDate) come la stringa ISO', () => {
    const until = new Date(now.getTime() + 3_600_000);
    assert.equal(_restorableExhaustUntil({ toDate: () => until }, now).reason, 'restore');
  });

  it('accetta un Timestamp serializzato con secondi e nanosecondi', () => {
    const until = new Date(now.getTime() + 3_600_000 + 123);
    const serialized = {
      _seconds: Math.floor(until.getTime() / 1000),
      _nanoseconds: (until.getTime() % 1000) * 1_000_000,
    };
    assert.deepEqual(_restorableExhaustUntil(serialized, now), { until, reason: 'restore' });
  });

  it('un Timestamp con toDate() difettoso diventa unparsable senza lanciare', () => {
    assert.doesNotThrow(() => _restorableExhaustUntil({ toDate: () => { throw new Error('bad timestamp'); } }, now));
    assert.equal(_restorableExhaustUntil({ toDate: () => { throw new Error('bad timestamp'); } }, now).reason, 'unparsable');
  });

  it('la diagnostica non serializzabile non interrompe il ledger', () => {
    const cyclic = {};
    cyclic.self = cyclic;
    assert.doesNotThrow(() => _safeDiagnosticValue(cyclic));
    assert.match(_safeDiagnosticValue(cyclic), /\[object Object\]/);

    const hostile = {
      toJSON: () => { throw new Error('cannot stringify'); },
      toString: () => { throw new Error('cannot stringify'); },
    };
    assert.equal(_safeDiagnosticValue(hostile), '<non-serializzabile>');
  });

  it('un valore illeggibile o assente non ripristina niente', () => {
    assert.equal(_restorableExhaustUntil('non-una-data', now).reason, 'unparsable');
    assert.equal(_restorableExhaustUntil(null, now).reason, 'absent');
  });

  it('il restore di initScoreStore passa dall\'helper, non da un confronto in-line', () => {
    assert.ok(
      SRC_CODE.includes('_restorableExhaustUntil(data.exhaustedUntil, now)'),
      'il ramo di restore deve chiamare l\'helper: in-line non e\' esercitabile da nessun test',
    );
    assert.match(
      SRC_CODE,
      /_safeDiagnosticValue\(data\.exhaustedUntil\)/,
      'la diagnostica del valore persistito deve passare dalla serializzazione safe',
    );
    assert.equal(
      (SRC_CODE.match(/resetTime > now/g) || []).length,
      0,
      'un confronto `resetTime > now` senza tetto e\' esattamente il difetto di #1045',
    );
  });
});
