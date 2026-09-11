/**
 * Contract test for the Codex-primary / Claude-fallback wiring.
 *
 * The composite action owns the raw OAuth JSON and exposes only its broker
 * socket. Every workflow consumer must carry that capability to its generator
 * process and clean it up even after a failed run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SOCKET = '${{ steps.setup_claude_haiku_fallback.outputs.codex_auth_broker_socket }}';
const SECRET = '${{ secrets.CODEX_AUTH_JSON }}';
const ACTION = './.github/actions/setup-claude-haiku-fallback';
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const workflowFiles = fs
  .readdirSync(path.join(ROOT, '.github/workflows'))
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .map((name) => `.github/workflows/${name}`)
  .filter((rel) => read(rel).split('\n').some((line) =>
    /^\s*-?\s*uses:\s*\.\/\.github\/actions\/setup-claude-haiku-fallback\s*$/.test(line),
  ));

function stepBlock(lines, index) {
  const current = /^(\s*)-\s/.exec(lines[index]);
  const currentIndent = lines[index].match(/^\s*/)[0].length;
  let start = index;
  let stepIndent = current?.[1].length ?? -1;
  if (!current) {
    while (start > 0) {
      const match = /^(\s*)-\s/.exec(lines[start]);
      if (match && match[1].length < currentIndent) {
        stepIndent = match[1].length;
        break;
      }
      start -= 1;
    }
  }
  assert.notEqual(stepIndent, -1, 'workflow step boundary not found');
  let end = index + 1;
  while (end < lines.length) {
    const match = /^(\s*)-\s/.exec(lines[end]);
    if (match && match[1].length <= stepIndent) break;
    end += 1;
  }
  return lines.slice(start, end).join('\n');
}

test('every active article CLI caller wires the OAuth Codex broker', () => {
  assert.equal(workflowFiles.length, 25, 'caller inventory changed: review new/removed consumers');
  for (const rel of workflowFiles) {
    const source = read(rel);
    const lines = source.split('\n');
    const setupIndex = lines.findIndex((line) => line.includes(`uses: ${ACTION}`));
    assert.notEqual(setupIndex, -1, `${rel}: setup action missing`);
    const setup = stepBlock(lines, setupIndex);
    assert.match(setup, /id:\s*setup_claude_haiku_fallback/, `${rel}: setup step needs a stable id`);
    assert.match(setup, new RegExp(String.raw`codex_auth_json:\s*${escapeRegex(SECRET)}`), `${rel}: raw Codex OAuth secret must stay on setup`);

    const oauthIndexes = lines
      .map((line, index) => /^\s+CLAUDE_CODE_OAUTH_TOKEN:/.test(line) ? index : -1)
      .filter((index) => index >= 0);
    assert.ok(oauthIndexes.length > 0, `${rel}: no Claude generator consumer found`);
    for (const index of oauthIndexes) {
      assert.match(stepBlock(lines, index), new RegExp(escapeRegex(SOCKET)), `${rel}: Claude consumer lacks broker socket`);
    }

    const cleanupIndex = lines.findIndex((line) => line.includes('- name: Cleanup Codex auth broker'));
    assert.notEqual(cleanupIndex, -1, `${rel}: broker cleanup step missing`);
    const cleanup = stepBlock(lines, cleanupIndex);
    assert.match(cleanup, /if:\s*always\(\)/, `${rel}: cleanup must run always`);
    assert.match(cleanup, /continue-on-error:\s*true/, `${rel}: cleanup must be best-effort`);
    assert.match(cleanup, new RegExp(escapeRegex(SOCKET)), `${rel}: cleanup lacks broker socket`);
    assert.match(cleanup, /--cleanup\s+--socket\s+"\$CODEX_AUTH_BROKER_SOCKET"/, `${rel}: cleanup command incomplete`);
    assert.equal((source.match(/CODEX_AUTH_JSON/g) ?? []).length, 1, `${rel}: raw Codex OAuth leaked beyond setup input`);
  }
});

test('Codex primary keeps the pinned OAuth model and is ordered before Claude', () => {
  const aiModels = read('generator/scripts/lib/ai-models.mjs');
  const createArticle = read('generator/scripts/create-article.mjs');
  const action = read('.github/actions/setup-claude-haiku-fallback/action.yml');
  const broker = read('.github/actions/setup-claude-haiku-fallback/codex-auth-broker.mjs');
  assert.match(aiModels, /CODEX_CLI_PRIMARY:\s*`codex-cli\/\$\{CODEX_FALLBACK_MODEL\}`/);
  assert.match(aiModels, /if \(model\.startsWith\('codex-cli\/'\)\)/);
  assert.match(aiModels, /case PROVIDER\.CODEX_CLI:\s+return _callCodexCli/);
  assert.match(aiModels, /_claimCodexCliFallback\(\)/);
  assert.doesNotMatch(aiModels, /_tryCodexCliUsageLimitFallback/);
  const preferenceStart = createArticle.indexOf('const PREFERRED_GENERATION_MODELS');
  const codexPreference = createArticle.indexOf('AI_MODELS.CODEX_CLI_PRIMARY', preferenceStart);
  const claudePreference = createArticle.indexOf('AI_MODELS.CLAUDE_CLI_HAIKU', preferenceStart);
  assert.ok(preferenceStart >= 0 && codexPreference >= 0 && claudePreference > codexPreference, 'Codex must precede Claude in the article preference');
  assert.match(action, /name: "Setup Codex primary with Claude fallback"/);
  assert.doesNotMatch(action, /indirect Codex fallback/);
  assert.match(broker, /CODEX_MODEL\s*=\s*['"]gpt-5\.6-luna['"]/);
  assert.match(broker, /CODEX_EFFORT\s*=\s*['"]medium['"]/);
});
