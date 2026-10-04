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
  originContentOnMain,
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


/** Patch nel formato di `pulls/<n>/files`: contesto `before`, rimozioni, aggiunte. */
const patch = (lines, removed = [], before = []) => [
  `@@ -1,${before.length + removed.length} +1,${before.length + lines.length} @@`,
  ...before.map((l) => ` ${l}`),
  ...removed.map((l) => `-${l}`),
  ...lines.map((l) => `+${l}`),
].join('\n');

describe('originContentOnMain: tutto o non provato', () => {
  const added = ['export const A = 1;', '', '  return a + b;'];
  const files = [{ filename: 'src/a.ts', status: 'modified', patch: patch(added, ['old'], ['// x']) }];
  const main = (text) => () => text;

  it('tutte le righe aggiunte non vuote su main → provato, con il conteggio', () => {
    expect(originContentOnMain(files, main('// x\nexport const A = 1;\n\n  return a + b;\n')))
      .toEqual({ proven: true, checked: added.filter((l) => l.trim()).length, files: ['src/a.ts'] });
  });

  it('una sola riga mancante → non provato', () => {
    const verdict = originContentOnMain(files, main('export const A = 1;\n'));
    expect(verdict.proven).toBe(false);
    expect(verdict.reason).toContain('src/a.ts: hunk 1/1');
  });

  it('file senza patch (binario o troppo grande) → non provato', () => {
    expect(originContentOnMain([{ filename: 'img.png', status: 'modified' }], main('x')).proven).toBe(false);
    expect(originContentOnMain([...files, { filename: 'big.json', status: 'modified', patch: '' }], main('export const A = 1;\n  return a + b;')).proven).toBe(false);
  });

  it('lettura di main fallita, file assente o eccezione → non provato', () => {
    expect(originContentOnMain(files, main(null)).proven).toBe(false);
    expect(originContentOnMain(files, () => { throw new Error('503'); }).proven).toBe(false);
  });

  it('file rimosso, sole rimozioni o elenco vuoto → non provato', () => {
    expect(originContentOnMain([{ filename: 'gone.ts', status: 'removed', patch: patch([], ['x']) }], main('')).proven).toBe(false);
    expect(originContentOnMain([{ filename: 'a.ts', status: 'modified', patch: patch([], ['x']) }], main('')).proven).toBe(false);
    expect(originContentOnMain([{ filename: 'a.ts', status: 'modified', patch: '@@ -1,0 +1,1 @@\n+  ' }], main('  \n')).proven).toBe(false);
    expect(originContentOnMain([], main('')).proven).toBe(false);
    expect(originContentOnMain(null, main('')).proven).toBe(false);
  });

  it('l\'intestazione +++ non è una riga aggiunta; solo CRLF non conta', () => {
    const withHeader = [{ filename: 'a.ts', status: 'modified', patch: `+++ b/a.ts\n${patch(['  // due  spazi'])}` }];
    expect(originContentOnMain(withHeader, main('\t// due spazi\r\n')).proven).toBe(false);
    expect(originContentOnMain(withHeader, main('  // due  spazi\r\n')).proven).toBe(true);
  });

  it('dentro un hunk una riga che inizia con ++ è una riga aggiunta, non un\'intestazione', () => {
    const plusPlus = [{ filename: 'a.ts', status: 'modified', patch: patch(['++i;', 'const x = 1;']) }];
    expect(originContentOnMain(plusPlus, main('const x = 1;\n')).proven).toBe(false);
    expect(originContentOnMain(plusPlus, main('++i;\nconst x = 1;\n'))).toEqual({ proven: true, checked: 2, files: ['a.ts'] });
  });
});

// Review del corpus sulla PR di trasporto 2090 (unico 🔴): la prova era un
// `Set` di righe, quindi una riga aggiunta che su main compare SOLO altrove (il
// contesto di un altro hunk) o una riga aggiunta due volte e presente una sola
// facevano «su main» una PR mai applicata. La prova e' ora un'applicazione al
// contrario: il nuovo lato di ogni hunk (contesto + aggiunte, in ordine) deve
// stare CONTIGUO su main, ogni hunk in una posizione distinta e nell'ordine
// della patch.
describe('originContentOnMain: applicazione hunk per hunk, non presenza di righe', () => {
  const main = (text) => () => text;
  const file = (p) => [{ filename: 'src/b.ts', status: 'modified', patch: p }];
  // Due hunk: il primo aggiunge `return null;` in a(), il secondo ha la stessa
  // riga come CONTESTO in b() e cambia `old()` in `fresh()`.
  const twoHunks = [
    '@@ -1,3 +1,4 @@',
    ' function a() {',
    '+  return null;',
    ' }',
    ' ',
    '@@ -10,4 +11,4 @@',
    ' function b() {',
    '-  old();',
    '+  fresh();',
    '   return null;',
    ' }',
  ].join('\n');
  const ORIGINAL = 'function a() {\n}\n\n// ...\nfunction b() {\n  old();\n  return null;\n}\n';
  const APPLIED = 'import x;\nfunction a() {\n  return null;\n}\n\n// ...\n// altro\nfunction b() {\n  fresh();\n  return null;\n}\n';

  it('una riga aggiunta presente su main solo nel contesto di un altro hunk → non provato', () => {
    // Su main c'e' `fresh()` (secondo hunk applicato) ma a() e' ancora vuota:
    // `return null;` compare solo dentro b().
    const onlySecond = 'function a() {\n}\n\nfunction b() {\n  fresh();\n  return null;\n}\n';
    const verdict = originContentOnMain(file(twoHunks), main(onlySecond));
    expect(verdict.proven).toBe(false);
    expect(verdict.reason).toContain('src/b.ts: hunk 1/2');
    expect(originContentOnMain(file(twoHunks), main(ORIGINAL)).proven).toBe(false);
  });

  it('una riga aggiunta due volte ma presente una volta su main → non provato', () => {
    const twice = '@@ -1,2 +1,4 @@\n const list = [\n+  \'a\',\n+  \'a\',\n ];';
    expect(originContentOnMain(file(twice), main('const list = [\n  \'a\',\n];\n')).proven).toBe(false);
    expect(originContentOnMain(file(twice), main('const list = [\n  \'a\',\n  \'a\',\n];\n')))
      .toEqual({ proven: true, checked: 2, files: ['src/b.ts'] });
  });

  it('patch davvero applicata, con righe nuove fra un hunk e l\'altro → provato', () => {
    expect(originContentOnMain(file(twoHunks), main(APPLIED))).toEqual({ proven: true, checked: 2, files: ['src/b.ts'] });
  });

  it('hunk su main in ordine inverso, o due hunk sulla stessa posizione → non provato', () => {
    const same = '@@ -1,2 +1,3 @@\n a\n+b\n c\n@@ -8,2 +9,3 @@\n a\n+b\n c';
    expect(originContentOnMain(file(same), main('a\nb\nc\n')).proven).toBe(false);
    expect(originContentOnMain(file(same), main('a\nb\nc\nz\na\nb\nc\n')).proven).toBe(true);
    const reversed = 'function b() {\n  fresh();\n  return null;\n}\nfunction a() {\n  return null;\n}\n';
    expect(originContentOnMain(file(twoHunks), main(reversed)).proven).toBe(false);
  });

  it('diff troncato (righe meno di quelle dichiarate dall\'intestazione dell\'hunk) → non provato', () => {
    const truncated = '@@ -1,3 +1,5 @@\n a\n+b\n+c';
    const verdict = originContentOnMain(file(truncated), main('a\nb\nc\nd\ne\n'));
    expect(verdict.proven).toBe(false);
    expect(verdict.reason).toContain('troncat');
  });

  it('patch senza intestazione di hunk o con una riga estranea → non provato', () => {
    expect(originContentOnMain(file('+solo una riga'), main('solo una riga\n')).proven).toBe(false);
    expect(originContentOnMain(file('@@ -1,1 +1,2 @@\n a\n+b\n?c'), main('a\nb\n')).proven).toBe(false);
  });

  it('una rimozione fra due righe di contesto e\' provata solo se su main non c\'e\' piu\'', () => {
    const swap = '@@ -1,3 +1,3 @@\n a\n-old\n+new\n b';
    expect(originContentOnMain(file(swap), main('a\nnew\nb\n')).proven).toBe(true);
    expect(originContentOnMain(file(swap), main('a\nold\nnew\nb\n')).proven).toBe(false);
    expect(originContentOnMain(file(swap), main('a\nnew\nold\nb\n')).proven).toBe(false);
  });

  it('una rimozione in testa o in coda all\'hunk ancora l\'hunk all\'inizio o alla fine del file', () => {
    const head = '@@ -1,2 +1,2 @@\n-old\n+new\n a';
    expect(originContentOnMain(file(head), main('new\na\n')).proven).toBe(true);
    expect(originContentOnMain(file(head), main('old\nnew\na\n')).proven).toBe(false);
    const tail = '@@ -1,2 +1,2 @@\n a\n+new\n-old';
    expect(originContentOnMain(file(tail), main('a\nnew\n')).proven).toBe(true);
    expect(originContentOnMain(file(tail), main('a\nnew\nold\n')).proven).toBe(false);
  });

  it('\\ No newline at end of file non e\' una riga del file', () => {
    const noEol = '@@ -1,1 +1,2 @@\n a\n+b\n\\ No newline at end of file';
    expect(originContentOnMain(file(noEol), main('a\nb')).proven).toBe(true);
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
