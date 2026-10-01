// Gemello node:test di tests/conflict-handoff-reconcile.test.ts del sito
// (valerielinc-ops/frontaliere-si-o-no#10714 e #10728): chiusura degli
// hand-off di conflitto il cui lavoro e' gia' fatto. Stessi casi puri, via
// expect-shim; il wiring e' quello del followup-drainer.yml di questo repo.
//
// Con la PR di origine aperta si chiude solo con la prova da merge-tree:
// `has-conflicts` tolta da pr-autorebase DOPO l'apertura dell'hand-off. La sola
// assenza della label non basta, perche' pr-autorebase la aggiunge best-effort
// (review di questa stessa PR, frontaliere-articles#2018).
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { expect } from './lib/expect-shim.mjs';
import { buildConflictHandoffIssue } from '../../scripts/ci/pr-autorebase.mjs';
import {
  conflictClearedAfter,
  conflictLabelEventsArgs,
  handoffResolution,
  parseConflictLabelEvents,
} from '../../scripts/ci/check-issue-already-resolved.mjs';
import {
  closingComment,
  decideHandoff,
  declaresClosing,
  declaresSupersede,
  groupHandoffs,
  reapplyInFlight,
  RECONCILE_MARKER,
  stillClosable,
} from '../../scripts/ci/reconcile-conflict-handoffs.mjs';

const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);
const OPENED = '2026-09-30T15:00:00Z';
const labelEvent = (event, createdAt, name = 'has-conflicts') => ({ event, label: { name }, created_at: createdAt });
const CLEARED = [labelEvent('labeled', '2026-09-30T14:59:50Z'), labelEvent('unlabeled', '2026-09-30T17:00:00Z')];
const PREVIOUS_CONFLICT = [labelEvent('labeled', '2026-09-29T10:00:00Z'), labelEvent('unlabeled', '2026-09-29T12:00:00Z')];

function handoff(number, origin, { labels = [] } = {}) {
  const { title, body } = buildConflictHandoffIssue({
    num: origin,
    branch: `fix/issue-${origin - 1}`,
    head: HEAD,
    files: ['generator/tests/example.test.mjs'],
  });
  return { number, title, body, labels, created_at: OPENED };
}

const openOrigin = (over = {}) => ({
  state: 'OPEN',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'BLOCKED',
  headRefOid: HEAD,
  labels: [],
  ...over,
});

describe('conflictClearedAfter: la prova da merge-tree', () => {
  it('has-conflicts tolta dopo l\'apertura dell\'hand-off → prova', () => {
    expect(conflictClearedAfter(CLEARED, OPENED)).toBe(true);
  });

  it('nessuna prova senza quella rimozione', () => {
    const cases = [
      [], // label mai applicata: l'edit best-effort di pr-autorebase e' fallito
      PREVIOUS_CONFLICT,
      [...CLEARED, labelEvent('labeled', '2026-09-30T18:00:00Z')],
      [labelEvent('labeled', '2026-09-30T14:59:50Z')],
      [labelEvent('unlabeled', '2026-09-30T17:00:00Z', 'stale-review')],
      null,
    ];
    for (const events of cases) expect(conflictClearedAfter(events, OPENED)).toBe(false);
    expect(conflictClearedAfter(CLEARED, '')).toBe(false);
  });

  it('gli eventi arrivano in NDJSON da gh api --jq', () => {
    const raw = '{"event":"labeled","created_at":"2026-09-30T14:59:50Z"}\n{"event":"unlabeled","created_at":"2026-09-30T17:00:00Z"}\n';
    expect(conflictClearedAfter(parseConflictLabelEvents(raw), OPENED)).toBe(true);
    expect(parseConflictLabelEvents('')).toEqual([]);
    expect(parseConflictLabelEvents('{"event":')).toBe(null);
    expect(conflictLabelEventsArgs('o/r', 1569)).toContain('repos/o/r/issues/1569/events?per_page=100');
  });
});

describe('handoffResolution', () => {
  it('PR di origine mergiata → risolto senza prova', () => {
    expect(handoffResolution({ state: 'MERGED' }, { expectedHead: HEAD.slice(0, 12) }))
      .toEqual({ resolved: true, reason: 'merged' });
  });

  it('stessa HEAD mergeable: chiude solo con la prova, altrimenti il vecchio rinvio', () => {
    expect(handoffResolution(openOrigin(), { expectedHead: HEAD.slice(0, 12), conflictClearedAfterOpen: true }))
      .toEqual({ resolved: true, reason: 'conflict-resolved' });
    expect(handoffResolution(openOrigin(), { expectedHead: HEAD.slice(0, 12) }))
      .toEqual({ resolved: false, reason: 'conflict-clear-unproven', sameHeadMergeable: true });
  });

  it('HEAD nuova: servono mergeable, nessuna has-conflicts E la prova', () => {
    expect(handoffResolution(openOrigin({ headRefOid: NEW_HEAD }), { expectedHead: HEAD.slice(0, 12), conflictClearedAfterOpen: true }))
      .toEqual({ resolved: true, reason: 'conflict-resolved-new-head' });
    expect(handoffResolution(openOrigin({ headRefOid: NEW_HEAD }), { expectedHead: HEAD.slice(0, 12) }))
      .toEqual({ resolved: false, reason: 'conflict-clear-unproven' });
    const cases = [
      [{ labels: [{ name: 'has-conflicts' }] }, 'origin-has-conflicts'],
      [{ labels: undefined }, 'origin-labels-unreadable'],
      [{ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, 'origin-open'],
      [{ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }, 'origin-mergeability-stale'],
    ];
    for (const [over, reason] of cases) {
      expect(handoffResolution(openOrigin({ headRefOid: NEW_HEAD, ...over }), { expectedHead: HEAD.slice(0, 12), conflictClearedAfterOpen: true }))
        .toEqual({ resolved: false, reason });
    }
  });
});

describe('keyword delle PR e riapplicazione in volo', () => {
  it('stesso parser del pre-flight: titolo, Closes #a #b, numero intero', () => {
    expect(declaresClosing('Closes #1586', 1586)).toBe(true);
    expect(declaresClosing('closes: #1586', 1586)).toBe(true);
    expect(declaresClosing('Closes #1 #1586', 1586)).toBe(true);
    expect(declaresClosing('fix(ci): riapplica (closes #1586)\n\nbody', 1586)).toBe(true);
    expect(declaresClosing('Closes #15860', 1586)).toBe(false);
    expect(declaresClosing('Refs #1586', 1586)).toBe(false);
    expect(declaresSupersede('Supersedes #1569', 1569)).toBe(true);
    expect(declaresSupersede('Supersedes #15690', 1569)).toBe(false);
  });

  it('il branch del fixer o le keyword, mai la PR di origine', () => {
    const prs = [
      { number: 1569, headRefName: 'fix/issue-1482', body: 'Closes #1482' },
      { number: 1700, headRefName: 'fix/issue-1586', body: '' },
    ];
    expect(reapplyInFlight(prs, { issueNumber: 1586, originNumber: 1569 })?.number).toBe(1700);
    expect(reapplyInFlight([prs[0]], { issueNumber: 1586, originNumber: 1569 })).toBe(null);
  });
});

describe('groupHandoffs e decideHandoff', () => {
  it('duplicati: resta la più vecchia, salvo lavoro avviato sulla più recente', () => {
    const groups = groupHandoffs([handoff(1587, 1569), handoff(1586, 1569)]);
    expect(groups[0].keeper.number).toBe(1586);
    expect(groups[0].duplicates.map((i) => i.number)).toEqual([1587]);
    const claimed = groupHandoffs([handoff(1586, 1569), handoff(1587, 1569, { labels: ['agent:in-progress'] })]);
    expect(claimed[0].keeper.number).toBe(1587);
  });

  it('chiude solo il lavoro dimostrabilmente fatto', () => {
    const issue = handoff(1586, 1569);
    expect(decideHandoff({ issue, origin: { state: 'MERGED' }, mergedPrs: [], openPrs: [] }))
      .toEqual({ action: 'close', reason: 'origin-merged', pr: 1569 });
    expect(decideHandoff({ issue, origin: { state: 'CLOSED' }, mergedPrs: [{ number: 1720, body: 'Supersedes #1569' }], openPrs: [] }))
      .toEqual({ action: 'close', reason: 'reapplied', pr: 1720 });
    expect(decideHandoff({ issue, origin: { state: 'CLOSED' }, mergedPrs: [{ number: 1722, title: 'reapply (closes #1586)', body: '' }], openPrs: [] }))
      .toEqual({ action: 'close', reason: 'reapplied', pr: 1722 });
    expect(decideHandoff({ issue, origin: { state: 'CLOSED' }, mergedPrs: [], openPrs: [] }))
      .toEqual({ action: 'keep', reason: 'origin-closed' });
    expect(decideHandoff({ issue, origin: openOrigin({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }), mergedPrs: [], openPrs: [] }))
      .toEqual({ action: 'keep', reason: 'origin-open' });
    expect(decideHandoff({ issue, origin: openOrigin(), mergedPrs: [], openPrs: null }))
      .toEqual({ action: 'keep', reason: 'open-prs-unreadable' });
    expect(decideHandoff({ issue: handoff(1586, 1569, { labels: ['agent:in-progress'] }), origin: { state: 'MERGED' }, mergedPrs: [], openPrs: [] }))
      .toEqual({ action: 'keep', reason: 'claim-active' });
  });

  it('PR di origine aperta: chiude con la prova da merge-tree, resta aperta senza', () => {
    const issue = handoff(1586, 1569);
    expect(decideHandoff({ issue, origin: openOrigin({ headRefOid: NEW_HEAD }), mergedPrs: [], openPrs: [], conflictEvents: CLEARED }))
      .toEqual({ action: 'close', reason: 'conflict-resolved-new-head', pr: 1569 });
    expect(decideHandoff({ issue, origin: openOrigin(), mergedPrs: [], openPrs: [], conflictEvents: CLEARED }))
      .toEqual({ action: 'close', reason: 'conflict-resolved', pr: 1569 });
    for (const conflictEvents of [null, [], PREVIOUS_CONFLICT]) {
      expect(decideHandoff({ issue, origin: openOrigin({ headRefOid: NEW_HEAD }), mergedPrs: [], openPrs: [], conflictEvents }))
        .toEqual({ action: 'keep', reason: 'conflict-clear-unproven' });
    }
  });

  it('subito prima di chiudere rilegge lo stato dal vivo', () => {
    expect(stillClosable({ state: 'OPEN', labels: [] })).toBe(true);
    expect(stillClosable({ state: 'OPEN', labels: [{ name: 'agent:in-progress' }] })).toBe(false);
    expect(stillClosable({ state: 'CLOSED', labels: [] })).toBe(false);
    expect(stillClosable(null)).toBe(false);
  });

  it('il commento porta il marker e nessuna keyword di chiusura', () => {
    for (const reason of ['duplicate', 'reapplied', 'origin-merged', 'conflict-resolved', 'conflict-resolved-new-head']) {
      const body = closingComment({ reason, pr: 1720, originNumber: 1569, keeper: 1586 });
      expect(body.startsWith(RECONCILE_MARKER)).toBe(true);
      expect(body).not.toMatch(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#\d/i);
    }
  });
});

describe('wiring nel followup-drainer di questo repo', () => {
  it('riconcilia prima del drain, con GITHUB_TOKEN, senza bloccarlo, e può leggere le PR', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/followup-drainer.yml', import.meta.url), 'utf8');
    const step = workflow.indexOf('run: node scripts/ci/reconcile-conflict-handoffs.mjs');
    const drain = workflow.indexOf('- name: Drain follow-up queue');
    expect(step).toBeGreaterThan(-1);
    expect(drain).toBeGreaterThan(step);
    const block = workflow.slice(workflow.lastIndexOf('- name: Reconcile conflict hand-offs', step), step);
    expect(block).toContain('continue-on-error: true');
    expect(block).toContain('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    expect(workflow).toContain('pull-requests: read');
  });
});
