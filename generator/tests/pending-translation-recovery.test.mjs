import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SECTIONS } from '../../scripts/lib/article-surfaces.mjs';
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
    assert.match(commit, /pending-translation-recovery\.mjs" capture all "\$pending_checkpoint"/u, file);
    assert.match(commit, /pending-translation-recovery\.mjs" restore all "\$pending_checkpoint"/u, file);
    assert.match(commit, /pending_translation_recovery_only=true/u, file);
    assert.doesNotMatch(commit, /recovery\.mjs" (capture|restore) "\$pending_section"/u,
      `${file}: capture/restore non devono ridursi alla sola sezione dell'output (target + sibling)`);
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
      /if \[ "\$pending_staged" -gt 0 \]; then\s+pending_translation_recovery_only=true/u,
      `${file}: il recovery deve diventare commit-only solo se il restore ha messo in stage qualcosa`,
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

function sampleDraftFor(section, articleId) {
  const draft = sampleDraft();
  draft.section = section;
  draft.articleId = articleId;
  draft.data.id = articleId;
  return draft;
}

test('sibling: la bozza salvata dalla sezione effettiva sopravvive a timeout ed error anche se l\'output dice TARGET', () => {
  for (const workflow of WORKFLOWS) {
    for (const outcome of ['timeout', 'error']) {
      const fixture = initFixtureRepo();
      try {
        // TARGET=frontaliere esce rc 4 senza bozza; poi `svizzera` salva una
        // bozza IT verificata (tentativo gia' consumato) e viene hard-killed.
        const siblingDir = path.join(fixture.root, 'data/sections/svizzera/pending-translation-drafts');
        const claimed = claimPendingTranslationDraft(
          sampleDraftFor('svizzera', 'sibling-draft-fixture'),
          { now: '2026-11-28T12:01:00.000Z' },
        );
        writePendingTranslationDraft(siblingDir, 'svizzera', claimed);

        assert.equal(
          capturePendingTranslationRecovery({ root: fixture.root, section: 'all', checkpointPath: fixture.checkpointPath }),
          1,
          `${workflow}/${outcome}: capture di tutte le sezioni`,
        );
        execFileSync('git', ['-C', fixture.root, 'reset', '--hard', 'HEAD'], { stdio: 'ignore' });
        execFileSync('git', ['-C', fixture.root, 'clean', '-fd'], { stdio: 'ignore' });
        assert.equal(fs.existsSync(siblingDir), false, 'il clean deve aver cancellato la bozza non tracciata');
        assert.equal(
          restorePendingTranslationRecovery({ root: fixture.root, section: 'all', checkpointPath: fixture.checkpointPath }),
          1,
          `${workflow}/${outcome}: restore in stage`,
        );
        const restored = listPendingTranslationDrafts(siblingDir, 'svizzera');
        assert.equal(restored.length, 1);
        assert.equal(restored[0].attempts, 2, `${workflow}/${outcome}: il tentativo consumato dal sibling deve restare`);
        const staged = execFileSync('git', ['-C', fixture.root, 'diff', '--cached', '--name-only'], { encoding: 'utf8' })
          .trim().split('\n').filter(Boolean);
        assert.equal(staged.length, 1);
        assert.match(staged[0], /^data\/sections\/svizzera\/pending-translation-drafts\/[a-f0-9]{64}\.json$/u);
      } finally {
        disposeFixture(fixture);
      }
    }
  }
});

test('capture con la sola sezione TARGET perderebbe la bozza del sibling (regressione documentata)', () => {
  const fixture = initFixtureRepo();
  try {
    const siblingDir = path.join(fixture.root, 'data/sections/svizzera/pending-translation-drafts');
    writePendingTranslationDraft(siblingDir, 'svizzera', sampleDraftFor('svizzera', 'sibling-only'));
    assert.equal(
      capturePendingTranslationRecovery({ root: fixture.root, section: 'frontaliere', checkpointPath: fixture.checkpointPath }),
      0,
    );
    assert.equal(
      capturePendingTranslationRecovery({ root: fixture.root, section: 'frontaliere,svizzera', checkpointPath: fixture.checkpointPath }),
      1,
    );
  } finally {
    disposeFixture(fixture);
  }
});

test('un draft già committato e invariato non apre un commit di recovery vuoto', () => {
  const fixture = initFixtureRepo();
  try {
    const dir = path.join(fixture.root, 'data/sections/frontaliere/pending-translation-drafts');
    writePendingTranslationDraft(dir, 'frontaliere', sampleDraft());
    execFileSync('git', ['-C', fixture.root, 'add', '-A'], { stdio: 'ignore' });
    execFileSync('git', ['-C', fixture.root, 'commit', '-qm', 'persisted draft'], { stdio: 'ignore' });
    assert.equal(
      capturePendingTranslationRecovery({ root: fixture.root, section: 'all', checkpointPath: fixture.checkpointPath }),
      0,
      'sezione invariata: nulla da catturare, la ripristina git reset',
    );
    execFileSync('git', ['-C', fixture.root, 'reset', '--hard', 'HEAD'], { stdio: 'ignore' });
    assert.equal(
      restorePendingTranslationRecovery({ root: fixture.root, section: 'all', checkpointPath: fixture.checkpointPath }),
      0,
      'nessun path cambiato: il workflow non deve fare commit',
    );
  } finally {
    disposeFixture(fixture);
  }
});

function commitInvalidDraft(fixture, section, articleId) {
  const dir = path.join(fixture.root, `data/sections/${section}/pending-translation-drafts`);
  writePendingTranslationDraft(dir, section, sampleDraftFor(section, articleId));
  const file = path.join(dir, fs.readdirSync(dir)[0]);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored.missingFields = ['en.title']; // non piu' coerente con il testo salvato
  fs.writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);
  execFileSync('git', ['-C', fixture.root, 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', fixture.root, 'commit', '-qm', 'committed draft now invalid'], { stdio: 'ignore' });
  return dir;
}

function captureResetRestore(fixture) {
  const args = { root: fixture.root, section: 'all', checkpointPath: fixture.checkpointPath };
  const captured = capturePendingTranslationRecovery(args);
  execFileSync('git', ['-C', fixture.root, 'reset', '--hard', 'HEAD'], { stdio: 'ignore' });
  execFileSync('git', ['-C', fixture.root, 'clean', '-fd'], { stdio: 'ignore' });
  const staged = restorePendingTranslationRecovery(args);
  const names = execFileSync('git', ['-C', fixture.root, 'diff', '--cached', '--name-only'], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  return { captured, staged, names };
}

test('una bozza invalida in una sezione non toccata non blocca capture/restore delle altre', () => {
  const fixture = initFixtureRepo();
  try {
    commitInvalidDraft(fixture, 'frontaliere', 'untouched-invalid');
    const touched = path.join(fixture.root, 'data/sections/svizzera/pending-translation-drafts');
    writePendingTranslationDraft(touched, 'svizzera', claimPendingTranslationDraft(
      sampleDraftFor('svizzera', 'touched-valid'),
      { now: '2026-11-28T12:01:00.000Z' },
    ));
    const { captured, staged, names } = captureResetRestore(fixture);
    assert.equal(captured, 1);
    assert.equal(staged, 1);
    assert.equal(names.length, 1);
    assert.match(names[0], /^data\/sections\/svizzera\/pending-translation-drafts\//u,
      'il commit di recovery contiene solo la sezione toccata');
  } finally {
    disposeFixture(fixture);
  }
});

test('una bozza invalida nella sezione toccata e\' confinata: warning, le altre sezioni e discovery-attempt-state restano', () => {
  const fixture = initFixtureRepo();
  try {
    const invalidDir = commitInvalidDraft(fixture, 'frontaliere', 'touched-invalid');
    // Il run tocca la sezione gia' invalida (nuova bozza non tracciata) e una valida.
    writePendingTranslationDraft(invalidDir, 'frontaliere', sampleDraftFor('frontaliere', 'touched-invalid-new'));
    const goodDir = path.join(fixture.root, 'data/sections/svizzera/pending-translation-drafts');
    writePendingTranslationDraft(goodDir, 'svizzera', sampleDraftFor('svizzera', 'touched-good'));
    const warnings = [];
    const original = console.error;
    console.error = (message) => warnings.push(String(message));
    let result;
    try {
      result = captureResetRestore(fixture);
    } finally {
      console.error = original;
    }
    assert.equal(result.captured, 1);
    assert.equal(result.staged, 1);
    assert.match(result.names[0], /\/svizzera\/pending-translation-drafts\//u);
    assert.ok(warnings.some((line) => /^::warning::.*section 'frontaliere'.*validation failed/u.test(line)),
      `warning atteso, ricevuto: ${warnings.join(' | ')}`);
    // discovery-attempt-state non e' toccato dal recovery delle bozze.
    assert.equal(fs.readFileSync(path.join(fixture.root, 'data/discovery-attempt-state.json'), 'utf8'), '{"schema":1}\n');
  } finally {
    disposeFixture(fixture);
  }
});

test('le traduzioni salvate sono candidati marcati NON verificati e non possono dichiararsi verificati', () => {
  const draft = sampleDraft();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-unverified-'));
  try {
    writePendingTranslationDraft(dir, 'frontaliere', draft);
    const [stored] = listPendingTranslationDrafts(dir, 'frontaliere');
    assert.equal(stored.translationState, 'unverified-candidate');
    assert.equal(stored.translationsVerified, false);
    assert.deepEqual(stored.unverifiedFields, ['en.title', 'en.excerpt', 'en.body1']);
    const file = fs.readdirSync(dir)[0];
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    assert.equal(onDisk.translationsVerified, false, 'la marcatura deve stare nel file persistito');
    assert.throws(
      () => writePendingTranslationDraft(dir, 'frontaliere', { ...draft, translationsVerified: true }),
      /cannot mark translations as verified/u,
    );
    assert.throws(
      () => writePendingTranslationDraft(dir, 'frontaliere', { ...draft, translationState: 'verified' }),
      /cannot mark translations as verified/u,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('nessuna superficie pubblicata (API, indici, sitemap, feed, trigger di publish) legge le bozze pendenti', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const publishers = [
    'scripts/build-api.mjs',
    'scripts/build-blog-index.mjs',
    'scripts/publish-article-fast.mjs',
    'scripts/publish-section-edge.mjs',
    'scripts/publish-section-pages.mjs',
    'scripts/reconcile-article-shards.mjs',
    'scripts/reconcile-section-pages.mjs',
    ...fs.readdirSync(path.join(ROOT, 'scripts/lib')).filter((name) => name.endsWith('.mjs')).map((name) => `scripts/lib/${name}`),
  ].filter((rel) => rel !== 'scripts/lib/article-surfaces.mjs' && fs.existsSync(path.join(ROOT, rel)));
  for (const rel of publishers) {
    const source = read(rel);
    assert.doesNotMatch(source, /pending-translation-drafts|pendingTranslationDir/u, `${rel} non deve leggere lo stato pending`);
    assert.doesNotMatch(source, /['"`]data\/sections['"`/]/u, `${rel} non deve scandire data/sections`);
  }
  // Un commit di sola recovery non e' un input di pubblicazione ne' un trigger.
  assert.doesNotMatch(read('.github/workflows/publish-api.yml'), /data\/sections/u);
  assert.match(read('scripts/ci/section-source-unaffected.sh'), /exclude,glob\)data\/sections\/\*\/pending-translation-drafts\/\*\*/u);
  for (const section of Object.keys(SECTIONS)) {
    const caller = `.github/workflows/generate-article-${section.replace(/^canton-/u, '')}.yml`;
    if (!fs.existsSync(path.join(ROOT, caller))) continue;
    assert.doesNotMatch(read(caller), /pending-translation-drafts/u, `${caller}: la recovery non deve riaccendere il caller`);
  }
});

test('la ripresa rigira i gate sui testi ripresi e un URL esplicito lascia intatta la bozza', () => {
  const source = fs.readFileSync(path.join(ROOT, 'generator/scripts/create-article.mjs'), 'utf8');
  const resumeGate = source.indexOf('TRANSLATION_CANDIDATES_UNVERIFIED');
  const translate = source.indexOf('await translateArticle(data, { resumeOnlyMissing', resumeGate);
  const slugs = source.indexOf('relocalizeSlugsAfterTranslation(data', translate);
  const fabricated = source.indexOf('assertNoFabricatedLaborOfficeCrossLocale(data);', translate);
  const finalCompleteness = source.indexOf('const missingBeforePublish', fabricated);
  const firstWrite = source.indexOf('modifyRouterTs(data);', finalCompleteness);
  assert.ok(resumeGate > 0 && translate > resumeGate && slugs > translate && fabricated > slugs
    && finalCompleteness > fabricated && firstWrite > finalCompleteness,
  'i gate post-traduzione devono girare sull\'intero testo ripreso prima del primo write');
  assert.match(source, /missingPendingTranslationFields\(data\),\s*\]\),\s*\]\);/u, 'i campi oggi inutilizzabili vanno riaperti');

  assert.match(
    source,
    /if \(!DRY_RUN_SCAN && PENDING_TRANSLATION_DIR && !url\) \{\s+const drafts = listPendingTranslationDrafts/u,
    'con URL esplicito la bozza non deve essere né reclamata né scartata',
  );
});

test('un commit di sola bozza pendente è bookkeeping per il publisher (fast-forward non invalidante)', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-unaffected-'));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  const commit = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(directory, rel)), { recursive: true });
    fs.writeFileSync(path.join(directory, rel), body);
    git('add', '--', rel);
    git('commit', '-qm', rel);
    return git('rev-parse', 'HEAD');
  };
  const check = (base, head) => spawnSync('bash', [path.join(ROOT, 'scripts/ci/section-source-unaffected.sh'), base, head], { cwd: directory }).status;
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    const base = commit('content/article.txt', 'original');
    const pending = commit(`data/sections/frontaliere/pending-translation-drafts/${'a'.repeat(64)}.json`, '{}');
    const article = commit('content/article.txt', 'changed');
    assert.equal(check(base, pending), 0);
    assert.equal(check(pending, article), 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
