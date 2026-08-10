/**
 * loop-drift-check-classify.test.mjs — pinna il grado `corpus-only-pending`
 * (issue #125) nella funzione che decide `actionable`.
 *
 * ## Cosa chiude
 *
 * `corpus-only` dice "non esiste sul sito" senza distinguere *non serve* da
 * *serve e manca*: prima di questa issue la differenza viveva solo in prosa
 * dentro `reason`, che non fa fallire niente — la stessa forma di punto cieco
 * che #97 aveva chiuso per i FILE (un file non censito non entra in silenzio,
 * ora entra rosso). Qui manca il grado, non la voce.
 *
 * `corpus-only-pending` la chiude spostando la distinzione da `reason`
 * (prosa) a `mode` + `trackingIssue` (dato). Questo file pinna il contratto
 * comportamentale che ne consegue in `classify()`:
 *
 *   - `corpus-only`             → SEMPRE `actionable: false` (comportamento
 *                                 preesistente: non deve regredire).
 *   - `corpus-only-pending`     → SEMPRE `actionable: true` finche' il sito
 *                                 non risponde piu' 404 sul path atteso.
 *   - `corpus-only-pending-landed` → il gemello e' comparso: l'istruzione e'
 *                                 promuovere la voce a mano, non farlo da soli
 *                                 (loop-drift-check non mergia né riscrive).
 *
 * ## Perche' gira offline
 *
 * `classify()` e' pura: prende `now` (gli hash gia' calcolati) invece di
 * calcolarli, quindi il "sito risponde 404 o no" e' un valore iniettato qui,
 * non un fetch vero. La domanda di rete — trackingIssue ancora aperta? — vive
 * nel censimento opt-in di loop-sync-manifest-scope.test.mjs, non qui.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../../scripts/ci/loop-drift-check.mjs';

const BASE = { site: null, corpus: null };

test('corpus-only resta non actionable (non regredire il comportamento preesistente)', () => {
  const entry = { path: 'scripts/ci/loop-drift-check.mjs', mode: 'corpus-only', reason: 'vive solo qui' };
  const verdict = classify(entry, { site: null, corpus: 'abc123' }, BASE);
  assert.equal(verdict.state, 'corpus-only');
  assert.equal(verdict.actionable, false);
});

test('corpus-only-pending: ancora assente sul sito → actionable, e nomina il lavoro tracciato', () => {
  const entry = {
    path: 'scripts/lib/sanitize-control-chars.mjs',
    mode: 'corpus-only-pending',
    reason: 'il sito emette grezze le occorrenze che il corpus strippa',
    trackingIssue: 'https://github.com/valerielinc-ops/frontaliere-si-o-no/issues/5457',
  };
  // now.site: null → il fetch sul sito ha ancora ricevuto 404.
  const verdict = classify(entry, { site: null, corpus: 'deadbeef' }, BASE);
  assert.equal(verdict.state, 'corpus-only-pending');
  assert.equal(verdict.actionable, true, 'una divergenza nota ma non ancora atterrata deve restare visibile, non sparire come corpus-only');
  assert.match(verdict.detail, /5457/, 'il segnale deve puntare al lavoro tracciato, non ripetersi a vuoto (vedi commento di #125)');
});

test('corpus-only-pending: il gemello e\' comparso → stato -landed, istruzione di promozione', () => {
  const entry = {
    path: 'scripts/lib/sanitize-control-chars.mjs',
    mode: 'corpus-only-pending',
    reason: 'il sito emette grezze le occorrenze che il corpus strippa',
    trackingIssue: 'https://github.com/valerielinc-ops/frontaliere-si-o-no/issues/5457',
  };
  // now.site non-null → il fetch sul sito NON risponde piu' 404: e' la via
  // d'uscita dallo stato pending che la issue #125 chiedeva esplicitamente.
  const verdict = classify(entry, { site: 'a1b2c3d4', corpus: 'deadbeef' }, BASE);
  assert.equal(verdict.state, 'corpus-only-pending-landed');
  assert.equal(verdict.actionable, true);
  assert.match(verdict.detail, /identical.*adapted|adapted.*identical/i, "l'uscita e' un'istruzione di promozione, non un mode gia' cambiato da solo");
});

test('corpus-only-pending senza trackingIssue: resta actionable ma segnala il campo mancante', () => {
  // Il test offline dello schema (loop-sync-manifest-scope.test.mjs) impedisce
  // che una voce del genere entri nel manifest reale; questo test copre solo
  // classify() in isolamento, per non lasciare un buco silenzioso se qualcuno
  // la chiama direttamente (es. da uno script nuovo) bypassando lo schema.
  const entry = { path: 'x/y.mjs', mode: 'corpus-only-pending', reason: 'esempio' };
  const verdict = classify(entry, { site: null, corpus: 'deadbeef' }, BASE);
  assert.equal(verdict.actionable, true);
  assert.match(verdict.detail, /ATTENZIONE/, 'un trackingIssue assente deve essere visibile nel report, non silenzioso');
});

test('importare il modulo non esegue loop-drift-check: nessun fetch, nessun process.exit', () => {
  // Senza guardia CLI, questo `import` avrebbe gia' chiamato main() sopra —
  // che fa rete e, con --issue, scrive sul repo — e chiuso il processo di test
  // con process.exit() prima ancora di arrivare a questa riga. Se questo file
  // e' arrivato fin qui verde, la guardia c'e'.
  assert.equal(typeof classify, 'function');
});
