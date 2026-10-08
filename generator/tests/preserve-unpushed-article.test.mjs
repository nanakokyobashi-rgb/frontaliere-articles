/**
 * Regression tests for preserving generated corpus output when its commit
 * cannot be pushed by a producer workflow.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
const WORKFLOW_DIR = path.join(ROOT, '.github/workflows');

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
  return runPreserverWithEnv(cwd, GIT_ENV, ...args);
}

function runPreserverWithEnv(cwd, env, ...args) {
  try {
    const stdout = execFileSync('bash', [SCRIPT, ...args], {
      cwd,
      env,
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

function status(repo) {
  return git(repo, 'status', '--porcelain=v1', '--untracked-files=all');
}

function readWorkflow(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

function stepBlocks(workflow) {
  const starts = [...workflow.matchAll(/^      - name: ([^\n]+)\n/gm)].map((match) => ({
    name: match[1],
    start: match.index,
  }));
  return starts.map(({ name, start }, index) => ({
    name,
    start,
    text: workflow.slice(start, starts[index + 1]?.start ?? workflow.length),
  }));
}

function articleProducerCandidates() {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith('.yml'))
    .sort()
    .map((name) => ({ name, workflow: readWorkflow(`.github/workflows/${name}`) }))
    .flatMap(({ name, workflow }) => stepBlocks(workflow).map((step) => ({ name, workflow, step })))
    .filter(({ step }) => {
      const joined = step.text.replace(/\\\n\s*/g, ' ');
      return /^Commit and push/.test(step.name)
        && /git commit\b/.test(step.text)
        && /git push\b/.test(step.text)
        && /exit 1/.test(step.text)
        && (/git add -A\b/.test(step.text) || /git add\b[^\n]*content\/blog/.test(joined));
    });
}

test('crea un bundle replayable con manifest, REPLAY e replay da shallow clone', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'preserve-unpushed-article-'));
  try {
    const repo = path.join(root, 'repo');
    const shallowClone = path.join(root, 'shallow-clone');
    mkdirSync(repo, { recursive: true });
    initRepo(repo);
    writeFileSync(path.join(repo, 'base.txt'), 'base\n');
    const baseSha = commitAll(repo, 'base');

    writeFileSync(path.join(repo, 'article-one.txt'), 'uno\n');
    writeFileSync(path.join(repo, 'article-two.txt'), 'due\n');
    const producedSha = commitAll(repo, 'Generate blog article (frontaliere)');
    const output = path.join(root, 'artifact');
    const result = runPreserver(repo, producedSha, output, 'passo Commit and push fallito dopo il commit');

    assert.equal(result.code, 0, result.output);
    assert.match(result.output, new RegExp(`sha=${producedSha}`));
    assert.match(result.output, /source=commit/);
    assert.match(result.output, /files=2/);
    assert.match(result.output, /size=[0-9]+ bytes/);

    const bundle = path.join(output, 'article.bundle');
    const manifestPath = path.join(output, 'manifest.json');
    const replayPath = path.join(output, 'REPLAY.md');
    assert.ok(existsSync(bundle));
    assert.ok(existsSync(manifestPath));
    assert.ok(existsSync(replayPath));

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.source, 'commit');
    assert.equal(manifest.producedSha, producedSha);
    assert.equal(manifest.baseSha, baseSha);
    assert.equal(manifest.subject, 'Generate blog article (frontaliere)');
    assert.deepEqual(manifest.files.sort(), ['article-one.txt', 'article-two.txt']);
    assert.equal(manifest.reason, 'passo Commit and push fallito dopo il commit');
    assert.match(manifest.ref, /^refs\/unpushed\/article-[0-9a-f-]+$/);

    // Il clone e' shallow sul commit prodotto: baseSha non e' ancora presente.
    git(root, 'clone', '-q', '--depth', '1', `file://${repo}`, shallowClone);
    assert.throws(() => git(shallowClone, 'cat-file', '-e', `${baseSha}^{commit}`));
    git(shallowClone, 'fetch', 'origin', baseSha);
    git(shallowClone, 'reset', '--hard', baseSha);
    git(shallowClone, 'bundle', 'verify', bundle);
    git(shallowClone, 'fetch', bundle, manifest.ref);
    assert.equal(git(shallowClone, 'rev-parse', 'FETCH_HEAD').trim(), producedSha);

    git(shallowClone, 'cherry-pick', 'FETCH_HEAD');
    assert.equal(readFileSync(path.join(shallowClone, 'article-one.txt'), 'utf8'), 'uno\n');
    assert.equal(readFileSync(path.join(shallowClone, 'article-two.txt'), 'utf8'), 'due\n');
    assert.equal(
      git(shallowClone, 'diff', '--name-only', baseSha, 'HEAD').trim().split('\n').sort().join(','),
      'article-one.txt,article-two.txt',
    );

    const replay = readFileSync(replayPath, 'utf8');
    assert.match(replay, /git fetch origin [0-9a-f]{40}/);
    assert.match(replay, /git checkout --detach [0-9a-f]{40}/);
    assert.match(replay, /git fetch <bundle> <ref>/);
    assert.match(replay, /git cherry-pick FETCH_HEAD/);
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

test('serializza correttamente path con spazio, carattere non ASCII e newline', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'preserve-unpushed-paths-'));
  try {
    initRepo(root);
    writeFileSync(path.join(root, 'base.txt'), 'base\n');
    commitAll(root, 'base');
    const filename = 'article résumé\nline.txt';
    writeFileSync(path.join(root, filename), 'contenuto\n');

    const output = path.join(root, 'artifact');
    const result = runPreserver(root, '--worktree', output, 'passo fallito prima del commit');
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /source=worktree/);

    const manifest = JSON.parse(readFileSync(path.join(output, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.files, [filename]);
    assert.equal(manifest.source, 'worktree');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('la modalita worktree conserva staged, unstaged e non tracciati senza toccare il repo sorgente', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'preserve-unpushed-worktree-'));
  const outputRoot = mkdtempSync(path.join(tmpdir(), 'preserve-unpushed-worktree-artifact-'));
  try {
    initRepo(root);
    writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\n');
    writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
    commitAll(root, 'base');

    writeFileSync(path.join(root, 'staged résumé.txt'), 'staged\n');
    git(root, 'add', 'staged résumé.txt');
    writeFileSync(path.join(root, 'tracked.txt'), 'unstaged\n');
    writeFileSync(path.join(root, 'untracked.txt'), 'untracked\n');
    writeFileSync(path.join(root, 'ignored.txt'), 'ignored\n');

    const headBefore = git(root, 'rev-parse', 'HEAD').trim();
    const statusBefore = status(root);
    const indexBefore = git(root, 'ls-files', '--stage');
    const cachedDiffBefore = git(root, 'diff', '--cached', '--binary');
    const workingDiffBefore = git(root, 'diff', '--binary');
    const output = path.join(outputRoot, 'artifact');
    const result = runPreserver(root, '--worktree', output, 'Commit and push fallito prima del commit');

    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /source=worktree/);
    const manifest = JSON.parse(readFileSync(path.join(output, 'manifest.json'), 'utf8'));
    assert.equal(manifest.source, 'worktree');
    assert.equal(manifest.baseSha, headBefore);
    assert.notEqual(manifest.producedSha, headBefore);
    assert.deepEqual(
      manifest.files.sort(),
      ['staged résumé.txt', 'tracked.txt', 'untracked.txt'],
    );
    assert.equal(existsSync(path.join(output, 'article.bundle')), true);

    assert.equal(git(root, 'rev-parse', 'HEAD').trim(), headBefore);
    assert.equal(status(root), statusBefore);
    assert.equal(git(root, 'ls-files', '--stage'), indexBefore);
    assert.equal(git(root, 'diff', '--cached', '--binary'), cachedDiffBefore);
    assert.equal(git(root, 'diff', '--binary'), workingDiffBefore);
    assert.equal(git(root, 'for-each-ref', '--format=%(refname)', 'refs/unpushed').trim(), '');

    const replay = readFileSync(path.join(output, 'REPLAY.md'), 'utf8');
    assert.match(replay, /creato dallo script di conservazione/);
    assert.match(replay, /non dal generatore/);
    assert.match(replay, /unicità dopo il rebase e i registri delle immagini/);
    assert.match(replay, /NON sono stati eseguiti/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('la modalita worktree in un checkout sparse non registra come cancellati i file fuori dallo sparse', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'preserve-unpushed-sparse-'));
  try {
    const origin = path.join(root, 'origin');
    const checkout = path.join(root, 'checkout');
    mkdirSync(path.join(origin, 'content'), { recursive: true });
    mkdirSync(path.join(origin, 'public/images'), { recursive: true });
    initRepo(origin);
    writeFileSync(path.join(origin, 'content/article.txt'), 'base\n');
    writeFileSync(path.join(origin, 'public/images/cover.bin'), 'cover\n');
    writeFileSync(path.join(origin, 'public/images/thumb.bin'), 'thumb\n');
    commitAll(origin, 'base');

    git(root, 'clone', '-q', '--no-checkout', origin, checkout);
    git(checkout, 'config', 'user.name', 'test');
    git(checkout, 'config', 'user.email', 'test@example.invalid');
    git(checkout, 'sparse-checkout', 'set', '--no-cone', '/content/');
    git(checkout, 'checkout', '-q');
    assert.equal(existsSync(path.join(checkout, 'public/images/cover.bin')), false, 'la fixture deve essere sparse');

    writeFileSync(path.join(checkout, 'content/article.txt'), 'edited\n');
    writeFileSync(path.join(checkout, 'content/new-article.txt'), 'new\n');
    const output = path.join(root, 'artifact');
    const result = runPreserver(checkout, '--worktree', output, 'passo Commit and push fallito prima del commit');

    assert.equal(result.code, 0, result.output);
    const manifest = JSON.parse(readFileSync(path.join(output, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.files.sort(), ['content/article.txt', 'content/new-article.txt']);
    // Il commit conservato contiene ancora ciò che lo sparse aveva lasciato fuori.
    assert.deepEqual(
      git(checkout, 'ls-tree', '-r', '--name-only', manifest.producedSha).trim().split('\n').sort(),
      ['content/article.txt', 'content/new-article.txt', 'public/images/cover.bin', 'public/images/thumb.bin'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('la modalita worktree non chiede al promisor i blob che un clone parziale non ha', () => {
  // Su un clone senza blob un `git write-tree` semplice scarica prima tutti i
  // blob nominati dall'indice: nel repo del sito è costato 298 e 321 secondi a
  // un job da dieci minuti. Qui girerebbe dopo un fallimento, a job già finito.
  const root = mkdtempSync(path.join(tmpdir(), 'preserve-unpushed-blobless-'));
  try {
    const origin = path.join(root, 'origin');
    const checkout = path.join(root, 'checkout');
    const trace = path.join(root, 'trace.jsonl');
    mkdirSync(path.join(origin, 'content'), { recursive: true });
    mkdirSync(path.join(origin, 'public/images'), { recursive: true });
    initRepo(origin);
    git(origin, 'config', 'uploadpack.allowFilter', 'true');
    git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    writeFileSync(path.join(origin, 'content/article.txt'), 'base\n');
    for (let index = 0; index < 6; index += 1) {
      writeFileSync(path.join(origin, `public/images/cover-${index}.bin`), `cover ${index}\n`);
    }
    commitAll(origin, 'base');

    git(root, 'clone', '-q', '--filter=blob:none', '--no-checkout', `file://${origin}`, checkout);
    git(checkout, 'config', 'user.name', 'test');
    git(checkout, 'config', 'user.email', 'test@example.invalid');
    git(checkout, 'sparse-checkout', 'set', '--no-cone', '/content/');
    git(checkout, 'checkout', '-q');
    const missing = () => git(checkout, 'rev-list', '--objects', '--missing=print', 'HEAD')
      .split('\n').filter((line) => line.startsWith('?')).length;
    assert.equal(missing(), 6, 'la fixture deve essere senza i blob fuori dallo sparse');

    writeFileSync(path.join(checkout, 'content/new-article.txt'), 'new\n');
    const output = path.join(root, 'artifact');
    const result = runPreserverWithEnv(
      checkout,
      { ...GIT_ENV, GIT_TRACE2_EVENT: trace },
      '--worktree',
      output,
      'passo Commit and push fallito prima del commit',
    );

    assert.equal(result.code, 0, result.output);
    const manifest = JSON.parse(readFileSync(path.join(output, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.files, ['content/new-article.txt']);
    const promisorFetches = readFileSync(trace, 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === 'child_start'
        && Array.isArray(event.argv)
        && event.argv.includes('fetch')
        && event.argv.some((arg) => arg.startsWith('--filter=')));
    assert.deepEqual(promisorFetches.map((event) => event.argv.join(' ')), []);
    assert.equal(missing(), 6, 'la conservazione non deve materializzare i blob lasciati fuori');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('la modalita worktree usa una identita esplicita anche senza user.email', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'preserve-unpushed-identity-'));
  try {
    initRepo(root);
    writeFileSync(path.join(root, 'base.txt'), 'base\n');
    commitAll(root, 'base');
    git(root, 'config', '--local', '--unset', 'user.name');
    git(root, 'config', '--local', '--unset', 'user.email');
    writeFileSync(path.join(root, 'article.txt'), 'articolo\n');

    const env = { ...GIT_ENV };
    delete env.GIT_AUTHOR_NAME;
    delete env.GIT_AUTHOR_EMAIL;
    delete env.GIT_COMMITTER_NAME;
    delete env.GIT_COMMITTER_EMAIL;
    const output = path.join(root, 'artifact');
    const result = runPreserverWithEnv(root, env, '--worktree', output, 'identita esplicita');

    assert.equal(result.code, 0, result.output);
    const manifest = JSON.parse(readFileSync(path.join(output, 'manifest.json'), 'utf8'));
    assert.match(
      git(root, 'show', '-s', '--format=%an <%ae>', manifest.producedSha).trim(),
      /^frontaliere-articles\[bot\] <41898282\+github-actions\[bot\]@users\.noreply\.github\.com>$/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('nessuna differenza in modalita worktree produce solo un warning e nessun file', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'preserve-unpushed-empty-'));
  try {
    initRepo(root);
    writeFileSync(path.join(root, 'base.txt'), 'base\n');
    commitAll(root, 'base');
    const headBefore = git(root, 'rev-parse', 'HEAD').trim();
    const statusBefore = status(root);
    const output = path.join(root, 'artifact');
    const result = runPreserver(root, '--worktree', output, 'passo fallito prima del commit');

    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /::warning::/);
    assert.match(result.output, /nessun file scritto/);
    assert.equal(existsSync(output), false);
    assert.equal(git(root, 'rev-parse', 'HEAD').trim(), headBefore);
    assert.equal(status(root), statusBefore);
    assert.equal(git(root, 'for-each-ref', '--format=%(refname)', 'refs/unpushed').trim(), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('una cartella riusata e un ref base preesistente non lasciano ref temporanei', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'preserve-unpushed-reuse-'));
  try {
    initRepo(root);
    writeFileSync(path.join(root, 'base.txt'), 'base\n');
    const baseSha = commitAll(root, 'base');
    writeFileSync(path.join(root, 'article.txt'), 'articolo\n');
    const producedSha = commitAll(root, 'article');
    const output = path.join(root, 'artifact');

    const first = runPreserver(root, producedSha, output, 'push fallito dopo 3 tentativi');
    assert.equal(first.code, 0, first.output);
    const firstManifest = JSON.parse(readFileSync(path.join(output, 'manifest.json'), 'utf8'));
    assert.match(firstManifest.ref, /^refs\/unpushed\/article-[0-9a-f-]+$/);

    const staleRef = 'refs/unpushed/article';
    git(root, 'update-ref', staleRef, baseSha);
    const second = runPreserver(root, producedSha, output, 'push fallito dopo 3 tentativi');
    assert.equal(second.code, 0, second.output);
    const secondManifest = JSON.parse(readFileSync(path.join(output, 'manifest.json'), 'utf8'));
    assert.match(secondManifest.ref, /^refs\/unpushed\/article-[0-9a-f-]+$/);
    assert.notEqual(secondManifest.ref, staleRef);
    assert.notEqual(secondManifest.ref, firstManifest.ref);
    assert.equal(git(root, 'rev-parse', staleRef).trim(), baseSha);
    assert.deepEqual(
      git(root, 'for-each-ref', '--format=%(refname)', 'refs/unpushed').trim().split('\n'),
      [staleRef],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('i cinque producer del funnel hanno id, marker, conservazione condizionata e upload', () => {
  const candidates = articleProducerCandidates();
  assert.equal(candidates.length, 7, `derivati ${candidates.length} producer di articoli/refresh: la scansione e' rotta`);

  // I due refresh evergreen esistenti hanno un percorso diverso dal funnel
  // issue 2489 (non generano una nuova edizione/articolo): sono esclusi qui con
  // motivo esplicito, non con un array silenzioso dei cinque target.
  const exclusions = new Map([
    ['generate-border-wait-ranking-weekly.yml', 'refresh evergreen del ranking gia registrato'],
    ['refresh-events-digest.yml', 'refresh evergreen del digest gia registrato'],
  ]);
  for (const [workflow, reason] of exclusions) {
    assert.ok(reason, `${workflow}: ogni esclusione deve avere un motivo`);
    assert.ok(candidates.some((candidate) => candidate.name === workflow), `${workflow}: esclusione non derivata dal workflow`);
  }

  const producers = candidates.filter(({ name }) => !exclusions.has(name));
  assert.equal(producers.length, 5, `il funnel issue 2489 deve avere cinque producer, trovati ${producers.length}`);
  for (const { name, workflow, step } of producers) {
    assert.match(step.text, /^        id: commit$/m, `${name}: manca id: commit`);
    const commitAt = step.text.indexOf('git commit');
    const markerAt = step.text.indexOf('produced-article-commit');
    const pushAt = step.text.indexOf('git push');
    assert.ok(commitAt >= 0 && markerAt > commitAt && markerAt < pushAt, `${name}: marker non e' subito dopo il commit e prima del push`);

    const preserve = stepBlocks(workflow).find((candidate) => candidate.name === 'Preserve the unpushed article');
    const upload = stepBlocks(workflow).find((candidate) => candidate.name === 'Upload the unpushed article');
    assert.ok(preserve, `${name}: manca lo step di conservazione`);
    assert.ok(upload, `${name}: manca lo step di upload`);
    assert.ok(step.start < preserve.start && preserve.start < upload.start, `${name}: ordine commit → preserve → upload errato`);

    assert.match(
      preserve.text,
      /if: \$\{\{ failure\(\) && steps\.commit\.outcome == 'failure' && [^\n]*steps\.mode\.outputs\.dry != 'true' \}\}/,
      `${name}: la conservazione deve dipendere dal fallimento del solo commit`,
    );
    assert.match(preserve.text, /preserve-unpushed-commit\.sh/);
    assert.match(preserve.text, /--worktree/);
    assert.match(preserve.text, /fallito dopo il commit/);
    assert.match(preserve.text, /fallito prima del commit/);
    // Il passo può fermarsi dopo il commit per più ragioni (controllo di
    // unicità, rebase, push): il motivo scritto nel manifest non ne sceglie una.
    assert.doesNotMatch(preserve.text, /fallito dopo \d+ tentativi/, `${name}: il motivo non deve affermare una causa`);
    assert.match(preserve.text, /preserved=true/);
    assert.match(upload.text, /uses: actions\/upload-artifact@v7/);
    assert.match(upload.text, /always\(\) && steps\.preserve_unpushed_article\.outputs\.preserved == 'true'/);
    assert.match(upload.text, /name: unpushed-[a-z-]+-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
    assert.match(upload.text, /retention-days: 14/);
    assert.match(upload.text, /if-no-files-found: ignore/);
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
      const result = runPreserver(root, sha, output, 'input non valido');
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
