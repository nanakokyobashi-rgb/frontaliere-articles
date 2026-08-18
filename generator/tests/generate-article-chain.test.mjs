/**
 * generate-article.yml — la catena self-trigger e il segnale «articolo prodotto».
 * Run with `node --test generator/tests/generate-article-chain.test.mjs`.
 *
 * DUE DIFETTI, UNA SOLA CAUSA. Il workflow aveva due nozioni diverse di «questo
 * run ha prodotto un articolo»:
 *
 *   1. `generated=true`, scritto ogni volta che create-article.mjs esce 0 — e
 *      uscire 0 senza scrivere niente e' l'esito NORMALE, come dice il commento
 *      dello step stesso. Il summary leggeva quello. Verificato sul run
 *      31405881104: il log diceva «Tutte le keyword evergreen risultano gia'
 *      coperte dal pre-flight», lo step di commit stampava «no article generated
 *      this run», e il summary diceva `Generated: true`.
 *   2. il body per locale aggiunto sotto content/blog-body{,-ch}/<loc>/<id>.ts,
 *      che e' il segnale onesto — quello su cui gia' si basava il titolo del
 *      commit, e quello su cui si basa fast-publish-article.yml.
 *
 * Ora la definizione e' una sola (`article_body_added` nello step `Generate the
 * article`) e sia il titolo del commit sia il summary leggono i suoi output. I
 * test qui sotto pinnano quell'unicita', perche' due definizioni che dicono la
 * stessa cosa nel 90% dei run sono esattamente il difetto che ha resistito: non
 * si notano finche' non divergono.
 *
 * LA CATENA. Il chain link e' l'ARTICOLO, non il run: solo un push che tocca
 * content/** riaccende il workflow. La sezione alterna a ogni anello, quindi un
 * anello assegnato a una sezione secca era terminale — misurato tre volte su tre
 * il 2026-08-10 (run 31402855968, 31405881104, 31379813715), tutti `svizzera`,
 * tutti senza articolo, tutti senza push. Il fallback prova l'altra sezione
 * DENTRO lo stesso run, quindi non aggiunge run e non tocca la condizione di
 * stop. La proprieta' che va dimostrata e' che termini: il blocco `run:` viene
 * estratto ed ESEGUITO qui contro `node`/`timeout`/`git` stubbati, e i test
 * contano i tentativi.
 *
 * PERCHE' ESEGUIRE E NON SOLO GREPPARE. Un test a regex su «c'e' un break»
 * passa anche su un loop che non termina. Contare le invocazioni di
 * create-article.mjs e' l'unica forma che distingue le due cose.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WF_PATH = path.resolve(HERE, '../../.github/workflows/generate-article.yml');
const WF = readFileSync(WF_PATH, 'utf8');

/** Solo le righe eseguibili: i commenti citano i difetti e li descriverebbero come presenti. */
const ACTIVE = WF.split('\n')
  .filter((l) => !l.trim().startsWith('#'))
  .join('\n');

/**
 * Estrae il corpo di uno step `run: |`. Volutamente non usa un parser YAML: il
 * repo non ha node_modules e il test deve girare con il solo `node --test`.
 */
function extractRun(stepName) {
  const lines = WF.split('\n');
  const start = lines.findIndex((l) => l === `      - name: ${stepName}`);
  assert.notEqual(start, -1, `step non trovato: ${stepName}`);
  const runAt = lines.findIndex((l, i) => i > start && l === '        run: |');
  assert.notEqual(runAt, -1, `blocco run non trovato per: ${stepName}`);
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') {
      body.push('');
      continue;
    }
    if (!l.startsWith('          ')) break;
    body.push(l.slice(10));
  }
  return body.join('\n');
}

const GENERATE_RUN = extractRun('Generate the article');

/**
 * Esegue il blocco `run:` dello step `Generate the article` con `node`,
 * `timeout` e `git` stubbati su PATH.
 *
 * `plan` e' una riga per invocazione di create-article.mjs: `<exit-code>
 * <ha-prodotto: 0|1> [secondi-di-lavoro]`. Il default per un'invocazione oltre
 * il piano e' `0 0`, cioe' «esce bene e non produce niente» — l'esito che ha
 * ucciso la catena.
 *
 * `budget`/`hardKill` guidano gli omonimi del workflow: il test li porta a
 * pochi secondi per poter misurare l'aritmetica del budget davvero, invece di
 * asserire su una regex che «c'e' una sottrazione».
 */
function runGenerateStep({
  section = 'frontaliere',
  event = 'push',
  url = '',
  plan = [],
  budget = null,
  hardKill = null,
  stall = null,
  stallPoll = null,
  stallGrace = null,
  talkForS = 0,
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'generate-article-chain-'));
  try {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const calls = path.join(dir, 'calls');
    const argv = path.join(dir, 'argv');
    const staged = path.join(dir, 'staged');
    const planFile = path.join(dir, 'plan');
    const ghOutput = path.join(dir, 'github_output');
    const capsFile = path.join(dir, 'caps');

    writeFileSync(planFile, plan.length ? `${plan.join('\n')}\n` : '');
    writeFileSync(ghOutput, '');

    // `timeout --signal=… --kill-after=… <durata> <cmd…>`: registra la durata
    // (il budget e' una delle proprieta' sotto test) ed esegue il comando.
    const timeoutStub = `#!/usr/bin/env bash
while [[ "$1" == --* ]]; do shift; done
echo "$1" >> "${capsFile}"
shift
exec "$@"
`;
    // create-article.mjs. Scrive nell'indice finto quando il piano dice che ha
    // prodotto, cosi' che il probe `git diff --cached --diff-filter=A` lo veda.
    // `trap '' USR1 USR2`: il watchdog dello stallo manda quei due segnali al
    // processo prima di ucciderlo, e per bash nudo la loro azione di default e'
    // TERMINARE — lo stub morirebbe li', prima del kill, e il test misurerebbe
    // la cosa sbagliata. Il `node` vero non ha questo problema: li gestisce (il
    // primo accende l'inspector, il secondo chiede il report diagnostico).
    // La riga su stdout e' il segnale che il watchdog campiona: il log cresce
    // una volta e poi tace, che e' esattamente la forma del wedge in
    // produzione.
    const nodeStub = `#!/usr/bin/env bash
trap '' USR1 USR2
echo "[prompt-budget] stub in esecuzione"
n=0
[ -f "${calls}" ] && n=$(cat "${calls}")
n=$((n + 1))
echo "$n" > "${calls}"
printf '%s\\n' "$*" >> "${argv}"
line="$(sed -n "\${n}p" "${planFile}")"
[ -z "$line" ] && line="0 0 0"
read -r rc prod slp <<< "$line"
[ -n "\${slp:-}" ] && [ "$slp" != "0" ] && sleep "$slp"
talk="\${TALK_FOR_S:-0}"
i=0
while [ "$i" -lt "$talk" ]; do sleep 1; echo "[stub] riga $i"; i=$((i + 1)); done
if [ "$prod" = "1" ]; then echo "content/blog-body/it/articolo-$n.ts" >> "${staged}"; fi
exit "$rc"
`;
    // `git add -A` e' un no-op; il probe legge l'indice finto.
    const gitStub = `#!/usr/bin/env bash
if [ "$1" = "diff" ]; then
  [ -f "${staged}" ] && cat "${staged}"
  exit 0
fi
exit 0
`;
    for (const [name, src] of [['timeout', timeoutStub], ['node', nodeStub], ['git', gitStub]]) {
      const p = path.join(bin, name);
      writeFileSync(p, src);
      chmodSync(p, 0o755);
    }

    const script = path.join(dir, 'step.sh');
    writeFileSync(script, GENERATE_RUN);
    const startedAt = Date.now();

    // ── PERCHE' NON PIU' `execFileSync` NUDO (issue #313 / #348) ─────────────
    // `execFileSync` LANCIA su uscita non-zero, e da quando lo step applica la
    // regola «nessun articolo ⇒ non verde» quasi ogni scenario di questo file —
    // due sezioni secche, un kill duro, un budget esaurito — esce 1 di
    // proposito. Questi test misurano QUALI sezioni sono state tentate e con
    // quale cap, non se lo step e' verde: quel giudizio vive tutto in
    // `no-article-not-green.test.mjs`. Catturare lo status invece di lanciare
    // separa le due domande; incrociarle rendeva rossi sei test su una fix che
    // non ha toccato la sequenza dei tentativi.
    const spawned = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: dir,
        TARGET_SECTION: section,
        EVENT_NAME: event,
        SOURCE_URL: url,
        GITHUB_OUTPUT: ghOutput,
        // Le diagnostiche dello step vanno sotto RUNNER_TEMP. Senza questa
        // riga finirebbero in /tmp/generate-diagnostics, condiviso fra i file
        // di test che `node --test` puo' eseguire in parallelo — e il primo
        // step che parte fa `rm -rf` di quella cartella.
        RUNNER_TEMP: dir,
        TALK_FOR_S: String(talkForS),
        ...(budget === null ? {} : { GENERATE_BUDGET_S: String(budget) }),
        ...(hardKill === null ? {} : { GENERATE_HARD_KILL_S: String(hardKill) }),
        ...(stall === null ? {} : { GENERATE_STALL_S: String(stall) }),
        ...(stallPoll === null ? {} : { GENERATE_STALL_POLL_S: String(stallPoll) }),
        ...(stallGrace === null ? {} : { GENERATE_STALL_GRACE_S: String(stallGrace) }),
      },
    });
    const elapsedMs = Date.now() - startedAt;

    const outputs = Object.fromEntries(
      readFileSync(ghOutput, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    const invocations = existsSync(argv)
      ? readFileSync(argv, 'utf8').split('\n').filter(Boolean)
      : [];
    const caps = existsSync(capsFile)
      ? readFileSync(capsFile, 'utf8').split('\n').filter(Boolean)
      : [];
    const diagFiles = existsSync(path.join(dir, 'generate-diagnostics'))
      ? readdirSync(path.join(dir, 'generate-diagnostics'))
      : [];
    return {
      outputs,
      invocations,
      caps,
      diagFiles,
      elapsedMs,
      stdout: spawned.stdout || '',
      status: spawned.status,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Il segnale: una definizione sola ──────────────────────────────────────────

test('esiste una sola definizione di «articolo prodotto» in tutto il workflow', () => {
  const probes = ACTIVE.match(/--diff-filter=A/g) || [];
  assert.equal(
    probes.length,
    1,
    'due probe = due nozioni di «prodotto» che possono divergere: e\' il difetto, non la fix',
  );
  assert.match(ACTIVE, /article_body_added\(\) \{/);
});

test('il titolo del commit e il summary leggono lo STESSO output', () => {
  const commitStep = extractRun('Commit and push');
  assert.match(
    commitStep,
    /steps\.generate\.outputs\.article/,
    'il titolo del commit deve derivare dal probe, non ricalcolarlo',
  );
  // Il summary riceve il valore via `env:`, quindi l'asserzione sta sul blocco
  // dello step, non sul solo `run:`.
  const summaryBlock = WF.slice(WF.indexOf('      - name: Summary'));
  assert.match(summaryBlock, /ARTICLE: \$\{\{ steps\.generate\.outputs\.article \}\}/);
  assert.match(summaryBlock, /\$ARTICLE/);
});

test('`generated`, l\'output che diceva il falso, non esiste piu\'', () => {
  // Su ACTIVE e non su WF: il commento del summary CITA il vecchio nome per
  // spiegare cosa e' andato storto, ed e' giusto che continui a citarlo.
  assert.ok(
    !/outputs\.generated/.test(ACTIVE),
    'era true a ogni exit 0 di create-article.mjs, cioe\' anche quando non scriveva niente',
  );
  assert.ok(!/echo "generated=/.test(ACTIVE));
});

test('il summary non puo\' dire «generato» su un dry run', () => {
  const summary = extractRun('Summary');
  assert.match(summary, /DRY.*=.*"true"[\s\S]{0,200}dry run/);
});

// ── La catena: il fallback termina ────────────────────────────────────────────

test('la sezione assegnata produce: un solo tentativo, e la sezione e\' quella', () => {
  const r = runGenerateStep({ section: 'frontaliere', plan: ['0 1'] });
  assert.equal(r.outputs.article, 'true');
  assert.equal(r.outputs.section, 'frontaliere');
  assert.equal(r.invocations.length, 1, 'nessun tentativo di troppo quando il primo riesce');
});

test('la sezione assegnata e\' secca: il run prova l\'altra invece di morire', () => {
  const r = runGenerateStep({ section: 'svizzera', plan: ['0 0', '0 1'] });
  assert.equal(r.outputs.article, 'true', 'l\'anello resta produttivo, quindi la catena continua');
  assert.equal(
    r.outputs.section,
    'frontaliere',
    'il commit deve nominare la sezione che ha SCRITTO: l\'anello dopo alterna su questo subject',
  );
  assert.equal(r.invocations.length, 2);
  assert.match(r.invocations[0], /--section=svizzera/, 'la sezione assegnata va provata per prima');
  assert.match(r.invocations[1], /--section=frontaliere/);
});

test('entrambe le sezioni secche: si ferma a due tentativi (TERMINAZIONE)', () => {
  const r = runGenerateStep({ section: 'frontaliere', plan: ['0 0', '0 0', '0 0', '0 0'] });
  assert.equal(r.outputs.article, 'false');
  assert.equal(
    r.invocations.length,
    2,
    'il fallback non e\' un loop: la lista dei tentativi ha una voce per sezione e basta',
  );
  // ...e con `article=false` lo step di commit non trova body da committare, il
  // push non tocca content/**, la catena si ferma dove si e' sempre fermata.
});

test('un hard kill non riparte sull\'altra sezione', () => {
  const r = runGenerateStep({ section: 'svizzera', plan: ['124 0', '0 1'] });
  assert.equal(r.outputs.article, 'false');
  assert.equal(
    r.invocations.length,
    1,
    'un provider che stalla stalla anche per l\'altra sezione, e il budget e\' gia\' speso',
  );
});

test('un exit non-zero non fatale prova comunque l\'altra sezione', () => {
  const r = runGenerateStep({ section: 'svizzera', plan: ['1 0', '0 1'] });
  assert.equal(r.outputs.article, 'true');
  assert.equal(r.outputs.section, 'frontaliere');
  assert.equal(r.invocations.length, 2);
});

test('una dispatch manuale ottiene la sezione che ha chiesto e nessun\'altra', () => {
  const r = runGenerateStep({ section: 'svizzera', event: 'workflow_dispatch', plan: ['0 0'] });
  assert.equal(r.invocations.length, 1);
  assert.match(r.invocations[0], /--section=svizzera/);
});

test('con un URL esplicito non c\'e\' fallback: l\'URL e\' legato alla sezione', () => {
  const r = runGenerateStep({
    section: 'frontaliere',
    event: 'schedule',
    url: 'https://example.invalid/a',
    plan: ['0 0'],
  });
  assert.equal(r.invocations.length, 1);
  assert.match(r.invocations[0], /https:\/\/example\.invalid\/a/);
});

test('il tempo speso piu\' il cap del tentativo dopo non sfora mai il budget', () => {
  // Il primo tentativo brucia 3s di un budget da 6; il secondo puo' quindi
  // valere al massimo 3s, non i 5s del cap per tentativo. Senza il termine
  // `budget − SECONDS` questo test vede 5s e fallisce — ed e' esattamente cosi'
  // che ha trovato la prima stesura della fix, dove due tentativi da 2400s
  // sommavano 4800s contro un `timeout-minutes: 60`.
  const r = runGenerateStep({
    section: 'svizzera',
    plan: ['0 0 3', '0 0'],
    budget: 6,
    hardKill: 5,
  });
  const caps = r.caps.map((c) => Number(String(c).replace(/s$/, '')));
  assert.equal(caps.length, 2, 'entrambi i tentativi devono essere partiti');
  assert.equal(caps[0], 5, 'il primo tentativo prende il cap pieno');
  assert.ok(caps[1] <= 3, `il secondo deve stare nel budget residuo, ha preso ${caps[1]}s`);
});

test('senza budget residuo il tentativo dopo non parte nemmeno', () => {
  const r = runGenerateStep({
    section: 'svizzera',
    // Il primo tentativo consuma tutto: il residuo scende sotto la soglia
    // minima e il secondo va saltato invece che partire condannato.
    plan: ['0 0 2', '0 1'],
    budget: 2,
    hardKill: 5,
  });
  assert.equal(r.invocations.length, 1);
  assert.equal(r.outputs.article, 'false');
  assert.match(r.stdout, /time budget spent/);
});

test('i default restano quelli del workflow, non quelli del test', () => {
  const gen = extractRun('Generate the article');
  assert.match(gen, /budget_s="\$\{GENERATE_BUDGET_S:-3000\}"/);
  assert.match(gen, /hard_kill_s="\$\{GENERATE_HARD_KILL_S:-2400\}"/);
  // 600s = 3,3x il silenzio legittimo piu' lungo mai osservato (182s su cinque
  // run sane campionate il 2026-08-18), contro i 2337s mediani di una run
  // incastrata. Abbassarlo sotto ~200s rimette in gioco le run sane; alzarlo
  // ricompra i quaranta minuti che questa soglia esiste per non pagare.
  assert.match(gen, /stall_s="\$\{GENERATE_STALL_S:-600\}"/);
  assert.match(gen, /stall_poll_s="\$\{GENERATE_STALL_POLL_S:-30\}"/);
  assert.match(gen, /stall_grace_s="\$\{GENERATE_STALL_GRACE_S:-10\}"/);
  assert.match(WF, /timeout-minutes: 60/);
});

// ── IL WEDGE: ucciso dal SILENZIO, non dalla durata ──────────────────────────
//
// 42 run su 69 `failure` dal 13-08 sono lo stesso difetto: il processo tace,
// l'heartbeat da 60s non stampa, nessun handler di segnale gira, e a ucciderlo
// e' solo il SIGKILL del grace di `timeout`, 2459s dopo. Costo misurato: 26,6
// ore in cinque giorni. Il cap di durata non puo' vederlo — su 530 run sane il
// p95 e' 2493s, quindi qualunque cap che prenda il wedge presto uccide run
// buone. Il silenzio invece separa i due regimi di piu' di un ordine di
// grandezza (182s peggiore legittimo contro 2337s mediani nel wedge).
//
// Questi test guidano la soglia in secondi, come gia' fanno budget e cap.

test('un processo muto viene ucciso dallo STALLO, non dal cap di durata', () => {
  const r = runGenerateStep({
    section: 'frontaliere',
    // Stampa una riga e poi dorme 120s: il log cresce una volta e tace. E' la
    // forma esatta del wedge, in scala.
    plan: ['0 0 120'],
    budget: 600,
    hardKill: 300,
    stall: 2,
    stallPoll: 1,
    stallGrace: 1,
  });

  // 1. E' morto molto prima del cap di durata, che era 300s.
  assert.ok(
    r.elapsedMs < 60_000,
    `ucciso dopo ${Math.round(r.elapsedMs / 1000)}s: senza watchdog avrebbe atteso i 300s del cap`,
  );
  assert.ok(r.elapsedMs > 2_000, 'ucciso prima ancora della soglia: la soglia non sta misurando niente');

  // 2. Il cap passato a `timeout` non e' stato toccato: la fix aggiunge un
  //    osservatore, non abbassa il budget — abbassarlo ucciderebbe il 15,5%
  //    delle run sane (82 su 530 a 900s).
  assert.equal(r.caps[0], '300s', 'il cap di durata deve restare quello, intatto');

  // 3. L'esito e' rosso e la ragione e' NOMINATA come stallo, distinta dal kill
  //    duro per budget: escono entrambi 137, quindi il codice di uscita da solo
  //    non li separa e il prossimo lettore non potrebbe contarli.
  assert.equal(r.status, 1, 'nessun articolo e nessuna ragione legittima: rosso');
  assert.match(r.stdout, /watchdog: nessun output per \d+s/);
  assert.match(r.stdout, /::error::.*stallo: nessun output per 2s/);
  assert.ok(
    !/kill duro dopo/.test(r.stdout),
    'un kill per stallo non deve mai essere raccontato come kill duro per budget scaduto',
  );

  // 4. Non ha nemmeno provato l'altra sezione: il muro e' lo stesso, e spendere
  //    il resto del job contro di esso e' quello che costava 40 minuti.
  const attempts = r.invocations.filter((l) => l.includes('create-article.mjs'));
  assert.equal(attempts.length, 1);

  // 5. La diagnostica c'e' davvero: il log del tentativo e la traiettoria di
  //    RSS/CPU restano su disco per l'artifact. Senza, il prossimo wedge
  //    lascerebbe di nuovo solo silenzio.
  assert.ok(r.diagFiles.includes('stalled'), `il flag dello stallo manca: ${r.diagFiles.join(', ')}`);
  assert.ok(r.diagFiles.includes('attempt.log'), `il log del tentativo manca: ${r.diagFiles.join(', ')}`);
  assert.ok(r.diagFiles.includes('resources.log'), `la traiettoria RSS/CPU manca: ${r.diagFiles.join(', ')}`);
});

test('una run che parla non viene toccata dal watchdog, e non lascia diagnostiche', () => {
  // La meta' che protegge dal falso positivo: soglia di 2s, ma lo stub stampa
  // ogni secondo per 4s. Una run sana e' lenta, non muta.
  const r = runGenerateStep({
    section: 'frontaliere',
    plan: ['0 1 0'],
    talkForS: 4,
    budget: 600,
    hardKill: 300,
    stall: 2,
    stallPoll: 1,
    stallGrace: 1,
  });
  assert.equal(r.outputs.article, 'true', 'una run che parla deve arrivare in fondo');
  assert.equal(r.status, 0);
  assert.ok(!/watchdog: nessun output/.test(r.stdout), 'il watchdog ha ucciso una run viva');
  assert.ok(!r.diagFiles.includes('stalled'));
  assert.ok(
    !r.diagFiles.includes('attempt.log'),
    'su una run che ha prodotto non si carica niente: l\'artifact deve restare vuoto',
  );
});

test('il watchdog non sopravvive allo step, e non lo fa fallire da solo', () => {
  const gen = extractRun('Generate the article');
  assert.match(gen, /trap stall_atexit EXIT/, 'senza trap un watchdog resta orfano dopo un exit anticipato');
  assert.match(gen, /kill_tree KILL "\$watch_pid"/, 'il watchdog va ucciso con il tentativo, con tutto il suo albero');
  // Il verdetto sull'esito resta dove stava: il watchdog alza un flag, non esce
  // mai per conto proprio.
  const watchdogBody = gen.slice(gen.indexOf('stall_watchdog() {'), gen.indexOf('watch_pid=""'));
  assert.ok(!/\bexit [0-9]/.test(watchdogBody), 'il watchdog non deve poter terminare lo step da solo');
});

test('lo stallo si valuta PRIMA del kill duro: escono entrambi 137', () => {
  const gen = extractRun('Generate the article');
  const stallAt = gen.indexOf('if [ -f "$stall_flag" ]; then');
  const hardAt = gen.indexOf('if [ "$rc" = "124" ] || [ "$rc" = "137" ]; then');
  assert.notEqual(stallAt, -1, 'il ramo dello stallo e\' sparito');
  assert.notEqual(hardAt, -1);
  assert.ok(
    stallAt < hardAt,
    'con il kill duro valutato per primo ogni stallo verrebbe contato come budget scaduto, ' +
      'e i due difetti tornerebbero indistinguibili nei log',
  );
});

test('le diagnostiche del wedge si caricano sempre, e da fuori il workspace', () => {
  const step = WF.slice(WF.indexOf('      - name: Upload wedge diagnostics'), WF.indexOf('      - name: Guard'));
  assert.ok(step, 'lo step che carica le diagnostiche e\' sparito');
  assert.match(step, /if: always\(\)/, 'lo step sopra e\' ROSSO proprio quando l\'artifact serve');
  assert.match(step, /uses: actions\/upload-artifact@v4/);
  assert.match(
    step,
    /path: \$\{\{ runner\.temp \}\}\/generate-diagnostics/,
    'sotto il workspace il `git add -A` dello step di generazione porterebbe un report diagnostico su main',
  );
  assert.match(step, /if-no-files-found: ignore/);
  // Nessun filtro, nessun tail: `javascriptHeap` e `resourceUsage` del report
  // sono cio' che distingue un thrash del GC da un blocco in codice nativo.
  assert.ok(!/\btail\b|head -/.test(step), 'un troncamento qui butta via proprio le sezioni diagnostiche');
});

test('il generatore gira con i flag di report diagnostico', () => {
  const gen = extractRun('Generate the article');
  assert.match(gen, /--report-on-signal --report-signal=SIGUSR2 --report-directory="\$diag_dir"/);
  // I flag vanno PRIMA del path dello script, o node li passerebbe allo script.
  const line = gen.split('\n').find((l) => l.includes('--report-on-signal'));
  assert.ok(
    gen.indexOf('--report-directory') < gen.indexOf('generator/scripts/create-article.mjs'),
    `i flag di node devono precedere lo script: ${line}`,
  );
  // Il report da solo NON basta per questo difetto (misurato su node v22.23.2:
  // a event loop bloccato non viene scritto), quindi lo stack arriva
  // dall'inspector — che SIGUSR1 accende anche a loop bloccato.
  assert.match(gen, /kill -USR1/, 'senza SIGUSR1 non c\'e\' inspector, e senza inspector non c\'e\' stack');
  assert.match(gen, /Debugger\.pause/, 'il client CDP e\' la sola meta\' che produce lo stack sotto wedge');
});

// ── La condizione di stop resta quella progettata ─────────────────────────────

test('il trigger push chaina ancora solo su content/**, mai sul bookkeeping', () => {
  // Il confine è `permissions:`, non `concurrency:`. Sono la stessa cosa finché
  // `concurrency:` è una chiave di primo livello subito dopo `on:` — e dal
  // 2026-08-13 non lo è più: la #193/#212 l'ha spostata sul job `generate`,
  // dietro il gate `admit`. Con il vecchio confine la slice arrivava fino DENTRO
  // i job, e l'assert negativo qui sotto avrebbe letto anche il loro corpo:
  // un test che passa o fallisce per ciò che sta in un job non è più il test del
  // blocco `on:`. `permissions:` è il primo top-level dopo `on:` in questo file.
  const onBlock = ACTIVE.slice(ACTIVE.indexOf('on:'), ACTIVE.indexOf('\npermissions:'));
  assert.match(onBlock, /- 'content\/\*\*'/);
  assert.ok(
    !/topic-candidates|data\/\*\*|- 'data\//.test(onBlock),
    'un run senza articolo scrive solo data/: metterlo nei paths riarma la ricorsione senza contenuto',
  );
});

test('il workflow non dispatcha se stesso', () => {
  assert.ok(
    !/actions\/workflows\/[^\s]*\/dispatches/.test(ACTIVE),
    'chainare sul RUN invece che sull\'ARTICOLO e\' la forma che gira a vuoto',
  );
});

test('il blocco run del generatore non interpola nulla: niente injection, ed e\' eseguibile qui', () => {
  assert.ok(
    !/\$\{\{/.test(GENERATE_RUN),
    'un `url` da dispatch interpolato nella command line e\' shell injection, e rende il blocco non testabile',
  );
});

// ── La guardia sul percorso di scrittura (issue #267) ─────────────────────────
//
// Fino al 2026-08-13 gli articoli generati non passavano da NESSUNA guardia:
// `tests.yml` ha `push: branches-ignore: [main]` e questo workflow scrive SOLO
// su main — misurato, 0 run di `tests.yml` su main nelle ultime 50 contro ~111
// commit/giorno su `content/**`. Il costo non e' stato teorico: il 2026-08-11 un
// corpo con una legge inventata e' passato di qui e ha tenuto rosso `main` DEL
// SITO per ~13 ore, bloccando sei PR.
//
// Questi test pinnano la STRUTTURA della fix, non il suo esito. Un guard che
// vive in un blocco `run:` puo' essere spostato dopo il push, reso advisory o
// ridotto a una sola suite da una modifica che sembra innocua, e nessuno se ne
// accorgerebbe finche' non ricapita — la stessa forma di silenzio che aveva reso
// invisibile l'assenza del gate.

test('lo step di guardia esiste, e invoca ENTRAMBE le suite dependency-free', () => {
  const guard = extractRun('Guard — l\'articolo generato non raggiunge main se viola le guardie');
  assert.match(guard, /generator\/tests\/article-fabrication-guard\.test\.mjs/);
  assert.match(
    guard,
    /generator\/tests\/prompt-placeholder-guard\.test\.mjs/,
    'le due suite coprono classi diverse (allucinazioni vs segnaposto del prompt): una sola dimezza il gate senza dirlo',
  );
});

test('la guardia gira PRIMA del commit, non dopo', () => {
  const guardAt = WF.indexOf('      - name: Guard — l\'articolo generato non raggiunge main');
  const commitAt = WF.indexOf('      - name: Commit and push');
  assert.notEqual(guardAt, -1, 'lo step di guardia e\' sparito');
  assert.notEqual(commitAt, -1);
  assert.ok(
    guardAt < commitAt,
    'una guardia dopo il commit non impedisce niente: l\'articolo sarebbe gia\' su main, ' +
      'e il cron 2x/giorno del sync del sito potrebbe portarlo al sito comunque',
  );
});

test('la guardia non e\' advisory: un fallimento ferma davvero il push', () => {
  const block = WF.slice(
    WF.indexOf('      - name: Guard — l\'articolo generato non raggiunge main'),
    WF.indexOf('      - name: Generate responsive image thumbnail'),
  );
  assert.ok(
    !/continue-on-error/.test(block),
    'con continue-on-error lo step diventa decorazione: fallisce, si vede rosso, e il commit parte lo stesso',
  );
  // Gli step successivi hanno un `if:` senza status function, quindi GitHub vi
  // applica `success()` implicito: uno step fallito qui li salta entrambi. E'
  // quella proprieta' — non un `if: failure()` scritto a mano — a impedire il
  // commit, quindi va pinnata la sua PRECONDIZIONE: nessuno dei due deve
  // acquisire un `always()`.
  const after = WF.slice(WF.indexOf('      - name: Generate responsive image thumbnail'), WF.indexOf('      - name: Summary'));
  assert.ok(
    !/if: always\(\)/.test(after),
    'un always() su thumbnail o commit rimetterebbe l\'articolo bocciato sulla strada di main',
  );
});

test('la guardia legge lo stesso output degli altri, senza inventarsi un secondo probe', () => {
  const block = WF.slice(
    WF.indexOf('      - name: Guard — l\'articolo generato non raggiunge main'),
    WF.indexOf('      - name: Generate responsive image thumbnail'),
  );
  assert.match(
    block,
    /steps\.generate\.outputs\.article == 'true'/,
    'la nozione di «articolo prodotto» resta una sola: quella di article_body_added',
  );
  assert.ok(
    !/--diff-filter=A/.test(block),
    'un secondo probe qui e\' il difetto che «esiste una sola definizione» esiste per impedire',
  );
});
