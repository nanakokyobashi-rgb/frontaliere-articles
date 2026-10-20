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
 * Anche il mirror `engine-lockstep-auto` deve ricevere body contract e review:
 * la review del sito non produce il verdetto richiesto dal corpus.
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
function requiredCheckOutcome({
  step,
  eventName,
  draft,
  headRef = '',
  headRepoIsCurrent = false,
  prNumber = '',
  reviewGateOutcome,
}) {
  const failClosedGuard =
    /always\(\)/.test(step) &&
    /github\.event_name\s*==\s*['"]pull_request['"]/.test(step) &&
    /github\.event\.pull_request\.draft\s*==\s*false/.test(step) &&
    /github\.event_name\s*==\s*['"]workflow_dispatch['"]/.test(step) &&
    /inputs\.pr_number\s*!=\s*''/.test(step) &&
    /steps\.review_gate\.outcome\s*==\s*['"]skipped['"]/.test(step) &&
    /\bexit\s+1\b/.test(step);
  const mirrorExemption =
    /github\.event_name\s*!=\s*['"]pull_request['"]/.test(step) &&
    /github\.event\.pull_request\.head\.ref\s*!=\s*['"]engine-lockstep-auto['"]/.test(step) &&
    /github\.event\.pull_request\.head\.repo\.full_name\s*!=\s*github\.repository/.test(step);
  const reviewRequiredEvent =
    (eventName === 'pull_request' && draft === false) ||
    (eventName === 'workflow_dispatch' && prNumber !== '');
  const mirrorIsExempt = headRef === 'engine-lockstep-auto' && headRepoIsCurrent && mirrorExemption;

  return failClosedGuard && !mirrorIsExempt && reviewRequiredEvent && reviewGateOutcome === 'skipped'
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
        headRef: 'engine-lockstep-auto',
        headRepoIsCurrent: true,
        reviewGateOutcome: 'skipped',
      }),
      requiredCheckOutcome({
        step,
        eventName: 'pull_request',
        draft: false,
        headRef: 'engine-lockstep-auto',
        headRepoIsCurrent: false,
        reviewGateOutcome: 'skipped',
      }),
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
      requiredCheckOutcome({
        step,
        eventName: 'pull_request',
        draft: true,
        reviewGateOutcome: 'skipped',
      }),
      requiredCheckOutcome({
        step,
        eventName: 'workflow_dispatch',
        draft: false,
        prNumber: '3018',
        reviewGateOutcome: 'skipped',
      }),
      requiredCheckOutcome({
        step,
        eventName: 'workflow_dispatch',
        draft: false,
        prNumber: '',
        reviewGateOutcome: 'skipped',
      }),
    ],
    ['failure', 'failure', 'failure', 'success', 'success', 'success', 'failure', 'success'],
    'Ogni PR non-draft, incluso il mirror sullo stesso repo, il branch omonimo da fork e una PR di recovery, deve fallire se il review gate viene saltato.',
  );

  const bodyContract = stepBlock(yaml, 'PR-body completeness + multi-issue Closes (zero-Claude)');
  assert.match(bodyContract, /github\.event\.pull_request\.draft\s*==\s*false/);
  assert.doesNotMatch(bodyContract, /head\.ref\s*!=\s*['"]engine-lockstep-auto['"]/);
  assert.doesNotMatch(bodyContract, /head\.repo\.full_name\s*!=\s*github\.repository/);
});

test('workflow_dispatch risolve e valida la base PR prima dei gate diff-scoped', () => {
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
  assert.match(
    yaml,
    /\n\s+base_sha:\n\s+description:/,
    'Il dispatch di recovery deve dichiarare la SHA esatta della base della PR.',
  );
  const recoveryBase = stepBlock(yaml, 'Resolve and validate recovery base SHA');
  assert.match(recoveryBase, /github\.event_name/);
  assert.match(recoveryBase, /inputs\.pr_number/);
  assert.match(recoveryBase, /inputs\.base_sha/);
  assert.match(recoveryBase, /gh api/);
  assert.match(recoveryBase, /\.base\.sha/);
  assert.match(recoveryBase, /INPUT_BASE_SHA.*resolved_base/);
  assert.match(recoveryBase, /match_count/);
  assert.match(recoveryBase, /base_sha=.*GITHUB_OUTPUT/);
  assert.match(recoveryBase, /exit 1/);

  const recoveryBaseOffset = yaml.indexOf('- name: Resolve and validate recovery base SHA');
  for (const name of [
    'Baseline verificabili nel manifest del ciclo (diff-scoped)',
    'Gemelli aggiunti dalla PR dichiarati nel manifest (diff-scoped)',
  ]) {
    const block = stepBlock(yaml, name);
    assert.match(
      block,
      /BASE_SHA:\s+\$\{\{\s*steps\.recovery_base\.outputs\.base_sha\s*\}\}/,
      `${name} deve usare la base SHA verificata prima del gate.`,
    );
    assert.ok(
      recoveryBaseOffset < yaml.indexOf(`- name: ${name}`),
      `La base verificata deve essere risolta prima di ${name}.`,
    );
  }
  const bodyContract = stepBlock(yaml, 'PR-body completeness + multi-issue Closes (zero-Claude)');
  assert.match(bodyContract, /inputs\.pr_number/);
  const resolve = stepBlock(yaml, 'Resolve PR');
  assert.match(resolve, /github\.event_name == 'workflow_dispatch'/);
  assert.match(resolve, /github\.event\.pull_request\.number \|\| inputs\.pr_number/);
  assert.match(resolve, /inputs\.head_sha \|\| github\.event\.pull_request\.head\.sha \|\| github\.sha/);
  assert.match(resolve, /La PR indicata deve essere aperta e non draft/);
  assert.match(resolve, /should_review=true/);
  assert.doesNotMatch(resolve, /github\.event\.pull_request\.head\.ref\s*!=\s*['"]engine-lockstep-auto['"]/);
  assert.doesNotMatch(resolve, /engine-lockstep-auto del repository/);
  const skipped = stepBlock(yaml, 'Fail when required review gate is skipped');
  assert.match(skipped, /github\.event_name == 'workflow_dispatch'/);
  assert.match(skipped, /inputs\.pr_number/);
  assert.doesNotMatch(skipped, /head\.ref\s*!=\s*['"]engine-lockstep-auto['"]/);
  assert.doesNotMatch(skipped, /head\.repo\.full_name\s*!=\s*github\.repository/);

});
