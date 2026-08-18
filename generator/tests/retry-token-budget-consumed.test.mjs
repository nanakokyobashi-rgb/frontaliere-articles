/**
 * ── IL NUMERO CHE LA LIBRERIA CALCOLAVA E NESSUNO LEGGEVA ───────────────────
 *
 * Quando ogni modello della flotta rifiuta il prompt per DIMENSIONE, `callLLM`
 * non si limita a fallire: allega all'errore il cap piu' permissivo fra quelli
 * che hanno detto no (`err.retryRequestTokenBudget`), il rapporto completo
 * (`err.inputCapReport`) e, nel messaggio, la frase
 *
 *     «A retry must rebuild the prompt under N tokens
 *      — resending the same messages cannot succeed»
 *
 * Era vero alla lettera. Fino al 2026-08-15 il `catch` del ciclo di generazione
 * faceva `continue` e basta: i tentativi 2→6 rispedivano messaggi identici che
 * la libreria aveva gia' dimostrato non poter riuscire. Misurato sulla run
 * 31833016113: **28,8 minuti** e due sezioni per arrivare a una conclusione
 * nota al primo tentativo, con 41 modelli su ~104 saltati dal pre-flight.
 *
 * ── PERCHE' IL BLOCCO VIENE ESTRATTO ED ESEGUITO ────────────────────────────
 *
 * `generateAndValidateArticle` non e' esportata e importarla tirerebbe dentro
 * l'intero albero del generatore (jsdom, sharp, …) che questo repo non ha in
 * node_modules. Un test che facesse `grep` sul sorgente proverebbe che il
 * codice *contiene* certe parole, non che il numero *arriva* dove serve — ed e'
 * esattamente la distinzione che questo difetto ha vissuto per mesi: la frase
 * giusta era scritta, nessuno la leggeva.
 *
 * Quindi qui il ramo `catch` viene ritagliato dal file che gira e ESEGUITO, con
 * un errore finto della forma che `callLLM` produce davvero. Stessa tecnica di
 * `news-prompt-token-budget.test.mjs`. Se le ancore scivolano, il ritaglio
 * fallisce rumorosamente invece di misurare una stringa vuota.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Issue #452 — le tre dipendenze che il ramo `catch` ha preso quando ha
// imparato a USCIRE invece di macinare. Sono importate davvero, non riscritte:
// il modulo della disposizione e' importabile (e' tutta la ragione per cui
// esiste), quindi il ritaglio esegue la funzione vera.
import {
  PROMPT_SCAFFOLD_FLOOR_TOKENS,
  isBudgetBelowScaffoldFloor,
  promptFloorSummary,
  isPromptFloorIrreducible,
} from '../scripts/lib/exhaustion-disposition.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.resolve(HERE, '../scripts/create-article.mjs'), 'utf-8');

/** Ritaglia fra due ancore, fallendo forte se una non c'e' piu'. */
function cut(startAnchor, endAnchor) {
  const a = SRC.indexOf(startAnchor);
  assert.notEqual(a, -1, `ancora iniziale non trovata — aggiornare questo test: ${startAnchor}`);
  const b = SRC.indexOf(endAnchor, a + startAnchor.length);
  assert.notEqual(b, -1, `ancora finale non trovata — aggiornare questo test: ${endAnchor}`);
  const blocco = SRC.slice(a, b);
  assert.ok(blocco.length > 200, `ritaglio troppo corto (${blocco.length}): ancore sbagliate`);
  return blocco;
}

/**
 * Il ramo `catch` del ciclo di generazione, verbatim, reso invocabile.
 * Riceve l'errore e il budget accumulato, restituisce il budget aggiornato.
 */
const CATCH_START = '      const budgetDettato = Number(e?.retryRequestTokenBudget) > 0';
const CATCH_END = '      if (attempt < maxAttempts) continue;';
const catchBlock = cut(CATCH_START, CATCH_END);

const silenzioso = { error() {}, warn() {}, log() {} };

/**
 * Le dipendenze che il ramo `catch` legge dal suo scope e che qui vanno
 * iniettate. `attempt`/`maxAttempts`/`SECTION_NAME`/`RUN_REPORT` sono lo scope
 * del ciclo; le altre tre arrivano da lib/exhaustion-disposition.mjs e sono
 * importate davvero (issue #452), non riscritte a mano — una copia direbbe che
 * la copia funziona.
 */
const DEPS = [
  'isBudgetBelowScaffoldFloor', 'PROMPT_SCAFFOLD_FLOOR_TOKENS', 'promptFloorSummary',
  'SECTION_NAME', 'attempt', 'maxAttempts', 'RUN_REPORT',
];

const applicaCatchGrezzo = new Function(
  'e',
  'lastPromptTokenBudget',
  'console',
  '__d',
  `const { ${DEPS.join(', ')} } = __d;\n${catchBlock}\nreturn lastPromptTokenBudget;`,
);

/**
 * Invoca il ramo verbatim. `deps` sovrascrive lo scope del ciclo (tentativo
 * corrente, tetto dei tentativi) per i casi che ne dipendono.
 */
function applicaCatch(e, lastPromptTokenBudget, cons = silenzioso, deps = {}) {
  return applicaCatchGrezzo(e, lastPromptTokenBudget, cons, {
    isBudgetBelowScaffoldFloor,
    PROMPT_SCAFFOLD_FLOOR_TOKENS,
    promptFloorSummary,
    SECTION_NAME: 'frontaliere',
    attempt: 2,
    maxAttempts: 6,
    RUN_REPORT: { notes: [] },
    ...deps,
  });
}

/** Un errore della forma che callLLM produce davvero su ALL_MODELS_EXHAUSTED. */
function erroreFlotta(budget, { count = 41, est = 9740 } = {}) {
  const e = new Error(
    `All AI models failed. Chain: [...]. | Prompt budget: ${count} model(s) refused a ~${est}-token `
    + `request; the most permissive cap among them is ${budget} tokens. A retry must rebuild the `
    + `prompt under ${budget} tokens — resending the same messages cannot succeed.`,
  );
  e.code = 'ALL_MODELS_EXHAUSTED';
  e.retryRequestTokenBudget = budget;
  e.maxSkippedReqLimit = budget;
  e.estimatedRequestTokens = est;
  e.inputCapReport = { count, maxSkippedReqLimit: budget, minSkippedReqLimit: 3000, estimatedRequestTokens: est };
  return e;
}

describe('il budget dettato dalla flotta viene consumato, non ignorato', () => {
  it('un errore con retryRequestTokenBudget lo imposta', () => {
    const out = applicaCatch(erroreFlotta(8000), 0, silenzioso);
    assert.equal(out, 8000, 'il budget non e\' stato letto dall\'errore');
  });

  it('si STRINGE fra un tentativo e l\'altro, non si allenta', () => {
    // La flotta disponibile cambia mentre i modelli si esauriscono: se il
    // secondo rifiuto dichiara un cap piu' basso, e' quello che vale. Allentare
    // vanificherebbe la riduzione gia' decisa e rimetterebbe il prompt fuori.
    //
    // I tre valori stanno tutti SOPRA il pavimento dell'impalcatura (issue
    // #452): la monotonia e' una proprieta' del `Math.min` e va misurata dove
    // il ciclo prosegue davvero. Il caso sotto il pavimento non prosegue piu'
    // — ha il suo test qui sotto — e usarlo qui misurerebbe due cose insieme.
    const dopoPrimo = applicaCatch(erroreFlotta(8000), 0, silenzioso);
    const dopoSecondo = applicaCatch(erroreFlotta(6000), dopoPrimo, silenzioso);
    assert.equal(dopoSecondo, 6000, 'un cap piu\' stretto deve vincere');
    const dopoTerzo = applicaCatch(erroreFlotta(8000), dopoSecondo, silenzioso);
    assert.equal(dopoTerzo, 6000, 'un cap piu\' largo NON deve allentare quello gia\' stretto');
  });

  it('un errore che non porta il budget lascia le cose come stanno', () => {
    // La stragrande maggioranza dei fallimenti non e' di dimensione (timeout,
    // JSON malformato, quota). Nessuno di quelli deve accorciare il prompt.
    const e = new Error('claude CLI timed out after 120000ms');
    assert.equal(applicaCatch(e, 0, silenzioso), 0, 'un timeout non deve dettare un budget');
    assert.equal(applicaCatch(e, 7000, silenzioso), 7000, 'un timeout non deve toccare il budget gia\' dettato');
  });

  it('valori non validi vengono ignorati invece di azzerare il prompt', () => {
    // Il budget di partenza sta SOPRA il pavimento dell'impalcatura: sotto, il
    // ramo esce prima (issue #452) e questo test misurerebbe l'uscita invece
    // dei valori non validi.
    for (const valore of [0, -1, NaN, 'ottomila', null, undefined]) {
      const e = new Error('x');
      e.retryRequestTokenBudget = valore;
      assert.equal(
        applicaCatch(e, 8000, silenzioso), 8000,
        `retryRequestTokenBudget=${String(valore)} non deve cambiare il budget`,
      );
    }
  });

  it('dice a voce che sta ricostruendo, non ripetendo', () => {
    // Il difetto era invisibile nei log: sei tentativi identici e nessuna riga
    // che dicesse perche'. La riga e' parte del rimedio.
    const righe = [];
    applicaCatch(erroreFlotta(8000), 0, { error: (m) => righe.push(String(m)), warn() {}, log() {} });
    const riga = righe.find((r) => r.includes('8000'));
    assert.ok(riga, `nessuna riga nomina il budget: ${JSON.stringify(righe)}`);
    assert.ok(/41 modelli/.test(riga), 'la riga non dice quanti modelli hanno rifiutato');
  });
});

/**
 * ── L'USCITA ANTICIPATA, ESEGUITA (issue #452) ──────────────────────────────
 *
 * Questo blocco vive QUI e non in un file suo perche' l'harness sopra ritaglia
 * il ramo `catch` VERO da create-article.mjs e lo esegue: e' l'unico posto del
 * corpus dove la decisione di uscire si puo' osservare come comportamento
 * invece che come testo. Le asserzioni sull'ORDINE dei blocchi — che sono
 * l'altra meta' della guardia, e che il testo e' l'unico modo di provare —
 * stanno in `prompt-floor-early-exit.test.mjs`.
 *
 * Il difetto misurato: 2510s mediani per una run `failure` contro 254s per una
 * `success` (926 run, 2026-08-13 → 18). Il `Math.min` monotono qui sopra e' la
 * meta' giusta di un assorbente: una volta che il budget scende sotto il
 * pavimento non risale mai, e ogni tentativo restante e' insoddisfacibile per
 * costruzione. Ne macinava fino a sei, fino al kill di durata.
 */
describe('sotto il pavimento dell\'impalcatura il ciclo ESCE, non ritenta', () => {
  /** Esegue il ramo e restituisce l'errore lanciato, o `null` se prosegue. */
  function lancio(e, budgetAccumulato, deps = {}) {
    try {
      applicaCatch(e, budgetAccumulato, silenzioso, deps);
      return null;
    } catch (uscito) {
      return uscito;
    }
  }

  it('un budget SOPRA il pavimento lascia proseguire (comportamento invariato)', () => {
    // La riga che protegge dall'uscita gratuita: 8000 e' il caso quotidiano, e
    // deve continuare a ritentare come ha sempre fatto.
    assert.equal(lancio(erroreFlotta(8000), 0), null);
    assert.equal(lancio(erroreFlotta(PROMPT_SCAFFOLD_FLOOR_TOKENS), 0), null, 'il pavimento esatto e\' un gradino stretto, non impossibile');
  });

  it('un budget SOTTO il pavimento rilancia l\'errore invece di ritentare', () => {
    const uscito = lancio(erroreFlotta(4000), 0);
    assert.ok(uscito, 'il ramo deve lanciare: proseguire spende cinque tentativi su un esito gia\' noto');
    assert.equal(uscito.code, 'ALL_MODELS_EXHAUSTED', 'va rilanciato l\'errore ORIGINALE, non uno nuovo che perde il contesto');
  });

  it('l\'errore rilanciato porta la ragione, e il catch di primo livello la riconosce', () => {
    const uscito = lancio(erroreFlotta(4000), 0, { attempt: 2, maxAttempts: 6, SECTION_NAME: 'svizzera' });
    // La marcatura e' cio' che rende la ragione DICHIARATA invece che dedotta.
    assert.deepEqual(uscito.promptFloorReport, {
      budget: 4000, floor: PROMPT_SCAFFOLD_FLOOR_TOKENS, attempt: 2, maxAttempts: 6, section: 'svizzera',
    });
    // E l'anello successivo la legge: senza questo, la marcatura sarebbe una
    // proprieta' che nessuno guarda — cioe' esattamente `unsat=1` prima di #452.
    assert.equal(isPromptFloorIrreducible(uscito), true);
    assert.equal(promptFloorSummary(uscito).attemptsSkipped, 4, 'i quattro tentativi che non si spendono piu\'');
  });

  it('esce anche quando il budget sotto il pavimento e\' quello ACCUMULATO, non quello dell\'errore', () => {
    // E' la forma esatta dell'assorbente. Il tentativo 3 fallisce senza dettare
    // niente (una quota, un timeout), ma il tentativo 2 aveva gia' dettato 4000
    // e il `Math.min` non lo riallarga: la condizione e' ancora vera, e uscire
    // qui e' cio' che distingue questa fix da un controllo sul solo errore.
    const senzaBudget = new Error('daily limit reached');
    senzaBudget.code = 'ALL_MODELS_EXHAUSTED';
    const uscito = lancio(senzaBudget, 4000, { attempt: 3, maxAttempts: 6 });
    assert.ok(uscito, 'un budget accumulato sotto il pavimento resta insoddisfacibile');
    assert.equal(uscito.promptFloorReport.budget, 4000);
    assert.equal(promptFloorSummary(uscito).attemptsSkipped, 3);
  });

  it('la riga machine-readable dice il numero azionabile, non solo la prosa', () => {
    const righe = [];
    try {
      applicaCatch(erroreFlotta(3000), 0, { error: (m) => righe.push(String(m)), warn() {}, log() {} }, { attempt: 1, maxAttempts: 6 });
    } catch { /* atteso */ }
    const marker = righe.find((r) => r.includes('[prompt-floor]'));
    assert.ok(marker, `nessun marker [prompt-floor]: ${JSON.stringify(righe)}`);
    // I campi che un watchdog leggera'. Il testo attorno puo' cambiare; questi no.
    for (const campo of ['budget=3000', 'floor=5850', 'short=2850', 'skipped=5', 'attempt=1/6']) {
      assert.ok(marker.includes(campo), `il marker non pubblica ${campo}: ${marker}`);
    }
  });
});

describe('il budget arriva fino al prompt', () => {
  it('genContext lo passa a callGemini', () => {
    // Il ritaglio sopra prova che il numero viene LETTO; questo prova che viene
    // PASSATO. Sono due difetti diversi e il primo senza il secondo non serve.
    const genContext = cut('    const genContext = {', '\n    };');
    assert.ok(
      /_promptTokenBudget:\s*lastPromptTokenBudget/.test(genContext),
      'genContext non inoltra il budget: callGemini continuerebbe a usare il default',
    );
  });

  it('callGemini lo usa come target della scala di riduzione', () => {
    const target = cut('  const _promptTokenTarget =', '\n  const PROMPT_SOURCE_FLOOR_CHARS');
    assert.ok(
      /sourceContext\?\._promptTokenBudget/.test(target),
      'il target non legge _promptTokenBudget dal contesto',
    );
    assert.ok(
      /PROMPT_TOKEN_BUDGET/.test(target),
      'manca il fallback al cap dichiarato dalla flotta quando il contesto non porta nulla',
    );
  });
});
