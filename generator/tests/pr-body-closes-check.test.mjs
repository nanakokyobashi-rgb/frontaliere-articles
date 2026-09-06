/**
 * pr-body-closes-check.test.mjs — la guardia sulla negazione non deve essere
 * aggirabile per LARGHEZZA.
 *
 * ## Perché esiste qui
 *
 * `scripts/lib/pr-body-closes-check.mjs` è `mode: identical` nel
 * `loop-sync-manifest`, e la sua copertura di test vive sul sito
 * (`tests/pr-body-closes-check.test.ts`). Da questo lato il modulo arrivava
 * quindi senza un solo test: la fix di #891 (classe `\p{L}`) e i tre buchi
 * residui misurati in #931 sono stati verificati a mano, in una sessione, e
 * niente li avrebbe difesi al giro dopo. Il file di test è corpus-only per
 * costruzione — non tocca il byte-identico del modulo — e chiude il buco sul
 * lato dove il gate `node --test` gira davvero prima di ogni PR.
 *
 * ## Cosa difende
 *
 * I due versi non si equivalgono: un falso positivo lo vedi e lo discuti, una
 * **chiusura mancata** lascia una issue aperta in silenzio con la fix già su
 * `main`. Per questo ogni caso «la guardia tace» è appaiato al suo gemello «la
 * guardia grida»: sono le tarature a occhio a scambiare i due versi.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkClosesLines } from '../../scripts/lib/pr-body-closes-check.mjs';

const refs = (body) =>
  checkClosesLines(body).violations
    .filter((v) => v.type === 'ineffective-closing-keyword')
    .map((v) => v.ref);

test('un intento di chiusura con una keyword che GitHub ignora resta segnalato', () => {
  assert.deepEqual(refs('Chiude #133'), ['#133']);
  assert.deepEqual(refs('Chiude: #133'), ['#133']);
  assert.deepEqual(refs('Risolve definitivamente #12'), ['#12']);
  // Una keyword vera altrove nel body raggiunge la ref: niente da segnalare.
  assert.deepEqual(refs('Closes #133\nchiude #133'), []);
});

test('la negazione sopprime il report anche oltre i 24 caratteri della vecchia finestra', () => {
  // `non ancora completamente ` = 25 caratteri: con la slice fissa il `non`
  // cadeva fuori e la stessa frase cambiava verdetto in base a QUANTO SONO
  // LUNGHE le parole in mezzo.
  assert.deepEqual(refs('Il bug non ancora completamente chiuso #849'), []);
  assert.deepEqual(refs('Il bug non ancora bene chiuso #849'), []);
  // Il bound resta DUE parole: una terza parola è di nuovo un intento reale.
  assert.deepEqual(refs('Il bug non ancora del tutto completamente chiuso #849'), ['#849']);
});

test('la negazione sopprime il report anche a cavallo di un a capo', () => {
  assert.deepEqual(refs('Il bug non è\nchiuso: #849 resta aperta.'), []);
  assert.deepEqual(refs('La issue è già\nchiusa da #66'), []);
  // Solo UNA riga indietro, e solo se la catena non è spezzata: una riga
  // vuota, un marker di lista o una punteggiatura restano confini.
  assert.deepEqual(refs('Il bug non è\n\nchiuso: #849'), ['#849']);
  assert.deepEqual(refs('Fix del parser.\nchiude #12'), ['#12']);
});

test('«non solo» concede la chiusura: ogni sinonimo resta segnalato', () => {
  for (const c of ['solo', 'soltanto', 'solamente', 'unicamente', 'esclusivamente']) {
    assert.deepEqual(refs(`Non ${c} chiude #12, ma anche X`), ['#12'], c);
  }
  for (const c of ['only', 'just', 'merely', 'simply']) {
    assert.deepEqual(refs(`Not ${c} closing #12, also Y`), ['#12'], c);
  }
});

test('un intento reale in una proposizione successiva resta segnalato', () => {
  assert.deepEqual(refs('Questo non è un problema, chiude #12'), ['#12']);
  assert.deepEqual(refs('- Non coperto qui.\n- Chiude #12'), ['#12']);
});

test('il report al passato non è un intento di chiusura di questa PR', () => {
  assert.deepEqual(refs('già chiusa da #66'), []);
  assert.deepEqual(refs('was fixed by #66'), []);
});

test('ciò che è QUOTATO non è un intento: fence, code span e commenti HTML', () => {
  assert.deepEqual(refs('Non scrivere `chiude #133`, scrivi `Closes #133`'), []);
  assert.deepEqual(refs('<!-- Chiude #133 -->'), []);
  assert.deepEqual(refs('```\nChiude #133\n```'), []);
});

test('la catena di ref su una keyword sola resta una violazione a parte', () => {
  const v = checkClosesLines('Closes #12 #34 #56').violations;
  assert.equal(v.length, 1);
  assert.equal(v[0].type, 'multi-ref-close');
  assert.deepEqual(v[0].refs, ['12', '34', '56']);
  assert.deepEqual(checkClosesLines('Closes #12\nCloses #34').violations, []);
});
