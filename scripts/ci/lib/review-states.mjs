/**
 * review-states.mjs — l'UNICA definizione degli stati di una review GitHub
 * che il ciclo agentico del corpus sa interpretare (#1762).
 *
 * GitHub dichiara cinque valori per `review.state`. Tre sono verdetti
 * terminali; `PENDING` (bozza non inviata) e `DISMISSED` (verdetto ritirato)
 * non lo sono e non possono mai fare da review azionabile. Un valore che non
 * compare qui — un enum nuovo, una stringa vuota, un tipo diverso — e' uno
 * schema che il ciclo non conosce: FAIL-CLOSED, mai «non e' PENDING quindi
 * vale». La forma precedente `(.state // "") != "PENDING" and != "DISMISSED"`
 * trattava proprio quel caso come una review valida.
 *
 * Stessa semantica di `KNOWN_REVIEW_STATES` nel modulo `pr-review-admission`
 * del sito (valerielinc-ops/frontaliere-si-o-no, che questo repo non ha),
 * senza il `trim().toUpperCase()`: qui il confronto e' esatto, come
 * lo sono gli `.state == "COMMENTED"` dei workflow, cosi' un valore
 * non canonico e' sconosciuto invece che promosso.
 *
 * I workflow selezionano le review con jq inline, che non puo' importare
 * questo modulo: le definizioni jq sono quindi GENERATE qui
 * (`REVIEW_STATE_JQ_DEFS`) e `generator/tests/review-state-normalization.test.mjs`
 * esige che ogni programma jq dei workflow che le usa le contenga identiche.
 * Un valore condiviso, una sorgente (AGENTS.md #6).
 */

export const TERMINAL_REVIEW_STATES = Object.freeze(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED']);
export const NON_TERMINAL_REVIEW_STATES = Object.freeze(['PENDING', 'DISMISSED']);
export const KNOWN_REVIEW_STATES = Object.freeze([
  ...TERMINAL_REVIEW_STATES,
  ...NON_TERMINAL_REVIEW_STATES,
]);

export function isKnownReviewState(state) {
  return typeof state === 'string' && KNOWN_REVIEW_STATES.includes(state);
}

/** Verdetto inviato e non ritirato. Uno stato sconosciuto non lo e' mai. */
export function isTerminalReviewState(state) {
  return typeof state === 'string' && TERMINAL_REVIEW_STATES.includes(state);
}

const jqStrings = (states) => states.map((state) => JSON.stringify(state)).join(', ');

/**
 * Le due righe `def` che ogni programma jq dei workflow copia alla lettera.
 * `review_state_known` alimenta il pre-controllo fail-closed (con log
 * esplicito nel chiamante); `review_state_terminal` e' il solo filtro di
 * selezione ammesso.
 */
export const REVIEW_STATE_JQ_DEFS = Object.freeze([
  `def review_state_known: (.state | type) == "string" and (.state | IN(${jqStrings(KNOWN_REVIEW_STATES)}));`,
  `def review_state_terminal: review_state_known and (.state | IN(${jqStrings(TERMINAL_REVIEW_STATES)}));`,
]);
