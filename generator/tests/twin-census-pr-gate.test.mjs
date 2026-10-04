/**
 * twin-census-pr-gate.test.mjs — il censimento dei gemelli sui file AGGIUNTI
 * dalla PR (issue 1610).
 *
 * Il censimento di rete gira solo sullo schedule: le PR 2096 e 2097 hanno
 * aggiunto due file byte-identici a file del sito senza dichiararli, sono
 * passate verdi, e il rosso e' comparso su `main` alla run 37205308197. Qui si
 * esercitano il verdetto puro, la lettura dei file aggiunti su un repository
 * git vero (cartella temporanea, niente rete) e la lettura dell'albero del sito
 * con un `fetch` finto.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  addedFiles,
  coveredByManifest,
  siteBlobShas,
  twinCensusVerdict,
} from '../../scripts/ci/twin-census-pr-gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/ci/loop-sync-manifest.json'), 'utf8'));

/** Lo sha del blob git di un contenuto: lo stesso nei due repo se i byte sono uguali. */
const blobSha = (body) =>
  execFileSync('git', ['hash-object', '--stdin'], { input: body, encoding: 'utf8' }).trim();

// ── 1. Il residuo della run 37205308197, sul manifest vero ────────────────

test('IL CASO: i due gemelli della run 37205308197 sono dichiarati nel manifest', () => {
  // Gli sha veri dei due file sono quelli che il sito ha nel proprio albero:
  // il fixture e' una copia di tests/fixtures/followup-mint/ del sito, e il
  // registro vuoto `{}` collide con ogni altro `{}` del sito.
  const twins = [
    'data/evergreen-verifications.json',
    'generator/tests/fixtures/followup-mint/closed-bullets-10258-10289.json',
  ].map((rel) => {
    // Dall'albero di HEAD, non dal disco: in un worktree sparse `data/` puo'
    // non essere materializzata, e lo sha del blob e' gia' nel tree.
    const sha = execFileSync('git', ['ls-tree', 'HEAD', '--', rel], { cwd: ROOT, encoding: 'utf8' }).split(/\s+/)[2];
    assert.ok(sha, `${rel} non e' nell'albero di HEAD`);
    return { path: rel, sha };
  });
  const v = twinCensusVerdict({ added: twins, siteShas: new Set(twins.map((t) => t.sha)), manifest: MANIFEST });
  assert.deepEqual(v.undeclared, [], `gemelli ancora fuori dal manifest:\n  ${v.undeclared.join('\n  ')}`);
});

test('il fixture e\' un `identical` col sitePath del sito, non un fuori scope', () => {
  // Un fixture copiato dal sito e consumato da due test qui e' un gemello
  // vero: se il sito lo corregge, la correzione deve scendere (trasporto).
  const entry = MANIFEST.files.find(
    (f) => f.path === 'generator/tests/fixtures/followup-mint/closed-bullets-10258-10289.json',
  );
  assert.ok(entry, 'voce mancante');
  assert.equal(entry.mode, 'identical');
  assert.equal(entry.sitePath, 'tests/fixtures/followup-mint/closed-bullets-10258-10289.json');
});

// ── 2. Il verdetto puro ───────────────────────────────────────────────────

const manifest = {
  files: [{ path: 'registered.json' }],
  scope: { roots: [{ path: 'scripts/ci' }], outOfScope: [{ prefix: 'content/' }] },
};

test('un file aggiunto byte-identico al sito e fuori dal manifest e\' rosso', () => {
  const v = twinCensusVerdict({
    added: [{ path: 'data/new.json', sha: 'aaa' }],
    siteShas: new Set(['aaa']),
    manifest,
  });
  assert.deepEqual(v.undeclared, ['data/new.json']);
});

test('registrato, sotto un root o fuori scope: coperto, nessuna rete chiesta', () => {
  const v = twinCensusVerdict({
    added: [
      { path: 'registered.json', sha: 'aaa' },
      { path: 'scripts/ci/new.mjs', sha: 'bbb' },
      { path: 'content/blog/x.json', sha: 'ccc' },
    ],
    siteShas: null,
    manifest,
  });
  assert.equal(v.needsSite, false, 'tutti coperti: il sito non va letto');
  assert.deepEqual(v.candidates, []);
});

test('un file aggiunto fuori dal manifest ma senza gemello sul sito passa', () => {
  const pre = twinCensusVerdict({ added: [{ path: 'data/new.json', sha: 'aaa' }], siteShas: null, manifest });
  assert.equal(pre.needsSite, true);
  const v = twinCensusVerdict({ added: [{ path: 'data/new.json', sha: 'aaa' }], siteShas: new Set(['zzz']), manifest });
  assert.deepEqual(v.undeclared, []);
});

test('`outOfScope` e\' un prefisso, `roots` un albero: un fratello omonimo non e\' coperto', () => {
  const covered = coveredByManifest(manifest);
  assert.equal(covered('scripts/ci/x.mjs'), true);
  assert.equal(covered('scripts/cix/x.mjs'), false, 'il root vale per l\'albero, non per il prefisso testuale');
  assert.equal(covered('content/x'), true);
});

// ── 3. I file aggiunti, su un repository vero ─────────────────────────────

let dir;
const git = (...args) =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });
const write = (rel, body) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body);
};

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twin-census-pr-'));
  git('init', '-q', '-b', 'main');
  write('kept.json', '{"kept":1}\n');
  write('moved-from.json', '{"moved":1}\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'pr');
  write('kept.json', '{"kept":2}\n');
  write('fixtures/twin.json', '{"twin":true}\n');
  git('mv', 'moved-from.json', 'moved-to.json');
  git('add', '-A');
  git('commit', '-q', '-m', 'pr');
});

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('addedFiles: solo i path nuovi (rinomini inclusi), con lo sha del blob di HEAD', () => {
  const added = addedFiles({ base: 'main', head: 'pr', cwd: dir });
  assert.deepEqual(
    added.map((e) => e.path).sort(),
    ['fixtures/twin.json', 'moved-to.json'],
    'un file modificato non e\' aggiunto; un rinominato e\' un path nuovo per il manifest',
  );
  assert.equal(added.find((e) => e.path === 'fixtures/twin.json').sha, blobSha('{"twin":true}\n'));
});

test('addedFiles: su main stesso non c\'e\' niente di aggiunto', () => {
  assert.deepEqual(addedFiles({ base: 'main', head: 'main', cwd: dir }), []);
});

// ── 4. L'albero del sito: fail-closed ─────────────────────────────────────

const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const noSleep = async () => {};

test('siteBlobShas: l\'albero intero da\' gli sha dei soli blob', async () => {
  const shas = await siteBlobShas({
    repo: 'o/r',
    ref: 'HEAD',
    fetchImpl: async () => response(200, { truncated: false, tree: [{ type: 'blob', sha: 'a' }, { type: 'tree', sha: 't' }] }),
    sleep: noSleep,
  });
  assert.deepEqual([...shas], ['a']);
});

test('siteBlobShas: un albero troncato non e\' un «nessun gemello»', async () => {
  await assert.rejects(
    siteBlobShas({ repo: 'o/r', ref: 'HEAD', fetchImpl: async () => response(200, { truncated: true, tree: [] }), sleep: noSleep }),
    /troncato/,
  );
});

test('siteBlobShas: ritenta 5xx ed errori di rete, non i 4xx', async () => {
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) throw new Error('ECONNRESET');
    if (calls === 2) return response(502, {});
    return response(200, { truncated: false, tree: [{ type: 'blob', sha: 'b' }] });
  };
  assert.deepEqual([...(await siteBlobShas({ repo: 'o/r', ref: 'HEAD', fetchImpl: flaky, sleep: noSleep }))], ['b']);
  assert.equal(calls, 3);

  let notFound = 0;
  await assert.rejects(
    siteBlobShas({ repo: 'o/r', ref: 'HEAD', fetchImpl: async () => { notFound += 1; return response(404, {}); }, sleep: noSleep }),
    /HTTP 404/,
  );
  assert.equal(notFound, 1);
});
