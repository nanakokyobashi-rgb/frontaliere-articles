/**
 * review-required-check-skipped.test.mjs — il check richiesto non puo'
 * diventare verde quando il review gate non e' stato valutato.
 *
 * GitHub considera verde un check richiesto che termina `skipped`. Per questo
 * il solo `if: always()` sul gate non basta: un `Resolve PR` saltato puo'
 * lasciare l'intero job verde senza che `review-gate.mjs` abbia mai deciso.
 * L'invariante qui sotto modella il comportamento osservabile del workflow:
 * su una PR non-draft, `review_gate=skipped` deve essere un fallimento del job;
 * sugli eventi che non richiedono una review non deve diventare un falso rosso.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = path.join(ROOT, '.github/workflows/tests.yml');
const yaml = fs.readFileSync(WORKFLOW, 'utf8');

function stepBlock(src, name) {
  const lines = src.split('\n');
  const literal = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const at = lines.findIndex((line) => new RegExp(`^\\s*-\\s+name:\\s*${literal}\\s*$`).test(line));
  assert.notEqual(at, -1, `tests.yml non ha lo step "${name}"`);
  const out = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    if (/^\s*-\s+name:\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

/**
 * Valuta l'invariante dal contratto dichiarato nello step, non solo la sua
 * presenza. Se lo YAML perde la guardia o l'exit non-zero, il caso skipped
 * torna verde e questo test lo espone.
 */
function requiredCheckOutcome({ step, eventName, draft, reviewGateOutcome }) {
  const failClosedGuard =
    /always\(\)/.test(step) &&
    /github\.event_name\s*==\s*['"]pull_request['"]/.test(step) &&
    /github\.event\.pull_request\.draft\s*==\s*false/.test(step) &&
    /steps\.review_gate\.outcome\s*==\s*['"]skipped['"]/.test(step) &&
    /\bexit\s+1\b/.test(step);

  return failClosedGuard && eventName === 'pull_request' && draft === false && reviewGateOutcome === 'skipped'
    ? 'failure'
    : 'success';
}

test('un run PR che soddisfa il check con review gate skipped deve essere rosso', () => {
  const step = stepBlock(yaml, 'Fail when required review gate is skipped');

  assert.deepEqual(
    [
      requiredCheckOutcome({
        step,
        eventName: 'pull_request',
        draft: false,
        reviewGateOutcome: 'skipped',
      }),
      requiredCheckOutcome({
        step,
        eventName: 'pull_request',
        draft: false,
        reviewGateOutcome: 'failure',
      }),
      requiredCheckOutcome({
        step,
        eventName: 'push',
        draft: false,
        reviewGateOutcome: 'skipped',
      }),
    ],
    ['failure', 'success', 'success'],
    'Una PR con il review gate skipped non deve poter soddisfare verde il check richiesto.',
  );
});

test('workflow_dispatch con `pr_number` può eseguire il gate completo su una PR reale', () => {
  assert.match(
    yaml,
    /workflow_dispatch:\n\s+inputs:\n\s+pr_number:/,
    'Il dispatch manuale deve dichiarare l input della PR da verificare.',
  );
  assert.match(
    yaml,
    /\n\s+head_sha:\n\s+description:/,
    'Il dispatch di recovery deve dichiarare la SHA esatta passata dal workflow trusted.',
  );
  const bodyContract = stepBlock(yaml, 'PR-body completeness + multi-issue Closes (zero-Claude)');
  assert.match(bodyContract, /inputs\.pr_number/);
  const resolve = stepBlock(yaml, 'Resolve PR');
  assert.match(resolve, /github\.event_name == 'workflow_dispatch'/);
  assert.match(resolve, /github\.event\.pull_request\.number \|\| inputs\.pr_number/);
  assert.match(resolve, /inputs\.head_sha \|\| github\.event\.pull_request\.head\.sha \|\| github\.sha/);
  assert.match(resolve, /La PR indicata deve essere aperta, non draft/);
  const skipped = stepBlock(yaml, 'Fail when required review gate is skipped');
  assert.match(skipped, /github\.event_name == 'workflow_dispatch'/);
  assert.match(skipped, /inputs\.pr_number/);
});
