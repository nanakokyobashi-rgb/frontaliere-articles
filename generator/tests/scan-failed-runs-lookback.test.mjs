/**
 * scan-failed-runs-lookback.test.mjs — la finestra di scansione non deve essere
 * una costante tarata sulla cadenza del cron.
 *
 * Il difetto misurato il 2026-09-18: `workflow-failure-issues.yml` chiede una
 * run ogni 30 minuti e il lookback era fisso a 40, con 10 minuti di
 * sovrapposizione "quindi nessun buco". GitHub però droppa le `schedule` su un
 * repo carico: su 120 scansioni riuscite in 449 ore la cadenza reale era
 * mediana 231 minuti, p90 318, massima 454 (il 13% delle run richieste). Con
 * 40 minuti di finestra lo scanner guardava il 17,7% del tempo, e il 70% delle
 * run fallite non-PR (95 su 136) non entrava in NESSUNA finestra: è il motivo
 * per cui `crawler-group-04/05/08/12` sono stati rossi ~26 ore senza aprire una
 * issue e `Loop drift check` ne ha perse 3.
 *
 * Qui si pinna che la finestra si DERIVI dall'ultima scansione riuscita, e che
 * i due chiamanti nello YAML non reintroducano la costante.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveLookbackMin, DEFAULT_RUN_QUERY_HORIZON_MIN } from '../../scripts/ci/scan-failed-runs.mjs';

const WORKFLOW = readFileSync(
  new URL('../../.github/workflows/workflow-failure-issues.yml', import.meta.url),
  'utf8',
);
const MIN = 60_000;
const CEIL = DEFAULT_RUN_QUERY_HORIZON_MIN;
const NOW = Date.parse('2026-09-18T12:00:00Z');
const silent = () => {};

test('un --lookback-min esplicito vince sulla derivazione', () => {
  // Il dispatch manuale e il dry-run devono poter forzare una finestra larga
  // anche quando l'ultima scansione è appena passata.
  assert.equal(
    resolveLookbackMin({
      explicitRaw: '2000',
      lastSuccessAtMs: NOW - 10 * MIN,
      nowMs: NOW,
      ceilingMin: CEIL,
      warn: silent,
    }),
    2000,
  );
});

test('la finestra copre il buco reale quando lo scheduler salta dei giri', () => {
  // 231 minuti = la cadenza MEDIANA misurata. Col vecchio 40 fisso, 191 minuti
  // di fallimenti erano invisibili a ogni passata.
  const got = resolveLookbackMin({
    lastSuccessAtMs: NOW - 231 * MIN,
    nowMs: NOW,
    ceilingMin: CEIL,
    warn: silent,
  });
  assert.equal(got, 236, '231 minuti trascorsi + 5 di sovrapposizione');
  assert.ok(got > 40, 'la finestra non deve restare inchiodata al vecchio default');
});

test('la sovrapposizione non si perde sulla cadenza nominale', () => {
  // Cron rispettato: 30 minuti. La finestra torna a ~35, non a 231 — la
  // derivazione non gonfia il lavoro quando lo scheduler funziona.
  assert.equal(
    resolveLookbackMin({
      lastSuccessAtMs: NOW - 30 * MIN,
      nowMs: NOW,
      ceilingMin: CEIL,
      warn: silent,
    }),
    40,
    'max(30+5, floor 40) = 40',
  );
});

test('senza una scansione precedente leggibile si ricade sul floor storico', () => {
  // Fail-open deliberato: prima scansione del repo, oppure `gh run list`
  // fallito. Un degrado noto (40 minuti) batte un lookback indefinito.
  for (const lastSuccessAtMs of [null, undefined, Number.NaN]) {
    assert.equal(
      resolveLookbackMin({ lastSuccessAtMs, nowMs: NOW, ceilingMin: CEIL, warn: silent }),
      40,
    );
  }
});

test('un orologio incoerente non produce una finestra negativa', () => {
  // `lastSuccess` nel futuro (clock skew, o la run corrente non esclusa)
  // darebbe un lookback <= 0, cioè una scansione che non guarda niente.
  assert.equal(
    resolveLookbackMin({
      lastSuccessAtMs: NOW + 90 * MIN,
      nowMs: NOW,
      ceilingMin: CEIL,
      warn: silent,
    }),
    40,
  );
});

test('oltre l orizzonte della query la finestra si tronca e lo DICE', () => {
  // Il filtro `since` non può promettere run che `--created` non copre: oltre
  // l'orizzonte il troncamento è obbligatorio, ma tacerlo rileggerebbe come
  // "tutto coperto" una passata che ha perso giorni di fallimenti.
  const warnings = [];
  const got = resolveLookbackMin({
    lastSuccessAtMs: NOW - 40 * 24 * MIN * 60,
    nowMs: NOW,
    ceilingMin: CEIL,
    warn: (m) => warnings.push(m),
  });
  assert.equal(got, CEIL);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^::warning::/, 'deve essere visibile come annotation, non un log');
  assert.match(warnings[0], /non sono recuperabili/);
});

test('lo YAML non passa piu una finestra fissa allo scanner', () => {
  // La regressione da cui è nato tutto: `--lookback-min "... || '40'"` passava
  // SEMPRE un valore, quindi sulle run da `schedule` — il 100% delle run reali,
  // dove l'input è vuoto — la derivazione era codice morto.
  assert.doesNotMatch(
    WORKFLOW,
    /--lookback-min "\$\{\{ github\.event\.inputs\.lookback_min \|\| '40' \}\}"/,
    'il default 40 non deve tornare nella riga di invocazione',
  );
  assert.match(
    WORKFLOW,
    /if \[ -n "\$\{\{ github\.event\.inputs\.lookback_min \}\}" \]/,
    '--lookback-min va passato solo se l input è stato compilato a mano',
  );
  assert.match(WORKFLOW, /default: ''/, "l'input lookback_min deve essere vuoto per default");
});

test('il gemello scan-job-timeouts riusa la finestra risolta, non la ricalcola', () => {
  // AGENTS.md §6: un valore condiviso ha UNA sorgente. I due scanner girano
  // nello stesso job e avevano lo stesso 40 fisso, quindi lo stesso buco.
  assert.match(
    WORKFLOW,
    /TIMEOUT_SCAN_LOOKBACK_MINUTES: \$\{\{ github\.event\.inputs\.lookback_min \|\| env\.SCAN_RESOLVED_LOOKBACK_MIN \|\| '40' \}\}/,
  );
});

test('il rilevamento di timeout non viene saltato se lo scanner ordinario fallisce', () => {
  // Senza `if: always()` il default `success()` faceva saltare l'intero
  // rilevamento di timeout/host-kill ogni volta che il passo precedente
  // usciva non-zero: due famiglie di guasto indipendenti, un solo interruttore.
  const step = WORKFLOW.slice(WORKFLOW.indexOf('- name: Scan timed out and host-killed jobs'));
  assert.match(step.slice(0, 200), /if: always\(\)/);
});

test('il cap non promette piu un recupero che non avviene', () => {
  // Il vecchio messaggio diceva "Verranno ripresi alla prossima scansione".
  // È falso: la passata capped RIESCE, quindi la finestra successiva parte da
  // qui e gli scartati ne restano fuori per sempre.
  const src = readFileSync(new URL('../../scripts/ci/scan-failed-runs.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /Verranno ripresi alla prossima scansione/);
  assert.match(src, /NON recuperabili in una passata successiva/);
});
