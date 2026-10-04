/**
 * ── LA RIMOZIONE DELLA RIGA `TITOLO ARTICOLO` NON TOCCA ALTRO ──────────────
 *
 * `stripLeakedTitleMarkerLine` e' l'unico punto in cui la bonifica dello stock
 * cancella testo da un body italiano pubblicato senza passare dalla cascata MT
 * (approvazione del proprietario del 2026-10-04, site 7682). Il test diventa
 * rosso se la rimozione tocca un carattere oltre la riga del prompt, se una
 * forma non riconosciuta (intestazione, etichetta a meta' riga, titolo lungo o
 * su un'altra riga, minuscolo) viene editata, o se la prova del diff accetta
 * una modifica diversa dalla sola riga tolta.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripLeakedTitleMarkerLine,
  diffIsExactlyRemovedLines,
  TITLE_MARKER_MAX_REST,
} from '../scripts/lib/strip-leaked-title-marker.mjs';

const PROSE = 'Il frontaliere che lavora in Ticino deve dichiarare il reddito in Italia.';

test('toglie la riga finale preceduta da una riga vuota, e solo quella', () => {
  const text = `${PROSE}\n\nTITOLO ARTICOLO: Frontalieri e redditi 2026`;
  const out = stripLeakedTitleMarkerLine(text);
  assert.deepEqual(out.removed, ['TITOLO ARTICOLO: Frontalieri e redditi 2026']);
  assert.deepEqual(out.skipped, []);
  // La riga vuota resta: con la riga se ne va solo il suo terminatore.
  assert.equal(out.value, `${PROSE}\n`);
});

test('toglie la riga con il titolo tra virgolette basse', () => {
  const text = `${PROSE}\nTITOLO ARTICOLO: «Trasporti ’45»: Ticino ai margini`;
  const out = stripLeakedTitleMarkerLine(text);
  assert.deepEqual(out.removed, ['TITOLO ARTICOLO: «Trasporti ’45»: Ticino ai margini']);
  assert.equal(out.value, PROSE);
});

test('toglie la riga a fine campo senza newline finale e quella in mezzo al campo', () => {
  const atEnd = stripLeakedTitleMarkerLine(`${PROSE}\nTITOLO ARTICOLO: x`);
  assert.equal(atEnd.value, PROSE);
  const middle = stripLeakedTitleMarkerLine(`## Titolo\n\nTITOLO ARTICOLO: Un titolo\n\n${PROSE}`);
  assert.deepEqual(middle.removed, ['TITOLO ARTICOLO: Un titolo']);
  assert.equal(middle.value, `## Titolo\n\n\n${PROSE}`);
});

test('un testo senza il token esce identico', () => {
  for (const text of [PROSE, '', `${PROSE}\n\n## Fatti chiave\n- **Cosa**: x.`]) {
    assert.deepEqual(stripLeakedTitleMarkerLine(text), { value: text, removed: [], skipped: [] });
  }
});

test('le forme che non sono la riga intera non si toccano e finiscono in skipped', () => {
  const longTitle = 'a'.repeat(TITLE_MARKER_MAX_REST + 1);
  const cases = [
    // minuscolo: prosa, non il token del prompt; non e' nemmeno un candidato.
    { text: `Il titolo articolo: ${PROSE}`, skipped: [] },
    { text: `titolo articolo: Frontalieri\n${PROSE}`, skipped: [] },
    // intestazione con il titolo sulla riga sotto (forma B).
    { text: `${PROSE}\n\n## TITOLO ARTICOLO\nFrontalieri e redditi`, skipped: [/^intestazione: ## TITOLO ARTICOLO/] },
    { text: `### TITOLO ARTICOLO: Frontalieri\n${PROSE}`, skipped: [/^intestazione:/] },
    // etichetta a meta' paragrafo.
    { text: `${PROSE} TITOLO ARTICOLO: Frontalieri e redditi`, skipped: [/^non-riga-intera:/] },
    // titolo oltre la soglia.
    { text: `${PROSE}\nTITOLO ARTICOLO: ${longTitle}`, skipped: [new RegExp(`^titolo-oltre-${TITLE_MARKER_MAX_REST}-caratteri:`)] },
    // resto su due righe: il titolo e' sulla riga dopo.
    { text: `${PROSE}\nTITOLO ARTICOLO:\nFrontalieri e redditi`, skipped: [/^titolo-su-altra-riga:/] },
  ];
  for (const { text, skipped } of cases) {
    const out = stripLeakedTitleMarkerLine(text);
    assert.equal(out.value, text, `non deve editare: ${JSON.stringify(text.slice(-60))}`);
    assert.deepEqual(out.removed, []);
    assert.equal(out.skipped.length, skipped.length, JSON.stringify(out.skipped));
    skipped.forEach((re, i) => assert.match(out.skipped[i], re));
  }
});

test('una riga rimovibile e una forma non riconosciuta nello stesso campo: tolta la prima, segnalata la seconda', () => {
  const text = `## TITOLO ARTICOLO\nFrontalieri\n\n${PROSE}\n\nTITOLO ARTICOLO: Frontalieri`;
  const out = stripLeakedTitleMarkerLine(text);
  assert.deepEqual(out.removed, ['TITOLO ARTICOLO: Frontalieri']);
  assert.equal(out.skipped.length, 1);
  // Chi chiama non scrive con `skipped` non vuoto: la pagina resta intatta.
});

test('proprieta\': dopo la rimozione il diff riga per riga e\' esattamente la riga tolta', () => {
  const fixtures = [
    `${PROSE}\n\nTITOLO ARTICOLO: Frontalieri e redditi 2026`,
    `TITOLO ARTICOLO: In testa al campo\n\n${PROSE}`,
    `${PROSE}\nTITOLO ARTICOLO: «Virgolette» e ’apostrofi’\n\n- elenco\n- puntato`,
    `## Fatti chiave\n- **Cosa**: x.\n\nTITOLO ARTICOLO: Uno\n\n${PROSE}\n\nTITOLO ARTICOLO: Due`,
    `  TITOLO ARTICOLO :  Spazi attorno ai due punti\n${PROSE}\n`,
  ];
  for (const text of fixtures) {
    const out = stripLeakedTitleMarkerLine(text);
    assert.ok(out.removed.length > 0, text);
    assert.deepEqual(out.skipped, []);
    assert.equal(out.value.split('\n').length, text.split('\n').length - out.removed.length);
    assert.ok(diffIsExactlyRemovedLines(text, out.value, out.removed), text);
    assert.doesNotMatch(out.value, /TITOLO ARTICOLO/);
  }
});

test('la prova del diff rifiuta ogni modifica che non sia la sola riga tolta', () => {
  const old = `${PROSE}\n\nTITOLO ARTICOLO: Frontalieri`;
  const removed = ['TITOLO ARTICOLO: Frontalieri'];
  assert.equal(diffIsExactlyRemovedLines(old, `${PROSE}\n`, removed), true);
  // un carattere cambiato altrove
  assert.equal(diffIsExactlyRemovedLines(old, `${PROSE.replace('Ticino', 'Ticin0')}\n`, removed), false);
  // tolta anche la riga vuota
  assert.equal(diffIsExactlyRemovedLines(old, PROSE, removed), false);
  // la riga non e' stata tolta
  assert.equal(diffIsExactlyRemovedLines(old, old, removed), false);
  // tolta una riga diversa da quella dichiarata
  assert.equal(diffIsExactlyRemovedLines(old, `${PROSE}\n`, ['TITOLO ARTICOLO: Altro']), false);
  // riga aggiunta
  assert.equal(diffIsExactlyRemovedLines(old, `${PROSE}\n\nnuova`, removed), false);
  // nessuna rimozione dichiarata: solo l'identita' passa
  assert.equal(diffIsExactlyRemovedLines(PROSE, PROSE, []), true);
  assert.equal(diffIsExactlyRemovedLines(undefined, PROSE, []), false);
});
