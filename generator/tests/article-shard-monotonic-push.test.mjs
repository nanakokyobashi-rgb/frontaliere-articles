import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const SCRIPT = path.join(ROOT, 'scripts/lib/push-article-shard-incremental.sh');
const SECTION = 'articolifrontaliere';
const LOCALE = 'it';
const REL = 'articoli-frontaliere/monotonic-test/index.html';

function git(args, cwd, extraEnv = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  }).trim();
}

function dateFor(epoch) {
  return new Date(Number(epoch) * 1000).toISOString();
}

function commitSeed(seed, message, epoch) {
  git(['-C', seed, 'add', REL, '.shard-filecount']);
  git(['-C', seed, 'commit', '-qm', message], undefined, {
    GIT_AUTHOR_DATE: dateFor(epoch),
    GIT_COMMITTER_DATE: dateFor(epoch),
  });
}

function seedRemote({
  body,
  remoteRevision = null,
  remoteEpoch = 1_000_000_000,
  seedEpoch = remoteEpoch - 10,
  seedRevision = null,
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-article-monotonic-'));
  const seed = path.join(root, 'seed');
  const remote = path.join(root, 'remote.git');
  fs.mkdirSync(path.join(seed, path.dirname(REL)), { recursive: true });
  fs.writeFileSync(path.join(seed, REL), body);
  fs.writeFileSync(path.join(seed, '.shard-filecount'), '1\n');
  git(['init', '-q', '-b', 'main', seed]);
  git(['-C', seed, 'config', 'user.name', 'monotonic test']);
  git(['-C', seed, 'config', 'user.email', 'monotonic-test@example.invalid']);
  commitSeed(seed, seedRevision ? `seed\n\nContent-Rev: ${seedRevision}` : 'seed', seedEpoch);
  git(['init', '--bare', '-q', '-b', 'main', remote]);
  // Lo script clona con --depth 1 --filter=blob:none. Git ignora --depth su un
  // path locale, quindi il remote si raggiunge come file:// (vedi runPush): una
  // guardia verificata solo su un clone completo non dice niente della
  // produzione.
  git(['-C', remote, 'config', 'uploadpack.allowfilter', 'true']);
  git(['-C', seed, 'remote', 'add', 'origin', remote]);
  git(['-C', seed, 'push', '-q', 'origin', 'main']);

  if (remoteRevision) {
    fs.writeFileSync(path.join(seed, REL), body.replace('remote', 'remote-newer'));
    commitSeed(seed, `remote publication\n\nContent-Rev: ${remoteRevision}`, remoteEpoch);
    git(['-C', seed, 'push', '-q', 'origin', 'main']);
  }
  return { root, remote, head: git(['-C', remote, 'rev-parse', 'main']) };
}

function runPush(remote, incomingHtml, { revision = null, failFetch = false, trace = false } = {}) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-article-monotonic-dist-'));
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-article-monotonic-runner-'));
  const summary = path.join(runnerTemp, 'push-summary.tsv');
  const traceFile = path.join(runnerTemp, 'git-trace.log');
  const wrapperDir = path.join(runnerTemp, 'bin');
  fs.mkdirSync(path.join(dist, path.dirname(REL)), { recursive: true });
  fs.writeFileSync(path.join(dist, REL), incomingHtml);
  if (failFetch) {
    fs.mkdirSync(wrapperDir);
    const realGit = execFileSync('command', ['-v', 'git'], { encoding: 'utf8', shell: true }).trim();
    fs.writeFileSync(path.join(wrapperDir, 'git'), `#!/bin/sh\nfor arg in "$@"; do [ "$arg" = fetch ] && exit 73; done\nexec "${realGit}" "$@"\n`);
    fs.chmodSync(path.join(wrapperDir, 'git'), 0o755);
  }
  const env = {
    ...process.env,
    SHARD_ARTICOLIFRONTALIERE_IT_DEPLOY_KEY: 'test-deploy-key',
    SHARD_REPO_OVERRIDE: `file://${remote}`,
    ARTICLE_PUSH_SUMMARY_FILE: summary,
    RUNNER_TEMP: runnerTemp,
    GITHUB_PAT: '',
    SHARD_PUSH_PAT: '',
    GIT_TERMINAL_PROMPT: '0',
    ...(revision ? { ARTICLE_CONTENT_REVISION: revision } : { ARTICLE_CONTENT_REVISION: '' }),
    ...(trace ? { GIT_TRACE: traceFile } : {}),
    ...(failFetch ? { PATH: `${wrapperDir}:${process.env.PATH}` } : {}),
  };
  const result = spawnSync('bash', [SCRIPT, SECTION, LOCALE, dist, REL], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  assert.equal(result.status, 0, output);
  const summaryText = fs.readFileSync(summary, 'utf8');
  assert.match(summaryText, /^articolifrontaliere-it\t/);
  const traceText = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8') : '';
  const head = git(['-C', remote, 'rev-parse', 'main']);
  fs.rmSync(dist, { recursive: true, force: true });
  fs.rmSync(runnerTemp, { recursive: true, force: true });
  return { output, summaryText, traceText, head };
}

function remoteHtml(remote) {
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-article-monotonic-read-'));
  try {
    git(['clone', '-q', remote, clone]);
    return fs.readFileSync(path.join(clone, REL), 'utf8');
  } finally {
    fs.rmSync(clone, { recursive: true, force: true });
  }
}

const page = (body) => `<html><head><title>article</title></head><body>${body}</body></html>\n`;

test('Content-Rev remoto più recente mantiene la pagina senza leggere il blob remoto', () => {
  const scenario = seedRemote({ body: page('remote'), remoteRevision: '2000000100.fffffff', remoteEpoch: 2_000_000_100 });
  try {
    const result = runPush(scenario.remote, page('incoming-older'), { revision: '2000000000.aaaaaaa', trace: true });
    assert.equal(result.head, scenario.head);
    assert.equal(remoteHtml(scenario.remote), page('remote-newer'));
    assert.match(result.output, /kept remote for 1 newer article path/);
    assert.doesNotMatch(result.traceText, new RegExp(`show HEAD:${REL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  } finally {
    fs.rmSync(scenario.root, { recursive: true, force: true });
  }
});

// La forma tipica in produzione: uno shard poco mosso, il cui commit precedente
// è vecchio di ore. La pubblicazione più recente è allora il commit più vecchio
// che la finestra porta con sé, e arriva senza il genitore. La prima versione
// della guardia non poteva confrontarlo, lo saltava in silenzio e sovrascriveva
// la pagina (sondato su un remote file://; la suite usava un path locale, dove
// il clone non è mai superficiale).
test('pubblicazione più recente tenuta anche se il commit precedente è fuori dalla finestra', () => {
  const remoteEpoch = 2_000_000_100;
  const scenario = seedRemote({
    body: page('remote'),
    remoteRevision: `${remoteEpoch}.fffffff`,
    remoteEpoch,
    seedEpoch: remoteEpoch - 5 * 3600,
  });
  try {
    const result = runPush(scenario.remote, page('incoming-older'), { revision: `${remoteEpoch - 600}.aaaaaaa`, trace: true });
    assert.equal(result.head, scenario.head);
    assert.equal(remoteHtml(scenario.remote), page('remote-newer'));
    assert.match(result.output, /kept remote for 1 newer article path/);
    // Prova che il ramo superficiale è stato percorso: su un clone completo
    // non c'è niente da approfondire.
    assert.match(result.traceText, /fetch .*--deepen=1/);
    assert.match(result.summaryText, /\t1\t[^\t]+\t0\n$/);
  } finally {
    fs.rmSync(scenario.root, { recursive: true, force: true });
  }
});

test('pubblicazione più recente tenuta quando è il commit radice dello shard', () => {
  const remoteEpoch = 2_000_000_100;
  const scenario = seedRemote({ body: page('remote'), remoteEpoch, seedEpoch: remoteEpoch, seedRevision: `${remoteEpoch}.fffffff` });
  try {
    const result = runPush(scenario.remote, page('incoming-older'), { revision: `${remoteEpoch - 600}.aaaaaaa` });
    assert.equal(result.head, scenario.head);
    assert.equal(remoteHtml(scenario.remote), page('remote'));
    assert.match(result.output, /kept remote for 1 newer article path/);
  } finally {
    fs.rmSync(scenario.root, { recursive: true, force: true });
  }
});

test('HEAD più vecchio non fa fetch della storia e sostituisce', () => {
  const scenario = seedRemote({ body: page('remote') });
  try {
    const result = runPush(scenario.remote, page('incoming'), { revision: '2000000200.aaaaaaa', trace: true });
    assert.notEqual(result.head, scenario.head);
    assert.equal(remoteHtml(scenario.remote), page('incoming'));
    assert.doesNotMatch(result.traceText, /fetch .*shallow-since/);
  } finally {
    fs.rmSync(scenario.root, { recursive: true, force: true });
  }
});

test('stessa epoca con shell diversa sostituisce e non confronta HTML', () => {
  const scenario = seedRemote({ body: page('remote'), remoteRevision: '2000000200.abcdef1', remoteEpoch: 2_000_000_200 });
  try {
    const result = runPush(scenario.remote, page('incoming'), { revision: '2000000200.1234567' });
    assert.notEqual(result.head, scenario.head);
    assert.equal(remoteHtml(scenario.remote), page('incoming'));
  } finally {
    fs.rmSync(scenario.root, { recursive: true, force: true });
  }
});

test('commit remoto senza trailer è sostituibile', () => {
  const scenario = seedRemote({ body: page('remote'), remoteEpoch: 2_000_000_100 });
  try {
    const result = runPush(scenario.remote, page('incoming'), { revision: '2000000000.abcdef1' });
    assert.notEqual(result.head, scenario.head);
    assert.equal(remoteHtml(scenario.remote), page('incoming'));
  } finally {
    fs.rmSync(scenario.root, { recursive: true, force: true });
  }
});

test('storia illeggibile: warning e push corrente', () => {
  const scenario = seedRemote({ body: page('remote'), remoteEpoch: 2_000_000_100 });
  try {
    const result = runPush(scenario.remote, page('incoming'), { revision: '2000000000.abcdef1', failFetch: true });
    assert.notEqual(result.head, scenario.head);
    assert.equal(remoteHtml(scenario.remote), page('incoming'));
    assert.match(result.output, /history fetch failed|history unavailable/);
    assert.match(result.summaryText, /\t1\n$/);
  } finally {
    fs.rmSync(scenario.root, { recursive: true, force: true });
  }
});

test('senza ARTICLE_CONTENT_REVISION conserva il comportamento origin/main', () => {
  const body = page('same');
  const scenario = seedRemote({ body });
  try {
    const result = runPush(scenario.remote, body);
    assert.equal(result.head, scenario.head);
    assert.match(result.output, /clean no-op/);
    assert.doesNotMatch(result.output, /monotonic guard/);
  } finally {
    fs.rmSync(scenario.root, { recursive: true, force: true });
  }
});
