/**
 * Contratto del resolver Node/npm usato dal lane Codex Luna Max.
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
const CODEX_ACTION = fs.readFileSync(
  path.join(ROOT, '.github/actions/claude-codex-fallback/action.yml'),
  'utf8',
);
const BROKER = fs.readFileSync(
  path.join(ROOT, '.github/actions/setup-claude-haiku-fallback/codex-auth-broker.mjs'),
  'utf8',
);

const runtimeStart = ACTION.indexOf('- name: Resolve trusted Node/npm toolchain');
const codexStart = ACTION.indexOf('- name: Prepare Linux sandbox for Codex primary');
assert.ok(runtimeStart !== -1 && codexStart > runtimeStart, 'blocco trusted toolchain non trovato');
const RUNTIME = ACTION.slice(runtimeStart, codexStart);
const CODEX = ACTION.slice(codexStart);

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

test('nessuna coppia attestabile disattiva Codex senza aggirare il controllo', () => {
  const noPair = RUNTIME.match(
    /if \[ -z "\$node_realpath" \] \|\| \[ -z "\$npm_realpath" \]; then([\s\S]*?)fi/,
  )?.[1] ?? '';
  assert.match(noPair, /disable_codex_lane/);
  assert.doesNotMatch(noPair, /exit 1/);
  assert.match(RUNTIME, /printf 'available=false\\n' >> "\$GITHUB_OUTPUT"/);
  assert.match(
    RUNTIME,
    /printf 'CODEX_ARTICLE_LANE_GATE=0\\nENABLE_CODEX_ARTICLE_FALLBACK=0\\n' >> "\$GITHUB_ENV"/,
  );
});

test('anche una CLI Codex non installabile lascia disponibile la cascata normale', () => {
  assert.match(CODEX, /set \+e/);
  assert.match(CODEX, /Codex CLI install failed/);
  assert.match(CODEX, /normal fallback cascade remain available/);
  assert.match(CODEX, /printf 'codex_bin=%s\\n'/);
  assert.match(CODEX, /steps\.trusted_toolchain\.outputs\.available == 'true'/);
});

test('la CLI Codex viene installata in un prefisso attestato e passa il suo path al broker', () => {
  assert.match(CODEX, /codex_prefix="\$\(mktemp -d "\$runner_tmp\/codex-luna-max-codex-cli/);
  assert.match(CODEX, /@openai\/codex@0\.153\.4/);
  assert.match(CODEX, /codex_realpath=/);
  assert.match(CODEX, /codex_sha256=/);
  assert.match(CODEX, /CODEX_CLI_BIN:/);
  assert.match(CODEX, /CODEX_CLI_SHA256:/);
  assert.match(CODEX, /Start Codex auth broker for the primary lane/);
});

test('le probe CLI tollerano il suffisso di --version senza allentare il pin semver', () => {
  const codexPatterns = [...CODEX_ACTION.matchAll(
    /printf '%s\\n' "\$codex_version" \| \/usr\/bin\/grep -Eq '([^']+)'/g,
  )].map((match) => match[1]);
  assert.equal(codexPatterns.length, 2, 'le due probe semver del Codex devono restare allineate');
  for (const pattern of codexPatterns) {
    const codexVersion = new RegExp(pattern);
    assert.match('codex-cli 0.153.4 (Codex CLI)', codexVersion);
    assert.match('codex-cli v0.153.4 (Codex CLI)', codexVersion);
    assert.doesNotMatch('codex-cli 0.153.40', codexVersion);
    assert.doesNotMatch('codex-cli 0.153.4.1', codexVersion);
    assert.doesNotMatch('codex-cli 0.153.4-beta', codexVersion);
  }
  const setupCodexPattern = ACTION.match(
    /printf '%s\\n' "\$codex_version" \| grep -Eq '([^']+)'/,
  )?.[1];
  assert.ok(setupCodexPattern, 'probe semver del Codex nella setup action non trovata');
  const setupCodexVersion = new RegExp(setupCodexPattern);
  assert.match('codex-cli v0.153.4 (Codex CLI)', setupCodexVersion);
  assert.doesNotMatch('codex-cli 0.153.4.1', setupCodexVersion);
  assert.doesNotMatch('codex-cli 0.153.4-beta', setupCodexVersion);
  assert.match(
    BROKER,
    /versionOutput\.match\(\/\(\?:\^\|\[\^0-9A-Za-z\._-\]\)v\?\(\\d\+\\\.\\d\+\\\.\\d\+\)\(\?:\[\^0-9A-Za-z\._-\]\|\$\)\//,
  );
  assert.doesNotMatch(CODEX_ACTION, /\[\s*"\$codex_version"\s*(?:!=|=)\s*'[^']+'\s*\]/);
});
