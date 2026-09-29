/**
 * Articolo scritto tutto nel body1, body2 e body3 vuoti: invece di rigenerare
 * (run 36514673677: 181 s di Codex per riscrivere un testo gia' consegnato) il
 * verdetto lo ridivide ai titoli `##` secondo il contratto del prompt — In
 * breve e Fatti chiave nel body1, le sezioni successive in tre parti
 * consecutive — e i body divisi passano gli stessi controlli di sempre.
 * Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  classifyBody2Payload,
  normalizeItalianContentFromPayload,
  payloadWithBodies,
  splitOverflowingBody1,
} from '../scripts/lib/body2-payload-verdict.mjs';

const para = (label, words) => `${label} ${Array.from({ length: words }, (_, i) => `parola${i}`).join(' ')}.`;
const OPENING = [
  '## In breve\n- Primo punto\n- Secondo punto\n- Terzo punto',
  '## Fatti chiave\n- **Cosa**: una decisione\n- Quando: 2026',
];
const SECTIONS = [
  `## Cosa e' successo\n${para('Cronaca', 120)}`,
  `## Il contesto\n${para('Contesto', 90)}\n\n### Un dettaglio\n${para('Dettaglio', 40)}`,
  `## Cosa cambia per i frontalieri\n${para('Impatto', 110)}`,
  `## Cosa succede ora\n${para('Seguito', 100)}`,
];
const WHOLE = [...OPENING, ...SECTIONS].join('\n\n');

function payload(bodies) {
  return {
    id: 'decisione-esempio-2026',
    content: { it: { title: 'Una decisione che cambia le regole per i frontalieri', excerpt: 'Una decisione cambia le regole per i frontalieri del Ticino.', ...bodies } },
  };
}

test('divide ai titoli ##, tiene l\'apertura nel body1 e non perde ne\' sposta nulla', () => {
  const split = splitOverflowingBody1(WHOLE);
  assert.ok(split);
  assert.ok(split.body1.startsWith('## In breve'));
  assert.ok(split.body1.includes('## Fatti chiave'));
  for (const body of [split.body1, split.body2, split.body3]) assert.ok(body.trim().length > 0);
  // I ### restano dentro la loro sezione ##.
  assert.ok(!split.body2.startsWith('### ') && !split.body3.startsWith('### '));
  // Stesso testo, stesso ordine.
  assert.equal([split.body1, split.body2, split.body3].join('\n\n'), WHOLE);
});

test('senza almeno tre sezioni dopo l\'apertura non divide', () => {
  assert.equal(splitOverflowingBody1([...OPENING, ...SECTIONS.slice(0, 2)].join('\n\n')), null);
  assert.equal(splitOverflowingBody1(para('Solo testo senza titoli', 300)), null);
});

test('il verdetto salva l\'articolo intero nel body1 invece di rigenerarlo', () => {
  const parsed = payload({ body1: WHOLE, body2: '', body3: '' });
  const v = classifyBody2Payload({ parsed });
  assert.equal(v.verdict, 'ok', JSON.stringify(v.missing));
  assert.ok(v.salvagedPayload);
  // Riletto come fa il chiamante, il JSON restituito porta i body divisi.
  const reread = normalizeItalianContentFromPayload(JSON.parse(JSON.stringify(v.salvagedPayload)));
  assert.equal(reread.body1, v.itContent.body1);
  assert.equal(reread.body2, v.itContent.body2);
  assert.equal(reread.body3, v.itContent.body3);
  assert.equal(parsed.content.it.body2, '', 'il payload originale non cambia');
});

test('un payload con body2 o body3 scritti non passa dal salvataggio', () => {
  const v = classifyBody2Payload({ parsed: payload({ body1: WHOLE, body2: para('Analisi', 60), body3: '' }) });
  assert.equal(v.verdict, 'reject');
  assert.ok(v.missing.includes('body3'));
  assert.equal(v.salvagedPayload, undefined);
});

test('un body1 senza la struttura del contratto si rigenera come prima', () => {
  const v = classifyBody2Payload({ parsed: payload({ body1: para('Testo senza sezioni', 400), body2: '', body3: '' }) });
  assert.equal(v.verdict, 'reject');
  assert.deepEqual(v.missing.filter((m) => m === 'body2' || m === 'body3'), ['body2', 'body3']);
  assert.equal(v.salvagedPayload, undefined);
});

test('i body divisi finiscono nel contenitore da cui veniva il body1', () => {
  const split = splitOverflowingBody1(WHOLE);
  const root = payloadWithBodies({ title: 'T', excerpt: 'E', body1: WHOLE, body2: '', body3: '' }, split);
  assert.equal(root.body2, split.body2);
  const bare = payloadWithBodies({ content: { title: 'T', body1: WHOLE } }, split);
  assert.equal(bare.content.body3, split.body3);
});

test('il wrapper di create-article restituisce il payload salvato, non la risposta grezza', () => {
  const src = fs.readFileSync(new URL('../scripts/create-article.mjs', import.meta.url), 'utf8');
  assert.match(src, /const \{ verdict, itContent: _verdictContent, missing, salvagedPayload \} = classifyBody2Payload\(/);
  assert.match(src, /if \(salvagedPayload\) \{[\s\S]{0,400}return JSON\.stringify\(salvagedPayload\);/);
});
