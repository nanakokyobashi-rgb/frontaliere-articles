/**
 * ── L'OSSERVATORE DELL'USCITA ANTICIPATA (issue #452) ───────────────────────
 *
 * IL DIFETTO, MISURATO. Finestra 2026-08-13 → 18, workflow
 * `generate-article.yml`, 926 run: una run `failure` dura **2510s mediani**
 * contro i **254s** di una `success`. La differenza non e' la latenza delle
 * chiamate: e' macinamento DOPO che l'esito era gia' deciso.
 *
 * La forma esatta. `callLLM` allega all'errore `retryRequestTokenBudget`, cioe'
 * il cap piu' permissivo fra i modelli che hanno rifiutato sulla TAGLIA. Il
 * ciclo di retry lo applica con un `Math.min` deliberatamente MONOTONO — e
 * quella scelta e' giusta, allentarlo vanificherebbe la riduzione gia' decisa.
 * Ma sotto PROMPT_SCAFFOLD_FLOOR_TOKENS il bersaglio sta sotto il peso del
 * prompt VUOTO, quindi nessuna riduzione ci rientra. Le due cose insieme fanno
 * un assorbente: basta UN tentativo che detti un budget sotto il pavimento
 * perche' tutti i restanti siano insoddisfacibili per costruzione. La sezione
 * ne macinava fino a sei, fino a `hard-killed after ~1180s` (exit 124), e il
 * marker `[prompt-budget] … unsat=1` lo dichiarava a ogni giro senza che
 * nessuno lo leggesse: l'unica azione era un `console.warn`.
 *
 * QUESTO FILE PROVA LE DUE META', in due modi diversi perche' vivono in due
 * posti con proprieta' diverse:
 *
 *   1. la DECISIONE (`lib/exhaustion-disposition.mjs`) — ESEGUITA davvero, sui
 *      numeri della run 31833016113 e sul confine esatto del pavimento;
 *   2. il CABLAGGIO in `create-article.mjs` — letto come TESTO, perche' quel
 *      file non e' importabile da un test (761 KB, e la prima cosa che fa e'
 *      una chiamata di rete). E' la stessa ragione per cui il modulo della
 *      disposizione esiste, ed e' anche il motivo per cui le asserzioni qui
 *      sotto guardano l'ORDINE dei blocchi e non la loro prosa: l'ordine e'
 *      cio' che rende il ramo raggiungibile, e una prosa cambia da sola.
 *
 * NOTA PER CHI CERCA IL SORGENTE COL GREP: `create-article.mjs` contiene byte
 * che fanno classificare il file come BINARIO, e un `grep` senza `-a` torna
 * vuoto IN SILENZIO. Qui si legge con `fs.readFileSync(…, 'utf8')`, che non ha
 * quel problema.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROMPT_SCAFFOLD_FLOOR_TOKENS,
  EXIT_ROSTER_CANNOT_SERVE_PROMPT,
  EXIT_NO_ARTICLE_DECLARED,
  isBudgetBelowScaffoldFloor,
  isPromptFloorIrreducible,
  promptFloorSummary,
  isInputCapDeferralVeto,
  isLegitimateQuotaDeferral,
} from '../scripts/lib/exhaustion-disposition.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const CREATE_ARTICLE = path.join(REPO, 'generator', 'scripts', 'create-article.mjs');

// ── 1. LA DECISIONE ────────────────────────────────────────────────────────

test('il pavimento e\' un numero solo, e vale 5850', () => {
  // Il valore non e' arbitrario: e' il peso del prompt a fonte E fatti
  // AZZERATI, misurato in `callGemini`. Se qualcuno lo cambia deve cambiarlo
  // QUI, cioe' nell'unico posto che le due meta' leggono.
  assert.equal(PROMPT_SCAFFOLD_FLOOR_TOKENS, 5850);
});

test('il confine del pavimento e\' STRETTO, e «nessun budget» non e\' «budget impossibile»', () => {
  // Il gradino da 3000 dell'esempio nel codice: insoddisfacibile.
  assert.equal(isBudgetBelowScaffoldFloor(3000), true);
  // Il gradino da 4000 che #450 propagava per sbaglio (chiuso da #454): pure.
  assert.equal(isBudgetBelowScaffoldFloor(4000), true);
  // Un token sotto: ancora insoddisfacibile.
  assert.equal(isBudgetBelowScaffoldFloor(PROMPT_SCAFFOLD_FLOOR_TOKENS - 1), true);
  // ESATTAMENTE il pavimento NON lo e': l'impalcatura ci sta, con zero spazio
  // per il contenuto. E' un gradino stretto, non un gradino impossibile, e
  // confonderli farebbe uscire presto un caso che una riduzione puo' servire.
  assert.equal(isBudgetBelowScaffoldFloor(PROMPT_SCAFFOLD_FLOOR_TOKENS), false);
  assert.equal(isBudgetBelowScaffoldFloor(8000), false);
  // L'ASSENZA di un vincolo non e' un vincolo impossibile. Questa e' la
  // guardia che impedisce all'uscita anticipata di scattare su ogni run che
  // non ha mai sentito parlare di cap: `lastPromptTokenBudget` vale 0 finche'
  // la flotta non detta niente.
  for (const nulla of [0, -1, undefined, null, NaN, '', 'boh', {}]) {
    assert.equal(isBudgetBelowScaffoldFloor(nulla), false, `«${String(nulla)}» non e' un budget impossibile`);
  }
});

/**
 * La forma dell'errore come arriva al catch di primo livello DOPO che il ciclo
 * di retry ha deciso di uscire. `promptFloorReport` e' cio' che il ciclo marca;
 * il resto e' quello che `callLLM` allega da sempre.
 */
function earlyExitError({ budget = 4000, attempt = 2, maxAttempts = 6, transient = 90, persistent = 10 } = {}) {
  const err = new Error('All AI models failed. Chain: [...]. Errors: ...');
  err.code = 'ALL_MODELS_EXHAUSTED';
  err.retryRequestTokenBudget = budget;
  err.exhaustionBreakdown = { transient, persistent, total: transient + persistent };
  err.inputCapReport = { count: 4, maxSkippedReqLimit: budget, minSkippedReqLimit: 3000, estimatedRequestTokens: 9740 };
  err.promptFloorReport = {
    budget, floor: PROMPT_SCAFFOLD_FLOOR_TOKENS, attempt, maxAttempts, section: 'frontaliere',
  };
  return err;
}

test('un errore marcato dall\'uscita anticipata e\' irriducibile, e dice quanti tentativi non ha speso', () => {
  const err = earlyExitError();
  assert.equal(isPromptFloorIrreducible(err), true);
  assert.deepEqual(promptFloorSummary(err), {
    budget: 4000,
    floor: 5850,
    short: 1850,
    attempt: 2,
    maxAttempts: 6,
    attemptsSkipped: 4,
    section: 'frontaliere',
  });
});

test('LA RAGIONE DEL RAMO: con quota dominante gli altri due predicati direbbero «differisci»', () => {
  // E' il caso che rende necessario un predicato NUOVO invece di riusare quelli
  // che c'erano. Su una cascata a quota dominante (90/100 transitori):
  const err = earlyExitError({ transient: 90, persistent: 10 });
  //   • il veto di #313 non scatta, perche' il transitorio domina STRETTAMENTE;
  assert.equal(isInputCapDeferralVeto(err), false);
  //   • il differimento invece SI', e la run uscirebbe 4 = «ragione legittima
  //     dichiarata», col `declared=true` che fa chainare il successore contro
  //     un muro che il prossimo tentativo trova identico.
  assert.equal(isLegitimateQuotaDeferral(err), true);
  //   • solo il predicato nuovo vede la condizione vera.
  assert.equal(isPromptFloorIrreducible(err), true);
  // E i due esiti non sono lo stesso esito: 3 non chaina, 4 si'.
  assert.notEqual(EXIT_ROSTER_CANNOT_SERVE_PROMPT, EXIT_NO_ARTICLE_DECLARED);
});

test('senza marcatura, o senza cascata svuotata, il predicato non afferma niente', () => {
  assert.equal(isPromptFloorIrreducible(null), false);
  assert.equal(isPromptFloorIrreducible(new Error('boom')), false);
  // Una cascata svuotata con un budget SOPRA il pavimento resta un caso da
  // ritentare: e' il comportamento invariato, e questa riga lo blocca.
  assert.equal(isPromptFloorIrreducible(earlyExitError({ budget: 8000 })), false);
  // Un errore che non e' una cascata svuotata non viene mai classificato qui,
  // per quanto porti un report.
  const altro = earlyExitError();
  altro.code = 'SOMETHING_ELSE';
  assert.equal(isPromptFloorIrreducible(altro), false);
  // E un errore che porta il budget ma NON la marcatura del ciclo non basta:
  // la marcatura e' la prova che una decisione e' stata presa a monte, e senza
  // di essa questo ramo ruberebbe la classificazione agli altri due.
  const nonMarcato = earlyExitError();
  delete nonMarcato.promptFloorReport;
  assert.equal(isPromptFloorIrreducible(nonMarcato), false);
});

// ── 2. IL CABLAGGIO in create-article.mjs ──────────────────────────────────

const SRC = fs.readFileSync(CREATE_ARTICLE, 'utf8');

test('il pavimento NON e\' riscritto a mano in create-article.mjs', () => {
  // Il difetto che questa riga previene e' la divergenza silenziosa: il marker
  // `unsat=` e l'uscita anticipata devono decidere sullo STESSO numero, e un
  // `const … = 5850` locale li lascerebbe scivolare l'uno dall'altro senza che
  // niente diventi rosso.
  assert.doesNotMatch(
    SRC,
    /PROMPT_SCAFFOLD_FLOOR_TOKENS\s*=\s*\d+/,
    'il pavimento va importato da lib/exhaustion-disposition.mjs, non ridichiarato',
  );
  assert.match(SRC, /PROMPT_SCAFFOLD_FLOOR_TOKENS,/, 'e va importato per nome');
});

test('l\'uscita anticipata precede il `continue` del ciclo di retry', () => {
  const uscita = SRC.indexOf('if (isBudgetBelowScaffoldFloor(lastPromptTokenBudget))');
  const continua = SRC.indexOf('if (attempt < maxAttempts) continue;');
  assert.ok(uscita > 0, 'il ciclo di retry deve consultare il pavimento');
  assert.ok(continua > 0, 'il `continue` del ciclo di retry deve esistere ancora');
  // L'ORDINE E' LA FIX. Dopo il `continue` il blocco e' codice morto per i
  // tentativi 2..maxAttempts, cioe' esattamente quelli che il difetto macina:
  // resterebbe l'uscita al SOLO ultimo giro, quando i minuti sono gia' spesi.
  assert.ok(uscita < continua, 'l\'uscita deve precedere il `continue`, o non risparmia un solo tentativo');
  // E deve LANCIARE, non ritornare: un `return` da qui sarebbe l'uscita muta
  // che il catch di primo livello e' li' per rendere impossibile.
  const blocco = SRC.slice(uscita, continua);
  assert.match(blocco, /e\.promptFloorReport = \{/, 'l\'errore va marcato, o il catch non sa perche\' e\' uscito');
  assert.match(blocco, /throw e;/, 'l\'uscita deve rilanciare l\'errore, non ritornare');
});

test('il ramo di primo livello viene PRIMA degli altri due, ed esce con la costante', () => {
  const floor = SRC.indexOf('if (isPromptFloorIrreducible(e))');
  const veto = SRC.indexOf('if (isInputCapDeferralVeto(e))');
  const defer = SRC.indexOf('if (isQuotaExhaustedError(e))');
  assert.ok(floor > 0, 'il catch di primo livello deve classificare l\'uscita anticipata');
  assert.ok(veto > 0 && defer > 0, 'gli altri due rami devono esistere ancora');
  // Sotto il differimento questo ramo e' irraggiungibile su ogni cascata a
  // quota dominante — cioe' proprio il caso provato sopra — perche' quel ramo
  // esce e non ritorna.
  assert.ok(floor < veto, 'l\'uscita anticipata deve precedere il veto di #313');
  assert.ok(floor < defer, 'l\'uscita anticipata deve precedere il differimento, o e\' codice morto');
  // Un solo posto definisce «uscita per roster che non serve il prompt»: il
  // letterale scritto a mano farebbe divergere le due meta'.
  const ramo = SRC.slice(floor, veto);
  assert.match(
    ramo,
    /(?:process\.exit|await exitAfterFlush)\(EXIT_ROSTER_CANNOT_SERVE_PROMPT\)/,
    'l\'uscita deve usare la costante condivisa, non un letterale',
  );
  // NON e' un `success` muto e NON e' una delle sei ragioni legittime: e' la
  // meta' della fix che protegge dal verde silenzioso di #313.
  assert.doesNotMatch(ramo, /EXIT_NO_ARTICLE_DECLARED/, 'questa condizione non e\' una ragione «legittima»');
  assert.doesNotMatch(ramo, /exitAfterFlush\(0\)|process\.exit\(0\)/, 'un\'uscita 0 qui e\' il verde silenzioso di #313');
  // E deve DIRE il numero azionabile in forma machine-readable, come gli altri
  // due rami: un watchdog legge questa riga, non la prosa attorno.
  assert.match(ramo, /::error::prompt-floor-irreducible: budget=/, 'serve la riga machine-readable');
});
