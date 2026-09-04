/**
 * follow-up #546 (da #483/#542): la causa root dell'apparente omissione dei
 * campi `required` da parte di `haiku`.
 *
 * `normalizeItalianContentFromPayload` tollera tre forme — `content[locale]`,
 * `content` senza locale, radice del payload — ma le trattava come
 * ALTERNATIVE: il primo candidato con almeno un campo non vuoto vinceva e gli
 * altri due non venivano piu' guardati. Un modello che mescola le forme nella
 * STESSA risposta (i `body1..3` sotto `content.it`, `title`/`excerpt` alla
 * radice) perdeva quindi i campi lasciati nel candidato perdente, e
 * `classifyBody2Payload` li riportava come `missing` — cioe' come campi che il
 * modello non aveva prodotto, mentre erano nel payload.
 *
 * Il fix cerca ogni campo indipendentemente attraverso tutti i candidati,
 * nello stesso ordine di priorita'.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeItalianContentFromPayload,
  classifyBody2Payload,
  REQUIRED_IT_BODY_FIELDS,
  META_ONLY_FIELDS,
} from '../scripts/lib/body2-payload-verdict.mjs';

const BODY = {
  body1: 'Il messaggio 8412 rivede le aliquote applicate ai frontalieri residenti in Italia.',
  body2: 'La notifica trimestrale sostituisce il conguaglio annuale per i nuovi frontalieri.',
  body3: 'Chi lavora in Ticino dal 2024 rientra nel nuovo regime senza ulteriori adempimenti.',
};

test('campi sparsi su forme diverse nella stessa risposta: nessuno viene perso', () => {
  const payload = {
    // il candidato che PRIMA vinceva sul primo campo trovato…
    content: { it: { ...BODY } },
    // …e i campi che venivano scartati con lui.
    title: 'Imposta alla fonte, cosa cambia per i frontalieri',
    excerpt: 'Il messaggio 8412 rivede le aliquote e introduce una notifica trimestrale.',
  };

  const block = normalizeItalianContentFromPayload(payload, 'it', REQUIRED_IT_BODY_FIELDS);
  assert.deepEqual(block, { ...BODY, title: payload.title, excerpt: payload.excerpt });

  const { verdict, missing } = classifyBody2Payload({ parsed: payload, expectedFields: REQUIRED_IT_BODY_FIELDS });
  assert.equal(verdict, 'ok', `campi presenti nel payload riportati come mancanti: ${missing.join(', ')}`);
  assert.deepEqual(missing, []);
});

test('la priorita fra i candidati resta content[locale] > content > radice, campo per campo', () => {
  const payload = {
    content: {
      it: { title: 'dal locale' },
      excerpt: 'da content senza locale',
      body1: 'da content senza locale',
    },
    title: 'dalla radice',
    excerpt: 'dalla radice',
    body1: 'dalla radice',
  };

  const block = normalizeItalianContentFromPayload(payload, 'it', ['title', 'excerpt', 'body1']);
  assert.equal(block.title, 'dal locale');
  assert.equal(block.excerpt, 'da content senza locale');
  assert.equal(block.body1, 'da content senza locale');
});

test('un campo davvero assente resta mancante: la ricerca per campo non inventa contenuto', () => {
  // Il titolo e' PLAUSIBILE apposta (>= FIELD_MIN_CHARS.title, #786): qui si
  // misura che un campo davvero assente resti `missing`, non il floor di
  // lunghezza — un titolo da 14 char farebbe passare il test per il motivo
  // sbagliato.
  const payload = { content: { it: { title: 'Solo il titolo, e nessun excerpt' } } };

  const { verdict, missing } = classifyBody2Payload({ parsed: payload, expectedFields: META_ONLY_FIELDS });
  assert.equal(verdict, 'reject');
  assert.deepEqual(missing, ['excerpt']);
});

test('il payload di abort di REGOLA #0 resta non normalizzabile (null), non un blocco vuoto', () => {
  const abort = {
    abort_topical_relevance: true,
    content: { it: { title: null, excerpt: 'null', body1: '', body2: '  ', body3: '"null"' } },
    title: 'null',
  };

  assert.equal(normalizeItalianContentFromPayload(abort, 'it', REQUIRED_IT_BODY_FIELDS), null);
  const { verdict, missing } = classifyBody2Payload({ parsed: abort, expectedFields: REQUIRED_IT_BODY_FIELDS });
  assert.equal(verdict, 'topic-gate-abort');
  assert.deepEqual(missing, []);
});
