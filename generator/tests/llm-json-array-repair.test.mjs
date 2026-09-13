import test from 'node:test';
import assert from 'node:assert/strict';

import { repairJsonArray } from '../scripts/batch-add-faq-to-articles.mjs';

const faqPair = (prefix) => ({
  q: `${prefix} domanda valida?`,
  a: `${prefix} risposta sufficientemente lunga per rappresentare una coppia FAQ valida.`,
});

test('il percorso FAQ scarta un oggetto di esempio e sceglie il payload array reale', () => {
  const raw = [
    'Esempio da non usare: {"note":"metadata"}',
    `Risposta finale: ${JSON.stringify([faqPair('Reale')])}`,
  ].join(' ');

  assert.deepEqual(JSON.parse(repairJsonArray(raw)), [faqPair('Reale')]);
});

test('il percorso FAQ applica la riparazione condivisa delle virgole dopo un array', () => {
  const raw = `Risposta finale: {"faq":${JSON.stringify([faqPair('FAQ')])} "meta":{"source":"model"}}`;
  const parsed = JSON.parse(repairJsonArray(raw));

  assert.deepEqual(parsed.faq, [faqPair('FAQ')]);
});
