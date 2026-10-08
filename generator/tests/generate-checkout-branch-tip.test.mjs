/**
 * I due generatori di articoli lavorano sulla TESTA del ramo, non sullo SHA
 * dell'evento che li ha innescati (issue #2428).
 *
 * Il job `generate` aspetta la generazione precedente nel suo gruppo di
 * concorrenza. Quando parte, lo SHA dell'evento e' piu' vecchio dell'articolo
 * che quella generazione ha appena pubblicato: con il checkout di default il
 * generatore leggeva un albero senza quell'articolo, e la deduplica di inizio
 * run non poteva vederlo. Misurato sulla run 37772192809 dell'8 ottobre 2026:
 * job partito nove secondi dopo il commit dell'articolo precedente, albero di
 * tre minuti prima, stessa fonte usata due volte nella stessa sezione.
 *
 * Due cose vanno tenute insieme, ed e' questo che il test osserva:
 *   1. il checkout del job `generate` chiede il ramo (`ref: github.ref`);
 *   2. il passo che decide modalita' e sezione continua a ragionare
 *      sull'EVENTO — quale push ha innescato la run, quale sezione aveva
 *      scritto — e lo legge per nome, perche' HEAD ora e' un altro commit.
 *
 * Il punto 2 non e' controllato cercando stringhe: lo script del passo viene
 * estratto dal workflow, le espressioni `${{ … }}` sostituite con i valori di
 * una run, ed eseguito in un repository dove la testa e' davanti all'evento.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const MAIN_WORKFLOW = '.github/workflows/generate-article.yml';
const CORE_WORKFLOW = '.github/workflows/generate-article-core.yml';
const RESOLVE_STEP = 'Resolve run mode and section';
const ZERO_SHA = '0'.repeat(40);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Il testo del job `generate`, dal suo nome al job successivo. */
function generateJob(rel) {
  const workflow = readFileSync(path.join(ROOT, rel), 'utf8');
  const start = workflow.search(/^ {2}generate:\n/m);
  assert.notEqual(start, -1, `${rel}: job \`generate\` non trovato`);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/^ {2}[A-Za-z_][\w-]*:\n/m);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

/** Un passo del job, dal suo `- name:` al passo successivo. */
function stepOf(job, name, rel) {
  const marker = `      - name: ${name}\n`;
  const start = job.indexOf(marker);
  assert.notEqual(start, -1, `${rel}: passo «${name}» non trovato nel job generate`);
  assert.equal(job.indexOf(marker, start + 1), -1, `${rel}: il passo «${name}» compare due volte`);
  const next = job.indexOf('\n      - name: ', start + marker.length);
  return next === -1 ? job.slice(start) : job.slice(start, next + 1);
}

/** Lo script del blocco `run: |` di un passo, senza il rientro del YAML. */
function runScriptOf(step, rel) {
  const marker = '        run: |\n';
  const start = step.indexOf(marker);
  assert.notEqual(start, -1, `${rel}: il passo non ha un blocco run`);
  const lines = [];
  for (const line of step.slice(start + marker.length).split('\n')) {
    if (line.trim() !== '' && !line.startsWith('          ')) break;
    lines.push(line.slice(10));
  }
  return lines.join('\n');
}

/** Sostituisce le espressioni di GitHub Actions; una non prevista fa fallire il test. */
function expand(script, values, rel) {
  return script.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expression) => {
    assert.ok(
      Object.prototype.hasOwnProperty.call(values, expression),
      `${rel}: il passo usa \`${expression}\`, che questo test non conosce — va deciso se dipende dall'evento o dall'albero`,
    );
    return values[expression];
  });
}

/**
 * base → evento → testa. Il working tree resta sulla testa, come dopo un
 * checkout per ramo fatto quando un altro commit e' gia' atterrato.
 */
function repositoryAheadOfEvent(root, { eventSubject, tipSubject, tipPath }) {
  const repo = path.join(root, 'repo');
  mkdirSync(path.join(repo, 'content'), { recursive: true });
  mkdirSync(path.join(repo, 'data'), { recursive: true });
  git(repo, 'init', '-q');
  writeFileSync(path.join(repo, 'README.md'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const baseSha = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(path.join(repo, 'content/event-article.ts'), 'evento\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', eventSubject);
  const eventSha = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(path.join(repo, tipPath), 'testa\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', tipSubject);
  const tipSha = git(repo, 'rev-parse', 'HEAD');
  return { repo, baseSha, eventSha, tipSha };
}

function resolve(rel, repo, values, env = {}) {
  const script = expand(runScriptOf(stepOf(generateJob(rel), RESOLVE_STEP, rel), rel), values, rel);
  const outputFile = path.join(path.dirname(repo), 'github-output');
  writeFileSync(outputFile, '');
  const stdout = execFileSync('bash', ['-c', script], {
    cwd: repo,
    env: { ...GIT_ENV, ...env, GITHUB_OUTPUT: outputFile },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const outputs = Object.fromEntries(
    readFileSync(outputFile, 'utf8').split('\n').filter(Boolean).map((line) => {
      const cut = line.indexOf('=');
      return [line.slice(0, cut), line.slice(cut + 1)];
    }),
  );
  return { stdout, outputs };
}

const pushValues = ({ before, sha }) => ({
  'github.event_name': 'push',
  'github.event.before': before,
  'github.event.schedule': '',
  'github.sha': sha,
  'inputs.dry_run': 'false',
  'inputs.section': '',
  'needs.admit.outputs.chain_link': 'false',
  'needs.admit.outputs.run_mode': 'production',
});

test('#2428 — il job generate dei due generatori fa il checkout del ramo', () => {
  for (const rel of [MAIN_WORKFLOW, CORE_WORKFLOW]) {
    const checkout = stepOf(generateJob(rel), 'Checkout', rel);
    assert.match(checkout, /^ {8}uses: actions\/checkout@/m, `${rel}: il passo Checkout non usa actions/checkout`);
    assert.match(
      checkout,
      /^ {10}ref: \$\{\{ github\.ref \}\}$/m,
      `${rel}: senza \`ref: github.ref\` il job parte dall'albero dello SHA dell'evento, gia' vecchio dopo l'attesa`,
    );
    // Servono tutti e due: l'evento e la sua base devono esistere in locale.
    assert.match(checkout, /^ {10}fetch-depth: 0$/m, `${rel}: senza la storia intera lo SHA dell'evento puo' mancare`);
  }
});

test('#2428 — la sezione segue il commit dell\'EVENTO, non quello che sta in testa', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'generate-branch-tip-section-'));
  try {
    // L'evento e' il push di un articolo cantonale; mentre la run aspettava e'
    // atterrato un articolo frontaliere. La regola resta quella di prima: un
    // push non riconosciuto fa partire una run frontaliere.
    const { repo, baseSha, eventSha, tipSha } = repositoryAheadOfEvent(root, {
      eventSubject: 'Generate blog article (canton-ti)',
      tipSubject: 'Generate blog article (frontaliere)',
      tipPath: 'content/tip-article.ts',
    });
    const { stdout, outputs } = resolve(MAIN_WORKFLOW, repo, pushValues({ before: baseSha, sha: eventSha }));

    assert.equal(outputs.chain, 'true');
    assert.equal(outputs.dry, 'false');
    assert.equal(outputs.section, 'frontaliere', 'la sezione e\' stata decisa dal commit in testa');
    assert.match(stdout, new RegExp(`CHECKOUT_TIP event=${eventSha.slice(0, 9)} head=${tipSha.slice(0, 9)} ahead=1\\n`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#2428 — l\'alternanza frontaliere/svizzera parte dal commit dell\'evento', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'generate-branch-tip-alternate-'));
  try {
    const { repo, baseSha, eventSha } = repositoryAheadOfEvent(root, {
      eventSubject: 'Generate blog article (frontaliere)',
      tipSubject: 'Generate blog article (svizzera)',
      tipPath: 'content/tip-article.ts',
    });
    const { outputs } = resolve(MAIN_WORKFLOW, repo, pushValues({ before: baseSha, sha: eventSha }));
    assert.equal(outputs.section, 'svizzera');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#2428 — senza `before` il push di catena si riconosce dal commit dell\'evento', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'generate-branch-tip-fallback-'));
  try {
    // In testa c'e' un commit di sola contabilita': letto al posto dell'evento
    // farebbe passare per prova a secco una run di produzione.
    for (const rel of [MAIN_WORKFLOW, CORE_WORKFLOW]) {
      const dir = path.join(root, rel === MAIN_WORKFLOW ? 'main' : 'core');
      mkdirSync(dir, { recursive: true });
      const { repo, eventSha } = repositoryAheadOfEvent(dir, {
        eventSubject: 'Generate blog article (canton-ti)',
        tipSubject: 'chore(licenses): persist blog cover CDN sync queue [skip ci]',
        tipPath: 'data/cover-sync-queue.json',
      });
      const { outputs } = resolve(
        rel,
        repo,
        pushValues({ before: ZERO_SHA, sha: eventSha }),
        { PRIMARY_SECTION: 'canton-ti', SIBLING_SECTION: '', SIBLING_CRONS: '', REQUESTED_SECTION: '', SCHEDULE: '' },
      );
      assert.equal(outputs.chain, 'true', `${rel}: il push dell'articolo non e' stato riconosciuto come anello della catena`);
      assert.equal(outputs.dry, 'false', `${rel}: una run di produzione e' stata presa per prova a secco`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#2428 — nel core la sezione sorella alterna sul commit dell\'evento', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'generate-branch-tip-core-'));
  try {
    const { repo, baseSha, eventSha, tipSha } = repositoryAheadOfEvent(root, {
      eventSubject: 'Generate blog article (sezione-a)',
      tipSubject: 'Generate blog article (sezione-b)',
      tipPath: 'content/tip-article.ts',
    });
    const { stdout, outputs } = resolve(
      CORE_WORKFLOW,
      repo,
      pushValues({ before: baseSha, sha: eventSha }),
      { PRIMARY_SECTION: 'sezione-a', SIBLING_SECTION: 'sezione-b', SIBLING_CRONS: '', REQUESTED_SECTION: '', SCHEDULE: '' },
    );
    // L'evento ha scritto la sezione A: tocca alla sorella. In testa c'e' un
    // articolo della sorella, che letto al suo posto ridarebbe la A.
    assert.equal(outputs.section, 'sezione-b');
    assert.match(stdout, new RegExp(`CHECKOUT_TIP event=${eventSha.slice(0, 9)} head=${tipSha.slice(0, 9)} ahead=1\\n`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#2428 — quando niente e\' atterrato nel frattempo l\'albero coincide con l\'evento', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'generate-branch-tip-same-'));
  try {
    const { repo, eventSha, tipSha } = repositoryAheadOfEvent(root, {
      eventSubject: 'Generate blog article (canton-ti)',
      tipSubject: 'Generate blog article (svizzera)',
      tipPath: 'content/tip-article.ts',
    });
    // L'evento E' la testa: la riga di osservazione deve dire zero.
    const { stdout, outputs } = resolve(MAIN_WORKFLOW, repo, pushValues({ before: eventSha, sha: tipSha }));
    assert.equal(outputs.section, 'frontaliere');
    assert.match(stdout, new RegExp(`CHECKOUT_TIP event=${tipSha.slice(0, 9)} head=${tipSha.slice(0, 9)} ahead=0\\n`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
