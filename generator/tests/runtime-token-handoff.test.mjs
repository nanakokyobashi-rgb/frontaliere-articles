/**
 * GitHub Actions valuta `env.*` prima che i valori scritti in GITHUB_ENV
 * siano visibili alle interpolazioni YAML. I consumer del loop devono
 * leggere il PAT dalla shell. Lo scanner cammina TUTTI i workflow: un
 * elenco di otto file (PR #1547) lasciava reintrodurre
 * `PUSH_TOKEN: ${{ env.GITHUB_PAT_NANAKO }}` altrove restando verde.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  ENV_CONTEXT_HANDOFF_RE,
  IF_ENV_TOKEN_RE,
  MIN_SCANNED_WORKFLOWS,
  PROBE_ENV_PUSH_TOKEN_RE,
  PROBE_SCRIPT,
  PROBE_SHELL_PUSH_TOKEN_RE,
  findViolations,
  scanRepo,
} from '../../scripts/ci/scan-runtime-token-handoff.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = (file) => readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8');

test('lo scanner riconosce if: env.GITHUB_PAT e PUSH_TOKEN interpolato', () => {
  const badIf = findViolations([
    '      - name: Guard',
    '        if: env.GITHUB_PAT_NANAKO != \'\'',
    '        run: echo hi',
  ].join('\n'), 'fixture.yml');
  assert.equal(badIf.some((f) => f.kind === 'if-env-token'), true, 'if: env.PAT deve essere un finding');

  const badPush = findViolations(
    '          PUSH_TOKEN: ${{ env.GITHUB_PAT_NANAKO }}\n',
    'fixture.yml',
  );
  assert.equal(badPush.some((f) => f.kind === 'env-context-handoff'), true);
  assert.equal(badPush.some((f) => f.kind === 'probe-env-push-token'), true);

  const badFallback = findViolations(
    '          GH_TOKEN: ${{ env.GITHUB_PAT_NANAKO || secrets.GITHUB_TOKEN }}\n',
    'fixture.yml',
  );
  assert.equal(
    badFallback.some((f) => f.kind === 'env-context-handoff'),
    true,
    'il fallback silenzioso su GITHUB_TOKEN è la stessa classe: env vuoto → token runner',
  );
});

test('lo scanner non confonde GITHUB_PAT: con la chiave PAT: e ignora i commenti', () => {
  const actionInput = findViolations([
    '          github_token: ${{ env.GITHUB_PAT_NANAKO }}',
    '          codex_github_token: ${{ env.GITHUB_PAT_NANAKO }}',
    '          GITHUB_PAT: ${{ env.GITHUB_PAT }}',
  ].join('\n'), 'fixture.yml');
  assert.deepEqual(actionInput, [], 'gli input Codex e GITHUB_PAT: non sono chiavi operative del gate');

  const commented = findViolations(
    '      # Lo step di apply e\' gatato su `env.GITHUB_PAT_NANAKO != \'\'`\n',
    'fixture.yml',
  );
  assert.deepEqual(commented, [], 'un commento che cita l\'anti-pattern non è un handoff');
});

test('una sonda senza PUSH_TOKEN dalla shell è un finding; con la forma runtime no', () => {
  const missing = findViolations(
    `        run: node scripts/ci/${PROBE_SCRIPT}\n`,
    'fixture.yml',
  );
  assert.equal(missing.some((f) => f.kind === 'probe-missing-shell-token'), true);

  const ok = findViolations(
    `          PUSH_TOKEN="$GITHUB_PAT_NANAKO" node scripts/ci/${PROBE_SCRIPT}\n`,
    'fixture.yml',
  );
  assert.deepEqual(ok, []);

  const tokenInAnotherStep = findViolations([
    '      - name: Token in another step',
    '        run: PUSH_TOKEN="$GITHUB_PAT_NANAKO" echo ready',
    '      - name: Probe',
    '        run: node scripts/ci/probe-workflow-scope.mjs',
  ].join('\n'), 'fixture.yml');
  assert.equal(
    tokenInAnotherStep.some((f) => f.kind === 'probe-missing-shell-token'),
    true,
    'un token in uno step diverso non deve soddisfare la sonda',
  );

  const sameBlock = findViolations([
    '      - name: Probe',
    '        run: |',
    '          PUSH_TOKEN="$GITHUB_PAT_NANAKO" node scripts/ci/probe-workflow-scope.mjs',
  ].join('\n'), 'fixture.yml');
  assert.deepEqual(sameBlock, []);
});

test('nessun workflow del repo reintroduce handoff env.* dopo load-rc-env', () => {
  const { findings, scanned } = scanRepo(ROOT);
  assert.ok(
    scanned >= MIN_SCANNED_WORKFLOWS,
    `scansionati ${scanned} workflow, sotto il pavimento di ${MIN_SCANNED_WORKFLOWS}`,
  );
  assert.deepEqual(
    findings.map((f) => `${f.file}:${f.line} [${f.kind}] ${f.text}`),
    [],
    'handoff env.GITHUB_PAT*: passa il token dalla shell, non dal contesto env',
  );
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
    // Il re-queue di recycle deve passare il sender gate di issue-fix: PAT
    // con identita' verificata, non l'App token (frontaliere-automation[bot]).
    'recycle-stale-prs.yml': /PAT="\$\{GITHUB_PAT_NANAKO:-\}"[\s\S]*?GH_TOKEN="\$PAT" gh api user/,
    'transport-identical-twins.yml': /PUSH_TOKEN="\$GITHUB_PAT_NANAKO" node scripts\/ci\/probe-workflow-scope\.mjs/,
    'transport-identical-twins-realign.yml': /export GH_TOKEN="\$runtime_pat"/,
  };
  for (const [file, pattern] of Object.entries(required)) {
    assert.match(source(file), pattern, `${file}: manca il passaggio runtime del token`);
  }
});

test('issue-fix passa la capability workflows dalla shell runtime al prompt', () => {
  const yaml = source('issue-fix.yml');
  assert.match(yaml, /echo "has_workflows_token=false" >> "\$GITHUB_OUTPUT"/);
  assert.match(yaml, /echo "has_workflows_token=true" >> "\$GITHUB_OUTPUT"/);
  assert.match(yaml, /steps\.scope_guard\.outputs\.has_workflows_token/);
  assert.doesNotMatch(
    yaml,
    /\$\{\{\s*env\.GITHUB_PAT_NANAKO\s*!=/,
    'il prompt non deve valutare la presenza del PAT prima del caricamento runtime',
  );
});

test('i consumer che puliscono runtime_pat conservano l’exit status del comando', () => {
  const drainer = source('followup-drainer.yml');
  assert.match(drainer, /GH_TOKEN="\$runtime_pat" node scripts\/ci\/followup-drainer\.mjs\n\s+rc=\$\?\n\s+unset runtime_pat\n\s+exit "\$rc"/);

  const autorebase = source('pr-autorebase.yml');
  assert.match(autorebase, /GH_TOKEN="\$runtime_pat" node scripts\/ci\/pr-autorebase\.mjs --dry-run\n\s+rc=\$\?/);
  assert.match(autorebase, /GH_TOKEN="\$runtime_pat" node scripts\/ci\/pr-autorebase\.mjs\n\s+rc=\$\?/);
  assert.match(autorebase, /unset runtime_pat\n\s+exit "\$rc"/,
    'pr-autorebase: unset non deve mascherare un errore del consumer');
});

test('la sonda del repo e le regex esportate restano allineate', () => {
  const probe = readFileSync(new URL('../../scripts/ci/probe-workflow-scope.mjs', import.meta.url), 'utf8');
  assert.match(probe, /const token = process\.env\.PUSH_TOKEN/,
    'la sonda deve continuare a rifiutare di indovinare l\'identità da GH_TOKEN');
  assert.match(PROBE_SHELL_PUSH_TOKEN_RE.source, /GITHUB_PAT_NANAKO/);
  assert.match(IF_ENV_TOKEN_RE.source, /GITHUB_PAT/);
  assert.match(ENV_CONTEXT_HANDOFF_RE.source, /GH_TOKEN/);
  assert.match(PROBE_ENV_PUSH_TOKEN_RE.source, /PUSH_TOKEN/);
});
