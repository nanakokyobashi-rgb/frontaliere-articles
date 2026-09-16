import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW = fs.readFileSync(path.join(HERE, '../../.github/workflows/generate-article.yml'), 'utf8');
const FAQ_WORKFLOW = fs.readFileSync(path.join(HERE, '../../.github/workflows/batch-faq-articles.yml'), 'utf8');

test('Generate Blog Article esegue il preflight dopo il setup opzionale e prima della generazione', () => {
  const setup = WORKFLOW.indexOf('id: setup_claude_haiku_fallback');
  const preflight = WORKFLOW.indexOf('id: provider_preflight');
  const generate = WORKFLOW.indexOf('- name: Generate the article');
  assert.ok(setup >= 0 && preflight > setup && generate > preflight);
  assert.match(WORKFLOW.slice(preflight, generate), /node generator\/scripts\/lib\/provider-preflight\.mjs/);
  assert.match(WORKFLOW.slice(preflight, generate), /PROVIDER_PREFLIGHT_OUTPUT:/);
  assert.match(WORKFLOW.slice(preflight, generate), /CODEX_AUTH_BROKER_SOCKET:/);
  assert.match(WORKFLOW.slice(preflight, generate), /CLAUDE_CODE_OAUTH_TOKEN:/);
  assert.match(WORKFLOW.slice(preflight, generate), /Upload provider preflight report/);
  assert.match(WORKFLOW.slice(preflight, generate), /actions\/upload-artifact@v4/);
  const nextStep = WORKFLOW.indexOf('\n      - ', generate + 1);
  const generateBlock = WORKFLOW.slice(generate, nextStep === -1 ? undefined : nextStep);
  assert.match(generateBlock, /CLAUDE_CODE_OAUTH_TOKEN:/);
  assert.match(generateBlock, /CODEX_AUTH_BROKER_SOCKET:/);
});

test('il dry-run non viene bloccato dal preflight che richiede una lane attiva', () => {
  const start = WORKFLOW.indexOf('id: provider_preflight');
  const end = WORKFLOW.indexOf('# Dry mode stops here', start);
  assert.match(WORKFLOW.slice(start, end), /if: steps\.mode\.outputs\.dry != 'true'/);
});

test('anche il batch FAQ usa lo stesso preflight e non il solo PAT GitHub', () => {
  const start = FAQ_WORKFLOW.indexOf('id: provider_preflight');
  assert.ok(start >= 0);
  const upload = FAQ_WORKFLOW.indexOf('- name: Upload provider preflight report', start);
  assert.ok(upload > start);
  const block = FAQ_WORKFLOW.slice(start, upload + 300);
  assert.match(block, /node generator\/scripts\/lib\/provider-preflight\.mjs/);
  assert.match(block, /PROVIDER_PREFLIGHT_OUTPUT:/);
  assert.match(block, /if: steps\.mode\.outputs\.dry != 'true'/);
  assert.match(block, /Upload provider preflight report/);
  assert.doesNotMatch(block, /GH_MODELS_PAT/);
});
