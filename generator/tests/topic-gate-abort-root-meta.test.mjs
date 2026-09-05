/**
 * topic-gate-abort-root-meta.test.mjs — un rifiuto che si INTITOLA resta un
 * rifiuto.
 *
 * ## Il difetto (#801)
 *
 * Lo schema del prompt impone `null` sui campi di `content`, NON alla radice
 * del payload. Un modello che esercita REGOLA #0 e da' un titolo al proprio
 * rifiuto —
 *
 *     {"abort_topical_relevance":true,"reason":"…",
 *      "title":"Rifiuto: fonte non pertinente",
 *      "content":{"it":{"title":null,"excerpt":null,"body1":null,…}}}
 *
 * — non viola niente di dichiarato. Ma `normalizeItalianContentFromPayload`
 * cerca `title` anche alla radice (forma mista di `haiku`, #483/#546), quindi
 * `hasAnyField` diventava vero, il ramo dell'abort — guardato da `!itContent`
 * — non scattava, e il verdetto usciva `reject` con
 * `missing:['excerpt','body1','body2','body3']`: CINQUE rigenerazioni e un
 * `recordModelContentFailure()` a ogni giro contro un modello che aveva
 * OBBEDITO, e la sezione chiusa senza articolo (run 32175400548).
 *
 * ## Cosa pinna questo file
 *
 * La regola nuova e i suoi due bordi: il corpo e' l'unico testimone che conta
 * (un rifiuto puo' portare un titolo, non puo' portare l'articolo), la guardia
 * di auto-contraddizione del 2026-07-06 resta intatta, e la meta' `meta` dello
 * split — dove il corpo e' assente PER COSTRUZIONE — non guadagna un abort che
 * non ha modo di distinguere da una risposta valida.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyBody2Payload,
  isTopicGateAbortVerdict,
  BODY_ONLY_FIELDS,
  META_ONLY_FIELDS,
} from '../scripts/lib/body2-payload-verdict.mjs';

const BLOCCO = 'Il Consiglio di Stato del Canton Ticino ha rivisto il regolamento sull\'imposta alla fonte per i frontalieri residenti in Italia. '.repeat(3);
const CONTENT_NULL = { it: { title: null, excerpt: null, body1: null, body2: null, body3: null } };

test('abort + `title` alla radice ⇒ topic-gate-abort, non un reject di 4 campi', () => {
  const parsed = {
    abort_topical_relevance: true,
    reason: 'La fonte riguarda una nuova ala ospedaliera a Coira: nessun aggancio frontaliere.',
    title: 'Rifiuto: fonte non pertinente',
    content: CONTENT_NULL,
  };
  const { verdict, itContent, missing } = classifyBody2Payload({ parsed });
  assert.equal(verdict, 'topic-gate-abort', 'un abort titolato veniva riletto come reject: 5 rigenerazioni contro un modello che ha obbedito');
  assert.equal(itContent, null);
  assert.deepEqual(missing, [], 'un abort non ha campi mancanti: non manca niente, e\' un verdetto');
});

test('abort + `title`/`excerpt` alla radice E dentro content.it ⇒ sempre abort', () => {
  for (const parsed of [
    { abort_topical_relevance: true, reason: 'fuori tema', title: 'Rifiuto', excerpt: 'Fonte non pertinente', content: CONTENT_NULL },
    { abort_topical_relevance: true, reason: 'fuori tema', content: { it: { title: 'Rifiuto: fonte non pertinente', excerpt: null, body1: null, body2: null, body3: null } } },
  ]) {
    assert.equal(classifyBody2Payload({ parsed }).verdict, 'topic-gate-abort');
  }
});

test('abort puro (nessun campo, da nessuna parte) ⇒ invariato', () => {
  const parsed = { abort_topical_relevance: true, reason: 'fuori tema', content: null, seo: null };
  assert.deepEqual(
    classifyBody2Payload({ parsed }),
    { verdict: 'topic-gate-abort', itContent: null, missing: [] },
  );
});

test('abort + corpo pieno ⇒ NON abort: vince il contenuto (guardia 2026-07-06)', () => {
  const parsed = {
    abort_topical_relevance: true,
    reason: 'testo che afferma comunque la rilevanza frontaliera',
    content: { it: { title: 'Imposta alla fonte, cosa cambia', excerpt: 'Il punto sulle nuove aliquote per i frontalieri.', body1: BLOCCO, body2: BLOCCO, body3: BLOCCO } },
  };
  const { verdict, itContent } = classifyBody2Payload({ parsed });
  assert.equal(verdict, 'ok', 'il flag ha scavalcato un articolo valido e in tema: e\' il difetto della run 28802314827');
  assert.equal(itContent.body1, BLOCCO.trim());
});

test('abort + corpo PARZIALE ⇒ NON abort: resta reject, il chiamante rigenera', () => {
  const parsed = {
    abort_topical_relevance: true,
    reason: 'contraddittorio',
    title: 'Titolo',
    content: { it: { title: null, excerpt: null, body1: BLOCCO, body2: null, body3: null } },
  };
  const { verdict, missing } = classifyBody2Payload({ parsed });
  assert.equal(verdict, 'reject', 'con del corpo prodotto il modello si e\' contraddetto: non e\' un rifiuto');
  assert.ok(missing.includes('body2') && missing.includes('body3'));
});

test('meta\' BODY dello split: abort + `title` alla radice ⇒ abort', () => {
  const parsed = { abort_topical_relevance: true, reason: 'fuori tema', title: 'Rifiuto', content: CONTENT_NULL };
  assert.equal(classifyBody2Payload({ parsed, expectedFields: BODY_ONLY_FIELDS }).verdict, 'topic-gate-abort');
  assert.equal(isTopicGateAbortVerdict(parsed, { expectedFields: BODY_ONLY_FIELDS }), true);
});

test('meta\' META dello split: il corpo manca PER COSTRUZIONE, quindi il contenuto vince sul flag', () => {
  // Qui «niente corpo» non e' evidenza di rifiuto: lo schema
  // `article_metadata_only` non dichiara i body. Trattarlo come abort
  // butterebbe title/excerpt validi con il corpo gia' generato dalla 1/2.
  const parsed = {
    abort_topical_relevance: true,
    reason: 'flag che questa meta\' non doveva nemmeno emettere',
    content: { it: { title: 'Imposta alla fonte, cosa cambia', excerpt: 'Il punto sulle nuove aliquote per i frontalieri.' } },
  };
  assert.equal(isTopicGateAbortVerdict(parsed, { expectedFields: META_ONLY_FIELDS }), false);
  assert.equal(classifyBody2Payload({ parsed, expectedFields: META_ONLY_FIELDS }).verdict, 'ok');
  // Senza NIENTE, invece, resta un abort anche sulla meta' meta.
  assert.equal(
    isTopicGateAbortVerdict({ abort_topical_relevance: true, reason: 'x' }, { expectedFields: META_ONLY_FIELDS }),
    true,
  );
});

test('senza flag `=== true` nessuna forma di payload diventa un abort', () => {
  for (const flag of [false, 'true', 1, null, undefined]) {
    const parsed = { abort_topical_relevance: flag, reason: 'x', title: 'Rifiuto', content: CONTENT_NULL };
    assert.equal(isTopicGateAbortVerdict(parsed), false, `flag ${JSON.stringify(flag)} letto come abort`);
    assert.equal(classifyBody2Payload({ parsed }).verdict, 'reject');
  }
});

test('un parse fallito resta reject, qualunque cosa dica il flag', () => {
  const { verdict } = classifyBody2Payload({ parsed: undefined, parseErr: new Error('JSON troncato') });
  assert.equal(verdict, 'reject');
});
