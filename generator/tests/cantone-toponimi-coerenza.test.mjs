/** Test del guard cantonale #1053. */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkCantonToponymConsistency,
  detectDeclaredCanton,
  findForeignCantonToponyms,
  isCantonGuideCandidate,
  KNOWN_BASELINE_CROSS_CANTON_ARTICLE_IDS,
} from '../scripts/lib/cantone-toponimi-coerenza.mjs';

test('lo slug verso Vallese con Lugano/Ticino e\' un nuovo offender', () => {
  const result = checkCantonToponymConsistency({
    articleId: 'nuova-guida-courmayeur-vallese',
    slug: 'vivere-courmayeur-e-lavorare-vallese-da-frontaliere',
    title: 'Lavorare in Vallese: confronto con Lugano',
    body: 'La guida descrive il Vallese ma cita Lugano e il Ticino come luogo di lavoro.',
  });
  assert.equal(result.status, 'reject');
  assert.equal(result.declaredCanton, 'vallese');
  assert.deepEqual(
    result.matches.map((match) => match.toponym),
    ['ticino', 'lugano'],
  );
});

test('la guida legittima del Ticino conserva i propri toponimi', () => {
  const result = checkCantonToponymConsistency({
    articleId: 'vivere-carate-urio-lavorare-ticino-frontaliere',
    slug: 'vivere-carate-urio-lavorare-ticino-frontaliere',
    title: 'Vivere a Carate Urio e lavorare in Ticino',
    body: 'Il percorso passa da Lugano, Bellinzona, Locarno, Chiasso e Mendrisio nel Ticino.',
  });
  assert.equal(result.status, 'pass');
  assert.equal(result.ok, true);
  assert.deepEqual(result.matches, []);
});

test('la clausola lavorare distingue la destinazione dalla residenza ticinese', () => {
  assert.equal(
    detectDeclaredCanton('vivere-a-lugano-e-lavorare-vallese'),
    'vallese',
  );
  const result = checkCantonToponymConsistency({
    articleId: 'nuova-guida-lugano-vallese',
    slug: 'vivere-a-lugano-e-lavorare-vallese',
    body: 'La guida cita Lugano come residenza e Bellinzona come confronto.',
  });
  assert.equal(result.status, 'reject');
  assert.deepEqual(
    result.matches.map((match) => match.toponym),
    ['lugano', 'bellinzona'],
  );
});

test('i 32 casi storici sono una baseline esplicita e non bloccano il corpus esistente', () => {
  assert.equal(KNOWN_BASELINE_CROSS_CANTON_ARTICLE_IDS.length, 32);
  assert.equal(new Set(KNOWN_BASELINE_CROSS_CANTON_ARTICLE_IDS).size, 32);
  const result = checkCantonToponymConsistency({
    articleId: 'vivere-courmayeur-e-lavorare-vallese-da-frontaliere',
    slug: 'vivere-courmayeur-e-lavorare-vallese-da-frontaliere',
    body: 'Lugano e Bellinzona sono citate nel testo storico.',
  });
  assert.equal(result.status, 'baseline');
  assert.equal(result.ok, true);
  assert.equal(result.matches.length, 2);
});

test('la regola rileva anche un toponimo ticinese senza la parola Ticino nello slug', () => {
  assert.equal(detectDeclaredCanton('guida-lavorare-grigioni'), 'grigioni');
  const matches = findForeignCantonToponyms({
    slug: 'guida-lavorare-grigioni',
    body: 'Il tragitto professionale parte da Bellinzona.',
  });
  assert.deepEqual(matches, [{ canton: 'ticino', toponym: 'bellinzona' }]);
});

test('uno slug ambiguo resta non classificato per evitare falsi positivi', () => {
  const result = checkCantonToponymConsistency({
    articleId: 'confronto-grigioni-vallese',
    slug: 'confronto-grigioni-vallese',
    body: 'La guida confronta più cantoni e cita Lugano.',
  });
  assert.equal(result.status, 'unscoped');
  assert.equal(result.ok, true);
});

test('il digest multi-cantone resta fuori dal guard guida/lavoro', () => {
  const result = checkCantonToponymConsistency({
    articleId: 'eventi-weekend-ticino',
    slug: 'eventi-weekend-ticino',
    title: 'Eventi in Ticino e altri cantoni',
    body: 'La sezione altri cantoni cita Grigioni e Vallese per gli eventi del weekend.',
  });
  assert.equal(isCantonGuideCandidate({
    articleId: 'eventi-weekend-ticino',
    slug: 'eventi-weekend-ticino',
    title: 'Eventi in Ticino e altri cantoni',
  }), false);
  assert.equal(result.status, 'unscoped');
  assert.equal(result.ok, true);
  assert.equal(result.declaredCanton, 'ticino');
  assert.deepEqual(result.matches, []);
});
