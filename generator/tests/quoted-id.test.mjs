/**
 * quoted-id.test.mjs — il matcher delimitato che sostituisce `includes(id)`
 * nelle verifiche di rimozione (issue #785, punto 2 e i suoi gemelli).
 *
 * Cosa e' in gioco. Gli id del corpus sono `[a-z0-9-]`, quindi ognuno e' una
 * sottostringa di ogni id piu' lungo che comincia con lui. Con `includes()`:
 *
 *   - `scripts/retire-article.mjs` chiude un ritiro COMPLETATO con «RIMOZIONE
 *     PARZIALE» ed `exit 1` — cioe' il messaggio che deve segnalare il corpus
 *     spezzato viene emesso su un corpus sano, e nessuno lo sa piu' leggere;
 *   - `retired-articles-fully-removed.test.mjs` diventa rosso sullo stesso
 *     corpus, bloccando ogni PR finche' qualcuno non capisce che il test mente.
 *
 * Le asserzioni qui sotto sono simmetriche di proposito: un matcher che non
 * sbaglia mai «presente» ma perde le occorrenze VERE sarebbe peggio del
 * difetto, perche' renderebbe la verifica di rimozione un no-op silenzioso.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containsQuotedId, quotedIdRegex } from '../scripts/lib/quoted-id.mjs';

const ID = 'frontalieri-imposta-2026';

test('un id che e\' PREFISSO di un altro non e\' un residuo', () => {
  for (const src of [
    `  'frontalieri-imposta-2026-ticino': { it: 'a' },\n`,
    `  id: 'frontalieri-imposta-2026-ticino',\n`,
    `  'blog-frontalieri-imposta-2026-ticino': {},\n`,
    `  'blog.article.frontalieri-imposta-2026-ticino.title': 'x',\n`,
    `["frontalieri-imposta-2026-ticino"]`,
    `content/blog-body/it/frontalieri-imposta-2026-ticino.ts`,
  ]) {
    assert.equal(containsQuotedId(src, ID), false, `falso positivo su: ${src.trim()}`);
    assert.equal(src.includes(ID), true, 'il caso deve essere uno di quelli che `includes()` sbaglia');
  }
});

test('un id che e\' SUFFISSO di un altro non e\' un residuo', () => {
  // Il difetto simmetrico: ammettere un prefisso generico `[a-z0-9-]*-` per
  // coprire `blog-<id>` farebbe combaciare `imposta-2026` dentro
  // `frontalieri-imposta-2026`, che e' un ALTRO articolo.
  const src = `  'frontalieri-imposta-2026': { it: 'a' },\n`;
  assert.equal(containsQuotedId(src, 'imposta-2026'), false);
  assert.equal(src.includes('imposta-2026'), true);
});

test('le occorrenze VERE restano tutte rilevate, superficie per superficie', () => {
  // Se una sola di queste sfuggisse, la verifica finale di retire-article.mjs
  // diventerebbe un no-op e una rimozione parziale uscirebbe 0 — esattamente
  // il fallimento che quel passo esiste per intercettare.
  const casi = {
    'mappa slug': `  '${ID}': { it: 'a', en: 'b', de: 'c', fr: 'd' },\n`,
    registro: `    id: '${ID}',\n`,
    'union BlogArticleId': `  | '${ID}';\n`,
    'file SEO': `  'blog-${ID}': { headline: 'x' },\n`,
    'chiave i18n meta': `  'blog.article.${ID}.title': 'x',\n`,
    'ledger JSON (chiave)': `{ "${ID}": { "image": "a.jpg" } }`,
    'ledger JSON (valore)': `{ "https://x": "${ID}" }`,
    'path di un corpo': `content/blog-body/it/${ID}.ts`,
  };
  for (const [dove, src] of Object.entries(casi)) {
    assert.equal(containsQuotedId(src, ID), true, `occorrenza vera non rilevata: ${dove}`);
  }
});

test('quotedIdRegex non porta stato fra un file e l\'altro', () => {
  // Una regex condivisa con `g` trascinerebbe `lastIndex`: il secondo file
  // riprenderebbe dall'offset del primo e la seconda verifica dello stesso id
  // uscirebbe falsa. Deve essere nuova a ogni chiamata e senza `g`.
  const a = quotedIdRegex(ID);
  const b = quotedIdRegex(ID);
  assert.notEqual(a, b);
  assert.equal(a.global, false);
  const src = `'${ID}'`;
  assert.equal(a.test(src), true);
  assert.equal(a.test(src), true, 'una seconda prova sulla stessa regex deve dare lo stesso esito');
});

test('un id con caratteri di regex e\' trattato come testo', () => {
  // Gli id reali sono `[a-z0-9-]`, ma la fonte e' un file dati: un `.` non
  // deve diventare «qualsiasi carattere» e far combaciare un id diverso.
  assert.equal(containsQuotedId(`'a-b-c'`, 'a.b.c'), false);
  assert.equal(containsQuotedId(`'a.b.c'`, 'a.b.c'), true);
});
