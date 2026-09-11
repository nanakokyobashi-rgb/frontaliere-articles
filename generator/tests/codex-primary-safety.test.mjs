import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMutatingGhArgs } from '../../.github/actions/claude-codex-fallback/gh-bridge-server.mjs';
import { isMutatingGitArgs } from '../../.github/actions/claude-codex-fallback/git-bridge-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const action = fs.readFileSync(path.join(ROOT, '.github/actions/claude-codex-fallback/action.yml'), 'utf8');
const lessonsWorkflow = fs.readFileSync(path.join(ROOT, '.github/workflows/lessons-harvester.yml'), 'utf8');
const followupWorkflow = fs.readFileSync(path.join(ROOT, '.github/workflows/post-merge-followup.yml'), 'utf8');

function workflowStep(source, name) {
  const start = source.indexOf(`      - name: ${name}`);
  assert.notEqual(start, -1, `workflow step «${name}» non trovato`);
  const rest = source.slice(start + 1);
  const next = rest.indexOf('\n      - name: ');
  return next === -1 ? rest : rest.slice(0, next);
}

test('the GitHub bridge marks only state-changing gh operations', () => {
  assert.equal(isMutatingGhArgs(['--repo', 'owner/repo', 'pr', 'comment', '--body-file', 'body.md']), true);
  assert.equal(isMutatingGhArgs(['issue', 'edit', '--repo', 'owner/repo', '1']), true);
  assert.equal(isMutatingGhArgs(['--repo', 'owner/repo', 'pr', 'view', '1']), false);
  assert.equal(isMutatingGhArgs(['api', 'repos/owner/repo', '--method', 'GET']), false);
});

test('the Git bridge marks delivery and local-state-changing operations', () => {
  assert.equal(isMutatingGitArgs(['push', 'origin', 'HEAD']), true);
  assert.equal(isMutatingGitArgs(['fetch', 'origin', '--prune']), true);
  assert.equal(isMutatingGitArgs(['pull', 'origin', 'main']), true);
  assert.equal(isMutatingGitArgs(['ls-remote', 'origin', 'HEAD']), false);
});

test('Claude fallback is suppressed when Codex side effects are possible', () => {
  assert.match(action, /steps\.codex\.outcome == 'failure'/);
  assert.match(action, /steps\.codex\.outputs\.side_effect_detected == 'false'/);
  assert.match(action, /restore_sanitized_git_config/);
  const stopGhStart = action.indexOf('        stop_gh_bridge() {');
  const stopGhEnd = action.indexOf('        trap stop_gh_bridge EXIT', stopGhStart);
  assert.notEqual(stopGhStart, -1);
  assert.match(action.slice(stopGhStart, stopGhEnd), /restore_sanitized_git_config \|\| true/);
  assert.match(action, /cmp -s -- \"\$codex_state_before\" \"\$codex_state_after\"/);
});

test('il bridge corpus resta host-side anche quando il PAT arriva da GITHUB_ENV', () => {
  assert.ok(
    action.includes('codex_corpus_github_auth="${CODEX_CORPUS_GH_AUTH:-${GITHUB_PAT_NANAKO:-${GITHUB_PAT:-}}}"'),
    'il bridge deve usare il PAT caricato dal runtime se l input statico è vuoto',
  );
  assert.match(action, /unset CODEX_GH_AUTH CODEX_CORPUS_GH_AUTH GITHUB_PAT_NANAKO GITHUB_PAT/);

  const start = followupWorkflow.indexOf('Per Nanako usa SEMPRE');
  const end = followupWorkflow.indexOf('Parse PR body', start);
  assert.ok(start >= 0 && end > start, 'blocco di routing corpus non trovato');
  const routing = followupWorkflow.slice(start, end);
  assert.match(routing, /gh issue create --repo nanakokyobashi-rgb\/frontaliere-articles/);
  assert.doesNotMatch(routing, /GH_TOKEN=\"\$GITHUB_PAT\"/,
    'Codex deve usare il wrapper gh del bridge, non una variabile che il sandbox non riceve');
});

test('#1312: Lessons harvester non blocca Codex quando la quota Claude e\u0027 esaurita', () => {
  const quota = workflowStep(lessonsWorkflow, 'Pre-flight — Claude quota telemetry (Codex primary)');
  const draft = workflowStep(lessonsWorkflow, 'Draft doc-rule proposal (Claude — only if NOVEL patterns)');

  assert.match(quota, /continue-on-error: true/,
    'la telemetria quota non deve trasformare un 429 in un workflow failure');
  assert.match(draft, /uses: \.\/\.github\/actions\/claude-codex-fallback/,
    'il Lessons harvester deve usare l’action provider-neutral con Codex primario');
  assert.match(draft, /codex_auth_json: \$\{\{ secrets\.CODEX_AUTH_JSON \}\}/,
    'il workflow deve fornire l’autenticazione subscription al provider primario');
  assert.match(draft, /codex_github_token: \$\{\{ secrets\.GITHUB_TOKEN \}\}/,
    'il provider primario deve avere il token GitHub esplicito per il bridge');
  assert.doesNotMatch(draft, /steps\.quota\.outputs\.quota_blocked/,
    'un beacon Claude attivo non deve saltare il tentativo Codex primario');
});
