/**
 * loop-manifest-baseline-squash.test.mjs — sulla PR la verifica delle
 * `baseline.corpus` deve vedere la storia che lo SQUASH portera' su `main`,
 * non quella del branch (issue 1610).
 *
 * ## Il caso
 *
 * La PR 2090 ha attestato la baseline di `scripts/ci/reconcile-conflict-handoffs.mjs`
 * sul blob di un commit intermedio (`d691fc86f`), poi un commit successivo
 * della stessa PR (`a0f76bdb8`) ha cambiato di nuovo il file. Sulla PR il
 * verificatore leggeva `rev-list HEAD origin/main`, cioe' anche i commit
 * intermedi del branch: il blob c'era e il passo era verde. Lo squash ha
 * scartato quel blob, e su `main` la stessa baseline e' diventata una
 * `ghost-baseline` (run 37205308197) — rossa dopo il merge, quando nessuno
 * guarda piu' la PR.
 *
 * La storia che conta e' quella che `main` avra' DOPO lo squash: la storia di
 * `origin/main` piu' l'albero finale di HEAD. Un blob che esiste solo in un
 * commit intermedio del branch non sopravvive al merge, quindi non attesta
 * niente.
 *
 * Il test costruisce un repository git vero in una cartella temporanea:
 * `origin/main` e' un ref locale `refs/remotes/origin/main`, niente rete.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  baselineHistoryVerdict,
  blobsByPathFromHistory,
  blobsFollowingRenames,
} from '../../scripts/ci/verify-manifest-baseline-history.mjs';
import { sha256 } from '../../scripts/ci/loop-drift-check.mjs';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

let dir;
const git = (...args) =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: dir,
    env: ENV,
    encoding: 'utf8',
  });
const write = (rel, body) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body);
};
const commit = (msg) => {
  git('add', '-A');
  git('commit', '-q', '-m', msg);
};

const V = {
  main: 'export const v = "main";\n',
  intermediate: 'export const v = "intermedio";\n',
  final: 'export const v = "finale";\n',
  renamedMain: 'export const r = "main";\n',
  renamedIntermediate: 'export const r = "intermedio";\n',
  renamedFinal: 'export const r = "finale";\n',
};
const h = (body) => sha256(Buffer.from(body));

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-squash-'));
  git('init', '-q', '-b', 'main');
  write('a.mjs', V.main);
  write('old-name.mjs', V.renamedMain);
  commit('main');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');

  git('checkout', '-q', '-b', 'pr');
  // Rinomina pura in un commit a se': e' la forma che `--follow` riconosce.
  git('mv', 'old-name.mjs', 'new-name.mjs');
  commit('pr: rinomina');
  write('a.mjs', V.intermediate);
  write('new-name.mjs', V.renamedIntermediate);
  commit('pr: intermedio');
  write('a.mjs', V.final);
  write('new-name.mjs', V.renamedFinal);
  commit('pr: finale');
});

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('IL CASO: un blob vissuto solo in un commit intermedio del branch non attesta la baseline', () => {
  const blobs = blobsByPathFromHistory(['a.mjs'], { cwd: dir, partialClone: false });
  const seen = blobs.get('a.mjs');
  assert.ok(seen, 'nessuna revisione letta per a.mjs');
  assert.equal(seen.has(h(V.intermediate)), false,
    'il blob del commit intermedio sparisce con lo squash: sulla PR non puo\' rendere verde la baseline');

  const verdict = baselineHistoryVerdict({
    files: [{ path: 'a.mjs', mode: 'identical', baseline: { site: 'x', corpus: h(V.intermediate) } }],
    blobsByPath: blobs,
  });
  assert.equal(verdict.ok, false, 'la stessa baseline su main e\' una ghost-baseline: deve esserlo gia\' sulla PR');
});

test('restano valide la storia di origin/main e l\'albero finale di HEAD', () => {
  const seen = blobsByPathFromHistory(['a.mjs'], { cwd: dir, partialClone: false }).get('a.mjs');
  assert.equal(seen.has(h(V.main)), true, 'una revisione gia\' su main resta attestabile');
  assert.equal(seen.has(h(V.final)), true, 'il contenuto finale della PR e\' cio\' che lo squash porta su main');
});

test('la passata sui rinomini scarta anche lei i commit intermedi del branch', () => {
  const extra = blobsFollowingRenames('new-name.mjs', { cwd: dir, partialClone: false });
  assert.ok(extra, 'lettura inconclusiva inattesa');
  assert.equal(extra.has(h(V.renamedMain)), true, 'il blob su main sotto il nome vecchio resta raggiungibile');
  assert.equal(extra.has(h(V.renamedIntermediate)), false,
    'il blob del commit intermedio sotto il nome nuovo non sopravvive allo squash');
});

test('su main (HEAD == origin/main) la storia letta e\' la stessa di prima', () => {
  git('checkout', '-q', 'main');
  try {
    const seen = blobsByPathFromHistory(['a.mjs'], { cwd: dir, partialClone: false }).get('a.mjs');
    assert.deepEqual([...seen], [h(V.main)]);
  } finally {
    git('checkout', '-q', 'pr');
  }
});
