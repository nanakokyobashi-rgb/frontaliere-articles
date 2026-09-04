/**
 * scan-failed-runs-filter.test.mjs — un push fallito su un branch non-main dei
 * gate pre-merge (`tests`, `Generator CI`) non deve aprire una "Workflow
 * Failure": è un'anteprima del `pull_request` che la stessa PR rigirerà, non
 * un segnale nuovo. Misurato: #112, #135, #178 — tre issue fantasma aperte da
 * push su branch (fixer WIP o sviluppo) mai ancora diventati PR.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isReportableRun,
  cleanLogLine,
  conflictedPathsFromLog,
  blockingConflictPath,
  articleWasGenerated,
  pushRetriesExhausted,
  lostArticleTitle,
  buildLostArticleReport,
  isDeclaredSkipOnly,
  DECLARED_SKIP_STEP_RE,
  DEFAULT_RUN_QUERY_HORIZON_MIN,
  parseHorizonMin,
  parsePositiveNum,
  horizonPressure,
  fetchRunsBisected,
  parseRunListJson,
} from '../../scripts/ci/scan-failed-runs.mjs';
import { TITLE_RE } from '../../scripts/ci/close-recovered-failure-issues.mjs';
import { isExclusivelyWorkflowScoped } from '../../scripts/ci/check-workflows-scope.mjs';
// Namespace import di proposito: `workflow-scope-detect.mjs` e' `identical` nel
// manifest del ciclo e scende dal sito, dove la #5599 gli ha aggiunto
// `isMonitorFiledWorkflowFailure` / `extractNonWorkflowCodeRefs`. Un import
// nominato di un export che la copia locale non ha ancora romperebbe il LINK
// del modulo — cioe' l'intero file di test — su una differenza che qui e'
// informativa e non portante. Col namespace la feature si sonda a runtime.
import * as scopeDetect from '../../scripts/lib/workflow-scope-detect.mjs';

const { detectWorkflowScoped, CODE_PATH_RE, isMonitorFiledWorkflowFailure } = scopeDetect;

/** I path di codice che il detector CONTA, con la semantica della copia presente. */
const codeRefsCounted = (text) =>
  scopeDetect.extractNonWorkflowCodeRefs
    ? scopeDetect.extractNonWorkflowCodeRefs(text)
    : [...new Set(String(text).match(CODE_PATH_RE) || [])];

const base = { conclusion: 'failure', createdAt: '2026-08-10T00:00:00Z', updatedAt: '2026-08-10T00:00:00Z' };

test('push fallito su tests/Generator CI in preview di una PR non ancora aperta è escluso', () => {
  assert.equal(isReportableRun({ ...base, workflowName: 'tests', event: 'push', headBranch: 'fix/issue-166' }), false);
  assert.equal(
    isReportableRun({ ...base, workflowName: 'Generator CI', event: 'push', headBranch: 'fix/whatever' }),
    false,
  );
});

test('push fallito su tests/Generator CI direttamente su main è segnalato (#476)', () => {
  // Dopo #424 la suite gira davvero sui push a main dei produttori di
  // articoli: li' non c'e' nessuna PR ne' un reviewer a vedere il rosso.
  assert.equal(isReportableRun({ ...base, workflowName: 'tests', event: 'push', headBranch: 'main' }), true);
  assert.equal(
    isReportableRun({ ...base, workflowName: 'Generator CI', event: 'push', headBranch: 'main' }),
    true,
  );
});

test('pull_request resta escluso per qualunque workflow (invariante preesistente)', () => {
  assert.equal(isReportableRun({ ...base, workflowName: 'tests', event: 'pull_request', headBranch: 'main' }), false);
});

test('push fallito su un workflow SENZA trigger pull_request gemello resta segnalato', () => {
  assert.equal(
    isReportableRun({ ...base, workflowName: 'batch-faq-articles', event: 'push', headBranch: 'main' }),
    true,
  );
});

test('IGNORE_WORKFLOWS esclude anche un push senza pull_request gemello (parametro ignore rispettato)', () => {
  assert.equal(
    isReportableRun(
      { ...base, workflowName: 'batch-faq-articles', event: 'push', headBranch: 'main' },
      { ignore: new Set(['batch-faq-articles']) },
    ),
    false,
  );
});

test('run non-failure o fuori dalla finestra restano esclusi (invarianti preesistenti)', () => {
  assert.equal(isReportableRun({ ...base, conclusion: 'cancelled', workflowName: 'x', event: 'schedule' }), false);
  assert.equal(
    isReportableRun(
      { ...base, workflowName: 'x', event: 'schedule', updatedAt: '2026-08-09T00:00:00Z' },
      { since: '2026-08-10T00:00:00Z' },
    ),
    false,
  );
});

/* ─────────────────────────────────────────────────────────────────────────────
 * Rilevatore "articolo generato e perso" (issue #225).
 *
 * Le righe della fixture sono copiate dal log della run 31459831234, prefisso
 * `job\tstep\ttimestamp` e sequenze ANSI compresi: e' su QUELLA forma che le
 * regex devono reggere, non su una versione ripulita a mano. L'ESC si scrive
 * con String.fromCharCode(27) invece che come byte letterale, cosi' il file
 * resta ASCII stampabile.
 * ────────────────────────────────────────────────────────────────────────── */

const CATALOG = 'public/data/journalist-image-catalog.json';
const ESC = String.fromCharCode(27);
const CYAN = `${ESC}[36;1m`;
const OFF = `${ESC}[0m`;
const P = (t, s) => `generate\tUNKNOWN STEP\t2026-08-11T05:0${t}Z ${s}`;

// L'eco che GitHub stampa dell'intero blocco `run:` all'avvio dello step: c'e'
// in ogni run, anche in quelle che pushano al primo tentativo.
const SCRIPT_ECHO = [
  P('0:17.6748816', `${CYAN}echo "::error::push failed after 5 attempts — the article is registered locally but not pushed"${OFF}`),
  P('0:17.6741689', `${CYAN}  # started from different bases conflict for real and all five${OFF}`),
  P('0:17.5226128', '  ENABLE_HAIKU_ARTICLE_FALLBACK: true'),
].join('\n');

const LOST_ARTICLE_LOG = [
  SCRIPT_ECHO,
  P('0:18.0664708', "error: failed to push some refs to 'https://github.com/nanakokyobashi-rgb/frontaliere-articles.git'"),
  P('0:18.0703116', 'push attempt 1 failed — rebasing onto main'),
  P('0:18.4631322', `CONFLICT (content): Merge conflict in ${CATALOG}`),
  P('0:18.5043863', 'error: could not apply e321793c... Generate blog article (svizzera)'),
  P('0:18.5860074', `##[warning]rebase conflict on '${CATALOG}', which is not a whole-file bookkeeping cache — aborting, as before`),
  P('0:22.4524431', `CONFLICT (content): Merge conflict in ${CATALOG}`),
  P('1:07.5850278', '##[error]push failed after 5 attempts — the article is registered locally but not pushed'),
  P('1:07.6072338', '  ARTICLE: true'),
].join('\n');

const RUN = {
  databaseId: 31459831234,
  url: 'https://github.com/nanakokyobashi-rgb/frontaliere-articles/actions/runs/31459831234',
  headBranch: 'main',
  event: 'schedule',
  updatedAt: '2026-08-11T05:01:09Z',
};

const REPORT_ARGS = {
  run: RUN,
  workflowName: 'Generate Blog Article',
  workflowPath: '.github/workflows/generate-article.yml',
  jobLines: '- `generate` — step fallito: `Commit and push`',
};

test('cleanLogLine toglie prefisso di job/step/timestamp e sequenze ANSI', () => {
  assert.equal(
    cleanLogLine(P('0:18.4631322', `CONFLICT (content): Merge conflict in ${CATALOG}`)),
    `CONFLICT (content): Merge conflict in ${CATALOG}`,
  );
  assert.equal(cleanLogLine(P('0:17.6748816', `${CYAN}ciao${OFF}`)), 'ciao');
});

test('il path in conflitto viene estratto dal log grezzo, senza duplicati', () => {
  assert.deepEqual(conflictedPathsFromLog(LOST_ARTICLE_LOG), [CATALOG]);
  assert.equal(blockingConflictPath(LOST_ARTICLE_LOG), CATALOG);
});

test("blockingConflictPath preferisce il path che ha fatto abortire l'helper", () => {
  // Piu' file in conflitto: quello nominato dall'avviso dell'helper e' l'unico
  // che ha davvero bloccato il rebase — gli altri erano bookkeeping risolvibile.
  const log = [
    P('0:18.4631322', 'CONFLICT (content): Merge conflict in data/blog-images-used.json'),
    P('0:18.4631323', `CONFLICT (content): Merge conflict in ${CATALOG}`),
    P('0:18.5860074', `##[warning]rebase conflict on '${CATALOG}', which is not a whole-file bookkeeping cache — aborting, as before`),
  ].join('\n');
  assert.equal(blockingConflictPath(log), CATALOG);
});

test("l'eco dello script non conta come push esaurito ne' come articolo generato", () => {
  // Senza questa distinzione OGNI run di quello step sembrerebbe un fallimento:
  // GitHub stampa il blocco `run:` per intero, `echo "::error::…"` compreso.
  assert.equal(pushRetriesExhausted(SCRIPT_ECHO), false);
  assert.equal(articleWasGenerated(SCRIPT_ECHO), false, "ENABLE_HAIKU_ARTICLE_FALLBACK: true non e' ARTICLE: true");
  assert.equal(pushRetriesExhausted(LOST_ARTICLE_LOG), true);
  assert.equal(articleWasGenerated(LOST_ARTICLE_LOG), true);
});

test('un push esaurito SENZA articolo non produce la issue ricca', () => {
  // La perdita e' solo di bookkeeping: resta la "Workflow Failure" generica,
  // che si richiude da sola al primo verde.
  const log = LOST_ARTICLE_LOG
    .replace('  ARTICLE: true', '  ARTICLE: false')
    .replace(
      'error: could not apply e321793c... Generate blog article (svizzera)',
      'error: could not apply e321793c... Record rejected topic candidates (svizzera — no article generated)',
    );
  assert.equal(buildLostArticleReport({ ...REPORT_ARGS, log }), null);
});

test('un fallimento senza conflitto non produce la issue ricca', () => {
  const log = [
    P('1:07.5850278', '##[error]push failed after 5 attempts — the article is registered locally but not pushed'),
    P('1:07.6072338', '  ARTICLE: true'),
  ].join('\n');
  assert.equal(buildLostArticleReport({ ...REPORT_ARGS, log }), null);
});

test("la issue ricca nomina il path, l'articolo perso e il file da modificare", () => {
  const report = buildLostArticleReport({ ...REPORT_ARGS, log: LOST_ARTICLE_LOG });
  assert.ok(report, "la classe piu' cara della pipeline deve produrre un report");
  assert.equal(report.title, lostArticleTitle(CATALOG));
  assert.ok(report.title.includes(CATALOG), 'il titolo deve dire QUALE file');
  assert.match(report.description, /articolo generato per intero e' stato buttato via/);
  assert.ok(report.description.includes(RUN.url), 'il run id sta nel body, non nel titolo');
  assert.match(report.description, /## Suggested action/);
  // L'helper, il test e l'auto-filer restano NOMINATI — l'informazione non si
  // perde — ma con nome file e cartella separati: vedi il test qui sotto per il
  // perche' un path unico spegnerebbe il corto-circuito del guard.
  assert.match(report.description, /`rebase-onto-remote\.sh`/, "il body deve dire QUALE helper");
  assert.match(report.description, /`scripts\/lib\/`/, "e in QUALE cartella sta");
  assert.match(report.description, /`rebase-onto-remote\.test\.mjs`/);
  assert.match(report.description, /`generator\/tests\/`/);
  // Il path del workflow nel body e' voluto: check-workflows-scope.mjs (Mode 1)
  // lo riconosce e ferma il fixer PRIMA di spendere token su una fix che il PAT
  // di questo repo non potrebbe comunque pushare.
  assert.match(report.description, /\.github\/workflows\/generate-article\.yml/);
});

test("il body della issue ricca e' esclusivamente workflow-scoped (il corto-circuito del fixer scatta davvero)", () => {
  // ⚠ QUESTO E' IL TEST CHE PROVA L'AFFERMAZIONE, e la prima stesura la smentiva.
  //
  // Nominare il workflow non basta: `isExclusivelyWorkflowScoped()` e'
  // ESCLUSIVO — >=1 path `.github/workflows/**` E **zero** path di codice
  // non-workflow (`CODE_PATH_RE`: scripts/, src/, services/, build/, ...).
  // Il body citava `scripts/lib/rebase-onto-remote.sh` nel punto 2 e
  // `scripts/ci/scan-failed-runs.mjs` nella firma in fondo: DUE, non uno.
  // Con anche solo il secondo, il verdetto resta `false`, il fixer parte lo
  // stesso e spende ~1M token per una fix che il PAT senza scope `workflow`
  // non potrebbe comunque pushare — cioe' l'esatto costo che la citazione del
  // workflow dice di evitare.
  //
  // Si asserisce su ENTRAMBI i consumatori perche' sono due call site distinti:
  // `isExclusivelyWorkflowScoped` e' il Mode 1 di check-workflows-scope.mjs,
  // `detectWorkflowScoped` e' il pre-flight di followup-drainer.mjs (che legge
  // titolo + body). Fu la loro asimmetria a produrre il loop della #4437.
  const report = buildLostArticleReport({ ...REPORT_ARGS, log: LOST_ARTICLE_LOG });
  const leaked = codeRefsCounted(report.description);
  assert.deepEqual(
    leaked,
    [],
    'Il body cita path di codice non-workflow: ' + JSON.stringify(leaked) + '.\n' +
      'Ognuno riapre la valvola "la fix potrebbe stare li\'" e spegne il corto-circuito.\n' +
      'Non togliere l\'informazione: scrivi nome file e cartella SEPARATI\n' +
      '(`` `x.mjs` ``, sotto `` `scripts/ci/` ``) — restano entrambi greppabili.',
  );
  assert.equal(isExclusivelyWorkflowScoped(report.description), true);
  assert.equal(detectWorkflowScoped(`${report.title}\n${report.description}`, { title: report.title }), true);

  // E la scorciatoia del sito NON copre questo caso, quindi l'invariante sopra
  // va tenuta a mano: `isMonitorFiledWorkflowFailure()` (#5599) esenta le issue
  // dell'auto-filer dalla regola sui path di codice, ma aggancia sul PREFISSO
  // del titolo (`Workflow Failure:`/`CI Failure:`), e questo titolo sta apposta
  // fuori da quei prefissi perche' il reconciler non lo chiuda su un verde.
  // Se un giorno il detector sceso dal mirror non esportasse piu' quella
  // funzione, il test non deve rompersi: e' un'osservazione, non una dipendenza.
  if (typeof isMonitorFiledWorkflowFailure === 'function') {
    assert.equal(
      isMonitorFiledWorkflowFailure({ title: report.title, labels: ['Bug'] }),
      false,
      "il titolo per-path sta fuori dai prefissi del monitor: nessuna esenzione automatica",
    );
  }
});

test("anche il body GENERICO resta leggibile dal routing (nessuna regressione sull'altro ramo)", () => {
  // Il ramo generico tiene la firma con il path completo, e va bene: il suo
  // titolo E' `Workflow Failure: <nome>`, quindi sul detector del sito post-#5599
  // `isMonitorFiledWorkflowFailure()` decide da solo, senza leggere il body.
  assert.ok(TITLE_RE.exec('Workflow Failure: Generate Blog Article'));
  if (typeof isMonitorFiledWorkflowFailure === 'function') {
    assert.equal(isMonitorFiledWorkflowFailure({ title: 'Workflow Failure: Generate Blog Article' }), true);
  }
});

test("il titolo e' stabile a parita' di path e discrimina dentro i 60 char della dedup", () => {
  // github-issue-creator.mjs deduplica sui primi 60 caratteri e, se il taglio
  // spezza una parola, butta l'ultimo token: col path in testa il discriminante
  // e' dentro la finestra anche per un path lungo.
  const a = lostArticleTitle(CATALOG);
  const b = lostArticleTitle('content/blog-articles-data.ts');
  const lungo = lostArticleTitle('content/blog-body/it/un-titolo-davvero-molto-lungo-che-da-solo-supera-i-sessanta-caratteri.ts');
  assert.equal(a, lostArticleTitle(CATALOG), 'stesso path → stesso titolo');
  assert.notEqual(a.slice(0, 60), b.slice(0, 60));
  assert.notEqual(a.slice(0, 60), lungo.slice(0, 60));
  assert.ok(!/\d{6,}/.test(a), 'nessun run id nel titolo: renderebbe la dedup inutile');
});

test('il titolo sta FUORI dal TITLE_RE di close-recovered-failure-issues.mjs', () => {
  // Deliberato: quel reconciler chiude sul primo verde successivo, e qui il
  // verde non prova niente — il path resta fuori dalla allowlist anche mentre
  // le run passano. E' cosi' che questa classe e' sparita finora senza fix.
  assert.equal(TITLE_RE.exec(lostArticleTitle(CATALOG)), null);
  assert.ok(TITLE_RE.exec('Workflow Failure: Generate Blog Article'), 'il titolo generico resta coperto dal closer');
});

/* ─────────────────────────────────────────────────────────────────────────────
 * issue #170 — uno skip DICHIARATO non e' un guasto
 *
 * `post-merge-followup.yml` esce 1 quando la quota Claude e' esaurita, e il
 * rosso e' il meccanismo: il watermark avanza solo sulle run di successo,
 * quindi un verde li' perderebbe il batch di PR non triagiate. Lo scanner lo
 * leggeva come qualunque altro rosso, apriva "Workflow Failure: Post-merge
 * follow-up triage" e la ri-citava a ogni finestra di quota finche' il closer
 * la promuoveva a `needs-human` per RICORRENZA. Misurato il 2026-08-25: #170
 * aperta dal 2026-08-10, 2 fallimenti su 10 run recenti, entrambi lo skip.
 * ───────────────────────────────────────────────────────────────────────────── */

/** Forma reale di `failedJobs()`: `step` e' il PRIMO step fallito del job. */
const job = (step, name = 'followup') => ({ name, step, url: 'https://example.invalid/job' });

test('#170: la run ferma sul solo skip di quota non e\' segnalabile', () => {
  assert.equal(
    isDeclaredSkipOnly([job('Skip on exhausted quota (no false green — watermark must hold)')]),
    true,
  );
});

test('#170: un guasto VERO nello stesso workflow resta segnalato', () => {
  // E' il fallimento che ha aperto #170 il 2026-08-10: un altro step, stesso
  // workflow. Se il filtro guardasse il WORKFLOW invece dello STEP, questo
  // sparirebbe insieme al rumore — ed e' l'unico dei due che vuole un fix.
  assert.equal(isDeclaredSkipOnly([job('Run Claude follow-up triage (batch)')]), false);
});

test('#170: basta UN job fallito fuori dallo skip perche\' la run resti segnalata', () => {
  assert.equal(
    isDeclaredSkipOnly([
      job('Skip on exhausted quota (no false green — watermark must hold)'),
      job('Commit and push', 'publish'),
    ]),
    false,
  );
});

test('#170: in dubbio si SEGNALA — elenco vuoto o step ignoto non sono uno skip', () => {
  // Il costo di una issue di troppo e' un triage; quello di una in meno e' un
  // guasto silenzioso. L'asimmetria decide il default.
  assert.equal(isDeclaredSkipOnly([]), false, 'nessun job fallito riportato dall\'API');
  assert.equal(isDeclaredSkipOnly([job(null)]), false, 'step non riportato');
  assert.equal(isDeclaredSkipOnly([job(undefined)]), false);
  assert.equal(isDeclaredSkipOnly('non-un-array'), false);
});

test('#170: il filtro NON e\' un allowlist di workflow — il nome dello step e\' il discriminante', () => {
  // Guard di forma: se qualcuno domani sostituisse il predicato con un match
  // sul nome del workflow, questo test cadrebbe. La regex deve restare narrow.
  assert.ok(DECLARED_SKIP_STEP_RE.test('Skip on exhausted quota (no false green — watermark must hold)'));
  assert.equal(DECLARED_SKIP_STEP_RE.test('Post-merge follow-up triage'), false);
  assert.equal(DECLARED_SKIP_STEP_RE.test('Pre-flight — quota backoff gate (zero-Claude)'), false,
    'il pre-flight e\' PROCEED-SAFE (continue-on-error) e non fallisce mai: non deve entrare nel filtro');
});

/**
 * Orizzonte della query `--created` (issue #762 item 3).
 *
 * Il filtro vero e' `updatedAt >= since`, ma la query puo' discriminare solo
 * per `created`: l'orizzonte deve quindi coprire la coda, non la sola durata
 * del job piu' lungo. La versione precedente valeva 350+60 minuti, cioe'
 * presumeva che una run non potesse essere piu' vecchia del proprio job — la
 * stessa assunzione che #761 ha smentito sul gemello scan-job-timeouts.mjs.
 */
test('l\'orizzonte della query copre l\'attesa in coda, non la sola durata del job', () => {
  // 24h di coda (il bound che GitHub stesso impone) + 350 min di job + margine.
  assert.ok(
    DEFAULT_RUN_QUERY_HORIZON_MIN >= 24 * 60 + 350,
    `orizzonte ${DEFAULT_RUN_QUERY_HORIZON_MIN} min: non copre una run rimasta in coda 24h`,
  );
  // Il vecchio valore era 410: se qualcuno lo reintroduce, questo test lo dice.
  assert.ok(DEFAULT_RUN_QUERY_HORIZON_MIN > 410);
});

test('SCAN_FAILED_RUNS_HORIZON_MIN sovrascrive solo con un numero positivo', () => {
  const quiet = () => {};
  assert.equal(parseHorizonMin('90', { warn: quiet }), 90);
  assert.equal(parseHorizonMin(undefined, { warn: quiet }), DEFAULT_RUN_QUERY_HORIZON_MIN);
  assert.equal(parseHorizonMin('', { warn: quiet }), DEFAULT_RUN_QUERY_HORIZON_MIN);
  assert.equal(parseHorizonMin('non-un-numero', { warn: quiet }), DEFAULT_RUN_QUERY_HORIZON_MIN);
  assert.equal(parseHorizonMin('0', { warn: quiet }), DEFAULT_RUN_QUERY_HORIZON_MIN);
  assert.equal(parseHorizonMin('-5', { warn: quiet }), DEFAULT_RUN_QUERY_HORIZON_MIN);
});

/**
 * #789 item 2 — un override malformato degradava al default IN SILENZIO, e la
 * leva e' l'unica via documentata per comprare il caso delle run in attesa di
 * approvazione: chi la tira crede di aver chiuso quel caso.
 */
test('un override malformato lo dice ad alta voce, uno assente no', () => {
  const seen = [];
  const warn = (m) => seen.push(m);

  assert.equal(parseHorizonMin('2d', { warn }), DEFAULT_RUN_QUERY_HORIZON_MIN);
  assert.equal(seen.length, 1, 'un valore non parsabile deve produrre un warning');
  assert.match(seen[0], /::warning::/);
  assert.match(seen[0], /SCAN_FAILED_RUNS_HORIZON_MIN=2d/);

  // Il default non e' un tradimento di nessuna intenzione: resta muto.
  seen.length = 0;
  parseHorizonMin(undefined, { warn });
  parseHorizonMin('', { warn });
  parseHorizonMin('   ', { warn });
  parseHorizonMin('4320', { warn });
  assert.deepEqual(seen, []);

  // Stessa classe sugli argv: `--lookback-min 40m` azzererebbe la finestra.
  seen.length = 0;
  assert.equal(parsePositiveNum('40m', 40, { label: '--lookback-min', warn }), 40);
  assert.equal(parsePositiveNum('-3', 5, { label: '--max-issues', warn }), 5);
  assert.equal(seen.length, 2);
  assert.match(seen[0], /--lookback-min=40m/);

  // #811 item 6 — `--gate -1` disattiva il gate di ricorrenza (stesso `-1` che
  // `main()` passa gia' come `consecutiveGate` per l'articolo perso). Rifiutarlo
  // come "non positivo" degradava a 3 gridando «override IGNORATO»: la leva non
  // esisteva piu' da CLI, e l'operatore otteneva il contrario di cio' che chiedeva.
  seen.length = 0;
  assert.equal(parsePositiveNum('-1', 3, { label: '--gate', warn, sentinels: [-1] }), -1);
  assert.equal(parsePositiveNum(-1, 3, { label: '--gate', warn, sentinels: [-1] }), -1);
  assert.deepEqual(seen, [], 'un sentinel dichiarato non e\' un override tradito: nessun warning');

  // Il sentinel vale SOLO dove e' dichiarato, e solo per quel valore: `-1` su
  // una durata resta un errore, e `-2` non diventa magico su `--gate`.
  assert.equal(parsePositiveNum('-1', 40, { label: '--lookback-min', warn }), 40);
  assert.equal(parsePositiveNum('-2', 3, { label: '--gate', warn, sentinels: [-1] }), 3);
  assert.equal(seen.length, 2);
  assert.match(seen[1], /valori speciali ammessi \(-1\)/);

  // "Leva non tirata" non deve diventare "leva tirata a 0" per un sentinel 0:
  // `Number('')` e `Number(null)` valgono 0, il sentinel richiede un valore presente.
  seen.length = 0;
  assert.equal(parsePositiveNum(undefined, 3, { label: '--gate', warn, sentinels: [0] }), 3);
  assert.equal(parsePositiveNum('', 3, { label: '--gate', warn, sentinels: [0] }), 3);
  assert.equal(parsePositiveNum(null, 3, { label: '--gate', warn, sentinels: [0] }), 3);
  assert.equal(parsePositiveNum('0', 3, { label: '--gate', warn, sentinels: [0] }), 0);
  assert.deepEqual(seen, []);
});

/**
 * #789 items 3 e 4 — il canary misurava l'ETA' delle sole run segnalabili:
 * banda utile ~225 minuti su un orizzonte di 1.850, e bound delle 24h di coda
 * assunto invece che misurato. La quantita' che decide se una run sfugge alla
 * query e' lo SPAN `createdAt -> updatedAt`, ed e' definita su OGNI run tornata
 * dalla query.
 */
test('la pressione sull\'orizzonte si misura sullo span, su tutte le run della query', () => {
  const base = Date.parse('2026-09-04T12:00:00Z');
  const horizonMin = 1000;
  const span = (min, updatedAgoMin = 0) => ({
    createdAt: new Date(base - (min + updatedAgoMin) * 60_000).toISOString(),
    updatedAt: new Date(base - updatedAgoMin * 60_000).toISOString(),
    url: `https://example.test/${min}`,
  });

  // Sotto il 90% dell'orizzonte: nessuna pressione, nessun rumore.
  const calm = horizonPressure([span(10), span(500)], { horizonMin });
  assert.equal(calm.overThreshold, 0);
  assert.equal(Math.round(calm.maxSpanMin), 500);
  assert.equal(calm.sampled, 2);

  // Oltre: si contano TUTTE le run vicine al cutoff, non solo la peggiore.
  const hot = horizonPressure([span(10), span(950), span(980)], { horizonMin });
  assert.equal(hot.overThreshold, 2);
  assert.equal(Math.round(hot.maxSpanMin), 980);

  // La run non deve essere aggiornata di recente per contare: e' proprio il
  // caso che la banda stretta del canary precedente non vedeva.
  const stale = horizonPressure([span(960, 5000)], { horizonMin });
  assert.equal(stale.overThreshold, 1);

  // Una run che fallisce senza aver mai eseguito un job contribuisce con lo
  // span che ha davvero: nessun bound di 24h dato per buono.
  const gate = horizonPressure([span(3 * 24 * 60)], { horizonMin });
  assert.equal(gate.overThreshold, 1);
  assert.ok(gate.maxSpanMin > 24 * 60);

  // Date rotte o assenti non fanno ne' passare ne' fallire nulla.
  const broken = horizonPressure([{ createdAt: 'boh' }, {}], { horizonMin });
  assert.equal(broken.sampled, 0);
  assert.equal(broken.maxSpanMin, null);
  assert.equal(horizonPressure(null, { horizonMin }).sampled, 0);
});

/**
 * #789 item 1 — `gh run list` torna ordinato per `createdAt` DECRESCENTE:
 * un cap raggiunto tronca le run PIU' VECCHIE, cioe' esattamente la classe che
 * l'orizzonte largo esiste per recuperare. La bisezione la recupera.
 */
test('il cap raggiunto biseca la finestra invece di perdere le run piu\' vecchie', () => {
  const nowMs = Date.parse('2026-09-04T12:00:00Z');
  const startMs = nowMs - 1890 * 60_000;
  const cap = 4;
  // 10 run distribuite sull'intera finestra: una singola query capped ne
  // restituirebbe solo le 4 piu' recenti.
  const all = Array.from({ length: 10 }, (_, i) => ({
    databaseId: i,
    createdAt: new Date(startMs + i * 180 * 60_000).toISOString(),
  }));
  const calls = [];
  const fetchWindow = (aIso, bIso) => {
    calls.push([aIso, bIso]);
    const aMs = Date.parse(aIso);
    const bMs = bIso === null ? nowMs : Date.parse(bIso);
    return all
      .filter((r) => {
        const c = Date.parse(r.createdAt);
        return c >= aMs && c <= bMs;
      })
      .sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt))
      .slice(0, cap);
  };

  const got = fetchRunsBisected(startMs, null, { fetchWindow, nowMs, cap, warn: () => {} });
  assert.deepEqual(got.map((r) => r.databaseId).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(calls.length > 1, 'la finestra piena deve essere bisecata');

  // Caso normale: una sola chiamata, nessun costo aggiunto.
  const cheapCalls = [];
  const cheap = fetchRunsBisected(startMs, null, {
    fetchWindow: (a, b) => { cheapCalls.push([a, b]); return all.slice(0, 2); },
    nowMs,
    cap,
    warn: () => {},
  });
  assert.equal(cheapCalls.length, 1);
  assert.equal(cheap.length, 2);
  assert.equal(cheapCalls[0][1], null, 'la finestra di primo livello resta aperta a destra');
});

test('la bisezione esausta dichiara QUALE estremo e\' stato troncato', () => {
  const nowMs = Date.parse('2026-09-04T12:00:00Z');
  const warnings = [];
  const got = fetchRunsBisected(nowMs - 60_000, null, {
    // Sempre piena: la bisezione non puo' risolvere, deve dirlo.
    fetchWindow: () => [{ databaseId: 1 }, { databaseId: 2 }],
    nowMs,
    cap: 2,
    maxDepth: 2,
    warn: (m) => warnings.push(m),
  });
  assert.equal(got.length, 2);
  assert.ok(warnings.length > 0);
  assert.match(warnings[0], /::warning::/);
  assert.match(warnings[0], /VECCHIO/, 'il warning deve dire che a sparire sono le run piu\' vecchie');
});

/**
 * Una slice la cui query FALLISCE non e' una slice risolta. Se errore e
 * finestra vuota collassano sullo stesso `[]`, la bisezione dichiara copertura
 * completa proprio sulla finestra che non ha letto, e il troncamento — che
 * prima della bisezione partiva SEMPRE al cap raggiunto — torna muto.
 */
test('la slice con query fallita (null) grida invece di passare per risolta', () => {
  const nowMs = Date.parse('2026-09-04T12:00:00Z');
  const startMs = nowMs - 1890 * 60_000;

  // Fallimento totale: nessuna run letta, un warning esplicito, zero silenzio.
  const warnings = [];
  const got = fetchRunsBisected(startMs, null, {
    fetchWindow: () => null,
    nowMs,
    cap: 4,
    warn: (m) => warnings.push(m),
  });
  assert.equal(got.length, 0);
  assert.equal(warnings.length, 1, 'un solo warning: il fallimento non fa fan-out di bisezione');
  assert.match(warnings[0], /::warning::/);
  assert.match(warnings[0], /FALLITA/);
  assert.match(warnings[0], new RegExp(new Date(startMs).toISOString()), 'il warning nomina la finestra non letta');

  // Fallimento PERSISTENTE di una sola sotto-finestra: le altre restano
  // valide, e la finestra persa viene dichiarata con i suoi estremi.
  //
  // L'assertion di prima era `partial.length > 0`, verde anche se OGNI
  // sotto-slice fosse tornata `null` — le run che la soddisfacevano venivano
  // dal batch di primo livello, letto PRIMA che qualunque sotto-finestra
  // fallisse. Qui si asserisce il set esatto di `databaseId` (#811 item 7).
  const cap = 2;
  const all = Array.from({ length: 6 }, (_, i) => ({
    databaseId: i,
    createdAt: new Date(startMs + i * 300 * 60_000).toISOString(),
  }));
  const window = (aIso, bIso) => {
    const aMs = Date.parse(aIso);
    const bMs = bIso === null ? nowMs : Date.parse(bIso);
    return all
      .filter((r) => Date.parse(r.createdAt) >= aMs && Date.parse(r.createdAt) <= bMs)
      .sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt))
      .slice(0, cap);
  };
  // La meta' piu' VECCHIA di primo livello — quella che la bisezione esiste
  // per recuperare — fallisce SEMPRE, retry con split compreso.
  const midMs = Math.floor((startMs + nowMs) / 2);
  const partialWarnings = [];
  const partial = fetchRunsBisected(startMs, null, {
    fetchWindow: (aIso, bIso) => (Date.parse(aIso) <= midMs && bIso !== null ? null : window(aIso, bIso)),
    nowMs,
    cap,
    warn: (m) => partialWarnings.push(m),
  });
  // Le sole run leggibili sono quelle della meta' RECENTE: la 5 e la 4 (dal
  // batch di primo livello e dalle sue sotto-finestre). La 0, 1, 2 e 3 cadono
  // tutte nella meta' vecchia, che nemmeno il retry con split legge.
  assert.deepEqual(
    partial.map((r) => r.databaseId).sort((a, b) => a - b),
    [4, 5],
    'restano ESATTAMENTE le run delle slice riuscite',
  );
  const lost = partialWarnings.filter((m) => /FALLITA/.test(m));
  assert.equal(lost.length, 1, 'una finestra persa, un warning — ne\' zero ne\' uno per foglia');
  assert.match(lost[0], new RegExp(new Date(startMs).toISOString()), 'il warning nomina la finestra persa');
});

/**
 * #811 item 2 — se la query fallisce PER AMPIEZZA (timeout lato `gh`, range
 * `--created A..B` rifiutato per estensione), lo split e' il rimedio: era
 * l'unico caso in cui non veniva tentato, e la finestra larga che fallisce
 * sistematicamente restava a copertura ZERO dove il codice pre-bisezione
 * almeno troncava.
 */
test('la slice fallita viene ritentata UNA volta con lo split prima di essere dichiarata persa', () => {
  const nowMs = Date.parse('2026-09-04T12:00:00Z');
  const startMs = nowMs - 1890 * 60_000;
  const all = Array.from({ length: 6 }, (_, i) => ({
    databaseId: i,
    createdAt: new Date(startMs + i * 300 * 60_000).toISOString(),
  }));
  const maxSpanMs = Math.floor((nowMs - startMs) / 2) + 1;
  const warnings = [];
  const calls = [];
  const got = fetchRunsBisected(startMs, null, {
    // Ogni finestra piu' larga della meta' fallisce: e' la firma del timeout
    // per ampiezza. Le due meta' passano.
    fetchWindow: (aIso, bIso) => {
      calls.push([aIso, bIso]);
      const aMs = Date.parse(aIso);
      const bMs = bIso === null ? nowMs : Date.parse(bIso);
      if (bMs - aMs > maxSpanMs) return null;
      return all.filter((r) => {
        const c = Date.parse(r.createdAt);
        return c >= aMs && c <= bMs;
      });
    },
    nowMs,
    cap: 100,
    warn: (m) => warnings.push(m),
  });
  assert.deepEqual(
    got.map((r) => r.databaseId).sort((a, b) => a - b),
    [0, 1, 2, 3, 4, 5],
    'lo split recupera l\'intera finestra che la query larga non sapeva leggere',
  );
  assert.deepEqual(warnings, [], 'una finestra recuperata dal retry non e\' una perdita');
  assert.equal(calls.length, 3, 'una chiamata fallita + le due meta\': il retry non e\' ricorsivo');
});

/**
 * #811 item 4 — `byId` eredita l'ordine di INSERIMENTO (primo livello, poi
 * meta' vecchia, poi recente): dopo una bisezione l'ordine di `gh run list`
 * non vale piu'. A valle il raggruppamento per workflow lo eredita e il cap
 * `MAX_ISSUES` tronca, quindi QUALI workflow ricevono la issue smetterebbe di
 * essere "i piu' recenti" senza che nulla fallisca.
 */
test('dopo la bisezione le run tornano ordinate per createdAt decrescente', () => {
  const nowMs = Date.parse('2026-09-04T12:00:00Z');
  const startMs = nowMs - 1890 * 60_000;
  const cap = 2;
  const all = Array.from({ length: 8 }, (_, i) => ({
    databaseId: i,
    createdAt: new Date(startMs + i * 200 * 60_000).toISOString(),
  }));
  const got = fetchRunsBisected(startMs, null, {
    fetchWindow: (aIso, bIso) => {
      const aMs = Date.parse(aIso);
      const bMs = bIso === null ? nowMs : Date.parse(bIso);
      return all
        .filter((r) => Date.parse(r.createdAt) >= aMs && Date.parse(r.createdAt) <= bMs)
        .sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt))
        .slice(0, cap);
    },
    nowMs,
    cap,
    warn: () => {},
  });
  assert.deepEqual(got.map((r) => r.databaseId), [7, 6, 5, 4, 3, 2, 1, 0]);

  // Una run senza `createdAt` leggibile non si infila in cima al cap.
  const undated = fetchRunsBisected(startMs, null, {
    fetchWindow: () => [{ databaseId: 'x' }, all[0], { databaseId: 'y', createdAt: 'boh' }, all[3]],
    nowMs,
    cap: 100,
    warn: () => {},
  });
  assert.deepEqual(undated.map((r) => r.databaseId), [3, 0, 'x', 'y']);
});

/**
 * #811 item 1 — `gh run list --json` stampa `[]` quando non trova niente:
 * stdout VUOTO su exit 0 e' una finestra NON letta, non una finestra vuota.
 * `JSON.parse(raw || '[]')` la faceva cadere su `[]`, e `[].length < cap`
 * chiude la slice come risolta — il buco muto rientrava dalla porta accanto.
 */
test('stdout vuoto su exit 0 e\' una finestra non letta, non una finestra vuota', () => {
  assert.deepEqual(parseRunListJson('[]'), [], 'la finestra davvero vuota resta leggibile');
  assert.deepEqual(parseRunListJson('[{"databaseId":1}]'), [{ databaseId: 1 }]);
  for (const unread of ['', '   ', '\n', null, undefined, '{"a":1}', '3', 'null', 'non-json']) {
    assert.equal(parseRunListJson(unread), null, `${JSON.stringify(unread)} deve valere "non letta"`);
  }

  // E il `null` arriva davvero fino alla bisezione, che lo grida.
  const nowMs = Date.parse('2026-09-04T12:00:00Z');
  const warnings = [];
  const got = fetchRunsBisected(nowMs - 60_000, null, {
    fetchWindow: () => parseRunListJson(''),
    nowMs,
    cap: 2,
    maxDepth: 0,
    warn: (m) => warnings.push(m),
  });
  assert.equal(got.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /FALLITA/);
});

/** Output di `gh` illeggibile o di forma inattesa: errore, non finestra vuota. */
test('la slice con batch non-array e\' trattata come query fallita', () => {
  const nowMs = Date.parse('2026-09-04T12:00:00Z');
  for (const bad of [undefined, {}, '[]', 0]) {
    const warnings = [];
    const got = fetchRunsBisected(nowMs - 60_000, null, {
      fetchWindow: () => bad,
      nowMs,
      cap: 2,
      warn: (m) => warnings.push(m),
    });
    assert.equal(got.length, 0);
    assert.match(warnings[0] ?? '', /FALLITA/, `batch ${JSON.stringify(bad)} deve gridare`);
  }
});
