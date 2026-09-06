/**
 * anchored-slice.mjs — ritagli di sorgente ancorati che FALLISCONO quando
 * l'ancora non c'e'.
 *
 * ## Perche' esiste
 *
 * Mezza suite legge un sorgente come testo e ne ritaglia una regione con
 * `src.slice(src.indexOf(ancora), ...)`, poi asserisce che quella regione NON
 * contenga qualcosa. E' il pattern giusto: pinna il comportamento dove sta,
 * non su tutto il file. Ma `indexOf` di un'ancora assente non e' un errore,
 * e' `-1`:
 *
 * - `src.slice(-1)` restituisce **un carattere**;
 * - `src.slice(a, -1)` toglie l'ultimo carattere;
 * - `src.slice(a, b)` con `b < a` restituisce **la stringa vuota**.
 *
 * Su una regione vuota o di un carattere, ogni `assert.doesNotMatch`,
 * `assert.ok(!…)` e `.not.toMatch` passa. Il test resta VERDE esattamente nel
 * caso che deve prendere: qualcuno ha rinominato la funzione o lo step, la
 * regione non esiste piu', e il pin e' evaporato in silenzio (#974, item 2 —
 * misurato su `build-api-manifest-counts.test.mjs`).
 *
 * Il guard `at >= 0` scritto a mano a ogni chiamata sarebbe la stessa
 * costante ripetuta decine di volte (AGENTS.md #6): sta qui, una volta.
 *
 * ## Nota su `sliceBetween`
 *
 * L'ancora finale si cerca **dopo** quella iniziale, non da zero. Cercarla da
 * zero e' l'altra meta' dello stesso bug: se compare prima, `slice` produce la
 * stringa vuota invece di segnalare che le due ancore sono nell'ordine
 * sbagliato (vedi il commento in `rewire-json-contracts.test.mjs`).
 */

/**
 * Indice di `needle` in `src`, o un errore diagnosticabile se manca.
 * `label` compare nel messaggio: serve a dire QUALE ritaglio si e' rotto
 * quando lo stesso sorgente ha piu' ancore.
 */
export function anchorIndex(src, needle, { from = 0, label = '' } = {}) {
  const at = src.indexOf(needle, from);
  if (at < 0) {
    throw new Error(
      `ancora assente${label ? ` (${label})` : ''}: ${JSON.stringify(needle)} non compare nel sorgente` +
        `${from ? ` dopo l'offset ${from}` : ''}. Il ritaglio sarebbe degenerato e le assertion negative su di esso sarebbero passate a vuoto.`,
    );
  }
  return at;
}

/**
 * `src` dall'ancora `from` in poi. `offset` sposta l'inizio (puo' essere
 * negativo per prendere anche il contesto che precede l'ancora) e viene
 * clampato a 0, cosi' non si trasforma mai in un indice negativo — che
 * `slice` interpreterebbe come "dalla fine".
 */
export function sliceFrom(src, from, { offset = 0, label = '' } = {}) {
  return src.slice(Math.max(0, anchorIndex(src, from, { label }) + offset));
}

/**
 * La regione fra le due ancore, estremo finale escluso. Entrambe devono
 * esistere, e `to` deve venire dopo `from`.
 */
export function sliceBetween(src, from, to, { label = '' } = {}) {
  const start = anchorIndex(src, from, { label });
  const end = anchorIndex(src, to, { from: start + from.length, label });
  return src.slice(start, end);
}

/**
 * `src` dall'inizio fino all'ancora `to`, esclusa. La meta' speculare di
 * `sliceFrom`: `src.slice(0, -1)` di un'ancora assente toglie **un carattere**
 * e restituisce quasi tutto il file, che e' il modo piu' silenzioso di
 * annullare un ritaglio.
 */
export function sliceUntil(src, to, { label = '' } = {}) {
  return src.slice(0, anchorIndex(src, to, { label }));
}
