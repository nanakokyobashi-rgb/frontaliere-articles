/**
 * followup-marker-zero-claim.test.mjs — la persistenza del triage non deve
 * dipendere dalle PAROLE con cui il marker è scritto, né dal repository in cui
 * il bucket è finito.
 *
 * ## Perché questo file ha cambiato contratto
 *
 * Il prompt di `post-merge-followup.yml` non impone un formato al corpo del
 * marker: quella riga è prosa generata da un modello. Ogni versione precedente
 * del parser era un ELENCO di formule ammesse, ed è stata superata dalla
 * variante successiva quattro volte in tre giorni:
 *
 *   2026-09-17  `- Daily bucket: #8944 (...)`   → aggiunta al parser
 *   2026-09-18  `Created/updated: 0 item; ...`  → aggiunto il claim a zero
 *   2026-09-18  `Bucket daily: #9102 — ...`     → NON riconosciuta
 *   2026-09-19  `- Daily bucket: nessuno.`      → NON riconosciuta
 *
 * Misurato sulla run 35430183038 (schedule, 07:45Z): le ultime due varianti
 * hanno bloccato TUTTE le 11 PR triagiate della finestra — `deferred_count=17`,
 * le stesse 4 PR più vecchie ri-triagiate ogni 3 ore come no-op, otto run rosse
 * consecutive. Un allowlist di sinonimi non è un cursore durevole.
 *
 * Il discriminante ora è STRUTTURALE e non nomina nessun verbo: un ITEM è una
 * riga `Follow-up item: FU-YYYY-MM-DD-NNN` (l'unico formato che il prompt
 * impone davvero, ed è lo stesso ID che finisce nel bucket), un BUCKET è un
 * `#N` su una riga che dice «bucket». Il verso fail-closed resta: senza
 * NESSUNA prova durevole la PR torna nel batch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  gatePreservedFollowupMatches,
  persistedBucketIssueMatches,
  readBucketIssue,
  triageMarkerPersistenceExpectation,
  verifyTriageMarkerPersistence,
} from '../../scripts/ci/collect-followup-batch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Bucket reale #9102 (sito): contiene davvero `- Sources: ... PR #1563`. */
const SITE_BUCKET = {
  number: 9102,
  title: 'follow-up(daily:2026-09-18): 13 items — valerielinc-ops/frontaliere-si-o-no',
  body: [
    '## Item',
    '',
    '### FU-2026-09-18-011 — bridge recovery cross-repo sulla head',
    '- State: open',
    '- Sources: PR #1563',
  ].join('\n'),
};

/* ── Le quattro formule reali, una per riga di storia ───────────────────── */

test('le quattro formule reali del marker sono tutte riconosciute', () => {
  // Ogni voce è il marker VERBATIM di una PR che la run 35430183038 ha
  // lasciato bloccata (o che una versione precedente del parser aveva
  // sbloccato). Nessuna di queste righe deve piu' dipendere dal suo verbo.
  const cases = [
    // PR #1535, 2026-09-17 — riconosciuta dal parser precedente
    ['- Daily bucket: #8944 (`follow-up(daily:2026-09-17): 10 items — valerielinc-ops/frontaliere-si-o-no`)\n- Follow-up item: FU-2026-09-17-005', [8944], 1],
    // PR #1563, 2026-09-18 — NON riconosciuta: «Bucket daily», non «Daily bucket»
    ['Bucket daily: #9102 — `daily:2026-09-18` (Europe/Zurich), State: collecting.\n- Follow-up item: FU-2026-09-18-011', [9102], 1],
    // forma del sito, mai rimossa dal contratto
    ['Created/updated: 1 issue nel bucket #9182\n- Follow-up item: FU-2026-09-19-001', [9182], 1],
    // PR #1549 — tre item dichiarati sullo stesso bucket
    ['Bucket daily: #9102 — repository target sito.\n- Follow-up item: FU-2026-09-18-008\n- Follow-up item: FU-2026-09-18-009\n- Follow-up item: FU-2026-09-18-010', [9102], 3],
  ];
  for (const [line, buckets, items] of cases) {
    const expectation = triageMarkerPersistenceExpectation(`## Post-merge follow-up triage\n\n${line}\n`);
    assert.deepEqual(expectation.buckets, buckets, `bucket non estratto da: ${line.split('\n')[0]}`);
    assert.equal(expectation.items.length, items, `item non contati in: ${line.split('\n')[0]}`);
    assert.equal(expectation.requiresBucket, true);
  }
});

test('un marker senza niente di dichiarato non promette niente da verificare', () => {
  // PR #1537, marker REALE: `- Daily bucket: nessuno.` con zero item. Il parser
  // precedente lo leggeva come una riga di claim (quindi «positivo») e poi non
  // trovava nessun `#N`: «senza riferimento a un bucket persistito», run rossa
  // su un marker corretto. Nessun item + nessun bucket = niente da provare.
  const marker = [
    '## Post-merge follow-up triage: zero outstanding items.',
    '',
    '- Daily bucket: nessuno.',
    '- PR #1537: `## Non implementato (ancora)` contiene `Nessuno`.',
  ].join('\n');
  const expectation = triageMarkerPersistenceExpectation(marker);
  assert.deepEqual(expectation.buckets, [], '«nessuno» non è un numero di bucket');
  assert.equal(expectation.items.length, 0);
  assert.equal(expectation.requiresBucket, false);
  assert.equal(verifyTriageMarkerPersistence(marker, 1537, () => null), true);
});

test('un `#N` fuori da una riga di bucket non diventa un candidato', () => {
  // Marker REALE di PR #1563: fra i drop cita `PR concatenata #9050`. Quel
  // numero non è un bucket, e trattarlo come tale aggiungeva una lettura
  // inutile per ogni riga di prosa del marker.
  const marker = [
    '## Post-merge follow-up triage',
    '',
    'Bucket daily: #9102 — State: collecting.',
    '- Follow-up item: FU-2026-09-18-011',
    '',
    'Drop motivati:',
    '- l’adattamento site-side è dichiarato `PR concatenata #9050`.',
  ].join('\n');
  assert.deepEqual(triageMarkerPersistenceExpectation(marker).buckets, [9102]);
});

/* ── Il verso fail-closed ───────────────────────────────────────────────── */

test('fail-closed: item dichiarati senza nessun bucket nominato', () => {
  const body = '## Post-merge follow-up triage\n\n- Follow-up item: FU-2026-09-19-001\n';
  const expectation = triageMarkerPersistenceExpectation(body);
  assert.equal(expectation.requiresBucket, true);
  assert.deepEqual(expectation.buckets, []);
  assert.equal(verifyTriageMarkerPersistence(body, 1532, () => SITE_BUCKET), false);
});

test('fail-closed: bucket nominato ma nessuna prova dentro il bucket', () => {
  const body = '## Post-merge follow-up triage\n\nBucket daily: #9102\n- Follow-up item: FU-2026-09-18-011\n';
  // #9102 esiste ma non nomina PR #1999 in nessun `Sources`.
  assert.equal(verifyTriageMarkerPersistence(body, 1999, () => SITE_BUCKET), false);
});

test('una lettura indisponibile resta `null`, mai `false`', () => {
  // `null` tiene la PR nel batch per il retry; `false` la dichiarerebbe non
  // persistita per un guasto API. I due esiti non sono intercambiabili.
  const body = '## Post-merge follow-up triage\n\nBucket daily: #9102\n- Follow-up item: FU-2026-09-18-011\n';
  assert.equal(verifyTriageMarkerPersistence(body, 1563, () => null), null);
});

/* ── La verifica è esistenziale, non universale ─────────────────────────── */

test('un bucket citato per contesto non fa cadere un marker che ne prova un altro', () => {
  // Era il difetto opposto: con la verifica UNIVERSALE ogni riga di prosa che
  // nominasse un bucket storico diventava un modo di bocciare un marker giusto.
  const body = [
    '## Post-merge follow-up triage',
    '',
    'Bucket daily: #9102 — State: collecting.',
    '- Follow-up item: FU-2026-09-18-011',
    '',
    'Nessun nuovo bucket: il bucket collecting storico #8944 copre la stessa finestra.',
  ].join('\n');
  assert.deepEqual(triageMarkerPersistenceExpectation(body).buckets, [9102, 8944]);
  const readIssue = (n) => (n === 9102 ? SITE_BUCKET : false);
  assert.equal(verifyTriageMarkerPersistence(body, 1563, readIssue), true);
});

test('nessun riferimento provato: esito NON positivo', () => {
  const body = '## Post-merge follow-up triage\n\nBucket daily: #1525 e bucket #9102.\n- Follow-up item: FU-2026-09-16-001\n';
  assert.notEqual(verifyTriageMarkerPersistence(body, 1532, () => false), true);
});

/* ── La lettura cross-repo del bucket ──────────────────────────────────── */

test('il bucket del sito viene trovato anche quando `GH_REPO` è il corpus', () => {
  // È il difetto misurato: un item del corpus con target un file del sito conia
  // NEL SITO, e il marker della PR corpus cita quel numero. Leggendo solo
  // `GH_REPO`, `gh` risponde «Could not resolve to an issue with the number
  // 9102» → `null` → «lettura indisponibile» su OGNI bucket cross-repo. Quattro
  // delle 11 PR bloccate nella run 35430183038 sono esattamente questo caso.
  const calls = [];
  const fakeGh = (args) => {
    const repo = args[args.indexOf('--repo') + 1];
    calls.push(repo);
    if (repo.startsWith('nanakokyobashi-rgb')) return null; // 404, come nella run reale
    return JSON.stringify(SITE_BUCKET);
  };
  const issue = readBucketIssue(9102, fakeGh, ['nanakokyobashi-rgb/frontaliere-articles', 'valerielinc-ops/frontaliere-si-o-no']);
  assert.equal(issue?.number, 9102, 'il bucket del sito deve essere leggibile dal corpus');
  assert.deepEqual(calls, ['nanakokyobashi-rgb/frontaliere-articles', 'valerielinc-ops/frontaliere-si-o-no']);
});

test('una issue omonima nel primo repository non nasconde il bucket vero nel secondo', () => {
  // I due repository numerano le proprie issue in modo indipendente: oggi il
  // corpus e' a #1594 e il sito a #9217, quindi i bucket citati dai marker del
  // corpus sono ancora fuori dalla portata del corpus — ma la collisione ha una
  // data d'arrivo. Fermarsi al primo JSON valido restituirebbe l'omonima.
  const homonym = { number: 9102, title: 'fix: qualcosa di non correlato', body: 'niente bucket qui' };
  const fakeGh = (args) => {
    const repo = args[args.indexOf('--repo') + 1];
    return JSON.stringify(repo.startsWith('nanakokyobashi-rgb') ? homonym : SITE_BUCKET);
  };
  const repos = ['nanakokyobashi-rgb/frontaliere-articles', 'valerielinc-ops/frontaliere-si-o-no'];
  const issue = readBucketIssue(9102, fakeGh, repos);
  assert.equal(issue?.title, SITE_BUCKET.title, 'deve vincere il bucket giornaliero, non l’omonima');

  const body = '## Post-merge follow-up triage\n\nBucket daily: #9102\n- Follow-up item: FU-2026-09-18-011';
  assert.equal(
    verifyTriageMarkerPersistence(body, 1563, (b) => readBucketIssue(b, fakeGh, repos)),
    true,
  );
});

test('un bucket illeggibile in ogni repository non falsifica gli altri riferimenti', () => {
  // `gh` non distingue un 404 da un guasto, quindi un numero introvabile resta
  // `null` = «non lo so» e da solo tiene la PR nel batch. Ma con la verifica
  // esistenziale non può più far cadere un marker il cui ALTRO riferimento è
  // provato: è la combinazione che sblocca le PR reali #1535/#1540/#1544, dove
  // il bucket citato vive nel sito e non nel repository del run.
  const reads = [];
  const fakeGh = (args) => {
    const num = args[2];
    const repo = args[args.indexOf('--repo') + 1];
    reads.push(`${repo}#${num}`);
    if (num === '9102' && repo.startsWith('valerielinc-ops')) return JSON.stringify(SITE_BUCKET);
    return null; // introvabile o guasto: indistinguibili da `gh`
  };
  const repos = ['nanakokyobashi-rgb/frontaliere-articles', 'valerielinc-ops/frontaliere-si-o-no'];
  assert.equal(readBucketIssue(4242, fakeGh, repos), null, 'introvabile ovunque → `null`');

  const body = '## Post-merge follow-up triage\n\nBucket daily: #4242 e bucket #9102.\n- Follow-up item: FU-2026-09-18-011';
  assert.equal(
    verifyTriageMarkerPersistence(body, 1563, (b) => readBucketIssue(b, fakeGh, repos)),
    true,
    'un riferimento introvabile non deve annullare quello provato',
  );
});

/* ── La prova per gli item demoti dal gate sul conio ───────────────────── */

test('accetta la prova del gate quando tutti gli item della PR sono stati demoti', () => {
  const bucket = {
    number: 8944,
    title: 'follow-up(daily:2026-09-17): 5 items — valerielinc-ops/frontaliere-si-o-no',
    body: 'State: sealed\n\n### FU-2026-09-17-001 — item rimasto\n- Sources: PR #1520\n',
  };
  const gateComments = JSON.stringify({ comments: [{ body: [
    '<!-- followup-mint-gate -->',
    '## Item demoti dal gate sul conio',
    'Issue #8944 resta aperta con 5 item validi.',
    '',
    '### item demoto',
    '- Sources: PR #1535',
  ].join('\n') }] });

  assert.equal(gatePreservedFollowupMatches(gateComments, 8944, 1535), true);
  assert.equal(persistedBucketIssueMatches(bucket, 1535, gateComments), true);
  assert.equal(
    verifyTriageMarkerPersistence(
      '## Post-merge follow-up triage\n\n- Daily bucket: #8944\n- Follow-up item: FU-2026-09-17-005',
      1535,
      () => bucket,
      gateComments,
    ),
    true,
    'il gate demota gli item e cancella il loro `Sources`: la prova resta il suo commento',
  );
});

test('la prova del gate resta fail-closed per bucket o PR diversi', () => {
  const comments = JSON.stringify({ comments: [{ body: [
    '<!-- followup-mint-gate -->',
    'Issue #8944 resta aperta con 7 item validi.',
    '- Sources: PR #1535',
  ].join('\n') }] });
  assert.equal(gatePreservedFollowupMatches(comments, 8943, 1535), false);
  assert.equal(gatePreservedFollowupMatches(comments, 8944, 1536), false);
});

/* ── Il gemello bash non esiste più ─────────────────────────────────────── */

test('lo step del workflow INVOCA il predicato invece di riscriverlo', () => {
  // Regola 6 di AGENTS.md chiedeva un test che legasse le due copie. Il legame
  // ora è più forte del test: la copia bash è stata cancellata. Nella run
  // 35430183038 le due copie erano divergenti in entrambi i versi — la bash
  // leggeva il bucket cross-repo ma non conosceva la prova del gate, il JS
  // conosceva la prova ma leggeva solo `GH_REPO` — e ciascuna bocciava le PR
  // che l'altra avrebbe promosso. Questo test difende l'unicità del predicato.
  const yml = readFileSync(path.join(ROOT, '.github/workflows/post-merge-followup.yml'), 'utf8');
  assert.match(yml, /--verify-persistence "\$csv"/, 'lo step deve invocare il predicato unico');
  for (const reimplementation of [
    /bucket_persisted_for_pr/,
    /gate_preserved_for_pr/,
    /claim_head=/,
    /zero_claim=/,
    /bucket_refs=/,
  ]) {
    assert.doesNotMatch(yml, reimplementation, `riscrittura bash del predicato: ${reimplementation}`);
  }
  // I due repository in cui può vivere un bucket devono raggiungere lo script.
  assert.match(yml, /FOLLOWUP_SITE_REPO: valerielinc-ops\/frontaliere-si-o-no/);
  assert.match(yml, /FOLLOWUP_CORPUS_REPO: nanakokyobashi-rgb\/frontaliere-articles/);
});
