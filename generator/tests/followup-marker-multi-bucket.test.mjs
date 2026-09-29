/**
 * followup-marker-multi-bucket.test.mjs — il marker di triage su due
 * repository: conteggio in testa e un bucket per bullet, SENZA la parola
 * «bucket» (marker reali delle PR del sito #10015 e #10050, run del sito
 * 36461728260, 36495756021, 36520419253). `bucketReferencesOnLine` richiedeva
 * «bucket» sulla riga: il marker non citava nessun bucket, la verifica restava
 * rossa a ogni run e il collector rimetteva la PR nel batch senza convergere.
 *
 * Copre anche la rete di sicurezza: un verdetto definitivo `false` su un
 * marker di oltre 6 ore esce dal batch come quarantena visibile.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  dailyTagBucketReferences,
  latestTriageComment,
  latestTriageCommentBody,
  markerIdempotencyDecision,
  MARKER_QUARANTINE_AFTER_MS,
  quarantineReason,
  QUARANTINE_ALARM_TITLE,
  reportQuarantinedMarkers,
  triageMarkerPersistenceExpectation,
  unreportedQuarantine,
  verifyTriageMarkerPersistence,
} from '../../scripts/ci/collect-followup-batch.mjs';
import { triageMarkerCitesBucket } from '../../scripts/ci/gate-minted-followups.mjs';

// Marker, commento del gate e blocchi item dei bucket REALI, parola per parola.
const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/followup-multi-bucket-markers.json', import.meta.url),
  'utf8',
));
const commentsOf = (pr) => JSON.stringify({ comments: fixture.prs[pr].comments });
const markerOf = (pr) => latestTriageCommentBody(commentsOf(pr));
const corpusBucket = fixture.buckets['nanakokyobashi-rgb/frontaliere-articles#1957'];
const siteBucket = fixture.buckets['valerielinc-ops/frontaliere-si-o-no#10171'];
// Come readBucketIssue: ogni numero letto in ENTRAMBI i repository.
const readBoth = (bucket) => ({
  candidates: [corpusBucket, siteBucket].filter((issue) => issue.number === bucket),
  unreadable: true,
});

test('trova corpus #1957 e sito #10171 nei bullet col tag daily', () => {
  assert.deepEqual(triageMarkerPersistenceExpectation(markerOf('10015')).buckets, [1957, 10171]);
  assert.deepEqual(triageMarkerPersistenceExpectation(markerOf('10050')).buckets, [1957]);
  assert.equal(triageMarkerPersistenceExpectation(markerOf('10015')).requiresBucket, true);
});

test('prova la persistenza reale, anche per l item demotato dal gate (#10050)', () => {
  assert.equal(verifyTriageMarkerPersistence(markerOf('10015'), 10015, readBoth, commentsOf('10015')), true);
  assert.equal(verifyTriageMarkerPersistence(markerOf('10050'), 10050, readBoth, commentsOf('10050')), true);
  // Ogni bucket dichiarato va provato.
  const onlyCorpus = (bucket) => (bucket === 1957 ? corpusBucket : false);
  assert.equal(verifyTriageMarkerPersistence(markerOf('10015'), 10015, onlyCorpus, commentsOf('10015')), false);
});

test('il tag si lega al #N piu vicino e mai a una PR', () => {
  assert.deepEqual(dailyTagBucketReferences('- Site #10171 `follow-up(daily:2026-09-28)` — x'), [10171]);
  assert.deepEqual(dailyTagBucketReferences('- PR #10015 → #1957 `follow-up(daily:2026-09-28)`'), [1957]);
  assert.deepEqual(dailyTagBucketReferences('- PR #1957 `follow-up(daily:2026-09-28)`'), []);
  assert.deepEqual(dailyTagBucketReferences('- Corpus #1957 senza tag'), []);
});

test('la forma canonica a piu bucket di FOLLOWUP.md e letta riga per riga', () => {
  const contract = readFileSync(new URL('../../FOLLOWUP.md', import.meta.url), 'utf8');
  const template = /Created\/updated: daily bucket #<id-corpus>[\s\S]*?<item one-line>\nCreated\/updated: daily bucket #<id-sito>[^\n]*\n- <item one-line>/.exec(contract);
  assert.ok(template, 'forma canonica a piu bucket assente da FOLLOWUP.md');
  const marker = '## Post-merge follow-up triage\n\n' + template[0]
    .replace('<id-corpus>', '1957')
    .replace('<id-sito>', '10171')
    .replaceAll('<YYYY-MM-DD>', '2026-09-28');
  assert.deepEqual(triageMarkerPersistenceExpectation(marker).buckets, [1957, 10171]);
  assert.equal(verifyTriageMarkerPersistence(marker, 10015, readBoth), true);
});

test('il gate sul conio qualifica la PR sorgente anche dal marker a bullet', () => {
  assert.equal(triageMarkerCitesBucket(commentsOf('10050'), 1957), true);
  assert.equal(triageMarkerCitesBucket(commentsOf('10050'), 10050), false);
});

test('quarantena: false e vecchio → quarantena; false e recente → retry; null → retry', () => {
  const at = latestTriageComment(commentsOf('10015')).at;
  const HOUR = 3600_000;
  assert.equal(MARKER_QUARANTINE_AFTER_MS, 6 * HOUR);
  assert.equal(markerIdempotencyDecision(false, at, at + 6 * HOUR + 1), 'quarantine');
  assert.equal(markerIdempotencyDecision(false, at, at + 6 * HOUR), 'retry');
  assert.equal(markerIdempotencyDecision(false, at, at + HOUR), 'retry');
  assert.equal(markerIdempotencyDecision(null, at, at + 30 * HOUR), 'retry');
  assert.equal(markerIdempotencyDecision(false, Number.NaN, at + 30 * HOUR), 'retry');
  assert.equal(markerIdempotencyDecision(false, undefined, at + 30 * HOUR), 'retry');
  assert.equal(markerIdempotencyDecision(true, at, at + 30 * HOUR), 'skip');
  assert.match(quarantineReason('## Post-merge follow-up triage\nCreated/updated: 2 item.'), /senza riferimento a un bucket persistito/);
});

test('allarme: github-issue-creator, un solo commento per PR, niente scrittura alla cieca', async () => {
  const quarantined = [{ number: 10015, reason: 'r1' }, { number: 10050, reason: 'r2' }];
  const issues = JSON.stringify([
    { number: 1, title: QUARANTINE_ALARM_TITLE, body: '- PR #10015: r1.', comments: [] },
    { number: 2, title: 'altro titolo', body: '- PR #10050', comments: [] },
  ]);
  assert.deepEqual(unreportedQuarantine(quarantined, issues), [{ number: 10050, reason: 'r2' }]);
  assert.equal(unreportedQuarantine(quarantined, 'not json'), null);
  const created = [];
  const createIssue = async (options) => { created.push(options); return { number: 1, persisted: true }; };
  const log = () => {};
  assert.deepEqual((await reportQuarantinedMarkers(quarantined, { listIssues: () => issues, createIssue, log })).reported, [10050]);
  assert.equal(created.length, 1);
  assert.equal(created[0].title, QUARANTINE_ALARM_TITLE);
  assert.match(created[0].description, /- PR #10050: r2\./);
  assert.doesNotMatch(created[0].description, /PR #10015/);
  const reported = JSON.stringify([
    { title: QUARANTINE_ALARM_TITLE, body: '- PR #10015: r1.', comments: [{ body: '- PR #10050: r2.' }] },
  ]);
  assert.deepEqual((await reportQuarantinedMarkers(quarantined, { listIssues: () => reported, createIssue, log })).reported, []);
  assert.equal((await reportQuarantinedMarkers(quarantined, { listIssues: () => null, createIssue, log })).unverifiable, true);
  assert.equal(created.length, 1);
});
