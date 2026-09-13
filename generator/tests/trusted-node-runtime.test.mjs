/**
 * Contratto del resolver Node/npm usato dal fallback Haiku.
 *
 * L'action è YAML con una composite action: il test verifica il contratto
 * sorgente senza fingere di poter emulare il runner GitHub in node:test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ACTION = fs.readFileSync(
  path.join(ROOT, '.github/actions/setup-claude-haiku-fallback/action.yml'),
  'utf8',
);

const runtimeStart = ACTION.indexOf('- name: Resolve trusted Node/npm toolchain');
const claudeStart = ACTION.indexOf('- name: Setup Claude CLI Haiku fallback');
assert.ok(runtimeStart !== -1 && claudeStart > runtimeStart, 'blocco trusted toolchain non trovato');
const RUNTIME = ACTION.slice(runtimeStart, claudeStart);
const CLAUDE = ACTION.slice(claudeStart);

test('il resolver ammette solo prefissi di sistema e mantiene il controllo dei componenti', () => {
  const roots = RUNTIME.match(/for trusted_root in ([^;]+); do/)?.[1] ?? '';
  assert.match(roots, /\/usr\b/);
  assert.match(roots, /\/usr\/local\b/);
  assert.match(roots, /\/opt\/hostedtoolcache\b/);
  assert.doesNotMatch(roots, /RUNNER_TEMP|runner_temp|\/tmp|HOME/);
  assert.match(RUNTIME, /\(\( \(8#\$mode & 022\) == 0 \)\)/);
  assert.match(RUNTIME, /if \[ "\$owner" = '0' \]; then/);
  assert.match(RUNTIME, /\(\( \(8#\$mode & 0200\) == 0 \)\)/);
  assert.match(RUNTIME, /harden_toolchain_path/);
  assert.match(RUNTIME, /chmod_cmd=/);
  assert.match(RUNTIME, /harden_runtime_candidates\n\s*report_runtime_candidates/);
});

test('workspace, home del runner, /tmp e RUNNER_TEMP restano percorsi vietati', () => {
  assert.match(RUNTIME, /runner_home="\$\{RUNNER_HOME:-\$\{HOME:-\/home\/runner\}\}"/);
  assert.match(
    RUNTIME,
    /for forbidden_root in "\$workspace_root" "\$action_path" "\$runner_temp" "\$runner_home"; do/,
  );
  assert.match(RUNTIME, /\/tmp\|\/tmp\/\*/);
});

test('la diagnostica espone PATH, realpath e il verdetto dei due controlli', () => {
  assert.match(RUNTIME, /trusted-runtime PATH=%s/);
  assert.match(
    RUNTIME,
    /trusted-runtime candidate=%s realpath=%s mode=%s owner=%s trusted_prefix=%s path_components_trusted=%s/,
  );
  assert.match(RUNTIME, /report_runtime_candidates\n/);
  assert.match(RUNTIME, /trusted-runtime selected node_realpath=%s npm_realpath=%s/);
});

test('nessuna coppia attestabile disattiva Haiku senza aggirare il controllo', () => {
  const noPair = RUNTIME.match(
    /if \[ -z "\$node_realpath" \] \|\| \[ -z "\$npm_realpath" \]; then([\s\S]*?)fi/,
  )?.[1] ?? '';
  assert.match(noPair, /disable_haiku/);
  assert.doesNotMatch(noPair, /exit 1/);
  assert.match(RUNTIME, /printf 'available=false\\n' >> "\$GITHUB_OUTPUT"/);
  assert.match(
    RUNTIME,
    /printf 'HAIKU_FALLBACK_GATE=0\\nENABLE_HAIKU_ARTICLE_FALLBACK=0\\nENABLE_CODEX_ARTICLE_FALLBACK=0\\n' >> "\$GITHUB_ENV"/,
  );
});

test('anche una CLI Haiku non installabile lascia disponibile la cascata normale', () => {
  assert.match(CLAUDE, /set \+e\n\s*\(/);
  assert.match(CLAUDE, /setup_status=\$\?/);
  assert.match(CLAUDE, /printf 'available=true\\n' >> "\$GITHUB_OUTPUT"/);
  assert.match(CLAUDE, /printf 'available=false\\n' >> "\$GITHUB_OUTPUT"/);
  assert.match(CLAUDE, /Haiku fallback disabled|Haiku setup unavailable/);
  assert.match(CLAUDE, /steps\.trusted_toolchain\.outputs\.available == 'true'/);
});

test('la CLI Haiku viene installata in un prefisso attestato e passa il suo path al consumer', () => {
  assert.match(CLAUDE, /claude_prefix=.*\/opt\/runner\/claude-haiku-cli/);
  assert.match(CLAUDE, /NPM_CONFIG_PREFIX="\$claude_prefix"/);
  assert.match(CLAUDE, /claude_cli_bin=/);
  assert.match(CLAUDE, /claude_cli_sha256=/);
  assert.match(CLAUDE, /CLAUDE_CLI_BIN=/);
  assert.match(CLAUDE, /CLAUDE_CLI_SHA256=/);
  assert.match(CLAUDE, /root-owned Claude CLI prefix/);
});
