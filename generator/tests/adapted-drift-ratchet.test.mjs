/**
 * adapted-drift-ratchet.test.mjs — il gate `adapted-drift-budget` e il registro
 * dei gemelli `adapted` in drift (issue #339).
 *
 * ## Cosa protegge
 *
 * Al 2026-10-05, 77 gemelli `adapted` su 100 erano in drift senza che niente lo
 * impedisse di crescere: il report quotidiano li elencava, ma un file in piu' non
 * cambiava il colore di nessun job. Il ratchet (`scripts/ci/adapted-drift-ratchet.json`)
 * congela l'elenco: un path nuovo in drift fa fallire lo schedule di
 * `loop-drift-check.yml`, l'elenco si accorcia soltanto (job `realign-adapted`,
 * `adapted-drift-register.mjs --write-ratchet`), e in PR non si puo' allungare.
 *
 * Titolo del fallimento in produzione:
 * «adapted-3way: N gemelli adapted in drift oltre il ratchet».
 *
 * Tutto offline: funzioni pure, e repo git temporanei per il merge a 3 vie.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ADAPTED_DRIFT_RATCHET_PATH,
  adaptedTwinState,
  driftFromReport,
  parseRatchet,
  pruneRatchetFile,
  ratchetShrinkVerdict,
  ratchetVerdict,
} from '../../scripts/ci/lib/adapted-drift.mjs';
import { main as ratchetMain } from '../../scripts/ci/adapted-drift-ratchet.mjs';
import {
  buildRegister,
  compareUrl,
  findSiteBase,
  mergeConflicts,
  registerMarkdown,
  sitePrsFromSubjects,
} from '../../scripts/ci/adapted-drift-register.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const h16 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const base = { site: 'S0', corpus: 'C0' };

test('stato a tre vie dagli hash: solo site-ahead e both-moved contano come drift', () => {
  assert.equal(adaptedTwinState({ site: 'S0', corpus: 'C0', baseline: base }), 'stable');
  assert.equal(adaptedTwinState({ site: 'S1', corpus: 'C0', baseline: base }), 'site-ahead');
  assert.equal(adaptedTwinState({ site: 'S0', corpus: 'C1', baseline: base }), 'corpus-ahead');
  assert.equal(adaptedTwinState({ site: 'S1', corpus: 'C1', baseline: base }), 'both-moved');
  assert.equal(adaptedTwinState({ site: 'X', corpus: 'X', baseline: base }), 'both-moved-converged');
  assert.equal(adaptedTwinState({ site: null, corpus: 'C0', baseline: base }), 'site-missing');
  assert.equal(adaptedTwinState({ site: 'S1', corpus: 'C0', baseline: null }), 'unknown');
});

test('il report si legge dagli hash, non da `state`: section-drift e ghost-baseline nascondono il verdetto sul file', () => {
  const report = {
    results: [
      { path: 'a.mjs', mode: 'adapted', state: 'site-ahead', hashes: { site: 'S1', corpus: 'C0', baseline: base } },
      { path: 'b.mjs', mode: 'adapted', state: 'section-drift', fileState: 'both-moved', hashes: { site: 'S1', corpus: 'C1', baseline: base } },
      { path: 'c.mjs', mode: 'adapted', state: 'ghost-baseline', hashes: { site: 'S1', corpus: 'C1', baseline: base } },
      { path: 'd.mjs', mode: 'adapted', state: 'stable', hashes: { site: 'S0', corpus: 'C0', baseline: base } },
      { path: 'e.mjs', mode: 'identical', state: 'site-ahead', hashes: { site: 'S1', corpus: 'C0', baseline: base } },
      { path: 'f.mjs', mode: 'adapted', state: 'check-failed' },
    ],
  };
  assert.deepEqual(driftFromReport(report), { drift: ['a.mjs', 'b.mjs', 'c.mjs'], unknown: ['f.mjs'], adapted: 5 });
});

test('il ratchet fallisce su un path nuovo in drift, avvisa sui path da potare, tace sugli illeggibili', () => {
  const ok = ratchetVerdict({ drift: ['a', 'b'], ratchetPaths: ['a', 'b', 'c'], unknown: ['c'] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.stale, []);
  const grown = ratchetVerdict({ drift: ['a', 'b', 'z'], ratchetPaths: ['a', 'b', 'c'] });
  assert.equal(grown.ok, false);
  assert.deepEqual(grown.fresh, ['z']);
  assert.deepEqual(grown.stale, ['c']);
  // Stesso numero, file diverso: e' comunque un drift nuovo.
  assert.equal(ratchetVerdict({ drift: ['a', 'z'], ratchetPaths: ['a', 'b'] }).ok, false);
});

test('in PR l\'elenco si accorcia soltanto', () => {
  assert.deepEqual(ratchetShrinkVerdict({ before: ['a', 'b'], after: ['a'] }), { ok: true, added: [] });
  assert.deepEqual(ratchetShrinkVerdict({ before: ['a'], after: ['a', 'z'] }), { ok: false, added: ['z'] });
  assert.equal(ratchetShrinkVerdict({ before: null, after: ['a'] }).ok, true);
});

test('il realign toglie dal ratchet solo i path riattestati, e non crea il file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-'));
  assert.deepEqual(pruneRatchetFile(dir, ['a']), []);
  assert.equal(fs.existsSync(path.join(dir, ADAPTED_DRIFT_RATCHET_PATH)), false);
  fs.mkdirSync(path.join(dir, path.dirname(ADAPTED_DRIFT_RATCHET_PATH)), { recursive: true });
  fs.writeFileSync(path.join(dir, ADAPTED_DRIFT_RATCHET_PATH), JSON.stringify({ _doc: ['x'], paths: ['b', 'a', 'c'] }));
  assert.deepEqual(pruneRatchetFile(dir, ['a', 'zz']), ['a']);
  const after = parseRatchet(fs.readFileSync(path.join(dir, ADAPTED_DRIFT_RATCHET_PATH), 'utf8'));
  assert.deepEqual(after.paths, ['b', 'c']);
  assert.deepEqual(after._doc, ['x']);
});

test('il ratchet del repo registra solo gemelli `adapted` del manifest', () => {
  const ratchet = parseRatchet(fs.readFileSync(path.join(ROOT, ADAPTED_DRIFT_RATCHET_PATH), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/ci/loop-sync-manifest.json'), 'utf8'));
  const adapted = new Set(manifest.files.filter((e) => e.mode === 'adapted').map((e) => e.path));
  assert.ok(ratchet.paths.length > 0);
  assert.deepEqual(ratchet.paths.filter((p) => !adapted.has(p)), []);
});

test('CLI: --enforce va rosso su un drift fuori elenco, senza --enforce resta un avviso', () => {
  const ratchet = parseRatchet(fs.readFileSync(path.join(ROOT, ADAPTED_DRIFT_RATCHET_PATH), 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-report-'));
  const write = (rows) => {
    const file = path.join(dir, `r${Math.random()}.json`);
    fs.writeFileSync(file, JSON.stringify({ results: rows }));
    return file;
  };
  const drifting = (p) => ({ path: p, mode: 'adapted', hashes: { site: 'S1', corpus: 'C0', baseline: base } });
  const known = write(ratchet.paths.map(drifting));
  const grown = write([...ratchet.paths, 'scripts/ci/non-registrato.mjs'].map(drifting));
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal(ratchetMain(['--report', known, '--enforce']), 0);
    assert.equal(ratchetMain(['--report', grown, '--enforce']), 1);
    assert.equal(ratchetMain(['--report', grown]), 0);
    // Report assente: rosso solo dove il gate deve decidere.
    assert.equal(ratchetMain(['--report', path.join(dir, 'manca.json'), '--enforce']), 1);
    assert.equal(ratchetMain(['--report', path.join(dir, 'manca.json')]), 0);
  } finally {
    console.log = log;
  }
});

test('workflow: il ratchet legge il report che il passo del drift scrive, e decide con la stessa regola di --strict', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/loop-drift-check.yml'), 'utf8');
  assert.match(wf, /export LOOP_DRIFT_REPORT_JSON="\$RUNNER_TEMP\/loop-drift-report\.json"/);
  const step = wf.slice(wf.indexOf('- name: Ratchet dei gemelli adapted in drift'));
  assert.ok(step.length > 0 && wf.includes('- name: Ratchet dei gemelli adapted in drift'));
  const block = step.slice(0, step.indexOf('\n      - name:', 10) > 0 ? step.indexOf('\n      - name:', 10) : undefined);
  assert.match(block, /if: always\(\)/);
  assert.match(block, /--report "\$RUNNER_TEMP\/loop-drift-report\.json"/);
  assert.match(block, /node scripts\/ci\/adapted-drift-ratchet\.mjs/);
  assert.match(block, /github\.event_name \}\}" = "schedule"[\s\S]*report_issue[\s\S]*args\+=\(--enforce\)/);
  assert.match(block, /"pull_request" \][\s\S]*--base-ref "origin\/\$\{\{ github\.base_ref \}\}"/);
});

// ───────────── registro: merge a 3 vie su repo git temporanei ─────────────

function gitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapted-reg-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  return dir;
}

function commit(dir, files, message) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', message], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

test('merge-file: 0 conflitti se le modifiche non si toccano, >0 se si', () => {
  const baseText = 'a\nb\nc\nd\ne\nf\ng\n';
  assert.equal(mergeConflicts({ ours: 'A\nb\nc\nd\ne\nf\ng\n', base: baseText, theirs: 'a\nb\nc\nd\ne\nf\nG\n' }), 0);
  assert.equal(mergeConflicts({ ours: 'a\nB1\nc\nd\ne\nf\ng\n', base: baseText, theirs: 'a\nB2\nc\nd\ne\nf\ng\n' }), 1);
});

test('PR del sito dai titoli squash, e link al diff ancorato al file', () => {
  assert.deepEqual(sitePrsFromSubjects(['fix(ci): x (#12)', 'merge (#3) poi (#40)', 'senza numero', 'dup (#12)']), [12, 40]);
  const url = compareUrl({ siteRepo: 'o/r', baseCommit: 'b', headCommit: 'h', sitePath: 'scripts/x.mjs' });
  assert.equal(url, `https://github.com/o/r/compare/b...h#diff-${crypto.createHash('sha256').update('scripts/x.mjs').digest('hex')}`);
});

test('registro end-to-end: base ritrovata nella storia del sito, conflitti contati, stabili esclusi', () => {
  const lines = (n, tag = '') => Array.from({ length: n }, (_, i) => `riga ${i}${tag}`).join('\n') + '\n';
  const site = gitRepo();
  const v0 = lines(12);
  const baseCommit = commit(site, { 'lib/pulito.mjs': v0, 'lib/conflitto.mjs': v0, 'lib/fermo.mjs': v0 }, 'base (#1)');
  const siteClean = v0.replace('riga 11\n', 'riga 11 sito\n');
  const siteConflict = v0.replace('riga 0\n', 'riga 0 sito\n');
  commit(site, { 'lib/pulito.mjs': siteClean, 'lib/conflitto.mjs': siteConflict }, 'fix: sito (#7)');

  const corpus = gitRepo();
  const corpusClean = v0.replace('riga 0\n', 'riga 0 corpus\n');
  const corpusConflict = v0.replace('riga 0\n', 'riga 0 corpus\n');
  const entry = (p, corpusText) => ({ path: p, mode: 'adapted', reason: 'test', baseline: { site: h16(v0), corpus: h16(corpusText), alignedAt: '2026-10-01' } });
  commit(corpus, {
    'lib/pulito.mjs': corpusClean,
    'lib/conflitto.mjs': v0,
    'lib/fermo.mjs': v0,
    'scripts/ci/loop-sync-manifest.json': JSON.stringify({
      siteRepo: 'o/r',
      files: [entry('lib/pulito.mjs', corpusClean), entry('lib/conflitto.mjs', v0), entry('lib/fermo.mjs', v0)],
    }),
  }, 'corpus');
  // Il corpus si muove sul file in conflitto DOPO la baseline: both-moved.
  commit(corpus, { 'lib/conflitto.mjs': corpusConflict }, 'corpus 2');

  const register = buildRegister({ corpusDir: corpus, corpusRef: 'HEAD', siteDir: site, siteRef: 'HEAD', cap: 50 });
  assert.deepEqual(register.rows.map((r) => [r.path, r.state, r.conflicts]), [
    ['lib/pulito.mjs', 'site-ahead', 0],
    ['lib/conflitto.mjs', 'both-moved', 1],
  ]);
  assert.equal(register.rows[0].baseCommit, baseCommit);
  assert.deepEqual(register.rows[0].sitePrs, [7]);
  assert.equal(findSiteBase({ siteDir: site, siteRef: 'HEAD', sitePath: 'lib/fermo.mjs', baselineSite: 'nessuno', cap: 50 }), null);

  const md = registerMarkdown(register);
  assert.match(md, /^<!-- adapted-drift-register -->/);
  assert.match(md, /\*\*In drift: 2\*\* \(1 `both-moved`, 1 `site-ahead`\)/);
  assert.match(md, /\| `lib\/pulito\.mjs` \| `site-ahead` \| 0 \(pulito\) \| #7 \| \[diff\]\(https:\/\/github\.com\/o\/r\/compare\//);
  assert.match(md, /Realign-adapted: <path> site-prs=#N/);
});
