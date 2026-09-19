/**
 * loop-baseline-pr-gate.test.mjs — il gate che rifiuta in PR una baseline non
 * verificabile (issue #956, follow-up della #954).
 *
 * Si esercitano le due funzioni PURE del gate — `changedBaselines` (quali voci
 * guardare) e `gateVerdict` (cosa farne) — perche' sono quelle che decidono, e
 * perche' cosi' la suite non parla ne' con GitHub ne' col sito. E' lo stesso
 * schema di `loop-drift-init-only.test.mjs` e di `ghostVerdict`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { changedBaselines, gateVerdict, localHistoryMatch } from '../../scripts/ci/loop-baseline-pr-gate.mjs';

const GATE_SOURCE = readFileSync(new URL('../../scripts/ci/loop-baseline-pr-gate.mjs', import.meta.url), 'utf8');

const entry = (path, baseline, extra = {}) => ({ path, mode: 'identical', baseline, ...extra });

test('changedBaselines: una baseline immutata non viene guardata', () => {
  const m = { files: [entry('a.mjs', { site: 'aaaa', corpus: 'bbbb', alignedAt: '2026-01-01' })] };
  assert.deepEqual(changedBaselines(m, m), []);
});

test('changedBaselines: un solo lato cambiato produce una sola voce', () => {
  const base = { files: [entry('a.mjs', { site: 'aaaa', corpus: 'bbbb' })] };
  const head = { files: [entry('a.mjs', { site: 'aaaa', corpus: 'cccc' })] };
  const out = changedBaselines(base, head);
  assert.equal(out.length, 1);
  assert.equal(out[0].side, 'corpus');
  assert.equal(out[0].hash, 'cccc');
  assert.equal(out[0].previous, 'bbbb');
});

test('changedBaselines: una voce NUOVA e\' guardata su entrambi i lati non-null', () => {
  // E' il percorso che ha fabbricato 6 delle 13 baseline fantasma della #954:
  // si aggiunge un file, non si puo' usare `--init` (tutto-o-niente), e la
  // baseline viene scritta a mano.
  const base = { files: [] };
  const head = { files: [entry('a.mjs', { site: 'aaaa', corpus: 'bbbb' })] };
  assert.deepEqual(
    changedBaselines(base, head).map((c) => `${c.side}:${c.hash}`),
    ['site:aaaa', 'corpus:bbbb'],
  );
});

test('changedBaselines: un lato null non e\' un hash da verificare', () => {
  const base = { files: [entry('a.mjs', { site: 'aaaa', corpus: 'bbbb' })] };
  const head = { files: [entry('a.mjs', { site: null, corpus: 'bbbb' }, { mode: 'corpus-only' })] };
  assert.deepEqual(changedBaselines(base, head), []);
});

test('changedBaselines: manifest di base assente → tutto e\' nuovo', () => {
  const head = { files: [entry('a.mjs', { corpus: 'bbbb' }, { mode: 'corpus-only' })] };
  assert.deepEqual(changedBaselines(null, head).map((c) => c.side), ['corpus']);
});

test('changedBaselines: `sitePath` viaggia con la voce, per il walk sul lato sito', () => {
  const head = { files: [entry('a.mjs', { site: 'aaaa' }, { sitePath: 'tests/a.test.ts' })] };
  assert.equal(changedBaselines(null, head)[0].sitePath, 'tests/a.test.ts');
});

test('changedBaselines e gateVerdict leggono la traccia `forcedAt`', () => {
  const forcedAt = '2026-09-08T12:34:56.000Z';
  const base = { files: [entry('a.mjs', { site: 'aaaa' })] };
  const head = { files: [entry('a.mjs', { site: 'bbbb', forcedAt })] };
  assert.equal(changedBaselines(base, head)[0].forcedAt, forcedAt);
  const verdict = gateVerdict({ side: 'site', baselineHash: 'bbbb', currentHash: 'bbbb', forcedAt });
  assert.ok(verdict.reason.includes(`forcedAt=${forcedAt}`));
});

test('gateVerdict: combacia col contenuto attuale → ok, senza rete', () => {
  for (const side of ['site', 'corpus']) {
    const v = gateVerdict({ side, baselineHash: 'aaaa', currentHash: 'aaaa' });
    assert.equal(v.status, 'ok');
  }
});

test('gateVerdict: trovata nella storia → ok (la riparazione legittima della #954)', () => {
  const v = gateVerdict({ side: 'corpus', baselineHash: 'aaaa', currentHash: 'zzzz', historyMatch: true, historyExhausted: true });
  assert.equal(v.status, 'ok');
});

test('gateVerdict: assente da TUTTA la storia → rifiutata su entrambi i lati', () => {
  for (const side of ['site', 'corpus']) {
    const v = gateVerdict({ side, baselineHash: 'aaaa', currentHash: 'zzzz', historyMatch: false, historyExhausted: true });
    assert.equal(v.status, 'reject', side);
  }
});

test('gateVerdict: storia troncata → il corpus rifiuta (ha un rimedio offline), il sito no', () => {
  const args = { baselineHash: 'aaaa', currentHash: 'zzzz', historyMatch: false, historyExhausted: false };
  assert.equal(gateVerdict({ ...args, side: 'corpus' }).status, 'reject');
  assert.equal(gateVerdict({ ...args, side: 'site' }).status, 'warn');
});

test('gateVerdict: storia esaurita ma solo 404 → non rifiuta come baseline fantasma', () => {
  const args = { baselineHash: 'aaaa', currentHash: 'zzzz', historyMatch: false, historyExhausted: true, historyReadable: false };
  for (const side of ['corpus', 'site']) {
    const v = gateVerdict({ ...args, side });
    assert.doesNotMatch(v.reason, /fantasma/);
    assert.equal(v.status, side === 'corpus' ? 'reject' : 'warn');
  }
});

test('gateVerdict: errore di rete → il sito non blocca la coda di merge di questo repo', () => {
  const args = { baselineHash: 'aaaa', currentHash: null, networkError: true };
  assert.equal(gateVerdict({ ...args, side: 'site' }).status, 'warn');
  assert.equal(gateVerdict({ ...args, side: 'corpus' }).status, 'reject');
});

test('gateVerdict: il verdetto fantasma resta quello di ghostVerdict, non una seconda copia', () => {
  // Se `ghostVerdict` cambiasse idea, il gate deve cambiare idea con lui: una
  // baseline accettata in PR e dichiarata fantasma dal cron il mattino dopo
  // sarebbe il modo peggiore di fallire.
  const v = gateVerdict({ side: 'corpus', baselineHash: 'aaaa', currentHash: 'zzzz', historyMatch: false, historyExhausted: true });
  assert.match(v.reason, /fantasma/);
});

test('il rimedio del gate per una ghost-baseline allinea il guard init e traccia force', () => {
  assert.match(GATE_SOURCE, /ghost-baseline/);
  assert.match(GATE_SOURCE, /--force/);
  assert.match(GATE_SOURCE, /forcedAt/);
});

test('localHistoryMatch: un blob storico illeggibile (partial clone) rende la storia non verificabile, non una baseline fantasma', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-gate-partial-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    const rel = 'scripts/x.mjs';
    fs.writeFileSync(path.join(dir, rel), 'v1\n');
    git('add', rel); git('commit', '-qm', 'v1');
    const v1Blob = git('rev-parse', `HEAD:${rel}`);
    fs.writeFileSync(path.join(dir, rel), 'v2\n');
    git('add', rel); git('commit', '-qm', 'v2');

    // Storia leggibile: la baseline v1 si trova.
    assert.equal(localHistoryMatch(rel, hash('v1\n'), dir).match, true);
    // Hash mai esistito, storia intera leggibile: esaurita e leggibile.
    const ghost = localHistoryMatch(rel, hash('mai\n'), dir);
    assert.deepEqual([ghost.match, ghost.exhausted, ghost.historyReadable], [false, true, true]);

    // Il blob di v1 non arriva (fetch su richiesta fallito): il tree dice che
    // il file c'era, quindi NON e' una prova di assenza.
    fs.rmSync(path.join(dir, '.git', 'objects', v1Blob.slice(0, 2), v1Blob.slice(2)));
    const partial = localHistoryMatch(rel, hash('v1\n'), dir);
    assert.deepEqual([partial.match, partial.exhausted, partial.historyReadable], [false, false, false]);
    // `exhausted: false` e' cio' che fa passare il chiamante all'API invece
    // di consegnare a `ghostVerdict` una storia incompleta come esaurita.
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
