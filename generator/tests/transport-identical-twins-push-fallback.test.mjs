/**
 * Copre il fallback del push del trasporto: solo il rifiuto GitHub esplicito
 * dei workflow abilita il secondo tentativo, e il manifest/report perdono solo
 * quei path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyWorkflowPushFailure,
  isWorkflowPath,
  removeWorkflowPathsFromReport,
  restoreWorkflowSnapshots,
  selectWorkflowFallbackPaths,
} from '../../scripts/transport-identical-twins-push-fallback.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const refusal = [
  'remote: error: refusing to allow a GitHub App to create or update workflow .github/workflows/crawler-group-01.yml without workflows permission.',
  'To https://github.com/nanakokyobashi-rgb/frontaliere-articles.git',
].join('\n');

test('classifica il rifiuto GitHub esplicito di un workflow', () => {
  assert.deepEqual(classifyWorkflowPushFailure(refusal), {
    kind: 'workflow-permission',
    fallback: true,
    rejectedPaths: ['.github/workflows/crawler-group-01.yml'],
  });
});

test('un errore diverso, anche su un workflow, non abilita il fallback', () => {
  const outputs = [
    'remote: error: GH006: Protected branch update failed',
    'remote: error: refusing to allow a GitHub App to create or update workflow .github/workflows/x.yml without repository permission.',
    'remote: error: refusing to allow a user to create or update workflow .github/workflows/x.yml without workflows permission.',
  ];
  for (const output of outputs) {
    assert.deepEqual(classifyWorkflowPushFailure(output), {
      kind: 'other',
      fallback: false,
      rejectedPaths: [],
    });
  }
});

test('il fallback seleziona tutti e soli i workflow del commit', () => {
  const paths = selectWorkflowFallbackPaths(
    classifyWorkflowPushFailure(refusal),
    [
      'scripts/ci/native-automerge-gate.mjs',
      '.github/workflows/crawler-group-02.yml',
      '.github/workflows/crawler-group-01.yml',
      'scripts/ci/loop-sync-manifest.json',
    ],
  );
  assert.deepEqual(paths, [
    '.github/workflows/crawler-group-01.yml',
    '.github/workflows/crawler-group-02.yml',
  ]);
  assert.equal(isWorkflowPath('scripts/ci/native-automerge-gate.mjs'), false);
  assert.throws(
    () => selectWorkflowFallbackPaths(classifyWorkflowPushFailure(refusal), ['.github/workflows/crawler-group-02.yml']),
    /assenti dal commit/,
  );
});

test('un batch solo-workflow esce prima dell\'amend e non apre una PR vuota', () => {
  const classification = classifyWorkflowPushFailure(refusal);
  const workflowPaths = selectWorkflowFallbackPaths(classification, [
    '.github/workflows/crawler-group-01.yml',
    '.github/workflows/crawler-group-02.yml',
  ]);
  const report = removeWorkflowPathsFromReport({
    manifestChanged: true,
    transported: workflowPaths.map((path) => ({ path })),
  }, workflowPaths);
  assert.deepEqual(report.transported, []);

  const source = fs.readFileSync(path.join(ROOT, '.github/workflows/transport-identical-twins.yml'), 'utf8');
  const noTreeChange = source.indexOf('if git diff --cached --quiet HEAD^; then');
  const amend = source.indexOf('git commit --amend --no-edit', noTreeChange);
  const create = source.indexOf('gh pr create', noTreeChange);
  assert.ok(noTreeChange >= 0, 'manca il guard del tree dopo l\'esclusione workflow');
  assert.ok(amend > noTreeChange, 'l\'amend deve arrivare dopo il guard');
  assert.ok(create > amend, 'gh pr create deve restare dopo l\'amend');
  assert.match(source.slice(noTreeChange, amend), /non restano path non-workflow[\s\S]*exit 0/);
});

test('il report conserva native-automerge e nomina i workflow esclusi', () => {
  const report = {
    apply: true,
    manifestChanged: true,
    transported: [
      { path: '.github/workflows/crawler-group-01.yml', sitePath: '.github/corpus-workflows/crawler-group-01.yml' },
      { path: 'scripts/ci/native-automerge-gate.mjs', sitePath: 'scripts/ci/native-automerge-gate.mjs' },
      { path: '.github/workflows/crawler-group-02.yml', sitePath: '.github/corpus-workflows/crawler-group-02.yml' },
    ],
  };
  const updated = removeWorkflowPathsFromReport(report, [
    '.github/workflows/crawler-group-01.yml',
    '.github/workflows/crawler-group-02.yml',
  ]);
  assert.deepEqual(updated.transported.map((item) => item.path), ['scripts/ci/native-automerge-gate.mjs']);
  assert.deepEqual(updated.workflowExcluded, [
    '.github/workflows/crawler-group-01.yml',
    '.github/workflows/crawler-group-02.yml',
  ]);
  assert.equal(updated.manifestChanged, true);
});

test('ripristina baseline e couplingSnapshot dal parent solo sui workflow', () => {
  const previous = {
    files: [
      {
        path: '.github/workflows/crawler-group-01.yml',
        mode: 'identical',
        baseline: { site: 'old-site-01', corpus: 'old-corpus-01', alignedAt: '2026-09-14' },
        couplingSnapshot: [{ path: 'old-coupling-01', mode: 'identical' }],
      },
      {
        path: '.github/workflows/crawler-group-02.yml',
        mode: 'identical',
        baseline: { site: 'old-site-02', corpus: 'old-corpus-02', alignedAt: '2026-09-14' },
      },
      {
        path: 'scripts/ci/native-automerge-gate.mjs',
        mode: 'identical',
        baseline: { site: 'old-native', corpus: 'old-native', alignedAt: '2026-09-14' },
      },
    ],
  };
  const current = structuredClone(previous);
  current.files[0].baseline = { site: 'new-site-01', corpus: 'new-site-01', alignedAt: '2026-09-15' };
  current.files[0].couplingSnapshot = [{ path: 'new-coupling-01', mode: 'identical' }];
  current.files[1].baseline = { site: 'new-site-02', corpus: 'new-site-02', alignedAt: '2026-09-15' };
  current.files[1].couplingSnapshot = [{ path: 'new-coupling-02', mode: 'identical' }];
  current.files[2].baseline = { site: 'new-native', corpus: 'new-native', alignedAt: '2026-09-15' };

  const restored = restoreWorkflowSnapshots(current, previous, [
    '.github/workflows/crawler-group-01.yml',
    '.github/workflows/crawler-group-02.yml',
  ]);
  assert.deepEqual(restored.files[0].baseline, previous.files[0].baseline);
  assert.deepEqual(restored.files[0].couplingSnapshot, previous.files[0].couplingSnapshot);
  assert.deepEqual(restored.files[1].baseline, previous.files[1].baseline);
  assert.equal('couplingSnapshot' in restored.files[1], false);
  assert.deepEqual(restored.files[2], current.files[2], 'il gemello non-workflow non si tocca');
  assert.throws(
    () => restoreWorkflowSnapshots(current, previous, ['scripts/ci/native-automerge-gate.mjs']),
    /non workflow/,
  );
});

test('il workflow usa il helper e non offre un fallback per altri push error', () => {
  const source = fs.readFileSync(path.join(ROOT, '.github/workflows/transport-identical-twins.yml'), 'utf8');
  assert.match(source, /transport-identical-twins-push-fallback\.mjs/);
  assert.match(source, /git push -u origin "\$BRANCH" > "\$PUSH_LOG" 2>&1/);
  assert.match(source, /fallback_rc/);
  assert.match(source, /git push -u origin "\$BRANCH" > "\$RETRY_LOG" 2>&1/);
  assert.doesNotMatch(source, /git push --force/);
});

test('il checkout non persiste l’extraheader GITHUB_TOKEN', () => {
  const source = fs.readFileSync(path.join(ROOT, '.github/workflows/transport-identical-twins.yml'), 'utf8');
  const checkoutStart = source.indexOf('      - name: Checkout');
  const nextStep = source.indexOf('      - name: Setup Node.js', checkoutStart);
  assert.ok(checkoutStart >= 0 && nextStep > checkoutStart, 'blocco Checkout non riconoscibile');
  const checkout = source.slice(checkoutStart, nextStep);
  assert.match(checkout, /^\s+persist-credentials:\s*false\s*$/m);
  assert.doesNotMatch(checkout, /^\s+persist-credentials:\s*true\s*$/m);
});
