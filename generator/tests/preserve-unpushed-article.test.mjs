/**
 * Regression tests for preserving a generated article when its commit cannot
 * be pushed by the generator workflow.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SCRIPT = path.join(ROOT, 'scripts/ci/preserve-unpushed-commit.sh');
const WORKFLOWS = [
  '.github/workflows/generate-article.yml',
  '.github/workflows/generate-article-core.yml',
];

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  NODE_TEST_CONTEXT: '',
};

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    env: GIT_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runPreserver(cwd, ...args) {
  try {
    const stdout = execFileSync('bash', [SCRIPT, ...args], {
      cwd,
      env: GIT_ENV,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output: stdout };
  } catch (error) {
    return {
      code: error.status ?? 1,
      output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
    };
  }
}

function initRepo(root) {
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'user.email', 'test@example.invalid');
}

function commitAll(repo, message) {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD').trim();
}

function readWorkflow(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

test('crea un bundle replayable con manifest, REPLAY e ref temporaneo rimosso', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'preserve-unpushed-article-'));
  try {
    const repo = path.join(root, 'repo');
    const baseClone = path.join(root, 'base-clone');
    mkdirSync(repo, { recursive: true });
    initRepo(repo);
    writeFileSync(path.join(repo, 'base.txt'), 'base\n');
    const baseSha = commitAll(repo, 'base');

    // Questo clone viene creato prima del commit prodotto: contiene solo la base.
    git(root, 'clone', '-q', repo, baseClone);

    writeFileSync(path.join(repo, 'article-one.txt'), 'uno\n');
    writeFileSync(path.join(repo, 'article-two.txt'), 'due\n');
    const producedSha = commitAll(repo, 'Generate blog article (frontaliere)');
    const output = path.join(root, 'artifact');
    const result = runPreserver(repo, producedSha, output, 'push failed after 5 attempts');

    assert.equal(result.code, 0, result.output);
    assert.match(result.output, new RegExp(`sha=${producedSha}`));
    assert.match(result.output, /files=2/);
    assert.match(result.output, /size=[0-9]+ bytes/);

    const bundle = path.join(output, 'article.bundle');
    const manifestPath = path.join(output, 'manifest.json');
    const replayPath = path.join(output, 'REPLAY.md');
    assert.ok(existsSync(bundle));
    assert.ok(existsSync(manifestPath));
    assert.ok(existsSync(replayPath));

    assert.equal(git(baseClone, 'rev-parse', 'HEAD').trim(), baseSha);
    git(baseClone, 'bundle', 'verify', bundle);
    assert.throws(() => git(baseClone, 'cat-file', '-e', `${producedSha}^{commit}`));

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.producedSha, producedSha);
    assert.equal(manifest.baseSha, baseSha);
    assert.equal(manifest.subject, 'Generate blog article (frontaliere)');
    assert.deepEqual(manifest.files.sort(), ['article-one.txt', 'article-two.txt']);
    assert.equal(manifest.reason, 'push failed after 5 attempts');
    assert.equal(manifest.ref, 'refs/unpushed/article');

    const heads = git(baseClone, 'bundle', 'list-heads', bundle);
    assert.match(heads, new RegExp(`${producedSha}\\s+${manifest.ref.replaceAll('/', '\\/')}`));
    git(baseClone, 'fetch', bundle, manifest.ref);
    assert.equal(git(baseClone, 'rev-parse', 'FETCH_HEAD').trim(), producedSha);

    // Il replay vero: in un clone che ha solo la base, il cherry-pick riporta
    // i file dell'articolo e niente altro.
    git(baseClone, 'cherry-pick', 'FETCH_HEAD');
    assert.equal(readFileSync(path.join(baseClone, 'article-one.txt'), 'utf8'), 'uno\n');
    assert.equal(readFileSync(path.join(baseClone, 'article-two.txt'), 'utf8'), 'due\n');
    assert.equal(
      git(baseClone, 'diff', '--name-only', baseSha, 'HEAD').trim().split('\n').sort().join(','),
      'article-one.txt,article-two.txt',
    );

    const replay = readFileSync(replayPath, 'utf8');
    assert.match(replay, /git fetch <bundle> <ref>/);
    assert.match(replay, /git cherry-pick FETCH_HEAD/);
    // Stessa invocazione dello step «Commit and push»: lo SHA prodotto dal run,
    // non l'HEAD rigiocato.
    assert.ok(
      replay.includes(`node scripts/ci/check-post-rebase-uniqueness.mjs --produced ${producedSha} --against HEAD`),
      replay,
    );
    assert.match(replay, /--merge-registry/);
    assert.match(replay, /uscita 1 significa un duplicato vero/);
    assert.match(replay, /NON si pusha/);

    assert.equal(
      git(repo, 'for-each-ref', '--format=%(refname)', 'refs/unpushed').trim(),
      '',
      'il ref temporaneo deve essere rimosso dal repository sorgente',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('uno SHA inesistente o un commit senza genitore produce solo un warning', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'preserve-unpushed-invalid-'));
  try {
    initRepo(root);
    writeFileSync(path.join(root, 'base.txt'), 'base\n');
    const rootSha = commitAll(root, 'root');

    for (const [sha, name] of [[rootSha, 'root-output'], ['does-not-exist', 'missing-output']]) {
      const output = path.join(root, name);
      const result = runPreserver(root, sha, output, 'invalid input');
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /::warning::/);
      assert.match(result.output, /nessun file scritto/);
      assert.equal(existsSync(path.join(output, 'article.bundle')), false);
      assert.equal(existsSync(output), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('i due workflow registrano lo SHA e conservano solo dopo il fallimento del push', () => {
  for (const workflowPath of WORKFLOWS) {
    const workflow = readWorkflow(workflowPath);
    const commitStart = workflow.indexOf('      - name: Commit and push');
    assert.notEqual(commitStart, -1, `${workflowPath}: step Commit and push assente`);
    const nextExistingStart = workflow.indexOf('      - name: Cleanup Codex auth broker', commitStart);
    assert.notEqual(nextExistingStart, -1, `${workflowPath}: step successivo assente`);

    const produced = '          PRODUCED="$(git rev-parse HEAD)"';
    const producedStart = workflow.indexOf(produced, commitStart);
    assert.ok(producedStart > commitStart, `${workflowPath}: PRODUCED assente`);
    assert.match(
      workflow.slice(producedStart, producedStart + 180),
      /PRODUCED="\$\(git rev-parse HEAD\)"\n\s+printf '%s\\n' "\$PRODUCED" > "\$RUNNER_TEMP\/produced-article-commit"/,
      `${workflowPath}: lo SHA non è scritto subito dopo PRODUCED`,
    );

    const preserveStart = workflow.indexOf('      - name: Preserve the unpushed article', commitStart);
    const commentStart = workflow.indexOf("\n\n      # ── CONSERVARE L'ARTICOLO SE IL PUSH FALLISCE", commitStart);
    const commitEnd = commentStart === -1 ? preserveStart : commentStart;
    const commitBlock = workflow.slice(commitStart, commitEnd);
    assert.match(commitBlock, /check-post-rebase-uniqueness\.mjs/);
    assert.match(commitBlock, /not pushing/);
    assert.match(commitBlock, /push failed after 5 attempts/);

    const uploadStart = workflow.indexOf('      - name: Upload the unpushed article', commitStart);
    assert.ok(commitStart < preserveStart, `${workflowPath}: step di conservazione fuori posizione`);
    assert.ok(preserveStart < uploadStart, `${workflowPath}: upload prima della conservazione`);
    assert.ok(uploadStart < nextExistingStart, `${workflowPath}: nuovi step dopo quello successivo`);

    const preserveEnd = workflow.indexOf('\n      - name:', preserveStart + 1);
    const recoverySection = workflow.slice(commitEnd, preserveEnd);
    const preserveBlock = workflow.slice(preserveStart, preserveEnd);
    assert.match(
      preserveBlock,
      /if: \$\{\{ failure\(\) && steps\.generate\.outputs\.article == 'true' && steps\.mode\.outputs\.dry != 'true' \}\}/,
    );
    assert.match(preserveBlock, /produced-article-commit/);
    assert.match(preserveBlock, /preserve-unpushed-commit\.sh/);
    assert.match(preserveBlock, /GITHUB_STEP_SUMMARY/);
    assert.match(preserveBlock, /preserved=true/);
    if (workflowPath.endsWith('generate-article.yml')) {
      assert.match(recoverySection, /2489/);
      assert.match(recoverySection, /2421/);
      assert.match(recoverySection, /non ne cambia[\s\S]*l'esito/);
    }

    const uploadEnd = workflow.indexOf('\n      - name:', uploadStart + 1);
    const uploadBlock = workflow.slice(uploadStart, uploadEnd);
    const uploadVersion = (workflow.match(/uses: actions\/upload-artifact@([^\s]+)/) || [])[1];
    assert.ok(uploadVersion, `${workflowPath}: versione upload-artifact non trovata`);
    assert.match(uploadBlock, new RegExp(`uses: actions/upload-artifact@${uploadVersion}`));
    assert.match(uploadBlock, /if: \$\{\{ always\(\) && steps\.preserve_unpushed_article\.outputs\.preserved == 'true' \}\}/);
    assert.match(uploadBlock, /name: unpushed-article-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
    assert.match(uploadBlock, /retention-days: 14/);
    assert.match(uploadBlock, /if-no-files-found: ignore/);
  }
});
