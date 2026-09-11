import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMutatingGhArgs } from '../../.github/actions/claude-codex-fallback/gh-bridge-server.mjs';
import { isMutatingGitArgs } from '../../.github/actions/claude-codex-fallback/git-bridge-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const action = fs.readFileSync(path.join(ROOT, '.github/actions/claude-codex-fallback/action.yml'), 'utf8');

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
  assert.match(action, /cmp -s -- \"\$codex_state_before\" \"\$codex_state_after\"/);
});
