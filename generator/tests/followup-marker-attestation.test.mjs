/**
 * followup-marker-attestation.test.mjs — tre domande del reviewer su PR #1718
 * (bucket del sito valerielinc-ops/frontaliere-si-o-no#9609), tutte sul parser
 * del marker di triage in `scripts/ci/collect-followup-batch.mjs`:
 *
 *  - FU-2026-09-24-008: la PR citata PRIMA del bucket sulla stessa riga
 *    (`bucket per PR #1718: #9102`) diventava il bucket da verificare;
 *  - FU-2026-09-24-009: la frase dello zero riportata come esempio (citazione
 *    `>`, blocco di codice, span di codice) valeva come esito reale e
 *    sopprimeva la raccolta;
 *  - FU-2026-09-24-010: «ultimo marker» era l'ultimo elemento dell'array, non
 *    il piu' recente per `createdAt`.
 *
 * Il verso resta fail-closed: nessuno di questi casi puo' far saltare una PR,
 * al massimo la tiene nel batch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  latestTriageCommentBody,
  triageMarkerPersistenceExpectation,
  verifyTriageMarkerPersistence,
} from '../../scripts/ci/collect-followup-batch.mjs';

const BUCKET = {
  number: 9102,
  title: 'follow-up(daily:2026-09-18): 13 items — valerielinc-ops/frontaliere-si-o-no',
  body: '### FU-2026-09-18-011 — x\n- Sources: PR #1718\n',
};

/* ── FU-2026-09-24-008 ─────────────────────────────────────────────────── */

test('008: la PR citata prima del numero del bucket non diventa il bucket', () => {
  for (const line of [
    'Daily bucket per PR #1718: #9102',
    'Bucket della PR #1718 → #9102 (collecting)',
    'bucket per pull request #1718: #9102',
    'Bucket per PR#1718: #9102',
  ]) {
    const marker = `## Post-merge follow-up triage\n\n${line}\n- Follow-up item: FU-2026-09-18-011`;
    assert.deepEqual(triageMarkerPersistenceExpectation(marker).buckets, [9102], line);
    assert.equal(verifyTriageMarkerPersistence(marker, 1718, () => BUCKET), true, line);
  }
});

test('008: una riga di bucket con la sola PR non dichiara nessun bucket (fail-closed)', () => {
  const marker = '## Post-merge follow-up triage\n\nBucket per PR #1718: vedi sopra\n- Follow-up item: FU-2026-09-18-011';
  const expectation = triageMarkerPersistenceExpectation(marker);
  assert.deepEqual(expectation.buckets, []);
  assert.equal(expectation.requiresBucket, true);
  assert.equal(verifyTriageMarkerPersistence(marker, 1718, () => BUCKET), false);
});

test('008: le forme gia\' supportate restano invariate', () => {
  assert.deepEqual(
    triageMarkerPersistenceExpectation('Bucket daily sito: #9102 e bucket daily corpus: #1590').buckets,
    [9102, 1590],
  );
  assert.deepEqual(
    triageMarkerPersistenceExpectation('- Il finding e\' nel bucket collecting #9182; Sources aggiornata con PR #1593.').buckets,
    [9182],
  );
});

/* ── FU-2026-09-24-009 ─────────────────────────────────────────────────── */

const QUOTED_PAIR = 'nessun item per questa PR; bucket giornaliero #9508 non modificato da questa PR';

test('009: la coppia dello zero riportata come esempio non e\' un esito', () => {
  for (const body of [
    `## Post-merge follow-up triage\n\n> ${QUOTED_PAIR}.\n\nBucket daily: #9102`,
    `## Post-merge follow-up triage\n\n\`\`\`\n${QUOTED_PAIR}\n\`\`\`\nBucket daily: #9102`,
    `## Post-merge follow-up triage\n\n~~~text\n${QUOTED_PAIR}\n~~~\nBucket daily: #9102`,
    `## Post-merge follow-up triage\n\nEsempio di zero: \`${QUOTED_PAIR}\`; qui invece bucket daily #9102.`,
  ]) {
    const expectation = triageMarkerPersistenceExpectation(body);
    assert.equal(expectation.explicitZero, false, body);
    assert.equal(expectation.requiresBucket, true, body);
    assert.notEqual(verifyTriageMarkerPersistence(body, 9435, () => null), true, body);
  }
});

test('009: intestazioni dello zero e dello skip dentro codice o citazione non contano', () => {
  for (const body of [
    '## Post-merge follow-up triage\n\n```\n## Post-merge follow-up triage: zero outstanding items.\n```\nBucket daily: #9102',
    '## Post-merge follow-up triage\n\n> ## Post-merge follow-up triage: zero outstanding items.\n',
    '## Post-merge follow-up triage\n\n```md\n## Post-merge follow-up triage: skipped by anti-nipote gate\n```\n',
  ]) {
    const expectation = triageMarkerPersistenceExpectation(body);
    assert.equal(expectation.explicitZero, false, body);
    assert.equal(expectation.explicitAntiNipoteSkip, false, body);
    assert.equal(expectation.requiresBucket, true, body);
  }
});

test('009: lo zero reale in prosa e l\'intestazione canonica restano riconosciuti', () => {
  const prose = `## Post-merge follow-up triage\n\nCreated/updated: ${QUOTED_PAIR}.`;
  assert.equal(triageMarkerPersistenceExpectation(prose).explicitZero, true);
  const heading = '## Post-merge follow-up triage: zero outstanding items.\n\n```\nesempio\n```';
  assert.equal(triageMarkerPersistenceExpectation(heading).explicitZero, true);
  const afterFence = '## Post-merge follow-up triage\n\n```\ncodice\n```\n\n## Post-merge follow-up triage: zero outstanding items.';
  assert.equal(triageMarkerPersistenceExpectation(afterFence).explicitZero, true);
});

/* ── FU-2026-09-24-010 ─────────────────────────────────────────────────── */

const OLD = '## Post-merge follow-up triage\n\nBucket daily: #1111';
const NEW = '## Post-merge follow-up triage: zero outstanding items.';

test('010: vince il marker piu\' recente per createdAt, non l\'ultimo dell\'array', () => {
  const comments = [
    { body: NEW, createdAt: '2026-09-24T10:00:00Z' },
    { body: 'commento qualsiasi', createdAt: '2026-09-24T11:00:00Z' },
    { body: OLD, createdAt: '2026-09-20T10:00:00Z' },
  ];
  assert.equal(latestTriageCommentBody(JSON.stringify({ comments })), NEW);
  assert.equal(latestTriageCommentBody(JSON.stringify(comments)), NEW);
});

test('010: a parita\' di timestamp vince la posizione successiva', () => {
  const at = '2026-09-24T10:00:00Z';
  const comments = [{ body: OLD, createdAt: at }, { body: NEW, createdAt: at }];
  assert.equal(latestTriageCommentBody(JSON.stringify({ comments })), NEW);
});

test('010: piu\' marker con una data non verificabile → null (fail-closed)', () => {
  for (const bad of [undefined, '', 'ieri', 42]) {
    const comments = [
      { body: OLD, createdAt: '2026-09-20T10:00:00Z' },
      { body: NEW, createdAt: bad },
    ];
    assert.equal(latestTriageCommentBody(JSON.stringify({ comments })), null, String(bad));
  }
  // null come marker non e' mai una prova: la PR resta nel batch.
  assert.equal(verifyTriageMarkerPersistence(null, 1718, () => BUCKET), false);
});

test('010: un solo marker non ha ordine da decidere, anche senza data', () => {
  const comments = [{ body: 'altro' }, { body: NEW }];
  assert.equal(latestTriageCommentBody(JSON.stringify({ comments })), NEW);
  assert.equal(latestTriageCommentBody(JSON.stringify({ comments: [{ body: 'altro' }] })), null);
  assert.equal(latestTriageCommentBody('non json'), null);
});
