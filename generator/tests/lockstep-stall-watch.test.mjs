/**
 * lockstep-stall-watch.test.mjs — la guardia sull'incaglio della lockstep.
 *
 * Il guardiano è l'osservatore di sé stesso: apre una issue quando la PR
 * `engine-lockstep-auto` non chiude entro soglia, e la richiude alla prima
 * passata pulita. Quello che NON può osservare da solo sono le due proprietà da
 * cui dipende di essere utile invece che rumoroso, e sono queste:
 *
 *   1. la soglia non scatta prima che un tentativo di auto-merge sia passato —
 *      altrimenti il primo falso allarme insegna a ignorare l'allarme vero;
 *   2. il titolo è COSTANTE — altrimenti `createGithubIssue` (dedup sui primi 60
 *      caratteri) apre una issue nuova a ogni passata e `resolveGithubIssue` non
 *      ne richiude mai nessuna. È la forma della #45: un allarme senza un
 *      chiuditore che lo matchi resta acceso per sempre e smette di significare
 *      qualcosa.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_THRESHOLD_HOURS,
  LOCKSTEP_BRANCH,
  STALL_ISSUE_TITLE,
  buildStallBody,
  findStalledLockstep,
} from '../../scripts/ci/lockstep-stall-watch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WF = fs.readFileSync(path.join(ROOT, '.github/workflows/lockstep-stall-watchdog.yml'), 'utf8');
const LOCKSTEP_WF = fs.readFileSync(
  path.join(ROOT, '.github/workflows/auto-merge-engine-lockstep.yml'),
  'utf8',
);

const NOW = Date.parse('2026-08-13T12:00:00Z');
const agoHours = (h) => new Date(NOW - h * 3_600_000).toISOString();

test('una lockstep più giovane della soglia NON è incagliata', () => {
  const { stalled } = findStalledLockstep({
    prs: [{ number: 205, createdAt: agoHours(1.5) }],
    now: NOW,
    thresholdHours: DEFAULT_THRESHOLD_HOURS,
  });
  assert.deepEqual(
    stalled,
    [],
    'Sotto le 2h il cron di auto-merge può semplicemente non essere ancora passato: chiamarla ' +
      'incagliata è un falso allarme sul canale che la guardia deve proteggere.',
  );
});

test('oltre la soglia è incagliata, e l\'età finisce nel risultato', () => {
  const { stalled, oldestAgeHours } = findStalledLockstep({
    prs: [{ number: 205, createdAt: agoHours(4) }],
    now: NOW,
    thresholdHours: DEFAULT_THRESHOLD_HOURS,
  });
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].number, 205);
  assert.ok(Math.abs(stalled[0].ageHours - 4) < 0.01);
  assert.ok(Math.abs(oldestAgeHours - 4) < 0.01);
});

test('la soglia è inclusiva: esattamente 3h scatta', () => {
  const { stalled } = findStalledLockstep({
    prs: [{ number: 1, createdAt: agoHours(DEFAULT_THRESHOLD_HOURS) }],
    now: NOW,
    thresholdHours: DEFAULT_THRESHOLD_HOURS,
  });
  assert.equal(stalled.length, 1, 'un confronto stretto lascia scoperto il bordo esatto della soglia');
});

test('nessuna PR aperta → nessun allarme (è il caso sano, ed è la maggioranza)', () => {
  const { stalled, oldestAgeHours } = findStalledLockstep({ prs: [], now: NOW, thresholdHours: 3 });
  assert.deepEqual(stalled, []);
  assert.equal(oldestAgeHours, null);
});

test('una data illeggibile non fabbrica un incaglio', () => {
  const { stalled } = findStalledLockstep({
    prs: [{ number: 7, createdAt: 'non-una-data' }, { number: 8, createdAt: null }],
    now: NOW,
    thresholdHours: 3,
  });
  assert.deepEqual(
    stalled,
    [],
    'Un allarme nato da un proprio bug di parsing è il modo più rapido di far spegnere la guardia.',
  );
});

test('le incagliate escono dalla più vecchia alla più giovane', () => {
  const { stalled } = findStalledLockstep({
    prs: [
      { number: 1, createdAt: agoHours(4) },
      { number: 2, createdAt: agoHours(9) },
      { number: 3, createdAt: agoHours(6) },
    ],
    now: NOW,
    thresholdHours: 3,
  });
  assert.deepEqual(stalled.map((p) => p.number), [2, 3, 1]);
});

// ── Le due proprietà che rendono l'allarme richiudibile ──────────────────────

test('il titolo è costante e sta dentro la finestra di dedup', () => {
  assert.ok(
    !/\d/.test(STALL_ISSUE_TITLE),
    `Il titolo contiene una cifra (${STALL_ISSUE_TITLE}): se è il numero di PR o le ore, ogni ` +
      'passata apre una issue diversa e nessuna viene mai richiusa.',
  );
  assert.ok(
    STALL_ISSUE_TITLE.length <= 60,
    `Il titolo è ${STALL_ISSUE_TITLE.length} caratteri: oltre i 60 la dedup di ` +
      'github-issue-creator taglia, e un taglio a metà parola fa divergere apertura e chiusura.',
  );
});

test('la soglia di default è oltre il periodo del cron di auto-merge', () => {
  const cron = LOCKSTEP_WF.match(/cron: '(\d+) \*\/(\d+) \* \* \*'/);
  assert.ok(cron, 'il cron di auto-merge-engine-lockstep.yml non è più nella forma attesa');
  const periodHours = Number(cron[2]);
  assert.ok(
    DEFAULT_THRESHOLD_HOURS > periodHours,
    `La soglia (${DEFAULT_THRESHOLD_HOURS}h) non supera il periodo del cron di auto-merge ` +
      `(${periodHours}h): sotto quel periodo «non ha chiuso» non distingue «incagliata» da ` +
      '«non è ancora arrivato il suo turno», e la guardia diventa un generatore di falsi allarmi.',
  );
});

test('il workflow e lo script dichiarano la STESSA soglia', () => {
  const dflt = WF.match(/threshold_hours:[\s\S]*?default: '(\d+)'/);
  assert.ok(dflt, 'il workflow non dichiara un default per `threshold_hours`');
  assert.equal(
    Number(dflt[1]),
    DEFAULT_THRESHOLD_HOURS,
    'Il default del workflow e quello dello script sono divergiti: il cron passerebbe una soglia ' +
      'diversa da quella che il razionale dello script motiva, e nessuno se ne accorgerebbe.',
  );
  const fallback = WF.match(/THRESHOLD_HOURS: \$\{\{ inputs\.threshold_hours \|\| '(\d+)' \}\}/);
  assert.ok(fallback, 'il passaggio della soglia allo script non ha un fallback');
  assert.equal(
    Number(fallback[1]),
    DEFAULT_THRESHOLD_HOURS,
    'Su `schedule` gli `inputs` non esistono: il fallback è la soglia che gira SEMPRE nel percorso ' +
      'automatico, quindi è quello il valore che conta davvero.',
  );
});

test('il workflow invoca davvero lo scanner, e sul branch giusto', () => {
  assert.match(WF, /node scripts\/ci\/lockstep-stall-watch\.mjs/);
  assert.equal(LOCKSTEP_BRANCH, 'engine-lockstep-auto');
  assert.match(
    LOCKSTEP_WF,
    /engine-lockstep-auto/,
    'il branch sorvegliato non è più quello che auto-merge-engine-lockstep.yml mergia',
  );
});

test('il body manda a monte, non a riparare qui', () => {
  const body = buildStallBody({
    stalled: [{ number: 205, ageHours: 4.2, url: 'https://example.invalid/205', checks: '2 rossi → rss-feed-guid' }],
    thresholdHours: 3,
  });
  assert.match(body, /#205/);
  assert.match(body, /4\.2h/);
  assert.match(body, /rss-feed-guid/);
  assert.match(
    body,
    /sovrascritt/i,
    'Senza dire che il branch è rigenerato dal mirror, il primo istinto è correggere l\'engine ' +
      'qui — che è la mossa che il mirror successivo cancella.',
  );
  assert.match(body, /richiude da sola/, 'il body non dice che l\'allarme si auto-risolve');
});
