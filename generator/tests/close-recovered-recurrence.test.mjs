/**
 * close-recovered-recurrence.test.mjs — un fallimento che RICORRE non è un
 * fallimento risolto.
 *
 * Il reconciler chiudeva sulla sola domanda «l'ultima run è verde?», e su un
 * guasto intermittente quella domanda ha sempre risposta sì. Misurato su questo
 * repo il 2026-08-18: la issue #249 `Workflow Failure: Generate Blog Article`
 * (il wedge di `generate-article.yml`, 42 run su 69 fallimenti dal 13-08, 26,6
 * ore di runner in 5 giorni) è stata auto-chiusa 37 volte in 7 giorni, con 45
 * commenti `🔁` di ricorrenza. Viveva fra i 5 e i 40 minuti per volta e non è
 * mai entrata né nella coda del fixer né in un triage umano.
 *
 * I numeri delle fixture qui sotto sono quelli misurati sulle run vere
 * (`gh run list -w 'Generate Blog Article' -b main -L 900`), non inventati.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TITLE_RE,
  decideRecurrenceHold,
  decideChronicEscalation,
  countRecurrences,
  alreadyRecurrenceHeld,
  recurrenceHoldNote,
  chronicEscalationNote,
  RECURRENCE_MARKER,
  RECURRENCE_HOLD_MARKER,
  CHRONIC_MARKER,
  CHRONIC_LABELS,
  DEFAULT_CHRONIC_RECURRENCES,
  DEFAULT_RECURRENCE_WINDOW_HOURS,
} from '../../scripts/ci/close-recovered-failure-issues.mjs';
import { lostArticleTitle } from '../../scripts/ci/scan-failed-runs.mjs';

const NOW = Date.parse('2026-08-18T08:00:00Z');
const opts = { now: NOW };

/** Una run completata, `minutesAgo` minuti fa. */
const run = (minutesAgo, ok) => ({
  databaseId: 100000 + minutesAgo,
  status: 'completed',
  conclusion: ok ? 'success' : 'failure',
  createdAt: new Date(NOW - minutesAgo * 60000).toISOString(),
});

/** Storico newest-first: `spec` è una lista [minutiFa, verde]. */
const history = (spec) => spec.map(([m, ok]) => run(m, ok));

/** Cadenza regolare: `count` run ogni `everyMin`, con i minuti in `failAt` rossi. */
function cadence({ count, everyMin, failAt = [] }) {
  const fails = new Set(failAt);
  return Array.from({ length: count }, (_, i) => run(i * everyMin, !fails.has(i * everyMin)));
}

// ── Il caso che ha aperto la scheda ───────────────────────────────────────────

test('storico con fallimenti ricorrenti + ultima run verde → la issue NON si chiude', () => {
  // La forma misurata su #249: il wedge colpisce ogni poche run, poi 3 verdi.
  const runs = history([
    [5, true], [12, true], [20, true],
    [35, false], [60, true], [90, false], [140, true], [200, false],
    [260, true], [320, true],
  ]);
  const d = decideRecurrenceHold(runs, opts);
  assert.equal(d.hold, true, 'un guasto che ricorre non va chiuso perché l\'ultima run è verde');
  assert.equal(d.failures, 3);
  assert.equal(d.streak, 3);
  assert.match(d.reason, /RICORRE/);
});

test('storico pulito + ultima run verde → la issue si chiude', () => {
  // Il fallimento che ha aperto la issue è fuori dalla finestra recente e da
  // allora è solo verde: è il transitorio davvero rientrato, e la chiusura
  // automatica deve restare (è la ragione per cui il reconciler esiste).
  const runs = history([[5, true], [40, true], [80, true], [120, true], [600, false]]);
  const d = decideRecurrenceHold(runs, opts);
  assert.equal(d.hold, false);
  assert.equal(d.failures, 0);
  assert.match(d.reason, /transitorio rientrato/);
});

test('un solo fallimento nella finestra, seguito da 3 verdi → si chiude', () => {
  // È il fallimento che ha aperto la issue, non una ricorrenza: `maxRecurrences: 1`.
  const runs = history([[5, true], [25, true], [45, true], [70, false], [400, true]]);
  assert.equal(decideRecurrenceHold(runs, opts).hold, false);
});

test('un solo fallimento ma appena UNA run verde dopo → si tiene aperta', () => {
  // Due delle 36 chiusure di #249 sono avvenute con l'ultima run completata
  // rossa (corsa fra il listing e la run in corso): la streak copre quel caso.
  const runs = history([[5, true], [70, false], [90, true], [400, true]]);
  const d = decideRecurrenceHold(runs, opts);
  assert.equal(d.hold, true);
  assert.equal(d.streak, 1);
});

test('19 verdi consecutive NON bastano se nella finestra il guasto è ricorso', () => {
  // Misurato: al momento di una delle auto-chiusure di #249 la streak era 19, e
  // il giorno dopo il wedge ha bruciato altre 12 run. La streak da sola non
  // discrimina niente — la misura che discrimina è il conteggio in finestra.
  const runs = [
    ...Array.from({ length: 19 }, (_, i) => run(5 + i * 8, true)),
    run(170, false), run(200, false), run(230, true),
  ];
  const d = decideRecurrenceHold(runs, opts);
  assert.equal(d.streak, 19);
  assert.equal(d.hold, true);
});

// ── Le famiglie che NON devono cambiare comportamento ─────────────────────────

test('workflow lento (cron giornaliero): un fallimento vecchio e una verde → si chiude come prima', () => {
  // La finestra di 8h è vuota: nessuna misura possibile e nessuna ragione di
  // tenere aperto. Senza questo ramo, `minGreenStreak: 3` su un cron giornaliero
  // vorrebbe dire tre giorni di issue aperta per un guasto già rientrato.
  const runs = history([[600, true], [2040, false], [3480, true]]);
  const d = decideRecurrenceHold(runs, opts);
  assert.equal(d.hold, false);
  assert.equal(d.sample, 0);
});

test('workflow ad alta cadenza: 2 flake su 120 run (1,7%) → la valvola sul tasso chiude', () => {
  // Una run ogni 4 minuti: senza valvola, due flake trascurabili basterebbero a
  // pinnare aperta una issue. La valvola NON copre #249: nei 36 momenti di
  // chiusura il suo tasso su 24h era al minimo 4,9% (mediana 12%).
  const runs = cadence({ count: 120, everyMin: 4, failAt: [300, 400] });
  const d = decideRecurrenceHold(runs, opts);
  assert.equal(d.failures, 2);
  assert.equal(d.sample, 120);
  assert.ok(d.rate <= 0.02, `tasso misurato ${d.rate}`);
  assert.equal(d.hold, false);
});

test('stessa cadenza al 5% di fallimenti → si tiene aperta', () => {
  const failAt = Array.from({ length: 6 }, (_, i) => 100 + i * 40);
  const runs = cadence({ count: 120, everyMin: 4, failAt });
  const d = decideRecurrenceHold(runs, opts);
  assert.equal(d.failures, 6);
  assert.equal(d.hold, true);
});

test('senza storico (crawler step) il gate è un no-op: comportamento invariato', () => {
  for (const empty of [null, undefined, []]) {
    const d = decideRecurrenceHold(empty, opts);
    assert.equal(d.hold, false);
    assert.equal(d.measured, false);
  }
});

// ── Escalation cronica ────────────────────────────────────────────────────────

const recurrenceComment = (hoursAgo) => ({
  body: `${RECURRENCE_MARKER} **Reopened** — ricorrenza`,
  createdAt: new Date(NOW - hoursAgo * 3600e3).toISOString(),
});

test('sotto soglia le ricorrenze non fanno escalation', () => {
  // Misurato sulle 22 issue di fallimento chiuse del repo: il massimo in 168h è
  // 3 (#411), poi 2 (#62) e 0 per le altre 19. La soglia a 5 non le tocca.
  const comments = [recurrenceComment(10), recurrenceComment(30), recurrenceComment(50)];
  const d = decideChronicEscalation(comments, opts);
  assert.equal(d.hold, false);
  assert.equal(d.count, 3);
  assert.equal(d.threshold, DEFAULT_CHRONIC_RECURRENCES);
});

test('sopra soglia la issue è cronica: hold + escalation una volta sola', () => {
  const comments = Array.from({ length: 45 }, (_, i) => recurrenceComment(i * 3));
  const first = decideChronicEscalation(comments, opts);
  assert.equal(first.hold, true);
  assert.equal(first.escalate, true);
  assert.equal(first.count, 45);

  // Secondo passaggio: il marker c'è già, niente label né commento ripetuti.
  const second = decideChronicEscalation(
    [...comments, { body: chronicEscalationNote({ workflow: 'X', decision: first }), createdAt: new Date(NOW).toISOString() }],
    opts,
  );
  assert.equal(second.hold, true);
  assert.equal(second.escalate, false);
});

test('le ricorrenze fuori finestra non contano', () => {
  const old = Array.from({ length: 40 }, (_, i) => recurrenceComment(200 + i));
  assert.equal(countRecurrences(old, opts), 0);
  assert.equal(decideChronicEscalation(old, opts).hold, false);
});

test('il commento di escalation non contiene 🔁: non deve gonfiare il proprio contatore', () => {
  const decision = { count: 45, threshold: 5, windowHours: 168 };
  const note = chronicEscalationNote({ workflow: 'Generate Blog Article', decision });
  assert.ok(!note.includes(RECURRENCE_MARKER), 'il marker di ricorrenza è del reporter, non nostro');
  assert.ok(note.includes(CHRONIC_MARKER));
  assert.equal(countRecurrences([{ body: note, createdAt: new Date(NOW).toISOString() }], opts), 0);
  for (const label of CHRONIC_LABELS) assert.ok(note.includes(label));
});

test('il commento di hold porta il conteggio, e si ripete solo dopo una nuova ricorrenza', () => {
  const decision = decideRecurrenceHold(
    history([[5, true], [12, true], [20, true], [35, false], [90, false]]),
    opts,
  );
  const note = recurrenceHoldNote({ workflow: 'Generate Blog Article', decision });
  assert.ok(note.includes(RECURRENCE_HOLD_MARKER));
  assert.ok(note.includes('2 fallimenti'), note);
  assert.ok(!note.includes(RECURRENCE_MARKER));

  const held = [{ body: note, createdAt: new Date(NOW - 3600e3).toISOString() }];
  assert.equal(alreadyRecurrenceHeld(held), true);
  // Se il guasto torna DOPO il nostro commento, il conteggio è cambiato e va riscritto.
  assert.equal(alreadyRecurrenceHeld([...held, recurrenceComment(0.2)]), false);
  // Commenti illeggibili: si tiene comunque aperta, ma senza riscrivere il commento
  // a ogni passata oraria (non potremmo vedere il nostro stesso marker).
  assert.equal(alreadyRecurrenceHeld(null), true);
});

// ── Il dedup sui titoli non si muove ─────────────────────────────────────────

test('TITLE_RE continua a riconoscere i titoli che scan-failed-runs.mjs conia', () => {
  const name = 'Generate Blog Article';
  const title = `Workflow Failure: ${name}`;
  const m = TITLE_RE.exec(title);
  assert.ok(m, 'se il closer smette di riconoscere la issue, il difetto non viene né riparato né cancellato: viene ignorato');
  assert.equal(m[1], name);
  // Il discriminante sta all'inizio, quindi la troncatura a 60 char del dedup
  // (DEDUP_TITLE_PREFIX_LEN in github-issue-creator.mjs) non lo taglia.
  assert.ok(title.length <= 60);
  assert.equal(TITLE_RE.exec(title.slice(0, 60))[1], name);

  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'ci', 'scan-failed-runs.mjs'),
    'utf8',
  );
  assert.ok(src.includes('`Workflow Failure: ${name}`'), 'il template del titolo è cambiato: riallineare TITLE_RE');
});

test('il titolo dell\'articolo perso resta FUORI dalla famiglia coperta dal closer', () => {
  // È deliberato (scan-failed-runs.mjs lo documenta): un articolo perso nel push
  // non si ripara tornando verde. Se un giorno rientrasse nella famiglia
  // `Workflow Failure:`, questo test lo fa notare invece di lasciarlo scivolare.
  assert.equal(TITLE_RE.test(lostArticleTitle('content/blog-articles-data.ts')), false);
});

test('i default sono quelli misurati', () => {
  assert.equal(DEFAULT_RECURRENCE_WINDOW_HOURS, 8);
  assert.equal(DEFAULT_CHRONIC_RECURRENCES, 5);
});
