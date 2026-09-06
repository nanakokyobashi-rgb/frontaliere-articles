// issue #922 (follow-up di #904) — i test diretti dello strumento che il
// censimento dei choke-point usa per VEDERE.
//
// `corpus-write-atomic.test.mjs` prova che il criterio vede ancora i nove file
// gia' pinnati (assertion `blind`). Quel campione e' l'unica prova che
// `codeOnly()` e la sorgente raggiungibile avevano, e non copre il caso per
// cui il censimento esiste: il file NUOVO, di cui nessuno conosce la risposta
// giusta. Un buco qui non fa fallire niente — rende il censimento verde
// perche' cieco, che e' il modo peggiore in cui questo strumento puo' rompersi.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codeOnly, RELATIVE_IMPORT_SPEC, createReachableSource } from './lib/reachable-source.mjs';

const BT = '`';

test('codeOnly toglie i commenti a riga intera e conserva il numero di righe', () => {
  const src = [
    '// una riga di prosa che nomina blog-body',
    "const p = 'content/x';",
    '/* blocco',
    '   che nomina dist/api */',
    "const q = 'ok';",
  ].join('\n');
  const out = codeOnly(src);
  assert.equal(out.split('\n').length, src.split('\n').length,
    'il numero di righe deve restare identico: il censimento non deve mai '
    + 'saldare due righe in una');
  assert.doesNotMatch(out, /blog-body/);
  assert.doesNotMatch(out, /dist\/api/);
  assert.match(out, /content\/x/);
  assert.match(out, /'ok'/);
});

test('codeOnly conserva il codice a destra di un blocco che chiude a meta\' riga', () => {
  // La versione precedente azzerava l'INTERA riga se il `trim()` iniziava con
  // `/*`, quindi un `/* nota */ const p = corpusPath(id)` spariva con tutto il
  // suo codice: una perdita silenziosa, esattamente la direzione che il
  // criterio dichiara di non voler prendere.
  const out = codeOnly("/* nota */ const p = corpusPath(id);");
  assert.match(out, /corpusPath\(id\)/,
    'il codice dopo la chiusura del blocco non deve sparire con il commento');
});

test('codeOnly chiude un blocco aperto a meta\' riga', () => {
  // Speculare al caso sopra: prima `inBlock` si armava solo se il `trim()`
  // iniziava con `/*`, quindi un blocco aperto in coda a una riga di codice non
  // veniva mai aperto — e la sua prosa restava dentro come se fosse codice.
  const src = [
    "const q = 1; /* apre qui",
    '   e nomina blog-body',
    '*/',
    "const p = 'visibile';",
  ].join('\n');
  const out = codeOnly(src);
  assert.doesNotMatch(out, /blog-body/,
    'la prosa di un blocco aperto a meta\' riga non e\' codice');
  assert.match(out, /const q = 1;/);
  assert.match(out, /'visibile'/);
});

test('codeOnly non tocca le righe dentro un template literal', () => {
  // #922 item 4, il caso che fa danno: questi script emettono il corpo `.ts`
  // del corpus VIA template literal. Una riga emessa che inizia con `//` o con
  // `/*` veniva azzerata come prosa, e con lei spariva un match VERO — un
  // choke-point nuovo usciva dal censimento in silenzio.
  const src = [
    'const body = ' + BT + 'export const meta = {',
    '  // path: content/services/locales/blog-body/it/x.ts',
    '  /* anche questo finisce nel file emesso */',
    "  target: 'blog-body',",
    '};' + BT + ';',
  ].join('\n');
  const out = codeOnly(src);
  assert.match(out, /blog-body\/it\/x\.ts/,
    'una riga dentro un backtick non e\' un commento: e\' testo emesso');
  assert.match(out, /anche questo finisce nel file emesso/);
  assert.match(out, /target: 'blog-body'/);
});

test('codeOnly riprende a togliere commenti dopo la chiusura del template', () => {
  const src = [
    'const body = ' + BT + '// dentro: blog-body' + BT + ';',
    '// fuori: dist/api',
    "const p = 'coda';",
  ].join('\n');
  const out = codeOnly(src);
  assert.match(out, /dentro: blog-body/, 'il template non e\' prosa');
  assert.doesNotMatch(out, /fuori: dist\/api/,
    'chiuso il backtick, il commento a riga intera torna prosa');
  assert.match(out, /'coda'/);
});

test('codeOnly non perde la sincronia su un backtick dentro un\'interpolazione', () => {
  // Il caso trovato su `create-article.mjs`: dentro `${…}` si torna a CODICE, e
  // li' un backtick puo' stare dentro una stringa o dentro una regex
  // (`/[#>*`_~-]+/`). Contandolo come toggle, il resto del file finiva "dentro
  // un template" e un centinaio di righe di commento veniva letto come testo
  // emesso — falsi positivi a valanga sul criterio.
  const src = [
    'const body = ' + BT + 'testo ${flag ? \'con un ' + BT + ' dentro\' : \'\'} coda' + BT + ';',
    '// prosa che nomina blog-body',
    "const p = 'coda';",
  ].join('\n');
  const out = codeOnly(src);
  assert.doesNotMatch(out, /prosa che nomina/,
    "il template si chiude dove si chiude davvero: dentro `${…}` si torna a "
    + 'codice, e un backtick in una stringa li\' non e\' un toggle');
  assert.match(out, /'coda'/);
});

test('codeOnly non si fa aprire un template da un backtick dentro una stringa', () => {
  const src = [
    "const tick = '" + BT + "';",
    '// prosa che nomina blog-body',
    "const p = 'coda';",
  ].join('\n');
  const out = codeOnly(src);
  assert.doesNotMatch(out, /prosa che nomina/,
    'un backtick dentro una stringa non apre un template literal');
  assert.match(out, /'coda'/);
});

test('codeOnly lascia intatta una riga di codice con un URL o un commento in coda', () => {
  // Conservativo di proposito: il commento in coda resta dentro, e con lui il
  // falso positivo. Il costo dei due errori non e' simmetrico — togliere
  // troppo perde un choke-point vero in silenzio.
  const src = "const u = 'https://esempio.test/x'; // nota in coda";
  const out = codeOnly(src);
  assert.match(out, /https:\/\/esempio\.test\/x/,
    'il `//` dentro una stringa non apre un commento');
  assert.match(out, /nota in coda/, 'il commento in coda resta: e\' la scelta conservativa');
});

test('RELATIVE_IMPORT_SPEC aggancia import statici, dinamici, di solo effetto e require relativi', () => {
  const src = [
    "import { a } from './lib/uno.mjs';",
    "export { b } from '../due.mjs';",
    "const m = await import('./lib/tre.mjs');",
    'const n = await import(',
    "  './lib/quattro.mjs');",
    "const r = require('./cinque.mjs');",
    "import './sei.mjs';",
    'import fs from \'node:fs\';',
    "import { z } from 'zod';",
    'const dyn = await import(specifierVariabile);',
  ].join('\n');
  const specs = [...src.matchAll(RELATIVE_IMPORT_SPEC)].map((m) => m[1]);
  assert.deepEqual(specs, [
    './lib/uno.mjs',
    '../due.mjs',
    './lib/tre.mjs',
    './lib/quattro.mjs',
    './cinque.mjs',
    './sei.mjs',
  ], 'i builtin, i pacchetti npm e gli specificatori calcolati restano fuori; '
    + 'gli import dinamici NO — erano meta\' delle forme in circolazione');
});

const mkTree = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'censimento-'));
  for (const [rel, src] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, rel), src);
  }
  return dir;
};

test('la sorgente raggiungibile segue anche un import dinamico', () => {
  // #922 item 1: la forma esiste gia' nel repo (`load-rc-env.mjs`). Un
  // choke-point che raggiungesse per import dinamico il modulo che definisce il
  // path pubblicato usciva dal censimento in silenzio — meta' del buco che #571
  // voleva chiudere, ancora aperto.
  const dir = mkTree({
    'root.mjs': "const p = await import('./paths.mjs');\nwriteFileSync(p.target, '');",
    'paths.mjs': "export const target = 'content/services/locales/blog-body/it/x.ts';",
  });
  const reachable = createReachableSource();
  assert.match(reachable(path.join(dir, 'root.mjs')), /blog-body/,
    'un import dinamico relativo deve entrare nella sorgente raggiungibile '
    + 'come uno statico');
});

test('un ciclo di import non tronca la sorgente per gli altri importatori', () => {
  // #922 item 2. A→B→A: la visita che parte da A calcola per B il combinato
  // `srcB + ''`, perche' il ritorno su A e' il taglio del ciclo. Prima quella
  // voce troncata finiva in cache per B, e ogni ALTRO root che passava da B si
  // portava a casa una sorgente senza il letterale definito in A — invisibile,
  // e senza un solo carattere di rumore.
  const dir = mkTree({
    'a.mjs': "import { b } from './b.mjs';\nexport const target = 'content/services/locales/blog-body/it/x.ts';",
    'b.mjs': "import { target } from './a.mjs';\nexport const b = target;",
    'altro.mjs': "import { b } from './b.mjs';\nwriteFileSync(b, '');",
  });
  const reachable = createReachableSource();
  // L'ordine conta: e' la visita da `a.mjs` a popolare la cache di `b.mjs`.
  reachable(path.join(dir, 'a.mjs'));
  assert.match(reachable(path.join(dir, 'altro.mjs')), /blog-body/,
    'il taglio del ciclo non deve essere cacheato addosso a chi lo ha subito: '
    + 'il censimento resterebbe cieco su ogni importatore di quel modulo');
});

test('la cache resta condivisa fra rami fratelli che passano dallo stesso modulo', () => {
  // La contro-prova del fix sopra: il caso che `ancestors` come stack (e non
  // come set che cresce) esisteva per proteggere. A importa B e C, entrambi
  // importano D: D non deve risultare troncato sul secondo ramo.
  const dir = mkTree({
    'a.mjs': "import './b.mjs';\nimport './c.mjs';",
    'b.mjs': "import './d.mjs';",
    'c.mjs': "import './d.mjs';",
    'd.mjs': "export const target = 'dist/api/manifest.json';",
  });
  const reachable = createReachableSource();
  reachable(path.join(dir, 'a.mjs'));
  assert.match(reachable(path.join(dir, 'c.mjs')), /dist\/api/,
    'un modulo condiviso raggiunto da due rami fratelli non e\' un ciclo');
});
