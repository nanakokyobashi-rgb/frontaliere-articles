import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ACTIONS = [
  '.github/actions/setup-claude-haiku-fallback/action.yml',
  '.github/actions/claude-codex-fallback/action.yml',
];

function read(rel) {
  return readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
}

function installStep(source) {
  const start = source.indexOf('\n    - name: Install pinned Codex CLI');
  assert.ok(start >= 0, 'Codex CLI install step missing');
  const end = source.indexOf('\n    - name:', start + 1);
  return source.slice(start, end < 0 ? undefined : end);
}

test('every Codex CLI installer is bounded before npm can consume the job', () => {
  const values = [];
  for (const rel of ACTIONS) {
    const step = installStep(read(rel));
    const timeout = step.match(/codex_cli_install_timeout_seconds=(\d+)/u)?.[1];
    assert.ok(timeout, `${rel}: install cap missing`);
    values.push(timeout);
    assert.ok(Number(timeout) > 0, `${rel}: install cap must be positive`);
    assert.match(step, /codex_cli_install_timeout_bin=\/usr\/bin\/timeout/u);
    assert.match(step, /--signal=TERM --kill-after=10s/u);
    assert.match(
      step,
      /"\$\{codex_cli_install_timeout_seconds\}s"[\s\S]*"\$trusted_node" "\$trusted_npm" install/u,
      `${rel}: npm install is not under the timeout wrapper`,
    );
    assert.match(step, /install_status=\$\?/u);
    assert.match(step, /if \[ "\$install_status" -ne 0 \]/u);
  }
  assert.deepEqual(values, ['300', '300'], 'the two Codex actions must share one bounded install policy');
});

test('a missing timeout utility never falls back to an unbounded install', () => {
  const articleStep = installStep(read(ACTIONS[0]));
  const reviewStep = installStep(read(ACTIONS[1]));
  assert.match(articleStep, /Trusted timeout utility unavailable[\s\S]*exit 0/u);
  assert.match(reviewStep, /Trusted timeout utility unavailable[\s\S]*exit 1/u);
});
