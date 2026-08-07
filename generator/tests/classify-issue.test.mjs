/**
 * classify-issue.test.mjs — equivalente in node:test del guard vitest del sito.
 *
 * Il classificatore decide se una issue salta la coda o ci entra. Sbagliarlo
 * non produce un errore: produce una issue che parte subito quando non doveva
 * (e occupa lo slot serializzato del fixer), oppure una che resta in coda
 * mentre la superficie dati servita al sito e' ferma.
 *
 * L'ordine delle regex e' la parte fragile, e i due test sull'ordine sotto
 * esistono per quello.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIssue } from '../../scripts/lib/classify-issue.mjs';

test('publish e\' l\'unica categoria che salta la coda', () => {
  const r = classifyIssue('Workflow Failure: Publish article data API', ['Bug']);
  assert.equal(r.category, 'publish');
  assert.equal(r.route, 'fix', 'publish deve partire subito: la superficie servita al sito e\' vecchia');
  assert.equal(r.fuPrio, null);
});

test('la generazione articoli va in coda bassa, non blocca il resto', () => {
  for (const title of [
    'Workflow Failure: Generate Blog Article',
    'Workflow Failure: fast-publish-article',
    'Workflow Failure: Publish Journalist Articles',
  ]) {
    const r = classifyIssue(title, ['Bug']);
    assert.equal(r.category, 'generation', `"${title}" deve essere generation`);
    assert.equal(r.route, 'queue');
    assert.equal(r.fuPrio, 'low', 'il volume di generazione non deve affamare le altre categorie');
  }
});

test('il contratto engine/host va in coda ALTA (si rompe dietro una CI verde)', () => {
  const r = classifyIssue('Workflow Failure: engine lockstep drift', ['Bug']);
  assert.equal(r.category, 'engine');
  assert.equal(r.route, 'queue');
  assert.equal(r.fuPrio, 'high');
});

test('ORDINE: un titolo di generazione che nomina publish resta publish', () => {
  // "fast-publish-article" contiene "publish". Se la regex generation venisse
  // valutata prima, un fallimento di publish-api con un titolo simile
  // finirebbe in coda bassa invece che partire subito. La guardia e' l'ordine.
  const r = classifyIssue('Workflow Failure: publish-api', ['Bug']);
  assert.equal(r.category, 'publish');
  assert.equal(r.route, 'fix');
});

test('ORDINE: fast-publish-article NON e\' publish (e\' generazione)', () => {
  // Il rovescio del test precedente: `fast-publish-article` matcha
  // /fast-publish/ nella categoria generation, ma NON deve essere catturato
  // dalla regex publish — altrimenti 8 fallimenti transienti a settimana
  // salterebbero la coda uno per uno.
  const r = classifyIssue('Workflow Failure: fast-publish-article', ['Bug']);
  assert.equal(r.category, 'generation', 'fast-publish-article e\' generazione transiente, non un guasto della pubblicazione');
  assert.equal(r.route, 'queue');
});

test('priority:high alza la priorita\' di drenaggio, non il route', () => {
  const r = classifyIssue('Workflow Failure: qualcosa', ['Bug', 'priority:high']);
  assert.equal(r.route, 'queue', 'nessuna label deve poter far saltare la coda');
  assert.equal(r.fuPrio, 'high');
});

test('ogni categoria e\' autofixabile (nessun guardrail di categoria)', () => {
  for (const title of ['Loop drift: il ciclo autonomo diverge dal sito', 'follow-up(#12): qualcosa', 'roba a caso']) {
    assert.equal(classifyIssue(title, []).autofix, true);
  }
});

test('la CLI emette JSON con la forma attesa dallo YAML del triage', async () => {
  // Lo YAML fa `node -e "JSON.parse(...).category"`: se la forma cambia, il
  // triage legge undefined e non instrada nulla, in silenzio.
  const r = classifyIssue('Workflow Failure: Publish article data API', []);
  assert.deepEqual(Object.keys(r).sort(), ['autofix', 'category', 'fuPrio', 'route']);
});
