/**
 * GitHub Actions evaluates `env.*` expressions before values appended to
 * GITHUB_ENV are available to later shell steps.  Keep the loop's
 * control-plane consumers on the runtime side of that boundary: expressions
 * may select the runner token, while the Remote Config token is selected only
 * from the shell environment and passed to the child command there.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../..', import.meta.url);
const workflows = [
  'followup-drainer.yml',
  'issue-fix.yml',
  'issue-triage.yml',
  'pr-autorebase.yml',
  'pr-redcheck-fixer.yml',
  'recycle-stale-prs.yml',
  'transport-identical-twins.yml',
  'transport-identical-twins-realign.yml',
];

const source = (file) => readFileSync(new URL(`.github/workflows/${file}`, root), 'utf8');

test('i consumer del loop non usano env.* per decidere la presenza del token runtime', () => {
  for (const file of workflows) {
    const yaml = source(file);
    assert.doesNotMatch(
      yaml,
      /if:\s*[^\n]*env\.(?:APP_TOKEN|GITHUB_PAT(?:_NANAKO)?)/,
      `${file}: una condizione env.* può essere valutata prima del GITHUB_ENV runtime`,
    );
    assert.doesNotMatch(
      yaml,
      /(?:GH_TOKEN|PUSH_TOKEN|PAT|ROUTING_TOKEN|SITE_TOKEN):\s*\$\{\{\s*env\.(?:APP_TOKEN|GITHUB_PAT(?:_NANAKO)?)\s*\}\}/,
      `${file}: il token operativo deve essere passato dal guscio runtime`,
    );
  }
});

test('gli alert token-down leggono la disponibilità dalla shell runtime', () => {
  for (const file of [
    'followup-drainer.yml',
    'issue-triage.yml',
    'pr-autorebase.yml',
    'pr-redcheck-fixer.yml',
    'recycle-stale-prs.yml',
  ]) {
    const yaml = source(file);
    assert.match(yaml, /Alert token-down[\s\S]*?if: always\(\)[\s\S]*?Token operativo runtime disponibile/,
      `${file}: alert token-down non protetto dalla verifica runtime`);
  }
});

test('ogni consumer critico re-inietta il token runtime nel comando che muta GitHub', () => {
  const required = {
    'followup-drainer.yml': /GH_TOKEN="\$runtime_pat" node scripts\/ci\/followup-drainer\.mjs/,
    'issue-fix.yml': /SITE_TOKEN="\$\{GITHUB_PAT:-\}" node scripts\/ci\/handoff-to-site\.mjs/,
    'issue-triage.yml': /GITHUB_PAT="\$runtime_pat" node scripts\/ci\/triage-sweep\.mjs/,
    'pr-autorebase.yml': /GH_TOKEN="\$runtime_pat" node scripts\/ci\/pr-autorebase\.mjs/,
    'pr-redcheck-fixer.yml': /push_token="\$\{GITHUB_PAT_NANAKO:-\}"/,
    'recycle-stale-prs.yml': /runtime_token="\$\{APP_TOKEN:-\$\{GITHUB_PAT_NANAKO:-\}\}"/,
    'transport-identical-twins.yml': /PUSH_TOKEN="\$GITHUB_PAT_NANAKO" node scripts\/ci\/probe-workflow-scope\.mjs/,
    'transport-identical-twins-realign.yml': /export GH_TOKEN="\$runtime_pat"/,
  };
  for (const [file, pattern] of Object.entries(required)) {
    assert.match(source(file), pattern, `${file}: manca il passaggio runtime del token`);
  }
});
