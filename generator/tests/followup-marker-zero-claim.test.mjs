/**
 * followup-marker-zero-claim.test.mjs — un claim di persistenza a ZERO non deve
 * dipendere dalle parole con cui è scritto.
 *
 * Misurato su questo repo il 2026-09-18, run 35403796041: la finestra fissa
 * funzionava (`collection_ok=true`, 35 candidate, `deferred_count=18`,
 * `verified_prs=4`) ma la run era rossa con `persistence_ok=false` su #1532,
 * #1534 e #1536. I marker erano CORRETTI: il triage aveva trovato candidati, li
 * aveva scartati tutti e aveva scritto un claim a zero con parole che la lista
 * di formule ammesse nel gate non conteneva. È lo stesso difetto già chiuso sul
 * sito (PR #9177) e la sua ricorrenza qui ne è la prova.
 *
 * Il discriminante è strutturale: sulla riga di claim — che il codice isolava
 * già — conta il NUMERO dichiarato, non la prosa. Il verso fail-closed resta.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  gatePreservedFollowupMatches,
  persistedBucketIssueMatches,
  triageMarkerPersistenceExpectation,
  verifyTriageMarkerPersistence,
} from '../../scripts/ci/collect-followup-batch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('accetta un claim a zero qualunque parola usi', () => {
  for (const line of [
    'Created/updated: 0 item; nessun bucket creato.',
    'Created/updated: 0 issue — nessun item nuovo aggiunto',
    'Created: 0 issue (solo live-verification batchata)',
    'Created/updated: 0 elementi, niente da persistere',
    '- Created: 0',
  ]) {
    const body = `## Post-merge follow-up triage\n\n${line}\n`;
    const expectation = triageMarkerPersistenceExpectation(body);
    assert.equal(expectation.requiresBucket, false, `claim a zero non riconosciuto: ${line}`);
    assert.equal(verifyTriageMarkerPersistence(body, 1532, undefined), true);
  }
});

test('riconosce la forma reale del marker di questo repo: `- Daily bucket: #N`', () => {
  // Marker REALE di PR #1532 (run 35403796041). Il prompt non impone un formato
  // al corpo del marker: il sito scrive `Created/updated: ... bucket #N`, qui
  // l'agent scrive `- Daily bucket: #N`. Il gate leggeva solo la prima forma,
  // e la seconda — una persistenza VERA, provata dal bucket #9182 che contiene
  // `- Sources: PR #1532` — risultava «senza riferimento a un bucket
  // persistito». Da qui `persistence_ok=false` su 3 PR su 4 con marker corretti.
  const marker = [
    '## Post-merge follow-up triage',
    '',
    '- Daily bucket: #9182 (`follow-up(daily:2026-09-19): 1 item — valerielinc-ops/frontaliere-si-o-no`)',
    '- Follow-up item: FU-2026-09-19-001',
    '- Candidate source: `## Non implementato (ancora)`, bullet `blocked:`.',
  ].join('\n');
  const expectation = triageMarkerPersistenceExpectation(marker);
  // E' un claim POSITIVO: il bucket va nominato e poi provato.
  assert.equal(expectation.requiresBucket, true);
  assert.deepEqual(expectation.buckets, [9182], 'il bucket dichiarato va estratto anche con i due punti');
});

test('la prosa che cita un bucket storico NON diventa un claim', () => {
  // La protezione che la restrizione alle righe di testa esisteva per dare:
  // un bucket nominato piu' in basso, per contesto, non e' una promessa di
  // persistenza e non deve far fallire un marker valido.
  const marker = [
    '## Post-merge follow-up triage: zero outstanding items.',
    '',
    'Nessun candidato. Per contesto, il bucket #8248 di ieri resta sealed.',
  ].join('\n');
  const expectation = triageMarkerPersistenceExpectation(marker);
  assert.deepEqual(expectation.buckets, []);
  assert.equal(expectation.requiresBucket, false);
});

test('resta fail-closed: un claim NON zero senza bucket fallisce', () => {
  const body = '## Post-merge follow-up triage\n\nCreated/updated: 3 item; bucket non nominato.\n';
  const expectation = triageMarkerPersistenceExpectation(body);
  assert.equal(expectation.requiresBucket, true);
  assert.deepEqual(expectation.buckets, []);
  assert.equal(verifyTriageMarkerPersistence(body, 1532, () => null), false);
});

test('un claim non-zero che nomina un bucket va provato sul bucket', () => {
  const body = '## Post-merge follow-up triage\n\nCreated/updated: 2 item nel bucket #1525.\n';
  const expectation = triageMarkerPersistenceExpectation(body);
  assert.equal(expectation.requiresBucket, true);
  assert.deepEqual(expectation.buckets, [1525]);
});

test('un "10" non viene letto come zero, e una riga non-zero basta', () => {
  assert.equal(
    triageMarkerPersistenceExpectation('## x\n\nCreated/updated: 10 item\n').requiresBucket,
    true,
  );
  assert.equal(
    triageMarkerPersistenceExpectation('## x\n\nCreated: 0 issue\nCreated/updated: 2 item\n').requiresBucket,
    true,
  );
});

test('la grammatica del claim e case-insensitive (divergenza fra i gemelli)', () => {
  // Il gemello JS e' `/i`; se il lato bash resta case-sensitive un marker
  // legittimo `created/updated: 0 item` non produce righe di claim e la run
  // finisce `persistence_ok=false` su un marker corretto.
  const body = '## Post-merge follow-up triage\n\ncreated/updated: 0 item; nessun bucket creato.\n';
  assert.equal(triageMarkerPersistenceExpectation(body).requiresBucket, false);
  const lower = '## Post-merge follow-up triage\n\n- daily bucket: #9182\n';
  assert.deepEqual(triageMarkerPersistenceExpectation(lower).buckets, [9182]);
});

test('una prosa con la formula legacy non scavalca un claim NON zero', () => {
  const body = [
    '## Post-merge follow-up triage',
    '',
    'Created/updated: 2 item; bucket non nominato.',
    '',
    'Nota: la run precedente aveva zero outstanding items.',
  ].join('\n');
  const expectation = triageMarkerPersistenceExpectation(body);
  assert.equal(expectation.requiresBucket, true, 'il fallback non deve valere con un claim positivo');
  assert.equal(verifyTriageMarkerPersistence(body, 1532, () => null), false);
});

test('la formula legacy resta valida senza alcuna riga di claim', () => {
  const body = '## Post-merge follow-up triage: zero outstanding items.\n\nNessun candidato.\n';
  assert.equal(triageMarkerPersistenceExpectation(body).requiresBucket, false);
});

test('un conteggio non intero non e uno zero', () => {
  assert.equal(
    triageMarkerPersistenceExpectation('## x\n\nCreated: 0.5 item\n').requiresBucket,
    true,
  );
});

test('accetta la prova del gate quando tutti gli item della PR sono stati demoti', () => {
  const bucket = {
    number: 8944,
    title: 'follow-up(daily:2026-09-17): 7 items — valerielinc-ops/frontaliere-si-o-no',
    body: 'State: sealed\n\n### FU-2026-09-17-001 — item rimasto\n- Sources: PR #1520\n',
  };
  const gateComments = JSON.stringify({ comments: [{ body: [
    '<!-- followup-mint-gate -->',
    '## Item demoti dal gate sul conio',
    'Issue #8944 resta aperta con 7 item validi.',
    '',
    '### item demoto',
    '- Source: PR #1535 / adversarial check',
  ].join('\n') }] });

  assert.equal(gatePreservedFollowupMatches(gateComments, 8944, 1535), true);
  assert.equal(persistedBucketIssueMatches(bucket, 1535, gateComments), true);
  assert.equal(
    verifyTriageMarkerPersistence(
      '## Post-merge follow-up triage\n\n- Daily bucket: #8944',
      1535,
      () => bucket,
      gateComments,
    ),
    true,
  );
});

test('la prova del gate resta fail-closed per bucket o PR diversi', () => {
  const comments = JSON.stringify({ comments: [{ body: [
    '<!-- followup-mint-gate -->',
    'Issue #8944 resta aperta con 7 item validi.',
    '- Source: PR #1535 / adversarial check',
  ].join('\n') }] });
  assert.equal(gatePreservedFollowupMatches(comments, 8943, 1535), false);
  assert.equal(gatePreservedFollowupMatches(comments, 8944, 1536), false);
});

test('piu bucket dichiarati, uno illeggibile: esito NON positivo', () => {
  const body = '## Post-merge follow-up triage\n\nCreated/updated: 2 item nei bucket #1525 e bucket #9182.\n';
  const expectation = triageMarkerPersistenceExpectation(body);
  assert.deepEqual(expectation.buckets, [1525, 9182]);
  const readIssue = (n) => (n === 1525
    ? { number: 1525, title: 'follow-up(daily:2026-09-16): 1 items — a/b', body: '### FU-2026-09-16-001\n- Sources: PR #1532\n' }
    : null);
  assert.notEqual(verifyTriageMarkerPersistence(body, 1532, readIssue), true);
});

test('il gemello bash dello YAML resta allineato', () => {
  // Regola 6 di AGENTS.md: quando i due lati non possono importarsi, il legame
  // va coperto da un test. Qui la copia bash è quella che decide il merge.
  const yml = readFileSync(path.join(ROOT, '.github/workflows/post-merge-followup.yml'), 'utf8');
  assert.doesNotMatch(yml, /nessun item nuovo aggiunto/);
  assert.doesNotMatch(yml, /solo live-verification batchata/);
  assert.match(yml, /zero_claim=true/);
  assert.match(yml, /claim_head='/);
  assert.match(yml, /grep -Ei "\$claim_head"/);
  assert.match(yml, /grep -Eqvi "\$\{claim_head\}\[\[:space:\]\]\*0\(\[\^0-9\.\]\|\\\$\)"/);
  assert.match(yml, /\[ -z "\$claim_lines" \][\s\S]{0,140}zero outstanding items\|backfill skipped/);
  assert.match(yml, /zero outstanding items\|backfill skipped/);
  assert.match(yml, /gate_preserved_for_pr\(\)/);
  assert.match(yml, /followup-mint-gate/);
  assert.match(yml, /bucket_persisted_for_pr "\$bucket" "\$pr" "\$comments"/);
});
