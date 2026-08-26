/**
 * expect-shim.mjs — sottoinsieme minimo dell'API `expect` di vitest, sopra
 * node:assert. (manifest: `corpus-only`)
 *
 * ## Perché esiste
 *
 * Le suite dei gate di qualità degli articoli (article-factuality-gates,
 * article-locale-gates, article-fabrication-guard, ...) arrivano dal sito
 * valerielinc-ops/frontaliere-si-o-no, dove girano sotto vitest. Questo repo
 * non ha vitest e non deve averlo: `tests.yml` e `generator-ci.yml` girano
 * `node --test` senza `npm ci`, di proposito (vedi i commenti in quei
 * workflow). Riscrivere ~1.600 righe di assert in stile node:assert avrebbe
 * reso ogni futuro riallineamento col sito un diff illeggibile; questo shim
 * lascia i corpi dei test quasi byte-identici all'originale, così un
 * aggiornamento della suite sul sito si riporta qui come copia + le 4 righe
 * di intestazione.
 *
 * ## Cosa implementa
 *
 * SOLO i matcher che le suite portate usano davvero (censiti sul sorgente del
 * sito, 2026-08-08): toBe, toEqual, toContain, toBeNaN, toMatch, toBeCloseTo,
 * toBeTruthy, toBeDefined, toBeGreaterThan(OrEqual), toBeLessThan,
 * toHaveLength, toThrow, e `.not` per TUTTI i matcher. (Questa riga diceva «`.not` per
 * toBe/toContain» ed era piu' restrittiva dell'implementazione: `.not` non e'
 * cablato per matcher, ricostruisce l'oggetto con `negated: true` e ogni
 * matcher passa da `maybe()`. Verificato portando article-sanitizers, che usa
 * `.not.toMatch` 15 volte: 39/39 verdi.) Un matcher non implementato
 * lancia TypeError (undefined is not a function): un test che ne usasse uno
 * nuovo fallisce rumorosamente invece di passare in silenzio.
 *
 * Semantica intenzionalmente allineata a vitest dove le suite ci contano:
 *  - `expect(valore, messaggio)`: il secondo argomento finisce nel messaggio
 *    di errore (usato dai gate per nominare il file/locale offender);
 *  - `toContain` su stringa = substring, su array/Set/iterabile = membership
 *    (le suite portate lo usano sui Set di extractSourceAnchors);
 *  - `toEqual` = uguaglianza strutturale (assert.deepStrictEqual: i casi
 *    portati confrontano array/stringhe/numeri, mai oggetti con `undefined`);
 *  - `toBeCloseTo(x, p=2)` = |actual-x| < 10^-p / 2, come vitest.
 */
import assert from 'node:assert/strict';

function fail(message, actual, expected, operator) {
  throw new assert.AssertionError({ message, actual, expected, operator });
}

function describeValue(v) {
  if (typeof v === 'string') return JSON.stringify(v.length > 200 ? v.slice(0, 200) + '…' : v);
  try {
    const s = JSON.stringify(v);
    return s && s.length > 200 ? s.slice(0, 200) + '…' : s;
  } catch {
    return String(v);
  }
}

function makeMatchers(actual, message, negated) {
  const prefix = message ? `${message}: ` : '';
  const maybe = (condition, describe) => {
    if (negated ? condition : !condition) {
      fail(`${prefix}expected ${describeValue(actual)} ${negated ? 'NOT ' : ''}${describe}`, actual);
    }
  };

  const matchers = {
    toBe(expected) {
      maybe(Object.is(actual, expected), `to be ${describeValue(expected)}`);
    },
    toEqual(expected) {
      let equal = true;
      try {
        assert.deepStrictEqual(actual, expected);
      } catch {
        equal = false;
      }
      maybe(equal, `to deeply equal ${describeValue(expected)}`);
    },
    toContain(item) {
      // Come vitest/jest: substring sulle stringhe, membership su array e su
      // qualunque iterabile (le suite passano dei Set — extractSourceAnchors).
      let holds;
      if (typeof actual === 'string') holds = actual.includes(item);
      else if (Array.isArray(actual)) holds = actual.includes(item);
      else if (actual instanceof Set) holds = actual.has(item);
      else if (actual != null && typeof actual[Symbol.iterator] === 'function') {
        holds = Array.from(actual).includes(item);
      } else holds = false;
      maybe(holds, `to contain ${describeValue(item)}`);
    },
    toBeNaN() {
      maybe(Number.isNaN(actual), 'to be NaN');
    },
    toMatch(re) {
      const holds = typeof re === 'string' ? String(actual).includes(re) : re.test(actual);
      maybe(holds, `to match ${re}`);
    },
    toBeCloseTo(expected, precision = 2) {
      maybe(
        Math.abs(actual - expected) < Math.pow(10, -precision) / 2,
        `to be close to ${expected} (precision ${precision})`,
      );
    },
    toBeTruthy() {
      maybe(Boolean(actual), 'to be truthy');
    },
    toBeDefined() {
      maybe(actual !== undefined, 'to be defined');
    },
    toBeGreaterThan(n) {
      maybe(actual > n, `to be > ${n}`);
    },
    toBeGreaterThanOrEqual(n) {
      maybe(actual >= n, `to be >= ${n}`);
    },
    toBeLessThan(n) {
      maybe(actual < n, `to be < ${n}`);
    },
    toHaveLength(n) {
      maybe(actual != null && actual.length === n,
        `to have length ${n} (got ${actual == null ? actual : actual.length})`);
    },
    toThrow(expected) {
      // `actual` è la funzione da invocare, non il valore da confrontare —
      // come vitest, a differenza di ogni altro matcher qui sopra.
      let threw = false;
      let error;
      try {
        actual();
      } catch (e) {
        threw = true;
        error = e;
      }
      if (expected === undefined) {
        maybe(threw, 'to throw');
        return;
      }
      const msg = error != null ? (error.message !== undefined ? error.message : String(error)) : '';
      const matches = threw && (expected instanceof RegExp ? expected.test(msg) : msg.includes(expected));
      maybe(matches, threw
        ? `to throw matching ${describeValue(expected)} (got: ${describeValue(msg)})`
        : `to throw matching ${describeValue(expected)} (did not throw)`);
    },
  };
  if (!negated) {
    Object.defineProperty(matchers, 'not', {
      get: () => makeMatchers(actual, message, true),
    });
  }
  return matchers;
}

export function expect(actual, message) {
  return makeMatchers(actual, message, false);
}
