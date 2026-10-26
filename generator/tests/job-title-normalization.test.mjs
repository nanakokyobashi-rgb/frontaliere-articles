import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { extractNarrativeJobTitle } from '../../scripts/lib/job-title-normalization.mjs';

test('sceglie il primo segmento bold introdotto, non la nota successiva', () => {
  assert.equal(
    extractNarrativeJobTitle('I need to translate **Titolo corretto** and then **nota**'),
    'Titolo corretto',
  );
});

test('salta il bold non introdotto e prende il primo segmento introdotto', () => {
  assert.equal(
    extractNarrativeJobTitle('Contesto **fonte**. The title: **Titolo corretto** and **nota**'),
    'Titolo corretto',
  );
});

test('preferisce l introduzione del titolo a un preambolo generico', () => {
  assert.equal(
    extractNarrativeJobTitle('I need to **translate** the title: **Titolo corretto** and **nota**'),
    'Titolo corretto',
  );
  assert.equal(
    extractNarrativeJobTitle('Based on the context, **Bozza**. The title appears to be **Titolo finale**'),
    'Titolo finale',
  );
});

test('non tratta un titolo bold isolato come narrativa', () => {
  assert.equal(extractNarrativeJobTitle('**Titolo di lavoro**'), '');
});
