/**
 * transport-pr-body-contract.test.mjs — il body che il trasporto dei gemelli
 * `identical` scrive sulla sua PR rispetta il contratto del body che lo stesso
 * sistema impone a chiunque lo modifichi.
 *
 * Prima il workflow scriveva in `## Non implementato (ancora)` una voce
 * «Le voci `adapted` restano escluse per scelta; ...» senza `Motivo:` e senza
 * `Prossimo passo:`. Il gate locale `pr-body-check-gate` valuta i body nuovi in
 * modalita' strict (`decision-deferral-not-specific`), quindi ogni correzione
 * manuale del body di una PR di trasporto veniva respinta — e il rifiuto
 * consumava comunque il claim di `pr-body-write-gate` (PR corpus 2090,
 * run 37173895046). Il generatore produceva un artefatto che violava il
 * contratto: qui lo si genera con fixture rappresentative e lo si passa
 * all'evaluator, CI e strict.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBodyContract } from '../../scripts/lib/pr-body-contract-eval.mjs';
import { checkPrBodySections, decisionDeferralFindings } from '../../scripts/lib/pr-body-sections-check.mjs';
import {
  ADAPTED_DEFERRAL_BULLET,
  MANIFEST_PATH,
  buildTransportPrBody,
  parseTransportBullets,
  planTransportRealign,
} from '../../scripts/ci/transport-realign-body.mjs';

const h = (n) => n.toString(16).padStart(16, '0');

// Run 37173895046 (PR corpus 2090), ricostruita dal body pubblicato: 8 copie,
// di cui una con sitePath diverso, 10 convergenti, scope `workflows` presente.
const RUN_37173895046 = {
  transported: [
    ['scripts/ci/scan-job-timeouts.mjs'],
    ['scripts/ci/close-recovered-failure-issues.mjs'],
    ['scripts/ci/harvest-agent-lessons.mjs'],
    ['host/authors.ts', 'data/authors.ts'],
    ['scripts/generate-image-thumbnails.mjs'],
    ['generator/data/crawler-cross-repo-contract.json', '.github/corpus-workflows/contract.json'],
    ['.github/workflows/crawler-generation-observer-shadow.yml', '.github/corpus-workflows/observers/workflows/crawler-generation-observer-shadow.yml'],
    ['scripts/ci/reconcile-conflict-handoffs.mjs'],
  ].map(([p, sitePath = p], i) => ({ path: p, sitePath, from: h(i), to: h(100 + i) })),
  realign: [
    'scripts/ci/lib/review-findings.mjs',
    'scripts/ci/check-workflows-scope.mjs',
    'scripts/ci/claim-issue-in-flight.mjs',
    'scripts/lib/sanitize-control-chars.mjs',
    'scripts/lib/shard-git-helpers.sh',
    'generator/scripts/lib/article-locale-lexicon.mjs',
    'host/shell-contract-fingerprint.json',
    '.github/actions/claude-codex-fallback/bridge-transport.mjs',
    '.github/actions/claude-codex-fallback/gh-bridge-client.mjs',
    '.github/actions/claude-codex-fallback/git-bridge-client.mjs',
  ].map((p, i) => ({ path: p, hash: h(200 + i) })),
  couplingDelta: [],
};

const FIXTURES = [
  { name: 'run 37173895046 (copie + convergenti, scope presente)', report: RUN_37173895046, opts: { workflowsScope: true } },
  {
    name: 'solo convergenti, scope assente',
    report: { transported: [], realign: RUN_37173895046.realign.slice(0, 2) },
    opts: { workflowsScope: false },
  },
  {
    name: 'gemelli esclusi da realign e dal rifiuto dello scope',
    report: {
      transported: RUN_37173895046.transported.slice(0, 1),
      realign: [],
      couplingDelta: [{ path: 'scripts/ci/with`tick.mjs', added: ['a'], removed: [], initialized: true }],
      realignExcluded: ['scripts/ci/mismatch.mjs'],
      workflowExcluded: ['.github/workflows/needs-scope.yml'],
    },
    opts: { workflowsScope: false },
  },
  {
    name: 'scope presente ma rifiutato esplicitamente da GitHub',
    report: {
      transported: RUN_37173895046.transported.slice(0, 1),
      realign: [],
      workflowExcluded: ['.github/workflows/needs-scope.yml'],
    },
    opts: { workflowsScope: true },
  },
  { name: 'report vuoto', report: {}, opts: {} },
];

for (const { name, report, opts } of FIXTURES) {
  test(`body di trasporto conforme al contratto: ${name}`, () => {
    const body = buildTransportPrBody(report, opts);
    const ci = evaluateBodyContract(body);
    assert.equal(ci.blocking, 0, JSON.stringify({
      sections: ci.sections.violations, closes: ci.closes.violations, nextStep: ci.nextStepProblems,
    }));
    // Modalita' del gate locale `pr-body-check-gate` per ogni scrittura nuova.
    const strict = checkPrBodySections(body, { strictDecisionDeferrals: true });
    assert.deepEqual(strict.violations, []);
    // Il gate locale promuove anche i bullet senza stato a violazione.
    assert.deepEqual((strict.warnings ?? []).filter((w) => w.type === 'bullet-without-state'), []);
    assert.deepEqual(decisionDeferralFindings(body), []);
    // Ogni sezione ha voci sostanziose subito sotto l'header.
    assert.match(body, /^## Implementato\n- \S/m);
    assert.match(body, /^## Non implementato \(ancora\)\n- \S/m);
  });
}

test('la deroga sulle voci adapted porta Motivo e Prossimo passo concreti', () => {
  assert.match(ADAPTED_DEFERRAL_BULLET, /per scelta/);
  assert.match(ADAPTED_DEFERRAL_BULLET, /\*\*Motivo:\*\* \S.{8,}\*\*Prossimo passo:\*\* \S.{8,}$/);
  for (const opts of [{ workflowsScope: true }, { workflowsScope: false }]) {
    assert.ok(buildTransportPrBody(RUN_37173895046, opts).includes(ADAPTED_DEFERRAL_BULLET));
  }
});

test('lo scope workflows mancante resta un blocco tecnico, non una deroga decisionale', () => {
  const body = buildTransportPrBody({ transported: [] }, { workflowsScope: false });
  assert.match(body, /blocked: PAT_WORKFLOWS_SCOPE non è true per questa identità/);
  const withRejected = buildTransportPrBody({ transported: [], workflowExcluded: ['.github/workflows/x.yml'] }, { workflowsScope: false });
  assert.doesNotMatch(withRejected, /PAT_WORKFLOWS_SCOPE/, 'il rifiuto esplicito sostituisce la riga generica');
  assert.doesNotMatch(buildTransportPrBody({ transported: [] }, { workflowsScope: true }), /PAT_WORKFLOWS_SCOPE/);
  const rejectedWithScope = buildTransportPrBody(
    { transported: [], workflowExcluded: ['.github/workflows/x.yml'] },
    { workflowsScope: true },
  );
  assert.doesNotMatch(rejectedWithScope, /e' disponibile per questa identita'/, 'nessuna nota che contraddica il rifiuto esplicito');
});

test('il body generato resta leggibile dal realign post-merge', () => {
  const body = buildTransportPrBody(RUN_37173895046, { workflowsScope: true });
  assert.deepEqual(
    parseTransportBullets(body),
    RUN_37173895046.transported.map((t) => ({ path: t.path, siteHash: t.to })),
  );
  const manifest = {
    files: RUN_37173895046.transported.map((t) => ({ path: t.path, mode: 'identical' }))
      .concat(RUN_37173895046.realign.map((x) => ({ path: x.path, mode: 'identical' }))),
  };
  const plan = planTransportRealign({
    body,
    changedFiles: [MANIFEST_PATH, ...RUN_37173895046.transported.map((t) => t.path)],
    manifest,
  });
  assert.equal(plan.rows.length, RUN_37173895046.transported.length);
});
