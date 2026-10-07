import { describe, test } from 'node:test';
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

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function seedRemote(html) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-article-monotonic-'));
  const seed = path.join(root, 'seed');
  const remote = path.join(root, 'remote.git');
  fs.mkdirSync(path.join(seed, path.dirname(REL)), { recursive: true });
  fs.writeFileSync(path.join(seed, REL), html);
  fs.writeFileSync(path.join(seed, '.shard-filecount'), '1\n');
  git(['init', '-q', '-b', 'main', seed]);
  git(['-C', seed, 'config', 'user.name', 'monotonic test']);
  git(['-C', seed, 'config', 'user.email', 'monotonic-test@example.invalid']);
  git(['-C', seed, 'add', REL, '.shard-filecount']);
  git(['-C', seed, 'commit', '-qm', 'seed']);
  git(['init', '--bare', '-q', '-b', 'main', remote]);
  git(['-C', seed, 'remote', 'add', 'origin', remote]);
  git(['-C', seed, 'push', '-q', 'origin', 'main']);
  return { root, remote, head: git(['-C', remote, 'rev-parse', 'main']) };
}

function page(revision, body) {
  return `<html><head>${revision ? `<meta name="ft:content-rev" content="${revision}">` : ''}</head><body>${body}</body></html>\n`;
}

function runPush(remote, incomingHtml) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-article-monotonic-dist-'));
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-article-monotonic-runner-'));
  const summary = path.join(runnerTemp, 'push-summary.tsv');
  fs.mkdirSync(path.join(dist, path.dirname(REL)), { recursive: true });
  fs.writeFileSync(path.join(dist, REL), incomingHtml);
  const result = spawnSync('bash', [SCRIPT, SECTION, LOCALE, dist, REL], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      SHARD_ARTICOLIFRONTALIERE_IT_DEPLOY_KEY: 'test-deploy-key',
      SHARD_REPO_OVERRIDE: remote,
      ARTICLE_PUSH_SUMMARY_FILE: summary,
      RUNNER_TEMP: runnerTemp,
      SHARD_INCREMENTAL_PUSH_MAX_ATTEMPTS: '1',
      SHARD_INCREMENTAL_PUSH_RETRY_DELAY: '0',
      GITHUB_PAT: '',
      SHARD_PUSH_PAT: '',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  assert.equal(result.status, 0, output);
  assert.match(fs.readFileSync(summary, 'utf8'), /^articolifrontaliere-it\t/);
  const head = git(['-C', remote, 'rev-parse', 'main']);
  fs.rmSync(dist, { recursive: true, force: true });
  fs.rmSync(runnerTemp, { recursive: true, force: true });
  return { output, head };
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

describe('push monotono degli shard corpus', () => {
  test('remoto più recente: mantiene la pagina remota', () => {
    const scenario = seedRemote(page('2000.fffffff', 'remote-newer'));
    try {
      const result = runPush(scenario.remote, page('1000.aaaaaaa', 'incoming-older'));
      assert.equal(result.head, scenario.head);
      assert.equal(remoteHtml(scenario.remote), page('2000.fffffff', 'remote-newer'));
      assert.match(result.output, /monotonic guard: kept remote for 1 newer article path/);
    } finally {
      fs.rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  test('remoto più vecchio: sostituisce con la pagina in arrivo', () => {
    const scenario = seedRemote(page('1000.aaaaaaa', 'remote-older'));
    try {
      const result = runPush(scenario.remote, page('2000.bbbbbbb', 'incoming-newer'));
      assert.notEqual(result.head, scenario.head);
      assert.equal(remoteHtml(scenario.remote), page('2000.bbbbbbb', 'incoming-newer'));
    } finally {
      fs.rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  test('timbri uguali con shell diversa: sostituisce', () => {
    const scenario = seedRemote(page('2000.abcdef1', 'remote-shell'));
    try {
      const result = runPush(scenario.remote, page('2000.abcdef1', 'incoming-shell'));
      assert.notEqual(result.head, scenario.head);
      assert.equal(remoteHtml(scenario.remote), page('2000.abcdef1', 'incoming-shell'));
    } finally {
      fs.rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  test('remoto senza timbro: sostituisce', () => {
    const scenario = seedRemote(page(null, 'remote-legacy'));
    try {
      const result = runPush(scenario.remote, page('2000.abcdef1', 'incoming-stamped'));
      assert.notEqual(result.head, scenario.head);
      assert.equal(remoteHtml(scenario.remote), page('2000.abcdef1', 'incoming-stamped'));
    } finally {
      fs.rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  test('solo timbro diverso: non ripubblica', () => {
    const shell = '<html><head><title>same shell</title></head><body>same</body></html>\n';
    const scenario = seedRemote(page('2000.abcdef1', shell));
    try {
      const result = runPush(scenario.remote, page('2001.1234567', shell));
      assert.equal(result.head, scenario.head);
      assert.equal(remoteHtml(scenario.remote), page('2000.abcdef1', shell));
      assert.match(result.output, /stamp-only path change/);
    } finally {
      fs.rmSync(scenario.root, { recursive: true, force: true });
    }
  });
});
