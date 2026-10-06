/**
 * close-superseded-conflict-prs.test.mjs — le decisioni di
 * `scripts/ci/close-superseded-conflict-prs.mjs`, sulle sole funzioni pure.
 * Run with `node --test generator/tests/close-superseded-conflict-prs.test.mjs`.
 *
 * Le fixture sono gli stati misurati il 2026-10-06: #2205 (riapplicazione di
 * #2201, già mergiata), #2246 (hand-off #2250 chiuso dal fixer con
 * `already-fixed`) e i duplicati della stessa causa con la sorgente chiusa.
 * Ogni caso positivo ha accanto i negativi che lo rendono stretto: lo sweep
 * CHIUDE PR, quindi il verso sicuro in cui sbagliare è lasciarle aperte.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_CLOSES_PER_RUN,
  SUPERSEDED_MARKER,
  closingComment,
  decideHandoffAlreadyFixed,
  decideReapplyOfMergedOrigin,
  decideSourceIssuesClosed,
  fixerIssueOfBranch,
  handoffTitleQuery,
  isSweepCandidate,
  isTrustedComment,
  latestHandoffOf,
} from '../../scripts/ci/close-superseded-conflict-prs.mjs';
import { buildConflictHandoffIssue } from '../../scripts/ci/pr-autorebase.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const HEAD = '244f876cdaaa64fa9a5530933f6356de47202ab8';

const loopPr = (over = {}) => ({
  number: 2246,
  title: 'fix(cantoni): prevent workflow self-trigger burst',
  body: '## Implementato\n\n- fix\nCloses #2236\n\n## Non implementato (ancora)\n\n- niente, per scelta',
  headRefName: 'fix/issue-2236',
  headRefOid: HEAD,
  isDraft: false,
  mergeable: 'CONFLICTING',
  labels: [{ name: 'has-conflicts' }, { name: 'agent:autofix' }],
  ...over,
});

// L'hand-off è costruito dal producer vero: se pr-autorebase cambia titolo o
// body, questo consumer deve accorgersene qui e non in produzione.
const handoffOf = (pr, over = {}) => {
  const { title, body } = buildConflictHandoffIssue({
    num: pr.number, branch: pr.headRefName, head: pr.headRefOid, files: ['scripts/ci/x.mjs'],
  });
  return {
    number: 2250, title, body, labels: [{ name: 'agent:triaged' }], createdAt: '2026-10-05T23:06:00Z', ...over,
  };
};

const verdict = (code, over = {}) => ({
  body: `Root cause: già su main.\n<!-- FIX_OUTCOME: ${code} -->`,
  created_at: '2026-10-06T00:18:00Z',
  author_association: 'OWNER',
  user: { login: 'nanakokyobashi-rgb' },
  ...over,
});

// ── Candidatura ─────────────────────────────────────────────────────────────

test('candidata: PR del ciclo, in conflitto, non draft', () => {
  assert.equal(isSweepCandidate(loopPr()).candidate, true);
  // `fix/*` senza label resta una PR del ciclo (branch storico del fixer).
  assert.equal(isSweepCandidate(loopPr({ labels: [{ name: 'has-conflicts' }] })).candidate, true);
});

test('non candidata: senza conflitto, umana, draft, fuori dal ciclo, o tornata mergeable', () => {
  const reason = (over) => isSweepCandidate(loopPr(over)).reason;
  assert.equal(reason({ labels: [{ name: 'agent:autofix' }] }), 'no-conflict-label');
  assert.equal(reason({ headRefName: 'feat/p7b', labels: [{ name: 'has-conflicts' }] }), 'not-loop-pr');
  assert.equal(reason({ isDraft: true }), 'draft');
  assert.equal(reason({ labels: [{ name: 'has-conflicts' }, { name: 'agent:autofix' }, { name: 'needs-human' }] }), 'hands-off-label');
  assert.equal(reason({ labels: [{ name: 'has-conflicts' }, { name: 'agent:autofix' }, { name: 'keep-open' }] }), 'hands-off-label');
  // La label è una fotografia di merge-tree: se GitHub dice MERGEABLE il
  // conflitto è appena rientrato e decide pr-autorebase, non questo sweep.
  assert.equal(reason({ mergeable: 'MERGEABLE' }), 'mergeable-now');
  // `UNKNOWN` (tipico subito dopo un push su main) o un campo assente non
  // confermano il conflitto: lo sweep gira anche se l'autorebase che ricalcola
  // la label è fallito, quindi serve `CONFLICTING` da GitHub.
  assert.equal(reason({ mergeable: 'UNKNOWN' }), 'conflict-unconfirmed');
  assert.equal(reason({ mergeable: undefined }), 'conflict-unconfirmed');
  assert.equal(reason({ mergeable: '' }), 'conflict-unconfirmed');
});

// ── Caso 1: riapplicazione di un'origine mergiata (#2205 → #2201) ───────────

const reapplyPr = loopPr({ number: 2205, headRefName: 'fix/issue-2204', title: 'feat(mobilita): riapplica P9c su main' });
const handoffOfOrigin = { number: 2204, title: 'Conflitto con main dopo LGTM: riapplicare la PR #2201 su main' };

test('caso 1 — la PR di origine ha mergiato: la riapplicazione è superata', () => {
  assert.deepEqual(
    decideReapplyOfMergedOrigin({ pr: reapplyPr, fixerIssue: handoffOfOrigin, origin: { state: 'MERGED' } }),
    { close: true, reason: 'reapply-origin-merged', origin: 2201, handoff: 2204 },
  );
  // La forma del titolo senza «dopo LGTM» è lo stesso hand-off.
  const plain = { number: 2204, title: 'Conflitto con main: riapplicare la PR #2201 su main' };
  assert.equal(decideReapplyOfMergedOrigin({ pr: reapplyPr, fixerIssue: plain, origin: { state: 'MERGED' } }).close, true);
});

test('caso 1 — resta aperta finché l\'origine non è MERGED o non si legge', () => {
  const reason = (over) => decideReapplyOfMergedOrigin({
    pr: reapplyPr, fixerIssue: handoffOfOrigin, origin: { state: 'MERGED' }, ...over,
  }).reason;
  assert.equal(reason({ origin: { state: 'OPEN' } }), 'origin-not-merged');
  // Chiusa senza merge: il contributo NON è su main, la riapplicazione serve.
  assert.equal(reason({ origin: { state: 'CLOSED' } }), 'origin-not-merged');
  assert.equal(reason({ origin: null }), 'origin-unreadable');
  assert.equal(reason({ fixerIssue: null }), 'fixer-issue-unreadable');
  assert.equal(reason({ fixerIssue: { number: 2204, title: 'Workflow Failure: tests' } }), 'fixer-issue-not-a-handoff');
  assert.equal(reason({ pr: loopPr({ headRefName: 'codex/altro' }) }), 'not-a-fixer-branch');
  assert.equal(fixerIssueOfBranch('fix/issue-2204'), 2204);
  assert.equal(fixerIssueOfBranch('fix/issue-2204-bis'), null);
});

// ── Caso 2: hand-off chiuso dal fixer con `already-fixed` (#2246 / #2250) ────

test('caso 2 — verdetto already-fixed sull\'hand-off della HEAD corrente: superata', () => {
  const pr = loopPr();
  assert.deepEqual(
    decideHandoffAlreadyFixed({ pr, handoff: handoffOf(pr), comments: [verdict('already-fixed')], openPrs: [pr] }),
    { close: true, reason: 'handoff-already-fixed', handoff: 2250 },
  );
});

test('caso 2 — ogni condizione mancante lascia la PR aperta', () => {
  const pr = loopPr();
  const reason = (over) => decideHandoffAlreadyFixed({
    pr, handoff: handoffOf(pr), comments: [verdict('already-fixed')], openPrs: [pr], ...over,
  }).reason;
  assert.equal(reason({ handoff: null }), 'no-handoff');
  assert.equal(reason({ handoff: handoffOf(loopPr({ number: 2249 })) }), 'handoff-of-another-pr');
  // Una HEAD nuova è un contributo nuovo: il verdetto parlava di quella vecchia.
  assert.equal(reason({ pr: loopPr({ headRefOid: 'f'.repeat(40) }) }), 'handoff-head-mismatch');
  assert.equal(reason({ handoff: handoffOf(pr, { labels: [{ name: 'agent:in-progress' }] }) }), 'handoff-in-progress');
  assert.equal(reason({ comments: null }), 'handoff-comments-unreadable');
  assert.equal(reason({ openPrs: null }), 'open-prs-unreadable');
  assert.equal(reason({ comments: [] }), 'no-trusted-verdict');
  // Solo `already-fixed` dice «niente da riapplicare»: gli altri verdetti no.
  assert.equal(reason({ comments: [verdict('blocked-secrets')] }), 'verdict-blocked-secrets');
  assert.equal(reason({ comments: [verdict('pr-created')] }), 'verdict-pr-created');
  // Conta l'ULTIMO verdetto: un già-risolto superato da un giro nuovo non vale.
  assert.equal(
    reason({ comments: [verdict('already-fixed'), verdict('no-root-cause', { created_at: '2026-10-06T02:00:00Z' })] }),
    'verdict-no-root-cause',
  );
  // Un verdetto più vecchio dell'hand-off appartiene a un'altra storia.
  assert.equal(reason({ comments: [verdict('already-fixed', { created_at: '2026-10-05T20:00:00Z' })] }), 'verdict-not-after-handoff');
});

test('caso 2 — una riapplicazione in volo ha la precedenza sul verdetto', () => {
  const pr = loopPr();
  const reason = (reapply) => decideHandoffAlreadyFixed({
    pr, handoff: handoffOf(pr), comments: [verdict('already-fixed')], openPrs: [pr, reapply],
  }).reason;
  assert.equal(reason({ number: 2290, headRefName: 'fix/issue-2250', body: '' }), 'reapply-in-flight');
  assert.equal(reason({ number: 2291, headRefName: 'codex/x', body: 'Supersedes #2246' }), 'reapply-in-flight');
});

test('caso 2 — un marker incollato da fuori non chiude niente', () => {
  const pr = loopPr();
  const outsider = verdict('already-fixed', { author_association: 'NONE', user: { login: 'passante' } });
  assert.equal(isTrustedComment(outsider), false);
  assert.equal(
    decideHandoffAlreadyFixed({ pr, handoff: handoffOf(pr), comments: [outsider], openPrs: [pr] }).reason,
    'no-trusted-verdict',
  );
  // Il fixer commenta anche come bot di Actions, che non ha un'associazione.
  assert.equal(isTrustedComment({ author_association: 'NONE', user: { login: 'github-actions[bot]' } }), true);
  assert.equal(isTrustedComment({ author_association: 'COLLABORATOR', user: { login: 'valerielinc-ops' } }), true);
});

test('l\'hand-off più recente della PR si trova con entrambe le forme del titolo', () => {
  const issues = [
    { number: 2250, title: 'Conflitto con main dopo LGTM: riapplicare la PR #2246 su main', createdAt: '2026-10-05T23:06:00Z' },
    { number: 2300, title: 'Conflitto con main: riapplicare la PR #2246 su main', createdAt: '2026-10-06T05:00:00Z' },
    // La ricerca per titolo di GitHub è per token: #22460 non è #2246.
    { number: 2301, title: 'Conflitto con main dopo LGTM: riapplicare la PR #22460 su main', createdAt: '2026-10-06T06:00:00Z' },
  ];
  assert.equal(latestHandoffOf(2246, issues).number, 2300);
  assert.equal(latestHandoffOf(9999, issues), null);
  assert.ok(issues[0].title.includes(handoffTitleQuery(2246)));
});

// ── Caso 3: ogni issue sorgente è già chiusa ────────────────────────────────

const closedIssue = () => ({ state: 'CLOSED' });
const mergedSiblings = [
  { number: 2245, title: 'fix(cantoni): prevent generated workflow fan-out', body: 'Closes #2236' },
  { number: 2248, title: 'fix(workflows): avoid canton self-test fanout', body: 'Fixes #2239' },
];

test('caso 3 — ogni sorgente è chiusa E consegnata da un\'altra PR mergiata', () => {
  const pr = loopPr({ body: 'Closes #2236\nFixes #2239' });
  assert.deepEqual(
    decideSourceIssuesClosed({ pr, readIssue: closedIssue, mergedPrs: mergedSiblings }),
    { close: true, reason: 'source-issues-delivered', issues: [2236, 2239], deliveredBy: [2245, 2248] },
  );
});

test('caso 3 — una issue chiusa senza una PR mergiata che la chiude NON prova niente', () => {
  // Chiusa a mano, `not planned`, o dal solo ritorno al verde del workflow:
  // questa PR può essere l'unico percorso di consegna rimasto.
  const pr = loopPr({ body: 'Closes #2236\nFixes #2239' });
  const reason = (mergedPrs) => decideSourceIssuesClosed({ pr, readIssue: closedIssue, mergedPrs }).reason;
  assert.equal(reason([]), 'source-issue-not-delivered');
  assert.equal(reason([mergedSiblings[0]]), 'source-issue-not-delivered', 'una sola delle due sorgenti consegnata non basta');
  // La PR stessa non è la prova della propria consegna.
  assert.equal(reason([{ number: pr.number, title: pr.title, body: pr.body }]), 'source-issue-not-delivered');
  // #22360 non è #2236.
  assert.equal(reason([{ number: 2245, body: 'Closes #22360\nCloses #2239' }]), 'source-issue-not-delivered');
  assert.equal(reason(null), 'merged-prs-unreadable');
});

test('caso 3 — una sorgente aperta, illeggibile o assente lascia la PR aperta', () => {
  const pr = loopPr({ body: 'Closes #2236\nFixes #2239' });
  const states = { 2236: { state: 'CLOSED' }, 2239: { state: 'OPEN' } };
  const reason = (over) => decideSourceIssuesClosed({ pr, readIssue: closedIssue, mergedPrs: mergedSiblings, ...over }).reason;
  assert.equal(reason({ readIssue: (n) => states[n] }), 'source-issue-open');
  assert.equal(reason({ readIssue: () => null }), 'source-issue-unreadable');
  assert.equal(reason({ pr: loopPr({ body: 'nessuna keyword' }) }), 'no-closing-keyword');
});

// ── Commento e agganci ──────────────────────────────────────────────────────

test('il commento di chiusura dice la ragione e come annullarla', () => {
  for (const decision of [
    { reason: 'reapply-origin-merged', origin: 2201, handoff: 2204 },
    { reason: 'handoff-already-fixed', handoff: 2250 },
    { reason: 'source-issues-delivered', issues: [2236], deliveredBy: [2245] },
  ]) {
    const body = closingComment(decision);
    assert.ok(body.startsWith(SUPERSEDED_MARKER), body);
    assert.match(body, /gh pr reopen/, body);
    assert.match(body, /branch NON è stato cancellato/, body);
  }
  assert.match(closingComment({ reason: 'reapply-origin-merged', origin: 2201, handoff: 2204 }), /#2201/);
  assert.match(closingComment({ reason: 'source-issues-delivered', issues: [2236], deliveredBy: [2245] }), /#2236.*#2245/);
  assert.throws(() => closingComment({ reason: 'inventata' }), /ragione di chiusura sconosciuta/);
});

test('la chiusura rilegge le prove, non solo la PR', () => {
  const src = readFileSync(path.join(ROOT, 'scripts/ci/close-superseded-conflict-prs.mjs'), 'utf8');
  const main = src.slice(src.indexOf('function main()'));
  assert.equal(main.split('decide(pr, ').length - 1, 2, 'decisione e conferma: `decide` va eseguita due volte, la seconda subito prima della close');
  assert.ok(main.indexOf('confirmed.reason !== decision.reason') < main.indexOf("'pr', 'close'"), 'la conferma deve precedere la chiusura');
});

test('lo sweep non cancella mai il branch e ha un tetto per run', () => {
  const src = readFileSync(path.join(ROOT, 'scripts/ci/close-superseded-conflict-prs.mjs'), 'utf8');
  assert.equal(/['"]--delete-branch['"]/.test(src), false, 'la chiusura deve restare annullabile con `gh pr reopen`');
  assert.ok(Number.isInteger(MAX_CLOSES_PER_RUN) && MAX_CLOSES_PER_RUN > 0);
});

test('pr-autorebase.yml esegue lo sweep dopo l\'autorebase, anche se questo fallisce', () => {
  const wf = readFileSync(path.join(ROOT, '.github/workflows/pr-autorebase.yml'), 'utf8');
  const rebaseAt = wf.indexOf('node scripts/ci/pr-autorebase.mjs');
  const sweepAt = wf.indexOf('node scripts/ci/close-superseded-conflict-prs.mjs');
  assert.notEqual(sweepAt, -1, 'lo sweep non è agganciato a pr-autorebase.yml');
  // Dopo: è l'autorebase a ricalcolare `has-conflicts` con merge-tree.
  assert.ok(sweepAt > rebaseAt, 'lo sweep deve leggere le label appena ricalcolate dall\'autorebase');
  const step = wf.slice(wf.lastIndexOf('      - name:', sweepAt), sweepAt);
  assert.match(step, /if: always\(\)/, step);
  assert.match(step, /continue-on-error: true/, step);
  assert.match(step, /DRY_RUN: \$\{\{ github\.event\.inputs\.dry_run \}\}/, step);
  // Senza la deadline `runBudgetFromEnv()` è illimitato: lo sweep fa letture
  // `gh` sincrone per ogni candidata e deve fermarsi pulito prima del timeout.
  const run = wf.slice(sweepAt - 120, sweepAt);
  assert.match(run, /CI_JOB_DEADLINE_EPOCH=/, 'il passo dello sweep deve esportare la propria deadline');
});
