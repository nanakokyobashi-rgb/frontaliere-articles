/**
 * scripts/lib/rebase-onto-remote.sh — regression suite.
 *
 * The helper exists because a rebase conflict on a whole-file bookkeeping cache
 * is NOT transient: the retry loop in generate-article.yml re-ran the identical
 * operation five times and failed identically, and the step's own error message
 * spells out the stake — "the article is registered locally but not pushed"
 * (issue #76).
 *
 * These tests build throwaway git repositories on disk and drive the real
 * script, because every bug this file pins was in the interaction with git's
 * actual rebase state machine, not in logic that could be unit-tested. In
 * particular `assert_multiple_conflicting_commits_all_replay` pins the one that
 * a first cut of the script got wrong: `git rebase --continue` returning
 * non-zero can mean "advanced and stopped on the NEXT conflict" just as much as
 * "the replayed commit is now empty". Treating it as only the latter aborted a
 * rebase that was halfway through succeeding, and the commit it dropped was the
 * one carrying the article — i.e. the exact failure the helper was written to
 * prevent, reintroduced by the helper.
 */
import '../../host/cantonSectionsBootstrap.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
// Non `rmSync` diretta: git scrive in `.git/` dopo l'uscita del comando e la
// rimozione alza ENOTEMPTY. Il perche' e la misura stanno nel modulo.
import { rmTempTree } from './rm-temp-tree.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backstop, findDuplicates, mergeSource, pruneRetiredRecords, readRetiredIds } from '../../scripts/lib/merge-content-registry-conflict.mjs';
// Le due sorgenti di verita' da cui il generatore ricava i propri target di
// scrittura. Importarle (invece di ricopiarne i path) e' cio' che rende il test
// sui registri dichiarati una guardia e non un elenco che invecchia da solo.
import { corpusPath } from '../scripts/lib/corpus-paths.mjs';
import { ARTICLE_SECTION_CORE } from '../../engine/shared/articleSectionCore.mjs';
import { SECTIONS as SECTION_SURFACES } from '../../scripts/lib/article-surfaces.mjs';
import { sectionRebaseArgs, sectionRebaseSurfaces } from '../../scripts/ci/rebase-section-args.mjs';
import { IMAGE_CREDIT_RECORDS_DIR } from '../../scripts/lib/image-credit-records.mjs';
import { QUOTA_STATE_PATH } from '../scripts/lib/scheduler/quotaController.mjs';
import * as topicSelector from '../scripts/lib/article-topic-selector.mjs';

const { EVERGREEN_COUNTER_PATH, EXPERIMENTAL_COUNTER_PATH } = topicSelector;
import { sliceBetween, sliceFrom } from './lib/anchored-slice.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '../../scripts/lib/rebase-onto-remote.sh');
const QUEUE_RESOLVER = path.resolve(HERE, '../../scripts/lib/merge-image-regeneration-queue.mjs');
const WORKFLOW = path.resolve(HERE, '../../.github/workflows/generate-article.yml');
const JOURNALIST_WORKFLOW = path.resolve(HERE, '../../.github/workflows/publish-journalist-articles.yml');
const BOOKKEEPING = 'data/topic-candidates-evergreen-rejected.json';
const IMAGE_CATALOG = 'public/data/journalist-image-catalog.json';
const IMAGE_REGENERATION_QUEUE = 'data/image-regeneration-queue.json';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  // Il probe `npx -y tsx@4.23.15` del resolver e' lo strato 2 del backstop e vuole la
  // rete: qui e' spento, cosi' cio' che i test mettono alla prova e' lo strato
  // PORTANTE, quello offline che decide davvero. Un test che passa perche' un
  // download e' riuscito non prova niente sul giorno in cui non riesce.
  MERGE_REGISTRY_TSX_PROBE: 'off',
  // `NODE_TEST_CONTEXT` ereditato fa uscire 0 in ~50 ms un `node` figlio senza
  // eseguirlo. Qui i figli sono `bash` e il resolver, e un figlio che «passa»
  // in 50 ms senza girare e' un test verde che non ha guardato niente.
  NODE_TEST_CONTEXT: '',
};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function write(root, rel, contents) {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
}

function commitAll(root, message) {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
}

/** Runs the helper. Returns { code, out } — never throws on a non-zero exit. */
function runHelper(cwd, upstreamPath, ...allowlist) {
  try {
    const out = execFileSync('bash', [SCRIPT, upstreamPath, 'main', ...allowlist], {
      cwd,
      env: GIT_ENV,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/**
 * Builds: a bare upstream, a `work` clone (this run) and an `other` clone
 * (a concurrent run), with one shared base commit.
 */
function makeWorld() {
  const root = mkdtempSync(path.join(tmpdir(), 'rebase-onto-remote-'));
  const upstream = path.join(root, 'up.git');
  const work = path.join(root, 'work');
  const other = path.join(root, 'other');

  git(root, 'init', '-q', '--bare', 'up.git');
  git(root, 'init', '-q', 'work');
  // Pin the fixture: diff3/zdiff3 adds a `|||||||` section and would make a
  // source slice depend on the developer's global git configuration.
  git(work, 'config', 'merge.conflictStyle', 'merge');
  write(work, BOOKKEEPING, '{"base":true}\n');
  write(work, 'README.md', 'base\n');
  commitAll(work, 'base');
  git(work, 'push', '-q', upstream, 'HEAD:main');
  git(root, 'clone', '-q', upstream, 'other');

  return {
    root,
    upstream,
    work,
    other,
    cleanup: () => rmTempTree(root),
  };
}

/** Makes the concurrent run land `commits` on upstream main. */
function landUpstream(w, commits) {
  git(w.other, 'fetch', '-q', 'origin', 'main');
  git(w.other, 'reset', '-q', '--hard', 'origin/main');
  for (const [rel, contents, message] of commits) {
    write(w.other, rel, contents);
    commitAll(w.other, message);
  }
  git(w.other, 'push', '-q', 'origin', 'HEAD:main');
}

function headSha(root) {
  return git(root, 'rev-parse', 'HEAD').trim();
}

function rebaseInProgress(root) {
  return existsSync(path.join(root, '.git', 'rebase-merge')) || existsSync(path.join(root, '.git', 'rebase-apply'));
}

test('an article survives a conflict confined to the bookkeeping cache', () => {
  const w = makeWorld();
  try {
    landUpstream(w, [[BOOKKEEPING, '{"other":true}\n', 'concurrent run rewrites the cache']]);

    write(w.work, BOOKKEEPING, '{"mine":true}\n');
    write(w.work, 'content/blog-body/it/nuovo-articolo.ts', 'export const x = 1\n');
    commitAll(w.work, 'Generate blog article (frontaliere)');

    const { code, out } = runHelper(w.work, w.upstream, BOOKKEEPING);
    assert.equal(code, 0, `helper should succeed, got:\n${out}`);

    git(w.work, 'push', '-q', w.upstream, 'HEAD:main');
    assert.ok(
      existsSync(path.join(w.work, 'content/blog-body/it/nuovo-articolo.ts')),
      'the generated article must survive the rebase — losing it is the whole bug',
    );
    assert.match(
      git(w.work, 'show', `HEAD:${BOOKKEEPING}`),
      /other/,
      'the bookkeeping cache must end up as upstream wrote it',
    );
  } finally {
    w.cleanup();
  }
});

test('multiple conflicting commits all replay, and the article is not dropped', () => {
  // The regression. Two local commits both conflict on the cache; the first
  // becomes empty once upstream's copy is taken, the second carries the article.
  const w = makeWorld();
  try {
    landUpstream(w, [
      [BOOKKEEPING, '{"u":1}\n', 'u1'],
      [BOOKKEEPING, '{"u":2}\n', 'u2'],
    ]);

    write(w.work, BOOKKEEPING, '{"m":1}\n');
    commitAll(w.work, 'Record rejected topic candidates (no article generated)');
    write(w.work, BOOKKEEPING, '{"m":2}\n');
    write(w.work, 'content/blog-body/it/articolo.ts', 'export const w = 9\n');
    commitAll(w.work, 'Generate blog article (frontaliere)');

    const { code, out } = runHelper(w.work, w.upstream, BOOKKEEPING);
    assert.equal(code, 0, `helper should succeed across several conflict passes, got:\n${out}`);

    git(w.work, 'push', '-q', w.upstream, 'HEAD:main');
    assert.ok(
      existsSync(path.join(w.work, 'content/blog-body/it/articolo.ts')),
      'the article in the SECOND commit must survive',
    );
    assert.match(git(w.work, 'show', `HEAD:${BOOKKEEPING}`), /"u":2/);
    // The bookkeeping-only commit contributed nothing once upstream won, so it
    // should have been dropped rather than landed empty.
    const subjects = git(w.work, 'log', '--format=%s', '-3').trim().split('\n');
    assert.ok(
      !subjects.includes('Record rejected topic candidates (no article generated)'),
      `the emptied bookkeeping commit should be dropped, got: ${JSON.stringify(subjects)}`,
    );
  } finally {
    w.cleanup();
  }
});

test('a bookkeeping-only run ends as a no-op instead of a failure', () => {
  const w = makeWorld();
  try {
    landUpstream(w, [[BOOKKEEPING, '{"other":true}\n', 'concurrent run rewrites the cache']]);

    write(w.work, BOOKKEEPING, '{"mine":true}\n');
    commitAll(w.work, 'Record rejected topic candidates (no article generated)');

    const { code, out } = runHelper(w.work, w.upstream, BOOKKEEPING);
    assert.equal(code, 0, `helper should succeed, got:\n${out}`);

    const upstreamSha = git(w.work, 'ls-remote', w.upstream, 'main').split(/\s/)[0];
    assert.equal(headSha(w.work), upstreamSha, 'HEAD should equal upstream so the retried push is a no-op success');
  } finally {
    w.cleanup();
  }
});

test('a conflict outside the allowlist aborts and leaves the tree untouched', () => {
  const w = makeWorld();
  try {
    landUpstream(w, [['README.md', 'upstream version\n', 'concurrent run edits README']]);

    write(w.work, 'README.md', 'my version\n');
    write(w.work, 'content/blog-body/it/altro.ts', 'export const y = 2\n');
    commitAll(w.work, 'Generate blog article (frontaliere)');
    const before = headSha(w.work);

    const { code, out } = runHelper(w.work, w.upstream, BOOKKEEPING);
    assert.equal(code, 1, 'a non-bookkeeping conflict must still fail, exactly as before the fix');
    assert.match(out, /not a whole-file bookkeeping cache/);
    assert.equal(headSha(w.work), before, 'HEAD must be untouched after the abort');
    assert.equal(git(w.work, 'status', '--porcelain').trim(), '', 'the working tree must be left clean');
    assert.ok(!rebaseInProgress(w.work), 'no rebase may be left in progress');
  } finally {
    w.cleanup();
  }
});

test('a per-article path with neither a --theirs nor an --ours copy aborts on the first pass (#347)', () => {
  // The degenerate conflict shape #329's fix never had a real fixture for: a
  // path git flags as unmerged (present at stage 1) but with NEITHER a stage 2
  // (--ours) NOR a stage 3 (--theirs) entry to take — e.g. a "both deleted"
  // conflict, not the add/add this branch is written for. Constructing it
  // through ordinary commits isn't possible: git auto-resolves a plain
  // delete/delete with no conflict at all, so the two stages are stripped here
  // with index plumbing to pin the exact state the resolution loop must
  // handle, once git itself has produced it.
  const w = makeWorld();
  const PER_ARTICLE = 'content/blog-body/it/degenerate.ts';
  try {
    write(w.work, PER_ARTICLE, 'base\n');
    commitAll(w.work, 'seed a per-article file');
    git(w.work, 'push', '-q', w.upstream, 'HEAD:main');
    const baseBlob = git(w.work, 'rev-parse', `HEAD:${PER_ARTICLE}`).trim();

    landUpstream(w, [[PER_ARTICLE, 'upstream version\n', 'concurrent run rewrites it']]);

    write(w.work, PER_ARTICLE, 'mine version\n');
    commitAll(w.work, 'Generate blog article (frontaliere)');
    const before = headSha(w.work);

    // Drive the real conflict, then strip stage 2/3 down to stage 1 only —
    // the on-disk shape of a "both deleted" conflict (verified separately:
    // `git status` reports it as `DD`, and `git checkout --ours/--theirs`
    // both fail with "does not have {our,their} version").
    try {
      git(w.work, 'pull', '--rebase', w.upstream, 'main');
    } catch { /* conflict expected */ }
    assert.ok(rebaseInProgress(w.work), 'setup failed to produce the conflict this test needs');
    git(w.work, 'rm', '--cached', '-q', '--', PER_ARTICLE);
    execFileSync('git', ['update-index', '--index-info'], {
      cwd: w.work,
      env: GIT_ENV,
      input: `100644 ${baseBlob} 1\t${PER_ARTICLE}\n`,
    });
    assert.match(git(w.work, 'status', '--porcelain', '--', PER_ARTICLE), /^DD /);

    const { code, out } = runHelper(w.work, w.upstream, BOOKKEEPING, '--take-theirs', 'content/blog-body/');
    assert.equal(code, 1, 'a conflict with neither side to take must fail, not silently proceed');
    assert.doesNotMatch(
      out,
      /resolved per-article conflict/,
      'must not claim to have resolved a file it never staged — that false claim is the bug: ' +
        `it hid the fact that nothing was resolved. Output:\n${out}`,
    );
    assert.match(out, /neither a --theirs nor an --ours copy/);
    assert.equal(headSha(w.work), before, 'HEAD must be untouched after the abort');
    assert.equal(git(w.work, 'status', '--porcelain').trim(), '', 'the working tree must be left clean');
    assert.ok(!rebaseInProgress(w.work), 'no rebase may be left in progress');
  } finally {
    w.cleanup();
  }
});

test('a plain divergence with no conflict rebases cleanly', () => {
  const w = makeWorld();
  try {
    landUpstream(w, [['UNRELATED.md', 'upstream\n', 'unrelated upstream commit']]);

    write(w.work, 'content/blog-body/it/terzo.ts', 'export const z = 3\n');
    commitAll(w.work, 'Generate blog article (frontaliere)');

    const { code, out } = runHelper(w.work, w.upstream, BOOKKEEPING);
    assert.equal(code, 0, `the ordinary path must keep working, got:\n${out}`);
    git(w.work, 'push', '-q', w.upstream, 'HEAD:main');
  } finally {
    w.cleanup();
  }
});

/**
 * Reads the paths generate-article.yml ACTUALLY passes to the helper.
 *
 * The tests below deliberately do not hard-code an allowlist: the helper has
 * been able to resolve a bookkeeping conflict since #88, and the four runs lost
 * to issue #225 were not a bug in it — they were a path MISSING from what the
 * caller declared. Only the caller's own argument list can prove that, so the
 * one place that can regress is the one the assertion reads.
 */
function parseHelperArgs(yamlText) {
  const lines = yamlText.split('\n');
  const start = lines.findIndex((l) => l.includes('bash scripts/lib/rebase-onto-remote.sh'));
  if (start === -1) return { bookkeeping: [], registries: [], queues: [], takeTheirs: [], counters: [], sectionSurfaces: false };
  const bookkeeping = [];
  const registries = [];
  const queues = [];
  const takeTheirs = [];
  const counters = [];
  let sectionSurfaces = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    // Le quattro categorie stanno nello STESSO comando e vogliono dire cose
    // diverse — prendi upstream / unisci i record / prendi il commit rigiocato /
    // somma gli incrementi — quindi si separano qui invece di finire in un
    // elenco solo che nessuna assert potrebbe piu' distinguere.
    const clean = line.replace(/\\\s*$/, '').trim();
    if (clean === '--section-surfaces') {
      // I path per sezione non sono scritti nel workflow: l'helper li chiede a
      // scripts/ci/rebase-section-args.mjs. Si espandono con la STESSA funzione,
      // cosi' le guardie sotto continuano a vedere ogni path dichiarato.
      sectionSurfaces = true;
      const derived = sectionRebaseSurfaces(SECTION_SURFACES);
      bookkeeping.push(...derived.bookkeeping);
      registries.push(...derived.registries);
      takeTheirs.push(...derived.takeTheirs);
    } else if (clean.startsWith('--take-theirs')) {
      const prefix = clean.split(/\s+/)[1];
      if (prefix) takeTheirs.push(prefix.replace(/\s*\|\|\s*true$/, ''));
    } else if (clean.startsWith('--merge-counter')) {
      const spec = clean.split(/\s+/)[1];
      if (spec) counters.push(spec);
    } else if (clean.startsWith('--merge-queue')) {
      const queue = clean.split(/\s+/)[1];
      if (queue) queues.push(queue);
    } else {
      const target = line.includes('--merge-registry') ? registries
        : line.includes('--merge-queue') ? queues
          : bookkeeping;
      for (const token of clean.split(/\s+/)) {
        if (/^[\w./-]+\.(?:json|ts|mjs)$/.test(token)) target.push(token);
      }
    }
    if (!/\\\s*$/.test(line)) break; // the shell continuation ended
  }
  return { bookkeeping, registries, queues, takeTheirs, counters, sectionSurfaces };
}

function allowlistFromWorkflow(yamlText) {
  return parseHelperArgs(yamlText).bookkeeping;
}

function registriesFromWorkflow(yamlText) {
  return parseHelperArgs(yamlText).registries;
}

test('generate-article.yml declares the journalist image catalog as bookkeeping', () => {
  const allowlist = allowlistFromWorkflow(readFileSync(WORKFLOW, 'utf8'));
  assert.ok(allowlist.length >= 3, `could not parse the allowlist out of the workflow, got: ${JSON.stringify(allowlist)}`);
  assert.ok(
    allowlist.includes(IMAGE_CATALOG),
    `${IMAGE_CATALOG} must stay on the allowlist: generate-journalist-image-catalog.mjs derives the file `
    + 'entirely from the filenames under public/images/blog/ and rewrites it as ONE JSON.stringify line, so two '
    + `runs that add an image always conflict on it. Off the list the helper aborts and the run dies on "the `
    + `article is registered locally but not pushed" (issue #225, run 31459831234). Got: ${JSON.stringify(allowlist)}`,
  );
  // The two originals are asserted too: this list is edited by appending, and a
  // rewrite that silently drops one would reopen issue #76 without failing here.
  assert.ok(allowlist.includes(BOOKKEEPING), `${BOOKKEEPING} must stay on the allowlist (issue #76)`);
  assert.ok(allowlist.includes('data/blog-images-used.json'), 'data/blog-images-used.json must stay on the allowlist');
});

test('generate-article.yml declares every sourceUrlsFile/sourceQuotaFile ledger as bookkeeping (#496)', () => {
  // The expected set is DERIVED from ARTICLE_SECTION_CONFIGS in create-article.mjs,
  // not copied here — same reasoning as the registries test below: a section
  // whose sourceUrlsFile/sourceQuotaFile isn't declared here dies the same way
  // #225 did, just on a different path, and a hardcoded list wouldn't catch a
  // new section adding one. Both keys are pulled from the same regex pass
  // because they're staged in the exact same git-add block in create-article.mjs
  // (SOURCE_QUOTA_FILE and SOURCE_URLS_FILE) — same lifecycle, same risk.
  const allowlist = allowlistFromWorkflow(readFileSync(WORKFLOW, 'utf8'));
  const src = readFileSync(path.resolve(HERE, '../scripts/create-article.mjs'), 'utf8');
  const expected = [
    ...src.matchAll(/sourceUrlsFile:\s*'([^']+)'/g),
    ...src.matchAll(/sourceQuotaFile:\s*'([^']+)'/g),
  ].map((m) => m[1]);
  assert.ok(expected.length >= 4, `expected at least 4 sourceUrlsFile/sourceQuotaFile entries in create-article.mjs, found: ${JSON.stringify(expected)}`);
  for (const p of expected) {
    assert.ok(
      allowlist.includes(p),
      `${p} is a saveSourceUrls()/saveSourceQuotaState() ledger — loaded whole and rewritten whole every run by `
      + `create-article.mjs, exactly like ${IMAGE_CATALOG} above — but is missing from the bookkeeping allowlist `
      + `in generate-article.yml. A conflict there aborts the rebase and the generated article is lost (issue #496). `
      + `Declared: ${JSON.stringify(allowlist)}`,
    );
  }
});

test('generate-article.yml declares the topic-candidates consumed tracker as bookkeeping (#496)', () => {
  // CONSUMED_PATH is not per-section like the two ledgers above — it's one
  // shared tracker imported (as CONSUMED_TRACKER_PATH) into create-article.mjs
  // from article-topic-selector.mjs, so it's derived from its own source of
  // truth rather than folded into the sourceUrlsFile/sourceQuotaFile regex.
  const allowlist = allowlistFromWorkflow(readFileSync(WORKFLOW, 'utf8'));
  const selectorSrc = readFileSync(path.resolve(HERE, '../scripts/lib/article-topic-selector.mjs'), 'utf8');
  const m = /CONSUMED_PATH\s*=\s*'([^']+)'/.exec(selectorSrc);
  assert.ok(m, 'could not find CONSUMED_PATH in article-topic-selector.mjs');
  const consumedPath = m[1];
  assert.ok(
    allowlist.includes(consumedPath),
    `${consumedPath} is the persistConsumedTracker() tracker — loaded whole and rewritten whole every run `
    + `(FIFO-capped in appendConsumedId), staged in the same git-add block as SOURCE_URLS_FILE in create-article.mjs `
    + `— but is missing from the bookkeeping allowlist in generate-article.yml. A conflict there aborts the rebase `
    + `and the generated article is lost (issue #496). Declared: ${JSON.stringify(allowlist)}`,
  );
});

test('generate-article.yml declares the quota-state ledger as a counter (#496, D18)', () => {
  // QUOTA_STATE_PATH is a fourth sibling in the same class as the two ledgers
  // and the consumed tracker above, found during #496's own review: it is one
  // file SHARED across both sections (no swiss- variant), read whole by
  // loadQuotaState() and rewritten whole by saveQuotaState() — which
  // create-article.mjs calls after every successful publish. #496 declared it
  // as bookkeeping (take upstream); D18 moved it to --merge-counter, because
  // what create-article changes in it is `runCounter + 1` and taking upstream
  // drops that increment. Path imported from its own source of truth.
  const { bookkeeping, counters } = parseHelperArgs(readFileSync(WORKFLOW, 'utf8'));
  const quotaControllerSrc = readFileSync(
    path.resolve(HERE, '../scripts/lib/scheduler/quotaController.mjs'),
    'utf8',
  );
  // The field the generator increments is the field the merge sums.
  assert.match(quotaControllerSrc, /runCounter:\s*safe\.runCounter \+ 1/,
    'incrementCounter() no longer increments runCounter: update the --merge-counter field in generate-article.yml');
  assert.ok(
    counters.includes(`${QUOTA_STATE_PATH}:runCounter`),
    `${QUOTA_STATE_PATH} is the saveQuotaState() counter — rewritten whole after every successful publish with `
    + `runCounter + 1 — but is not declared as --merge-counter ${QUOTA_STATE_PATH}:runCounter in generate-article.yml. `
    + `As a bare path a conflict takes upstream and loses this run's increment; undeclared it aborts the rebase `
    + `and the generated article is lost (issue #496). Declared counters: ${JSON.stringify(counters)}`,
  );
  assert.ok(!bookkeeping.includes(QUOTA_STATE_PATH), `${QUOTA_STATE_PATH} must not be in two categories`);
});

test('ogni file che article-topic-selector.mjs scrive con una persist* e\' dichiarato in una categoria', () => {
  // La classe, non i singoli file: le funzioni `persist*` del selettore
  // riscrivono per intero un file di stato che `git add -A` porta nel commit,
  // tracciato o no. Fuori da ogni lista un conflitto (o un add/add di due run
  // che lo creano) abortisce il rebase. I path si leggono dalle costanti che le
  // persist* usano come default, non si ricopiano.
  const { bookkeeping, registries, takeTheirs, counters } = parseHelperArgs(readFileSync(WORKFLOW, 'utf8'));
  const declared = new Set([...bookkeeping, ...registries, ...counters.map((c) => c.slice(0, c.lastIndexOf(':')))]);
  const selectorSrc = readFileSync(path.resolve(HERE, '../scripts/lib/article-topic-selector.mjs'), 'utf8');
  const persisted = [];
  for (const m of selectorSrc.matchAll(/export function (persist\w+)\(/g)) {
    const from = sliceFrom(selectorSrc, m[0], { label: m[1] });
    const body = from.slice(0, from.indexOf('\n}\n'));
    const constName = /\b([A-Z][A-Z0-9_]*_PATH)\b/.exec(body)?.[1];
    assert.ok(constName, `${m[1]}: non trovo la costante *_PATH del file che scrive`);
    const p = topicSelector[constName];
    assert.equal(typeof p, 'string', `${constName} non e' esportata da article-topic-selector.mjs`);
    persisted.push({ fn: m[1], p });
  }
  assert.ok(persisted.length >= 5, `attese almeno 5 persist*, trovate: ${JSON.stringify(persisted)}`);
  for (const { fn, p } of persisted) {
    assert.ok(
      declared.has(p) || takeTheirs.some((prefix) => p.startsWith(prefix)),
      `${p} e' riscritto per intero da ${fn}() e finisce in git add -A, ma non e' dichiarato in nessuna categoria `
      + `di rebase-onto-remote.sh in generate-article.yml: un conflitto li' abortisce il rebase e l'articolo e' perso.`,
    );
  }
});

test('generate-article.yml declares the topic-candidates counters as counters (D18)', () => {
  // EXPERIMENTAL_COUNTER_PATH / EVERGREEN_COUNTER_PATH are rewritten whole by
  // persistExperimentalCounter()/persistEvergreenCounter() as `{count}` and
  // staged by `git add -A`: 198 and 133 of the last 200 generator commits
  // touched them (2026-10-05), yet they were on NO list, so a conflict there
  // aborted the rebase like #76/#225/#496. Imported, not copied: a renamed
  // counter makes this red instead of reopening the hole.
  const { bookkeeping, registries, takeTheirs, counters } = parseHelperArgs(readFileSync(WORKFLOW, 'utf8'));
  const selectorSrc = readFileSync(path.resolve(HERE, '../scripts/lib/article-topic-selector.mjs'), 'utf8');
  for (const [p, persist] of [
    [EXPERIMENTAL_COUNTER_PATH, 'persistExperimentalCounter'],
    [EVERGREEN_COUNTER_PATH, 'persistEvergreenCounter'],
  ]) {
    const from = sliceFrom(selectorSrc, `export function ${persist}(`, { label: persist });
    const body = from.slice(0, from.indexOf('\n}\n'));
    assert.match(body, /JSON\.stringify\(\{ count:/, `${persist} no longer writes {count}: update the --merge-counter field`);
    assert.ok(
      counters.includes(`${p}:count`),
      `${p} is a whole-file counter rewritten by ${persist}() and staged by git add -A, but is not declared as `
      + `--merge-counter ${p}:count in generate-article.yml. Declared counters: ${JSON.stringify(counters)}`,
    );
    assert.ok(!bookkeeping.includes(p) && !registries.includes(p), `${p} must not be in two categories`);
    assert.ok(!takeTheirs.some((prefix) => p.startsWith(prefix)),
      `${p} under --take-theirs would drop every increment that landed upstream meanwhile`);
  }
});

test('a conflict on the journalist image catalog resolves instead of aborting', () => {
  // Driven with the allowlist READ FROM THE WORKFLOW, not a literal: what this
  // pins is that the real caller declares the path, not that the helper can
  // resolve one when told to (the tests above already prove that).
  const allowlist = allowlistFromWorkflow(readFileSync(WORKFLOW, 'utf8'));
  const w = makeWorld();
  try {
    // Seed the catalog into the base both runs start from — the real file is
    // committed and rewritten in place, not created fresh on each run.
    write(w.work, IMAGE_CATALOG, '[{"path":"/images/blog/base.webp","words":["base"]}]');
    commitAll(w.work, 'seed the image catalog');
    git(w.work, 'push', '-q', w.upstream, 'HEAD:main');

    // A concurrent run publishes its own article and appends its image.
    landUpstream(w, [[
      IMAGE_CATALOG,
      '[{"path":"/images/blog/base.webp","words":["base"]},{"path":"/images/blog/altrui.webp","words":["altrui"]}]',
      'concurrent run appends its own hero image',
    ]]);

    // This run: a fully generated article — LLM, four translations, hero image
    // — plus its own append to the same single-line JSON.
    write(w.work, IMAGE_CATALOG, '[{"path":"/images/blog/base.webp","words":["base"]},{"path":"/images/blog/mio.webp","words":["mio"]}]');
    write(w.work, 'public/images/blog/mio.webp', 'RIFF-fake\n');
    write(w.work, 'content/blog-body/it/articolo-costoso.ts', 'export const a = 1\n');
    commitAll(w.work, 'Generate blog article (svizzera)');

    const { code, out } = runHelper(w.work, w.upstream, ...allowlist);
    assert.equal(code, 0, `the helper must resolve this conflict, not abort. Got:\n${out}`);
    assert.match(out, /resolved bookkeeping conflict by taking upstream: public\/data\/journalist-image-catalog\.json/);

    git(w.work, 'push', '-q', w.upstream, 'HEAD:main');
    assert.ok(
      existsSync(path.join(w.work, 'content/blog-body/it/articolo-costoso.ts')),
      'the generated article must survive — an article thrown away is what issue #225 measured 4 times in 37h',
    );
    // The image itself is a distinct path, so it lands even though the catalog
    // entry naming it was resolved to upstream's copy. A full rescan
    // (generate-journalist-image-catalog.mjs) rebuilds the entry from it.
    assert.ok(existsSync(path.join(w.work, 'public/images/blog/mio.webp')), 'the hero image must survive too');
    assert.match(git(w.work, 'show', `HEAD:${IMAGE_CATALOG}`), /altrui/, 'the catalog must end up as upstream wrote it');
  } finally {
    w.cleanup();
  }
});

function queueDocument(items) {
  return `${JSON.stringify({ schema: 1, items }, null, 2)}\n`;
}

function queueItem(articleId, reason, lastFailureAt) {
  return {
    articleId,
    title: `Titolo ${articleId}`,
    fallbackImage: '/images/places/lugano-view.webp',
    reason,
    status: 'queued',
    requestedAt: '2026-10-07T00:00:00.000Z',
    lastFailureAt,
  };
}

test('il conflitto della coda copertine unisce gli item per articleId', () => {
  const { queues } = parseHelperArgs(readFileSync(WORKFLOW, 'utf8'));
  assert.deepEqual(queues, [IMAGE_REGENERATION_QUEUE]);
  const w = makeWorld();
  try {
    const base = queueItem('article-base', 'base', '2026-10-07T00:01:00.000Z');
    write(w.work, IMAGE_REGENERATION_QUEUE, queueDocument([base]));
    commitAll(w.work, 'seed the cover regeneration queue');
    git(w.work, 'push', '-q', w.upstream, 'HEAD:main');

    const upstreamBase = { ...base, reason: 'upstream', lastFailureAt: '2026-10-07T00:02:00.000Z' };
    landUpstream(w, [[
      IMAGE_REGENERATION_QUEUE,
      queueDocument([upstreamBase, queueItem('article-upstream', 'upstream', '2026-10-07T00:03:00.000Z')]),
      'concurrent run queues its failed cover',
    ]]);

    const replayedBase = { ...base, reason: 'replayed', lastFailureAt: '2026-10-07T00:04:00.000Z' };
    write(w.work, IMAGE_REGENERATION_QUEUE, queueDocument([
      replayedBase,
      queueItem('article-replayed', 'replayed', '2026-10-07T00:05:00.000Z'),
    ]));
    write(w.work, 'content/blog-body/it/articolo-con-coda.ts', 'export const cover = true\n');
    commitAll(w.work, 'Generate blog article with cover queue item');

    const { code, out } = runHelper(w.work, w.upstream, '--merge-queue', IMAGE_REGENERATION_QUEUE);
    assert.equal(code, 0, `la coda deve fondersi, non abortire il rebase. Output:\n${out}`);
    const merged = JSON.parse(git(w.work, 'show', `HEAD:${IMAGE_REGENERATION_QUEUE}`));
    assert.deepEqual(merged.items.map((item) => item.articleId), [
      'article-base', 'article-upstream', 'article-replayed',
    ]);
    assert.equal(merged.items.find((item) => item.articleId === 'article-base').reason, 'replayed');
    assert.equal(new Set(merged.items.map((item) => item.articleId)).size, 3);
    assert.ok(existsSync(path.join(w.work, 'content/blog-body/it/articolo-con-coda.ts')));
  } finally {
    w.cleanup();
  }
});

test('il resolver della coda fallisce chiuso se git non riesce a leggere uno stage', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'queue-stage-read-error-'));
  try {
    assert.throws(
      () => execFileSync('node', [QUEUE_RESOLVER, IMAGE_REGENERATION_QUEUE], {
        cwd: root,
        env: GIT_ENV,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
      (error) => {
        assert.equal(error.status, 1);
        assert.match(
          String(error.stdout || '') + String(error.stderr || ''),
          /conflitto coda copertine non dimostrabile/,
        );
        return true;
      },
    );
  } finally {
    rmTempTree(root);
  }
});

test('il publisher journalist usa lo stesso rebase queue-aware', () => {
  const workflow = readFileSync(JOURNALIST_WORKFLOW, 'utf8');
  assert.match(
    workflow,
    /bash scripts\/lib\/rebase-onto-remote\.sh "\$REMOTE" "\$TARGET" \\\n\s+--merge-queue data\/image-regeneration-queue\.json/,
  );
  assert.doesNotMatch(workflow, /git pull --rebase "\$REMOTE" "\$TARGET"/);
});

test('an empty allowlist is a caller bug, not a silent always-abort', () => {
  // Without this guard a caller that forgot its paths would degrade to exactly
  // the old behaviour, which is indistinguishable from the fix not being there.
  const w = makeWorld();
  try {
    const { code } = runHelper(w.work, w.upstream);
    assert.equal(code, 2);
  } finally {
    w.cleanup();
  }
});

// ════════════════════════════════════════════════════════════════════════════
// I REGISTRI APPEND-ONLY — issue #255 (FRONTALIERE), #281 e #285 (SVIZZERA)
// ════════════════════════════════════════════════════════════════════════════
//
// I test qui sopra coprono i tre path di bookkeeping e la loro risoluzione
// «prendi upstream». Su questa classe non provano NIENTE, ed e' il buco che
// costava gli articoli: `content/blog-articles-data.ts` e i suoi gemelli non
// erano ne' sull'allowlist (giustamente: prendere un lato CANCELLA record) ne'
// da nessun'altra parte, quindi un conflitto li' abortiva, cinque volte, e
// `generate-article.yml` moriva su «the article is registered locally but not
// pushed» portandosi via il commit.
//
// Il fixture qui sotto REPLICA il conflitto vero: due commit che appendono id
// diversi allo stesso punto d'inserzione. L'assert e' che sopravvivano
// ENTRAMBI — non che il comando esca 0.

const REGISTRY = 'content/blog-articles-data.ts';
const SWISS_REGISTRY = 'content/swiss-articles-data.ts';
const RESOLVER = path.resolve(HERE, '../../scripts/lib/merge-content-registry-conflict.mjs');

/** Il registro FRONTALIERE con gli id dati, nella forma reale (array di oggetti). */
function articlesRegistry(ids) {
  const entries = ids.map((id) => `  {\n   id: '${id}',\n   category: 'fiscale',\n`
    + `   date: '2026-08-14',\n   image: '/images/blog/${id}.webp',\n   hasCalculator: false,\n`
    + `   authorName: 'Redazione Frontaliere Ticino',\n  },\n`).join('');
  return `import { cdnBlogImage } from './blogImageCdnMirror';\n\n`
    + `export interface Article {\n id: string;\n category: string;\n date: string;\n`
    + ` image: string;\n hasCalculator: boolean;\n authorName?: string;\n}\n\n`
    + `const RAW_ARTICLES = [\n${entries}] satisfies Article[];\n\n`
    + `export const ARTICLES: Article[] = RAW_ARTICLES.map((a) => ({ ...a, image: cdnBlogImage(a.image) }));\n`;
}

/** Il registro SVIZZERA — stessa forma, altro array e altro export. */
function swissRegistry(ids) {
  const entries = ids.map((id) => `  {\n   id: '${id}',\n   category: 'pratico',\n`
    + `   date: '2026-08-14',\n   image: '/images/places/${id}.webp',\n   hasCalculator: false,\n`
    + `   authorName: 'Redazione Frontaliere Ticino',\n  },\n`).join('');
  return `import type { Article } from './blog-articles-data';\n`
    + `import { cdnBlogImage } from './blogImageCdnMirror';\n\n`
    + `const RAW_SWISS_ARTICLES: Article[] = [\n${entries}];\n\n`
    + `export const SWISS_ARTICLES: Article[] = RAW_SWISS_ARTICLES.map((a) => ({ ...a, image: cdnBlogImage(a.image) }));\n`;
}

/** Una mappa slug (`BLOG_SLUGS` / `SWISS_SLUGS`): una riga per id. */
function slugMap(constName, ids) {
  const rows = ids.map((id) => ` '${id}': { it: '${id}-it', en: '${id}-en', de: '${id}-de', fr: '${id}-fr' },\n`).join('');
  return `export const ${constName}: Record<string, Record<string, string>> = {\n${rows}};\n`;
}

/** Un file meta per-locale: tre chiavi i18n per articolo, come i veri. */
function metaFile(constName, ids) {
  const rows = ids.flatMap((id) => [
    ` 'blog.article.${id}.title': 'Titolo di ${id}',`,
    ` 'blog.article.${id}.excerpt': 'Sommario di ${id}, con un apostrofo dell\\'A9 dentro.',`,
    ` 'blog.article.${id}.imageAlt': 'Immagine di ${id}',`,
  ]).join('\n');
  return `const ${constName}: Record<string, string> = {\n${rows}\n};\n\nexport default ${constName};\n`;
}

/** Il file SEO: una entry annidata per articolo. */
function seoFile(constName, hub, ids) {
  const rows = ids.map((id) => ` 'blog-${id}': {\n  title: 'SEO ${id}',\n`
    + `  description: 'Descrizione SEO di ${id}.',\n  canonicalPath: '/${hub}/${id}/',\n`
    + `  structuredData: { "@type": "NewsArticle", "headline": "${id}" },\n },\n`).join('');
  return `import type { SEOMetadata } from './seoMetadataType';\n\n`
    + `const ${constName}: Record<string, SEOMetadata> = {\n${rows}};\n\nexport default ${constName};\n`;
}

/** `blogArticleIds.ts`: non un contenitore di record ma una union di literal. */
function idUnion(ids) {
  return `type _BlogId1 = ${ids.map((i) => `'${i}'`).join(' | ')};\n\n`
    + `export type BlogArticleId = _BlogId1;\n`;
}

/** L'elenco piatto dentro routerBlogData.ts — dichiarazione singola che cresce. */
function allIds(ids) {
  return `export const ALL_BLOG_ARTICLE_IDS: string[] = [${ids.map((i) => `'${i}'`).join(', ')}];\n`;
}

/** Gli argomenti che il WORKFLOW passa davvero, non una lista riscritta qui. */
function helperArgsFromWorkflow() {
  const { bookkeeping, registries, queues, takeTheirs, counters, sectionSurfaces } = parseHelperArgs(readFileSync(WORKFLOW, 'utf8'));
  if (sectionSurfaces) {
    // Come nel workflow: il flag, non la sua espansione. Cosi' i casi git sotto
    // passano davvero dalla derivazione dentro rebase-onto-remote.sh.
    const derived = new Set(sectionRebaseArgs(SECTION_SURFACES));
    return [
      ...bookkeeping.filter((p) => !derived.has(p)),
      ...queues.flatMap((p) => ['--merge-queue', p]),
      ...counters.flatMap((c) => ['--merge-counter', c]),
      ...registries.filter((r) => !derived.has(r)).flatMap((r) => ['--merge-registry', r]),
      ...takeTheirs.filter((p) => !derived.has(p)).flatMap((p) => ['--take-theirs', p]),
      '--section-surfaces',
    ];
  }
  return [
    ...bookkeeping,
    ...queues.flatMap((p) => ['--merge-queue', p]),
    ...counters.flatMap((c) => ['--merge-counter', c]),
    ...registries.flatMap((r) => ['--merge-registry', r]),
    ...takeTheirs.flatMap((p) => ['--take-theirs', p]),
  ];
}

test('due articoli appesi allo stesso punto sopravvivono entrambi (FRONTALIERE, #255)', () => {
  const w = makeWorld();
  try {
    // La base da cui partono i due run concorrenti.
    write(w.work, REGISTRY, articlesRegistry(['articolo-base']));
    write(w.work, 'content/routerBlogData.ts', `${slugMap('BLOG_SLUGS', ['articolo-base'])}\n${allIds(['articolo-base'])}`);
    write(w.work, 'content/blogArticleIds.ts', idUnion(['articolo-base']));
    write(w.work, 'content/blog-meta-it.ts', metaFile('blogMetaIt', ['articolo-base']));
    write(w.work, 'content/seo/seo-blog-5.ts', seoFile('BLOG_SEO_METADATA', 'blog', ['articolo-base']));
    commitAll(w.work, 'seed the corpus registries');
    git(w.work, 'push', '-q', w.upstream, 'HEAD:main');

    // Il run concorrente registra il SUO articolo e atterra per primo.
    landUpstream(w, [[REGISTRY, articlesRegistry(['articolo-base', 'articolo-upstream']), 'concurrent run registers its article'],
      ['content/routerBlogData.ts', `${slugMap('BLOG_SLUGS', ['articolo-base', 'articolo-upstream'])}\n${allIds(['articolo-base', 'articolo-upstream'])}`, 'x'],
      ['content/blogArticleIds.ts', idUnion(['articolo-base', 'articolo-upstream']), 'x'],
      ['content/blog-meta-it.ts', metaFile('blogMetaIt', ['articolo-base', 'articolo-upstream']), 'x'],
      ['content/seo/seo-blog-5.ts', seoFile('BLOG_SEO_METADATA', 'blog', ['articolo-base', 'articolo-upstream']), 'x'],
    ]);

    // Questo run: articolo generato per intero — LLM, quattro traduzioni,
    // immagine hero — registrato allo STESSO punto d'inserzione.
    write(w.work, REGISTRY, articlesRegistry(['articolo-base', 'articolo-mio']));
    write(w.work, 'content/routerBlogData.ts', `${slugMap('BLOG_SLUGS', ['articolo-base', 'articolo-mio'])}\n${allIds(['articolo-base', 'articolo-mio'])}`);
    write(w.work, 'content/blogArticleIds.ts', idUnion(['articolo-base', 'articolo-mio']));
    write(w.work, 'content/blog-meta-it.ts', metaFile('blogMetaIt', ['articolo-base', 'articolo-mio']));
    write(w.work, 'content/seo/seo-blog-5.ts', seoFile('BLOG_SEO_METADATA', 'blog', ['articolo-base', 'articolo-mio']));
    write(w.work, 'content/blog-body/it/articolo-mio.ts', 'export const body = "…";\n');
    commitAll(w.work, 'Generate blog article (frontaliere)');

    const { code, out } = runHelper(w.work, w.upstream, ...helperArgsFromWorkflow());
    assert.equal(code, 0, `il conflitto sui registri deve risolversi, non abortire. Output:\n${out}`);

    git(w.work, 'push', '-q', w.upstream, 'HEAD:main');

    // L'assert che conta: ENTRAMBI gli id, in OGNI file della famiglia.
    for (const file of [REGISTRY, 'content/routerBlogData.ts', 'content/blogArticleIds.ts',
      'content/blog-meta-it.ts', 'content/seo/seo-blog-5.ts']) {
      const landed = git(w.work, 'show', `HEAD:${file}`);
      assert.match(landed, /articolo-upstream/, `${file}: l'articolo di upstream e' stato CANCELLATO dal merge`);
      assert.match(landed, /articolo-mio/, `${file}: l'articolo appena generato e' stato CANCELLATO dal merge`);
      assert.match(landed, /articolo-base/, `${file}: il record preesistente e' sparito`);
      assert.doesNotMatch(landed, /<{7}|={7}|>{7}/, `${file}: marker di conflitto finiti nel commit`);
    }
    assert.ok(
      existsSync(path.join(w.work, 'content/blog-body/it/articolo-mio.ts')),
      'il corpo dell\'articolo generato deve sopravvivere: perderlo e\' tutto il bug',
    );
  } finally {
    w.cleanup();
  }
});

test('la stessa cosa vale per la famiglia SVIZZERA (#281, #285)', () => {
  // #281 e #285 NON sono difetti diversi: sono #255 sui path svizzera. Coprire
  // solo la prima famiglia le lascerebbe aperte, quindi qui si guarda solo
  // quella — swiss-articles-data, routerSwissData, blog-meta-ch-*, seo-blog-ch.
  const w = makeWorld();
  try {
    const base = ['svizzera-base'];
    const upstream = ['svizzera-base', 'svizzera-upstream'];
    const mine = ['svizzera-base', 'svizzera-mio'];
    const files = (ids) => [
      [SWISS_REGISTRY, swissRegistry(ids)],
      ['content/routerSwissData.ts', slugMap('SWISS_SLUGS', ids)],
      ['content/blog-meta-ch-it.ts', metaFile('blogMetaChIt', ids)],
      ['content/blog-meta-ch-de.ts', metaFile('blogMetaChDe', ids)],
      ['content/seo/seo-blog-ch.ts', seoFile('BLOG_CH_SEO_METADATA', 'articoli-svizzera', ids)],
    ];

    for (const [rel, contents] of files(base)) write(w.work, rel, contents);
    commitAll(w.work, 'seed the SVIZZERA registries');
    git(w.work, 'push', '-q', w.upstream, 'HEAD:main');

    landUpstream(w, files(upstream).map(([rel, contents]) => [rel, contents, `upstream ${rel}`]));

    for (const [rel, contents] of files(mine)) write(w.work, rel, contents);
    write(w.work, 'content/blog-body-ch/it/svizzera-mio.ts', 'export const body = "…";\n');
    commitAll(w.work, 'Generate blog article (svizzera)');

    const { code, out } = runHelper(w.work, w.upstream, ...helperArgsFromWorkflow());
    assert.equal(code, 0, `il conflitto sui registri SVIZZERA deve risolversi. Output:\n${out}`);

    git(w.work, 'push', '-q', w.upstream, 'HEAD:main');
    for (const [rel] of files(mine)) {
      const landed = git(w.work, 'show', `HEAD:${rel}`);
      assert.match(landed, /svizzera-upstream/, `${rel}: articolo upstream cancellato`);
      assert.match(landed, /svizzera-mio/, `${rel}: articolo appena generato cancellato`);
      assert.doesNotMatch(landed, /<{7}|={7}|>{7}/, `${rel}: marker di conflitto nel commit`);
    }
    assert.ok(existsSync(path.join(w.work, 'content/blog-body-ch/it/svizzera-mio.ts')));
  } finally {
    w.cleanup();
  }
});

/**
 * Il file conflittato VERO: si fa partire un rebase e lo si legge dal disco,
 * invece di scrivere a mano dove dovrebbero cadere i marker. Dove git mette il
 * confine e' il fatto in discussione, e scriverlo a mano lo darebbe per buono.
 */
function conflictedRegistry(mineIds, upstreamIds, mutate = (s) => s) {
  const w = makeWorld();
  try {
    write(w.work, REGISTRY, mutate(articlesRegistry(['articolo-base']), 'base'));
    commitAll(w.work, 'seed');
    git(w.work, 'push', '-q', w.upstream, 'HEAD:main');
    landUpstream(w, [[REGISTRY, mutate(articlesRegistry(upstreamIds), 'upstream'), 'upstream']]);
    write(w.work, REGISTRY, mutate(articlesRegistry(mineIds), 'mine'));
    commitAll(w.work, 'Generate blog article (frontaliere)');
    try {
      git(w.work, 'pull', '--rebase', w.upstream, 'main');
    } catch { /* il conflitto e' il punto */ }
    return readFileSync(path.join(w.work, REGISTRY), 'utf8');
  } finally {
    w.cleanup();
  }
}

test('il confine del conflitto cade a META\' ENTRY, e il merge non fonde i due record', () => {
  // Questa NON e' un'ipotesi: e' la forma che git produce davvero. Le entry di
  // questi registri condividono quasi tutte le righe (`  {`, `   category:`,
  // `   hasCalculator: false,`, `   authorName: …`, `  },`), quindi quando due
  // run ne appendono una a testa il confine NON finisce fra le due entry — cade
  // dentro, e i due lati sono mezzo record ciascuno dentro UNA graffa sola.
  const conflicted = conflictedRegistry(['articolo-base', 'articolo-mio'], ['articolo-base', 'articolo-upstream']);
  assert.match(conflicted, /<{7}/, 'il fixture deve contenere un conflitto vero');

  // Prova che il confine e' davvero a meta' entry: fra `<<<<<<<` e `>>>>>>>`
  // non c'e' una graffa di apertura, quindi nessun lato contiene un record
  // intero. Se un giorno git allineasse diversamente, questo assert lo dice
  // invece di lasciar passare un test che non prova piu' la stessa cosa.
  const between = sliceBetween(conflicted, '<<<<<<<', '>>>>>>>');
  assert.doesNotMatch(between, /\{/, `il fixture non replica piu' il boundary a meta' entry:\n${between}`);

  const result = mergeSource(conflicted);
  assert.ok(result.ok, `il merge deve riuscire su questa forma, altrimenti la fix non serve a niente: ${result.reason}`);
  assert.deepEqual(findDuplicates(result.merged), [],
    `il merge ha FUSO due record: ${result.merged}`);
  for (const id of ['articolo-base', 'articolo-upstream', 'articolo-mio']) {
    assert.ok(result.merged.includes(`id: '${id}'`), `manca l'id '${id}' dal merge:\n${result.merged}`);
  }
  // Tre id ⇒ tre graffe di apertura di record. Due id in una graffa sola e'
  // esattamente la corruzione, e conta piu' del numero di id.
  assert.equal((result.merged.match(/\{\n\s+id: '/g) || []).length, 3,
    `tre record devono restare tre oggetti distinti:\n${result.merged}`);
  assert.deepEqual(backstop(result.merged, result.ours, result.theirs), []);
});

test('una tombstone non viene riesumata dal merge per-record, nemmeno nella union degli id', () => {
  const conflicted = conflictedRegistry(['articolo-base', 'articolo-mio'], ['articolo-base', 'articolo-upstream']);
  const result = mergeSource(conflicted, { retiredIds: new Set(['articolo-upstream']) });
  assert.ok(result.ok, `il merge con tombstone deve riuscire: ${result.reason}`);
  assert.match(result.merged, /articolo-base/);
  assert.match(result.merged, /articolo-mio/);
  assert.doesNotMatch(result.merged, /articolo-upstream/);
  assert.deepEqual(backstop(result.merged, result.ours, result.theirs), []);

  const unionConflict = [
    "type _BlogId1 = 'articolo-base' |",
    '<<<<<<< HEAD',
    "'articolo-upstream'",
    '=======',
    "'articolo-mio'",
    '>>>>>>> replay',
    ';',
    'export type BlogArticleId = _BlogId1;',
    '',
  ].join('\n');
  const union = mergeSource(unionConflict, { retiredIds: new Set(['articolo-upstream']) });
  assert.ok(union.ok, `la union con tombstone deve riuscire: ${union.reason}`);
  assert.match(union.merged, /'articolo-base'/);
  assert.match(union.merged, /'articolo-mio'/);
  assert.doesNotMatch(union.merged, /articolo-upstream/);

  const metadata = [
    "const M = {",
    "  'blog.article.articolo-upstream.title': 'ritirato',",
    "  'blog.article.articolo-upstream-2.title': 'attivo',",
    "  'blog-articolo-upstream': { title: 'ritirato' },",
    "  'blog-articolo-upstream-2': { title: 'attivo' },",
    '};',
    '',
  ].join('\n');
  const pruned = pruneRetiredRecords(metadata, new Set(['articolo-upstream']));
  assert.doesNotMatch(pruned, /blog\.article\.articolo-upstream\.title/);
  assert.doesNotMatch(pruned, /'blog-articolo-upstream':/);
  assert.match(pruned, /articolo-upstream-2/);
});

test('il prune conserva l\'ancora di un contenitore e di una union potati', () => {
  const conflicted = conflictedRegistry(['articolo-mio'], ['articolo-upstream']);
  const result = mergeSource(conflicted, { retiredIds: new Set(['articolo-upstream']) });
  assert.ok(result.ok, `un record vivo deve fondersi con un lato potato: ${result.reason}`);
  assert.match(result.merged, /articolo-mio/);
  assert.doesNotMatch(result.merged, /articolo-upstream/);

  const unionConflict = [
    'type _BlogId1 =',
    '<<<<<<< HEAD',
    "'articolo-upstream'",
    '=======',
    "'articolo-mio'",
    '>>>>>>> replay',
    ';',
    'export type BlogArticleId = _BlogId1;',
    '',
  ].join('\n');
  const union = mergeSource(unionConflict, { retiredIds: new Set(['articolo-upstream']) });
  assert.ok(union.ok, `una union con un lato vuoto deve fondersi: ${union.reason}`);
  assert.match(union.merged, /'articolo-mio'/);
  assert.doesNotMatch(union.merged, /articolo-upstream/);

  const bothRetired = mergeSource(unionConflict, { retiredIds: new Set(['articolo-upstream', 'articolo-mio']) });
  assert.equal(bothRetired.ok, false);
  assert.match(bothRetired.reason, /union .* vuota/);
});

test('il resolver CLI legge il ledger dei ritiri prima di scrivere il conflitto', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'merge-retired-ledger-'));
  try {
    const conflicted = conflictedRegistry(['articolo-base', 'articolo-mio'], ['articolo-base', 'articolo-upstream']);
    write(root, 'data/retired-articles.json', JSON.stringify({ retired: [{
      id: 'articolo-upstream',
      section: 'frontaliere',
      winnerId: 'articolo-vivo',
      winnerSection: 'frontaliere',
      retiredOn: '2026-10-07',
      duplicateOf: [],
      slugs: { it: 'a', en: 'b', de: 'c', fr: 'd' },
    }] }));
    write(root, REGISTRY, conflicted);

    execFileSync('node', [RESOLVER, REGISTRY], { cwd: root, env: GIT_ENV, encoding: 'utf8' });
    const merged = readFileSync(path.join(root, REGISTRY), 'utf8');
    assert.match(merged, /articolo-base/);
    assert.match(merged, /articolo-mio/);
    assert.doesNotMatch(merged, /articolo-upstream/);
  } finally {
    rmTempTree(root);
  }
});

test('il ledger delle tombstone invalido viene rifiutato senza filtrare gli id', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'merge-retired-invalid-ledger-'));
  const valid = {
    id: 'articolo-upstream',
    section: 'frontaliere',
    winnerId: 'articolo-vivo',
    winnerSection: 'frontaliere',
    retiredOn: '2026-10-07',
    duplicateOf: [],
    slugs: { it: 'a', en: 'b', de: 'c', fr: 'd' },
  };
  try {
    for (const retired of [
      [{ ...valid, winnerId: '' }],
      [{ ...valid }, { ...valid }],
      [{ id: valid.id }],
      [{ ...valid, slugs: { ...valid.slugs, fr: '' } }],
    ]) {
      write(root, 'data/retired-articles.json', JSON.stringify({ retired }));
      assert.throws(() => readRetiredIds(root), /deve essere|duplicato/);
    }
  } finally {
    rmTempTree(root);
  }
});

test('sullo STESSO file, «togli i marker e tieni entrambi i lati» fonde — e il backstop lo blocca', () => {
  // La riparazione ingenua, che e' quella che il resolver del sito applica ai
  // suoi append-only. Su questo boundary produce un oggetto con due `id`, due
  // `category`, due `date`: sintatticamente valido, quindi una CI che si limita
  // a compilare passa. E' il caso in cui il backstop e' l'unica cosa che sta fra
  // il registro e la corruzione, quindi va provato che dice di no.
  const conflicted = conflictedRegistry(['articolo-base', 'articolo-mio'], ['articolo-base', 'articolo-upstream']);
  const naive = conflicted
    .split('\n')
    .filter((l) => !/^<{7}|^={7}$|^>{7}/.test(l))
    .join('\n');

  assert.doesNotMatch(naive, /<{7}|={7}|>{7}/);
  const reference = mergeSource(conflicted);
  assert.ok(reference.ok);

  const problems = backstop(naive, reference.ours, reference.theirs);
  assert.ok(
    problems.some((p) => p.startsWith('(b)')),
    `il backstop deve rifiutare il registro fuso, invece ha detto: ${JSON.stringify(problems)}\n${naive}`,
  );
});

test('un conflitto anche FUORI dai record fa abortire, e non riscrive niente', () => {
  // Il merge per-record sa unire i record e nient'altro. Quando il conflitto
  // tocca anche il resto del file — qui l'intestazione — tenere `ours` come base
  // risolverebbe quella parte su upstream in silenzio, buttando via una modifica
  // del commit rigiocato senza che nessuno lo sappia. L'esito giusto e' abortire
  // e lasciare l'albero com'era: e' lo stesso costo di prima della fix, mai piu'.
  const w = makeWorld();
  try {
    const withHeader = (body, side) => `// intestazione, versione ${side === 'base' ? 'base' : side}\n${body}`;
    write(w.work, REGISTRY, withHeader(articlesRegistry(['articolo-base']), 'base'));
    commitAll(w.work, 'seed');
    git(w.work, 'push', '-q', w.upstream, 'HEAD:main');
    landUpstream(w, [[REGISTRY, withHeader(articlesRegistry(['articolo-base', 'articolo-upstream']), 'upstream'), 'upstream']]);

    write(w.work, REGISTRY, withHeader(articlesRegistry(['articolo-base', 'articolo-mio']), 'mine'));
    commitAll(w.work, 'Generate blog article (frontaliere)');
    const before = headSha(w.work);

    const { code, out } = runHelper(w.work, w.upstream, ...helperArgsFromWorkflow());
    assert.equal(code, 1, `un conflitto fuori dai record DEVE abortire, non committare. Output:\n${out}`);
    assert.match(out, /FUORI dai contenitori di record|perderebbe una modifica/,
      `l'abort deve dire PERCHE', altrimenti il prossimo caso e' indistinguibile. Output:\n${out}`);
    assert.equal(headSha(w.work), before, 'HEAD deve restare intatto dopo l\'abort');
    assert.equal(git(w.work, 'status', '--porcelain').trim(), '', 'l\'albero deve restare pulito');
    assert.ok(!rebaseInProgress(w.work), 'nessun rebase puo\' restare in corso');

    const onDisk = readFileSync(path.join(w.work, REGISTRY), 'utf8');
    assert.match(onDisk, /articolo-mio/);
    assert.doesNotMatch(onDisk, /articolo-upstream/, 'il resolver NON deve aver riscritto il file');
    assert.doesNotMatch(onDisk, /<{7}|={7}|>{7}/);
  } finally {
    w.cleanup();
  }
});

test('il backstop rifiuta un risultato con id duplicati o con meno record dei due lati', () => {
  // Le due meta' di (b) e (c) provate direttamente, senza passare da git: se un
  // giorno il merge producesse un record fuso o ne perdesse uno, questo e' il
  // controllo che deve dire di no.
  const ours = articlesRegistry(['a', 'b']);
  const theirs = articlesRegistry(['a', 'c']);
  const good = articlesRegistry(['a', 'b', 'c']);
  assert.deepEqual(backstop(good, ours, theirs), [], 'un merge corretto deve passare');

  const duplicated = articlesRegistry(['a', 'b', 'c', 'b']);
  assert.ok(
    backstop(duplicated, ours, theirs).some((p) => p.startsWith('(b)')),
    'un id duplicato deve far fallire il backstop (b)',
  );

  const truncated = articlesRegistry(['a']);
  assert.ok(
    backstop(truncated, ours, theirs).some((p) => p.startsWith('(c)')),
    'un risultato con meno record del massimo dei due lati deve far fallire il backstop (c)',
  );

  const broken = `${good.slice(0, -40)}\n`;
  assert.ok(
    backstop(broken, ours, theirs).some((p) => p.startsWith('(a)')),
    'un risultato che non si ri-analizza deve far fallire il backstop (a)',
  );
});

test('generate-article.yml dichiara come registro OGNI target di scrittura del generatore', () => {
  // La forma della issue #225: il difetto non era nell'helper, era un path che
  // il CHIAMANTE non dichiarava. Quindi l'elenco atteso NON si ricopia qui —
  // si DERIVA dalle stesse strutture da cui scrive create-article.mjs, cosi'
  // una sezione nuova o un target rinominato fa rosso questo test invece di
  // perdere articoli in silenzio.
  const registries = registriesFromWorkflow(readFileSync(WORKFLOW, 'utf8'));
  const src = readFileSync(path.resolve(HERE, '../scripts/create-article.mjs'), 'utf8');

  const expected = new Set();
  for (const section of Object.values(ARTICLE_SECTION_CORE)) {
    expected.add(corpusPath(section.registryFile));
    expected.add(corpusPath(section.slugDataFile));
    for (const loc of ['it', 'en', 'de', 'fr']) {
      expected.add(corpusPath(`services/locales/${section.metaPrefix}-${loc}.ts`));
    }
  }
  // Le due sezioni storiche hanno ancora letterali nel generatore; le
  // cantonali arrivano da cantonSectionConfigs(). Il contratto completo e'
  // quindi la stessa tabella di superfici che il rebase passa al generatore,
  // non una regex che perde le sezioni generate dal profilo.
  assert.match(src, /\.\.\.cantonSectionConfigs\(\)/,
    'create-article.mjs deve derivare le configurazioni cantonali dal profilo');
  const seoFiles = Object.values(SECTION_SURFACES).map(({ seoWriteFile }) => corpusPath(seoWriteFile));
  assert.equal(seoFiles.length, Object.keys(ARTICLE_SECTION_CORE).length,
    `atteso un seoFile per sezione in create-article.mjs, trovati: ${JSON.stringify(seoFiles)}`);
  for (const f of seoFiles) expected.add(f);

  const unionFile = /'(packages\/articles\/content\/blogArticleIds\.ts)'/.exec(src);
  assert.ok(unionFile, 'create-article.mjs non nomina piu\' blogArticleIds.ts: aggiornare questo test');
  expected.add(corpusPath(unionFile[1]));

  for (const p of expected) {
    assert.ok(
      registries.includes(p),
      `${p} e' un target di scrittura del generatore ma non e' dichiarato con --merge-registry in `
      + `generate-article.yml. Fuori da quella lista un conflitto li' abortisce il rebase, e dopo 5 `
      + `tentativi l'articolo generato viene PERSO (issue #255/#281/#285). Dichiarati: ${JSON.stringify(registries)}`,
    );
  }

  // Entrambe le famiglie, per nome: e' la meta' del contratto che #281 e #285
  // hanno pagato, e vederla sparire deve essere una modifica visibile in review.
  for (const p of ['content/blog-articles-data.ts', 'content/swiss-articles-data.ts',
    'content/routerBlogData.ts', 'content/routerSwissData.ts',
    'content/blog-meta-ch-it.ts', 'content/seo/seo-blog-ch.ts']) {
    assert.ok(registries.includes(p), `${p} deve restare fra i registri dichiarati`);
  }

  // I path di bookkeeping NON devono essere finiti fra i registri, e viceversa:
  // per una cache il merge per-record non ha senso, per un registro «prendi
  // upstream» cancella l'articolo appena generato.
  const bookkeeping = allowlistFromWorkflow(readFileSync(WORKFLOW, 'utf8'));
  for (const p of bookkeeping) assert.ok(!registries.includes(p), `${p} non puo' stare in tutte e due le categorie`);
});

test('i registri VERI del corpus passano l\'analizzatore del resolver', () => {
  // L'analizzatore decide se un merge si puo' scrivere. Se sbagliasse a leggere
  // i file reali — una graffa dentro una stringa, un apostrofo escapato, un
  // template literal in seo-blog-ch.ts — direbbe «corrotto» su un merge sano e
  // butterebbe via l'articolo. Qui gli si danno i file veri, in blocco.
  const registries = registriesFromWorkflow(readFileSync(WORKFLOW, 'utf8'));
  const ROOT = path.resolve(HERE, '../..');
  const present = registries.filter((r) => existsSync(path.join(ROOT, r)));
  assert.ok(present.length >= 10, `attesi almeno 10 registri reali da analizzare, trovati ${present.length}`);

  const res = execFileSync('node', [RESOLVER, '--check', ...present], {
    cwd: ROOT, env: GIT_ENV, encoding: 'utf8',
  });
  assert.equal(res.split('\n').filter((l) => l.startsWith('ok: ')).length, present.length, res);
});

test('la collisione sullo STESSO slug (#281) sopravvive: registri fusi, file per-articolo dal commit rigiocato', () => {
  // La forma esatta della run 31705820503. Due run hanno generato lo STESSO
  // slug, quindi oltre agli otto registri hanno conflitto in add/add i quattro
  // corpi per-locale e il sidecar. Dichiarare solo i registri non basta: la
  // classificazione fallisce sul primo corpo e l'helper aborta lo stesso — #281
  // sarebbe rimasta aperta con la fix installata.
  const slug = 'modifica-ordinanza-liquidita';
  const w = makeWorld();
  try {
    const files = (ids, side) => [
      [SWISS_REGISTRY, swissRegistry(ids)],
      ['content/routerSwissData.ts', slugMap('SWISS_SLUGS', ids)],
      ...['it', 'en', 'de', 'fr'].map((loc) => [`content/blog-meta-ch-${loc}.ts`, metaFile(`blogMetaCh${loc}`, ids)]),
      ['content/seo/seo-blog-ch.ts', seoFile('BLOG_CH_SEO_METADATA', 'articoli-svizzera', ids)],
      // I file PER-ARTICOLO: esistono solo dopo che lo slug e' stato generato,
      // quindi fra i due run sono add/add, con contenuto diverso perche' le due
      // generazioni sono indipendenti.
      ...(ids.includes(slug)
        ? [
          ...['it', 'en', 'de', 'fr'].map((loc) => [`content/blog-body-ch/${loc}/${slug}.ts`,
            `export const body = 'testo ${loc} scritto dal run ${side}';\n`]),
          [`data/swiss-articles/${slug}.json`, `{"id":"${slug}","run":"${side}"}\n`],
          [`public/images/blog/${slug}.webp`, `RIFF-fake-${side}\n`],
          [`content/image-credits/blog/${slug}.json`, `{"cover":"/images/blog/${slug}.webp","run":"${side}"}\n`],
        ]
        : []),
    ];

    for (const [rel, contents] of files(['svizzera-base'], 'base')) write(w.work, rel, contents);
    commitAll(w.work, 'seed');
    git(w.work, 'push', '-q', w.upstream, 'HEAD:main');

    landUpstream(w, files(['svizzera-base', slug], 'upstream').map(([r, c]) => [r, c, `upstream ${r}`]));

    for (const [rel, contents] of files(['svizzera-base', slug], 'mine')) write(w.work, rel, contents);
    commitAll(w.work, 'Generate blog article (svizzera)');

    const { code, out } = runHelper(w.work, w.upstream, ...helperArgsFromWorkflow());
    assert.equal(code, 0, `la collisione di slug deve risolversi, non abortire. Output:\n${out}`);

    git(w.work, 'push', '-q', w.upstream, 'HEAD:main');

    // Il registro tiene l'id UNA volta sola, non due.
    const registry = git(w.work, 'show', `HEAD:${SWISS_REGISTRY}`);
    assert.equal((registry.match(new RegExp(`id: '${slug}'`, 'g')) || []).length, 1,
      `l'id in collisione deve comparire una volta sola nel registro:\n${registry}`);
    assert.match(registry, /svizzera-base/, 'il record preesistente non si tocca');
    assert.deepEqual(findDuplicates(registry), []);

    // E i corpi devono essere quelli del commit rigiocato — lo STESSO lato che
    // vince nel registro. Mischiare i due lati pubblicherebbe i nostri metadati
    // sopra il loro testo.
    for (const loc of ['it', 'en', 'de', 'fr']) {
      assert.match(git(w.work, 'show', `HEAD:content/blog-body-ch/${loc}/${slug}.ts`), /run mine/,
        `il corpo ${loc} deve venire dal commit rigiocato, come il record del registro`);
    }
    assert.match(git(w.work, 'show', `HEAD:data/swiss-articles/${slug}.json`), /"run":"mine"/);
    // P14: il credito descrive QUEL file webp, quindi viene dallo stesso lato.
    assert.match(git(w.work, 'show', `HEAD:content/image-credits/blog/${slug}.json`), /"run":"mine"/,
      'il credito della copertina deve venire dal commit rigiocato, come la sua immagine');
  } finally {
    w.cleanup();
  }
});

test('i prefissi --take-theirs coprono i target per-articolo di ENTRAMBE le sezioni', () => {
  // Stessa forma della guardia sui registri: l'elenco atteso si deriva da
  // ARTICLE_SECTION_CORE, non si ricopia. Una sezione nuova (o un bodyDir
  // rinominato) fa rosso qui invece di far morire una run che ha gia' pagato
  // LLM, traduzioni e immagine.
  const { takeTheirs } = parseHelperArgs(readFileSync(WORKFLOW, 'utf8'));
  assert.ok(takeTheirs.length >= 4, `attesi almeno 4 prefissi per-articolo, trovati: ${JSON.stringify(takeTheirs)}`);

  const expected = new Set();
  for (const section of Object.values(ARTICLE_SECTION_CORE)) {
    expected.add(`${corpusPath(`services/locales/${section.bodyDir}`)}/`);
  }
  const src = readFileSync(path.resolve(HERE, '../scripts/create-article.mjs'), 'utf8');
  const sidecars = Object.values(SECTION_SURFACES).map(({ sidecarDir }) => `${corpusPath(sidecarDir)}/`);
  assert.equal(sidecars.length, Object.keys(ARTICLE_SECTION_CORE).length,
    `atteso un sidecarDir per sezione in create-article.mjs, trovati: ${JSON.stringify(sidecars)}`);
  for (const s of sidecars) expected.add(s);
  // P14: il credito di una copertina Commons e' un file per articolo
  // (`<slug>.json`) che il generatore scrive accanto all'hero; la cartella e'
  // la costante di chi lo scrive, non un letterale ricopiato.
  expected.add(`${IMAGE_CREDIT_RECORDS_DIR}/`);

  for (const prefix of expected) {
    assert.ok(
      takeTheirs.some((declared) => prefix.startsWith(declared)),
      `${prefix} e' scritto per articolo dal generatore ma nessun --take-theirs lo copre in `
      + `generate-article.yml. Fuori da quella lista un add/add fra due run che generano lo STESSO `
      + `slug abortisce il rebase e l'articolo viene perso (issue #281, run 31705820503). `
      + `Dichiarati: ${JSON.stringify(takeTheirs)}`,
    );
  }
});

test('un conflitto di solo bookkeeping resta risolto anche con le altre categorie dichiarate', () => {
  // Le quattro categorie convivono nella STESSA invocazione, e il caso piu' comune
  // (#76, #225) e' un conflitto di sola cache mentre registri e prefissi
  // per-articolo sono dichiarati ma non toccati. E' l'unica combinazione che i
  // test sopra non attraversano — quelli sul bookkeeping passano la sola
  // allowlist, quelli sui registri non hanno cache in conflitto — e una
  // regressione qui riaprirebbe #76 lasciando verdi tutti gli altri.
  const w = makeWorld();
  try {
    landUpstream(w, [[BOOKKEEPING, '{"other":true}\n', 'concurrent run rewrites the cache']]);

    write(w.work, BOOKKEEPING, '{"mine":true}\n');
    write(w.work, 'content/blog-body/it/nuovo-articolo.ts', 'export const x = 1\n');
    commitAll(w.work, 'Generate blog article (frontaliere)');

    const { code, out } = runHelper(w.work, w.upstream, ...helperArgsFromWorkflow());
    assert.equal(code, 0, `il ramo bookkeeping deve continuare a funzionare con tutte le categorie attive:\n${out}`);
    assert.match(out, /resolved bookkeeping conflict by taking upstream/);

    git(w.work, 'push', '-q', w.upstream, 'HEAD:main');
    assert.ok(existsSync(path.join(w.work, 'content/blog-body/it/nuovo-articolo.ts')));
    assert.match(git(w.work, 'show', `HEAD:${BOOKKEEPING}`), /other/);
  } finally {
    w.cleanup();
  }
});

// ════════════════════════════════════════════════════════════════════════════
// I CONTATORI — `--merge-counter <path>:<campo>` (D18)
// ════════════════════════════════════════════════════════════════════════════
//
// «Prendi upstream» perde l'incremento di questo run, «prendi il commit
// rigiocato» perde quelli atterrati upstream nel frattempo. L'assert e' sul
// VALORE: base 10, upstream 12 (due run altrui), questo run 11 → 13.

/** Un mondo con i contatori nella base comune, come sono committati davvero. */
function counterWorld({ experimental = 10, evergreen = 10, runCounter = 10 } = {}) {
  const w = makeWorld();
  write(w.work, EXPERIMENTAL_COUNTER_PATH, `${JSON.stringify({ count: experimental }, null, 2)}\n`);
  write(w.work, EVERGREEN_COUNTER_PATH, `${JSON.stringify({ count: evergreen }, null, 2)}\n`);
  write(w.work, QUOTA_STATE_PATH, `${JSON.stringify({
    version: 1, runCounter, currentQuota: 80, lastTune: null, history: [],
  }, null, 2)}\n`);
  commitAll(w.work, 'seed counters');
  git(w.work, 'push', '-q', w.upstream, 'HEAD:main');
  return w;
}

const countOf = (w, rel, field = 'count') => JSON.parse(git(w.work, 'show', `HEAD:${rel}`))[field];

test('un conflitto sui contatori somma gli incrementi dei due lati, e l\'articolo sopravvive', () => {
  const w = counterWorld();
  try {
    // Due run altrui atterrati upstream: +2 su ciascun contatore, e il tuning
    // ha cambiato currentQuota (un campo che create-article non scrive).
    landUpstream(w, [
      [EXPERIMENTAL_COUNTER_PATH, `${JSON.stringify({ count: 12 }, null, 2)}\n`, 'u exp'],
      [EVERGREEN_COUNTER_PATH, `${JSON.stringify({ count: 12 }, null, 2)}\n`, 'u ever'],
      [QUOTA_STATE_PATH, `${JSON.stringify({
        version: 1, runCounter: 12, currentQuota: 70, lastTune: '2026-10-05', history: [],
      }, null, 2)}\n`, 'u quota'],
    ]);

    write(w.work, EXPERIMENTAL_COUNTER_PATH, `${JSON.stringify({ count: 11 }, null, 2)}\n`);
    write(w.work, EVERGREEN_COUNTER_PATH, `${JSON.stringify({ count: 11 }, null, 2)}\n`);
    write(w.work, QUOTA_STATE_PATH, `${JSON.stringify({
      version: 1, runCounter: 11, currentQuota: 80, lastTune: null, history: [],
    }, null, 2)}\n`);
    write(w.work, 'content/blog-body/it/articolo-contato.ts', 'export const c = 1\n');
    commitAll(w.work, 'Generate blog article (frontaliere)');

    const { code, out } = runHelper(w.work, w.upstream, ...helperArgsFromWorkflow());
    assert.equal(code, 0, `un conflitto di soli contatori deve risolversi, non abortire:\n${out}`);
    assert.match(out, /resolved counter conflict by summing both sides/);

    git(w.work, 'push', '-q', w.upstream, 'HEAD:main');
    assert.ok(existsSync(path.join(w.work, 'content/blog-body/it/articolo-contato.ts')));
    assert.equal(countOf(w, EXPERIMENTAL_COUNTER_PATH), 13, 'upstream 12 + (11 − 10)');
    assert.equal(countOf(w, EVERGREEN_COUNTER_PATH), 13, 'upstream 12 + (11 − 10)');
    const quota = JSON.parse(git(w.work, 'show', `HEAD:${QUOTA_STATE_PATH}`));
    assert.equal(quota.runCounter, 13, 'upstream 12 + (11 − 10)');
    assert.equal(quota.currentQuota, 70, 'gli altri campi restano quelli di upstream');
    assert.equal(quota.lastTune, '2026-10-05');
  } finally {
    w.cleanup();
  }
});

test('due run che scrivono lo STESSO valore (nessun conflitto) non perdono un incremento', () => {
  // Base 10, upstream 11, questo run 11: blob identici, git non vede conflitto
  // e il rebase finirebbe su 11. La riconciliazione a rebase riuscito porta 12.
  const w = counterWorld();
  try {
    landUpstream(w, [[EVERGREEN_COUNTER_PATH, `${JSON.stringify({ count: 11 }, null, 2)}\n`, 'u ever']]);
    write(w.work, EVERGREEN_COUNTER_PATH, `${JSON.stringify({ count: 11 }, null, 2)}\n`);
    write(w.work, 'content/blog-body/it/articolo-parallelo.ts', 'export const p = 1\n');
    commitAll(w.work, 'Generate blog article (frontaliere)');

    const { code, out } = runHelper(w.work, w.upstream, ...helperArgsFromWorkflow());
    assert.equal(code, 0, out);
    assert.match(out, /reconciled counters after the rebase/);
    git(w.work, 'push', '-q', w.upstream, 'HEAD:main');
    assert.equal(countOf(w, EVERGREEN_COUNTER_PATH), 12, 'upstream 11 + (11 − 10)');
    assert.ok(existsSync(path.join(w.work, 'content/blog-body/it/articolo-parallelo.ts')));
    assert.equal(git(w.work, 'log', '--format=%s', '-1').trim(), 'Generate blog article (frontaliere)',
      'la riconciliazione si aggiunge al commit dell\'articolo, non ne crea un altro');
    assert.equal(git(w.work, 'status', '--porcelain').trim(), '', 'nessun residuo nel working tree');
  } finally {
    w.cleanup();
  }
});

test('un rebase senza contatori toccati da upstream lascia i contatori come sono', () => {
  const w = counterWorld();
  try {
    landUpstream(w, [['README.md', 'altro\n', 'upstream unrelated']]);
    write(w.work, EVERGREEN_COUNTER_PATH, `${JSON.stringify({ count: 11 }, null, 2)}\n`);
    commitAll(w.work, 'Generate blog article (frontaliere)');
    const { code, out } = runHelper(w.work, w.upstream, ...helperArgsFromWorkflow());
    assert.equal(code, 0, out);
    assert.doesNotMatch(out, /reconciled counters/);
    assert.equal(countOf(w, EVERGREEN_COUNTER_PATH), 11);
  } finally {
    w.cleanup();
  }
});

test('un contatore che non si sa fondere ricade su «prendi upstream», non aborta', () => {
  // Il ripiego e' il comportamento che quota-state.json aveva prima del ramo:
  // un contatore sbagliato di uno costa meno di un articolo perso.
  const w = counterWorld();
  try {
    landUpstream(w, [[EVERGREEN_COUNTER_PATH, `${JSON.stringify({ count: 12 }, null, 2)}\n`, 'u ever']]);
    write(w.work, EVERGREEN_COUNTER_PATH, '{"count": "rotto"}\n');
    write(w.work, 'content/blog-body/it/articolo-ripiego.ts', 'export const r = 1\n');
    commitAll(w.work, 'Generate blog article (frontaliere)');

    const { code, out } = runHelper(w.work, w.upstream, ...helperArgsFromWorkflow());
    assert.equal(code, 0, `il ripiego deve risolvere:\n${out}`);
    assert.match(out, /counter merge refused on 'data\/topic-candidates-evergreen-counter\.json'/);
    git(w.work, 'push', '-q', w.upstream, 'HEAD:main');
    assert.ok(existsSync(path.join(w.work, 'content/blog-body/it/articolo-ripiego.ts')));
    assert.equal(countOf(w, EVERGREEN_COUNTER_PATH), 12, 'ripiego = copia upstream');
  } finally {
    w.cleanup();
  }
});

test('--merge-counter senza campo e\' un errore del chiamante', () => {
  const w = makeWorld();
  try {
    const { code, out } = runHelper(w.work, w.upstream, '--merge-counter', EVERGREEN_COUNTER_PATH);
    assert.equal(code, 2, out);
    assert.match(out, /--merge-counter requires <path>:<field>/);
  } finally {
    w.cleanup();
  }
});
