import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(
  new URL('../../.github/workflows/fast-publish-section.yml', import.meta.url),
  'utf8',
);
const resolver = readFileSync(
  new URL('../../scripts/ci/fast-publish-section-resolve.sh', import.meta.url),
  'utf8',
);
const render = readFileSync(
  new URL('../../scripts/ci/fast-publish-section-render.sh', import.meta.url),
  'utf8',
);

function triggerBlock(name) {
  const start = workflow.indexOf(`\n  ${name}:`);
  assert.ok(start >= 0, `trigger ${name} missing`);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n  [A-Za-z_][A-Za-z0-9_-]*:/u);
  return next < 0 ? rest : rest.slice(0, next);
}

test('fast-publish-section non crea run push sui branch di PR', () => {
  const push = triggerBlock('push');
  assert.match(push, /\n    branches: \[main\]/u);
  assert.doesNotMatch(push, /branches-ignore/u);
  assert.doesNotMatch(workflow.slice(workflow.indexOf('\non:')), /\n  pull_request:/u);
});

test('fast-publish-section limita i replay workflow_run a publish-api verde su main', () => {
  const run = triggerBlock('workflow_run');
  assert.match(run, /workflows: \['Publish article data API'\]/u);
  assert.match(run, /types: \[completed\]/u);
  assert.match(run, /branches: \[main\]/u);

  const resolve = workflow.slice(workflow.indexOf('\n  resolve:'), workflow.indexOf('\n  plan:'));
  assert.match(resolve, /github\.event\.workflow_run\.conclusion == 'success'/u);
  assert.match(resolve, /github\.event\.workflow_run\.head_branch == 'main'/u);
});

test('fast-publish-section mantiene il contratto dispatch esplicito', () => {
  const dispatch = triggerBlock('workflow_dispatch');
  assert.match(dispatch, /section:/u);
  assert.match(dispatch, /required: true/u);
  assert.match(dispatch, /bootstrap:/u);
  assert.match(dispatch, /push_before:/u);
  assert.match(dispatch, /push_after:/u);
});

test('fast-publish-section ricontrolla main subito prima del replay API', () => {
  const replay = workflow.slice(workflow.indexOf('\n  replay-api-after-staged-release:'));
  const dispatchStep = replay.slice(replay.indexOf('- name: Replay publish-api after staged release'));
  const guardIndex = dispatchStep.indexOf('verifyMainHeadAtDispatch() {');
  const dispatchIndex = dispatchStep.indexOf('gh workflow run publish-api.yml');

  assert.ok(guardIndex >= 0, 'manca il controllo finale della HEAD di main');
  assert.ok(dispatchIndex > guardIndex, 'il dispatch deve avvenire dopo il controllo finale');
  assert.match(dispatchStep, /current_main="\$\(bash scripts\/ci\/read-main-head\.sh\)"/u);
  assert.match(dispatchStep, /\[ "\$current_main" != "\$SOURCE_COMMIT" \]/u);
  assert.match(dispatchStep, /replay API interrotto/u);
  assert.match(dispatchStep, /if verifyMainHeadAtDispatch; then/u);
});

test('il replay checkout mantiene tutti gli helper nel profilo sparse', () => {
  const replay = workflow.slice(workflow.indexOf('\n  replay-api-after-staged-release:'));
  const checkout = replay.slice(
    replay.indexOf('- name: Checkout replay dispatcher from workflow revision'),
    replay.indexOf('- name: Materialize freshness helper from workflow revision'),
  );

  assert.match(checkout, /sparse-checkout:\s*\|/u);
  assert.match(checkout, /scripts\/ci\/dispatch-fast-publish-replay\.sh[\s\S]*scripts\/ci\/read-main-head\.sh/u);
});

test('fast-publish-section mantiene il resolver sotto il limite del parser GitHub', () => {
  assert.match(workflow, /- name: Materialize resolver from workflow revision/u);
  assert.match(workflow, /scripts\/ci\/fast-publish-section-resolve\.sh/u);
  const resolve = workflow.slice(
    workflow.indexOf('\n      - name: Resolve sections and article ids'),
    workflow.indexOf('\n      - name: Arm normal push staged replay'),
  );
  assert.match(resolve, /run: \|\n\s+bash scripts\/ci\/fast-publish-section-resolve\.sh/u);
  assert.ok(resolver.length < 21_000, `resolver too large: ${resolver.length}`);
  assert.match(resolver, /reconcile_edge_matrix\(\)/u);
  assert.match(resolver, /GITHUB_OUTPUT/u);
  assert.match(resolver, /FAST_PUBLISH_ARMED/u);
  assert.doesNotMatch(resolver, /\$\{\{/u);
});

test('fast-publish-section conserva la guardia di freschezza anche con checkout pinned precedente', () => {
  const materializers = [...workflow.matchAll(/- name: Materialize (?:resolver|freshness helper) from workflow revision[\s\S]*?(?=\n      - name:|\n  [A-Za-z_][A-Za-z0-9_-]*:|$)/gu)]
    .map((match) => match[0]);
  assert.equal(materializers.length, 3, 'ogni job che legge main deve materializzare la guardia');
  for (const block of materializers) {
    assert.match(block, /if \[ -f "\$(?:source|main_head_source)" \]; then/u);
    assert.match(block, /elif \[ -f "\$(?:target|main_head_target)" \]; then/u);
    assert.match(block, /fallback git-transport/u);
    assert.match(block, /git ls-remote --refs/u);
    assert.match(block, /timeout 60/u);
    assert.doesNotMatch(block, /helper della punta di main non presente.*exit 1/u);
  }
});

test('fast-publish-section delega i blocchi shell grandi a script senza espressioni YAML', () => {
  for (const name of [
    'preflight',
    'render',
    'recovery',
  ]) {
    const path = `scripts/ci/fast-publish-section-${name}.sh`;
    assert.match(workflow, new RegExp(`run: bash ${path.replaceAll('/', '\\/')}`));
    const source = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
    assert.match(source, /^#!\/usr\/bin\/env bash/u);
    assert.match(source, /^set -euo pipefail$/mu);
    assert.doesNotMatch(source, /\$\{\{/u);
  }
});

test('una gara stale consegna la sezione al coordinatore senza dichiarare una pubblicazione', () => {
  assert.doesNotMatch(render, /dispatch_stale_handoff\(\)/u);
  assert.match(render, /echo "stale_handoff=true" >> "\$GITHUB_OUTPUT"/u);
  assert.match(render, /echo "stale_handoff_head=\$handoff_head" >> "\$GITHUB_OUTPUT"/u);
  assert.match(render, /coordinatore della matrice/u);
  assert.doesNotMatch(
    render,
    /main e' avanzata durante tre tentativi di render del publisher[\s\S]*exit 1/u,
    'tre avanzamenti concorrenti devono accodare il replay, non lasciare il producer rosso',
  );
  assert.match(workflow, /STALE_HANDOFF: \$\{\{ steps\.render\.outputs\.stale_handoff \}\}/u);
  assert.match(workflow, /stale_handoff: \$stale_handoff/u);
  assert.match(workflow, /stale_handoff: \$\{\{ steps\.collect\.outputs\.stale_handoff \}\}/u);
  assert.match(workflow, /echo 'mixed_matrix=true' >> "\$GITHUB_OUTPUT"/u);
  assert.doesNotMatch(workflow, /needs\.publish_release_head\.outputs\.stale_handoff != 'true'/u);
  assert.match(
    workflow,
    /all\(\.\[\]; \(\.rendered_head == "" and \(\(\.stale_handoff == "true"\) or \(\.fresh == "false"\)\)\)\)/u,
  );
  assert.ok(
    workflow.includes('(.stale_handoff // "") == "true"'),
    'una matrix mista deve ricorrere al recovery, non annunciare una release parziale',
  );
  assert.match(workflow, /steps\.replay_freshness\.outputs\.current_main \|\| needs\.publish_release_head\.outputs\.rendered_head/u);
  assert.match(workflow, /steps\.replay_freshness\.outputs\.fresh == 'false'[\s\S]*needs\.publish_release_head\.outputs\.mixed_matrix == 'true'/u);
});
