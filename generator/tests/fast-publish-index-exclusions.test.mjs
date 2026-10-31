/**
 * Un articolo che entra nel ledger cambia il robots senza cambiare corpo, meta o SEO.
 * Senza una voce nel piano del fast-publish il noindex resterebbe nel JSON e la
 * pagina servita continuerebbe a dire `index`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { articlePublishPlan, r2PublishPlan } from '../../scripts/ci/fast-publish-section.mjs';
import { unknownIndexExclusionKeys } from '../../scripts/lib/article-index-exclusions-check.mjs';
import { ARTICLE_SECTION_CORE_ALL } from '../../engine/shared/articleSectionCore.mjs';
import { readFileSync } from 'node:fs';

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

test('il piano R2 segue la stessa transizione: le pagine cantonali portano il robots', () => {
  const canton = [ARTICLE_SECTION_CORE_ALL['canton-gr']];
  const result = r2PublishPlan([LEDGER], canton, {
    readCurrentSource: () => ledger({ section: 'canton-gr', id: 'nuovo' }, { section: 'frontaliere', id: 'a' }),
    readPreviousSource: () => ledger(),
  });
  assert.deepEqual(result, [{ section: 'canton-gr', ids: ['nuovo'], bootstrap: false }]);
});

test('il workflow cantonale parte quando cambia il ledger', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/fast-publish-section.yml', import.meta.url), 'utf8');
  assert.match(workflow, /- 'content\/article-index-exclusions\.json'/);
});

test('il publisher rifiuta una riga senza articolo, non la ignora', () => {
  const known = new Set(['frontaliere', 'svizzera', 'canton-gr']);
  const published = new Set(['frontaliere', 'svizzera']);
  const articles = ['frontaliere|a', 'svizzera|c'];
  assert.deepEqual(unknownIndexExclusionKeys(['frontaliere|a'], articles, published, known), []);
  assert.deepEqual(unknownIndexExclusionKeys(['frontaliere|refuso'], articles, published, known), ['frontaliere|refuso']);
  assert.deepEqual(unknownIndexExclusionKeys(['sezione-inventata|a'], articles, published, known), ['sezione-inventata|a']);
  assert.deepEqual(unknownIndexExclusionKeys(['canton-gr|x'], articles, published, known), []);
});
