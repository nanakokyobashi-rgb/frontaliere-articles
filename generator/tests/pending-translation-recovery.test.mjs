import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_PENDING_TRANSLATION_ATTEMPTS,
  claimPendingTranslationDraft,
  clearPendingTranslationFields,
  listPendingTranslationDrafts,
  missingPendingTranslationFields,
  writePendingTranslationDraft,
} from '../scripts/lib/pending-article-translations.mjs';
import {
  capturePendingTranslationRecovery,
  restorePendingTranslationRecovery,
} from '../../scripts/ci/pending-translation-recovery.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const WORKFLOWS = [
  '.github/workflows/generate-article.yml',
  '.github/workflows/generate-article-core.yml',
];
const WORKFLOW_SOURCES = Object.fromEntries(
  WORKFLOWS.map((file) => [file, fs.readFileSync(path.join(ROOT, file), 'utf8')]),
);

function extractRun(workflow, stepName) {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line === `      - name: ${stepName}`);
  assert.notEqual(start, -1, `step non trovato: ${stepName}`);
  const runAt = lines.findIndex((line, index) => index > start && line === '        run: |');
  assert.notEqual(runAt, -1, `blocco run non trovato per: ${stepName}`);
  const body = [];
  for (let index = runAt + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') {
      body.push('');
      continue;
    }
    if (!line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
}

test('entrambi i workflow avviano il recovery su timeout ed errore', () => {
  for (const [file, workflow] of Object.entries(WORKFLOW_SOURCES)) {
    const commit = extractRun(workflow, 'Commit and push');
    assert.match(
      workflow,
      /steps\.generate\.outputs\.outcome_kind == 'error'[\s\S]+steps\.generate\.outputs\.outcome_kind == 'timeout'/u,
      `${file}: la condizione del commit non copre errore e hard-kill`,
    );
    assert.match(commit, /pending-translation-recovery\.mjs" capture "\$pending_section" "\$pending_checkpoint"/u, file);
    assert.match(commit, /pending-translation-recovery\.mjs" restore "\$pending_section" "\$pending_checkpoint"/u, file);
    assert.match(commit, /pending_translation_recovery_only=true/u, file);
  }
});

test('in entrambi i workflow l’ordine è capture → reset/clean → restore', () => {
  for (const [file, workflow] of Object.entries(WORKFLOW_SOURCES)) {
    const commit = extractRun(workflow, 'Commit and push');
    const capture = commit.indexOf('pending-translation-recovery.mjs" capture');
    const reset = commit.indexOf('git reset --hard HEAD');
    const clean = commit.indexOf('git clean -fd');
    const restore = commit.indexOf('pending-translation-recovery.mjs" restore');
    assert.ok(capture >= 0, `${file}: manca capture`);
    assert.ok(reset > capture, `${file}: reset precede capture`);
    assert.ok(clean > reset, `${file}: clean precede reset`);
    assert.ok(restore > clean, `${file}: restore precede clean`);
    assert.match(
      commit,
      /if \[ "\$pending_count" -gt 0 \]; then[\s\S]+pending_translation_recovery_only=true/u,
      `${file}: il recovery deve diventare commit-only solo con draft catturati`,
    );
  }
});

function sampleDraft() {
  const data = {
    id: 'recovery-durability-fixture',
    content: {
      it: {
        title: 'Titolo verificato in italiano',
        excerpt: 'Estratto verificato per il test di durabilità.',
        body1: 'Corpo italiano verificato che non deve essere pubblicato dal recovery.',
      },
      en: {
        title: 'Verified English title',
        excerpt: 'Verified English excerpt.',
        body1: 'Verified English body.',
      },
      de: {},
      fr: {},
    },
  };
  const now = '2026-11-28T12:00:00.000Z';
  return {
    schema: 1,
    section: 'frontaliere',
    articleId: data.id,
    sourceUrl: 'https://example.test/recovery-durability',
    sourceContext: { headline: 'Titolo verificato in italiano' },
    pageContent: 'Fonte verificata dal fact-check italiano.',
    sourceDate: '2026-11-28T08:00:00.000Z',
    sourceTitle: 'Titolo verificato in italiano',
    data,
    attempts: 1,
    missingFields: missingPendingTranslationFields(data),
    createdAt: now,
    updatedAt: now,
    verifiedAt: now,
  };
}

function initFixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-translation-recovery-'));
  const checkpointDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-translation-checkpoint-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'codex@example.invalid']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Codex']);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'discovery-attempt-state.json'), '{"schema":1}\n');
  execFileSync('git', ['-C', root, 'add', 'data/discovery-attempt-state.json']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture baseline']);
  return { root, checkpointPath: path.join(checkpointDir, 'pending.json'), checkpointDir };
}

function disposeFixture({ root, checkpointDir }) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(checkpointDir, { recursive: true, force: true });
}

test('timeout ed error preservano draft, tentativo consumato e gate di pubblicazione per entrambi i workflow', () => {
  for (const workflow of WORKFLOWS) {
    for (const outcome of ['timeout', 'error']) {
      const fixture = initFixtureRepo();
      try {
        const draft = sampleDraft();
        const pendingDir = path.join(fixture.root, 'data/sections/frontaliere/pending-translation-drafts');
        const claimedBeforeProvider = claimPendingTranslationDraft(draft, { now: '2026-11-28T12:01:00.000Z' });
        writePendingTranslationDraft(pendingDir, 'frontaliere', claimedBeforeProvider);
        fs.mkdirSync(path.join(fixture.root, 'content/blog-body/it'), { recursive: true });
        fs.writeFileSync(path.join(fixture.root, 'content/blog-body/it/unverified.ts'), 'const unverified = true;\n');

        assert.equal(
          capturePendingTranslationRecovery({
            root: fixture.root,
            section: 'frontaliere',
            checkpointPath: fixture.checkpointPath,
          }),
          1,
          `${workflow}/${outcome}: capture`,
        );
        execFileSync('git', ['-C', fixture.root, 'reset', '--hard', 'HEAD'], { stdio: 'ignore' });
        execFileSync('git', ['-C', fixture.root, 'clean', '-fd'], { stdio: 'ignore' });
        assert.equal(
          restorePendingTranslationRecovery({
            root: fixture.root,
            section: 'frontaliere',
            checkpointPath: fixture.checkpointPath,
          }),
          1,
          `${workflow}/${outcome}: restore`,
        );

        const staged = execFileSync('git', ['-C', fixture.root, 'diff', '--cached', '--name-only'], { encoding: 'utf8' })
          .trim().split('\n').filter(Boolean);
        assert.equal(staged.length, 1, `${workflow}/${outcome}: recovery-only deve avere un solo path`);
        assert.match(staged[0], /^data\/sections\/frontaliere\/pending-translation-drafts\/[a-f0-9]{64}\.json$/u);
        assert.doesNotMatch(staged.join('\n'), /content\/blog-body/u, `${workflow}/${outcome}: articolo non deve essere staged`);
        assert.equal(fs.existsSync(path.join(fixture.root, 'content/blog-body/it/unverified.ts')), false);

        const restored = listPendingTranslationDrafts(pendingDir, 'frontaliere');
        assert.equal(restored.length, 1);
        assert.equal(restored[0].attempts, 2, `${workflow}/${outcome}: il tentativo deve essere consumato prima del provider`);
        assert.deepEqual(
          missingPendingTranslationFields(restored[0].data),
          restored[0].missingFields,
          `${workflow}/${outcome}: completezza del draft non verificata`,
        );
        const resumedData = structuredClone(restored[0].data);
        clearPendingTranslationFields(resumedData, restored[0].missingFields);
        assert.deepEqual(
          missingPendingTranslationFields(resumedData),
          restored[0].missingFields,
          `${workflow}/${outcome}: resume deve riaprire solo i campi mancanti`,
        );

        const third = claimPendingTranslationDraft(restored[0], { now: '2026-11-29T12:00:00.000Z' });
        assert.equal(third.attempts, MAX_PENDING_TRANSLATION_ATTEMPTS);
        assert.equal(claimPendingTranslationDraft(third), null, `${workflow}/${outcome}: budget oltre 3 tentativi`);
      } finally {
        disposeFixture(fixture);
      }
    }
  }
});
