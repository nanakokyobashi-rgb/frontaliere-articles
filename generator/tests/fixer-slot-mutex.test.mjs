/**
 * Mutua esclusione FRA issue diverse per il fixer (#974, item 3).
 *
 * `issue-fix.yml` aveva una `concurrency` a chiave COSTANTE: un fixer alla
 * volta, garantito da GitHub. #908 l'ha spostata a `issue-fix-<numero>` —
 * necessario, la chiave costante sfrattava le pending — e con essa e' sparita
 * la mutua esclusione fra issue diverse. Il resto del ciclo continua a
 * assumerla: la coda `agent:fix-queued`, il drainer che promuove «una alla
 * volta a slot libero», e `check-quota-backoff.mjs`, che ragiona sull'issue in
 * lavorazione al singolare e chiude la porta solo DOPO un 429 osservato.
 *
 * Questi casi pinnano le tre cose che rendono il ripristino non-vacuo:
 *   1. il tie-break e' DEADLOCK-FREE (si cede solo alle run piu' vecchie);
 *   2. lo slot occupato RI-ACCODA senza consumare un tentativo, e la
 *      classificazione a valle lo tratta come zero-lavoro;
 *   3. il gate e' davvero cablato — permesso `actions: read` compreso, senza
 *      il quale `gh run list` da' 403 e il gate PROCEED-SAFE resta inerte in
 *      silenzio, cioe' verde e vacuo.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  IN_FLIGHT_STATUSES,
  FIX_WORKFLOW_FILE,
  DECOMPOSE_WORKFLOW_FILE,
  precedingRunIds,
  workflowFileFromRef,
} from '../../scripts/lib/fixer-slot.mjs';
import { requeueBody } from '../../scripts/ci/check-fixer-slot.mjs';
import { ZERO_WORK } from '../../scripts/ci/followup-drainer.mjs';
import { sliceFrom, sliceBetween } from './lib/anchored-slice.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SLOT_GATE = path.join(ROOT, 'scripts', 'ci', 'check-fixer-slot.mjs');
const QUOTA_GATE = path.join(ROOT, 'scripts', 'ci', 'check-quota-backoff.mjs');
const WORKFLOW = readFileSync(path.join(ROOT, '.github', 'workflows', 'issue-fix.yml'), 'utf8');
const DRAINER = readFileSync(path.join(ROOT, 'scripts', 'ci', 'followup-drainer.mjs'), 'utf8');

// ── 1. Le parti pure: chi ha la precedenza ──────────────────────────────────

test('precedingRunIds cede solo alle run STRETTAMENTE piu vecchie', () => {
  const runs = [{ databaseId: 10 }, { databaseId: 42 }, { databaseId: 99 }];
  assert.deepEqual(precedingRunIds(runs, 42), [10]);
  // La run corrente non precede se stessa: senza il `<` stretto si cederebbe
  // alla propria riga nella lista e nessuna run lavorerebbe mai.
  assert.deepEqual(precedingRunIds([{ databaseId: 42 }], 42), []);
  assert.deepEqual(precedingRunIds(runs, 10), []);
  assert.deepEqual(precedingRunIds(runs, 100), [10, 42, 99]);
});

test('precedingRunIds e deadlock-free: la run minima non cede mai a nessuno', () => {
  // La proprieta' che rende il gate un serializzatore e non un livelock: su
  // QUALUNQUE insieme di run vive, esiste sempre almeno una che procede.
  const ids = [7, 3, 91, 12, 55];
  const runs = ids.map((databaseId) => ({ databaseId }));
  const procedono = ids.filter((id) => precedingRunIds(runs, id).length === 0);
  assert.deepEqual(procedono, [3], 'deve procedere esattamente la piu vecchia');
});

test('precedingRunIds ignora le righe senza id invece di trattarle come 0', () => {
  // Un id assente che collassasse a 0 sarebbe piu' vecchio di tutto: ogni run
  // cederebbe a un fantasma e la coda si fermerebbe.
  const runs = [{ databaseId: null }, {}, { databaseId: 'x' }, { databaseId: 5 }];
  assert.deepEqual(precedingRunIds(runs, 9), [5]);
  assert.deepEqual(precedingRunIds(runs, Number.NaN), []);
  assert.deepEqual(precedingRunIds(null, 9), []);
});

test('workflowFileFromRef estrae il file dal ref di Actions', () => {
  assert.equal(
    workflowFileFromRef('o/r/.github/workflows/issue-fix.yml@refs/heads/main'),
    'issue-fix.yml',
  );
  assert.equal(
    workflowFileFromRef('o/r/.github/workflows/issue-decompose.yml@refs/heads/main'),
    'issue-decompose.yml',
  );
  // Ref assente o non-workflow → stringa vuota, cosi' il chiamante cade sul
  // default dichiarato invece di interrogare un workflow inventato.
  assert.equal(workflowFileFromRef(undefined), '');
  assert.equal(workflowFileFromRef(''), '');
  assert.equal(workflowFileFromRef('o/r/qualcosa@refs/heads/main'), '');
});

test('i due stadi Claude hanno slot separati', () => {
  // Una decomposizione in corso non deve bloccare un fix: sono due code, e il
  // drainer le conta separatamente.
  assert.notEqual(FIX_WORKFLOW_FILE, DECOMPOSE_WORKFLOW_FILE);
  assert.deepEqual(IN_FLIGHT_STATUSES, ['queued', 'in_progress']);
});

// ── 2. Il gate end-to-end, con un `gh` finto sul PATH ───────────────────────

/** Scrive un `gh` finto che risponde a `run list` con `runs` e registra ogni
 * invocazione su un file, cosi' i casi possono asserire non solo l'output ma
 * anche quali scritture sono (o non sono) avvenute. */
function withFakeGh(runs, fn, { failRunList = false } = {}) {
  const binDir = mkdtempSync(path.join(os.tmpdir(), 'fixer-slot-'));
  const logPath = path.join(binDir, 'calls.log');
  const ghPath = path.join(binDir, 'gh');
  writeFileSync(
    ghPath,
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
case "$1 $2" in
  "run list")
    ${failRunList ? 'echo "HTTP 403: Resource not accessible by integration" >&2; exit 1;;' : `printf '%s' '${JSON.stringify(runs)}' ;;`}
  "issue list") printf '%s' '[]' ;;
  "issue view") printf '%s' '{"comments":[]}' ;;
  *) printf '%s' '' ;;
esac
`,
  );
  chmodSync(ghPath, 0o755);
  try {
    return fn({ binDir, logPath, calls: () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '') });
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
}

function runGate(script, binDir, env) {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      GH_REPO: 'o/r',
      GITHUB_OUTPUT: '',
      ...env,
    },
  });
}

test('slot libero: nessuna run piu vecchia -> il fixer procede e la issue non viene toccata', () => {
  withFakeGh([{ databaseId: 900 }], ({ binDir, calls }) => {
    const r = runGate(SLOT_GATE, binDir, { GITHUB_RUN_ID: '100', ISSUE_NUMBER: '974' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /slot_busy=false/);
    assert.doesNotMatch(calls(), /issue edit/, 'una run che procede non deve ri-accodare la propria issue');
  });
});

test('slot occupato: ri-accoda con marker slot-busy e swap di label, senza chiamare Claude', () => {
  withFakeGh([{ databaseId: 100 }, { databaseId: 250 }], ({ binDir, calls }) => {
    const r = runGate(SLOT_GATE, binDir, { GITHUB_RUN_ID: '900', ISSUE_NUMBER: '974' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /slot_busy=true/);
    // Il piu' VECCHIO fra i precedenti, non il primo che capita nella lista.
    assert.match(r.stdout, /holder=100/);
    const log = calls();
    assert.match(log, /issue comment 974 .*FIX_OUTCOME: slot-busy/s);
    assert.match(log, /issue edit 974 .*--add-label agent:fix-queued --remove-label agent:fix/);
  });
});

test('solo run piu NUOVE in volo: si procede (e non si cede a valanga)', () => {
  withFakeGh([{ databaseId: 950 }, { databaseId: 980 }], ({ binDir }) => {
    const r = runGate(SLOT_GATE, binDir, { GITHUB_RUN_ID: '900', ISSUE_NUMBER: '974' });
    assert.match(r.stdout, /slot_busy=false/);
  });
});

test('gh in errore (403 senza `actions: read`) -> PROCEED-SAFE, mai coda congelata', () => {
  withFakeGh([], ({ binDir, calls }) => {
    const r = runGate(SLOT_GATE, binDir, { GITHUB_RUN_ID: '900', ISSUE_NUMBER: '974' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /slot_busy=false/);
    assert.doesNotMatch(calls(), /issue edit/);
  }, { failRunList: true });
});

test('senza GITHUB_RUN_ID non esiste tie-break: si procede invece di cedere alla cieca', () => {
  withFakeGh([{ databaseId: 100 }], ({ binDir, calls }) => {
    const r = runGate(SLOT_GATE, binDir, { ISSUE_NUMBER: '974', GITHUB_RUN_ID: '' });
    assert.match(r.stdout, /slot_busy=false/);
    assert.doesNotMatch(calls(), /issue edit/);
  });
});

test('DRY_RUN decide e stampa senza scrivere sulla issue', () => {
  withFakeGh([{ databaseId: 100 }], ({ binDir, calls }) => {
    const r = runGate(SLOT_GATE, binDir, { GITHUB_RUN_ID: '900', ISSUE_NUMBER: '974', DRY_RUN: '1' });
    assert.match(r.stdout, /slot_busy=true/);
    assert.doesNotMatch(calls(), /issue (edit|comment)/);
  });
});

// ── 3. La composizione dentro il gate di quota ──────────────────────────────

test('QUOTA_SLOT_MUTEX=1: lo slot occupato blocca prima ancora di leggere il beacon', () => {
  withFakeGh([{ databaseId: 100 }], ({ binDir, calls }) => {
    const r = runGate(QUOTA_GATE, binDir, {
      GITHUB_RUN_ID: '900',
      ISSUE_NUMBER: '974',
      QUOTA_SLOT_MUTEX: '1',
      DRY_RUN: '1',
    });
    assert.equal(r.status, 0, r.stderr);
    // Riusa `quota_blocked`: e' l'output su cui ogni step a valle di
    // issue-fix.yml e' gia' condizionato. Un output nuovo vorrebbe dire
    // aggiornare a mano ogni catena `if:`, e la prima dimenticata farebbe
    // girare Claude proprio nel caso che il gate deve prendere.
    assert.match(r.stdout, /quota_blocked=true/);
    assert.doesNotMatch(calls(), /issue list/, 'il beacon costa 4 list + N view: non va pagato se la decisione e gia presa');
  });
});

test('senza QUOTA_SLOT_MUTEX il gate di quota resta quello di prima', () => {
  // Opt-in: dei chiamanti di `check-quota-backoff.mjs` solo gli stadi con una
  // coda serializzata hanno uno slot da difendere. Bloccare gli altri sarebbe
  // un'invenzione, non un ripristino.
  withFakeGh([{ databaseId: 100 }], ({ binDir, calls }) => {
    const r = runGate(QUOTA_GATE, binDir, { GITHUB_RUN_ID: '900', ISSUE_NUMBER: '974', DRY_RUN: '1' });
    assert.match(r.stdout, /quota_blocked=false/);
    assert.match(calls(), /issue list/, 'senza il mutex si passa dal beacon come sempre');
  });
});

// ── 4. Il cablaggio: un gate scollegato e verde e vacuo ─────────────────────

test('issue-fix.yml concede `actions: read` — senza, gh run list da 403 e il gate e inerte', () => {
  const perms = sliceBetween(WORKFLOW, 'permissions:', 'jobs:', { label: 'blocco permissions di issue-fix.yml' });
  assert.match(perms, /^\s*actions:\s*read\s*$/m);
});

test('lo step di quota di issue-fix.yml accende il mutex', () => {
  const step = sliceFrom(WORKFLOW, 'QUOTA_BEACON_PEER_REPO:', { label: 'env dello step di quota' })
    .slice(0, 1200);
  assert.match(step, /QUOTA_SLOT_MUTEX:\s*'1'/);
  assert.match(step, /node scripts\/ci\/check-quota-backoff\.mjs/);
});

test('`slot-busy` e ZERO_WORK per il drainer: nessun tentativo consumato', () => {
  // Se non lo fosse, la label `agent:fix` gia' tolta dal gate ricadrebbe nel
  // rescue «run morta» e brucerebbe un `fu-attempt` per una run che non ha mai
  // letto la issue — la stessa catena assorbente che `rate-limited` rompe.
  assert.ok(ZERO_WORK.has('slot-busy'));
  assert.ok(ZERO_WORK.has('rate-limited'));
  assert.match(requeueBody(4242), /<!-- FIX_OUTCOME: slot-busy -->/);
  assert.match(requeueBody(4242), /4242/);
  assert.match(requeueBody(4242, 3), /altre 2 piu vecchie|altre 2 più vecchie/);
});

test('il drainer conta lo slot con le costanti condivise, non con letterali propri', () => {
  // AGENTS.md #6: il gate e la coda devono contare la STESSA cosa, o si
  // raccontano due storie diverse sullo stesso slot.
  const conteggio = sliceFrom(DRAINER, 'function inFlightFixCount(', { label: 'inFlightFixCount' })
    .slice(0, 600);
  assert.match(conteggio, /IN_FLIGHT_STATUSES/);
  assert.match(conteggio, /FIX_WORKFLOW_FILE/);
  assert.doesNotMatch(conteggio, /'issue-fix\.yml'/);
  assert.doesNotMatch(conteggio, /'queued', 'in_progress'/);
});
