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
 * ## Perché la funzione sta in un modulo a parte
 *
 * `retire-article.mjs` chiama `main()` a fine file: importarlo lo eseguirebbe.
 * Ma la stessa regola serve a un secondo chiamante — il gate di PR
 * `retired-articles-fully-removed.test.mjs`, che rilegge le stesse superfici —
 * e una seconda copia è il modo garantito per farle divergere. Quindi la
 * funzione vive in `scripts/lib/mentions-id.mjs`, questo file la importa da lì
 * (nessuna estrazione, nessuna copia) e l'ultimo caso verifica che i due
 * chiamanti non se la siano ri-scritta in casa.
 *
 * Lancia con:
 *   node --test generator/tests/retire-article-leftover-check.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mentionsId } from '../../scripts/lib/mentions-id.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** I chiamanti della regola: devono usarla, non ri-scriverla. */
const CALLERS = [
  'scripts/retire-article.mjs',
  'generator/tests/retired-articles-fully-removed.test.mjs',
];

const ID = 'disoccupazione-svizzera-2026';
const LONGER = `frontalieri-${ID}`;

test('la verifica finale non scambia un id piu\' lungo per un residuo', () => {
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

test('la regola ha una sorgente sola: nessun chiamante se la ri-scrive', () => {
  // Il difetto che questo caso ferma non è un falso residuo, è la DERIVA: la
  // verifica finale dello script e il gate di PR guardano le stesse superfici,
  // e finché la regola è una sola i due casi qui sopra parlano per entrambi.
  // Una copia locale in uno dei due li scollegherebbe in silenzio.
  for (const rel of CALLERS) {
    const src = readFileSync(path.join(ROOT, rel), 'utf-8');
    assert.match(
      src,
      /import \{ mentionsId \} from '[^']*lib\/mentions-id\.mjs'/,
      `${rel}: non importa mentionsId da scripts/lib/mentions-id.mjs`,
    );
    assert.doesNotMatch(
      src,
      /function mentionsId\s*\(/,
      `${rel}: ri-definisce mentionsId invece di importarla — due copie della `
      + 'stessa regola divergono, ed è esattamente il difetto per cui il modulo esiste.',
    );
    assert.doesNotMatch(
      src,
      /readSurface\([^)]*\)\.includes\(id\)|\bread\(f\)\.includes\(id\)/,
      `${rel}: includes(id) nudo su una superficie — un id annidato inventa un residuo.`,
    );
  }
});
