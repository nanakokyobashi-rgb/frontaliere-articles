/**
 * numeric-override-gates.test.mjs — un override numerico illeggibile deve
 * DEGRADARE AL DEFAULT gridandolo, mai spegnere la regola che governa.
 *
 * ## Il difetto, misurato (issue #871)
 *
 * `Number(process.env.X || d)` sembra difensivo e non lo è. Tre leve di questo
 * repo lo usavano, e ciascuna produceva un guasto VERDE — la passata riusciva,
 * il canale era spento:
 *
 *   · `STRANDED_AFTER_DAYS=tre` → `NaN` → `ageDays >= NaN` è sempre falso →
 *     la classe `stranded-twin` non viene più emessa. È l'unico canale che
 *     intercetta un gemello `identical` fermo che nessun trasporto porterà.
 *   · `BLOG_INDEX_LIMIT=-5` → `Number('-5') || 150` vale `-5` (il `||` copre
 *     `NaN`, `0` e `''`, non un negativo) → `entries.slice(0, -5)` → l'indice
 *     fast-path PUBBLICATO con le cinque voci più recenti in meno, accettato
 *     dal sito senza errore.
 *   · un tetto FRAZIONARIO: `TRANSPORT_MAX_FILES=0.5` passa il test "positivo"
 *     e poi `slice(0, 0.5)` è `slice(0, 0)` — zero copie, «niente da portare».
 *
 * ## Cosa pinna questo file
 *
 * Il comportamento dell'helper condiviso, e il fatto che i tre punti lo USINO.
 * La seconda metà è un pin sul sorgente apposta: la regressione che si teme non
 * è che l'helper smetta di funzionare, è che qualcuno riscriva un
 * `Number(process.env.…)` a mano nel punto quattro. Un test sul solo helper
 * resterebbe verde mentre il buco si riapre altrove — esattamente la forma di
 * guasto che questi tre casi descrivono.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parsePositiveNum } from '../../scripts/lib/parse-positive-num.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Raccoglie i `::warning::` invece di stamparli. */
const collect = () => {
  const seen = [];
  return { warn: (m) => seen.push(m), seen };
};

test('un valore illeggibile torna al default E lo dice', () => {
  const { warn, seen } = collect();
  assert.equal(parsePositiveNum('tre', 3, { label: 'STRANDED_AFTER_DAYS', warn }), 3);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^::warning::/);
  assert.match(seen[0], /STRANDED_AFTER_DAYS=tre/);
  assert.match(seen[0], /NON e' attivo/);
});

test('un negativo non è un override valido: era il caso che il `||` lasciava passare', () => {
  const { warn, seen } = collect();
  assert.equal(parsePositiveNum('-5', 150, { label: 'BLOG_INDEX_LIMIT', warn }), 150);
  assert.equal(seen.length, 1, 'un negativo deve gridare quanto un NaN');
  // La forma vecchia, per memoria di cosa si sta impedendo.
  assert.equal(Number('-5') || 150, -5);
  assert.deepEqual([1, 2, 3, 4, 5, 6].slice(0, -5), [1]);
});

test('`integer` chiude il buco del valore POSITIVO che spegne comunque', () => {
  const { warn, seen } = collect();
  // `0.5 > 0` è vero: senza `integer` questo valore passa, e poi `slice` lo
  // tronca a zero. Il canale si spegne con un override "valido".
  assert.equal(parsePositiveNum('0.5', 25, { label: 'TRANSPORT_MAX_FILES', warn, integer: true }), 25);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /numero intero positivo/);
  assert.deepEqual([1, 2, 3].slice(0, 0.5), []);
  // Senza `integer` una frazione resta lecita: `TRANSPORT_MAX_FAILURE_RATIO`
  // e ogni altra soglia frazionaria non devono essere rotte da questa regola.
  assert.equal(parsePositiveNum('0.5', 25, { label: 'X', warn: () => {} }), 0.5);
});

test('assente o stringa vuota resta SILENZIOSO: lì il default è la risposta giusta', () => {
  const { warn, seen } = collect();
  assert.equal(parsePositiveNum(undefined, 3, { label: 'X', warn }), 3);
  assert.equal(parsePositiveNum('', 3, { label: 'X', warn }), 3);
  assert.equal(parsePositiveNum('  ', 3, { label: 'X', warn }), 3);
  assert.equal(seen.length, 0, 'nessuna intenzione tradita: non c’era nessun override');
});

test('i sentinel restano una scelta del chiamante, non una regola globale', () => {
  const { warn, seen } = collect();
  assert.equal(parsePositiveNum('-1', 3, { label: '--gate', warn, sentinels: [-1] }), -1);
  assert.equal(parsePositiveNum('-1', 40, { label: '--lookback-min', warn }), 40);
  assert.equal(seen.length, 1, 'il -1 non dichiarato deve gridare, quello dichiarato no');
});

test('STRANDED_AFTER_DAYS=tre non fa più sparire `stranded-twin`', () => {
  // Il caso vero, in un processo a parte: la costante è valutata all'import,
  // quindi l'env va impostato PRIMA. Un gemello `identical` fermo da 10 giorni
  // deve restare `stranded` anche con la leva scritta a parole.
  const mod = new URL('../../scripts/ci/loop-drift-check.mjs', import.meta.url).href;
  const src = `
    import('${mod}').then((m) => {
      const now = Date.parse('2026-09-05T00:00:00Z');
      console.log(JSON.stringify(m.strandedVerdict({
        mode: 'identical',
        state: 'site-ahead',
        baselineLastSeenAt: '2026-08-26T00:00:00Z',
        nowMs: now,
      })));
    });
  `;
  const run = (env) => JSON.parse(
    execFileSync(process.execPath, ['-e', src], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim(),
  );

  assert.equal(run({}).stranded, true, 'senza override: 10 giorni > 3');
  assert.equal(run({ STRANDED_AFTER_DAYS: 'tre' }).stranded, true, 'con NaN il canale deve restare ACCESO sul default');
  assert.equal(run({ STRANDED_AFTER_DAYS: '30' }).stranded, false, 'un override valido continua a valere');
});

test('i punti che leggono un numero da env passano dall’helper condiviso', () => {
  const sites = [
    ['scripts/ci/loop-drift-check.mjs', ['STRANDED_AFTER_DAYS', 'PROVENANCE_HISTORY_CAP']],
    ['scripts/build-blog-index.mjs', ['BLOG_INDEX_LIMIT']],
    ['scripts/ci/transport-identical-twins.mjs', ['TRANSPORT_MAX_FILES']],
  ];
  for (const [rel, vars] of sites) {
    const src = read(rel);
    assert.match(src, /parsePositiveNum/, `${rel} deve usare l’helper condiviso`);
    for (const v of vars) {
      assert.doesNotMatch(
        src,
        new RegExp(`Number\\(\\s*process\\.env\\.${v}`),
        `${rel}: ${v} è tornato a un \`Number(process.env.…)\` a mano — è il buco di #871`,
      );
      assert.match(src, new RegExp(`parsePositiveNum\\(process\\.env\\.${v}`), `${rel}: ${v} deve passare dall’helper`);
    }
  }
});

test('l’helper ha UNA sola definizione in tutto il repo', () => {
  // Tre validazioni copiaincollate coprono tre casi e non il quarto che nasce
  // domani: `scan-failed-runs.mjs` la RI-ESPORTA, non la ridefinisce.
  const lib = read('scripts/lib/parse-positive-num.mjs');
  assert.match(lib, /export function parsePositiveNum/);
  assert.match(
    read('scripts/ci/scan-failed-runs.mjs'),
    /export \{ parsePositiveNum \} from '\.\.\/lib\/parse-positive-num\.mjs';/,
    'la vecchia sede deve ri-esportare, non tenere una seconda copia',
  );
  assert.doesNotMatch(read('scripts/ci/scan-failed-runs.mjs'), /export function parsePositiveNum/);
});
