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
