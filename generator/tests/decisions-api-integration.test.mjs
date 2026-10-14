import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const createArticle = fs.readFileSync(path.join(ROOT, 'generator', 'scripts', 'create-article.mjs'), 'utf8');
const loadRemoteConfig = fs.readFileSync(path.join(ROOT, 'generator', 'scripts', 'load-rc-env.mjs'), 'utf8');

test('il gate pre-spend usa Decisions API solo dietro flag e conserva il percorso LLM storico', () => {
  assert.match(createArticle, /import \{ classifyWithDecisionsApi \} from '\.\/lib\/decisions-api\.mjs';/);
  assert.match(createArticle, /process\.env\.DECISION_API_ENABLED === '1'/);
  assert.match(createArticle, /tryDecisionsApiClassifier\(prompt, classifierCallTimeout, SECTION_NAME\)/);
  assert.match(createArticle, /timeoutMs,\n\s*\}\);/);
  assert.match(createArticle, /PRESPEND_DECISION_API_FALLBACK/);

  const decisionCall = createArticle.indexOf('return await classifyWithDecisionsApi(');
  const decisionBranch = createArticle.indexOf('const decision = await tryDecisionsApiClassifier(');
  const legacyCall = createArticle.indexOf('text = await _aiCallLLM(', decisionBranch);
  assert.ok(decisionCall >= 0, 'la chiamata Decisions API non è cablata');
  assert.ok(legacyCall > decisionBranch, 'il classifier LLM storico deve restare il fallback');
});

test('Remote Config espone chiave server-only e flag di rollout', () => {
  assert.match(loadRemoteConfig, /DECISION_API_KEY:\s+\['DECISION_API_KEY'\]/);
  assert.match(loadRemoteConfig, /DECISION_API_ENABLED:\s+\['DECISION_API_ENABLED'\]/);
  assert.match(loadRemoteConfig, /'DECISION_API_ENABLED'/);
  assert.doesNotMatch(loadRemoteConfig, /DECISION_API_KEY:\s+\['[^']*VITE_/);
});
