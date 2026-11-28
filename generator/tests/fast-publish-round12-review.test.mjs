// Round 12 di F1: rilievi della re-review (gamba di stage fallita senza
// proprietario, dispatch che sostituisce un finalize pending, download degli
// stage artifact senza retry). Ogni test gira sul codice vero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const workflow = readFileSync(path.join(repoRoot, '.github/workflows/fast-publish-section.yml'), 'utf8');
const coordinate = path.join(repoRoot, 'scripts/ci/fast-publish-section-coordinate.sh');
const probe = path.join(repoRoot, 'scripts/ci/fast-publish-section-pending-probe.sh');

function jobBlock(name) {
  const start = workflow.indexOf(`\n  ${name}:`, workflow.indexOf('\njobs:'));
  assert.ok(start >= 0, `job ${name} missing`);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n  [A-Za-z_][A-Za-z0-9_-]*:/u);
  return next < 0 ? rest : rest.slice(0, next);
}

function stepBlock(job, name) {
  const marker = `      - name: ${name}\n`;
  const start = job.indexOf(marker);
  assert.ok(start >= 0, `step "${name}" assente`);
  const rest = job.slice(start + marker.length);
  const next = rest.search(/\n      - name: /u);
  return next < 0 ? rest : rest.slice(0, next);
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(cwd, file, content) {
  writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', file);
  return git(cwd, 'rev-parse', 'HEAD');
}

function writeFakeGh(dir, body) {
  const file = path.join(dir, 'gh');
  writeFileSync(file, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  chmodSync(file, 0o755);
}

/** Fixture del coordinator: main fermo su `latest`, nessun nuovo dato API. */
function coordinatorFixture(root) {
  const fixture = path.join(root, 'corpus');
  mkdirSync(path.join(fixture, 'scripts/ci'), { recursive: true });
  git(fixture, 'init', '-q');
  const latest = commit(fixture, 'a.txt', '1\n');
  writeFileSync(path.join(fixture, 'scripts/ci/read-main-head.sh'), `#!/usr/bin/env bash\necho ${latest}\n`);
  writeFileSync(path.join(fixture, 'scripts/ci/section-source-unaffected.sh'), '#!/usr/bin/env bash\nexit 0\n');
  const realModule = path.join(repoRoot, 'scripts/ci/fast-publish-section.mjs');
  writeFileSync(path.join(fixture, 'scripts/ci/fast-publish-section.mjs'), `
import { readFileSync } from 'node:fs';
const mod = await import(${JSON.stringify(realModule)});
const [cmd] = process.argv.slice(2);
const input = () => JSON.parse(readFileSync(0, 'utf8'));
if (cmd === 'r2-api-stage-barrier') console.log(JSON.stringify(mod.r2ApiStageBarrierDecision(input())));
else if (cmd === 'r2-api-wait-defer') console.log(String(mod.r2ShouldDeferApiReadinessToFinalize(input())));
else if (cmd === 'r2-api-data-range') console.log('false');
else process.exit(2);
`);
  return { fixture, latest };
}

function runCoordinator(root, { fixture, latest }, { artifacts, matrix, extraEnv = {} }) {
  const output = path.join(root, 'output');
  writeFileSync(output, '');
  const result = spawnSync('bash', [coordinate], {
    cwd: fixture,
    encoding: 'utf8',
    env: {
      ...process.env,
      API_ACTION: 'dispatch',
      STAGE_MATRIX: matrix,
      FINAL_MATRIX: matrix,
      EVENT_NAME: 'push',
      PUSH_AFTER: latest,
      GITHUB_OUTPUT: output,
      ARTIFACTS_DIR: artifacts,
      ...extraEnv,
    },
  });
  const outputs = Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter(Boolean).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
  return { result, outputs };
}

const stageArtifact = (section, sourceCommit) => JSON.stringify({ section, sourceCommit, staged: true });
const failedMarker = (section) => JSON.stringify({ section, failed: true });

// ───────── MEDIUM 2: gamba di stage fallita ─────────

test('MEDIUM 2: lo stage fallito scrive un marcatore, il coordinator replay-a solo le gambe FALLITE', () => {
  const stage = jobBlock('stage');
  const marker = stepBlock(stage, 'Record failed stage marker');
  assert.match(marker, /if: failure\(\)/u, 'solo un vero fallimento (non cancellazione/sostituzione)');
  const upload = stepBlock(stage, 'Upload failed stage marker');
  assert.match(upload, /if: failure\(\)/u);
  assert.match(upload, /name: fast-publish-stage-failed-\$\{\{ matrix\.target\.section \}\}/u);
  assert.ok(stage.indexOf('Upload failed stage marker') < stage.indexOf('Cleanup Firebase credentials'));

  const replay = stepBlock(jobBlock('coordinate_api_release'), 'Replay full-section for failed stage legs');
  assert.match(replay, /if: \$\{\{ !cancelled\(\) && needs\.resolve\.outputs\.dry != 'true' && steps\.decision\.outputs\.failed_sections != '\[\]' \}\}/u);
  assert.match(replay, /dispatch-fast-publish-replay\.sh[\s\S]*?-f section="\$section" -f dry_run=false -f article_ids='\[\]'/u);
  assert.match(jobBlock('coordinate_api_release'), /failed_sections: \$\{\{ steps\.decision\.outputs\.failed_sections \}\}/u);
});

test('MEDIUM 2: push A+B con stage di A FALLITO: A esce da sections_json e dalla matrix finale ed e in failed_sections', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'f1-r12-failed-'));
  try {
    const ctx = coordinatorFixture(root);
    const artifacts = path.join(root, 'artifacts');
    mkdirSync(artifacts);
    writeFileSync(path.join(artifacts, 'fast-publish-stage-canton-ow.json'), stageArtifact('canton-ow', ctx.latest));
    writeFileSync(path.join(artifacts, 'fast-publish-stage-failed-canton-ti.json'), failedMarker('canton-ti'));
    const matrix = JSON.stringify([
      { section: 'canton-ti', ids: [], bootstrap: true },
      { section: 'canton-ow', ids: [], bootstrap: true },
    ]);
    const { result, outputs } = runCoordinator(root, ctx, { artifacts, matrix });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(outputs.failed_sections), ['canton-ti']);
    assert.deepEqual(JSON.parse(outputs.staged_sections), ['canton-ow']);
    assert.deepEqual(JSON.parse(outputs.sections_json), ['canton-ow'], 'l API non attende pagine che nessuno rendera');
    assert.deepEqual(JSON.parse(outputs.final_matrix).map(({ section }) => section), ['canton-ow']);
    assert.equal(outputs.action, 'dispatch');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MEDIUM 2: una gamba SOSTITUITA (nessun marcatore) non riceve replay: resta alla run che la possiede', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'f1-r12-replaced-'));
  try {
    const ctx = coordinatorFixture(root);
    const artifacts = path.join(root, 'artifacts');
    mkdirSync(artifacts);
    writeFileSync(path.join(artifacts, 'fast-publish-stage-canton-ow.json'), stageArtifact('canton-ow', ctx.latest));
    const matrix = JSON.stringify([
      { section: 'canton-ti', ids: [], bootstrap: true },
      { section: 'canton-ow', ids: [], bootstrap: true },
    ]);
    const { result, outputs } = runCoordinator(root, ctx, { artifacts, matrix });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(outputs.failed_sections), []);
    assert.deepEqual(JSON.parse(outputs.staged_sections), ['canton-ow']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MEDIUM 2: tutte le gambe fallite: nessun rilascio API e nessun errore, il replay rifa il lavoro', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'f1-r12-allfailed-'));
  try {
    const ctx = coordinatorFixture(root);
    const artifacts = path.join(root, 'artifacts');
    mkdirSync(artifacts);
    writeFileSync(path.join(artifacts, 'fast-publish-stage-failed-canton-ti.json'), failedMarker('canton-ti'));
    writeFileSync(path.join(artifacts, 'fast-publish-stage-failed-canton-ow.json'), failedMarker('canton-ow'));
    const matrix = JSON.stringify([
      { section: 'canton-ti', ids: [], bootstrap: true },
      { section: 'canton-ow', ids: [], bootstrap: true },
    ]);
    const { result, outputs } = runCoordinator(root, ctx, { artifacts, matrix });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(outputs.failed_sections), ['canton-ow', 'canton-ti']);
    assert.equal(outputs.action, 'none');
    assert.equal(outputs.wait_api, 'false');
    assert.deepEqual(JSON.parse(outputs.final_matrix), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MEDIUM 2: un marcatore non valido o di un\'altra sezione non innesca il replay', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'f1-r12-badmarker-'));
  try {
    const ctx = coordinatorFixture(root);
    const artifacts = path.join(root, 'artifacts');
    mkdirSync(artifacts);
    writeFileSync(path.join(artifacts, 'fast-publish-stage-canton-ow.json'), stageArtifact('canton-ow', ctx.latest));
    writeFileSync(path.join(artifacts, 'fast-publish-stage-failed-canton-ti.json'), failedMarker('canton-zz'));
    const matrix = JSON.stringify([
      { section: 'canton-ti', ids: [], bootstrap: true },
      { section: 'canton-ow', ids: [], bootstrap: true },
    ]);
    const { result, outputs } = runCoordinator(root, ctx, { artifacts, matrix });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(outputs.failed_sections), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ───────── MEDIUM 3: dispatch che sostituisce un finalize pending ─────────

function runProbe(root, ghBody, extraEnv = {}) {
  const bin = path.join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFakeGh(bin, ghBody);
  return spawnSync('bash', [probe], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      REPO: 'owner/repo',
      CURRENT_RUN_ID: '100',
      PENDING_PROBE_RETRY_DELAY: '0',
      ...extraEnv,
    },
  });
}

// Il comportamento per sezione del probe e' coperto da fast-publish-round13-review.test.mjs.

test('MEDIUM 3: probe illeggibile o risposta non valida = non posso escludere (full-section)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'f1-r12-probe-fail-'));
  try {
    const failing = runProbe(root, 'exit 1', { SECTION: 'canton-ow', PATH: `${path.join(root, 'bin')}:${process.env.PATH}` });
    assert.equal(failing.stdout.trim(), 'false');
    assert.equal(failing.status, 0);
    assert.equal(runProbe(root, "printf '%s\\n' 'not-json'", { SECTION: 'canton-ow' }).stdout.trim(), 'false');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, { timeout: 60_000 });

test('MEDIUM 3: il finalize rende full-section un dispatch mirato che non puo escludere la sostituzione', () => {
  const finalize = jobBlock('finalize');
  const preserve = stepBlock(finalize, 'Preserve the result recorder from the workflow revision');
  assert.match(preserve, /fast-publish-section-pending-probe\.sh/u, 'il probe viene dalla revisione del workflow');
  const start = stepBlock(finalize, 'Read latest main after acquiring the section slot');
  assert.match(start, /DRY: \$\{\{ needs\.resolve\.outputs\.dry \}\}/u);
  assert.match(start, /CURRENT_RUN_ID: \$\{\{ github\.run_id \}\}/u);
  assert.match(start, /if \[ "\$targeted" = 'true' \] && \[ "\$DRY" != 'true' \]; then[\s\S]*?fast-publish-section-pending-probe\.sh[\s\S]*?\[ "\$can_exclude" != 'true' \][\s\S]*?targeted=false/u);
  assert.ok(start.indexOf('targeted=false') < start.indexOf('force_full_section=true'),
    'la decisione sul probe precede il ramo che forza il full-section');
  assert.match(workflow, /- 'scripts\/ci\/fast-publish-section-pending-probe\.sh'/u, 'una modifica al probe rilancia il publisher');
});

// ───────── LOW 4: download degli stage artifact ─────────

test('LOW 4: il download degli stage artifact ritenta 3 volte con attesa e riporta l esito al coordinator', () => {
  const coordinator = jobBlock('coordinate_api_release');
  for (const id of ['download_stage_1', 'download_stage_2', 'download_stage_3']) {
    assert.match(coordinator, new RegExp(`id: ${id}\\n[\\s\\S]*?continue-on-error: true\\n[\\s\\S]*?download-artifact@v7`, 'u'));
  }
  assert.match(coordinator, /steps\.download_stage_1\.outcome == 'failure' && steps\.download_stage_2\.outcome == 'failure'/u);
  assert.match(coordinator, /STAGE_DOWNLOAD_FAILED: \$\{\{ steps\.download_stage_1\.outcome == 'failure' && steps\.download_stage_2\.outcome == 'failure' && steps\.download_stage_3\.outcome == 'failure' \}\}/u);
  assert.match(coordinator, /RUN_ID: \$\{\{ github\.run_id \}\}/u);
  assert.equal((coordinator.match(/continue-on-error: true/gu) ?? []).length, 4, 'tre download e il replay (round 13): nessun altro step silenzia errori');
});

function runDownloadFailure(root, ghBody) {
  const ctx = coordinatorFixture(root);
  const bin = path.join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFakeGh(bin, ghBody);
  const artifacts = path.join(root, 'artifacts');
  mkdirSync(artifacts);
  const matrix = JSON.stringify([{ section: 'canton-ow', ids: [], bootstrap: true }]);
  return runCoordinator(root, ctx, {
    artifacts,
    matrix,
    extraEnv: {
      STAGE_DOWNLOAD_FAILED: 'true',
      REPO: 'owner/repo',
      RUN_ID: '77',
      PATH: `${bin}:${process.env.PATH}`,
    },
  });
}

test('LOW 4: download fallito con artifact presenti = errore esplicito, non «tutte le sezioni scartate»', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'f1-r12-download-'));
  try {
    const { result, outputs } = runDownloadFailure(root, "printf '%s\\n' 2");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /download degli stage artifact fallito 3 volte ma il run ne ha 2/u);
    assert.equal(outputs.final_matrix, undefined, 'nessuna decisione scritta');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('LOW 4: download fallito e elenco illeggibile = errore esplicito', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'f1-r12-download-list-'));
  try {
    const { result } = runDownloadFailure(root, 'exit 1');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /elenco degli artifact del run non e leggibile/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('LOW 4: download fallito perche il run non ha artifact di stage = procede (nessuna gamba ha prodotto uno stage)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'f1-r12-download-none-'));
  try {
    const { result } = runDownloadFailure(root, "printf '%s\\n' 0");
    assert.match(result.stdout, /nessun artifact di stage nel run/u);
    assert.doesNotMatch(result.stderr, /download degli stage artifact fallito/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
