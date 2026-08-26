/**
 * ── IL PREFERITO NON VA RICONTATTATO DOPO IL RI-BRACKETING (issue #611) ─────
 *
 * PARENT: #460. Il ri-bracketing (`_eseguiRibracket`) si arma SOLO quando
 * `err.retryRequestTokenBudget` viene dal roster (`_budgetDettato`), cioe'
 * quando la libreria ha visto ALMENO un modello saltato per cap di INPUT. Ma
 * l'unico membro di `PREFERRED_GENERATION_MODELS` (claude-cli/haiku) non
 * dichiara nessun cap di input, quindi non puo' MAI essere fra i modelli
 * saltati per dimensione: se ha fallito, ha fallito per un'altra ragione
 * (timeout, quota, rate-limit) che ridimensionare il prompt non cambia.
 * Ricontattarlo con lo stesso `prefer` dopo l'armo e' spendere una chiamata
 * su un esito gia' noto.
 *
 * Il fix introduce `_preferDegradataDalRibracket` (spento di default, acceso
 * dentro `_eseguiRibracket`) e lo usa per spegnere `prefer` sui QUATTRO
 * call-site del tentativo: la chiamata 1/2 split, la chiamata 2/2 meta
 * (`_call2`, raggiunta dallo stesso ramo `_eseguiRibracket` -> `rb.split` ->
 * `_generateSplit()`, mancante nel primo giro — vedi review PR #616), il
 * fallback scala dentro `_eseguiRibracket` stesso, e il retry per JSON
 * malformato piu' sotto.
 * Questo file prova che i quattro call-site restano coperti, letti come TESTO
 * per lo stesso motivo di `prompt-floor-early-exit.test.mjs` e
 * `prompt-rebracket-determinism.test.mjs`: `create-article.mjs` non e'
 * importabile da un test (contiene byte che lo fanno classificare BINARIO —
 * un `grep` senza `-a` torna vuoto IN SILENZIO — ed esegue una chiamata di
 * rete a module scope).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const CREATE_ARTICLE = path.join(REPO, 'generator', 'scripts', 'create-article.mjs');
const SRC = fs.readFileSync(CREATE_ARTICLE, 'utf8');

test('il flag `_preferDegradataDalRibracket` esiste, spento di default', () => {
  assert.match(
    SRC,
    /let _preferDegradataDalRibracket = false;/,
    'il flag deve partire spento: prima del ri-bracketing la preferenza resta attiva',
  );
});

test('`_eseguiRibracket` accende il flag prima di richiamare `callLLM`', () => {
  const inizio = SRC.indexOf('const _eseguiRibracket = async (rb, opts) => {');
  assert.ok(inizio > 0, 'la funzione deve esistere ancora con questa firma');
  const fine = SRC.indexOf('\n  };', inizio);
  assert.ok(fine > inizio, 'fine della funzione non trovata');
  const corpo = SRC.slice(inizio, fine);

  const accensione = corpo.indexOf('_preferDegradataDalRibracket = true;');
  const chiamataScala = corpo.indexOf('callLLM(llmMessages, { ...opts, prefer: undefined });');
  assert.ok(accensione > 0, 'il ri-bracketing deve accendere il flag');
  assert.ok(chiamataScala > 0, 'il fallback scala deve spegnere `prefer` esplicitamente sulla chiamata a `callLLM`');
  assert.ok(
    accensione < chiamataScala,
    'il flag va acceso PRIMA della chiamata scala, o la guardia arriva a cose gia\' fatte',
  );
});

test('la chiamata split rispetta il flag oltre a `_preferActiveThisAttempt`', () => {
  assert.match(
    SRC,
    /prefer: \(_preferActiveThisAttempt && !_preferDegradataDalRibracket\) \? PREFERRED_GENERATION_MODELS : undefined, expectedFields: BODY_ONLY_FIELDS/,
    'la chiamata split deve spegnere `prefer` quando il ri-bracketing si e\' armato',
  );
});

test('il retry per JSON malformato rispetta il flag oltre a `_preferActiveThisAttempt`', () => {
  assert.match(
    SRC,
    /prefer: \(_preferActiveThisAttempt && !_preferDegradataDalRibracket\) \? PREFERRED_GENERATION_MODELS : undefined, expectedFields: REQUIRED_IT_BODY_FIELDS/,
    'il retry per JSON malformato deve spegnere `prefer` quando il ri-bracketing si e\' armato',
  );
});

test('la chiamata 2/2 meta (`_call2`) rispetta il flag oltre a `_preferActiveThisAttempt`', () => {
  // Raggiunta da `_eseguiRibracket` -> ramo `rb.split` -> `_generateSplit()`,
  // che accende il flag PRIMA di richiamare la funzione: la 2/2 e' quindi
  // esposta allo stesso ricontatto sprecato della 1/2, ma nel primo giro del
  // fix non portava il gate (review PR #616, L8438).
  assert.match(
    SRC,
    /prefer: \(_preferActiveThisAttempt && !_preferDegradataDalRibracket\) \? PREFERRED_GENERATION_MODELS : undefined, expectedFields: META_ONLY_FIELDS/,
    'la chiamata 2/2 meta deve spegnere `prefer` quando il ri-bracketing si e\' armato',
  );
});

test('i quattro call-site del tentativo sono TUTTI coperti dal gate, nessuno resta scoperto', () => {
  const occorrenze = SRC.match(/!_preferDegradataDalRibracket/g) || [];
  // Una nel commento di dichiarazione del flag non esiste (il commento non usa
  // il letterale con `!`); le occorrenze reali sono: split, meta, retry
  // malformato, piu' i riferimenti in prosa nei commenti che accompagnano
  // ciascun sito. Il numero minimo che conta e' quello dei GATE effettivi in
  // una chiamata a `callLLM` (non in un commento): split, meta e retry
  // malformato usano il letterale
  // `(_preferActiveThisAttempt && !_preferDegradataDalRibracket)`, mentre il
  // fallback scala spegne `prefer` incondizionatamente perche' e' GIA' dentro
  // `_eseguiRibracket` (verificato nel test sopra).
  const gateInCodice = SRC.match(
    /prefer: \(_preferActiveThisAttempt && !_preferDegradataDalRibracket\) \? PREFERRED_GENERATION_MODELS : undefined/g,
  ) || [];
  assert.ok(occorrenze.length > 0, 'il flag deve comparire almeno una volta nel file');
  assert.equal(
    gateInCodice.length,
    3,
    'split, meta e retry malformato devono tutti portare il gate letterale sul `prefer`',
  );
});
