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
