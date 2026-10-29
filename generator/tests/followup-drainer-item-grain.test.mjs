/**
 * Drainer (corpus): bucket giornaliero parcheggiato per data-pending.
 *
 * Due contratti a grana di item, gemelli di quelli del sito:
 *
 * 1. PARENT-DEQUEUE è idempotente: il commento porta `<!-- PARENT_DEQUEUED -->`
 *    e si posta una volta sola. Un secondo dequeue sullo stesso padre toglie
 *    le label senza commentare e lo segnala (`parent_dequeue_repeat`); una
 *    lettura dei commenti fallita non commenta mai.
 * 2. `detectDataPending` non parcheggia un bucket giornaliero per la frase di
 *    UN item, e su una issue singola non legge le intestazioni Markdown come
 *    dichiarazioni di attesa.
 *
 * Dependency-free: nessuna chiamata a GitHub.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isRepositoryOwnedPrHead } from '../../scripts/ci/lib/pr-head-identity.mjs';
import {
  PARENT_DEQUEUED_MARKER,
  applyParentDequeue,
  dailyBucketOutcomeTransition,
  dailyMutexDecision,
  dailyOverlapRetryHold,
  dailyOutcomeItemId,
  detectDataPending,
  parentDequeueCommentDecision,
  selectMergedDailyItemPr,
} from '../../scripts/ci/followup-drainer.mjs';
import { dailyBucketScopeDecision, isDailyBucketTitle } from '../../scripts/ci/followup-resolution-match.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DRAINER = readFileSync(path.join(ROOT, 'scripts/ci/followup-drainer.mjs'), 'utf8');
const ISSUE_FIX_WORKFLOW = readFileSync(path.join(ROOT, '.github/workflows/issue-fix.yml'), 'utf8');

const BODY = 'padre decomposto fuori dalla coda del fixer';

/** I/O finto: registra commenti, rimozioni di label e righe di log. */
function fakeIo(readComments, removeResult = true) {
  const calls = { comments: [], removed: [], log: [], order: [] };
  return {
    calls,
    io: {
      readComments,
      postComment: (num, body) => { calls.comments.push({ num, body }); calls.order.push('comment'); },
      removeLabels: (num) => {
        calls.removed.push(num);
        calls.order.push('remove');
        if (removeResult instanceof Error) throw removeResult;
        return removeResult;
      },
      body: BODY,
      log: (line) => { calls.log.push(line); },
    },
  };
}

test('primo dequeue: label tolte, poi un commento con il marker', () => {
  const { calls, io } = fakeIo(() => [{ body: 'un commento qualsiasi' }]);
  assert.deepEqual(applyParentDequeue({ number: 41 }, io), { decision: 'comment', labelsRemoved: true });
  assert.equal(calls.comments.length, 1);
  assert.ok(calls.comments[0].body.startsWith(PARENT_DEQUEUED_MARKER));
  assert.ok(calls.comments[0].body.includes(BODY));
  assert.deepEqual(calls.removed, [41]);
  assert.deepEqual(calls.order, ['remove', 'comment'], 'il commento segue un edit confermato');
});

test('edit rifiutato (claim live, CLAIM-READ-FAIL) o in errore: zero commenti, niente marker', () => {
  // Solo `true` conferma: un valore non booleano (null, stringa) non è un edit riuscito.
  for (const refused of [false, null, 'ok', new Error('gh: HTTP 502')]) {
    const { calls, io } = fakeIo(() => [], refused);
    const out = applyParentDequeue({ number: 41 }, io);
    assert.deepEqual(out, { decision: 'comment', labelsRemoved: false });
    assert.equal(calls.comments.length, 0, `nessun commento con removeLabels → ${String(refused)}`);
    assert.ok(calls.log.some((line) => line.startsWith('::warning::') && line.includes('#41')));

    // Il tick dopo NON è un repeat: senza marker il padre è ancora un primo dequeue.
    const next = fakeIo(() => calls.comments.map((c) => ({ body: c.body })));
    assert.equal(applyParentDequeue({ number: 41 }, next.io).decision, 'comment');
  }
});

test('secondo dequeue con marker: zero commenti, decisione repeat, warning che nomina la issue', () => {
  // Il secondo giro legge ciò che il primo ha scritto: nessun testo fissato a mano.
  const first = fakeIo(() => []);
  applyParentDequeue({ number: 41 }, first.io);
  const posted = first.calls.comments.map((c) => ({ body: c.body }));

  const second = fakeIo(() => posted);
  assert.deepEqual(applyParentDequeue({ number: 41 }, second.io), { decision: 'repeat', labelsRemoved: true });
  assert.equal(second.calls.comments.length, 0);
  assert.deepEqual(second.calls.removed, [41], 'la rimozione delle label resta incondizionata');
  assert.ok(second.calls.log.some((line) => line.startsWith('::warning::') && line.includes('#41')));
});

test('lettura commenti fallita (null o eccezione): zero commenti, label tolte comunque', () => {
  const readers = [
    () => null,
    () => { throw new Error('gh: HTTP 502'); },
  ];
  for (const reader of readers) {
    const { calls, io } = fakeIo(reader);
    assert.deepEqual(applyParentDequeue({ number: 7 }, io), { decision: 'unreadable', labelsRemoved: true });
    assert.equal(calls.comments.length, 0);
    assert.deepEqual(calls.removed, [7]);
    assert.ok(calls.log.some((line) => line.startsWith('::warning::')));
  }
});

test('la decisione distingue «nessun commento» da «commenti non letti»', () => {
  assert.equal(parentDequeueCommentDecision([]), 'comment');
  assert.equal(parentDequeueCommentDecision(null), 'unreadable');
  assert.equal(parentDequeueCommentDecision(undefined), 'unreadable');
  assert.equal(parentDequeueCommentDecision([{ body: `x\n${PARENT_DEQUEUED_MARKER}\ny` }]), 'repeat');
  assert.equal(parentDequeueCommentDecision([{ body: '<!--PARENT_DEQUEUED-->' }]), 'repeat');
  assert.equal(parentDequeueCommentDecision([{}, { body: null }]), 'comment');
});

test('lo stadio PARENT-DEQUEUE passa dal helper e pubblica il contatore', () => {
  const start = DRAINER.indexOf('// PARENT-DEQUEUE: un padre decomposto');
  const end = DRAINER.indexOf('// Il cap di questo stadio conta le ESAMINATE', start);
  assert.ok(start > 0 && end > start, 'stadio parent-dequeue non trovato');
  const stage = DRAINER.slice(start, end);
  assert.match(stage, /applyParentDequeue\(p, \{/);
  assert.match(stage, /readComments: issueComments/);
  assert.match(stage, /parent_dequeue_repeat=/);
  assert.match(stage, /GITHUB_STEP_SUMMARY/);
  // Il commento non si posta più fuori dal helper: sarebbe di nuovo senza marker.
  assert.doesNotMatch(stage, /^\s*commentIssue\(p\.number/m);
});

const DAILY_OUTCOME_TITLE = 'follow-up(daily:2026-10-02): 3 items — nanakokyobashi-rgb/frontaliere-articles';
const DAILY_OUTCOME_BODY = [
  `## ${DAILY_OUTCOME_TITLE}`,
  '- Daily key: 2026-10-02',
  '- Target repository: nanakokyobashi-rgb/frontaliere-articles',
  '- State: sealed',
  '',
  '### FU-2026-10-02-001 — primo item',
  '- Target repository: nanakokyobashi-rgb/frontaliere-articles',
  '- State: open',
  '- Suggested action: firstAcceptanceToken()',
  '',
  '### FU-2026-10-02-002 — secondo item',
  '- Target repository: nanakokyobashi-rgb/frontaliere-articles',
  '- State: open',
  '- Suggested action: secondAcceptanceToken()',
  '',
  '### FU-2026-10-02-003 — terzo item',
  '- Target repository: nanakokyobashi-rgb/frontaliere-articles',
  '- State: blocked',
  '- Suggested action: thirdAcceptanceToken()',
].join('\n');

test('il preflight daily distingue item open, in-progress, terminale e bucket malformato', () => {
  const open = dailyBucketScopeDecision(DAILY_OUTCOME_TITLE, DAILY_OUTCOME_BODY);
  assert.equal(open.valid, true);
  assert.equal(open.terminal, false);
  assert.equal(open.item.id, 'FU-2026-10-02-001');

  const inProgressBody = DAILY_OUTCOME_BODY.replaceAll('- State: open', '- State: in-progress');
  const inProgress = dailyBucketScopeDecision(DAILY_OUTCOME_TITLE, inProgressBody);
  assert.equal(inProgress.valid, true);
  assert.equal(inProgress.terminal, false);
  assert.equal(inProgress.reason, 'item-in-progress');

  const settledBody = DAILY_OUTCOME_BODY
    .replaceAll('- State: open', '- State: done');
  const settled = dailyBucketScopeDecision(DAILY_OUTCOME_TITLE, settledBody);
  assert.equal(settled.valid, true);
  assert.equal(settled.terminal, true);

  const empty = dailyBucketScopeDecision(DAILY_OUTCOME_TITLE, '');
  assert.equal(empty.valid, false);
  assert.equal(empty.terminal, false);
  assert.equal(empty.reason, 'bucket-not-sealed');

  const malformed = dailyBucketScopeDecision(
    DAILY_OUTCOME_TITLE,
    DAILY_OUTCOME_BODY.replace('- State: open', '- State: unknown'),
  );
  assert.equal(malformed.valid, false);
  assert.equal(malformed.terminal, false);
  assert.equal(malformed.reason, 'invalid-item-state');
});

test('un pr-created daily attende la PR mergiata dello stesso FU e avanza solo quel FU', () => {
  const outcome = '<!-- FOLLOWUP_ITEM: FU-2026-10-02-001 -->\n<!-- FIX_OUTCOME: pr-created -->';
  const waiting = dailyBucketOutcomeTransition(
    { title: DAILY_OUTCOME_TITLE, body: DAILY_OUTCOME_BODY },
    'pr-created',
    outcome,
  );
  assert.equal(waiting.action, 'awaiting-merged-pr');

  const siblingProof = dailyBucketOutcomeTransition(
    { title: DAILY_OUTCOME_TITLE, body: DAILY_OUTCOME_BODY },
    'pr-created',
    outcome,
    { verifiedMergedItemId: 'FU-2026-10-02-002' },
  );
  assert.equal(siblingProof.action, 'awaiting-merged-pr');

  const merged = dailyBucketOutcomeTransition(
    { title: DAILY_OUTCOME_TITLE, body: DAILY_OUTCOME_BODY },
    'pr-created',
    outcome,
    { verifiedMergedItemId: 'FU-2026-10-02-001' },
  );
  assert.equal(merged.action, 'requeue');
  assert.equal(merged.itemId, 'FU-2026-10-02-001');
  assert.equal(merged.state, 'done');
  assert.equal(merged.nextItem.id, 'FU-2026-10-02-002');
  assert.match(merged.body, /### FU-2026-10-02-001[\s\S]*?- State: done/);
});

test('la prova merged daily richiede marker FU esatto e merge successivo al verdetto', () => {
  const cutoff = Date.parse('2026-10-02T12:00:00Z');
  const selected = selectMergedDailyItemPr([
    { number: 91, mergedAt: '2026-10-02T11:59:00Z', body: 'Follow-up item: FU-2026-10-02-001' },
    { number: 92, mergedAt: '2026-10-02T12:02:00Z', body: 'Follow-up item: FU-2026-10-02-002' },
    { number: 93, mergedAt: '2026-10-02T12:03:00Z', body: 'Follow-up item: FU-2026-10-02-001' },
    { number: 94, mergedAt: '2026-10-02T12:04:00Z', body: 'Follow-up item: FU-2026-10-02-001\nFollow-up item: FU-2026-10-02-002' },
  ], 'FU-2026-10-02-001', cutoff);
  assert.deepEqual(selected, {
    number: 93,
    mergedAt: Date.parse('2026-10-02T12:03:00Z'),
    itemId: 'FU-2026-10-02-001',
  });
  assert.equal(selectMergedDailyItemPr([], 'FU-2026-10-02-001', null), null);
});

test('il verdetto daily cambia solo l’item attribuito e riaccoda il successivo', () => {
  const outcomeComment = [
    'Verifica `already-fixed` per `FU-2026-10-02-001`: il fix è già presente.',
    '',
    'Un altro residuo citato è FU-2026-10-02-003, che resta fuori dall’esito.',
  ].join('\n');
  const result = dailyBucketOutcomeTransition(
    { title: DAILY_OUTCOME_TITLE, body: DAILY_OUTCOME_BODY },
    'already-fixed',
    outcomeComment,
  );

  assert.equal(result.action, 'requeue');
  assert.equal(result.itemId, 'FU-2026-10-02-001');
  assert.equal(result.state, 'done');
  assert.equal(result.nextItem.id, 'FU-2026-10-02-002');
  assert.deepEqual(result.body.match(/^- State: (?:open|done|blocked)$/gm), [
    '- State: done',
    '- State: open',
    '- State: blocked',
  ]);
});

test('un verdetto terminale non risolutivo blocca un solo item e non ferma gli altri', () => {
  const result = dailyBucketOutcomeTransition(
    { title: DAILY_OUTCOME_TITLE, body: DAILY_OUTCOME_BODY },
    'no-root-cause',
    'FU-2026-10-02-001: non ho trovato una causa verificabile.\n\n<!-- FIX_OUTCOME: no-root-cause -->',
  );
  assert.equal(result.action, 'requeue');
  assert.equal(result.state, 'blocked');
  assert.equal(result.nextItem.id, 'FU-2026-10-02-002');
  assert.match(result.body, /### FU-2026-10-02-001[\s\S]*?- State: blocked/);
  assert.match(result.body, /### FU-2026-10-02-002[\s\S]*?- State: open/);
});

test('un FIX_OUTCOME già consumato ripara il routing senza riapplicare il verdetto', () => {
  for (const state of ['done', 'blocked']) {
    const body = DAILY_OUTCOME_BODY.replace('- State: open', `- State: ${state}`);
    const result = dailyBucketOutcomeTransition(
      { title: DAILY_OUTCOME_TITLE, body },
      'already-fixed',
      '<!-- FOLLOWUP_ITEM: FU-2026-10-02-001 -->\n<!-- FIX_OUTCOME: already-fixed -->',
    );
    assert.equal(result.action, 'outcome-consumed', `${state}: il verdetto non deve essere riapplicato`);
    assert.equal(result.itemId, 'FU-2026-10-02-001');
    assert.equal(result.state, state);
    assert.equal(result.action, 'outcome-consumed');
    assert.equal(result.reconcileAction, 'requeue', 'un body già aggiornato conserva l’azione label da riprovare');
    assert.equal(result.nextItem.id, 'FU-2026-10-02-002');
    assert.equal(result.body, undefined);
  }
});

test('l’attribuzione daily usa un solo item esplicito e fallisce chiusa se ambigua', () => {
  assert.equal(dailyOutcomeItemId('<!-- FOLLOWUP_ITEM: FU-2026-10-02-002 -->\n\nFU-2026-10-02-001'), 'FU-2026-10-02-002');
  assert.equal(dailyOutcomeItemId('Esito per FU-2026-10-02-001 e FU-2026-10-02-002.'), null);
  const result = dailyBucketOutcomeTransition(
    { title: DAILY_OUTCOME_TITLE, body: DAILY_OUTCOME_BODY },
    'already-fixed',
    'Esito indistinguibile per FU-2026-10-02-001 e FU-2026-10-02-002.\n\n<!-- FIX_OUTCOME: already-fixed -->',
  );
  assert.deepEqual(result, {
    handled: true,
    action: 'unattributed',
    reason: 'outcome senza un solo FU stabile',
  });
});

test('il mutex daily blocca anche un FU diverso sul branch condiviso e mantiene il legacy ambiguo in fail-closed', () => {
  const wanted = 'FU-2026-10-02-001';
  const scanForOtherItem = {
    ok: true,
    prs: [{
      number: 2571,
      title: 'fix daily item',
      body: 'Addresses #2151\nFollow-up item: FU-2026-10-02-006',
      head: { ref: 'fix/issue-2151' },
    }],
  };
  assert.deepEqual(dailyMutexDecision(wanted, scanForOtherItem, 2151), {
    eligible: false,
    reason: 'item-pr-open',
    pr: scanForOtherItem.prs[0],
  });

  const separateBranch = {
    ok: true,
    prs: [{
      number: 2576,
      title: 'fix daily item',
      body: 'Addresses #2151\nFollow-up item: FU-2026-10-02-006',
      head: { ref: 'fix/issue-2151-FU-006' },
    }],
  };
  assert.equal(dailyMutexDecision(wanted, separateBranch, 2151).eligible, true);

  const legacyIssuePr = {
    ok: true,
    prs: [{ number: 2572, title: 'Addresses #2151', body: 'legacy PR with no FU marker' }],
  };
  assert.deepEqual(dailyMutexDecision(wanted, legacyIssuePr, 2151), {
    eligible: false,
    reason: 'item-pr-open',
    pr: legacyIssuePr.prs[0],
  });
  assert.equal(dailyMutexDecision(wanted, legacyIssuePr, 9999).eligible, true);
});

test('il mutex daily tratta come legacy anche una PR markerless sul branch issue', () => {
  const wanted = 'FU-2026-10-02-001';
  for (const pr of [
    { number: 2573, title: 'fix senza marker', body: 'nessun riferimento all’issue', head: { ref: 'fix/issue-2151' } },
    { number: 2574, title: 'fix senza marker', body: 'nessun riferimento all’issue', headRefName: 'fix/issue-2151' },
  ]) {
    const decision = dailyMutexDecision(wanted, { ok: true, prs: [pr] }, 2151);
    assert.deepEqual(decision, { eligible: false, reason: 'item-pr-open', pr });
  }
  const differentIssueBranch = {
    number: 2575,
    title: 'fix senza marker',
    body: 'nessun riferimento all’issue',
    head: { ref: 'fix/issue-9999' },
  };
  assert.equal(dailyMutexDecision(wanted, { ok: true, prs: [differentIssueBranch] }, 2151).eligible, true);
});

test('il mutex daily ignora una fork che riusa il branch del fixer e riconosce entrambi i formati head', () => {
  const repository = 'nanakokyobashi-rgb/frontaliere-articles';
  const forkPr = {
    number: 2577,
    title: 'PR aperta da una fork',
    body: 'Branch riutilizzato senza riferimenti all’issue',
    head: { ref: 'fix/issue-2151', repo: { full_name: 'contributor/frontaliere-articles' } },
  };
  const ownPr = {
    number: 2578,
    title: 'fix daily item',
    body: 'Addresses #2151',
    headRefName: 'fix/issue-2151',
    headRepository: { nameWithOwner: repository },
  };

  assert.equal(isRepositoryOwnedPrHead(forkPr, repository), false);
  assert.equal(isRepositoryOwnedPrHead(ownPr, repository), true);
  assert.equal(isRepositoryOwnedPrHead({ headRefName: 'fix/issue-2151' }, repository), null);
  assert.equal(dailyMutexDecision('FU-2026-10-02-001', { ok: true, prs: [forkPr] }, 2151, repository).eligible, true);
  assert.equal(dailyMutexDecision('FU-2026-10-02-001', {
    ok: true,
    prs: [{ ...forkPr, body: 'Follow-up item: FU-2026-10-02-001' }],
  }, 2151, repository).eligible, false);
  assert.deepEqual(dailyMutexDecision('FU-2026-10-02-001', { ok: true, prs: [ownPr] }, 2151, repository), {
    eligible: false,
    reason: 'item-pr-open',
    pr: ownPr,
  });

  assert.match(ISSUE_FIX_WORKFLOW, /number,headRefName,body,headRepository/);
  assert.match(ISSUE_FIX_WORKFLOW, /scripts\/ci\/lib\/pr-head-identity\.mjs/);
  assert.match(ISSUE_FIX_WORKFLOW, /isRepositoryOwnedPrHead\(pr, repository\) !== false/);
});

test('un pr-already-open attribuito riaccoda solo il FU attualmente selezionato', () => {
  const result = dailyBucketOutcomeTransition(
    { title: DAILY_OUTCOME_TITLE, body: DAILY_OUTCOME_BODY },
    'pr-already-open',
    'PR già in volo: #2571, skip.\n<!-- FOLLOWUP_ITEM: FU-2026-10-02-001 -->\n\n<!-- FIX_OUTCOME: pr-already-open -->',
  );
  assert.equal(result.action, 'retry');
  assert.equal(result.itemId, 'FU-2026-10-02-001');
  assert.equal(result.nextItem.id, 'FU-2026-10-02-001');
  assert.equal(result.changed, false);
  assert.equal(result.body, DAILY_OUTCOME_BODY);
});

test('un marker transient stantio o attribuito a un altro FU non riaccoda il bucket', () => {
  const result = dailyBucketOutcomeTransition(
    { title: DAILY_OUTCOME_TITLE, body: DAILY_OUTCOME_BODY },
    'pr-already-open',
    '<!-- FOLLOWUP_ITEM: FU-2026-10-02-002 -->\n<!-- FIX_OUTCOME: pr-already-open -->',
  );
  assert.equal(result.action, 'stale-attribution');
  assert.equal(result.itemId, 'FU-2026-10-02-002');
  assert.equal(result.body, undefined);
});

test('un outcome transient del FU terminale non riaccoda il FU successivo', () => {
  const body = DAILY_OUTCOME_BODY.replace(
    '### FU-2026-10-02-001 — primo item\n- Target repository: nanakokyobashi-rgb/frontaliere-articles\n- State: open',
    '### FU-2026-10-02-001 — primo item\n- Target repository: nanakokyobashi-rgb/frontaliere-articles\n- State: done',
  );
  const result = dailyBucketOutcomeTransition(
    { title: DAILY_OUTCOME_TITLE, body },
    'pr-already-open',
    'PR già in volo: #2571, skip.\n<!-- FOLLOWUP_ITEM: FU-2026-10-02-001 -->\n<!-- FIX_OUTCOME: pr-already-open -->',
  );
  assert.equal(result.action, 'stale-attribution');
  assert.equal(result.itemId, 'FU-2026-10-02-001');
  assert.equal(result.nextItem, undefined);
  assert.equal(result.body, undefined);
});

test('overlap-skip trattiene il daily finché la PR dichiarata è attiva o non verificabile', () => {
  const comments = [{
    body: 'File già in volo nella PR #2571 — skip.\n<!-- FIX_OUTCOME: overlap-skip -->',
    createdAt: '2026-10-02T12:00:00Z',
  }];
  assert.deepEqual(dailyOverlapRetryHold(null, () => null), {
    hold: true, blocker: null, reason: 'comments-unreadable',
  });
  assert.deepEqual(dailyOverlapRetryHold(comments, () => ({ state: 'OPEN', labels: [] })), {
    hold: true, blocker: 2571, reason: 'blocker-active',
  });
  assert.deepEqual(dailyOverlapRetryHold(comments, () => null), {
    hold: true, blocker: 2571, reason: 'blocker-unverifiable',
  });
  assert.deepEqual(dailyOverlapRetryHold(comments, () => ({ state: 'CLOSED', labels: [] })), {
    hold: false, blocker: 2571, reason: 'blocker-inactive',
  });
});

test('un esito terminale su un daily senza altri open resta aggregato e non chiude', () => {
  const body = DAILY_OUTCOME_BODY
    .replace('### FU-2026-10-02-002 — secondo item\n- Target repository: nanakokyobashi-rgb/frontaliere-articles\n- State: open', '### FU-2026-10-02-002 — secondo item\n- Target repository: nanakokyobashi-rgb/frontaliere-articles\n- State: done');
  const result = dailyBucketOutcomeTransition(
    { title: DAILY_OUTCOME_TITLE, body },
    'already-fixed',
    '<!-- FOLLOWUP_ITEM: FU-2026-10-02-001 -->\n<!-- FIX_OUTCOME: already-fixed -->',
  );
  assert.equal(result.action, 'blocked', 'l’item 003 è ancora blocked: non si dichiara chiuso il bucket');
  assert.equal(result.nextItem, null);
  assert.match(result.body, /### FU-2026-10-02-003[\s\S]*?- State: blocked/);
});

test('un daily blocked senza prossimo item esce tecnicamente dal pool parked', () => {
  const start = DRAINER.indexOf('// A daily issue is only a container.');
  const end = DRAINER.indexOf('const add = action ===', start);
  assert.ok(start >= 0 && end > start, 'blocco daily non trovato');
  const branch = DRAINER.slice(start, end);
  assert.match(branch, /if \(action === 'blocked'\)/);
  assert.match(branch, /deferAutomationIssue\(iss\.number/);
  assert.match(branch, /remove: \[LBL_PARKED, LBL_MAYBE_RESOLVED, LBL_QUEUED, LBL_FIX/);
  assert.match(branch, /daily-bucket-blocked/);
});

test('VERDICT-EXIT instrada il daily prima della decisione terminale issue-wide', () => {
  const start = DRAINER.indexOf('// --- VERDICT-EXIT:');
  const end = DRAINER.indexOf('// --- TOO-LARGE ESCALATION', start);
  const stage = DRAINER.slice(start, end);
  assert.ok(start >= 0 && end > start, 'stadi VERDICT-EXIT non trovati');
  assert.match(stage, /latestFixRunOutcomeEntryFromComments\(comments\)/);
  assert.match(stage, /const composeTransition = \(snapshot\) => dailyBucketOutcomeTransition\(/);
  assert.match(stage, /let transition = composeTransition\(liveIssue\)/);
  assert.match(stage, /dailyOverlapRetryHold\(comments, readOverlapBlocker\)/);
  assert.match(stage, /let action = outcomeConsumed \? transition\.reconcileAction : transition\.action/);
  assert.match(stage, /labelsNeedRepair/);
  assert.match(stage, /loadOpenPrsForDailyMutex\(\)/);
  assert.match(stage, /updateDailyIssueBody\(/);
  assert.match(stage, /outcome === 'pr-created'/);
  assert.match(stage, /mergedDailyItemPr\(iss\.number, dailyOutcomeItemId\(outcomeBody\), outcomeEntry\.at\)/);
  assert.match(stage, /verifiedMergedItemId: mergedItemPr\?\.itemId \|\| null/);
  assert.match(stage, /if \(!outcomeConsumed\) commentIssue\(iss\.number, note, 'daily item outcome comment'\)/);
  assert.match(stage, /const add = action === 'requeue' \|\| action === 'retry' \? \[LBL_QUEUED\]/);
  assert.ok(stage.indexOf('dailyBucketOutcomeTransition(') < stage.indexOf('verdictExitDecision('));
  assert.match(DRAINER, /const dailyBucket = dailyBucketInfo\(iss\?\.title/);
});

test('tutti i writer automatici del body daily condividono un mutex repo-scoped non cancellabile', () => {
  const writers = [
    ['followup-drainer.yml', 'scripts/ci/followup-drainer.mjs'],
    ['followup-reconcile.yml', 'scripts/ci/reconcile-followups.mjs'],
    // Questo workflow ospita sia il collector sia gate-minted-followups.
    ['post-merge-followup.yml', 'scripts/ci/collect-followup-batch.mjs'],
    ['post-merge-followup.yml', 'scripts/ci/gate-minted-followups.mjs'],
  ];
  for (const [file, writer] of writers) {
    const source = readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8');
    assert.ok(source.includes(writer), `${file} deve restare il workflow del writer ${writer}`);
    const executableSource = source.replace(/^[ \t]*#.*$/gm, '');
    assert.match(executableSource, /concurrency:\s*\n\s+group: followup-daily-\$\{\{ github\.repository \}\}\s*\n\s+cancel-in-progress: false/, `${file}: mutex condiviso richiesto`);
  }
  assert.match(DRAINER, /issue endpoint does not support conditional PATCH/);
  assert.match(DRAINER, /shared repo-scoped `followup-daily-` Actions mutex/);
  assert.match(DRAINER, /for \(let attempt = 0; attempt < 3; attempt\+\+\)/);
  assert.match(DRAINER, /composeTransition\(latest\)/);
  assert.match(DRAINER, /body cambiato durante tre re-read/);
  assert.doesNotMatch(DRAINER, /prima della scrittura CAS/);
});

test('il guard workflow del drainer è per-item e annota il blocco nello stesso esito', () => {
  const start = DRAINER.indexOf('const issueFixCanPushWorkflows = canPushWorkflows();');
  const end = DRAINER.indexOf('// Check: wide-scope aggregate', start);
  assert.ok(start >= 0 && end > start, 'guard workflow del drainer non trovato');
  const stage = DRAINER.slice(start, end);
  assert.match(stage, /const workflowScopeItem = dailyQueue\.item/);
  assert.match(stage, /detectWorkflowScoped\(workflowScopeText, workflowScopeMeta\)/);
  assert.match(stage, /const itemMarker = workflowScopeItem/);
  assert.match(stage, /FIX_OUTCOME: blocked-workflows-scope/);
  assert.match(stage, /FOLLOWUP_ITEM: \$\{workflowScopeItem\.id\}/);
  assert.match(stage, /commentIssue\(cand\.number, outcomeNote/);
});

const DAILY_TITLE = 'follow-up(daily:2026-10-02): 3 items — nanakokyobashi-rgb/frontaliere-articles';
const DAILY_BODY = [
  '### FU-2026-10-02-001 — Soglia del gate di qualità',
  '- State: open',
  '- blocked: data-pending, serve la misura di due run consecutivi',
  '',
  '### FU-2026-10-02-002 — Full-suite post-merge: report e baseline di performance',
  '- State: open',
  '- Comando: `gh workflow run full-suite-dispatch.yml`',
  '',
  '### FU-2026-10-02-003 — Rinomina di un helper',
  '- State: open',
].join('\n');

test('bucket giornaliero con una riga data-pending in un item → null', () => {
  assert.equal(isDailyBucketTitle(DAILY_TITLE), true, 'la fixture deve essere un bucket giornaliero');
  assert.equal(detectDataPending(DAILY_TITLE, DAILY_BODY), null);
});

test('lo stesso corpo sotto un titolo non aggregato viene rilevato (il bucket non è un caso vuoto)', () => {
  const hit = detectDataPending('follow-up(#12): soglia del gate', DAILY_BODY);
  assert.ok(hit && hit.includes('data-pending'));
});

test('issue singola: la frase solo in una intestazione → null; in una riga di testo → rilevata', () => {
  const title = 'follow-up(#12): 1 item deferred — report full-suite';
  const heading = '### 1. Full-suite post-merge: report e baseline di performance';
  for (const line of [heading, heading.replace('###', '#'), `  ${heading.replace('###', '######')}`]) {
    assert.equal(detectDataPending(title, `${line}\n- Comando eseguibile oggi.`), null, line);
  }
  const hit = detectDataPending(title, `${heading}\n- richiede una baseline post-merge prima di decidere`);
  assert.ok(hit && hit.includes('richiede una baseline'));
});

test('aggregata «N items deferred» → null come prima; il titolo resta sovrano', () => {
  const body = '### 1. a\n### 2. b\n### 3. blocked: data-pending\n- blocked: data-pending';
  assert.equal(detectDataPending('follow-up(#9): 3 items deferred — vari', body), null);
  assert.ok(detectDataPending('follow-up(#9): 3 items deferred (blocked, in attesa di dati dal warning)', body));
  // Vale anche per il bucket giornaliero: un marker nel titolo copre lo scope intero.
  assert.ok(detectDataPending(`${DAILY_TITLE} (in attesa di dati)`, DAILY_BODY));
});
