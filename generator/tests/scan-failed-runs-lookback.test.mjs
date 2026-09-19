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
import { resolveLookbackMin, DEFAULT_RUN_QUERY_HORIZON_MIN, fetchRunsBisected, parseWatermarkListing } from '../../scripts/ci/scan-failed-runs.mjs';

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
  // La finestra si risolve nella SHELL: `env.SCAN_RESOLVED_LOOKBACK_MIN` non è
  // alimentato in modo affidabile da una scrittura in GITHUB_ENV di un passo
  // precedente — stessa trappola già documentata nel workflow per il PAT — e il
  // silenzio riporterebbe il detector a 40 riaprendo il buco (review #1568).
  assert.doesNotMatch(
    WORKFLOW,
    /TIMEOUT_SCAN_LOOKBACK_MINUTES: \$\{\{[^}]*env\.SCAN_RESOLVED_LOOKBACK_MIN/,
    'la finestra non va interpolata dal context env.*',
  );
  assert.match(
    WORKFLOW,
    /export TIMEOUT_SCAN_LOOKBACK_MINUTES="\$\{TIMEOUT_SCAN_LOOKBACK_INPUT:-\$\{SCAN_RESOLVED_LOOKBACK_MIN:-40\}\}"/,
    'precedenza: input manuale → finestra risolta → floor, risolta in shell',
  );
});

test('l export della finestra e opt-in, per non inquinare altri job', () => {
  // Misurato sulla run 35378019611: `tests.yml` esegue un test che lancia questo
  // CLI, e `SCAN_RESOLVED_LOOKBACK_MIN=40` è finito nell'ambiente dei suoi step.
  // In CI GITHUB_ENV è popolata in OGNI job, quindi "scrivo se esiste" non è una
  // condizione sufficiente: solo il workflow che possiede il gemello lo chiede.
  const src = readFileSync(new URL('../../scripts/ci/scan-failed-runs.mjs', import.meta.url), 'utf8');
  assert.match(src, /process\.env\.SCAN_EXPORT_RESOLVED_LOOKBACK === '1' && process\.env\.GITHUB_ENV/);
  assert.match(WORKFLOW, /SCAN_EXPORT_RESOLVED_LOOKBACK: '1'/);
});

test('il watermark conta solo le scansioni da schedule, non i dry-run', () => {
  // Una run `workflow_dispatch --dry-run` esce SUCCESS senza consegnare niente:
  // usarla come watermark fa avanzare la finestra oltre fallimenti mai
  // segnalati (review #1568). `schedule` è l'unico canale di consegna.
  const src = readFileSync(new URL('../../scripts/ci/scan-failed-runs.mjs', import.meta.url), 'utf8');
  assert.match(src, /'--status', 'success', '--event', 'schedule'/);
  assert.match(
    src,
    /\.filter\(\(r\) => r\?\.event === 'schedule' && r\?\.conclusion === 'success'\)/,
    'il filtro server-side va ri-verificato in locale: decide cosa non verrà più guardato',
  );
});

test('una passata troncata dal cap esce non-zero, per non far avanzare la finestra', () => {
  // Il cap che tronca in silenzio e poi esce 0 e' una perdita definitiva: il
  // watermark avanzerebbe oltre gli scartati. Uscire non-zero è il meccanismo
  // che tiene la finestra indietro finché la consegna non è completa.
  const src = readFileSync(new URL('../../scripts/ci/scan-failed-runs.mjs', import.meta.url), 'utf8');
  assert.match(src, /if \(truncated\.length > 0\) \{/);
  assert.match(src, /passata INCOMPLETA/);
  assert.doesNotMatch(src, /NON recuperabili in una passata successiva/);
  assert.match(src, /la prossima scansione li rivede/);
});

test('un errore interno non esce piu 0: con un watermark sarebbe una perdita', () => {
  // PROCEED-SAFE usciva 0 perché «uno scanner rotto non deve far fallire il
  // workflow che lo ospita». Da quando la finestra si deriva dall'ultima
  // scansione riuscita, uscire 0 dopo un errore fa avanzare il watermark oltre
  // fallimenti non raccolti. L'asserzione di prosa va cambiata col diff (§8).
  const src = readFileSync(new URL('../../scripts/ci/scan-failed-runs.mjs', import.meta.url), 'utf8');
  const tail = src.slice(src.indexOf('main().then('));
  assert.match(tail, /process\.exit\(1\)/, "l'errore deve risultare rotto");
  assert.doesNotMatch(tail, /PROCEED-SAFE: uno scanner rotto non deve/);
});

test('il rilevamento di timeout non viene saltato se lo scanner ordinario fallisce', () => {
  // Senza `if: always()` il default `success()` faceva saltare l'intero
  // rilevamento di timeout/host-kill ogni volta che il passo precedente
  // usciva non-zero: due famiglie di guasto indipendenti, un solo interruttore.
  const step = WORKFLOW.slice(WORKFLOW.indexOf('- name: Scan timed out and host-killed jobs'));
  assert.match(step.slice(0, 200), /if: always\(\)/);
});

test('il cap non promette piu un recupero che non avviene', () => {
  // Il messaggio originale diceva "Verranno ripresi alla prossima scansione",
  // e con una finestra derivata era falso: la passata capped RIESCE, quindi la
  // finestra successiva parte da qui e gli scartati ne restano fuori.
  // Ora la promessa è di nuovo VERA, ma perché il comportamento è cambiato —
  // la passata troncata esce non-zero, quindi non diventa il watermark. Il
  // messaggio deve dire quel meccanismo, non ammettere la perdita.
  const src = readFileSync(new URL('../../scripts/ci/scan-failed-runs.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /Verranno ripresi alla prossima scansione/);
  assert.match(src, /esce non-zero per NON far avanzare il watermark/);
});

test('una finestra NON letta viene riportata al chiamante, non solo loggata', () => {
  // Primo dei tre 🔴: `warnUnread()` avvisava e poi rendeva `'read'`, quindi la
  // perdita finiva nel log e il chiamante la vedeva come lettura riuscita — e la
  // passata poteva diventare il watermark senza aver guardato quel tratto.
  const unread = [];
  const runs = fetchRunsBisected(
    Date.parse('2026-09-18T00:00:00Z'),
    null,
    {
      fetchWindow: () => null, // gh fallisce sempre
      nowMs: Date.parse('2026-09-18T12:00:00Z'),
      warn: () => {},
      onUnread: (a, b) => unread.push([a, b]),
    },
  );
  assert.equal(runs.length, 0);
  assert.ok(unread.length > 0, 'la finestra persa deve essere segnalata al chiamante');
});

test('onUnread ha un default no-op: i chiamanti di sola lettura non cambiano', () => {
  // I test storici chiamano fetchRunsBisected senza onUnread: non deve lanciare.
  assert.doesNotThrow(() => fetchRunsBisected(
    Date.parse('2026-09-18T00:00:00Z'),
    null,
    { fetchWindow: () => null, nowMs: Date.parse('2026-09-18T12:00:00Z'), warn: () => {} },
  ));
});

test('i tre 🔴 sono lo stesso difetto: nessun avanzamento su lavoro non svolto', () => {
  const src = readFileSync(new URL('../../scripts/ci/scan-failed-runs.mjs', import.meta.url), 'utf8');
  // Un solo accumulatore e una sola uscita applicano la regola.
  assert.match(src, /const incompleteReasons = \[\];/);
  assert.match(src, /function incompleteExit\(\)/);
  // (1) lettura dello storico non riuscita ≠ nessuna scansione precedente.
  // Asserito sul COMPORTAMENTO della funzione pura, non sul testo del sorgente:
  // la prima versione pinnava una stringa e si è rotta al primo refactor, che è
  // esattamente il difetto dei test che pinnano il sorgente.
  assert.equal(parseWatermarkListing(null).incomplete, 'non leggibile');
  assert.equal(parseWatermarkListing('[]').incomplete, null);
  assert.match(src, /markIncomplete\(`listing delle scansioni precedenti \$\{incomplete\}/);
  // (2) consegna non persistita
  assert.match(src, /if \(res === null \|\| res\?\.persisted === false\) \{/);
  assert.doesNotMatch(src, /if \(res\) opened\+\+;/);
  // (3) export della finestra al gemello
  assert.match(src, /markIncomplete\('export della finestra risolta al detector timeout fallito'\)/);
  // e la lista vuota non è più un successo incondizionato
  assert.match(src, /return incompleteReasons\.length > 0 \? incompleteExit\(\) : 0;/);
});

test('«[]» e «» non sono la stessa cosa: solo il secondo rende la passata incompleta', () => {
  // L'ultimo 🔴: `if (!raw) return null` trattava l'output VUOTO come «non
  // esistono scansioni riuscite», quindi il codice usava il floor, completava la
  // run `schedule` e la faceva diventare il nuovo watermark — saltando failure
  // non esaminate, `publish-api` incluso, che lascia `dist/api/` vecchia.

  // Lista vuota: risultato VALIDO. Prima scansione del repo: nessun confine
  // precedente da rispettare, floor legittimo, passata completa.
  assert.deepEqual(parseWatermarkListing('[]'), { atMs: null, incomplete: null });

  // Output vuoto: la finestra NON è determinabile.
  assert.equal(parseWatermarkListing('').incomplete, 'vuoto (nessun JSON)');
  assert.equal(parseWatermarkListing('').atMs, null);

  // gh fallito.
  assert.equal(parseWatermarkListing(null).incomplete, 'non leggibile');
  // Spazzatura.
  assert.equal(parseWatermarkListing('not json').incomplete, 'non parsabile');
  // Forma inattesa (un oggetto invece di un array).
  assert.equal(parseWatermarkListing('{"a":1}').incomplete, 'di forma inattesa');
});

test('il watermark ignora se stesso e tutto cio che non e schedule+success', () => {
  const rows = JSON.stringify([
    { databaseId: 111, createdAt: '2026-09-18T12:00:00Z', event: 'schedule', conclusion: 'success' },
    { databaseId: 222, createdAt: '2026-09-18T17:00:00Z', event: 'workflow_dispatch', conclusion: 'success' },
    { databaseId: 333, createdAt: '2026-09-18T16:00:00Z', event: 'schedule', conclusion: 'failure' },
    { databaseId: 999, createdAt: '2026-09-18T18:00:00Z', event: 'schedule', conclusion: 'success' },
  ]);
  // 999 è la run corrente: derivare da se stessi collasserebbe il lookback a zero.
  const { atMs, incomplete } = parseWatermarkListing(rows, '999');
  assert.equal(incomplete, null);
  assert.equal(new Date(atMs).toISOString(), '2026-09-18T12:00:00.000Z',
    'vince la più recente fra schedule+success, esclusa la corrente');
});
