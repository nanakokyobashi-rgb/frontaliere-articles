import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { identicalPaths, partitionPaths } from '../../scripts/ci/lib/identical-paths.mjs';
import { routeIdenticalFindings } from '../../scripts/ci/lib/identical-review-routing.mjs';
import { installIdenticalCommitHook, IDENTICAL_COMMIT_MESSAGE } from '../../scripts/ci/fixer-identical-hook.mjs';
import { restoreIdenticalPaths } from '../../scripts/ci/restore-identical-paths.mjs';
import { registeredTransportHashes } from '../../scripts/ci/transport-identical-twins-guard.mjs';
import { transportPrDisposition } from '../../scripts/ci/transport-identical-twins.mjs';
import { isIdenticalTwinTransportPr, TRANSPORT_EXCEPTION_PHRASE } from '../../scripts/ci/lib/transport-pr.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function fixtureManifest() {
  return {
    files: [
      { path: 'same.mjs', mode: 'identical', sitePath: 'packages/same.mjs' },
      { path: 'adapted.mjs', mode: 'adapted' },
    ],
  };
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-identical-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'same.mjs'), 'same base\n');
  fs.writeFileSync(path.join(dir, 'adapted.mjs'), 'adapted base\n');
  fs.writeFileSync(path.join(dir, 'outside.mjs'), 'outside base\n');
  git(dir, 'add', '--', 'same.mjs', 'adapted.mjs', 'outside.mjs');
  git(dir, 'commit', '-qm', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  return { dir, base };
}

test('il modulo puro legge il manifest reale e separa identical da adapted/fuori manifest', () => {
  const manifest = JSON.parse(read('scripts/ci/loop-sync-manifest.json'));
  const locked = identicalPaths(manifest);
  assert.ok(locked.size > 0);
  const adapted = manifest.files.find((entry) => entry.mode === 'adapted');
  assert.ok(adapted);
  const parts = partitionPaths(manifest, [
    [...locked][0],
    adapted.path,
    'path/not-in-manifest.mjs',
  ]);
  assert.deepEqual(parts.readOnly, [[...locked][0]]);
  assert.deepEqual(parts.writable, [adapted.path, 'path/not-in-manifest.mjs']);
});

test('il ripristino tocca solo identical, crea un commit e lascia il resto del giro', () => {
  const { dir, base } = makeRepo();
  try {
    fs.writeFileSync(path.join(dir, 'same.mjs'), 'same changed\n');
    fs.writeFileSync(path.join(dir, 'adapted.mjs'), 'adapted changed\n');
    fs.writeFileSync(path.join(dir, 'outside.mjs'), 'outside changed\n');
    git(dir, 'add', '--', 'same.mjs', 'adapted.mjs', 'outside.mjs');
    git(dir, 'commit', '-qm', 'round');
    fs.writeFileSync(path.join(dir, 'outside.mjs'), 'outside staged after round\n');
    git(dir, 'add', 'outside.mjs');
    const result = restoreIdenticalPaths({ cwd: dir, baseRef: base, manifest: fixtureManifest() });
    assert.deepEqual(result.restored, ['same.mjs']);
    assert.equal(fs.readFileSync(path.join(dir, 'same.mjs'), 'utf8'), 'same base\n');
    assert.equal(fs.readFileSync(path.join(dir, 'adapted.mjs'), 'utf8'), 'adapted changed\n');
    assert.equal(fs.readFileSync(path.join(dir, 'outside.mjs'), 'utf8'), 'outside staged after round\n');
    assert.ok(result.commitSha);
    assert.match(result.comment, /same\.mjs/);
    assert.deepEqual(git(dir, 'diff', '--cached', '--name-only').split('\n'), ['outside.mjs']);
    git(dir, 'reset', '-q');
    git(dir, 'restore', '--', 'outside.mjs');
    assert.equal(git(dir, 'status', '--porcelain'), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("l'hook rifiuta un commit identical e accetta gli altri path", () => {
  const { dir } = makeRepo();
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(fixtureManifest()));
  try {
    installIdenticalCommitHook({
      cwd: dir,
      manifestPath,
      scriptPath: path.join(ROOT, 'scripts/ci/fixer-identical-hook.mjs'),
    });
    fs.writeFileSync(path.join(dir, 'same.mjs'), 'blocked\n');
    git(dir, 'add', 'same.mjs');
    const rejected = spawnSync('git', ['-C', dir, 'commit', '-m', 'blocked'], { encoding: 'utf8' });
    assert.notEqual(rejected.status, 0);
    assert.match(`${rejected.stdout}\n${rejected.stderr}`, new RegExp(IDENTICAL_COMMIT_MESSAGE));
    git(dir, 'reset', '-q');
    fs.writeFileSync(path.join(dir, 'outside.mjs'), 'accepted\n');
    git(dir, 'add', 'outside.mjs');
    assert.doesNotThrow(() => git(dir, 'commit', '-qm', 'accepted'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('il routing usa un titolo stabile/deduplicante e segnala il salto all-identical', async () => {
  const manifest = fixtureManifest();
  const issueByTitle = new Map();
  const comments = new Set();
  const commentBodies = [];
  const createIssue = async (input) => {
    if (!issueByTitle.has(input.title)) issueByTitle.set(input.title, { persisted: true, number: 77, url: 'https://github.com/site/issues/77' });
    return issueByTitle.get(input.title);
  };
  const commentPr = async (body, { marker }) => {
    if (comments.has(marker)) return;
    comments.add(marker);
    commentBodies.push(body);
  };
  const finding = { stableId: 'finding-1', text: '`same.mjs:1`: 🔴 Important: difetto', resolvedFiles: ['same.mjs'] };
  const first = await routeIdenticalFindings({
    findings: [finding], manifest, repo: 'corpus/repo', pr: 12,
    prUrl: 'https://github.com/corpus/repo/pull/12', createIssue, commentPr,
  });
  const second = await routeIdenticalFindings({
    findings: [finding], manifest, repo: 'corpus/repo', pr: 12,
    prUrl: 'https://github.com/corpus/repo/pull/12', createIssue, commentPr,
  });
  assert.equal(first.allIdentical, true);
  assert.equal(second.allIdentical, true);
  assert.equal(issueByTitle.size, 1);
  assert.equal(comments.size, 1);
  assert.match(commentBodies[0], /non consuma quota né round/u);
  assert.match([...issueByTitle.keys()][0], /^gemello identical: rilievi della review del corpus su packages\/same\.mjs$/);
  const mixed = await routeIdenticalFindings({
    findings: [finding, { stableId: 'finding-2', text: 'mixed', resolvedFiles: ['same.mjs', 'adapted.mjs'] }],
    manifest, repo: 'corpus/repo', pr: 12, createIssue, mutate: false,
  });
  assert.equal(mixed.allIdentical, false);
  assert.equal(mixed.routed.length, 0);

  const transport = {
    transport: true,
    transportedFiles: ['same.mjs'],
  };
  const transported = await routeIdenticalFindings({
    findings: [finding], allFindings: [finding], manifest, repo: 'corpus/repo', pr: 12,
    prUrl: 'https://github.com/corpus/repo/pull/12', createIssue, commentPr,
    transportPr: transport, headSha: 'a'.repeat(40), reviewId: 101,
  });
  assert.equal(transported.transportException, true);
  assert.ok(commentBodies.at(-1).includes(TRANSPORT_EXCEPTION_PHRASE));
  assert.match(commentBodies.at(-1), /IDENTICAL_REVIEW_ROUTING_EVIDENCE/u);
  const numberedFinding = {
    lineNumber: 42,
    text: '`same.mjs:42`: 🔴 Important: finding numerico',
    resolvedFiles: ['same.mjs'],
  };
  const numberedTransport = await routeIdenticalFindings({
    findings: [numberedFinding],
    allFindings: [numberedFinding],
    manifest,
    repo: 'corpus/repo',
    pr: 12,
    createIssue,
    commentPr,
    transportPr: transport,
    headSha: 'b'.repeat(40),
    reviewId: 102,
  });
  assert.equal(numberedTransport.transportException, true);
  assert.deepEqual(numberedTransport.allOpenFindingIds, ['42']);
  const nonIdenticalOpen = await routeIdenticalFindings({
    findings: [finding],
    allFindings: [finding, { stableId: 'finding-2', text: 'adapted', resolvedFiles: ['adapted.mjs'] }],
    manifest,
    repo: 'corpus/repo',
    pr: 12,
    createIssue,
    transportPr: transport,
  });
  assert.equal(nonIdenticalOpen.transportException, false);
  await assert.rejects(() => routeIdenticalFindings({
    findings: [finding],
    manifest,
    repo: 'corpus/repo',
    pr: 12,
    createIssue: async () => ({ persisted: false }),
    transportPr: transport,
  }), /routing identical non persistito/u);
});

test('il predicato del trasporto lega autore, branch, manifest e perimetro dei file', () => {
  const manifest = fixtureManifest();
  const pr = {
    author: { login: 'nanakokyobashi-rgb' },
    headRefName: 'transport/identical-twins-123',
    baseRefName: 'main',
    headRepository: { nameWithOwner: 'corpus/repo' },
  };
  const valid = isIdenticalTwinTransportPr({
    pr,
    repository: 'corpus/repo',
    files: ['same.mjs', 'scripts/ci/loop-sync-manifest.json'],
    filesComplete: true,
    manifest,
  });
  assert.equal(valid.transport, true);
  assert.deepEqual(valid.transportedFiles, ['same.mjs']);
  assert.equal(isIdenticalTwinTransportPr({
    pr,
    repository: 'corpus/repo',
    files: ['same.mjs', 'scripts/ci/loop-sync-manifest.json', 'adapted.mjs'],
    filesComplete: true,
    manifest,
  }).transport, false);
  assert.equal(isIdenticalTwinTransportPr({
    pr: { ...pr, author: { login: 'valerielinc-ops' } },
    repository: 'corpus/repo',
    files: ['same.mjs', 'scripts/ci/loop-sync-manifest.json'],
    filesComplete: true,
    manifest,
  }).transport, false);
  assert.equal(isIdenticalTwinTransportPr({
    pr,
    repository: 'corpus/repo',
    files: ['scripts/ci/loop-sync-manifest.json'],
    filesComplete: true,
    manifest,
  }).transport, false);
  const manifestOnlyGuard = isIdenticalTwinTransportPr({
    pr,
    repository: 'corpus/repo',
    files: ['scripts/ci/loop-sync-manifest.json'],
    filesComplete: true,
    manifest,
    allowManifestOnly: true,
  });
  assert.equal(manifestOnlyGuard.transport, true);
  assert.equal(manifestOnlyGuard.manifestOnly, true);
  assert.deepEqual(manifestOnlyGuard.transportedFiles, []);
});

test('il guard del trasporto distingue PR superata e PR ancora da attendere', () => {
  assert.deepEqual(transportPrDisposition({
    openPr: true,
    registeredHashes: { 'same.mjs': 'aaaaaaaaaaaaaaaa' },
    currentHashes: { 'same.mjs': 'bbbbbbbbbbbbbbbb' },
  }), { state: 'superseded', changed: ['same.mjs'] });
  assert.deepEqual(transportPrDisposition({
    openPr: true,
    registeredHashes: { 'same.mjs': 'aaaaaaaaaaaaaaaa' },
    currentHashes: { 'same.mjs': 'aaaaaaaaaaaaaaaa' },
  }), { state: 'wait', changed: [] });
});

test('il guard rifiuta attestazioni duplicate con hash discordanti', () => {
  assert.deepEqual(registeredTransportHashes([
    { path: 'same.mjs', siteHash: 'aaaaaaaaaaaaaaaa' },
    { path: 'same.mjs', siteHash: 'aaaaaaaaaaaaaaaa' },
  ]), { 'same.mjs': 'aaaaaaaaaaaaaaaa' });
  assert.throws(
    () => registeredTransportHashes([
      { path: 'same.mjs', siteHash: 'aaaaaaaaaaaaaaaa' },
      { path: 'same.mjs', siteHash: 'bbbbbbbbbbbbbbbb' },
    ]),
    /attestazioni in conflitto per same\.mjs/u,
  );
});

test('forma dei workflow: helper trusted, hook prima dell’agente, restore dopo agente', () => {
  const redflag = read('.github/workflows/pr-redflag-fixer.yml');
  assert.match(redflag, /needs\.scope\.outputs\.identical_only != 'true'/u);
  const redcheck = read('.github/workflows/pr-redcheck-fixer.yml');
  assert.match(redcheck, /Ripristina drift identical prima di claim e quota/u);
  assert.match(redcheck, /steps\.identical_drift\.outputs\.skip != 'true'/u);
  const issueFix = read('.github/workflows/issue-fix.yml');
  assert.match(issueFix, /handoff-to-site\.mjs/u);
  assert.match(issueFix, /identical_restore_wip/u);
  for (const file of ['pr-redflag-fixer.yml', 'pr-redcheck-fixer.yml', 'issue-fix.yml']) {
    const source = read(`.github/workflows/${file}`);
    assert.match(source, /git show "\$trusted_sha:scripts\/ci\/loop-sync-manifest\.json"/u, `${file}: manifest non materializzato da main`);
    assert.match(source, /fixer-identical-hook\.mjs/u, `${file}: hook identical assente`);
    assert.match(source, /restore-identical-paths\.mjs/u, `${file}: restore identical assente`);
    const agent = source.indexOf('uses: ./.github/actions/claude-codex-fallback');
    const hook = source.indexOf('fixer-identical-hook.mjs');
    const restore = source.lastIndexOf('name: Ripristina gemelli identical');
    assert.ok(hook > 0 && hook < agent, `${file}: hook non precede l’agente`);
    assert.ok(restore > agent, `${file}: restore non segue l’agente`);
    if (file !== 'issue-fix.yml') assert.ok(restore < source.indexOf('Classify outcome'), `${file}: restore non precede classify`);
  }
  const transport = read('.github/workflows/transport-identical-twins.yml');
  assert.match(transport, /transport-identical-twins-guard\.mjs/u);
});
