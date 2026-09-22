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
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatorCiVerdict, NON_VERDICT_CONCLUSIONS } from '../../scripts/ci/generator-ci-gate.mjs';
import { GENERATOR_CI_JOB_NAME } from '../../scripts/ci/lib/constants.mjs';

const NAME = GENERATOR_CI_JOB_NAME;
const HEAD_SHA = 'a'.repeat(40);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GATE_SCRIPT = path.join(REPO_ROOT, 'scripts/ci/generator-ci-gate.mjs');
let nextRunId = 1;
const run = (conclusion, completed_at, name = NAME, options = {}) => ({
  id: options.id ?? nextRunId++,
  name,
  status: options.status ?? 'completed',
  conclusion,
  head_sha: options.head_sha ?? HEAD_SHA,
  created_at: options.created_at ?? completed_at,
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

test('un cancelled PIU\' RECENTE rende stantio un success precedente', () => {
  // Senza snapshot del replacement, una cancellazione piu' recente deve
  // invalidare il verdetto precedente e lasciare il gate in attesa.
  const cancelledDopo = run('cancelled', '2026-09-09T03:10:00Z');
  assert.equal(generatorCiVerdict([SUCCESS_1275, cancelledDopo], NAME), '');
});

test('un replacement pending blocca il success stantio e il success del replacement sblocca', () => {
  const replacementCreatedAt = '2026-09-09T03:20:00Z';
  const replacementPending = run(undefined, undefined, NAME, {
    id: 9001,
    status: 'in_progress',
    created_at: replacementCreatedAt,
  });
  const replacementSuccess = run('success', '2026-09-09T03:22:00Z', NAME, {
    id: 9001,
    created_at: replacementCreatedAt,
  });

  assert.equal(generatorCiVerdict([SUCCESS_1275, replacementPending], NAME), '');
  assert.equal(generatorCiVerdict([SUCCESS_1275, replacementSuccess], NAME), 'success');
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

test('solo cancelled resta fail-closed fino al timeout del gate', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'generator-ci-gate-timeout-'));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const fakeGh = path.join(bin, 'gh');
  const checkRuns = JSON.stringify({
    check_runs: [
      run('cancelled', '2026-09-09T03:10:00Z', NAME, { id: 9002 }),
    ],
  });
  writeFileSync(
    fakeGh,
    `#!/usr/bin/env node
const args = process.argv.slice(2).join(' ');
if (args.includes('/pulls/')) {
  process.stdout.write('generator/changed.mjs\\n');
} else if (args.includes('/check-runs?')) {
  process.stdout.write(${JSON.stringify(checkRuns)});
} else {
  process.exit(2);
}
`,
  );
  chmodSync(fakeGh, 0o755);

  try {
    const result = spawnSync(process.execPath, [GATE_SCRIPT], {
      encoding: 'utf8',
      timeout: 2_000,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
        GITHUB_REPOSITORY: 'nanakokyobashi-rgb/frontaliere-articles',
        PR_NUMBER: '911',
        HEAD_SHA,
        GENERATOR_CI_GATE_TIMEOUT_MS: '1',
      },
    });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /non ha concluso entro/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
