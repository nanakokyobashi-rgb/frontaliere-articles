/**
 * I campi del template senza valore e i marcatori del prompt escono dal corpo senza
 * portarsi dietro niente che abbia un valore.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairBody } from '../scripts/repair-empty-template-fields.mjs';
import { isEmptyAmountFact, stripVacuousFacts } from '../scripts/lib/key-facts-specificity.mjs';

test('la riga vuota esce, le altre restano', () => {
  const body = '## Fatti chiave\n- Cosa: x\n- Dove: Lugano\n- Chi: Cantone\n- Importo: Non specificato\n\nTesto.';
  const { value, facts } = repairBody(body);
  assert.equal(facts, 1);
  assert.equal(value, '## Fatti chiave\n- Cosa: x\n- Dove: Lugano\n- Chi: Cantone\n\nTesto.');
});

test('l\'ultima riga di una sezione porta via anche il titolo', () => {
  const { value } = repairBody('Prima.\n\n## Fatti chiave\n- Importo: Non specificato\n\nDopo.');
  assert.doesNotMatch(value, /Fatti chiave/);
  assert.match(value, /Dopo\.$/);
});

test('«non specificato, ma» conserva il valore che segue', () => {
  const { value } = repairBody('- Importo: Non specificato, ma stimato in 2 milioni\n- Dove: Chiasso');
  assert.equal(value, '- Importo: Stimato in 2 milioni\n- Dove: Chiasso');
});

test('i corpi su una riga sola perdono il campo e non la frase dopo', () => {
  const { value } = repairBody('- Wer: Genfer Ärzte. - Betrag: Nicht angegeben. Im Mai 2026 begann es.');
  assert.equal(value, '- Wer: Genfer Ärzte. Im Mai 2026 begann es.');
});

test('un valore vero non si tocca', () => {
  for (const body of ['- Importo: 1,2 milioni di franchi', '- Impatto diurno: Nessuno', 'Il dato non e\' stato specificato dal Cantone.']) {
    assert.equal(repairBody(body).value, body);
  }
});

test('«Importo: Nessuno» e\' vuoto solo se l\'etichetta chiede un importo', () => {
  assert.equal(isEmptyAmountFact('- **Importo**: Nessuno'), true);
  assert.equal(isEmptyAmountFact('- Amount: None'), true);
  assert.equal(isEmptyAmountFact('- Impatto diurno: Nessuno'), false);
  assert.equal(isEmptyAmountFact('- Importo: 200 franchi'), false);
});

test('il generatore toglie anche «Importo: Nessuno»', () => {
  const body = '## Fatti chiave\n- Cosa: a\n- Dove: b\n- Chi: c\n- Importo: Nessuno\n\nTesto.';
  const result = stripVacuousFacts(body);
  assert.equal(result.changed, true);
  assert.doesNotMatch(result.value, /Importo/);
});

test('il marcatore del prompt su una riga propria esce con il titolo ripetuto', () => {
  const { value, markers } = repairBody("Fine paragrafo.\n\nTITRE DE L'ARTICLE : Déductions fiscales\n\nSuite.");
  assert.equal(markers, 1);
  assert.doesNotMatch(value, /TITRE|Déductions/);
  assert.match(value, /^Fine paragrafo\.\n+Suite\.$/);
});

test('il marcatore dentro una frase esce con il titolo dell\'articolo, e solo con quello', () => {
  const title = 'CNC-Bediener im Tessin';
  assert.equal(
    repairBody(`Abschluss. ARTIKELTITEL: ${title} Der Beruf ist gefragt.`, title).value,
    'Abschluss. Der Beruf ist gefragt.',
  );
  assert.equal(
    repairBody('Abschluss. ARTIKELTITEL: Etwas anderes folgt.', title).value,
    'Abschluss. Etwas anderes folgt.',
  );
});
