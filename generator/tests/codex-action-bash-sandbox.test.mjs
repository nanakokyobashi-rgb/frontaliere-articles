/**
 * Contratto dei caller dell'action provider-neutral: Codex è il primario,
 * mentre la compatibilità Claude resta opzionale e non viene attivata dai
 * workflow che non forniscono il token.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');
const WF_DIR = resolve(ROOT, '.github/workflows');
const ACTION_FILE = resolve(ROOT, '.github/actions/claude-codex-fallback/action.yml');
const CODEX_ACTION = /uses:\s*\.\/\.github\/actions\/claude-codex-fallback/;
const LEGACY_INPUT = /^(?:\s*)(allowed_non_write_users|allowed_bots|claude_args|claude_code_oauth_token):\s*/gm;

function stepBlocks(text) {
  const blocks = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (/^ {6}- /.test(line)) {
      if (current) blocks.push(current.join('\n'));
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) blocks.push(current.join('\n'));
  return blocks;
}

function codexSteps() {
  const out = [];
  for (const file of readdirSync(WF_DIR).filter((name) => /\.ya?ml$/.test(name)).sort()) {
    const source = readFileSync(join(WF_DIR, file), 'utf8');
    for (const block of stepBlocks(source)) {
      if (!CODEX_ACTION.test(block)) continue;
      out.push({ file, block, legacyInputs: [...block.matchAll(LEGACY_INPUT)].map((m) => m[1]) });
    }
  }
  return out;
}

test('il censimento degli step Codex non è vuoto', () => {
  assert.ok(codexSteps().length >= 5, 'i workflow non invocano più il lane Codex');
});

test('i caller Codex non attivano implicitamente il fallback Claude', () => {
  const callers = codexSteps();
  assert.deepEqual(
    callers.filter((step) => step.legacyInputs.length > 0).map((step) => step.file),
    [],
    'un caller sta passando input legacy che possono attivare il fallback Claude',
  );
});

test('l’action dichiara Codex primario e fallback Claude bounded', () => {
  const action = readFileSync(ACTION_FILE, 'utf8');
  assert.match(action, /Codex Luna Max primary with optional Claude fallback/);
  assert.match(action, /steps\.codex\.outcome == 'failure'/);
  assert.match(action, /steps\.codex\.outputs\.side_effect_detected == 'false'/);
  assert.match(action, /claude_code_oauth_token/);
});

test('post-merge-followup non porta variabili di sandbox Claude', () => {
  const followup = codexSteps().find((step) => step.file === 'post-merge-followup.yml');
  assert.ok(followup, 'post-merge-followup.yml non usa il lane Codex');
  assert.doesNotMatch(followup.block, /CLAUDE_CODE_SUBPROCESS_ENV_SCRUB/);
  assert.doesNotMatch(followup.block, /MAX_THINKING_TOKENS/);
});
