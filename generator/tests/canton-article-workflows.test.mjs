/**
 * generate-article-core.yml + i 24 chiamanti generate-article-<cantone>.yml
 * (P8 del piano «sezioni articoli per cantone», D15).
 * Run with `node --test generator/tests/canton-article-workflows.test.mjs`.
 *
 * TRE COSE, e nessuna si vede da una run rossa:
 *
 *   1. I 25 file sono GENERATI. Se uno diverge dal generatore — perche' qualcuno
 *      lo ha corretto a mano, o perche' `generate-article.yml` e' cambiato senza
 *      rigenerare — i cantoni girano con una logica che non e' piu' quella di
 *      frontaliere/svizzera, e niente lo dice. Il confronto e' byte per byte.
 *   2. Il core e' la sorgente piu' le sostituzioni dichiarate. Le sostituzioni
 *      toccano i punti che decidono QUALE sezione scrive e QUALE workflow
 *      riparte: qui i blocchi `run:` del core vengono eseguiti accanto a quelli
 *      della sorgente, e con gli input della coppia storica devono dare lo
 *      stesso esito. E' la prova che il core puo' sostituire la sorgente, non
 *      una promessa.
 *   3. Un chiamante cantonale non deve svegliare gli altri 23, non deve
 *      auto-attivarsi quando vengono aggiornati insieme i caller generati,
 *      non deve ripartire su un run che non ha prodotto niente e non deve
 *      dispatchare una catena. Sono proprieta' dei trigger, cioe' righe che
 *      GitHub interpreta prima che esista uno step.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARTICLE_SECTION_CORE_ALL, isCantonSection } from '../../engine/shared/articleSectionCore.mjs';
import {
  AUTO_GENERATED_MARKER,
  CANTON_SELF_TEST_WORKFLOW,
  CORE_FORBIDDEN_LITERALS,
  CORE_REPLACEMENTS,
  CORE_WORKFLOW,
  SOURCE_WORKFLOW,
  WORKFLOWS_DIR,
  buildAll,
  buildCoreWorkflow,
  buildFromRepo,
  buildSelfTestWorkflow,
  callerWorkflowFile,
  checkGenerated,
  cronExpression,
  hourOffsets,
  sectionCorpusPaths,
  stripComments,
} from '../../scripts/ci/generate-canton-article-workflows.mjs';
import { parseReservedCronMinutes } from '../../scripts/ci/validate-canton-sections.mjs';
import { cantonSectionPaths, loadCantonSectionProfiles } from '../scripts/lib/canton-section-profile.mjs';
import { corpusPath } from '../scripts/lib/corpus-paths.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readWorkflow = (file) => readFileSync(path.join(ROOT, WORKFLOWS_DIR, file), 'utf8');

const SOURCE = readWorkflow(SOURCE_WORKFLOW);
const CORE = readWorkflow(CORE_WORKFLOW);
const SELF_TEST = readWorkflow(CANTON_SELF_TEST_WORKFLOW);
const PROFILES = loadCantonSectionProfiles();
const CANTONS = [...PROFILES.cantons].sort((a, b) => a.section.localeCompare(b.section));
const OFFSETS = hourOffsets(CANTONS);

/** Gli input con cui il core riproduce la coppia storica. */
const PAIR = {
  primary: 'frontaliere',
  sibling: 'svizzera',
  crons: '22 * * * *|37 * * * *',
  bodyRe: '^content/blog-body(-ch)?/[a-z]{2}/.+\\.ts$',
  caller: SOURCE_WORKFLOW,
};

// ── 1. I file sono quelli che il generatore produce ──────────────────────────

test('core e chiamanti su disco sono byte-identici al generato', () => {
  assert.deepEqual(checkGenerated(ROOT), [], 'rigenera con: node scripts/ci/generate-canton-article-workflows.mjs');
  const files = buildFromRepo(ROOT);
  assert.equal(files.size, 26, 'un core, un self-test e 24 chiamanti');
  for (const [file, content] of files) {
    assert.equal(readWorkflow(file), content, file);
    assert.ok(content.startsWith(`${AUTO_GENERATED_MARKER}\n`), `${file}: manca il marcatore in testa`);
    assert.ok(content.endsWith('\n') && !content.endsWith('\n\n'), `${file}: una sola newline finale`);
  }
});

test('un chiamante per ogni sezione cantonale del core, col nome dal codice', () => {
  const coreSections = Object.keys(ARTICLE_SECTION_CORE_ALL).filter((id) => isCantonSection(id)).sort();
  assert.equal(coreSections.length, 24);
  assert.deepEqual(CANTONS.map((c) => c.section), coreSections);
  for (const c of CANTONS) {
    const file = callerWorkflowFile(c.code);
    assert.equal(file, `generate-article-${c.code.toLowerCase()}.yml`);
    assert.ok(existsSync(path.join(ROOT, WORKFLOWS_DIR, file)), `${file} manca`);
  }
  assert.throws(() => callerWorkflowFile('ti'), /codice cantone non valido/);
});

test('un file generato che il generatore non prevede piu\' e\' segnalato come orfano', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'canton-workflows-'));
  try {
    mkdirSync(path.join(dir, WORKFLOWS_DIR), { recursive: true });
    mkdirSync(path.join(dir, 'generator/data'), { recursive: true });
    writeFileSync(path.join(dir, WORKFLOWS_DIR, SOURCE_WORKFLOW), SOURCE);
    writeFileSync(path.join(dir, 'generator/data/canton-sections.json'), JSON.stringify(PROFILES));
    for (const [file, content] of buildFromRepo(ROOT)) writeFileSync(path.join(dir, WORKFLOWS_DIR, file), content);
    assert.deepEqual(checkGenerated(dir), []);

    writeFileSync(path.join(dir, WORKFLOWS_DIR, 'generate-article-xx.yml'), `${AUTO_GENERATED_MARKER}\nname: x\n`);
    writeFileSync(path.join(dir, WORKFLOWS_DIR, 'generate-article-xx-self-test.yml'), `${AUTO_GENERATED_MARKER}\nname: x\n`);
    writeFileSync(path.join(dir, WORKFLOWS_DIR, 'generate-article-ti.yml'), `${readWorkflow('generate-article-ti.yml')}# a mano\n`);
    rmSync(path.join(dir, WORKFLOWS_DIR, 'generate-article-gr.yml'));
    assert.deepEqual(checkGenerated(dir).sort(), [
      'generate-article-gr.yml: manca',
      'generate-article-ti.yml: diverge dal generato',
      'generate-article-xx-self-test.yml: generato ma non piu\' previsto (orfano)',
      'generate-article-xx.yml: generato ma non piu\' previsto (orfano)',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 2. Il core e' la sorgente piu' le sostituzioni dichiarate ────────────────

test('ogni sostituzione dichiara un ancoraggio che la sorgente ha esattamente N volte', () => {
  const ids = CORE_REPLACEMENTS.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'id di sostituzione duplicato');
  for (const r of CORE_REPLACEMENTS) {
    assert.ok(r.count >= 1 && r.find !== r.replace, r.id);
    // Cambiata la prima riga dell'ancoraggio, il generatore si ferma e NOMINA
    // la sostituzione: e' cio' che succede a chi modifica la sorgente li' vicino.
    const first = r.find.split('\n')[0];
    assert.ok(SOURCE.includes(first), `${r.id}: la prima riga dell'ancoraggio non e' nella sorgente`);
    const broken = SOURCE.split(first).join(`${first.slice(0, -1)}~`);
    assert.throws(() => buildCoreWorkflow(broken), (e) => e.message.includes(`«${r.id}»`), r.id);
  }
});

test('nessun nome della coppia storica resta cablato nelle righe eseguibili del core', () => {
  const jobs = CORE.slice(CORE.indexOf('\njobs:\n'));
  assert.ok(!jobs.split('\n').some((l) => l.trim().startsWith('#')), 'il core non porta commenti: le ragioni stanno nella sorgente');
  for (const literal of ['generate-article.yml', 'blog-body']) {
    assert.ok(!jobs.includes(literal), `«${literal}» e' ancora nel core`);
  }
  assert.ok(CORE_FORBIDDEN_LITERALS.includes('svizzera') && CORE_FORBIDDEN_LITERALS.includes('frontaliere'));
  // Il generatore rifiuta una sorgente che reintroduce un nome cablato.
  const tainted = SOURCE.replace('          echo "event=$EV chain=$CHAIN', '          [ "$SEC" = "svizzera" ] && true\n          echo "event=$EV chain=$CHAIN');
  assert.notEqual(tainted, SOURCE);
  assert.throws(() => buildCoreWorkflow(tainted), /ancora «svizzera» cablato/);
});

test('stripComments toglie i commenti ma non tocca un heredoc', () => {
  const text = ['a', '  # commento', '', '', 'cat <<\'EOF\'', '# dato', '', '', 'EOF', 'x <<< "$y"', '# via', 'b'].join('\n');
  assert.equal(stripComments(text), ['a', '', 'cat <<\'EOF\'', '# dato', '', '', 'EOF', 'x <<< "$y"', 'b'].join('\n'));
  assert.throws(() => stripComments('cat <<EOF\nmai chiuso'), /mai chiuso/);
});

/** Il corpo di uno step `run: |`, come lo estrae generate-article-chain.test.mjs. */
function extractRun(workflow, stepName) {
  const lines = workflow.split('\n');
  const start = lines.findIndex((l) => l === `      - name: ${stepName}`);
  assert.notEqual(start, -1, `step non trovato: ${stepName}`);
  const runAt = lines.findIndex((l, i) => i > start && l === '        run: |');
  assert.notEqual(runAt, -1, `blocco run non trovato per: ${stepName}`);
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { body.push(''); continue; }
    if (!l.startsWith('          ')) break;
    body.push(l.slice(10));
  }
  return body.join('\n');
}

/** I nomi degli step di un workflow, nell'ordine in cui compaiono. */
const stepNames = (workflow) => [...workflow.matchAll(/^ {6}- name: (.+)$/gm)].map((m) => m[1]);

test('gli step che le sostituzioni non toccano sono identici alla sorgente, commenti a parte', () => {
  const sourceSteps = stepNames(SOURCE);
  const coreSteps = stepNames(CORE);
  const gateSteps = coreSteps.filter((s) => !sourceSteps.includes(s));
  assert.deepEqual(coreSteps.filter((s) => sourceSteps.includes(s)), sourceSteps, 'il core ha perso o riordinato uno step della sorgente');
  assert.equal(gateSteps.length, 6, `gli step in piu' sono quelli del gate di sezione: ${gateSteps.join(' | ')}`);
  assert.ok(gateSteps.every((s) => s.startsWith('Section gate — ')), 'gli step del gate hanno nomi propri: un omonimo di uno step della sorgente renderebbe ambiguo ogni test che estrae per nome');
  assert.equal(new Set(coreSteps).size, coreSteps.length, 'nomi di step duplicati nel core');

  // Lo step INTERO (if, env, with, run), non solo il blocco run: uno step
  // `uses:` o un `if:` cambiato per sbaglio non hanno un run da confrontare.
  const stepBlock = (wf, name) => {
    const lines = wf.split('\n');
    const at = lines.indexOf(`      - name: ${name}`);
    assert.notEqual(at, -1, `step non trovato: ${name}`);
    const next = lines.findIndex((l, i) => i > at && (/^ {6}- name: /.test(l) || /^ {2}[a-z_]+:$/.test(l)));
    return lines.slice(at, next === -1 ? undefined : next).join('\n').replace(/\n+$/, '');
  };
  const strippedSource = stripComments(SOURCE.slice(SOURCE.indexOf('\njobs:\n')));
  const touched = ['Skip when a generation is already in flight', 'Resolve run mode and section', 'Generate the article', 'Chain — dispatch the next link'];
  for (const name of sourceSteps) {
    if (touched.includes(name)) assert.notEqual(stepBlock(CORE, name), stepBlock(strippedSource, name), `${name}: atteso diverso`);
    else assert.equal(stepBlock(CORE, name), stepBlock(strippedSource, name), name);
  }
  assert.ok(sourceSteps.length - touched.length >= 10, 'quasi tutti gli step della sorgente passano nel core senza modifiche');
});

test('ogni blocco run del core e\' bash sintatticamente valido', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'canton-core-syntax-'));
  try {
    let checked = 0;
    for (const name of stepNames(CORE)) {
      const lines = CORE.split('\n');
      const at = lines.indexOf(`      - name: ${name}`);
      const next = lines.findIndex((l, i) => i > at && /^ {6}- name: /.test(l));
      if (!lines.slice(at, next === -1 ? undefined : next).includes('        run: |')) continue;
      const file = path.join(dir, 'step.sh');
      writeFileSync(file, extractRun(CORE, name).replace(/\$\{\{[^}]*\}\}/g, 'X'));
      const res = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
      assert.equal(res.status, 0, `${name}: ${res.stderr}`);
      checked += 1;
    }
    assert.ok(checked >= 12, `controllati solo ${checked} blocchi`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Esecuzione dei blocchi: la sorgente accanto al core ──────────────────────

function withBin(stubs, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'canton-core-run-'));
  try {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    for (const [name, src] of Object.entries(stubs(dir))) {
      writeFileSync(path.join(bin, name), src);
      chmodSync(path.join(bin, name), 0o755);
    }
    return fn(dir, bin);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const readOutputs = (file) => Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter(Boolean)
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

/**
 * Esegue lo step «Generate the article» di `workflow`. `plan` ha una riga per
 * invocazione di create-article.mjs: `<exit> <path del corpo aggiunto | ->`.
 */
function runGenerate(workflow, { env, plan }) {
  return withBin((dir) => ({
    timeout: '#!/usr/bin/env bash\nwhile [[ "$1" == --* ]]; do shift; done\nshift\nexec "$@"\n',
    node: `#!/usr/bin/env bash
trap '' USR1 USR2
echo "[stub] create-article"
n=0; [ -f "${dir}/calls" ] && n=$(cat "${dir}/calls")
n=$((n + 1)); echo "$n" > "${dir}/calls"
printf '%s\\n' "$*" >> "${dir}/argv"
line="$(sed -n "\${n}p" "${dir}/plan")"
[ -z "$line" ] && line="0 -"
read -r rc body <<< "$line"
[ "$body" != "-" ] && echo "$body" >> "${dir}/staged"
exit "$rc"
`,
    git: `#!/usr/bin/env bash
if [ "$1" = "diff" ] && [ "\${3:-}" != "--name-status" ] && [ -f "${dir}/staged" ]; then cat "${dir}/staged"; fi
exit 0
`,
  }), (dir, bin) => {
    writeFileSync(path.join(dir, 'plan'), `${plan.join('\n')}\n`);
    writeFileSync(path.join(dir, 'out'), '');
    writeFileSync(path.join(dir, 'step.sh'), extractRun(workflow, 'Generate the article'));
    const res = spawnSync('bash', [path.join(dir, 'step.sh')], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`, HOME: dir, RUNNER_TEMP: dir, GITHUB_OUTPUT: path.join(dir, 'out'),
        SOURCE_URL: '', ...env,
      },
    });
    const argv = existsSync(path.join(dir, 'argv')) ? readFileSync(path.join(dir, 'argv'), 'utf8').split('\n').filter(Boolean) : [];
    return {
      status: res.status,
      stdout: res.stdout,
      outputs: readOutputs(path.join(dir, 'out')),
      sections: argv.map((a) => (/--section=(\S+)/.exec(a) || [])[1]),
      outcome: (/GENERATION_OUTCOME .*/.exec(res.stdout) || [''])[0],
    };
  });
}

/** Esegue il gate `admit` con un compare GitHub finto. */
function runAdmit(workflow, { caller, changed }) {
  return withBin((dir) => ({
    gh: `#!/usr/bin/env bash
case "\${2:-}" in
  *compare*) cat "${dir}/changed" ;;
  *) printf '%s\\n' '{"workflow_runs":[]}' ;;
esac
`,
  }), (dir, bin) => {
    writeFileSync(path.join(dir, 'changed'), `${changed.join('\n')}\n`);
    writeFileSync(path.join(dir, 'out'), '');
    writeFileSync(path.join(dir, 'step.sh'), extractRun(workflow, 'Skip when a generation is already in flight'));
    const res = spawnSync('bash', [path.join(dir, 'step.sh')], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`, HOME: dir, GITHUB_OUTPUT: path.join(dir, 'out'),
        REPO: 'owner/repo', SELF_ID: '4242', EVENT_NAME: 'push',
        PUSH_BEFORE: 'before', PUSH_SHA: 'after', CHAIN_DEPTH: '0', PARENT_RUN_ID: '',
        CHAIN_MAX_RUNS_PER_HOUR: '', CALLER_WORKFLOW: caller,
      },
    });
    return { status: res.status, stdout: res.stdout, outputs: readOutputs(path.join(dir, 'out')) };
  });
}

test('admit elegge un solo self-test dry quando un commit cambia piu\' caller', () => {
  const batch = [
    '.github/workflows/generate-article.yml',
    '.github/workflows/generate-article-appenzello.yml',
    '.github/workflows/generate-article-ag.yml',
    '.github/workflows/generate-article-core.yml',
  ];
  const elected = runAdmit(CORE, { caller: 'generate-article-ag.yml', changed: batch });
  assert.equal(elected.status, 0);
  assert.equal(elected.outputs.proceed, 'true');
  assert.match(elected.stdout, /Self-test dry eletto per il batch: generate-article-ag\.yml/);

  const skipped = runAdmit(CORE, { caller: 'generate-article-appenzello.yml', changed: batch });
  assert.equal(skipped.status, 0);
  assert.equal(skipped.outputs.proceed, 'false');
  assert.match(skipped.stdout, /reason=self-test-batch/);

  const single = runAdmit(CORE, {
    caller: 'generate-article-appenzello.yml',
    changed: ['.github/workflows/generate-article-appenzello.yml'],
  });
  assert.equal(single.outputs.proceed, 'true');

  const source = runAdmit(SOURCE, {
    caller: 'generate-article.yml',
    changed: batch,
  });
  assert.equal(source.status, 0);
  assert.equal(source.outputs.proceed, 'true');
  assert.match(source.stdout, /workflow sorgente: non partecipa al batch cantonale/);
});

const pairGenerateEnv = (extra) => ({ BODY_PATH_RE: PAIR.bodyRe, PRIMARY_SECTION: PAIR.primary, SIBLING_SECTION: PAIR.sibling, ...extra });

test('Generate the article: con gli input della coppia storica il core si comporta come la sorgente', () => {
  const scenarios = [
    { name: 'frontaliere produce', env: { TARGET_SECTION: 'frontaliere', EVENT_NAME: 'push' }, plan: ['0 content/blog-body/it/a.ts'] },
    { name: 'svizzera secca, ripiega su frontaliere', env: { TARGET_SECTION: 'svizzera', EVENT_NAME: 'schedule' }, plan: ['4 -', '0 content/blog-body/en/a.ts'] },
    { name: 'frontaliere secca, ripiega su svizzera', env: { TARGET_SECTION: 'frontaliere', EVENT_NAME: 'push' }, plan: ['4 -', '0 content/blog-body-ch/it/a.ts'] },
    { name: 'entrambe secche, dichiarato', env: { TARGET_SECTION: 'svizzera', EVENT_NAME: 'push' }, plan: ['4 -', '4 -'] },
    { name: 'dispatch umano: una sola sezione', env: { TARGET_SECTION: 'svizzera', EVENT_NAME: 'workflow_dispatch', CHAIN_LINK: 'false' }, plan: ['4 -', '0 content/blog-body/it/a.ts'] },
    { name: 'anello della catena: tiene il fallback', env: { TARGET_SECTION: 'svizzera', EVENT_NAME: 'workflow_dispatch', CHAIN_LINK: 'true' }, plan: ['4 -', '0 content/blog-body/it/a.ts'] },
    { name: 'uscita 0 senza corpo: non dichiarato', env: { TARGET_SECTION: 'frontaliere', EVENT_NAME: 'push' }, plan: ['0 -', '0 -'] },
    { name: 'un file che non e\' un corpo non e\' un articolo', env: { TARGET_SECTION: 'frontaliere', EVENT_NAME: 'push' }, plan: ['4 content/blog-meta-it.ts', '4 -'] },
  ];
  for (const s of scenarios) {
    const source = runGenerate(SOURCE, { env: s.env, plan: s.plan });
    const core = runGenerate(CORE, { env: pairGenerateEnv(s.env), plan: s.plan });
    assert.deepEqual(
      { status: core.status, outputs: core.outputs, sections: core.sections, outcome: core.outcome },
      { status: source.status, outputs: source.outputs, sections: source.sections, outcome: source.outcome },
      s.name,
    );
    assert.ok(source.sections.length >= 1, `${s.name}: la sorgente non ha tentato niente`);
  }
});

test('Generate the article: un cantone tenta SOLO la propria sezione e riconosce SOLO i propri corpi', () => {
  const { bodyPathRegex } = sectionCorpusPaths('canton-ti');
  const env = { TARGET_SECTION: 'canton-ti', EVENT_NAME: 'schedule', BODY_PATH_RE: bodyPathRegex, PRIMARY_SECTION: 'canton-ti', SIBLING_SECTION: '' };

  const produced = runGenerate(CORE, { env, plan: ['0 content/blog-body-canton-ti/it/nuovo.ts'] });
  assert.equal(produced.status, 0);
  assert.deepEqual(produced.sections, ['canton-ti']);
  assert.equal(produced.outputs.article, 'true');
  assert.equal(produced.outputs.section, 'canton-ti');
  assert.match(produced.outcome, /kind=generated reason=article section=canton-ti/);

  // Pool secco: nessun ripiego su un'altra sezione, e l'esito resta dichiarato.
  const dry = runGenerate(CORE, { env, plan: ['4 -', '0 content/blog-body/it/intruso.ts'] });
  assert.deepEqual(dry.sections, ['canton-ti'], 'un cantone non ha una gemella su cui ripiegare');
  assert.equal(dry.outputs.article, 'false');
  assert.equal(dry.outputs.declared, 'true');
  assert.equal(dry.status, 0);

  // Il corpo di un'altra sezione non prova un articolo di questa.
  for (const foreign of ['content/blog-body/it/x.ts', 'content/blog-body-ch/it/x.ts', 'content/blog-body-canton-gr/it/x.ts', 'content/blog-body-canton-ti-extra/it/x.ts']) {
    const res = runGenerate(CORE, { env, plan: [`0 ${foreign}`] });
    assert.equal(res.outputs.article, 'false', foreign);
    assert.equal(res.status, 1, `${foreign}: uscita 0 senza un corpo della sezione non e' un esito dichiarato`);
  }
});

/** Esegue lo step «Chain» di `workflow` con `curl` e `sleep` finti. */
function runChain(workflow, env) {
  return withBin((dir) => ({
    curl: `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${dir}/curl-args"\nprintf '204'\n`,
    sleep: '#!/usr/bin/env bash\nexit 0\n',
  }), (dir, bin) => {
    writeFileSync(path.join(dir, 'step.sh'), extractRun(workflow, 'Chain — dispatch the next link'));
    const res = spawnSync('bash', [path.join(dir, 'step.sh')], {
      encoding: 'utf8',
      cwd: dir,
      env: {
        PATH: `${bin}:${process.env.PATH}`, HOME: dir,
        REPO: 'owner/repo', SELF_ID: '4242', DRY: 'false', ARTICLE: 'false', DECLARED: 'true', ROSTER_BLOCKED: 'false',
        CHAIN_DEPTH: '2', NO_ARTICLE_STREAK: '1', RESCUE_DEPTH: '0', CHAIN_ARMED: '', GITHUB_PAT_NANAKO: 'tok',
        ...env,
      },
    });
    const args = existsSync(path.join(dir, 'curl-args')) ? readFileSync(path.join(dir, 'curl-args'), 'utf8').split('\n').filter(Boolean) : null;
    return {
      status: res.status,
      stdout: res.stdout,
      dispatched: args !== null,
      url: args ? args.find((a) => a.startsWith('https://')) : null,
      payload: args ? JSON.parse(args[args.indexOf('-d') + 1]) : null,
    };
  });
}

test('Chain: con gli input della coppia storica il core dispatcha come la sorgente', () => {
  const pair = { CHAIN_DISPATCH: 'true', CALLER_WORKFLOW: PAIR.caller, PRIMARY_SECTION: PAIR.primary, SIBLING_SECTION: PAIR.sibling };
  for (const sections of [
    { SECTION_PRODUCED: 'svizzera', SECTION_REQUESTED: 'frontaliere' },
    { SECTION_PRODUCED: 'frontaliere', SECTION_REQUESTED: 'svizzera' },
    { SECTION_PRODUCED: '', SECTION_REQUESTED: 'svizzera' },
    { SECTION_PRODUCED: '', SECTION_REQUESTED: '' },
    { SECTION_PRODUCED: '', SECTION_REQUESTED: 'frontaliere', DECLARED: 'false' }, // soccorso
  ]) {
    const source = runChain(SOURCE, sections);
    const core = runChain(CORE, { ...pair, ...sections });
    assert.equal(source.dispatched, true, JSON.stringify(sections));
    assert.deepEqual({ url: core.url, payload: core.payload }, { url: source.url, payload: source.payload }, JSON.stringify(sections));
    assert.equal(core.url, 'https://api.github.com/repos/owner/repo/actions/workflows/generate-article.yml/dispatches');
  }
  // Gli stop della sorgente restano stop: articolo prodotto, roster bloccato, kill switch.
  for (const stop of [{ ARTICLE: 'true' }, { ROSTER_BLOCKED: 'true' }, { CHAIN_ARMED: 'false' }, { DRY: 'true' }]) {
    assert.equal(runChain(CORE, { ...pair, SECTION_REQUESTED: 'frontaliere', ...stop }).dispatched, false, JSON.stringify(stop));
    assert.equal(runChain(SOURCE, { SECTION_REQUESTED: 'frontaliere', ...stop }).dispatched, false, JSON.stringify(stop));
  }
});

test('Chain: un cantone non dispatcha nessun successore', () => {
  const canton = { CALLER_WORKFLOW: 'generate-article-ti.yml', PRIMARY_SECTION: 'canton-ti', SIBLING_SECTION: '', SECTION_REQUESTED: 'canton-ti' };
  for (const flag of ['false', '', 'TRUE']) {
    const res = runChain(CORE, { ...canton, CHAIN_DISPATCH: flag });
    assert.equal(res.dispatched, false, `chain_dispatch=${JSON.stringify(flag)}`);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /catena ferma: catena via dispatch spenta/);
  }
  // Se un giorno la si arma, torna al PROPRIO chiamante e resta sulla propria sezione.
  const armed = runChain(CORE, { ...canton, CHAIN_DISPATCH: 'true' });
  assert.equal(armed.url, 'https://api.github.com/repos/owner/repo/actions/workflows/generate-article-ti.yml/dispatches');
  assert.equal(armed.payload.inputs.section, 'canton-ti');
});

/**
 * Esegue lo step «Resolve run mode and section» dopo aver risolto le
 * espressioni `${{ }}` con `ctx` (un'espressione non prevista fa fallire il test).
 */
function runMode(workflow, { ctx, env = {}, subject = '', changed = '' }) {
  const script = extractRun(workflow, 'Resolve run mode and section').replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expr) => {
    assert.ok(Object.prototype.hasOwnProperty.call(ctx, expr), `espressione non prevista nello step: ${expr}`);
    return ctx[expr];
  });
  return withBin((dir) => ({
    git: `#!/usr/bin/env bash
case "$1" in
  log) cat "${dir}/subject" ;;
  diff) cat "${dir}/changed" ;;
esac
exit 0
`,
  }), (dir, bin) => {
    writeFileSync(path.join(dir, 'subject'), `${subject}\n`);
    writeFileSync(path.join(dir, 'changed'), changed ? `${changed}\n` : '');
    writeFileSync(path.join(dir, 'out'), '');
    writeFileSync(path.join(dir, 'step.sh'), script);
    const res = spawnSync('bash', [path.join(dir, 'step.sh')], {
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, GITHUB_OUTPUT: path.join(dir, 'out'), ...env },
    });
    assert.equal(res.status, 0, res.stderr);
    return readOutputs(path.join(dir, 'out'));
  });
}

const MODE_SCENARIOS = [
  { name: 'cron frontaliere', event: 'schedule', schedule: '7 * * * *' },
  { name: 'cron svizzera', event: 'schedule', schedule: '37 * * * *' },
  { name: 'cron svizzera storico', event: 'schedule', schedule: '22 * * * *' },
  { name: 'cron ignoto', event: 'schedule', schedule: '52 * * * *' },
  { name: 'anello dopo svizzera', event: 'push', changed: 'content/blog-body-ch/it/a.ts', subject: 'Generate blog article (svizzera)' },
  { name: 'anello dopo frontaliere', event: 'push', changed: 'content/blog-body/it/a.ts', subject: 'Generate blog article (frontaliere)' },
  { name: 'anello dopo un altro produttore', event: 'push', changed: 'content/blog-body/it/a.ts', subject: 'Weekly border-wait ranking digest refresh' },
  { name: 'anello dopo un cantone', event: 'push', changed: 'content/blog-body-canton-ti/it/a.ts', subject: 'Generate blog article (canton-ti)' },
  { name: 'self-test', event: 'push', changed: '.github/workflows/generate-article.yml', subject: 'ci: tocca il workflow' },
  { name: 'dispatch svizzera', event: 'workflow_dispatch', requested: 'svizzera', dry: 'false' },
  { name: 'dispatch frontaliere dry', event: 'workflow_dispatch', requested: 'frontaliere', dry: 'true' },
  { name: 'dispatch con sezione ignota', event: 'workflow_dispatch', requested: 'canton-ti', dry: 'false' },
  { name: 'anello via dispatch', event: 'workflow_dispatch', requested: 'svizzera', dry: 'false', chainLink: 'true' },
];

const modeCtx = (s) => ({
  'github.event_name': s.event,
  'needs.admit.outputs.chain_link': s.chainLink || 'false',
  'github.event.before': '1111111111111111111111111111111111111111',
  'github.sha': '2222222222222222222222222222222222222222',
  'inputs.dry_run': s.dry || 'false',
});

test('Resolve run mode and section: con gli input della coppia storica il core sceglie come la sorgente', () => {
  for (const s of MODE_SCENARIOS) {
    const source = runMode(SOURCE, {
      ctx: { ...modeCtx(s), 'github.event.schedule': s.schedule || '', 'inputs.section': s.requested || '' },
      subject: s.subject, changed: s.changed,
    });
    const core = runMode(CORE, {
      ctx: modeCtx(s),
      env: { PRIMARY_SECTION: PAIR.primary, SIBLING_SECTION: PAIR.sibling, SIBLING_CRONS: PAIR.crons, REQUESTED_SECTION: s.requested || '', SCHEDULE: s.schedule || '' },
      subject: s.subject, changed: s.changed,
    });
    assert.deepEqual(core, source, s.name);
    assert.ok(['frontaliere', 'svizzera'].includes(source.section), s.name);
  }
  // I cron della gemella dichiarati al core sono quelli che la sorgente cabla.
  assert.match(SOURCE, /'22 \* \* \* \*'\|'37 \* \* \* \*'\) SEC=svizzera ;;/);
});

test('Resolve run mode and section: un cantone resta sulla propria sezione, qualunque cosa lo svegli', () => {
  for (const s of MODE_SCENARIOS) {
    const out = runMode(CORE, {
      ctx: modeCtx(s),
      env: { PRIMARY_SECTION: 'canton-ti', SIBLING_SECTION: '', SIBLING_CRONS: '', REQUESTED_SECTION: s.requested || '', SCHEDULE: s.schedule || '' },
      subject: s.subject, changed: s.changed,
    });
    assert.equal(out.section, 'canton-ti', s.name);
  }
});

// ── 3. I chiamanti ───────────────────────────────────────────────────────────

/** Legge un chiamante generato (forma nota: e' il generatore a scriverla). */
function parseCaller(text) {
  const withBlock = text.slice(text.indexOf('\n    with:\n') + '\n    with:\n'.length);
  const withMap = Object.fromEntries(withBlock.split('\n').filter(Boolean).map((l) => {
    const m = /^ {6}([a-z_]+): (.*)$/.exec(l);
    assert.ok(m, `riga inattesa in with: ${l}`);
    return [m[1], m[2].replace(/^'(.*)'$/, '$1')];
  }));
  const pushBlock = text.slice(text.indexOf('\n  push:\n'), text.indexOf('\n  workflow_dispatch:\n'));
  return {
    name: (/^name: (.+)$/m.exec(text) || [])[1],
    crons: [...text.matchAll(/^ {4}- cron: '([^']+)'$/gm)].map((m) => m[1]),
    pushBranches: (/^ {4}branches: \[(.+)\]$/m.exec(pushBlock) || [])[1],
    pushPaths: [...pushBlock.matchAll(/^ {6}- '([^']+)'$/gm)].map((m) => m[1]),
    dispatchInputs: [...text.slice(text.indexOf('\n  workflow_dispatch:\n'), text.indexOf('\npermissions:\n')).matchAll(/^ {6}([a-z_]+):$/gm)].map((m) => m[1]),
    with: withMap,
  };
}

/** `path` soddisfa il filtro `pattern` (solo le due forme che il generatore emette). */
const pathMatches = (pattern, p) => (pattern.endsWith('/**') ? p.startsWith(pattern.slice(0, -2)) : p === pattern);

const CALLERS = CANTONS.map((c) => ({ canton: c, file: callerWorkflowFile(c.code), ...parseCaller(readWorkflow(callerWorkflowFile(c.code))) }));

test('cron: minuto e cadenza vengono dal profilo, e gli slot non si ammassano', () => {
  const reserved = parseReservedCronMinutes(SOURCE);
  const seen = new Set();
  for (const { canton, crons, file } of CALLERS) {
    assert.equal(crons.length, 1, file);
    const m = /^(\d+) (\*|[\d,]+) \* \* \*$/.exec(crons[0]);
    assert.ok(m, `${file}: cron inatteso ${crons[0]}`);
    assert.equal(Number(m[1]), canton.cronMinute, `${file}: minuto`);
    assert.ok(!reserved.has(canton.cronMinute), `${file}: minuto ${canton.cronMinute} riservato a generate-article.yml`);
    const hours = m[2] === '*' ? Array.from({ length: 24 }, (_, h) => h) : m[2].split(',').map(Number);
    assert.equal(hours.length, 24 / canton.cadenceHours, `${file}: ${hours.length} slot al giorno per una cadenza di ${canton.cadenceHours}h`);
    hours.forEach((h, i) => assert.equal(h, hours[0] + i * canton.cadenceHours, `${file}: ore non equidistanti`));
    assert.ok(hours[0] < canton.cadenceHours);
    assert.equal(crons[0], cronExpression(canton, OFFSETS.get(canton.section)));
    assert.ok(!seen.has(crons[0]), `${file}: cron duplicato ${crons[0]}`);
    seen.add(crons[0]);
  }
  // Per ogni ora del giorno, quanti cantoni hanno uno slot: senza sfasamento
  // sarebbero tutti e 24 all'ora 0, contro un tetto globale di 3.
  const perHour = Array.from({ length: 24 }, () => 0);
  for (const { crons } of CALLERS) {
    const hoursField = crons[0].split(' ')[1];
    for (const h of hoursField === '*' ? perHour.keys() : hoursField.split(',').map(Number)) perHour[h] += 1;
  }
  assert.ok(Math.max(...perHour) <= 8, `troppi cantoni nella stessa ora: ${perHour.join(',')}`);
  assert.equal(cronExpression({ cronMinute: 5, cadenceHours: 1 }, 0), '5 * * * *');
  assert.equal(cronExpression({ cronMinute: 5, cadenceHours: 24 }, 0), '5 0 * * *');
  assert.throws(() => cronExpression({ cronMinute: 5, cadenceHours: 5 }, 0), /non divide le 24 ore/);
  assert.throws(() => cronExpression({ cronMinute: 5, cadenceHours: 6 }, 6), /sfasamento/);
});

test('push.paths: solo i path del corpus della propria sezione', () => {
  for (const { canton, file, pushPaths, pushBranches } of CALLERS) {
    const { section } = canton;
    assert.equal(pushBranches, 'main', `${file}: un branch di backup non deve generare`);
    assert.ok(pushPaths.length >= 3, `${file}: nessun path di corpus`);
    assert.ok(
      pushPaths.every((p) => p.startsWith('content/')),
      `${file}: un wrapper non deve auto-avviarsi quando vengono rigenerati tutti i wrapper`,
    );
    const corpus = pushPaths;
    assert.ok(corpus.length >= 3, file);
    for (const p of corpus) {
      assert.ok(p.startsWith('content/'), `${file}: ${p} non e' corpus — un run che non produce scrive solo sotto data/, e non deve ripartire`);
      assert.ok(p.includes(section), `${file}: ${p} non e' della sezione ${section}`);
      assert.notEqual(p, 'content/**');
    }
    // Tutto cio' che create-article scrive nel corpus per questa sezione sveglia il chiamante…
    const paths = cantonSectionPaths(section);
    const written = [
      corpusPath(paths.registryFile), corpusPath(paths.slugDataFile), corpusPath(paths.seoFile),
      ...paths.metaFiles.map((f) => corpusPath(f)),
      `${corpusPath(`services/locales/${paths.bodyDir}`)}/it/un-articolo.ts`,
    ];
    for (const w of written) assert.ok(corpus.some((p) => pathMatches(p, w)), `${file}: ${w} non sveglia il chiamante`);
    // …e niente del suo STATO: e' cio' che un run senza articolo riscrive.
    for (const state of [paths.sourceUrlsFile, paths.evergreenRejectedFile, paths.quotaStateFile, `${paths.sidecarDir}/x.json`]) {
      assert.ok(!pushPaths.some((p) => pathMatches(p, state)), `${file}: lo stato ${state} farebbe ripartire un run secco`);
    }
  }
});

test('un solo self-test runtime copre core e caller senza fan-out', () => {
  const canonical = CANTONS[0];
  assert.equal(SELF_TEST, buildSelfTestWorkflow(canonical));
  assert.match(SELF_TEST, /^name: Generate Blog Article \(cantons self-test\)$/m);
  assert.match(SELF_TEST, new RegExp(`- '${WORKFLOWS_DIR}/${SOURCE_WORKFLOW.replace('.', '\\.')}'`));
  assert.match(SELF_TEST, new RegExp(`- '${WORKFLOWS_DIR}/${CORE_WORKFLOW.replace('.', '\\.')}'`));
  assert.match(SELF_TEST, new RegExp(`- '${WORKFLOWS_DIR}/generate-article-\\*\\.yml'`));
  assert.equal((SELF_TEST.match(/uses: \.\/\.github\/workflows\/generate-article-core\.yml/g) || []).length, 1);
  assert.match(SELF_TEST, /section_gate: canton/);
  assert.match(SELF_TEST, new RegExp(`caller_workflow: ${callerWorkflowFile(canonical.code)}`));
  assert.match(SELF_TEST, /dry_run: true/);
  for (const { file, pushPaths } of CALLERS) {
    assert.ok(!pushPaths.includes(`${WORKFLOWS_DIR}/${file}`), `${file}: self-test duplicato nel caller`);
  }
});

test('push.paths: l\'articolo di un cantone non sveglia nessun altro cantone', () => {
  for (const a of CALLERS) {
    const paths = cantonSectionPaths(a.canton.section);
    const touched = [
      corpusPath(paths.registryFile), corpusPath(paths.slugDataFile), corpusPath(paths.seoFile),
      ...paths.metaFiles.map((f) => corpusPath(f)),
      `${corpusPath(`services/locales/${paths.bodyDir}`)}/de/un-articolo.ts`,
      'public/images/blog/un-articolo.webp', 'data/blog-images-used.json',
      'content/blog-body/it/frontaliere.ts', 'content/blog-body-ch/it/svizzera.ts',
    ];
    for (const b of CALLERS) {
      if (a === b) continue;
      const woken = touched.filter((t) => b.pushPaths.some((p) => pathMatches(p, t)));
      assert.deepEqual(woken, [], `${b.file} si sveglia per un articolo di ${a.canton.section}`);
    }
  }
});

test('ogni chiamante passa al core la propria sezione, il proprio file e il proprio gruppo', () => {
  const groups = new Set();
  for (const { canton, file, name, dispatchInputs, with: w } of CALLERS) {
    const { section } = canton;
    assert.equal(name, `Generate Blog Article (${section})`);
    assert.deepEqual(Object.keys(w), ['section', 'caller_workflow', 'concurrency_group', 'body_path_regex', 'section_gate', 'chain_dispatch', 'url', 'dry_run']);
    assert.equal(w.section, section);
    assert.equal(w.caller_workflow, file, 'ammissione e dispatch guardano le run di QUESTO file');
    assert.equal(w.concurrency_group, `generate-article-${section}`);
    assert.equal(w.section_gate, 'canton', 'senza il gate un cantone genererebbe col flag spento');
    assert.equal(w.chain_dispatch, 'false', 'catena via dispatch spenta al lancio (D15)');
    assert.equal(w.url, '${{ inputs.url }}');
    assert.equal(w.dry_run, '${{ inputs.dry_run == true }}');
    assert.deepEqual(dispatchInputs, ['url', 'dry_run'], `${file}: un dispatch non sceglie un'altra sezione ne' si finge un anello`);
    assert.ok(!groups.has(w.concurrency_group));
    groups.add(w.concurrency_group);

    const re = new RegExp(w.body_path_regex);
    assert.equal(w.body_path_regex, sectionCorpusPaths(section).bodyPathRegex);
    assert.ok(re.test(`${corpusPath(`services/locales/${cantonSectionPaths(section).bodyDir}`)}/fr/un-articolo.ts`), `${file}: la regex non riconosce i propri corpi`);
    for (const other of ['content/blog-body/it/a.ts', 'content/blog-body-ch/it/a.ts', `content/blog-body-${section}x/it/a.ts`, `content/blog-body-${section}/it/a.json`]) {
      assert.ok(!re.test(other), `${file}: la regex prende ${other}`);
    }
  }
  assert.ok(!groups.has('generate-article'), 'il gruppo di frontaliere/svizzera non e\' di nessun cantone');
});

test('i chiamanti non hanno concurrency a livello di workflow e concedono al core i permessi che chiede', () => {
  for (const { file } of CALLERS) {
    const text = readWorkflow(file);
    assert.doesNotMatch(text, /^concurrency:/m, `${file}: un gruppo a livello di workflow sfratta le run prima che admit decida`);
    assert.match(text, /\n {4}uses: \.\/\.github\/workflows\/generate-article-core\.yml\n {4}secrets: inherit\n/, file);
    assert.match(text, /^permissions:\n {2}contents: read\n/m, file);
    // Un job del riusabile non puo' chiedere piu' di quanto il chiamante concede:
    // senza queste righe la run muore all'avvio, prima di qualunque step.
    const granted = new Set([...text.slice(text.indexOf('\n  generate:\n')).matchAll(/^ {6}([a-z-]+): read$/gm)].map((m) => m[1]));
    const requested = new Set([...CORE.matchAll(/^ {6}([a-z-]+): (read|write)(?: #.*)?$/gm)].map((m) => `${m[1]}:${m[2]}`));
    for (const r of requested) {
      const [scope, level] = r.split(':');
      assert.equal(level, 'read', `il core chiede ${r}: i chiamanti concedono solo letture`);
      assert.ok(granted.has(scope), `${file}: il core chiede ${scope}: read e il chiamante non lo concede`);
    }
    assert.ok(requested.size >= 2);
  }
});

test('il core dichiara ogni input che i chiamanti passano, e la catena e\' spenta di default', () => {
  const inputsBlock = CORE.slice(CORE.indexOf('    inputs:\n'), CORE.indexOf('\npermissions:\n'));
  const declared = [...inputsBlock.matchAll(/^ {6}([a-z_]+):$/gm)].map((m) => m[1]);
  for (const { file, with: w } of CALLERS) {
    for (const key of Object.keys(w)) assert.ok(declared.includes(key), `${file}: passa «${key}» ma il core non lo dichiara`);
  }
  for (const used of new Set([...CORE.matchAll(/inputs\.([a-z_]+)/g)].map((m) => m[1]))) {
    assert.ok(declared.includes(used), `il core legge inputs.${used} senza dichiararlo: resterebbe vuoto in silenzio`);
  }
  assert.match(inputsBlock, /chain_dispatch:\n(?: {8}.*\n)*? {8}default: false\n {8}type: boolean/);
  assert.match(inputsBlock, /section_gate:\n(?: {8}.*\n)*? {8}default: 'none'/);
  assert.match(CORE, /^on:\n {2}workflow_call:\n/m);
  assert.doesNotMatch(CORE, /^ {2}(schedule|push|workflow_dispatch):/m, 'il core non ha trigger suoi');
  // La mutua esclusione resta sul job che scrive, col gruppo del chiamante.
  assert.match(CORE, /\n {4}concurrency:\n {6}group: \$\{\{ inputs\.concurrency_group \}\}\n {6}cancel-in-progress: false\n/);
  assert.equal((CORE.match(/\n {4}concurrency:/g) || []).length, 1, 'ne\' admit ne\' il gate di sezione stanno in un gruppo');
});

test('buildAll rifiuta un profilo che non copre le sezioni cantonali del core', () => {
  const missing = { cantons: PROFILES.cantons.filter((c) => c.code !== 'TI') };
  assert.throws(() => buildAll({ source: SOURCE, profiles: missing }), /non elencano le stesse sezioni/);
  assert.throws(() => buildAll({ source: SOURCE, profiles: { cantons: [] } }), /nessun cantone/);
});
