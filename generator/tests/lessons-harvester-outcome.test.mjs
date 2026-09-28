/**
 * lessons-harvester.yml — verde falso e gate dichiarato (gemello del test del
 * sito `tests/lessons-harvester-outcome.test.ts`).
 *
 * Sul sito la run 36336838172 e' finita verde con 0 PR: `gh pr create` era
 * uscito con codice 3 e niente distingueva «Codex ha deciso di non aprire la
 * PR» da «non ci e' riuscito». Ora Codex scrive `lessons-harvester-outcome.txt`
 * e lo step `Verify proposal outcome` lo confronta con PR e branch reali. Qui
 * lo step viene ESEGUITO con un `gh` finto, caso per caso.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github/workflows/lessons-harvester.yml'), 'utf8');
const STARTED_AT = '2026-09-28T05:20:00Z';

/** Il blocco `run: |` di uno step, senza parser YAML (il corpus non ne ha). */
function stepBlock(name) {
  const lines = WORKFLOW.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`      - name: ${name}`));
  assert.ok(start > -1, `step «${name}» sparito`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith('      - name: '));
  return lines.slice(start, end === -1 ? undefined : end);
}
function runScript(name) {
  const block = stepBlock(name);
  const runAt = block.findIndex((l) => l === '        run: |');
  assert.ok(runAt > -1, `step «${name}» senza run: |`);
  return block.slice(runAt + 1).map((l) => l.slice(10)).join('\n');
}

let dir = '';
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lessons-outcome-'));
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', 'gh'), [
    '#!/bin/bash',
    'case "$*" in',
    '  *matching-refs*) printf \'%b\' "${STUB_REFS:-}" ;;',
    '  *commits/*) echo "${STUB_COMMIT_DATE:-2026-09-28T05:00:00Z}" ;;',
    '  "pr view"*) printf \'%b\\n\' "${STUB_PR:-}" ;;',
    'esac',
  ].join('\n'));
  fs.chmodSync(path.join(dir, 'bin', 'gh'), 0o755);
  fs.writeFileSync(path.join(dir, 'verify.sh'), runScript('Verify proposal outcome'));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function verify(outcome, stub = {}) {
  fs.rmSync(path.join(dir, 'lessons-harvester-outcome.txt'), { force: true });
  if (outcome !== null) fs.writeFileSync(path.join(dir, 'lessons-harvester-outcome.txt'), `${outcome}\n`);
  const r = spawnSync('bash', ['-euo', 'pipefail', path.join(dir, 'verify.sh')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...stub, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`,
      REPO: 'nanakokyobashi-rgb/frontaliere-articles', STARTED_AT },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const openPr = 'OPEN\tlessons/auto-harvest-20260928\t2026-09-28T05:31:00Z\tnanakokyobashi-rgb';

test('lo step di verifica sta dopo lo step Codex e gira anche se quello fallisce', () => {
  const codexAt = WORKFLOW.indexOf('uses: ./.github/actions/claude-codex-fallback');
  const verifyAt = WORKFLOW.indexOf('      - name: Verify proposal outcome');
  assert.ok(codexAt > -1 && verifyAt > codexAt);
  const block = stepBlock('Verify proposal outcome').join('\n');
  assert.match(block, /\n {8}if: always\(\) && /);
  assert.match(block, /STARTED_AT: \$\{\{ steps\.guard\.outputs\.started_at \}\}/);
  assert.match(WORKFLOW, /echo "started_at=\$\(date -u \+%Y-%m-%dT%H:%M:%SZ\)" >> "\$GITHUB_OUTPUT"/);
});

test('file d\'esito assente → rosso', () => {
  const r = verify(null);
  assert.equal(r.code, 1);
  assert.match(r.out, /assente o vuoto/);
});

test('failed:<causa> → rosso', () => {
  assert.equal(verify('failed:gh pr create exit 3').code, 1);
});

test('none:<motivo> senza branch nuovi → verde; con un branch vecchio → verde', () => {
  assert.equal(verify('none:ogni cluster gia registrato').code, 0);
  assert.equal(verify('none:niente', {
    STUB_REFS: 'refs/heads/lessons/auto-harvest-20260901\tabc\n', STUB_COMMIT_DATE: '2026-09-01T05:30:00Z' }).code, 0);
});

test('none: con un branch lessons/auto-harvest-* pushato in questa run → rosso', () => {
  const r = verify('none:niente', {
    STUB_REFS: 'refs/heads/lessons/auto-harvest-20260928\tabc\n', STUB_COMMIT_DATE: '2026-09-28T05:30:00Z' });
  assert.equal(r.code, 1);
  assert.match(r.out, /stato pushato in questa run/);
});

test('pr:<N> coerente → verde; incoerente → rosso', () => {
  assert.equal(verify('pr:2100', { STUB_PR: openPr }).code, 0);
  assert.equal(verify('pr:2100', { STUB_PR: openPr.replace('lessons/auto-harvest-20260928', 'fix/other') }).code, 1);
  assert.equal(verify('pr:2100', { STUB_PR: openPr.replace('2026-09-28T05:31:00Z', '2026-09-27T05:31:00Z') }).code, 1);
  assert.equal(verify('pr:2100', { STUB_PR: openPr.replace('OPEN', 'CLOSED') }).code, 1);
  assert.equal(verify('pr:2100', { STUB_PR: '' }).code, 1);
  assert.equal(verify('pr:abc').code, 1);
});

test('esito non riconosciuto o none: senza motivo → rosso', () => {
  assert.equal(verify('boh').code, 1);
  assert.equal(verify('none:').code, 1);
});

test('nessuna promessa di gate umano; il prompt chiede registro ed esito', () => {
  assert.doesNotMatch(WORKFLOW, /never auto-merged|Human-gated|la rivede un umano/u);
  assert.match(WORKFLOW, /auto-merge nativo/u);
  assert.match(WORKFLOW, /scripts\/ci\/lessons-harvester-registry\.json/u);
  assert.match(WORKFLOW, /`pr:<N>`[\s\S]*`none:<motivo>`[\s\S]*`failed:<causa>`/u);
});

test('il registro versionato del corpus e\' valido', async () => {
  const raw = fs.readFileSync(path.join(ROOT, 'scripts/ci/lessons-harvester-registry.json'), 'utf8');
  const data = JSON.parse(raw);
  assert.ok(Array.isArray(data.entries));
  const harvester = await import(path.join(ROOT, 'scripts/ci/harvest-agent-lessons.mjs'));
  if (typeof harvester.parseLessonsRegistry === 'function') {
    // Il parser arriva dal gemello identical del sito: quando c'e', e' lui l'arbitro.
    const { entries, errors } = harvester.parseLessonsRegistry(raw);
    assert.deepEqual(errors, []);
    assert.equal(entries.size, data.entries.length);
    return;
  }
  for (const e of data.entries) {
    assert.match(e.key, /^(?:reviewer-finding|fix-outcome|issue-class)\/\S+$/u);
    assert.ok(['added', 'declined'].includes(e.outcome), e.key);
    assert.match(e.decidedAt, /^\d{4}-\d{2}-\d{2}T/u, e.key);
    assert.ok(String(e.reason || '').trim(), e.key);
  }
});
