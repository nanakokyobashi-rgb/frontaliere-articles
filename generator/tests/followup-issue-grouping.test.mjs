import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ISSUE_GROUP_MAX_SIZE,
  activeGroupDigests,
  findOverlapFile,
  flattenPaginatedOpenPrs,
  groupIssueQueue,
  isIssueGroupable,
  issueGroupInstanceLabels,
  issueGroupingKey,
  openPrFilesScanDecision,
  openPrHeadIdentity,
  parseOpenGroupPrs,
} from '../../scripts/ci/followup-drainer.mjs';

const DRAINER_SOURCE = readFileSync(
  new URL('../../scripts/ci/followup-drainer.mjs', import.meta.url),
  'utf8',
);

const targetIssue = (number, body = 'Suggested action: `scripts/ci/followup-drainer.mjs`') => ({
  number,
  title: `Follow-up ${number}`,
  body,
  labels: [],
  createdAt: `2026-09-0${number}T00:00:00Z`,
});

test('issue con la stessa chiave produce un solo gruppo entro il tetto', () => {
  const groups = groupIssueQueue(
    [targetIssue(1), targetIssue(2), targetIssue(3)],
    { repository: 'owner/repo' },
  );

  assert.equal(groups.length, 1);
  assert.equal(groups[0].size, ISSUE_GROUP_MAX_SIZE);
  assert.ok(groups[0].size <= ISSUE_GROUP_MAX_SIZE);
});

test('una chiave oltre il tetto viene spezzata senza crescere', () => {
  const groups = groupIssueQueue(
    [1, 2, 3, 4, 5].map((number) => targetIssue(number)),
    { repository: 'owner/repo' },
  );

  assert.deepEqual(groups.map((group) => group.size), [3, 2]);
  assert.ok(groups.every((group) => group.size <= ISSUE_GROUP_MAX_SIZE));
});

test('un issue senza chiave risolvibile resta fuori dai gruppi', () => {
  const groups = groupIssueQueue([
    { ...targetIssue(1), body: 'La descrizione non nomina un punto di riparazione.' },
    { ...targetIssue(2), body: 'La descrizione non nomina un punto di riparazione.' },
  ], { repository: 'owner/repo' });

  assert.deepEqual(groups, []);
  assert.equal(issueGroupingKey(targetIssue(1), { repository: 'owner/repo' }), 'target-file:owner/repo:scripts/ci/followup-drainer.mjs');
  assert.equal(issueGroupingKey({ ...targetIssue(1), body: 'La descrizione non nomina un punto di riparazione.' }, { repository: 'owner/repo' }), null);
});

test('la stessa firma non attraversa il confine di repository', () => {
  const groups = groupIssueQueue([
    targetIssue(1),
    { ...targetIssue(2), body: 'Target repository: other/repo\nSuggested action: `scripts/ci/followup-drainer.mjs`' },
  ], { repository: 'owner/repo' });

  assert.deepEqual(groups, []);
});

test('la firma automatica usa i primi 60 caratteri e richiede una prova strutturata', () => {
  const stable = 'Workflow Failure: ' + 'deploy-validation-monitor '.repeat(3);
  const automatic = (number, suffix) => ({
    ...targetIssue(number),
    title: `${stable}${suffix}`,
    body: '**Workflow:** deploy-validation.yml',
  });

  const first = automatic(1, ' instance-a');
  const second = automatic(2, ' instance-b');
  assert.equal(issueGroupingKey(first, { repository: 'owner/repo' }), issueGroupingKey(second, { repository: 'owner/repo' }));
  assert.equal(issueGroupingKey({ ...first, body: 'Testo umano senza marker del monitor.' }, { repository: 'owner/repo' }), null);
  assert.equal(groupIssueQueue([first, second], { repository: 'owner/repo' })[0].source, 'auto-title');
});

test('un marker automatico riconosciuto senza scope non ricade sul prefisso del titolo', () => {
  const issue = {
    ...targetIssue(1, '## Build fallito\nIl monitor non ha prodotto una destinazione leggibile.'),
    title: 'Workflow Failure: deploy-validation.yml — run 123',
  };

  assert.equal(issueGroupingKey(issue, { repository: 'owner/repo' }), null);
  assert.deepEqual(groupIssueQueue([issue, { ...issue, number: 2 }], { repository: 'owner/repo' }), []);
});

test('awaiting-production-proof esclude una issue dal preflight di raggruppamento', () => {
  const issue = {
    ...targetIssue(1),
    labels: [{ name: 'awaiting-production-proof' }],
  };

  assert.equal(isIssueGroupable(issue, {
    repository: 'owner/repo',
    canPushWorkflows: true,
  }), false);
});

test('un gruppo resta attivo finché la PR del leader è aperta, anche senza agent:fix', () => {
  const digest = '0123456789ab';
  const instanceLabel = `agent:fix-group:${digest}-42`;
  const member = {
    ...targetIssue(2),
    labels: [{ name: instanceLabel }],
  };

  assert.deepEqual(
    [...activeGroupDigests([member], [{
      head: { ref: 'fix/issue-42', repo: { full_name: 'owner/repo' } },
    }], { repository: 'owner/repo' })],
    [digest],
  );
  assert.deepEqual([...activeGroupDigests([member], [], { repository: 'owner/repo' })], []);
  assert.deepEqual(
    [...activeGroupDigests(
      [{ ...member, labels: [{ name: instanceLabel }, { name: 'agent:fix' }] }],
      [],
      { repository: 'owner/repo' },
    )],
    [digest],
  );
  assert.deepEqual(
    issueGroupInstanceLabels({ labels: [{ name: instanceLabel }, { name: 'agent:fix-group:malformed' }] }),
    [instanceLabel, 'agent:fix-group:malformed'],
  );
});

test('il mutex B19 qualifica ref e repository head, rifiutando fork e risposta parziale', () => {
  const digest = '0123456789ab';
  const instanceLabel = `agent:fix-group:${digest}-42`;
  const member = {
    ...targetIssue(2),
    labels: [{ name: instanceLabel }],
  };
  const localPr = {
    head: { ref: 'fix/issue-42', repo: { full_name: 'owner/repo' } },
  };
  const forkPr = {
    head: { ref: 'fix/issue-42', repo: { full_name: 'someone/fork' } },
  };

  assert.deepEqual(
    [...activeGroupDigests([member], [localPr], { repository: 'owner/repo' })],
    [digest],
  );
  assert.deepEqual(
    [...activeGroupDigests([member], [forkPr], { repository: 'owner/repo' })],
    [],
    'un fork con lo stesso branch non può trattenere il gruppo del repository corrente',
  );
  assert.equal(openPrHeadIdentity({ head: { ref: 'fix/issue-42' } }), null);
  assert.equal(
    parseOpenGroupPrs([[localPr], [{ head: { ref: 'fix/issue-43', repo: null } }]]),
    null,
    'una risposta REST senza identità completa del head deve rendere indisponibile la scansione',
  );
  assert.deepEqual(parseOpenGroupPrs([[localPr]]), [localPr]);
});

test('la scansione overlap distingue lista PR vuota valida da lista indisponibile', () => {
  const empty = openPrFilesScanDecision([], new Map());
  assert.equal(empty.ok, true);
  assert.deepEqual([...empty.map.entries()], []);

  const unavailable = openPrFilesScanDecision(null, new Map());
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.reason, 'open-pr-list-unavailable');
  assert.equal(unavailable.map, null);
});

test('la scansione overlap usa tutte le pagine REST, oltre il limite storico di 50 PR', () => {
  const firstPage = Array.from({ length: 50 }, (_, index) => ({
    number: index + 1,
    title: `fix ${index + 1}`,
    body: '',
  }));
  const secondPage = [{ number: 51, title: 'fix 51', body: '' }];
  const complete = flattenPaginatedOpenPrs([firstPage, secondPage]);
  assert.equal(complete.length, 51);

  const loader = DRAINER_SOURCE.slice(
    DRAINER_SOURCE.indexOf('function loadOpenPrFilesMap'),
    DRAINER_SOURCE.indexOf('/** Wrapper:', DRAINER_SOURCE.indexOf('function loadOpenPrFilesMap')),
  );
  assert.match(loader, /pulls\?state=open&per_page=100/);
  assert.match(loader, /--paginate/);
  assert.match(loader, /--slurp/);
  assert.doesNotMatch(loader, /'pr', 'list'/);
});

test('una diff mancante o illeggibile blocca la scansione, anche con PR aperta', () => {
  const prs = [{ number: 42, title: 'fix', body: '' }];
  const missing = openPrFilesScanDecision(prs, new Map());
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'open-pr-diff-unavailable-42');

  const malformed = openPrFilesScanDecision(prs, new Map([[42, null]]));
  assert.equal(malformed.ok, false);
  assert.equal(malformed.reason, 'open-pr-diff-unavailable-42');
});

test('diff vuota è una scansione valida e non produce overlap', () => {
  const scan = openPrFilesScanDecision(
    [{ number: 42, title: 'fix', body: null }],
    new Map([[42, '']]),
  );
  assert.equal(scan.ok, true);
  assert.equal(findOverlapFile(['scripts/ci/followup-drainer.mjs'], scan.map), null);
  assert.equal(findOverlapFile(['scripts/ci/followup-drainer.mjs'], null), null);
});

test('il drainer lascia il candidato in coda quando la scansione overlap è unavailable', () => {
  assert.match(DRAINER_SOURCE, /OVERLAP-SCAN-BLOCK/);
  assert.match(DRAINER_SOURCE, /retryable, blocked-zero-agent/);
  assert.match(DRAINER_SOURCE, /overlapScanBlocked/);
  const candidate = DRAINER_SOURCE.slice(
    DRAINER_SOURCE.indexOf('const candPaths = extractCodePaths'),
    DRAINER_SOURCE.indexOf('const quotaLease = reserveQuotaLease', DRAINER_SOURCE.indexOf('const candPaths = extractCodePaths')),
  );
  assert.ok(candidate.indexOf('OVERLAP-SCAN-BLOCK') >= 0);
  assert.ok(
    DRAINER_SOURCE.indexOf('OVERLAP-SCAN-BLOCK', DRAINER_SOURCE.indexOf('const candPaths = extractCodePaths'))
      < DRAINER_SOURCE.indexOf('const quotaLease = reserveQuotaLease', DRAINER_SOURCE.indexOf('const candPaths = extractCodePaths')),
  );
});

test('il rescue rimuove i marker B19 prima di ogni riarmo o park', () => {
  const queueStart = DRAINER_SOURCE.indexOf('// --- RESCUE + PARK: agent:fix');
  const crawlerStart = DRAINER_SOURCE.indexOf('// --- CRAWLER RESCUE + PARK (non-queue-managed');
  const decomposeStart = DRAINER_SOURCE.indexOf('// --- DECOMPOSE-RESCUE + DECOMPOSE-DRAIN');
  const queueRescue = DRAINER_SOURCE.slice(queueStart, crawlerStart);
  const crawlerRescue = DRAINER_SOURCE.slice(crawlerStart, decomposeStart);

  assert.ok(queueStart >= 0 && crawlerStart > queueStart && decomposeStart > crawlerStart);
  assert.match(queueRescue, /if \(!clearIssueGroupLabels\(iss\)\)/);
  assert.match(crawlerRescue, /if \(!clearIssueGroupLabels\(iss\)\)/);
});
