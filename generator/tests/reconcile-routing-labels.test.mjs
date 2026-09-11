/**
 * reconcile-routing-labels.test.mjs — una issue non deve restare instradata
 * DUE volte (`agent:fix` e `agent:fix-queued` insieme).
 *
 * ## Perche' questo gate esiste (#918, item 2 del follow-up di #908)
 *
 * Con la chiave di concorrenza per-issue lo sweep schedulato del triage e la
 * run event-driven non condividono piu' alcun gruppo: girano insieme, e il
 * secondo passaggio dello sweep («triaged-but-not-routed») legge esattamente lo
 * stato transitorio fra `agent:triaged` e la label di routing. Le due strade
 * classificano lo stesso input, quindi di norma la seconda label e' idempotente
 * — tranne dove il clamp del budget diretto dello sweep (`crawlerToQueue`)
 * accoda cio' che l'event-driven ha mandato a fix diretto.
 *
 * Il danno non e' l'etichetta doppia: e' che `agent:fix-queued` rimette una
 * issue GIA' in lavorazione fra i candidati del drainer, che la promuove una
 * seconda volta — una run del fixer in piu' sulla quota condivisa col sito.
 *
 * ## Cosa inchioda questo file
 *
 * Le due meta' che regrediscono separatamente: la REGOLA (chi vince, e il guard
 * di eta' che impedisce di disfare un `gh issue edit` add+remove colto a
 * meta') e il CABLAGGIO (un riconciliatore che nessuno step invoca e'
 * arredamento — e va invocato dove il danno accade, cioe' prima del drain).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconciliations, ROUTE_CONFLICTS } from '../../scripts/ci/reconcile-routing-labels.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROUTER = path.join(ROOT, 'scripts/ci/reconcile-routing-labels.mjs');
const ROUTER_SRC = fs.readFileSync(ROUTER, 'utf8');
const DECOMPOSE = fs.readFileSync(path.join(ROOT, '.github/workflows/issue-decompose.yml'), 'utf8');
const NOW = Date.parse('2026-09-06T12:00:00Z');
const agoSec = (s) => new Date(NOW - s * 1000).toISOString();
const iss = (number, labels, ageSec = 600) => ({
  number,
  labels: labels.map((name) => ({ name })),
  updatedAt: agoSec(ageSec),
});

test('doppio instradamento fermo: vince la label attiva, cade quella di coda', () => {
  const todo = reconciliations([iss(918, ['agent:fix', 'agent:fix-queued', 'fu-prio:low'])], { nowMs: NOW });
  assert.equal(todo.length, 1);
  assert.equal(todo[0].number, 918);
  assert.equal(todo[0].active, 'agent:fix');
  assert.equal(todo[0].remove, 'agent:fix-queued',
    'togliere `agent:fix` lascerebbe un fixer in volo su una issue che nessuna label descrive');
});

test('`fu-prio:*` non viene mai toccata: serve intatta se la issue rientra in coda', () => {
  const todo = reconciliations([iss(1, ['agent:fix', 'agent:fix-queued', 'fu-prio:high'])], { nowMs: NOW });
  assert.deepEqual(todo.map((r) => r.remove), ['agent:fix-queued']);
});

test('una sola label di routing: niente da fare', () => {
  const only = [
    iss(1, ['agent:fix']),
    iss(2, ['agent:fix-queued', 'fu-prio:low']),
    iss(3, ['agent:triaged']),
    iss(4, ['agent:decompose']),
  ];
  assert.deepEqual(reconciliations(only, { nowMs: NOW }), []);
});

test('conflitto FRESCO: e\' un `gh issue edit` add+remove colto a meta\', non si tocca', () => {
  // Promozione del drainer e ri-accodamento per quota passano entrambi da
  // add+remove, che sull'API sono due chiamate: fra le due la issue porta
  // legittimamente entrambe le label. Riconciliare li' disferebbe l'edit.
  const fresh = reconciliations([iss(7, ['agent:fix', 'agent:fix-queued'], 5)], { nowMs: NOW });
  assert.deepEqual(fresh, [], 'un conflitto di 5s puo\' essere un edit in corso');
  const settled = reconciliations([iss(7, ['agent:fix', 'agent:fix-queued'], 5)], { nowMs: NOW, minAgeSec: 1 });
  assert.equal(settled.length, 1, 'la soglia deve restare configurabile, non cablata');
});

test('l\'eta\' usa l\'ultimo evento di label, non un commento che aggiorna la issue (#1084)', () => {
  const staleLabel = agoSec(600);
  const freshBodyEdit = agoSec(5);
  const freshLabel = agoSec(5);
  assert.equal(
    reconciliations([{
      ...iss(8, ['agent:fix', 'agent:fix-queued'], 600),
      updatedAt: freshBodyEdit,
      lastLabelEventAt: staleLabel,
    }], { nowMs: NOW }).length,
    1,
    'un commento recente non deve riaprire la finestra di sicurezza',
  );
  assert.deepEqual(
    reconciliations([{
      ...iss(9, ['agent:fix', 'agent:fix-queued'], 600),
      updatedAt: staleLabel,
      lastLabelEventAt: freshLabel,
    }], { nowMs: NOW }),
    [],
    'una label appena aggiunta deve restare protetta anche con updatedAt vecchio',
  );
});

test('`updatedAt` assente o illeggibile → si salta (dubbio ⇒ non toccare)', () => {
  const broken = [
    { number: 1, labels: [{ name: 'agent:fix' }, { name: 'agent:fix-queued' }] },
    { number: 2, labels: [{ name: 'agent:fix' }, { name: 'agent:fix-queued' }], updatedAt: 'ieri' },
    { number: 0, labels: [{ name: 'agent:fix' }, { name: 'agent:fix-queued' }], updatedAt: agoSec(600) },
  ];
  assert.deepEqual(reconciliations(broken, { nowMs: NOW }), []);
});

test('input non-lista o vuoto non esplode', () => {
  for (const bad of [null, undefined, 0, 'x', {}, []]) {
    assert.deepEqual(reconciliations(bad, { nowMs: NOW }), []);
  }
});

test('la classe copre anche la coppia decompose (stesso antipattern, altro stadio)', () => {
  assert.deepEqual(
    ROUTE_CONFLICTS.map((c) => [c.active, c.queued]),
    [['agent:fix', 'agent:fix-queued'], ['agent:decompose', 'agent:decompose-queued']],
  );
  const todo = reconciliations([iss(5, ['agent:decompose', 'agent:decompose-queued'])], { nowMs: NOW });
  assert.deepEqual(todo.map((r) => r.remove), ['agent:decompose-queued']);
});

// ── Cablaggio ──────────────────────────────────────────────────────────────
// Il riconciliatore vive fuori dagli script mirrorati (`triage-sweep.mjs` e
// `followup-drainer.mjs` sono `mode: identical`): l'unico legame con il ciclo
// sono questi due step, e un legame che nessun test guarda si spegne in
// silenzio.
const wf = (name) => fs.readFileSync(path.join(ROOT, '.github/workflows', name), 'utf8');

test('il drainer riconcilia PRIMA di promuovere', () => {
  const y = wf('followup-drainer.yml');
  const iReconcile = y.indexOf('scripts/ci/reconcile-routing-labels.mjs');
  const iDrain = y.indexOf('scripts/ci/followup-drainer.mjs');
  assert.ok(iReconcile > 0, 'senza questo step il drainer promuove una seconda volta una issue gia\' in lavorazione');
  assert.ok(iDrain > iReconcile, 'riconciliare dopo il drain non evita la promozione doppia di QUESTO tick');
});

test('lo sweep del triage riconcilia dopo aver instradato', () => {
  const y = wf('issue-triage.yml');
  const iSweep = y.indexOf('scripts/ci/triage-sweep.mjs');
  const iReconcile = y.indexOf('scripts/ci/reconcile-routing-labels.mjs');
  assert.ok(iSweep > 0 && iReconcile > iSweep,
    'lo sweep e\' una delle due strade che possono produrre il conflitto: lo ripulisce dopo averlo potuto creare');
});

test('la riconciliazione non usa il PAT: rimuove una label, non deve svegliare nulla', () => {
  for (const name of ['followup-drainer.yml', 'issue-triage.yml']) {
    const step = wf(name).split('- name:').find((s) => s.includes('reconcile-routing-labels.mjs'));
    assert.ok(step, `${name}: step assente`);
    assert.match(step, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/, `${name}: il GITHUB_TOKEN e' deliberato`);
    assert.ok(!/GITHUB_PAT_NANAKO/.test(step), `${name}: col PAT una rimozione emetterebbe eventi che nessuno deve ascoltare`);
    assert.match(step, /continue-on-error: true/, `${name}: una riconciliazione mancata non deve rendere rossa la run`);
  }
});

test('`--issue` accetta solo interi positivi e rifiuta `0` prima di leggere GitHub', () => {
  const result = spawnSync(process.execPath, [ROUTER, '--issue', '0'], {
    encoding: 'utf8',
    env: { ...process.env, GH_REPO: 'nanakokyobashi-rgb/frontaliere-articles' },
  });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /--issue richiede un numero intero positivo/);
});

test('il riepilogo distingue successi/fallimenti e il writer decompose e\' atomico', () => {
  assert.match(ROUTER_SRC, /let reconciled = 0/);
  assert.match(ROUTER_SRC, /reconciled\+\+/);
  assert.match(ROUTER_SRC, /let failed = 0/);
  assert.match(ROUTER_SRC, /failed\+\+/);
  assert.match(ROUTER_SRC, /Riconciliazioni: \$\{reconciled\}/);
  assert.match(ROUTER_SRC, /reconcile: \$\{failed\} falliti su \$\{todo\.length\}/);

  const transitions = DECOMPOSE.split('\n').filter((line) => line.includes('gh issue edit'));
  assert.ok(transitions.length >= 4, 'le transizioni di stato del prompt sono sparite');
  for (const line of transitions) {
    assert.match(line, /--add-label/);
    assert.match(line, /--remove-label/);
  }
});

test('una rimozione fallita non entra nel totale delle riconciliazioni', () => {
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-gh-'));
  const fakeGh = path.join(fakeBin, 'gh');
  fs.writeFileSync(fakeGh, `#!/bin/sh
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '[{"number":1,"labels":[{"name":"agent:fix"},{"name":"agent:fix-queued"}],"updatedAt":"1970-01-01T00:00:00Z"},{"number":2,"labels":[{"name":"agent:fix"},{"name":"agent:fix-queued"}],"updatedAt":"1970-01-01T00:00:00Z"}]'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "edit" ]; then
  [ "$3" = "2" ] && exit 1
  exit 0
fi
exit 0
`);
  fs.chmodSync(fakeGh, 0o755);
  const result = spawnSync(process.execPath, [ROUTER], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      GH_REPO: '',
      GITHUB_REPOSITORY: '',
      MIN_AGE_SEC: '0',
    },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Riconciliazioni: 1\./);
  assert.match(result.stdout, /reconcile: 1 falliti su 2/);
});
