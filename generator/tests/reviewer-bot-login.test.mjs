/**
 * Reviewer-bot login set — UNA sorgente, sei consumer.
 *
 * `REVIEWER_BOT_LOGIN_RE` decide quali review valgono come verdetto del
 * reviewer. I consumer `.mjs` la importano; i workflow non possono (uno `run:`
 * YAML non importa una const JS) e usano il predicato jq derivato dalla stessa
 * `.source`. Questo guard è il legame fra le due copie: senza, il trigger del
 * 🔴-fixer può accettare l'App bot mentre il bundle e i gate di merge leggono
 * ancora il solo `claude` — un round speso sui findings sbagliati, un `## LGTM`
 * mai riconosciuto, e nessuno dei due fallisce.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REVIEWER_BOT_LOGIN_RE, REVIEWER_BOT_LOGIN_JQ } from '../../scripts/ci/lib/constants.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('il set di login copre entrambe le forme di entrambi i bot', () => {
  for (const login of ['claude', 'claude[bot]', 'frontaliere-automation', 'frontaliere-automation[bot]']) {
    assert.ok(REVIEWER_BOT_LOGIN_RE.test(login), `${login} deve valere come reviewer`);
  }
  for (const login of ['github-actions[bot]', 'dependabot[bot]', 'valerielinc', 'not-claude']) {
    assert.ok(!REVIEWER_BOT_LOGIN_RE.test(login), `${login} non deve valere come reviewer`);
  }
});

test('il predicato jq è derivato dalla regex, non riscritto', () => {
  assert.equal(REVIEWER_BOT_LOGIN_JQ, `test("${REVIEWER_BOT_LOGIN_RE.source}";"i")`);
});

test('i workflow che filtrano le review usano il predicato jq condiviso', () => {
  const workflows = [
    '.github/workflows/pr-redflag-fixer.yml',
    '.github/workflows/stale-pr-rescuer.yml',
    '.github/workflows/tests.yml',
  ];
  for (const wf of workflows) {
    const src = read(wf);
    assert.ok(src.includes(REVIEWER_BOT_LOGIN_JQ), `${wf} deve filtrare le review con ${REVIEWER_BOT_LOGIN_JQ}`);
    assert.ok(
      !/test\("claude";"i"\)/.test(src),
      `${wf} filtra ancora il solo login claude`,
    );
  }
});

test('i consumer .mjs della review importano la costante invece di riscriverla', () => {
  for (const mjs of [
    'scripts/ci/auto-merge-eval.mjs',
    'scripts/ci/review-gate.mjs',
    'scripts/ci/pr-autorebase.mjs',
    'scripts/ci/harvest-agent-lessons.mjs',
  ]) {
    const src = read(mjs);
    assert.match(src, /REVIEWER_BOT_LOGIN_RE/, `${mjs} deve usare REVIEWER_BOT_LOGIN_RE`);
    assert.ok(
      !/\/\^claude\/i\.test\(/.test(src),
      `${mjs} ha ancora un filtro login /^claude/i locale`,
    );
  }
});
