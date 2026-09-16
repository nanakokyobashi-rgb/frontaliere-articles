/**
 * Reviewer-bot login set — UNA sorgente per tutti i consumer.
 *
 * `REVIEWER_BOT_LOGIN_RE` è la metà generica del predicato; `isManagedReview`
 * aggiunge Codex solo con marker + identità bot esatta. I consumer `.mjs`
 * importano quel predicato; i workflow non possono importare una const JS e
 * riproducono il ramo jq equivalente. Questo guard tiene allineate le due
 * superfici.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REVIEWER_BOT_LOGIN_RE,
  REVIEWER_BOT_LOGIN_JQ,
  CODEX_REVIEW_MARKER,
  isCodexFallbackReview,
  isManagedReview,
  isReviewerBot,
} from '../../scripts/ci/lib/constants.mjs';

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

test('il tipo Bot è parte del predicato condiviso', () => {
  assert.equal(isReviewerBot({ type: 'Bot', login: 'claude[bot]' }), true);
  assert.equal(isReviewerBot({ type: 'User', login: 'claude-human' }), false);
  assert.equal(isReviewerBot({ type: 'User', login: 'frontaliere-automation-human' }), false);
});

test('Codex entra nel set gestito solo con marker e identità bot', () => {
  const codex = {
    user: { type: 'Bot', login: 'github-actions[bot]' },
    body: `## LGTM\n${CODEX_REVIEW_MARKER}`,
  };
  assert.equal(isCodexFallbackReview(codex), true);
  assert.equal(isManagedReview(codex), true);
  assert.equal(isManagedReview({
    ...codex,
    body: '## LGTM',
  }), false);
  assert.equal(isManagedReview({
    user: { type: 'Bot', login: 'dependabot[bot]' },
    body: `## LGTM\n${CODEX_REVIEW_MARKER}`,
  }), false);
  assert.equal(isManagedReview({
    user: { type: 'User', login: 'github-actions[bot]' },
    body: `## LGTM\n${CODEX_REVIEW_MARKER}`,
  }), false);
});

test('il predicato gestito copre anche la forma GraphQL author senza allargare i login', () => {
  assert.equal(isManagedReview({ author: { login: 'github-actions' }, body: CODEX_REVIEW_MARKER }), true);
  assert.equal(isManagedReview({ author: { login: 'claude' }, body: '## LGTM' }), true);
  assert.equal(isManagedReview({ author: { login: 'claude-human' }, body: '## LGTM' }), false);
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
  for (const [wf, expected] of [
    ['.github/workflows/pr-redflag-fixer.yml', 1],
    ['.github/workflows/stale-pr-rescuer.yml', 2],
  ]) {
    const src = read(wf);
    const loginSelector = `((.user.login // "") | ${REVIEWER_BOT_LOGIN_JQ})`;
    const botTypeSelector = wf.endsWith('pr-redflag-fixer.yml')
      ? 'select(.user.type == "Bot")'
      : '(.user.type == "Bot")';
    const count = (needle) => src.split(needle).length - 1;
    if (wf.endsWith('pr-redflag-fixer.yml')) {
      assert.equal(count(loginSelector), expected, `${wf} deve avere ${expected} predicato login reviewer`);
      assert.match(src, /github-actions\[bot\]/, `${wf} deve avere il predicato Codex separato`);
      assert.match(src, /CODEX_FALLBACK_REVIEW/, `${wf} deve richiedere il marker Codex`);
    } else {
      assert.equal(count(loginSelector), expected, `${wf} deve avere ${expected} selettori login reviewer`);
      assert.equal(
        count('(.user.login // "") == "github-actions[bot]"'),
        expected,
        `${wf} deve avere il ramo Codex con identità esatta`,
      );
      assert.equal(
        count('contains("<!-- CODEX_FALLBACK_REVIEW -->")'),
        expected,
        `${wf} deve richiedere il marker Codex`,
      );
    }
    assert.equal(count(botTypeSelector), expected, `${wf} deve accoppiare user.type == Bot a ogni selettore reviewer`);
  }
});

test('i consumer .mjs della review importano la costante invece di riscriverla', () => {
  for (const mjs of [
    'scripts/ci/auto-merge-eval.mjs',
    'scripts/ci/review-gate.mjs',
    'scripts/ci/pr-autorebase.mjs',
    'scripts/ci/harvest-agent-lessons.mjs',
    'scripts/ci/followup-has-candidates.mjs',
    'scripts/ci/review-claim.mjs',
    'scripts/ci/native-automerge-gate.mjs',
  ]) {
    const src = read(mjs);
    assert.match(src, /REVIEWER_BOT_LOGIN_RE|isReviewerBot|isManagedReview/, `${mjs} deve usare la costante o il predicato condiviso`);
    assert.ok(
      !/\/\^claude\/i\.test\(/.test(src),
      `${mjs} ha ancora un filtro login /^claude/i locale`,
    );
  }
});
