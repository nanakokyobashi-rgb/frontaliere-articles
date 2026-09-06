/**
 * retire-article-leftover-check.test.mjs — la verifica finale di
 * `scripts/retire-article.mjs` distingue l'id da un id che lo CONTIENE.
 *
 * ## Il difetto che sorveglia
 *
 * Al passo 12 lo script rilegge le superfici da disco e, se l'id compare
 * ancora, esce 1 con `RIMOZIONE PARZIALE`. La verifica deve restare larga —
 * a servire è proprio il residuo che nessuno si aspetta — ma con un
 * `includes(id)` nudo era anche indiscriminata: gli id si annidano
 * (`frontalieri-disoccupazione-svizzera-2026` contiene
 * `disoccupazione-svizzera-2026`, ed è già così nel corpus), quindi ritirare
 * l'id corto su una superficie che ospita il lungo gridava `RIMOZIONE
 * PARZIALE` su una rimozione in realtà completa — dopo aver già scritto tutto,
 * e con una issue di workflow aperta su un corpus sano.
 *
 * È la stessa classe del needle nudo di `registerLockTargets()`
 * (`generator/tests/register-lock.test.mjs`), con l'esito opposto: là il falso
 * `present` nasconde uno split, qui il falso leftover ne inventa uno.
 *
 * ## Perché la funzione si estrae dal sorgente
 *
 * `retire-article.mjs` chiama `main()` a fine file: importarlo lo eseguirebbe.
 * Come in `register-lock.test.mjs`, il corpo si estrae dal sorgente e si
 * istanzia con `new Function`, così ciò che il test esegue è la funzione VERA
 * e non una sua copia destinata a divergere.
 *
 * Lancia con:
 *   node --test generator/tests/retire-article-leftover-check.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = readFileSync(path.join(ROOT, 'scripts/retire-article.mjs'), 'utf-8');

function loadMentionsId() {
  const header = 'function mentionsId(text, id) {';
  const start = SRC.indexOf(header);
  assert.notEqual(start, -1, 'mentionsId non trovata in scripts/retire-article.mjs: aggiornare questo test');
  const rest = SRC.slice(start);
  const endRel = rest.search(/\n\}\n/);
  assert.notEqual(endRel, -1, 'chiusura di mentionsId non trovata');
  return new Function(`${rest.slice(0, endRel + 2)}\nreturn mentionsId;`)();
}

const ID = 'disoccupazione-svizzera-2026';
const LONGER = `frontalieri-${ID}`;

test('la verifica finale non scambia un id piu\' lungo per un residuo', () => {
  const mentionsId = loadMentionsId();
  // Le forme reali con cui l'id LUNGO vive sulle superfici: riga slug,
  // proprieta' del registro, chiave SEO, chiave i18n, membro della union,
  // chiave/valore dei ledger JSON. Nessuna di queste e' un residuo dell'id
  // corto, e nessuna deve far uscire 1 lo script.
  for (const text of [
    `  '${LONGER}': { it: 'x', en: 'x', de: 'x', fr: 'x' },\n`,
    `    id: '${LONGER}',\n`,
    `  'blog-${LONGER}': {\n`,
    `'blog.article.${LONGER}.title': 'x',\n`,
    `type _BlogId9 = | 'altro' | '${LONGER}';\n`,
    `{ "${LONGER}": "https://example.org/foto.jpg" }\n`,
    `{ "https://example.org/news/x": "${LONGER}" }\n`,
  ]) {
    assert.equal(mentionsId(text, ID), false, `falso residuo su: ${text.trim()}`);
  }
});

test('la verifica finale vede ancora il residuo VERO, in ogni forma scritta', () => {
  const mentionsId = loadMentionsId();
  // L'altra meta': un needle che non matcha mai passerebbe il test qui sopra
  // e trasformerebbe il gate in decorazione. Ognuna di queste e' una rimozione
  // lasciata a meta', e deve continuare a uscire 1.
  for (const text of [
    `  '${ID}': { it: 'x', en: 'x', de: 'x', fr: 'x' },\n`,
    `    id: '${ID}',\n`,
    `  'blog-${ID}': {\n`,
    `'blog.article.${ID}.title': 'x',\n`,
    `type _BlogId9 = | 'altro' | '${ID}';\n`,
    `{ "${ID}": "https://example.org/foto.jpg" }\n`,
    `{ "https://example.org/news/x": "${ID}" }\n`,
    // Anche mescolato all'id lungo nello stesso file: e' il caso reale di una
    // rimozione parziale su una superficie che ospita entrambi.
    `  '${LONGER}': { it: 'x' },\n  '${ID}': { it: 'x' },\n`,
  ]) {
    assert.equal(mentionsId(text, ID), true, `residuo non visto in: ${text.trim()}`);
  }
});
