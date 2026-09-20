/**
 * Il guard token-down di recycle-stale-prs.yml deve misurare la capacita' che
 * il workflow usa davvero.
 *
 * Il preflight del recycle ammette SOLO `GITHUB_PAT_NANAKO` con un login nel
 * set del sender gate di issue-fix: l'App token chiude la PR ma non ritriggera
 * il fixer, quindi non e' un sostituto. Finche' il guard accettava
 * `${APP_TOKEN:-${GITHUB_PAT_NANAKO:-}}`, lo scenario "App token presente, PAT
 * assente o con login non ammesso" usciva 0 su TUTTI i fronti: niente close,
 * niente re-queue e niente alert. Questi test eseguono il blocco reale dello
 * step con un `gh` e un `node` finti e pinnano quando l'alert deve partire.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const WORKFLOW = readFileSync(new URL('../../.github/workflows/recycle-stale-prs.yml', import.meta.url), 'utf8');

function alertScript() {
  const step = WORKFLOW.indexOf('- name: Alert token-down (dedup, zero-Claude)');
  assert.notEqual(step, -1, 'step Alert token-down non trovato');
  const start = WORKFLOW.indexOf('\n        run: |', step);
  assert.notEqual(start, -1, 'run block dell\'alert non trovato');
  const end = WORKFLOW.indexOf('\n      - name: ', start);
  assert.notEqual(end, -1, 'fine del run block dell\'alert non trovata');
  return WORKFLOW.slice(start + '\n        run: |\n'.length, end)
    .split('\n')
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n')
    // Le espressioni ${{ }} sono interpolate da Actions, non da bash.
    .replace(/\$\{\{[^}]*\}\}/g, 'x');
}

const FAKE_GH = `#!/bin/sh
set -eu
printf 'gh %s\\n' "$*" >>"\${FAKE_LOG:?}"
if [ "\${1:-}" = api ] && [ "\${2:-}" = user ]; then
  case "\${GH_TOKEN:-}" in
    nanako-token) printf '%s\\n' "\${FAKE_PAT_LOGIN-nanakokyobashi-rgb}" ;;
    app-token) printf '%s\\n' 'frontaliere-automation[bot]' ;;
    *) exit 1 ;;
  esac
  exit 0
fi
exit 0
`;

const FAKE_NODE = `#!/bin/sh
printf 'node %s\\n' "$*" >>"\${FAKE_LOG:?}"
exit 0
`;

function runAlert(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'recycle-token-guard-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  for (const [name, body] of [['gh', FAKE_GH], ['node', FAKE_NODE]]) {
    const file = join(bin, name);
    writeFileSync(file, body);
    chmodSync(file, 0o755);
  }
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH || ''}`,
    BASH_ENV: '/dev/null',
    GH_TOKEN: 'base-token',
    GH_REPO: 'owner/repo',
    FAKE_LOG: log,
    ...overrides,
  };
  let output = '';
  try {
    output = execFileSync('bash', ['-c', ['set -uo pipefail', alertScript()].join('\n')], {
      encoding: 'utf8',
      env,
    });
  } catch (caught) {
    output = `${caught.stdout || ''}${caught.stderr || ''}`;
  }
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  rmSync(dir, { recursive: true, force: true });
  return { output, calls, alerted: calls.some((line) => line.includes('alert-pat-down.mjs')) };
}

test('PAT ammesso dal sender gate: nessun alert', () => {
  const result = runAlert({ GITHUB_PAT_NANAKO: 'nanako-token', APP_TOKEN: '' });
  assert.equal(result.alerted, false, result.output);
  assert.match(result.output, /nessun alert token-down/);
});

test('App token presente ma PAT assente: l\'alert parte lo stesso', () => {
  const result = runAlert({ APP_TOKEN: 'app-token', GITHUB_PAT_NANAKO: '' });
  assert.equal(result.alerted, true, result.output);
  assert.match(result.output, /GITHUB_PAT_NANAKO assente/);
});

test('PAT presente ma con login non ammesso: l\'alert parte', () => {
  for (const login of ['frontaliere-automation[bot]', '']) {
    const result = runAlert({
      APP_TOKEN: 'app-token',
      GITHUB_PAT_NANAKO: 'nanako-token',
      FAKE_PAT_LOGIN: login,
    });
    assert.equal(result.alerted, true, `${login}: ${result.output}`);
    assert.match(result.output, /non ammesso dal sender gate/);
  }
});

test('il guard non accetta piu\' l\'App token come capacita\' sufficiente', () => {
  const step = WORKFLOW.slice(
    WORKFLOW.indexOf('- name: Alert token-down (dedup, zero-Claude)'),
    WORKFLOW.indexOf('- name: Recycle deeply-stale stale-review PRs'),
  );
  assert.doesNotMatch(step, /\$\{APP_TOKEN:-\$\{GITHUB_PAT_NANAKO:-\}\}/);
  assert.match(step, /nanakokyobashi-rgb\|valerielinc-ops\|claude\*/);
});
