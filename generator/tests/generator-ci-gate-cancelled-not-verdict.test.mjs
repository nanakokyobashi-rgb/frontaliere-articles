/**
 * generator-ci-gate-cancelled-not-verdict.test.mjs — una cancellazione da
 * concurrency non e' un verdetto sul codice, e il gate richiesto non deve
 * leggerla come tale.
 *
 * ── Il falso rosso che questo file chiude (PR #1275) ───────────────────────
 * `generator-ci.yml` ha `concurrency: cancel-in-progress`. Due push ravvicinate
 * lasciano quindi sullo STESSO SHA due check-run di nome `test`: quello del run
 * cancellato dopo pochi secondi, e quello del run rimpiazzo che porta il
 * verdetto vero. Sulla head di #1275: `cancelled` completato alle 02:42:19 dopo
 * 1 secondo di vita, `success` completato alle 02:45:10.
 *
 * `generator-ci-gate.mjs` gira dentro `tests` e in quella finestra (02:44) il
 * solo check-run COMPLETATO era la cancellazione. Prendendo «l'ultimo
 * completato» senza distinguere, leggeva `cancelled`, cadeva nel ramo
 * `conclusion !== 'success'` e usciva 1 — rendendo rosso il check RICHIESTO 80
 * secondi prima che il verdetto reale, verde, atterrasse. Il tetto di 30 minuti
 * che il gate ha proprio per aspettare non veniva mai raggiunto.
 *
 * ── Perche' questo NON allenta il gate ─────────────────────────────────────
 * I due test finali sono la meta' che tiene: un `failure` resta rosso subito, e
 * un `cancelled` non puo' MAI produrre un verde — produce `''`, cioe' «continua
 * ad attendere», e se non arriva altro il tetto scade e il gate e' rosso lo
 * stesso. L'unica cosa che cambia e' che il rumore della concurrency smette di
 * essere scambiato per un contratto rotto.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatorCiVerdict, NON_VERDICT_CONCLUSIONS } from '../../scripts/ci/generator-ci-gate.mjs';
import { GENERATOR_CI_JOB_NAME } from '../../scripts/ci/lib/constants.mjs';

const NAME = GENERATOR_CI_JOB_NAME;
const run = (conclusion, completed_at, name = NAME) => ({
  name,
  status: 'completed',
  conclusion,
  completed_at,
});

// Le due righe reali della head di #1275, con i loro timestamp.
const CANCELLED_1275 = run('cancelled', '2026-09-09T02:42:19Z');
const SUCCESS_1275 = run('success', '2026-09-09T02:45:10Z');

test('la cancellazione da concurrency, sola sulla head, non e\' ancora un verdetto', () => {
  // Lo stato esatto che il gate vedeva alle 02:44: il rimpiazzo e' partito ma
  // non ha concluso. Deve valere «attendi» (''), non «rosso».
  assert.equal(generatorCiVerdict([CANCELLED_1275], NAME), '');
});

test('quando il verdetto vero atterra, vince lui e il gate e\' verde', () => {
  assert.equal(generatorCiVerdict([CANCELLED_1275, SUCCESS_1275], NAME), 'success');
});

test('un cancelled PIU\' RECENTE di un success non lo sovrascrive', () => {
  // Invarianza all'ordine di atterraggio: un dispatch manuale cancellato dopo
  // il run buono non deve rimettere in dubbio un verdetto gia' dato.
  const cancelledDopo = run('cancelled', '2026-09-09T03:10:00Z');
  assert.equal(generatorCiVerdict([SUCCESS_1275, cancelledDopo], NAME), 'success');
});

test('un failure resta un verdetto ROSSO, e immediato', () => {
  // La meta' che tiene: nessuna failure reale viene assorbita dalla filtratura.
  assert.equal(generatorCiVerdict([run('failure', '2026-09-09T02:45:10Z')], NAME), 'failure');
  // ...e non viene mascherata da una cancellazione piu' fresca.
  assert.equal(
    generatorCiVerdict([run('failure', '2026-09-09T02:45:10Z'), run('cancelled', '2026-09-09T03:00:00Z')], NAME),
    'failure',
  );
});

test('timed_out e action_required restano verdetti rossi, non non-verdetti', () => {
  for (const c of ['timed_out', 'action_required', 'stale']) {
    assert.equal(generatorCiVerdict([run(c, '2026-09-09T02:45:10Z')], NAME), c);
    assert.equal(NON_VERDICT_CONCLUSIONS.has(c), false, `${c} non deve essere trattata come non-verdetto`);
  }
});

test('un cancelled non puo\' mai produrre un verde', () => {
  // Qualunque combinazione di sole cancellazioni deve dare '' — mai 'success'.
  const soloCancelled = [
    run('cancelled', '2026-09-09T02:42:19Z'),
    run('cancelled', '2026-09-09T02:50:00Z'),
    run('cancelled', '2026-09-09T03:00:00Z'),
  ];
  assert.equal(generatorCiVerdict(soloCancelled, NAME), '');
});

test('i check-run di ALTRI job non contaminano il verdetto', () => {
  // Il gate guarda il solo job `test`: un `dry-run` rosso (fa rete, storicamente
  // rumoroso) non e' il contratto sorvegliato qui.
  const altri = [run('failure', '2026-09-09T02:46:00Z', 'dry-run'), SUCCESS_1275];
  assert.equal(generatorCiVerdict(altri, NAME), 'success');
});

test('input non-array o vuoto → attendi, non lancia', () => {
  assert.equal(generatorCiVerdict(undefined, NAME), '');
  assert.equal(generatorCiVerdict(null, NAME), '');
  assert.equal(generatorCiVerdict([], NAME), '');
});
