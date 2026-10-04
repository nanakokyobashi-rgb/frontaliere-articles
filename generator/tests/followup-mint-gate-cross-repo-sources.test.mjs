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
  admissionCounts,
  bornSatisfiedCommentBody,
  bornSatisfiedToMark,
  decideMintGate,
  demotedBlock,
  demotedItemsBySourcePr,
  ghApiRunner,
  itemBornSatisfiedMarker,
  itemHeadline,
  mintCheckCounts,
  mintTargetContext,
  preserveDemotedOnSourcePrs,
  qualifySourcePrLookups,
  resolveSourcePrTriage,
  targetNoteLines,
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

/* ── Ammissione al conio nel passaggio del corpus (parità con FU-13/FU-14 del sito) ──
 *
 * Titolo di fallimento: «Conio follow-up (corpus): bucket sigillato senza i
 * controlli di ammissione». Un bucket del corpus è sigillato da due passaggi
 * (la copia del sito via API e questa); prima solo il sito demotava i bullet già
 * chiusi e i bersagli assenti, quindi il risultato dipendeva da chi sigillava
 * per primo. Qui l'`io` è l'API contents finta del repository del bucket: mai il disco.
 */
const ADMISSION_DAY = '2026-10-04';
const CLOSED_BULLET = JSON.parse(readFileSync(
  new URL('./fixtures/followup-mint/closed-bullets-10258-10289.json', import.meta.url), 'utf8',
)).closed[0].bullet;
// Un file `identical` del manifest vero (letto dal disco, come in produzione), fuori
// da `scripts/ci`: un path della macchina passerebbe anche da `machineAdmission()`.
// Accoppiamento voluto: se la voce cambia modo o sparisce dal manifest, scegline
// un'altra `identical` fuori da `scripts/ci` (l'assert sotto lo segnala).
const IDENTICAL_TARGET = 'scripts/lib/pr-body-sections-check.mjs';
assert.equal(
  JSON.parse(readFileSync(new URL('../../scripts/ci/loop-sync-manifest.json', import.meta.url), 'utf8'))
    .files?.find?.((entry) => entry?.path === IDENTICAL_TARGET)?.mode,
  'identical',
  `${IDENTICAL_TARGET} non è più identical nel manifest: aggiorna IDENTICAL_TARGET`,
);

// Un token per item: due item con lo stesso bersaglio e token sarebbero accorpati
// dal dedupe del fingerprint prima dell'ammissione.
const GUARD_TOKENS = ['firstGuard()', 'secondGuard()', 'thirdGuard()', 'fourthGuard()'];
const admissionItem = (seq, { title = 'proteggi il comportamento', state = 'open', target = 'scripts/example.mjs',
  original = 'controllo non sempre applicato', token = GUARD_TOKENS[seq - 1], action = null, pr = 1509 } = {}) => [
  `### FU-${ADMISSION_DAY}-${String(seq).padStart(3, '0')} — ${title}`,
  `- State: ${state}`,
  '- Target repository: corpus/r',
  `- Target file: \`${target}\``,
  `- Sources: PR #${pr}`,
  '- Original text:',
  `  > ${original}`,
  action ?? `- Suggested action: aggiungi \`${token}\` in \`${target}\``,
  ...(action ? [] : [`- Acceptance token: \`${token}\``]),
  '',
].join('\n');

const admissionBucket = (items, state = 'collecting') => ({
  number: 2001,
  title: `follow-up(daily:${ADMISSION_DAY}): ${items.length} items — corpus/r`,
  body: ['## Batch', `- Daily key: ${ADMISSION_DAY} (Europe/Zurich)`, `- State: ${state}`, '- Target repository: corpus/r', '',
    '## Item', '', ...items].join('\n'),
  labels: [{ name: 'follow-up' }],
  createdAt: new Date().toISOString(),
});

/** `io` finto con `status()`, come `contentsApiIo`. */
const statusIo = (files, fallback = 'missing') => ({
  status: (p) => (p in files ? 'present' : fallback),
  fileExists: (p) => p in files,
  readFile: (p) => files[p] ?? null,
});

const corpusTarget = (manifestFiles, twin = {}) => ({ side: 'corpus', manifestFiles, twinIo: statusIo(twin) });

test('bucket corpus collecting: bullet chiuso e bersaglio inesistente demotati con il loro codice', () => {
  const bucket = admissionBucket([
    admissionItem(1, { title: 'da un bullet chiuso', original: CLOSED_BULLET }),
    admissionItem(2, { title: 'bersaglio inesistente', target: 'scripts/missing.mjs' }),
    admissionItem(3, { title: 'lavoro vero' }),
  ]);
  const d = decideMintGate(bucket, {
    triageComplete: true,
    fileIo: statusIo({ 'scripts/example.mjs': 'export const x = 1;\n' }),
    mintTarget: corpusTarget([]),
  });
  assert.equal(d.action, 'demote');
  assert.deepEqual(d.demotedItems.map((item) => [item.id, item.demotion?.code]), [
    [`FU-${ADMISSION_DAY}-001`, 'closed-state-bullet'],
    [`FU-${ADMISSION_DAY}-002`, 'target-file-missing'],
  ]);
  assert.match(d.body, /- State: sealed/);
  assert.match(d.body, /lavoro vero/);
  assert.doesNotMatch(d.body, /bersaglio inesistente/);
  assert.deepEqual(mintCheckCounts(d.admissions), {
    closedState: 1, targetMissing: 1, targetInTwin: 0, targetRewritten: 0, targetIdenticalInCorpus: 0,
  });
  // L'elenco del commento e il blocco verbatim portano `ID — titolo` e il motivo.
  assert.equal(itemHeadline(d.demotedItems[0]), `FU-${ADMISSION_DAY}-001 — da un bullet chiuso`);
  const block = demotedBlock(d.demotedItems);
  assert.match(block, new RegExp(`### FU-${ADMISSION_DAY}-002 — bersaglio inesistente\\n- Demozione al conio: \`target-file-missing\``));
  assert.doesNotMatch(block, /\(senza titolo\)/);
  // Senza `fileIo` (il comportamento di prima) gli stessi item passavano e il bucket si sigillava.
  assert.equal(decideMintGate(bucket, { triageComplete: true }).action, 'seal');
});

test('io che risponde unknown: closed-state-bullet demotato comunque, nessuna demozione per il bersaglio', () => {
  const bucket = admissionBucket([
    admissionItem(1, { title: 'da un bullet chiuso', original: CLOSED_BULLET }),
    admissionItem(2, { title: 'bersaglio illeggibile', target: 'scripts/missing.mjs' }),
  ]);
  const unknownIo = statusIo({}, 'unknown');
  const d = decideMintGate(bucket, { triageComplete: true, fileIo: unknownIo, mintTarget: { ...corpusTarget([]), twinIo: unknownIo } });
  assert.equal(d.action, 'demote');
  assert.deepEqual(d.demotedItems.map((item) => item.demotion?.code), ['closed-state-bullet']);
  assert.match(d.body, /bersaglio illeggibile/);
  assert.equal(mintCheckCounts(d.admissions).targetMissing, 0);
  assert.ok(admissionCounts(d.admissions).admissionUnknown >= 1);
});

test('un item done con accettazione oggi non falsificabile resta nel corpo', () => {
  const bucket = admissionBucket([
    admissionItem(1, { title: 'già fatto', state: 'done', original: CLOSED_BULLET, action: '- Suggested action: controllare il file' }),
    admissionItem(2, { title: 'lavoro vero' }),
  ]);
  const d = decideMintGate(bucket, {
    triageComplete: true,
    fileIo: statusIo({ 'scripts/example.mjs': 'x' }),
    mintTarget: corpusTarget([]),
  });
  assert.equal(d.action, 'seal');
  assert.deepEqual(d.donePreserved, [`FU-${ADMISSION_DAY}-001`]);
  assert.match(d.body, /già fatto/);
  assert.equal(d.admissions.some((entry) => entry.id === `FU-${ADMISSION_DAY}-001`), false);
});

test('Target file identical in un bucket del corpus: ammesso, contato e annotato', () => {
  const bucket = admissionBucket([admissionItem(1, { title: 'gemello identical', target: IDENTICAL_TARGET })]);
  const manifest = [{ path: IDENTICAL_TARGET, mode: 'identical' }];
  const d = decideMintGate(bucket, {
    triageComplete: true,
    fileIo: statusIo({ [IDENTICAL_TARGET]: 'x' }),
    mintTarget: corpusTarget(manifest),
  });
  assert.equal(d.action, 'seal');
  assert.equal(mintCheckCounts(d.admissions).targetIdenticalInCorpus, 1);
  assert.deepEqual(targetNoteLines(d.admissions, d.rewritten),
    [`- FU-${ADMISSION_DAY}-001: \`${IDENTICAL_TARGET}\` è \`identical\` nel manifest di mirror: si corregge nel sito, non nel corpus.`]);
});

test('il marker FU_ITEM_BORN_SATISFIED ha la forma letterale del sito e si conta solo da autori fidati', () => {
  const id = `FU-${ADMISSION_DAY}-001`;
  assert.equal(itemBornSatisfiedMarker({ item: id.toLowerCase() }), `<!-- FU_ITEM_BORN_SATISFIED: item=${id} -->`);
  const admissions = [{ id, observed: ['acceptance-already-true'] }];
  const body = bornSatisfiedCommentBody(admissions.map((a) => ({ ...a, token: 'firstGuard()', targetFile: '`x.mjs`' })), 'corpus/r');
  assert.equal(bornSatisfiedToMark(admissions, [{ body, author: { login: 'github-actions' } }]).length, 0);
  assert.equal(bornSatisfiedToMark(admissions, [{ body, author: { login: 'estraneo' }, authorAssociation: 'NONE' }]).length, 1);
  assert.equal(bornSatisfiedToMark(admissions, null).length, 1);
});

/**
 * Il gate vero con un `gh` finto: issue, commenti e l'API contents dei due
 * repository. `failEdit` fa fallire la riscrittura del corpo (il bucket resta
 * collecting e la passata dopo lo rivaluta).
 */
function runAdmissionGate(bucket, { files = {}, contentsError = null, failEdit = false, passes = 1, env: envOverrides = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'followup-mint-admission-'));
  const calls = join(root, 'calls');
  const state = join(root, 'state.json');
  writeFileSync(calls, '');
  writeFileSync(state, JSON.stringify({ issue: bucket, comments: [] }));
  writeFileSync(join(root, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, token: process.env.GH_TOKEN || '' }) + '\\n');
const read = () => JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const write = (s) => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(s));
const files = ${JSON.stringify(files)};
const contentsError = ${JSON.stringify(contentsError)};
if (args[0] === 'api') {
  const url = args.find((a) => a.startsWith('repos/'));
  const m = /^repos\\/([^/]+\\/[^/]+)\\/contents\\/(.+)\\?ref=/.exec(url || '');
  if (m) {
    if (contentsError) { process.stderr.write(contentsError + '\\n'); process.exit(1); }
    const content = (files[m[1]] || {})[decodeURIComponent(m[2])];
    if (content == null) { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1); }
    process.stdout.write(content);
    process.exit(0);
  }
  const s = read();
  process.stdout.write(JSON.stringify([[{ number: s.issue.number, title: s.issue.title, state: 'open', labels: s.issue.labels, created_at: s.issue.createdAt }]]));
} else if (args[0] === 'issue' && args[1] === 'view') {
  const s = read();
  if (args.includes('comments')) process.stdout.write(JSON.stringify({ comments: s.comments }));
  else process.stdout.write(JSON.stringify(s.issue));
} else if (args[0] === 'issue' && args[1] === 'comment') {
  const s = read();
  s.comments.push({ body: args[args.indexOf('--body') + 1], author: { login: 'github-actions' } });
  write(s);
} else if (args[0] === 'issue' && args[1] === 'edit' && args.includes('--body-file')) {
  if (${JSON.stringify(failEdit)}) { process.stderr.write('HTTP 502: Bad Gateway\\n'); process.exit(1); }
  const s = read();
  s.issue.body = fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
  write(s);
} else if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({ comments: [{ body: '## Post-merge follow-up triage\\nBucket giornaliero: #' + read().issue.number + '.' }] }));
}
`);
  chmodSync(join(root, 'gh'), 0o755);
  const env = {
    ...process.env,
    PATH: `${root}:${process.env.PATH}`,
    GH_REPO: 'corpus/r',
    GH_TOKEN: 'corpus-token',
    FOLLOWUP_CORPUS_REPO: 'corpus/r',
    FOLLOWUP_SITE_REPO: 'site/r',
    BATCH_PRS: '',
    TRIAGE_COMPLETE: 'true',
    COLLECTION_OK: 'true',
    DRY_RUN: '',
    GITHUB_STEP_SUMMARY: '',
  };
  for (const key of ['GATE_PR_REPO', 'GATE_PR_TOKEN', 'GATE_ALT_PR_REPO', 'GATE_ALT_PR_TOKEN', 'MINT_ADMISSION_READ_CAP']) delete env[key];
  // Come il passaggio del corpus nel workflow: il gemello (sito) ha il suo token.
  Object.assign(env, { GATE_ALT_PR_REPO: 'site/r', GATE_ALT_PR_TOKEN: 'site-token' }, envOverrides);
  for (const [key, value] of Object.entries(envOverrides)) if (value === undefined) delete env[key];
  try {
    const runs = [];
    for (let i = 0; i < passes; i += 1) runs.push(spawnSync(process.execPath, [GATE], { encoding: 'utf8', env }));
    const recorded = readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    return { runs, calls: recorded, state: JSON.parse(readFileSync(state, 'utf8')) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const tallyOf = (stdout) => stdout.split('\n').find((line) => line.startsWith('MINT_GATE_TALLY repo=corpus/r pr=')) || '';

test('gate vero: il passaggio del corpus demota, conta in MINT_GATE_TALLY e motiva sulla PR sorgente', () => {
  const bucket = admissionBucket([
    admissionItem(1, { title: 'da un bullet chiuso', original: CLOSED_BULLET }),
    admissionItem(2, { title: 'bersaglio inesistente', target: 'scripts/missing.mjs' }),
    admissionItem(3, { title: 'gemello identical', target: IDENTICAL_TARGET }),
    admissionItem(4, { title: 'lavoro vero' }),
  ]);
  const { runs, calls, state } = runAdmissionGate(bucket, {
    files: { 'corpus/r': { 'scripts/example.mjs': 'export const x = 1;\n', [IDENTICAL_TARGET]: 'export {}\n' } },
  });
  const [run] = runs;
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const tally = tallyOf(run.stdout);
  assert.match(tally, /action=demote /, run.stdout);
  for (const field of ['demoted=2', 'kept=2', 'done_preserved=0', 'born_satisfied=0', 'closed_state=1',
    'target_missing=1', 'target_in_twin=0', 'target_identical_in_corpus=1']) {
    assert.ok(tally.includes(` ${field}`), `${field} assente: ${tally}`);
  }
  assert.match(run.stdout, /^MINT_GATE_ADMISSION repo=corpus\/r reads=\d+ read_cap=200 read_capped=0 read_errors=0$/m);
  const prComment = calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'comment');
  const prBody = prComment.args[prComment.args.indexOf('--body') + 1];
  assert.match(prBody, new RegExp(`### FU-${ADMISSION_DAY}-001 — da un bullet chiuso\\n- Demozione al conio: \`closed-state-bullet\``));
  assert.match(state.issue.body, /- State: sealed/);
  assert.doesNotMatch(state.issue.body, /bersaglio inesistente|da un bullet chiuso/);
  const issueComment = state.comments.map((c) => c.body).find((body) => body.includes('Rimossi dal corpo'));
  assert.match(issueComment, /Bersagli:\n- FU-2026-10-04-003: `scripts\/lib\/pr-body-sections-check\.mjs` è `identical`/);
  // Nessuna lettura dal disco per l'io: ogni file è passato dall'API contents del bucket.
  assert.ok(calls.some((c) => c.args.includes(`repos/corpus/r/contents/scripts/missing.mjs?ref=main`)));
});

test('gate vero: io API in errore → admission_unknown contato, solo il bullet chiuso esce', () => {
  const bucket = admissionBucket([
    admissionItem(1, { title: 'da un bullet chiuso', original: CLOSED_BULLET }),
    admissionItem(2, { title: 'bersaglio illeggibile', target: 'scripts/missing.mjs' }),
  ]);
  const { runs } = runAdmissionGate(bucket, { contentsError: 'HTTP 502: Bad Gateway' });
  const tally = tallyOf(runs[0].stdout);
  assert.match(tally, / demoted=1 kept=1 /, runs[0].stdout);
  assert.match(tally, / admission_unknown=1 closed_state=1 target_missing=0 /);
  assert.match(runs[0].stdout, /^MINT_GATE_ADMISSION repo=corpus\/r reads=\d+ read_cap=200 read_capped=0 read_errors=[1-9]/m);
});

test('gate vero: un item nato soddisfatto riceve UN solo marker anche su due passate', () => {
  const bucket = admissionBucket([admissionItem(1, { title: 'nato soddisfatto' })]);
  const { runs, state } = runAdmissionGate(bucket, {
    files: { 'corpus/r': { 'scripts/example.mjs': 'export function firstGuard(x) { return x; }\nfirstGuard(value);\n' } },
    // Il sigillo fallisce: il bucket resta collecting e la seconda passata lo rivaluta.
    failEdit: true,
    passes: 2,
  });
  for (const run of runs) {
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(tallyOf(run.stdout), / born_satisfied=1 /, run.stdout);
  }
  const markers = state.comments.filter((c) => c.body.includes(`<!-- FU_ITEM_BORN_SATISFIED: item=FU-${ADMISSION_DAY}-001 -->`));
  assert.equal(markers.length, 1, JSON.stringify(state.comments.map((c) => c.body.slice(0, 80))));
  assert.match(state.issue.body, /- State: collecting/);
});

/**
 * Il gemello si legge col SUO token (review #2097): `twinIo` passava da
 * `ghApiRaw`, che eredita il `GH_TOKEN` del bucket e ignora
 * `GATE_ALT_PR_TOKEN`/`GATE_PR_TOKEN`. Con un gemello illeggibile da quel token
 * il 404 diventava `missing` e un bersaglio valido usciva come
 * `target-file-missing`. Titolo di fallimento: «Conio follow-up: bersaglio del
 * gemello demotato perché letto con il token sbagliato».
 */
const SITE_LAYOUT = { GH_REPO: 'corpus/r', GH_TOKEN: 'corpus-token', FOLLOWUP_CORPUS_REPO: 'corpus/r', FOLLOWUP_SITE_REPO: 'site/r' };

const recordingRunner = (seen, answer = () => 'x') => (token) => {
  seen.push({ token });
  return (args) => {
    seen.push({ token, args });
    return answer(args);
  };
};

test('mintTargetContext: il runner del gemello riceve GATE_ALT_PR_TOKEN, non GH_TOKEN', () => {
  const seen = [];
  const ctx = mintTargetContext({
    readManifest: () => [],
    env: { ...SITE_LAYOUT, GATE_ALT_PR_REPO: 'site/r', GATE_ALT_PR_TOKEN: 'site-token' },
    ghFor: recordingRunner(seen),
  });
  assert.equal(ctx.side, 'corpus');
  assert.equal(ctx.twinIo.status('scripts/a.mjs'), 'present');
  const reads = seen.filter((entry) => entry.args);
  assert.deepEqual(reads.map((entry) => entry.token), ['site-token']);
  assert.ok(reads[0].args.some((arg) => arg.startsWith('repos/site/r/contents/scripts/a.mjs')));
  assert.equal(seen.some((entry) => entry.token === 'corpus-token'), false);
});

test('mintTargetContext: dal lato sito il gemello è il repository delle PR e usa GATE_PR_TOKEN', () => {
  const seen = [];
  const ctx = mintTargetContext({
    readManifest: () => [],
    env: { GH_REPO: 'site/r', GH_TOKEN: 'site-token', GATE_PR_REPO: 'corpus/r', GATE_PR_TOKEN: 'corpus-token',
      FOLLOWUP_CORPUS_REPO: 'corpus/r', FOLLOWUP_SITE_REPO: 'site/r' },
    ghFor: recordingRunner(seen),
  });
  assert.equal(ctx.side, 'site');
  assert.equal(ctx.twinIo.status('generator/x.mjs'), 'present');
  assert.deepEqual(seen.filter((entry) => entry.args).map((entry) => entry.token), ['corpus-token']);
});

test('gemello senza token dichiarato: unknown, nessuna lettura, item con bersaglio assente qui resta ammesso', () => {
  const seen = [];
  const ctx = mintTargetContext({
    readManifest: () => [],
    env: { ...SITE_LAYOUT, GATE_ALT_PR_REPO: 'site/r', GATE_ALT_PR_TOKEN: '' },
    ghFor: recordingRunner(seen),
  });
  assert.equal(ctx.twinIo.status('scripts/missing.mjs'), 'unknown');
  assert.deepEqual(seen, [], 'nessun runner costruito con un token di ripiego');
  const bucket = admissionBucket([admissionItem(1, { title: 'bersaglio nel gemello', target: 'scripts/missing.mjs' })]);
  const d = decideMintGate(bucket, { triageComplete: true, fileIo: statusIo({}), mintTarget: ctx });
  assert.equal(d.action, 'seal');
  assert.match(d.body, /bersaglio nel gemello/);
  assert.equal(mintCheckCounts(d.admissions).targetMissing, 0);
  assert.equal(admissionCounts(d.admissions).admissionUnknown, 1);
});

test('ghApiRunner passa il token al processo gh via env, non negli argomenti', () => {
  const root = mkdtempSync(join(tmpdir(), 'followup-mint-runner-'));
  writeFileSync(join(root, 'gh'), '#!/bin/sh\nprintf "%s|%s" "$GH_TOKEN" "$*"\n');
  chmodSync(join(root, 'gh'), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${root}:${previous}`;
  try {
    const [token, args] = ghApiRunner('twin-token')(['api', 'repos/site/r/contents/a.mjs']).split('|');
    assert.equal(token, 'twin-token');
    assert.equal(args.includes('twin-token'), false);
  } finally {
    process.env.PATH = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate vero: le letture del gemello portano il token del gemello, quelle del bucket il suo', () => {
  const bucket = admissionBucket([admissionItem(1, { title: 'bersaglio inesistente', target: 'scripts/missing.mjs' })]);
  const { runs, calls } = runAdmissionGate(bucket, { files: { 'corpus/r': {} } });
  assert.equal(runs[0].status, 0, runs[0].stdout + runs[0].stderr);
  const contents = (repo) => calls.filter((c) => c.args.some((arg) => arg.startsWith(`repos/${repo}/contents/`)));
  assert.ok(contents('site/r').length > 0, 'il gemello non è stato letto');
  assert.deepEqual([...new Set(contents('site/r').map((c) => c.token))], ['site-token']);
  assert.deepEqual([...new Set(contents('corpus/r').map((c) => c.token))], ['corpus-token']);
  assert.doesNotMatch(runs[0].stdout + runs[0].stderr, /site-token/, 'il token del gemello non finisce nei log');
});

test('gate vero: gemello senza token → target_missing=0 e admission_unknown, nessuna lettura col token del bucket', () => {
  const bucket = admissionBucket([admissionItem(1, { title: 'bersaglio nel gemello', target: 'scripts/missing.mjs' })]);
  const { runs, calls, state } = runAdmissionGate(bucket, { files: { 'corpus/r': {} }, env: { GATE_ALT_PR_TOKEN: undefined } });
  const tally = tallyOf(runs[0].stdout);
  assert.match(tally, / demoted=0 kept=1 /, runs[0].stdout);
  assert.match(tally, / admission_unknown=1 closed_state=0 target_missing=0 /);
  assert.equal(calls.some((c) => c.args.some((arg) => arg.startsWith('repos/site/r/contents/'))), false);
  assert.match(state.issue.body, /bersaglio nel gemello/);
});
