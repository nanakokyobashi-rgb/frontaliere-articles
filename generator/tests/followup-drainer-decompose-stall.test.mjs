/**
 * Drainer (corpus): allarme sullo stadio decompose che prenota e non consuma.
 *
 * Il DECOMPOSE-DRAIN prenota un lease `issue-decompose` per issue; se
 * `issue-decompose.yml` non lo consuma mai, la issue torna in coda e la run
 * resta verde. Corpus 1084 ha accumulato cosi' 29 reservation e 0 `consumed`
 * in sei giorni senza alcun segnale. Contratti:
 *
 * 1. tre reservation consecutive dopo la data di taglio senza `consumed` →
 *    stallo: nessuna quarta reservation, defer con UN commento
 *    `DECOMPOSE_STALLED`;
 * 2. la storia prima della data di taglio non fa scattare l'allarme;
 * 3. un `consumed` azzera il conteggio;
 * 4. il marker chiude l'episodio: nessun secondo commento per le stesse
 *    reservation, e un nuovo episodio riparte da zero.
 *
 * Dependency-free: nessuna chiamata a GitHub.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { quotaLeaseEvents } from '../../scripts/ci/check-quota-backoff.mjs';
import {
  DECOMPOSE_STALLED_MARKER,
  DECOMPOSE_STALL_COUNT_SINCE,
  DECOMPOSE_STALL_THRESHOLD,
  decomposeStallDecision,
  gateDecomposeReservation,
  latestDecomposeStalledAt,
} from '../../scripts/ci/followup-drainer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DRAINER = readFileSync(path.join(ROOT, 'scripts/ci/followup-drainer.mjs'), 'utf8');

const SINCE = '2026-10-03T17:41:42Z';
const SINCE_SEC = Math.floor(Date.parse(SINCE) / 1000);
const BOT = { login: 'github-actions[bot]' };

let seq = 0;
/** Commento REST con un evento di lease, `minutes` dopo (o prima) di SINCE. */
function lease(state, minutes, { token, role = 'issue-decompose', target = '1084' } = {}) {
  seq += 1;
  const at = SINCE_SEC + minutes * 60;
  const event = {
    version: 1,
    token: token || `tok-${seq}`,
    role,
    owner: state === 'reserved' ? 'followup-drainer' : 'issue-decompose',
    targetType: 'issue',
    target,
    state,
    issuedAt: at,
    expiresAt: at + 30 * 60,
    runId: String(1000 + seq),
  };
  return {
    id: seq,
    user: BOT,
    created_at: new Date(at * 1000).toISOString(),
    body: `<!-- CLAUDE_QUOTA_LEASE: ${JSON.stringify(event)} -->\n_Quota lease ${state}._`,
  };
}

function marker(minutes, { user = BOT } = {}) {
  seq += 1;
  return {
    id: seq,
    user,
    created_at: new Date((SINCE_SEC + minutes * 60) * 1000).toISOString(),
    body: `<!-- AUTOMATION_DEFERRED: decompose-stalled -->\n\n${DECOMPOSE_STALLED_MARKER}\nStadio decompose fermo.`,
  };
}

const NOW = SINCE_SEC + 7 * 24 * 3600;

function decide(comments, opts = {}) {
  return decomposeStallDecision(quotaLeaseEvents(comments), {
    since: SINCE,
    resetAt: latestDecomposeStalledAt(comments),
    nowSec: NOW,
    ...opts,
  });
}

/** I/O finto del gate: registra i defer e le righe di log. */
function fakeGate(comments, { deferResult = true } = {}) {
  const calls = { defers: [], log: [] };
  const result = gateDecomposeReservation({ number: 1084 }, {
    readComments: () => comments,
    defer: (num, note) => { calls.defers.push({ num, note }); return deferResult; },
    log: (line) => calls.log.push(line),
    since: SINCE,
    nowSec: NOW,
  });
  return { result, calls };
}

test('tre reservation dopo la data di taglio senza consumed → stallo, nessuna quarta reservation, un solo commento', () => {
  const comments = [lease('reserved', 10), lease('reserved', 90), lease('reserved', 200)];
  const decision = decide(comments);
  assert.equal(decision.stalled, true);
  assert.equal(decision.count, DECOMPOSE_STALL_THRESHOLD);
  assert.equal(decision.reason, 'reservation-expired-unconsumed');

  const { result, calls } = fakeGate(comments);
  assert.equal(result.proceed, false, 'il drainer non deve prenotare una quarta reservation');
  assert.equal(result.deferred, true);
  assert.equal(calls.defers.length, 1);
  assert.equal(calls.defers[0].num, 1084);
  assert.ok(calls.defers[0].note.includes(DECOMPOSE_STALLED_MARKER));
  const error = calls.log.find((line) => line.startsWith('::error::'));
  assert.ok(error, 'serve un ::error:: visibile nella run verde');
  assert.match(error, /#1084/);
  assert.match(error, /reservation-expired-unconsumed/);
});

test('due reservation pendenti non bastano: si prenota ancora', () => {
  const { result, calls } = fakeGate([lease('reserved', 10), lease('reserved', 90)]);
  assert.equal(result.proceed, true);
  assert.equal(calls.defers.length, 0);
});

test('29 reservation PRIMA della data di taglio + una dopo → non stallo (la storia del difetto corretto non conta)', () => {
  const history = Array.from({ length: 29 }, (_, i) => lease('reserved', -6 * 24 * 60 + i * 300));
  const comments = [...history, lease('reserved', 30)];
  const decision = decide(comments);
  assert.equal(decision.stalled, false);
  assert.equal(decision.count, 1);
  const { result, calls } = fakeGate(comments);
  assert.equal(result.proceed, true);
  assert.equal(calls.defers.length, 0);
  // Con la data di taglio spostata indietro la stessa storia e' uno stallo:
  // e' il segnale che sarebbe servito dal 27-09.
  assert.equal(decide(comments, { since: '2026-09-27T00:00:00Z' }).stalled, true);
});

test('un consumed in mezzo azzera il conteggio', () => {
  const reset = [
    lease('reserved', 10),
    lease('reserved', 60),
    lease('consumed', 70, { token: 'tok-consumed' }),
    lease('reserved', 120),
    lease('reserved', 180),
  ];
  const decision = decide(reset);
  assert.equal(decision.stalled, false);
  assert.equal(decision.count, 2);
  assert.equal(decide([...reset, lease('reserved', 240)]).stalled, true);
});

test('la sequenza osservata su 1084 dopo la fix del consumo (reserved → consumed → released) non e\' uno stallo', () => {
  const comments = [
    lease('reserved', -400),
    lease('reserved', 103, { token: 'tok-1925' }),
    lease('consumed', 105, { token: 'tok-1925' }),
    lease('released', 113, { token: 'tok-1925' }),
  ];
  const decision = decide(comments);
  assert.equal(decision.stalled, false);
  assert.equal(decision.count, 0);
});

test('una reservation rilasciata senza consumo conta, e il motivo lo dice', () => {
  const comments = [
    lease('reserved', 10),
    lease('reserved', 60),
    lease('reserved', 120, { token: 'tok-rel' }),
    lease('released', 125, { token: 'tok-rel' }),
  ];
  const decision = decide(comments);
  assert.equal(decision.stalled, true);
  assert.equal(decision.reason, 'reservation-released-unconsumed');
  assert.equal(decision.last.token, 'tok-rel');
});

test('lease di altri ruoli non contano e non azzerano', () => {
  const comments = [
    lease('reserved', 10),
    lease('consumed', 20, { role: 'issue-fix' }),
    lease('reserved', 60),
    lease('reserved', 120),
  ];
  assert.equal(decide(comments).stalled, true);
});

test('marker DECOMPOSE_STALLED gia\' presente → nessun secondo commento; un nuovo episodio riparte da zero', () => {
  const episode = [lease('reserved', 10), lease('reserved', 60), lease('reserved', 120), marker(121)];
  const { result, calls } = fakeGate(episode);
  assert.equal(result.proceed, true, 'dopo il marker la issue rimessa in coda ha di nuovo la sua soglia');
  assert.equal(calls.defers.length, 0, 'nessun secondo commento per le stesse reservation');

  const next = [...episode, lease('reserved', 2000), lease('reserved', 2100)];
  assert.equal(fakeGate(next).calls.defers.length, 0);
  const again = fakeGate([...next, lease('reserved', 2200)]);
  assert.equal(again.result.proceed, false);
  assert.equal(again.calls.defers.length, 1);
});

test('un marker DECOMPOSE_STALLED di un autore non fidato non azzera il conteggio', () => {
  const comments = [
    lease('reserved', 10),
    lease('reserved', 60),
    marker(61, { user: { login: 'random-visitor' } }),
    lease('reserved', 120),
  ];
  assert.equal(latestDecomposeStalledAt(comments), null);
  const { result, calls } = fakeGate(comments);
  assert.equal(result.proceed, false, 'il marker di terzi non deve zittire l\'allarme');
  assert.equal(calls.defers.length, 1);
});

test('commenti illeggibili → si prenota come prima, nessun defer', () => {
  const calls = [];
  const result = gateDecomposeReservation({ number: 7 }, {
    readComments: () => null,
    defer: () => { calls.push('defer'); return true; },
    log: () => {},
  });
  assert.equal(result.proceed, true);
  assert.deepEqual(calls, []);
});

test('defer fallito → comunque nessuna reservation (si riprova al prossimo tick)', () => {
  const comments = [lease('reserved', 10), lease('reserved', 60), lease('reserved', 120)];
  const { result } = fakeGate(comments, { deferResult: false });
  assert.equal(result.proceed, false);
  assert.equal(result.deferred, false);
});

test('la data di taglio e\' un istante ISO valido nel passato', () => {
  const at = Date.parse(DECOMPOSE_STALL_COUNT_SINCE);
  assert.ok(Number.isFinite(at));
  assert.ok(at <= Date.now());
});

test('cablaggio: nel DECOMPOSE-DRAIN il gate viene interrogato PRIMA della reservation', () => {
  // Solo l'ordine, dentro il blocco del DRAIN decompose: la reservation
  // `issue-decompose` deve stare nel ramo che segue il gate, non prima.
  const drainAt = DRAINER.indexOf('// DRAIN decompose');
  assert.ok(drainAt > 0, 'blocco DRAIN decompose non trovato');
  const drain = DRAINER.slice(drainAt);
  const gate = drain.search(/\bdecomposeStallBlocks\(\s*dq\[0\]\s*\)/);
  const reserve = drain.search(/\breserveQuotaLease\(\s*dq\[0\]\.number\s*,\s*['"]issue-decompose['"]/);
  assert.ok(gate >= 0, 'il DECOMPOSE-DRAIN deve chiamare decomposeStallBlocks');
  assert.ok(reserve > gate, 'la reservation deve venire dopo il gate');
});
