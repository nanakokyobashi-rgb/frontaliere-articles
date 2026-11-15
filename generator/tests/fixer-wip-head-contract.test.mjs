/**
 * fixer-wip-head-contract.test.mjs — nessun fixer consegna un checkpoint WIP
 * come HEAD della PR (gemello del sito: tests/wip-checkpoint-review-gate.test.ts
 * e tests/fixer-wip-head-contract.test.ts).
 *
 * Al sito il Re-review guard F7 di `tests.yml` chiude fail-closed, senza modello,
 * ogni PR la cui HEAD e' `wip(issue-N): checkpoint ...`; misurato il 2026-11-15
 * su #18842/#18843/#18844 (issue-fix) e su #18822 (round del fixer redflag, che
 * ha consegnato `wip(issue-18813): checkpoint pre-test` imitando lo stile del
 * branch). Il corpus tiene lo stesso contratto: regola nei prompt e step
 * deterministico `Finalize ... HEAD`, cosi' i due lati non divergono.
 *
 * Solo testo dei workflow (come gli altri test di forma, niente parser YAML);
 * il comportamento dello step e' eseguito su un repository git temporaneo.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WORKFLOWS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.github/workflows');
const load = (name) => fs.readFileSync(path.join(WORKFLOWS, name), 'utf8');

/** Gli step di un workflow come blocchi di testo (da `      - name:` al successivo). */
function stepsOf(text) {
  const lines = text.split('\n');
  const steps = [];
  let current = null;
  for (const line of lines) {
    if (/^ {6}- name: /.test(line)) {
      current = { name: line.replace(/^ {6}- name: /, '').trim(), lines: [line] };
      steps.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return steps.map((step) => ({ ...step, text: step.lines.join('\n') }));
}

/** Il corpo di `run: |` di uno step, dedentato di 10 colonne. */
function runOf(step) {
  const index = step.lines.findIndex((line) => /^ {8}run: \|\s*$/.test(line));
  assert.ok(index >= 0, `step senza run: ${step.name}`);
  const body = [];
  for (const line of step.lines.slice(index + 1)) {
    if (line.trim() !== '' && !line.startsWith(' '.repeat(10))) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
}

const FIXERS = [
  { file: 'issue-fix.yml', kind: 'issue-fix', finalize: 'Finalize PR HEAD', after: 'Salva il lavoro parziale', before: 'Evaluate current PR delivery evidence' },
  { file: 'pr-redflag-fixer.yml', kind: 'redflag', finalize: 'Finalize redflag HEAD', after: 'Ripristina gemelli identical', before: 'Cleanup Firebase credentials' },
  { file: 'pr-redcheck-fixer.yml', kind: 'redcheck', finalize: 'Finalize redcheck HEAD', after: 'Ripristina gemelli identical', before: 'Classify outcome' },
];

for (const { file, kind, finalize, after, before } of FIXERS) {
  const text = load(file);
  const steps = stepsOf(text);
  const step = steps.find((candidate) => candidate.name.startsWith(finalize));

  test(`${file}: il prompt vieta un subject che inizia per wip( e chiede un commit conventional`, () => {
    if (kind === 'issue-fix') {
      assert.match(text, /7\. Commit FINALE \(OBBLIGATORIO, mai un no-op\)/u);
      assert.match(text, /git commit --allow-empty -m "fix\(issue-\$ISSUE_NUMBER\):/u);
      assert.doesNotMatch(text, /Commit \(no-op se dal checkpoint non è cambiato altro/u);
      assert.match(text, /NON inizi per `wip\(`/u);
    } else {
      assert.match(text, /NON inizia MAI con `wip\(`/u);
      assert.match(text, /`fix\(\.\.\.\)`\/`chore\(\.\.\.\)`/u);
    }
  });

  test(`${file}: lo step Finalize esiste, e' best-effort e sta fra ${after} e ${before}`, () => {
    assert.ok(step, `step ${finalize} mancante`);
    assert.match(step.text, /^ {8}continue-on-error: true$/mu);
    assert.match(step.text, /^ {8}if: always\(\)/mu);
    const names = steps.map((candidate) => candidate.name);
    const at = names.indexOf(step.name);
    assert.ok(at > names.findIndex((name) => name.startsWith(after)), `dopo «${after}»`);
    assert.ok(at < names.findIndex((name) => name.startsWith(before)), `prima di «${before}»`);
    const run = runOf(step);
    assert.doesNotMatch(run, /--force|\+HEAD|--amend|git reset|git rebase|git push[^\n]*\s-f(?:\s|$)/u);
    assert.match(run, /git push origin "HEAD:refs\/heads\/\$\{?(?:HEAD_REF|BRANCH)\}?"/u);
  });
}

// ---- comportamento reale degli step dei fixer di PR (redflag/redcheck) ----
for (const { file, kind, finalize } of FIXERS.filter((fixer) => fixer.kind !== 'issue-fix')) {
  const step = stepsOf(load(file)).find((candidate) => candidate.name.startsWith(finalize));
  const run = runOf(step);

  const exec = ({ subject, baseIsHead = false }) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-finalize-'));
    try {
      const remote = path.join(temp, 'remote.git');
      const work = path.join(temp, 'work');
      fs.mkdirSync(work);
      const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
      execFileSync('git', ['init', '-q', '--bare', remote]);
      git(work, 'init', '-q', '-b', 'main');
      git(work, 'config', 'user.name', 't');
      git(work, 'config', 'user.email', 't@example.invalid');
      git(work, 'remote', 'add', 'origin', remote);
      fs.writeFileSync(path.join(work, 'a.txt'), 'a');
      git(work, 'add', '-A');
      git(work, 'commit', '-q', '-m', 'base');
      git(work, 'checkout', '-q', '-b', 'fix/x');
      git(work, 'push', '-q', 'origin', 'fix/x');
      const baseSha = git(work, 'rev-parse', 'HEAD');
      if (!baseIsHead) {
        fs.writeFileSync(path.join(work, 'a.txt'), 'b');
        git(work, 'add', '-A');
        git(work, 'commit', '-q', '-m', subject, '-m', `Fixer: ${kind}-round-1`);
      }
      execFileSync('bash', ['-c', run], {
        cwd: work,
        env: { ...process.env, HEAD_REF: 'fix/x', BASE_SHA: baseSha, FIX_ROUND: '2' },
        stdio: 'pipe',
      });
      return {
        subject: git(work, 'log', '-1', '--format=%s'),
        trailer: git(work, 'log', '-1', '--format=%(trailers:key=Fixer,valueonly)'),
        commits: Number(git(work, 'rev-list', '--count', `${baseSha}..HEAD`)),
        pushed: git(remote, 'rev-parse', 'fix/x') === git(work, 'rev-parse', 'HEAD'),
        remoteIsBase: git(remote, 'rev-parse', 'fix/x') === baseSha,
      };
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  };

  test(`${file}: sopra un checkpoint wip aggiunge un commit conventional con lo stesso trailer e lo pusha`, () => {
    const result = exec({ subject: 'wip(issue-18813): checkpoint pre-test' });
    assert.equal(result.subject, `chore(${kind}): consegna il fix del round 2`);
    assert.equal(result.trailer.trim(), `${kind}-round-2`);
    assert.equal(result.commits, 2, 'nessun amend: il commit del round resta sotto');
    assert.equal(result.pushed, true);
  });

  test(`${file}: non tocca un commit conventional ne' un round senza commit nuovi`, () => {
    const conventional = exec({ subject: 'fix(issue-18813): correggi il guard' });
    assert.equal(conventional.commits, 1);
    assert.equal(conventional.subject, 'fix(issue-18813): correggi il guard');
    const none = exec({ subject: 'unused', baseIsHead: true });
    assert.equal(none.commits, 0);
    assert.equal(none.remoteIsBase, true);
  });
}
