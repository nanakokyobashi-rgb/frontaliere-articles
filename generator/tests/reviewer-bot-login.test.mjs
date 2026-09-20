/**
 * Reviewer-bot login set — UNA sorgente, sei consumer.
 *
 * `REVIEWER_BOT_LOGIN_RE` decide quali review valgono come verdetto del
 * reviewer. I consumer `.mjs` la importano; i workflow adattati non possono
 * (uno `run:` YAML non importa una const JS) e riproducono il predicato jq.
 * `stale-pr-rescuer.yml` è l'eccezione REST: usa i due login `[bot]` esatti
 * e non il metadata opzionale `user.type`. Questo guard tiene distinti i
 * due contratti: senza, il trigger del 🔴-fixer può accettare l'App bot
 * mentre il bundle e i gate di merge leggono ancora il solo `claude` — un
 * round speso sui findings sbagliati, un `## LGTM` mai riconosciuto, e
 * nessuno dei due fallisce.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REVIEWER_BOT_LOGIN_RE,
  REVIEWER_BOT_LOGIN_JQ,
  isReviewerBot,
  isManagedReview,
  CODEX_REVIEW_MARKER,
} from '../../scripts/ci/lib/constants.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const STRICT_REVIEWER_BOT_LOGIN_JQ = 'test("^(claude\\\\[bot\\\\]|frontaliere-automation\\\\[bot\\\\])$";"i")';

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

test('il login REST esatto basta anche senza user.type', () => {
  assert.equal(isReviewerBot({ type: 'Bot', login: 'claude[bot]' }), true);
  assert.equal(isReviewerBot({ login: 'frontaliere-automation[bot]' }), true);
  assert.equal(isReviewerBot({ type: 'User', login: 'claude[bot]' }), true);
  assert.equal(isReviewerBot({ type: 'Bot', login: 'frontaliere-automation' }), false);
  assert.equal(isReviewerBot({ type: 'User', login: 'claude-human' }), false);
});

test('isManagedReview allinea login GraphQL e REST dopo la normalizzazione', () => {
  assert.equal(isManagedReview({ user: { type: 'Bot', login: 'claude[bot]' } }), true);
  assert.equal(isManagedReview({ user: { login: 'frontaliere-automation[bot]' } }), true);
  assert.equal(isManagedReview({ user: { type: 'Bot', login: 'frontaliere-automation' } }), false);
  assert.equal(isManagedReview({ author: { login: 'claude' } }), true);
  assert.equal(isManagedReview({ author: { login: 'claude[bot]' } }), true);
  assert.equal(isManagedReview({ author: { login: 'frontaliere-automation' } }), true);
  assert.equal(isManagedReview({ author: { login: 'frontaliere-automation[bot]' } }), true);
  assert.equal(isManagedReview({ user: { login: 'claude[bot]' } }), true);
  assert.equal(isManagedReview({ author: { login: 'claude-code[bot]' } }), true);
  assert.equal(isManagedReview({ user: { type: 'Bot', login: 'claude-code[bot]' } }), false);
  assert.equal(isManagedReview({ author: { login: 'claude-human' } }), false);
  assert.equal(isManagedReview({ user: { type: 'User', login: 'claude-human' } }), false);
  assert.equal(
    isManagedReview({
      user: { type: 'Bot', login: 'github-actions[bot]' },
      body: `${CODEX_REVIEW_MARKER}\n## LGTM`,
    }),
    true,
  );
  assert.equal(
    isManagedReview({
      user: { type: 'Bot', login: 'github-actions[bot]' },
      body: '## LGTM',
    }),
    false,
  );
});

test('i workflow di review rispettano il contratto di identità specifico', () => {
  const workflows = [
    '.github/workflows/pr-redflag-fixer.yml',
  ];
  for (const wf of workflows) {
    const src = read(wf);
    assert.equal(
      src.split(STRICT_REVIEWER_BOT_LOGIN_JQ).length - 1,
      1,
      `${wf} deve usare una allowlist REST esatta`,
    );
    assert.doesNotMatch(src, /select\(\.user\.type == "Bot"\)/,
      `${wf} non deve dipendere da user.type`);
    assert.ok(
      !/test\("claude";"i"\)/.test(src),
      `${wf} filtra ancora il solo login claude`,
    );
  }
  const staleRescuer = read('.github/workflows/stale-pr-rescuer.yml');
  assert.equal(
    staleRescuer.split(STRICT_REVIEWER_BOT_LOGIN_JQ).length - 1,
    2,
    'stale-pr-rescuer deve usare due allowlist reviewer esatte',
  );
  assert.doesNotMatch(staleRescuer, /\.user\.type/, 'stale-pr-rescuer non deve dipendere da user.type');
  assert.doesNotMatch(
    staleRescuer,
    /test\("\^\(claude\|frontaliere-automation\)";"i"\)/,
    'stale-pr-rescuer non deve usare l allowlist a prefisso',
  );
  const testsYml = read('.github/workflows/tests.yml');
  const strictCount = testsYml.split(STRICT_REVIEWER_BOT_LOGIN_JQ).length - 1;
  assert.equal(strictCount, 4, 'tests.yml deve avere quattro selettori reviewer strettamente ancorati');
  assert.equal(
    testsYml.split(REVIEWER_BOT_LOGIN_JQ).length - 1,
    0,
    'tests.yml non deve usare il predicato prefisso condiviso dai fixer adattati',
  );
  for (const match of testsYml.matchAll(/test\("\^\(claude\\\\\[bot\\\\\]\|frontaliere-automation\\\\\[bot\\\\\]\)\$";"i"\)/g)) {
    const context = testsYml.slice(Math.max(0, match.index - 220), match.index + match[0].length);
    assert.doesNotMatch(context, /\.user\.type\s*==\s*"Bot"/, 'il gate review non deve dipendere da user.type');
  }
  for (const [wf, expected] of [
    ['.github/workflows/pr-redflag-fixer.yml', 1],
  ]) {
    const src = read(wf);
    const loginSelector = STRICT_REVIEWER_BOT_LOGIN_JQ;
    const count = (needle) => src.split(needle).length - 1;
    assert.equal(count(loginSelector), expected, `${wf} deve avere ${expected} selettori login reviewer`);
    assert.equal(count('select(.user.type == "Bot")'), 0, `${wf} non deve filtrare user.type`);
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
    assert.match(src, /REVIEWER_BOT_LOGIN_RE|isReviewerBot|isManagedReview/, `${mjs} deve usare la costante o il predicato condiviso`);
    assert.ok(
      !/\/\^claude\/i\.test\(/.test(src),
      `${mjs} ha ancora un filtro login /^claude/i locale`,
    );
  }
});
