/**
 * follow-up #786 (da #768): il floor di plausibilita' sui campi meta.
 *
 * `normalizeItalianContentFromPayload` cerca ogni campo su TUTTI i candidati
 * (`content[locale]`, `content`, radice) e adotta la prima stringa non vuota.
 * Dopo #768 la ricerca e' per campo, quindi un `title` di tre caratteri
 * parcheggiato alla radice — o un residuo del prompt — bastava a far uscire il
 * verdetto `ok`. Sui body il danno moriva a valle sulla lunghezza
 * dell'articolo; sui META no: `title` diventa slug e canonical, e questo repo
 * pubblica senza che il sito ribuildi, quindi l'URL sbagliato e' live subito.
 *
 * Questo file pinna DUE cose:
 *
 *   1. che il floor scatti — un campo meta implausibile non esce `ok`;
 *   2. che sia DIMENSIONATO SUL CORPUS REALE e non a tavolino: i titoli e gli
 *      excerpt piu' CORTI davvero pubblicati devono passarlo. Il floor sta
 *      sotto il minimo osservato (title 16, excerpt 37 su 5.565/5.569 campi
 *      italiani, misurati il 2026-09-04): non rigetta nemmeno un articolo del
 *      corpus. Se qualcuno lo alza verso la mediana, questo test cade — ed e'
 *      il punto: rigenerare contro un modello che ha obbedito e' il danno
 *      peggiore dei due.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyBody2Payload,
  FIELD_MIN_CHARS,
  META_ONLY_FIELDS,
  REQUIRED_IT_BODY_FIELDS,
} from '../scripts/lib/body2-payload-verdict.mjs';

/** I campi meta piu' corti realmente pubblicati (content/blog-meta{,-ch}-it.ts). */
const TITOLI_CORTI_REALI = [
  'Basta complicità',
  'Lavorare alla SECO',
  'Rissa a Ponte Tresa',
  "Ristorni all'Italia",
  'Code al San Gottardo',
];
const EXCERPT_CORTI_REALI = [
  'Informazioni pratiche per frontalieri',
  'Il film di Felix Randau su Felix Kersten',
  'Le novità per i frontalieri gruisti in Ticino',
];

const EXCERPT_OK = 'Il messaggio 8412 rivede le aliquote e introduce una notifica trimestrale.';
const TITLE_OK = 'Imposta alla fonte, cosa cambia per i frontalieri';

test('il floor sta SOTTO il minimo del corpus: nessun titolo/excerpt reale verrebbe rigettato', () => {
  for (const t of TITOLI_CORTI_REALI) {
    assert.ok(
      t.trim().length >= FIELD_MIN_CHARS.title,
      `il floor title (${FIELD_MIN_CHARS.title}) rigetterebbe un titolo REALE del corpus: ${JSON.stringify(t)}`,
    );
  }
  for (const e of EXCERPT_CORTI_REALI) {
    assert.ok(
      e.trim().length >= FIELD_MIN_CHARS.excerpt,
      `il floor excerpt (${FIELD_MIN_CHARS.excerpt}) rigetterebbe un excerpt REALE del corpus: ${JSON.stringify(e)}`,
    );
  }
});

test('un title implausibile recuperato dalla radice NON esce ok', () => {
  // La forma misurata su haiku: i campi meta parcheggiati alla radice. Prima
  // del floor questo `title` diventava slug e canonical.
  const payload = { content: { it: { excerpt: EXCERPT_OK } }, title: 'ok' };

  const { verdict, missing } = classifyBody2Payload({ parsed: payload, expectedFields: META_ONLY_FIELDS });
  assert.equal(verdict, 'reject');
  assert.deepEqual(missing, [`title<${FIELD_MIN_CHARS.title}`]);
});

test('un excerpt implausibile non esce ok, e il campo viene NOMINATO nel motivo', () => {
  const payload = { content: { it: { title: TITLE_OK, excerpt: 'n/a' } } };

  const { verdict, missing } = classifyBody2Payload({ parsed: payload, expectedFields: META_ONLY_FIELDS });
  assert.equal(verdict, 'reject');
  assert.deepEqual(missing, [`excerpt<${FIELD_MIN_CHARS.excerpt}`]);
});

test('il floor vale solo sui campi CHIESTI: la meta\' body non viene giudicata su title/excerpt', () => {
  const payload = {
    content: {
      it: {
        body1: 'Il messaggio 8412 rivede le aliquote applicate ai frontalieri residenti in Italia.',
        body2: 'La notifica trimestrale sostituisce il conguaglio annuale per i nuovi frontalieri.',
        body3: 'Chi lavora in Ticino dal 2024 rientra nel nuovo regime senza ulteriori adempimenti.',
      },
    },
    // Implausibile, ma questa meta' non lo produce: non e' suo.
    title: 'ok',
  };

  const { verdict, missing } = classifyBody2Payload({
    parsed: payload,
    expectedFields: ['body1', 'body2', 'body3'],
  });
  assert.equal(verdict, 'ok', `la meta' body e' stata giudicata su un campo che non produce: ${missing.join(', ')}`);
});

test('un campo ASSENTE resta `missing`, non `<floor`: i due motivi non si confondono', () => {
  const payload = { content: { it: { title: TITLE_OK } } };

  const { missing } = classifyBody2Payload({ parsed: payload, expectedFields: META_ONLY_FIELDS });
  assert.deepEqual(missing, ['excerpt']);
});

test('il floor su body2 vive nella stessa tabella e non e\' cambiato', () => {
  // Era una costante inline (`body2<40`): sta in FIELD_MIN_CHARS perche' e' la
  // stessa domanda, e una soglia in due posti e' una soglia che diverge.
  assert.equal(FIELD_MIN_CHARS.body2, 40);

  const payload = {
    content: {
      it: {
        title: TITLE_OK,
        excerpt: EXCERPT_OK,
        body1: 'Il messaggio 8412 rivede le aliquote applicate ai frontalieri residenti in Italia.',
        body2: 'Troppo corto.',
        body3: 'Chi lavora in Ticino dal 2024 rientra nel nuovo regime senza ulteriori adempimenti.',
      },
    },
  };

  const { verdict, missing } = classifyBody2Payload({ parsed: payload, expectedFields: REQUIRED_IT_BODY_FIELDS });
  assert.equal(verdict, 'reject');
  assert.deepEqual(missing, ['body2<40']);
});
