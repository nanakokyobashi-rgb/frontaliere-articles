/**
 * Contratto del resolver Node/npm usato dalla lane Codex degli articoli (era
 * condiviso con il fallback Haiku, spento dal proprietario il 2026-09-24).
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
const runtimeEnd = ACTION.indexOf('- name: Prepare Linux sandbox for Codex primary');
assert.ok(runtimeStart !== -1 && runtimeEnd > runtimeStart, 'blocco trusted toolchain non trovato');
const RUNTIME = ACTION.slice(runtimeStart, runtimeEnd);

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

test('nessuna coppia attestabile disattiva la lane CLI senza aggirare il controllo', () => {
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

// Decisione del proprietario del 2026-09-24 («Disattiva haiku! Voglio solo
// codex»): l'action non installa, non attesta e non pubblica piu' la CLI
// Claude. Qui stavano i test della sua installazione (prefisso root-owned,
// pulizia della cache npm con sudo, probe semver): il loro oggetto non esiste
// piu', e questo test impedisce che rientri in silenzio.
test('l\'action non installa ne\' pubblica la CLI Claude: la lane CLI e\' solo Codex', () => {
  // Solo outputs e steps: la `description` in testa nomina apposta cio' che
  // l'action NON fa piu'.
  const body = ACTION.slice(ACTION.indexOf('\ninputs:'));
  assert.doesNotMatch(body, /@anthropic-ai\/claude-code/);
  assert.doesNotMatch(body, /id: setup_claude_cli|claude_cli_bin|claude_cli_sha256/);
  assert.doesNotMatch(body, /CLAUDE_CLI_BIN=|CLAUDE_CLI_SHA256=/);
  assert.doesNotMatch(body, /ENABLE_HAIKU_ARTICLE_FALLBACK=1/);
  assert.doesNotMatch(body, /\/opt\/runner\/claude-haiku-cli/);
  assert.match(body, /@openai\/codex@0\.153\.4/);
  assert.match(body, /id: start_codex_auth_broker/);
});

test('la pulizia della cache npm scritta da root non può disattivare Haiku', () => {
  // Run 36001495484: CLI installata e attestata, poi `rm -rf "$install_root"`
  // senza sudo falliva con EACCES sulla cache npm scritta da root, e sotto
  // `set -e` la subshell usciva prima di pubblicare claude_cli_bin.
  const setupEnd = CLAUDE.indexOf('- name: Prepare Linux sandbox for Codex primary');
  assert.ok(setupEnd !== -1, 'fine dello step Claude CLI non trovata');
  const setup = CLAUDE.slice(0, setupEnd);
  assert.match(setup, /npm_config_cache="\$install_root\/cache"/);
  assert.match(setup, /"\$sudo_cmd" -n \/usr\/bin\/env -i "\$\{clean_env\[@\]\}"[^\n]*install --global/);
  const removals = setup
    .split('\n')
    .filter((line) => !line.trim().startsWith('#') && /\brm\b[^\n]*"\$install_root"/.test(line));
  assert.ok(removals.length > 0, 'la pulizia di $install_root non è stata trovata');
  for (const line of removals) {
    assert.match(line, /"\$sudo_cmd" -n \/usr\/bin\/rm -rf -- "\$install_root"/, `rimozione senza sudo: ${line.trim()}`);
  }
  const cleanup = setup.match(/"\$sudo_cmd" -n \/usr\/bin\/rm -rf -- "\$install_root"[^\n]*\n([^\n]*)/);
  assert.ok(cleanup, 'pulizia non trovata');
  assert.match(cleanup[0], /\\\n\s*\|\| echo "::warning::/, 'la pulizia deve restare non fatale');
  assert.ok(
    setup.indexOf(cleanup[0]) < setup.indexOf("printf 'claude_cli_bin=%s"),
    'la pulizia precede la pubblicazione del path attestato',
  );
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
