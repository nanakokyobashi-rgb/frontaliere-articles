/**
 * PARENT-REARM: un monitor riapre/riconferma un padre decomposto dopo che
 * tutte le figlie sono chiuse. Il runner del corpus e' node:test, quindi il
 * test resta puro e non invoca GitHub.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_PARENT_REARM_MAX_PER_WINDOW,
  DEFAULT_PARENT_REARM_WINDOW_DAYS,
  PARENT_REARM_MARKER,
  decideParentRearm,
  parentRearmCommentBody,
} from '../../scripts/ci/lib/parent-close-recurrence.mjs';
import { pinnedBy } from '../../scripts/ci/manifest-pinned-issues.mjs';

const DRAINER = readFileSync(new URL('../../scripts/ci/followup-drainer.mjs', import.meta.url), 'utf8');
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-06T20:00:00Z');
const REPO = 'nanakokyobashi-rgb/frontaliere-articles';

const reopenedBody = (number) =>
  `🔁 **Reopened** — ricorrenza del padre #${number}: la stessa condizione si è ripresentata.`;
const recurringBody = () =>
  '🔁 Recurrence on workflow run.\n\n**Workflow:** Bing SEO closed loop — full sitemap tree';
const decomposedBody = (children) =>
  `## Decomposizione\n\n<!-- DECOMPOSED_INTO: ${children.join(' ')} -->`;
const closedChildren = (children) => children.map((number) => ({ number, state: 'CLOSED' }));

const realCases = [
  {
    number: 6504,
    children: [6918, 6919, 6920, 6921, 6922, 6923],
    decomposedAt: '2026-09-01T06:43:51Z',
    reopenedAt: '2026-10-04T11:15:56Z',
  },
  {
    number: 6317,
    children: [6765, 6766],
    decomposedAt: '2026-08-31T13:01:51Z',
    reopenedAt: '2026-10-05T10:51:50Z',
  },
  {
    number: 10120,
    children: [11438, 11439, 11440, 11441, 11442],
    decomposedAt: '2026-10-04T11:51:23Z',
    reopenedAt: '2026-10-06T13:39:40Z',
    recurrenceBody: recurringBody(),
  },
  {
    number: 5661,
    children: [6672, 6673, 6674],
    decomposedAt: '2026-08-30T06:07:04Z',
    reopenedAt: '2026-09-24T18:16:59Z',
  },
];

function commentsFor(parent) {
  return [
    { body: decomposedBody(parent.children), createdAt: parent.decomposedAt },
    {
      body: parent.recurrenceBody || reopenedBody(parent.number),
      createdAt: parent.reopenedAt,
    },
  ];
}

test('PARENT-REARM: i quattro casi misurati rientrano una sola volta', () => {
  for (const parent of realCases) {
    const decision = decideParentRearm({
      parentState: 'OPEN',
      comments: commentsFor(parent),
      childStates: closedChildren(parent.children),
      now: NOW,
    });
    assert.equal(decision.action, 'rearm', `padre #${parent.number}`);
    assert.equal(decision.reason, 'children-closed', `padre #${parent.number}`);
    assert.equal(decision.reopenedAt, parent.reopenedAt, `padre #${parent.number}`);
    assert.deepEqual(decision.childNumbers, parent.children, `padre #${parent.number}`);

    const after = [
      ...commentsFor(parent),
      {
        body: parentRearmCommentBody({
          reopenedAt: parent.reopenedAt,
          childNumbers: parent.children,
        }),
        createdAt: '2026-10-06T20:01:00Z',
      },
    ];
    assert.equal(
      decideParentRearm({
        parentState: 'OPEN',
        comments: after,
        childStates: closedChildren(parent.children),
        now: NOW,
      }).reason,
      'already-rearmed',
      `idempotenza #${parent.number}`,
    );
  }
});

test('il marker scritto nello stesso secondo della ricorrenza vale come riarmo già fatto', () => {
  // I commenti sono datati al secondo: ricorrenza e marker possono avere lo
  // stesso istante. Stesso caso del sito (PR 11968 di frontaliere-si-o-no).
  const parent = realCases[0];
  const sameSecond = [
    ...commentsFor(parent),
    {
      body: parentRearmCommentBody({ reopenedAt: parent.reopenedAt, childNumbers: parent.children }),
      createdAt: parent.reopenedAt,
    },
  ];
  assert.equal(decideParentRearm({
    parentState: 'OPEN',
    comments: sameSecond,
    childStates: closedChildren(parent.children),
    now: NOW,
  }).reason, 'already-rearmed');

  const before = [
    ...commentsFor(parent),
    {
      body: parentRearmCommentBody({ reopenedAt: parent.reopenedAt, childNumbers: parent.children }),
      createdAt: new Date(Date.parse(parent.reopenedAt) - 1000).toISOString(),
    },
  ];
  assert.equal(decideParentRearm({
    parentState: 'OPEN',
    comments: before,
    childStates: closedChildren(parent.children),
    now: NOW,
  }).action, 'rearm');
});

test('il drainer legge lo stato del padre: senza `state` ogni padre sarebbe illeggibile', () => {
  // La decisione e' fail-closed sullo stato mancante...
  const parent = realCases[0];
  assert.equal(decideParentRearm({
    parentState: undefined,
    comments: commentsFor(parent),
    childStates: closedChildren(parent.children),
    now: NOW,
  }).reason, 'unreadable');
  // ...quindi il listing che alimenta il pass deve chiedere `state` a GitHub,
  // e il pass deve passare proprio quel campo.
  const listing = /function listIssues\(label\) \{[\s\S]*?\n\}/.exec(DRAINER)?.[0] || '';
  const projection = /'--json',\s*'([^']+)'/.exec(listing)?.[1].split(',') || [];
  assert.ok(projection.includes('state'), `proiezione di listIssues senza state: ${projection.join(',')}`);
  assert.match(DRAINER, /parentState: p\.state,/);
  // `gh issue list --json state` rende lo stato in maiuscolo, il REST del
  // sito in minuscolo: la decisione li accetta entrambi.
  for (const state of ['OPEN', 'open']) {
    assert.equal(decideParentRearm({
      parentState: state,
      comments: commentsFor(parent),
      childStates: closedChildren(parent.children),
      now: NOW,
    }).action, 'rearm', state);
  }
});

test('a parità di secondo decide l\'ultima decomposizione, come nel PARENT-CLOSE', () => {
  // Stesso caso del sito (PR 11975 di frontaliere-si-o-no): due marker
  // DECOMPOSED_INTO nello stesso secondo, il secondo aggiunge una figlia aperta.
  const parent = realCases[1];
  const extraChild = 9999;
  const comments = [
    { body: decomposedBody(parent.children), createdAt: parent.decomposedAt },
    { body: decomposedBody([...parent.children, extraChild]), createdAt: parent.decomposedAt },
    { body: reopenedBody(parent.number), createdAt: parent.reopenedAt },
  ];
  const decision = decideParentRearm({
    parentState: 'OPEN',
    comments,
    childStates: [...closedChildren(parent.children), { number: extraChild, state: 'OPEN' }],
    now: NOW,
  });
  assert.equal(decision.action, 'skip');
  assert.equal(decision.reason, 'child-open');
});

test('una ricorrenza nello stesso secondo della decomposizione conta solo se viene dopo nel thread', () => {
  const parent = realCases[1];
  const after = [
    { body: decomposedBody(parent.children), createdAt: parent.decomposedAt },
    { body: reopenedBody(parent.number), createdAt: parent.decomposedAt },
  ];
  assert.equal(decideParentRearm({
    parentState: 'OPEN', comments: after, childStates: closedChildren(parent.children), now: NOW,
  }).action, 'rearm');
  const before = [
    { body: reopenedBody(parent.number), createdAt: parent.decomposedAt },
    { body: decomposedBody(parent.children), createdAt: parent.decomposedAt },
  ];
  assert.equal(decideParentRearm({
    parentState: 'OPEN', comments: before, childStates: closedChildren(parent.children), now: NOW,
  }).reason, 'not-reopened');
});

test('PARENT-REARM non agisce con una figlia aperta', () => {
  const parent = realCases[0];
  const states = closedChildren(parent.children);
  states[states.length - 1] = { number: parent.children.at(-1), state: 'OPEN' };
  assert.deepEqual(
    decideParentRearm({
      parentState: 'OPEN',
      comments: commentsFor(parent),
      childStates: states,
      now: NOW,
    }),
    { action: 'skip', reason: 'child-open' },
  );
});

test('PARENT-REARM rispetta il tetto per issue nella finestra', () => {
  const parent = realCases[1];
  const comments = [
    ...commentsFor(parent),
    ...[1, 2].map((index) => ({
      body: `${PARENT_REARM_MARKER} reopened-at=2026-10-0${index}T08:00:00Z -->`,
      createdAt: `2026-10-0${index}T08:01:00Z`,
    })),
  ];
  assert.equal(
    decideParentRearm({
      parentState: 'OPEN',
      comments,
      childStates: closedChildren(parent.children),
      now: NOW,
    }).reason,
    'window-cap',
  );
});

test('PARENT-REARM è fail-closed su marker, date, stato o padre illeggibili', () => {
  const parent = realCases[2];
  const base = {
    parentState: 'OPEN',
    comments: commentsFor(parent),
    childStates: closedChildren(parent.children),
    now: NOW,
  };
  assert.equal(
    decideParentRearm({ ...base, comments: [{ body: reopenedBody(parent.number), createdAt: parent.reopenedAt }] }).reason,
    'unreadable',
  );
  assert.equal(
    decideParentRearm({
      ...base,
      comments: [
        { body: decomposedBody(parent.children), createdAt: parent.decomposedAt },
        { body: reopenedBody(parent.number) },
      ],
    }).reason,
    'unreadable',
  );
  assert.equal(
    decideParentRearm({
      ...base,
      comments: [...commentsFor(parent), { body: '<!-- PARENT_REARM: malformed -->', createdAt: '2026-10-06T19:00:00Z' }],
    }).reason,
    'unreadable',
  );
  assert.equal(decideParentRearm({ ...base, childStates: null }).reason, 'unreadable');
  assert.equal(
    decideParentRearm({ ...base, parentState: 'CLOSED' }).reason,
    'unreadable',
  );
});

test('una decomposizione successiva ridà autorità al PARENT-CLOSE', () => {
  const parent = realCases[3];
  const comments = [
    ...commentsFor(parent),
    {
      body: parentRearmCommentBody({
        reopenedAt: parent.reopenedAt,
        childNumbers: parent.children,
      }),
      createdAt: '2026-09-24T19:00:00Z',
    },
    { body: decomposedBody([7001, 7002]), createdAt: '2026-09-25T08:00:00Z' },
  ];
  assert.equal(
    decideParentRearm({
      parentState: 'OPEN',
      comments,
      childStates: closedChildren([7001, 7002]),
      now: NOW,
    }).reason,
    'not-reopened',
  );
});

test('PARENT-REARM usa i default del sito e serializza il marker', () => {
  assert.equal(DEFAULT_PARENT_REARM_WINDOW_DAYS, 30);
  assert.equal(DEFAULT_PARENT_REARM_MAX_PER_WINDOW, 2);
  assert.equal(DEFAULT_PARENT_REARM_WINDOW_DAYS * DAY_MS, 30 * DAY_MS);
  const body = parentRearmCommentBody({ reopenedAt: '2026-10-04T11:15:56Z', childNumbers: [3, 2, 3] });
  assert.match(body, /<!-- PARENT_REARM: reopened-at=2026-10-04T11:15:56\.000Z children=2,3 -->/);
  assert.match(body, /PARENT-REARM/);
});

test('il pin del manifest blocca il PARENT-REARM prima della lettura delle figlie', () => {
  const pinned = new Map([[`${REPO}#2318`, 'scripts/ci/example.mjs']]);
  assert.equal(pinnedBy(2318, REPO, pinned), 'scripts/ci/example.mjs');

  const start = DRAINER.indexOf('// --- PARENT-CLOSE:');
  const end = DRAINER.indexOf('// --- PRODUCTION-PROOF:', start);
  assert.ok(start >= 0 && end > start, 'blocco PARENT-CLOSE non trovato');
  const block = DRAINER.slice(start, end);
  const reopened = block.indexOf('if (reopenedAfterDecomposition(comments))');
  const pin = block.indexOf('const rearmPinnedPath = manifestPinFor(p.number);', reopened);
  const childRead = block.indexOf('readParentRearmChildStates(kids)', reopened);
  const marker = block.indexOf('parentRearmCommentBody({', reopened);
  assert.ok(reopened >= 0, 'guardia di riapertura assente');
  assert.ok(pin > reopened, 'il pass nuovo deve interrogare il manifest');
  assert.ok(childRead > pin, 'il pin deve precedere ogni lettura delle figlie del riarmo');
  assert.ok(marker > pin, 'il pin deve precedere la scrittura del marker');
  assert.match(block.slice(pin, childRead), /PARENT-REARM-SKIP.*manifest/);
});

test('cablaggio del pass: cap per run, marker prima del routing e triage esistente', () => {
  assert.match(DRAINER, /decideParentRearm\([\s\S]*?childStates/);
  assert.match(DRAINER, /PARENT_REARM_MAX_PER_RUN/);
  assert.match(DRAINER, /parentRearms >= PARENT_REARM_MAX_PER_RUN/);
  assert.match(DRAINER, /remove: \[LBL_DECOMPOSED, 'agent:triaged', LBL_FIX, LBL_QUEUED\]/);
  assert.match(DRAINER, /parentRearmCommentBody\(\{/);
  assert.match(DRAINER, /triage-sweep/);
});
