/**
 * Un articolo che entra nel ledger cambia il robots senza cambiare corpo, meta o SEO.
 * Senza una voce nel piano del fast-publish il noindex resterebbe nel JSON e la
 * pagina servita continuerebbe a dire `index`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { articlePublishPlan } from '../../scripts/ci/fast-publish-section.mjs';

const LEDGER = 'content/article-index-exclusions.json';
const ledger = (...rows) => JSON.stringify({ excluded: rows });

function plan(previous, next) {
  const sections = { frontaliere: ['a', 'b'], svizzera: ['c'] };
  return articlePublishPlan([LEDGER], undefined, {
    readCurrentSource: (rel) => (rel === LEDGER ? next : ''),
    readPreviousSource: (rel) => (rel === LEDGER ? previous : ''),
    articleIdsForSection: (section) => sections[section.section] ?? [],
  });
}

const idsOf = (result, section) => result.find((row) => row.section === section)?.ids ?? [];

test('chi entra nel ledger si ripubblica, chi resta no', () => {
  const result = plan(
    ledger({ section: 'frontaliere', id: 'a' }),
    ledger({ section: 'frontaliere', id: 'a' }, { section: 'frontaliere', id: 'b' }),
  );
  assert.deepEqual(idsOf(result, 'frontaliere'), ['b']);
  assert.deepEqual(idsOf(result, 'svizzera'), []);
});

test('chi esce dal ledger si ripubblica: il noindex va tolto dalla pagina', () => {
  const result = plan(ledger({ section: 'svizzera', id: 'c' }), ledger());
  assert.deepEqual(idsOf(result, 'svizzera'), ['c']);
});

test('il primo ledger ripubblica tutti i suoi articoli', () => {
  const result = plan(null, ledger({ section: 'frontaliere', id: 'a' }, { section: 'svizzera', id: 'c' }));
  assert.deepEqual(idsOf(result, 'frontaliere'), ['a']);
  assert.deepEqual(idsOf(result, 'svizzera'), ['c']);
});

test('un id fuori registro non arriva al renderer', () => {
  const result = plan(null, ledger({ section: 'frontaliere', id: 'ritirato' }));
  assert.deepEqual(idsOf(result, 'frontaliere'), []);
});
