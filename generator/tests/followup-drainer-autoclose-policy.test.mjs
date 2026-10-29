import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workflowPath = fileURLToPath(new URL('../../.github/workflows/followup-drainer.yml', import.meta.url));
const drainerPath = fileURLToPath(new URL('../../scripts/ci/followup-drainer.mjs', import.meta.url));
const workflow = readFileSync(workflowPath, 'utf8');
const drainer = readFileSync(drainerPath, 'utf8');

test('il cron lascia attiva la chiusura verificata e conserva l override di emergenza', () => {
  assert.match(workflow, /FOLLOWUP_CODEX_FALLBACK_MODE: '1'/);
  assert.doesNotMatch(workflow, /^\s+FOLLOWUP_NO_AUTOCLOSE:\s*['"]1['"]/m);
  assert.match(workflow, /FOLLOWUP_NO_AUTOCLOSE:\s*\$\{\{[\s\S]*?inputs\.no_autoclose/);
  assert.match(drainer, /process\.env\.FOLLOWUP_NO_AUTOCLOSE === '1'/);
  assert.match(drainer, /already-fixed: difetto verificato assente/);
  assert.match(drainer, /already-fixed, autoclose disattivato/);
  assert.match(drainer, /manifestPinLookup/);
  assert.match(drainer, /hasPR: hasFixPR\(iss\.number, \{ failClosed: true \}\)/);
  assert.match(drainer, /outcomeForCurrentPromotion\(\{/);
});
