/**
 * followup-mint-gate-cross-repo-sources.test.mjs — le `Sources: PR #N` di un
 * daily bucket non portano il repository, ma il bucket puo' contenere item
 * instradati dall'altro repository.
 *
 * Misurato: il daily corpus #1508 (2026-09-15) cita `PR #8699`/`#8696`/`#8692`/
 * `#8769`/`#8764` del sito accanto a `PR #1509` di questo repo. Il recovery
 * storico di `gate-minted-followups.mjs` cercava tutte le Sources in
 * `GATE_PR_REPO`, cioe' qui: `gh pr view 8699` rispondeva «Could not resolve to
 * a PullRequest», `scanOk` diventava false e il bucket restava `collecting`
 * (`historical-triage-scan-unavailable`) a ogni run di post-merge-followup.
 *
 * Il gemello del sito ha la stessa correzione (`resolveSourcePrTriage`): si
 * passa al repository gemello SOLO sulla risposta definitiva «non e' una PR»;
 * un guasto resta `unavailable` e non viene indovinato altrove.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { resolveSourcePrTriage } from '../../scripts/ci/gate-minted-followups.mjs';

const GATE = fileURLToPath(new URL('../../scripts/ci/gate-minted-followups.mjs', import.meta.url));
const WORKFLOW = readFileSync(new URL('../../.github/workflows/post-merge-followup.yml', import.meta.url), 'utf8');
const MARKER = JSON.stringify({ comments: [{ body: '## Post-merge follow-up triage\n\nCreated/updated: 0 item.' }] });
const NO_MARKER = JSON.stringify({ comments: [{ body: 'lgtm' }] });

const lookup = (repo, answers) => ({
  repo,
  read: (n) => answers[n] ?? { ok: false, notPr: true },
});

test('resolveSourcePrTriage passa al gemello solo su «non e\' una PR»', () => {
  const corpus = lookup('corpus/r', { 1509: { ok: true, comments: MARKER } });
  const site = lookup('site/r', { 8699: { ok: true, comments: MARKER }, 1509: { ok: true, comments: NO_MARKER } });

  assert.deepEqual(resolveSourcePrTriage(8699, [corpus, site]), { status: 'triaged', repo: 'site/r', fallback: true });
  // Un numero che e' PR in entrambi si legge nel repository delle PR, come prima.
  assert.deepEqual(resolveSourcePrTriage(1509, [corpus, site]), { status: 'triaged', repo: 'corpus/r', fallback: false });
  assert.equal(resolveSourcePrTriage(8699, [corpus, lookup('site/r', { 8699: { ok: true, comments: NO_MARKER } })]).status,
    'untriaged');
  // Nessun gemello: la Source resta non verificabile (comportamento di prima).
  assert.deepEqual(resolveSourcePrTriage(8699, [corpus]),
    { status: 'unavailable', repo: null, fallback: false, notPrAnywhere: true });
});

test('un guasto nel repository delle PR non viene indovinato nel gemello', () => {
  let siteRead = false;
  const broken = { repo: 'corpus/r', read: () => ({ ok: false, notPr: false }) };
  const site = { repo: 'site/r', read: () => { siteRead = true; return { ok: true, comments: MARKER }; } };
  assert.deepEqual(resolveSourcePrTriage(8699, [broken, site]), { status: 'unavailable', repo: 'corpus/r', fallback: false });
  assert.equal(siteRead, false);
});

/**
 * Il gate vero, con un `gh` finto: daily corpus con una Source locale e una del
 * sito. `demote` aggiunge un terzo item, sourced dal sito, senza condizione di
 * accettazione: il gate deve conservarlo commentando la PR dove E' una PR.
 */
function runRecovery(extraEnv, { demote = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'followup-cross-repo-sources-'));
  const calls = join(root, 'calls');
  writeFileSync(calls, '');
  const title = 'follow-up(daily:2026-09-15): 2 items — corpus/r';
  const item = (id, pr, token) => [
    `### ${id} — proteggi il comportamento`,
    '- State: open',
    '- Target repository: corpus/r',
    '- Target file: `scripts/example.mjs`',
    `- Sources: PR #${pr}`,
    '- Original text:',
    '  > controllo non sempre applicato',
    `- Suggested action: aggiungi \`${token}\` in scripts/example.mjs`,
    `- Acceptance token: \`${token}\``,
    '',
  ].join('\n');
  const issue = {
    number: 1508,
    title,
    body: [
      '## Batch',
      '- Daily key: 2026-09-15 (Europe/Zurich)',
      '- State: collecting',
      '- Target repository: corpus/r',
      '',
      '## Item',
      '',
      item('FU-2026-09-15-001', 8699, 'firstGuard()'),
      item('FU-2026-09-15-002', 1509, 'secondGuard()'),
      ...(demote ? [[
        '### FU-2026-09-15-003 — senza condizione di accettazione',
        '- State: open',
        '- Target repository: corpus/r',
        '- Target file: `scripts/example.mjs`',
        '- Sources: PR #8699',
        '- Suggested action: controllare scripts/example.mjs',
        '',
      ].join('\n')] : []),
    ].join('\n'),
    labels: [{ name: 'follow-up' }],
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(root, 'gh'), `#!/usr/bin/env node
const args = process.argv.slice(2);
const repo = args.includes('--repo') ? args[args.indexOf('--repo') + 1] : '';
const issue = ${JSON.stringify(issue)};
const marker = ${JSON.stringify(MARKER)};
require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, token: process.env.GH_TOKEN }) + '\\n');
if (args[0] === 'api') {
  console.log(JSON.stringify([[{ number: issue.number, title: issue.title, state: 'open', labels: issue.labels, created_at: issue.createdAt }]]));
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'view') { console.log(JSON.stringify(issue)); process.exit(0); }
if (args[0] === 'pr' && args[1] === 'view') {
  const n = args[2];
  if (repo === 'corpus/r' && n === '1509') { console.log(marker); process.exit(0); }
  if (repo === 'site/r' && n === '8699' && process.env.GH_TOKEN === 'site-token') { console.log(marker); process.exit(0); }
  process.stderr.write('GraphQL: Could not resolve to a PullRequest with the number of ' + n + '. (repository.pullRequest)\\n');
  process.exit(1);
}
if (args[0] === 'pr' && args[1] === 'comment') {
  const n = args[2];
  if ((repo === 'corpus/r' && n === '1509') || (repo === 'site/r' && n === '8699' && process.env.GH_TOKEN === 'site-token')) process.exit(0);
  process.stderr.write('GraphQL: Could not resolve to a PullRequest with the number of ' + n + '. (repository.pullRequest)\\n');
  process.exit(1);
}
process.exit(0);
`);
  chmodSync(join(root, 'gh'), 0o755);
  const env = {
    ...process.env,
    PATH: `${root}:${process.env.PATH}`,
    GH_REPO: 'corpus/r',
    GH_TOKEN: 'corpus-token',
    BATCH_PRS: '',
    TRIAGE_COMPLETE: 'false',
    COLLECTION_OK: 'true',
    DRY_RUN: '1',
    GITHUB_STEP_SUMMARY: '',
    ...extraEnv,
  };
  for (const key of ['GATE_PR_REPO', 'GATE_PR_TOKEN', 'GATE_ALT_PR_REPO', 'GATE_ALT_PR_TOKEN']) {
    if (!(key in extraEnv)) delete env[key];
  }
  try {
    const result = spawnSync(process.execPath, [GATE], { encoding: 'utf8', env });
    const recorded = readFileSync(calls, 'utf8').trim();
    result.calls = recorded ? recorded.split('\n').map((line) => JSON.parse(line)) : [];
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('senza repository gemello il daily con Sources del sito resta negato', () => {
  const result = runRecovery({});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /recovery per bucket negato \(historical-triage-scan-unavailable\)/);
  assert.match(result.stdout, /PR #8699 non è una PR in corpus\/r → Source non verificabile/);
});

test('con GATE_ALT_PR_REPO la Source del sito si risolve la\' e il recovery e\' ammesso', () => {
  const result = runRecovery({ GATE_ALT_PR_REPO: 'site/r', GATE_ALT_PR_TOKEN: 'site-token' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PR #8699 non è una PR in corpus\/r → Source risolta in site\/r/);
  assert.match(result.stdout, /marker storici verificati \(PR #8699, PR #1509\) → recovery ammesso/);
});

test('un gemello dichiarato senza token resta non verificabile, non ammesso', () => {
  const result = runRecovery({ GATE_ALT_PR_REPO: 'site/r', GATE_ALT_PR_TOKEN: '' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /nessun token per site\/r/);
  assert.match(result.stdout, /recovery per bucket negato \(historical-triage-scan-unavailable\)/);
});

test('la demozione di un daily conserva l\'item sulla PR del sito, dove e\' una PR', () => {
  const result = runRecovery({ DRY_RUN: '', GATE_ALT_PR_REPO: 'site/r', GATE_ALT_PR_TOKEN: 'site-token' }, { demote: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const comments = result.calls.filter((call) => call.args[0] === 'pr' && call.args[1] === 'comment');
  const onSite = comments.find((call) => call.args[2] === '8699' && call.args.includes('site/r'));
  assert.ok(onSite, `nessun commento sulla PR #8699 del sito: ${JSON.stringify(comments.map((c) => c.args.slice(0, 5)))}`);
  assert.equal(onSite.token, 'site-token');
  // Il commento e' riuscito, quindi il corpo viene riscritto senza l'item demoto.
  assert.ok(result.calls.some((call) => call.args[0] === 'issue' && call.args[1] === 'edit' && call.args.includes('--body-file')),
    result.stdout);
});

test('i due gate corpus di post-merge-followup dichiarano il sito come repository gemello', () => {
  for (const step of ['Gate sul conio — demota gli item senza condizione di accettazione (zero-provider)',
    'Gate sul conio — corpus (zero-provider)']) {
    const start = WORKFLOW.indexOf(`- name: ${step}`);
    assert.ok(start >= 0, `step «${step}» assente`);
    const next = WORKFLOW.indexOf('\n      - name:', start + 1);
    const block = WORKFLOW.slice(start, next < 0 ? undefined : next);
    assert.match(block, /GATE_ALT_PR_REPO: valerielinc-ops\/frontaliere-si-o-no/, step);
    // Il token dalla shell dopo load-rc-env, mai dal contesto `env.*` (AGENTS.md).
    assert.match(block, /GATE_ALT_PR_TOKEN="\$\{GITHUB_PAT_SITE:-\$\{GITHUB_PAT:-\}\}"/, step);
    assert.doesNotMatch(block, /GATE_ALT_PR_TOKEN: \$\{\{/, step);
  }
});
