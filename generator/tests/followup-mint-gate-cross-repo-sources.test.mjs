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

import {
  decideMintGate,
  demotedBlock,
  demotedItemsBySourcePr,
  preserveDemotedOnSourcePrs,
  qualifySourcePrLookups,
  resolveSourcePrTriage,
  triageMarkerCitesBucket,
} from '../../scripts/ci/gate-minted-followups.mjs';
import { verifyTriageMarkerPersistence } from '../../scripts/ci/collect-followup-batch.mjs';

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

/* ── Un item demoto va SOLO sulla sua PR sorgente, qualificata col repository ── */

// Caso reale corpus #1742 (run 36214063543, 35973121007): «PR #1742 bucket non
// leggibile (item=1, bucket=[9769])». Il bucket #9769 vive nel SITO e cita
// `Sources: PR #1742` della PR del CORPUS; anche il sito ha una PR #1742. Il
// gate commentava TUTTI gli item demoti su TUTTE le Sources, risolvendo ogni
// numero nel primo repository in cui era una PR: corpus #1742 ha ricevuto gli
// item di #1740, #1741 e #1771 ma mai il proprio.
const BUCKET = 9769;
const MARKER_AT = '2026-09-25T00:15:59Z';
const MARKER_1742 = [
  '## Post-merge follow-up triage',
  'Bucket giornaliero: #9769 (`follow-up(daily:2026-09-25): 9 items — valerielinc-ops/frontaliere-si-o-no`).',
  'Follow-up item: FU-2026-09-25-009',
].join('\n');
const markerFor = (bucket) => JSON.stringify({ comments: [{ createdAt: MARKER_AT, body: MARKER_1742.replace('#9769', `#${bucket}`) }] });
const demotedText = (pr, what) => `\n- State: open\n- Target repository: valerielinc-ops/frontaliere-si-o-no\n- Sources: PR #${pr}\n- Suggested action: controllare ${what}\n`;

test('ogni item demoto viene raggruppato solo sotto le PR della SUA Sources', () => {
  const groups = demotedItemsBySourcePr([demotedText(1742, 'uno'), demotedText(1740, 'due')], [1740, 1741, 1742, 1771]);
  assert.deepEqual(groups.map(({ pr, items }) => [pr, items.length]), [[1742, 1], [1740, 1]]);
  assert.match(groups[0].items[0], /controllare uno/);
});

test('la PR sorgente e\' quella il cui marker cita il bucket, non la prima omonima', () => {
  const site = lookup('site/r', { 1742: { ok: true, comments: markerFor(1234) } });
  const corpus = lookup('corpus/r', { 1742: { ok: true, comments: markerFor(BUCKET) } });
  assert.equal(triageMarkerCitesBucket(markerFor(BUCKET), BUCKET), true);
  assert.deepEqual(qualifySourcePrLookups(1742, BUCKET, [site, corpus]).map((l) => l.repo), ['corpus/r']);
  // Nessun marker cita il bucket: resta la risoluzione legacy, il testo non si perde.
  assert.deepEqual(qualifySourcePrLookups(1742, 5555, [site, corpus]).map((l) => l.repo), ['site/r']);
  // Un guasto prima di poter decidere: null, nessuna riscrittura del bucket.
  assert.equal(qualifySourcePrLookups(1742, BUCKET, [site, { repo: 'corpus/r', read: () => ({ ok: false, notPr: false }) }]), null);
});

test('contratto gate → collector: il commento sulla PR sorgente rende OK la verifica dell item demotato dopo il marker', () => {
  const posts = [];
  const results = preserveDemotedOnSourcePrs({
    bucketNumber: BUCKET,
    demoted: [demotedText(1742, 'item-di-1742'), demotedText(1740, 'item-di-1740')],
    fallbackTargets: [1740, 1742],
    intro: `<!-- followup-mint-gate -->\n## Item demoti dal gate sul conio\n\nIssue #${BUCKET} resta aperta con 7 item validi; questi sono stati tolti dal suo corpo e vivono solo qui.`,
    lookups: [
      lookup('site/r', { 1742: { ok: true, comments: markerFor(1234) } }),
      lookup('corpus/r', { 1742: { ok: true, comments: markerFor(BUCKET) }, 1740: { ok: true, comments: markerFor(BUCKET) } }),
    ],
    post: (l, pr, body) => { posts.push({ repo: l.repo, pr, body }); return 'ok'; },
    log: () => {},
  });
  assert.deepEqual(results, ['ok', 'ok']);
  assert.deepEqual(posts.map((p) => `${p.repo}#${p.pr}`), ['corpus/r#1742', 'corpus/r#1740']);
  assert.match(posts[0].body, /item-di-1742/);
  assert.doesNotMatch(posts[0].body, /item-di-1740/);

  // Il bucket, dopo la demozione, non cita piu' #1742: la sola prova e' il commento.
  const bucketAfter = {
    number: BUCKET,
    title: 'follow-up(daily:2026-09-25): 7 items — valerielinc-ops/frontaliere-si-o-no',
    body: '### FU-2026-09-25-001 — altro\n- Sources: PR #9560\n',
  };
  const prComments = (gateBody) => JSON.stringify({ comments: [
    { createdAt: MARKER_AT, body: MARKER_1742 },
    { createdAt: '2026-09-25T00:18:40Z', body: gateBody },
  ] });
  assert.equal(verifyTriageMarkerPersistence(MARKER_1742, 1742, () => bucketAfter, prComments(posts[0].body)), true);
  // Il commento che #1742 riceveva prima (i soli item di un'altra PR) non prova nulla.
  assert.equal(verifyTriageMarkerPersistence(MARKER_1742, 1742, () => bucketAfter, prComments(posts[1].body)), false);
});

test('gate vero: stesso numero di PR nei due repository, commento solo sulla PR sorgente dell item', () => {
  const root = mkdtempSync(join(tmpdir(), 'followup-same-number-'));
  const calls = join(root, 'calls');
  const state = join(root, 'state.json');
  writeFileSync(calls, '');
  const valid = [
    '### FU-2026-09-25-001 — queue candidate',
    '- State: open',
    '- Target repository: site/r',
    '- Target file: `scripts/example.mjs`',
    '- Sources: PR #9633',
    '- Original text:',
    '  > controllo non sempre applicato',
    '- Suggested action: aggiungi `firstGuard()` in scripts/example.mjs',
    '- Acceptance token: `firstGuard()`',
    '',
  ].join('\n');
  const vague = (id, pr, what) => [
    `### ${id} — ${what}`,
    '- State: open',
    '- Target repository: site/r',
    '- Target file: `scripts/example.mjs`',
    `- Sources: PR #${pr}`,
    `- Suggested action: controllare ${what}`,
    '',
  ].join('\n');
  writeFileSync(state, JSON.stringify({
    number: BUCKET,
    title: 'follow-up(daily:2026-09-25): 3 items — site/r',
    body: ['## Batch', '- Daily key: 2026-09-25 (Europe/Zurich)', '- State: collecting', '- Target repository: site/r', '',
      '## Item', '', valid, vague('FU-2026-09-25-002', 1742, 'item-di-1742'), vague('FU-2026-09-25-003', 1740, 'item-di-1740')].join('\n'),
    labels: [{ name: 'follow-up' }],
    createdAt: new Date().toISOString(),
  }));
  writeFileSync(join(root, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const repo = args.includes('--repo') ? args[args.indexOf('--repo') + 1] : '';
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, token: process.env.GH_TOKEN }) + '\\n');
const readState = () => JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const marker = (bucket) => ({ body: '## Post-merge follow-up triage\\nBucket giornaliero: #' + bucket + ' (daily).' });
const prs = { 'site/r': { '9633': [marker(9769)], '1742': [marker(1234)] }, 'corpus/r': { '1742': [marker(9769)], '1740': [marker(9769)] } };
if (args[0] === 'api') {
  const c = readState();
  process.stdout.write(JSON.stringify([[{ number: c.number, title: c.title, state: 'open', labels: c.labels, created_at: c.createdAt }]]));
} else if (args[0] === 'issue' && args[1] === 'view') process.stdout.write(JSON.stringify(readState()));
else if (args[0] === 'pr' && (args[1] === 'view' || args[1] === 'comment')) {
  const comments = (prs[repo] || {})[args[2]];
  if (!comments) { process.stderr.write('GraphQL: Could not resolve to a PullRequest with the number of ' + args[2] + '. (repository.pullRequest)\\n'); process.exit(1); }
  if (args[1] === 'view') process.stdout.write(JSON.stringify({ comments }));
} else if (args[0] === 'issue' && args[1] === 'edit' && args.includes('--body-file')) {
  const u = readState();
  u.body = fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
  fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(u));
}
`);
  chmodSync(join(root, 'gh'), 0o755);
  const env = {
    ...process.env,
    PATH: `${root}:${process.env.PATH}`,
    GH_REPO: 'site/r',
    GH_TOKEN: 'site-token',
    GATE_ALT_PR_REPO: 'corpus/r',
    GATE_ALT_PR_TOKEN: 'corpus-token',
    BATCH_PRS: '',
    TRIAGE_COMPLETE: 'true',
    COLLECTION_OK: 'true',
    DRY_RUN: '',
    GITHUB_STEP_SUMMARY: '',
  };
  delete env.GATE_PR_REPO;
  delete env.GATE_PR_TOKEN;
  try {
    const result = spawnSync(process.execPath, [GATE], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const recorded = readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const comments = recorded.filter((c) => c.args[0] === 'pr' && c.args[1] === 'comment');
    const where = (c) => `${c.args[c.args.indexOf('--repo') + 1]}#${c.args[2]}`;
    const body = (c) => c.args[c.args.indexOf('--body') + 1];
    assert.deepEqual(comments.map(where).sort(), ['corpus/r#1740', 'corpus/r#1742'], result.stdout);
    const on1742 = comments.find((c) => c.args[2] === '1742');
    assert.equal(on1742.token, 'corpus-token');
    assert.match(body(on1742), /Issue #9769/);
    assert.match(body(on1742), /- Sources: PR #1742/);
    assert.doesNotMatch(body(on1742), /item-di-1740/);
    const after = JSON.parse(readFileSync(state, 'utf8')).body;
    assert.doesNotMatch(after, /item-di-174[02]/);
    assert.match(after, /FU-2026-09-25-001/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('il ramo suppress di un daily conserva il TESTO dell item, non [object Object]', () => {
  const body = ['## Batch', '- Daily key: 2026-09-25 (Europe/Zurich)', '- State: collecting', '- Target repository: o/r', '',
    '### FU-2026-09-25-001 — vago', '- State: open', '- Target repository: o/r', '- Sources: PR #1742', '- Suggested action: controllare il file', ''].join('\n');
  const d = decideMintGate({ title: 'follow-up(daily:2026-09-25): 1 item — o/r', body }, { triageComplete: true });
  assert.equal(d.action, 'suppress');
  assert.ok(d.demoted.every((it) => typeof it === 'string'));
  assert.match(demotedBlock(d.demoted), /- Sources: PR #1742/);
  assert.doesNotMatch(demotedBlock(d.demoted), /\[object Object\]/);
});

test('suppress di un daily con conservazione fallita sulla PR sorgente: nessun close, issue aperta', () => {
  // Review di valerielinc-ops/frontaliere-si-o-no#10070, stesso ramo qui: la
  // soppressione chiudeva la issue anche quando `preserveDemotedOnSourcePrs()`
  // non era riuscito, perdendo l'unica copia integrale degli item demoti.
  // `gh pr comment` fallisce con un guasto (non «non e' una PR»).
  const root = mkdtempSync(join(tmpdir(), 'followup-suppress-guard-'));
  const calls = join(root, 'calls');
  const state = join(root, 'state.json');
  writeFileSync(calls, '');
  writeFileSync(state, JSON.stringify({
    number: 1950,
    title: 'follow-up(daily:2026-09-26): 1 item — corpus/r',
    body: ['## Batch', '- Daily key: 2026-09-26 (Europe/Zurich)', '- State: collecting', '- Target repository: corpus/r', '',
      '## Item', '', '### FU-2026-09-26-001 — senza condizione di accettazione', '- State: open', '- Target repository: corpus/r',
      '- Target file: `scripts/example.mjs`', '- Sources: PR #1742', '- Suggested action: controllare il file', ''].join('\n'),
    state: 'open',
    labels: [{ name: 'follow-up' }],
    createdAt: new Date().toISOString(),
  }));
  writeFileSync(join(root, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args }) + '\\n');
const readState = () => JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
if (args[0] === 'api') {
  const c = readState();
  process.stdout.write(JSON.stringify([[{ number: c.number, title: c.title, state: 'open', labels: c.labels, created_at: c.createdAt }]]));
} else if (args[0] === 'issue' && args[1] === 'view') process.stdout.write(JSON.stringify(readState()));
else if (args[0] === 'pr' && args[1] === 'view') process.stdout.write(JSON.stringify({ comments: [{ body: '## Post-merge follow-up triage\\nBucket giornaliero: #1950.' }] }));
else if (args[0] === 'pr' && args[1] === 'comment') { process.stderr.write('HTTP 502: Bad Gateway\\n'); process.exit(1); }
else if (args[0] === 'issue' && args[1] === 'close') { const u = readState(); u.state = 'closed'; fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(u)); }
`);
  chmodSync(join(root, 'gh'), 0o755);
  const env = {
    ...process.env,
    PATH: `${root}:${process.env.PATH}`,
    GH_REPO: 'corpus/r',
    GH_TOKEN: 'corpus-token',
    BATCH_PRS: '',
    TRIAGE_COMPLETE: 'true',
    COLLECTION_OK: 'true',
    DRY_RUN: '',
    GITHUB_STEP_SUMMARY: '',
  };
  for (const key of ['GATE_PR_REPO', 'GATE_PR_TOKEN', 'GATE_ALT_PR_REPO', 'GATE_ALT_PR_TOKEN']) delete env[key];
  try {
    const result = spawnSync(process.execPath, [GATE], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /#1950 \(daily:2026-09-26\) → suppress/);
    const recorded = readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(recorded.some((c) => c.args[0] === 'pr' && c.args[1] === 'comment'), 'la conservazione va tentata');
    assert.equal(recorded.some((c) => c.args[0] === 'issue' && c.args[1] === 'close'), false, result.stdout);
    assert.equal(recorded.some((c) => c.args[0] === 'issue' && c.args[1] === 'comment'), false, result.stdout);
    assert.equal(JSON.parse(readFileSync(state, 'utf8')).state, 'open');
    assert.match(result.stdout, /NON chiudo la issue/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
