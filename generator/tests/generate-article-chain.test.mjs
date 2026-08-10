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
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, chmodSync, existsSync } from 'node:fs';
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
    const nodeStub = `#!/usr/bin/env bash
n=0
[ -f "${calls}" ] && n=$(cat "${calls}")
n=$((n + 1))
echo "$n" > "${calls}"
printf '%s\\n' "$*" >> "${argv}"
line="$(sed -n "\${n}p" "${planFile}")"
[ -z "$line" ] && line="0 0 0"
read -r rc prod slp <<< "$line"
[ -n "\${slp:-}" ] && [ "$slp" != "0" ] && sleep "$slp"
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

    const stdout = execFileSync('bash', [script], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: dir,
        TARGET_SECTION: section,
        EVENT_NAME: event,
        SOURCE_URL: url,
        GITHUB_OUTPUT: ghOutput,
        ...(budget === null ? {} : { GENERATE_BUDGET_S: String(budget) }),
        ...(hardKill === null ? {} : { GENERATE_HARD_KILL_S: String(hardKill) }),
      },
    });

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
    return { outputs, invocations, caps, stdout };
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
  assert.match(WF, /timeout-minutes: 60/);
});

// ── La condizione di stop resta quella progettata ─────────────────────────────

test('il trigger push chaina ancora solo su content/**, mai sul bookkeeping', () => {
  const onBlock = ACTIVE.slice(ACTIVE.indexOf('on:'), ACTIVE.indexOf('concurrency:'));
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
