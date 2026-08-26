/**
 * ── `_msgsUnica` FUORI BUDGET SUL FALLBACK VIA=SPLIT, RESO OSSERVABILE (issue #612) ──
 *
 * PARENT: #460, sub-issue gemello di #611. In `_rebracket(budget)`, quando
 * NESSUN gradino della scala rientra nel nuovo target (`stepFit` resta
 * `null`) ma lo split si' (`splitEntra` true), `rb.msgs` e' `null` per
 * costruzione. In `_eseguiRibracket`, `_msgsUnica = rb.msgs ||
 * _buildStep(_shrinkLadder.length - 1).msgs` ricade quindi sul gradino PIU'
 * aggressivo della scala — che, per lo stesso motivo per cui `stepFit` e'
 * rimasto `null`, NON rispetta il budget dettato dalla flotta. Se lo split
 * riesce, `llmMessages = _msgsUnica` diventa il punto di ripartenza del
 * retry per JSON malformato piu' sotto: quel retry rispedisce un prompt
 * sopra budget, in un caso oggi silenzioso nei log.
 *
 * Il fix aggiunge un campo `viaFallbackUnsat=<0|1>` al marker
 * `[prompt-rebracket]`, acceso esattamente quando `rb.msgs` e' `null` (cioe'
 * quando `_msgsUnica` ricade sul fallback fuori budget), sullo stesso
 * principio del campo `unsat=1` gia' in uso sul marker `[prompt-budget]`.
 *
 * Letto come TESTO per lo stesso motivo di `prompt-floor-early-exit.test.mjs`,
 * `prompt-rebracket-determinism.test.mjs` e
 * `prompt-rebracket-prefer-degradata.test.mjs`: `create-article.mjs` non e'
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

function corpoEseguiRibracket() {
  const inizio = SRC.indexOf('const _eseguiRibracket = async (rb, opts) => {');
  assert.ok(inizio > 0, 'la funzione deve esistere ancora con questa firma');
  const fine = SRC.indexOf('\n  };', inizio);
  assert.ok(fine > inizio, 'fine della funzione non trovata');
  return SRC.slice(inizio, fine);
}

test('`viaFallbackUnsat` e\' calcolato dallo stesso `rb.msgs` da cui dipende `_msgsUnica`', () => {
  const corpo = corpoEseguiRibracket();

  const calcolo = corpo.indexOf('const viaFallbackUnsat = rb.msgs ? 0 : 1;');
  const msgsUnica = corpo.indexOf('const _msgsUnica = rb.msgs || _buildStep(_shrinkLadder.length - 1).msgs;');
  assert.ok(calcolo > 0, 'il campo deve essere calcolato su `rb.msgs`, la stessa condizione del fallback');
  assert.ok(msgsUnica > 0, 'il fallback `_msgsUnica` deve esistere ancora con questa forma');
  assert.ok(
    calcolo < msgsUnica,
    'il campo va calcolato prima del log, non dopo aver gia\' costruito `_msgsUnica`',
  );
});

test('il marker `[prompt-rebracket]` emette `viaFallbackUnsat` nella console.error', () => {
  const corpo = corpoEseguiRibracket();
  const logStart = corpo.indexOf('console.error(');
  assert.ok(logStart > 0, 'la console.error del marker deve esistere');
  const logEnd = corpo.indexOf(');', logStart);
  const logBody = corpo.slice(logStart, logEnd);

  assert.match(logBody, /\[prompt-rebracket\]/, 'deve restare il marker machine-readable');
  assert.match(
    logBody,
    /viaFallbackUnsat=\$\{viaFallbackUnsat\}/,
    'il marker deve interpolare il nuovo campo `viaFallbackUnsat`',
  );
});

test('il commento di forma del marker documenta il nuovo campo', () => {
  assert.match(
    SRC,
    /\/\/ {3}\[prompt-rebracket\] section=<s> attempt=<n> budget=<token>\n {2}\/\/ {3}da=<token> a=<token> via=<split\|scala> fonte=<n>ch fatti=<n>ch\n {2}\/\/ {3}viaFallbackUnsat=<0\|1>/,
    'il commento che descrive la forma stabile del marker deve elencare anche `viaFallbackUnsat`',
  );
});
