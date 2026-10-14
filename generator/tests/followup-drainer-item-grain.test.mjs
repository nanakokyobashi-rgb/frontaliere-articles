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
import {
  PARENT_DEQUEUED_MARKER,
  applyParentDequeue,
  dailyBucketOutcomeTransition,
  dailyMutexDecision,
  dailyOutcomeItemId,
  detectDataPending,
  parentDequeueCommentDecision,
} from '../../scripts/ci/followup-drainer.mjs';
import { isDailyBucketTitle } from '../../scripts/ci/followup-resolution-match.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DRAINER = readFileSync(path.join(ROOT, 'scripts/ci/followup-drainer.mjs'), 'utf8');

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

test('il mutex daily non blocca un FU diverso ma mantiene il legacy ambiguo in fail-closed', () => {
  const wanted = 'FU-2026-10-02-001';
  const scanForOtherItem = {
    ok: true,
    prs: [{ number: 2571, title: 'fix daily item', body: 'Addresses #2151\nFollow-up item: FU-2026-10-02-006' }],
  };
  assert.equal(dailyMutexDecision(wanted, scanForOtherItem, 2151).eligible, true);

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

test('un vecchio pr-already-open riaccoda il primo FU open se la sua PR non è più attiva', () => {
  const result = dailyBucketOutcomeTransition(
    { title: DAILY_OUTCOME_TITLE, body: DAILY_OUTCOME_BODY },
    'pr-already-open',
    'PR già in volo: #2571, skip.\n\n<!-- FIX_OUTCOME: pr-already-open -->',
  );
  assert.equal(result.action, 'retry');
  assert.equal(result.itemId, 'FU-2026-10-02-001');
  assert.equal(result.nextItem.id, 'FU-2026-10-02-001');
  assert.equal(result.changed, false);
  assert.equal(result.body, DAILY_OUTCOME_BODY);
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

test('un FIX_OUTCOME già consumato su un item terminale non riaccoda il successivo', () => {
  for (const state of ['done', 'blocked']) {
    const body = DAILY_OUTCOME_BODY.replace(
      '### FU-2026-10-02-001 — primo item\n- Target repository: nanakokyobashi-rgb/frontaliere-articles\n- State: open',
      `### FU-2026-10-02-001 — primo item\n- Target repository: nanakokyobashi-rgb/frontaliere-articles\n- State: ${state}`,
    );
    const result = dailyBucketOutcomeTransition(
      { title: DAILY_OUTCOME_TITLE, body },
      'already-fixed',
      '<!-- FOLLOWUP_ITEM: FU-2026-10-02-001 -->\n<!-- FIX_OUTCOME: already-fixed -->',
    );
    assert.equal(result.handled, true);
    assert.equal(result.action, 'outcome-consumed');
    assert.equal(result.itemId, 'FU-2026-10-02-001');
    assert.equal(result.state, state);
    assert.equal(result.reason, 'esito già applicato a un FU terminale');
  }
});

test('VERDICT-EXIT instrada il daily prima della decisione terminale issue-wide', () => {
  const start = DRAINER.indexOf('// --- VERDICT-EXIT:');
  const end = DRAINER.indexOf('// --- TOO-LARGE ESCALATION', start);
  const stage = DRAINER.slice(start, end);
  assert.ok(start >= 0 && end > start, 'stadi VERDICT-EXIT non trovati');
  assert.match(stage, /latestFixOutcomeCommentFromComments\(comments\)/);
  assert.match(stage, /dailyBucketOutcomeTransition\(liveIssue, outcome, outcomeEntry\.comment\?\.body\)/);
  assert.match(stage, /loadOpenPrsForDailyMutex\(\)/);
  assert.match(stage, /updateDailyIssueBody\(/);
  assert.match(stage, /const add = transition\.action === 'requeue' \|\| transition\.action === 'retry' \? \[LBL_QUEUED\]/);
  assert.ok(stage.indexOf('dailyBucketOutcomeTransition(') < stage.indexOf('verdictExitDecision('));
  assert.match(DRAINER, /const isDaily = !!dailyBucketInfo\(iss\?\.title/);
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
