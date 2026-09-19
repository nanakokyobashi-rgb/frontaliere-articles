/**
 * Il contratto deterministico del body e' l'UNICO giudice del body
 * (trasporto adattato del sito valerielinc-ops/frontaliere-si-o-no#9308).
 *
 * Misura che ha aperto la classe sul sito: 37 dei 187 🔴 (20%) erano sul body
 * della PR mentre lo step `PR-body completeness` era verde. Su questo repo il
 * sintomo e' lo stesso e costa un giro di review intero: la voce chiusa con
 * uno stato che il contratto accetta viene riaperta dal modello, il fixer
 * declina perche' non c'e' niente da riparare, e il cap dei round porta la PR
 * su `needs-human` con la diagnosi sbagliata.
 *
 * Il declassamento e' STRETTO per costruzione, e questi test difendono i
 * confini, non la riga: senza il body della PR non si declassa (non c'e'
 * prova che l'anchor cada dentro `## Non implementato`), una citazione di file
 * lo disattiva (non e' piu' un finding sul solo body), e un claim di
 * performance resta bloccante perche' e' una regola della review, non del
 * contratto. Il quarto test copre la trappola propria di QUESTO repo: qui
 * l'approvazione «tutti i finding fuori dal diff» pretende anche una
 * follow-up coniata, e una PR i cui unici 🔴 sono sul body non ne ha nessuna
 * da coniare.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bodyContractIsGreen,
  classifyImportantFindings,
  isContractDomainBodyFinding,
  importantFindings,
  prBodyFindingLine,
} from '../../scripts/ci/review-scope.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const PR_BODY = [
  '## Implementato',                                             // 1
  '- Fa una cosa.',                                              // 2
  '',                                                            // 3
  '## Non implementato (ancora)',                                // 4
  '- Cosa X: `blocked: configurazione owner-only`. **Motivo:** y. **Prossimo passo:** z.', // 5
  '- Cosa Y: `per scelta`. **Motivo:** y. **Prossimo passo:** z.', // 6
].join('\n');

const bodyFinding = (anchor, text) => [
  '## Findings (Important: 1)',
  `\`${anchor}\`: 🔴 Important: ${text}`,
].join('\n');

test('un 🔴 sul body cade quando il contratto deterministico e\' verde', () => {
  const review = bodyFinding('PR body:L5', 'la voce non dichiara uno stato accettabile.');
  const blocking = classifyImportantFindings(review, ['scripts/ci/review-scope.mjs']);
  assert.equal(blocking.blocking, true, 'senza il verdetto del contratto il finding deve restare bloccante');
  assert.equal(blocking.bodyDeclassified.length, 0);

  const declassified = classifyImportantFindings(review, ['scripts/ci/review-scope.mjs'], null, {
    bodyContractPassed: true,
    prBody: PR_BODY,
  });
  assert.equal(declassified.bodyDeclassified.length, 1, 'il contratto verde deve declassare il finding sul body');
  assert.equal(declassified.blocking, false);
  assert.equal(declassified.unresolved.length, 0);
  assert.equal(declassified.outsideOnly, true,
    'un finding declassato non lascia la PR senza una via di approvazione');
});

test('il declassamento non si concede senza la prova della posizione', () => {
  const review = bodyFinding('PR body:L5', 'la voce non dichiara uno stato accettabile.');
  // Body non leggibile: nessun declassamento, il finding resta bloccante.
  const noBody = classifyImportantFindings(review, ['scripts/ci/review-scope.mjs'], null, {
    bodyContractPassed: true,
    prBody: null,
  });
  assert.equal(noBody.bodyDeclassified.length, 0);
  assert.equal(noBody.blocking, true);

  // Riga FUORI da `## Non implementato`: il contratto non giudica quella
  // sezione riga per riga, quindi il 🔴 resta.
  const inImplementato = classifyImportantFindings(
    bodyFinding('PR body:L2', 'la voce Implementato non corrisponde al diff.'),
    ['scripts/ci/review-scope.mjs'], null, { bodyContractPassed: true, prBody: PR_BODY },
  );
  assert.equal(inImplementato.bodyDeclassified.length, 0);
  assert.equal(inImplementato.blocking, true);

  // Riga oltre la fine del body: posizione non provabile.
  const outOfRange = classifyImportantFindings(
    bodyFinding('PR body:L99', 'voce senza stato.'),
    ['scripts/ci/review-scope.mjs'], null, { bodyContractPassed: true, prBody: PR_BODY },
  );
  assert.equal(outOfRange.bodyDeclassified.length, 0);
  assert.equal(outOfRange.blocking, true);
});

test('un claim di performance sul body resta 🔴 (regola della review, non del contratto)', () => {
  const review = bodyFinding('PR body:L5',
    'lo speedup dichiarato non porta una misura baseline pre/post.');
  const result = classifyImportantFindings(review, ['scripts/ci/review-scope.mjs'], null, {
    bodyContractPassed: true,
    prBody: PR_BODY,
  });
  assert.equal(result.bodyDeclassified.length, 0,
    'REVIEW.md punto 7 non e\' una regola del contratto: il contratto verde non la chiude');
  assert.equal(result.blocking, true);
});

test('un finding che cita un file non e\' un finding sul solo body', () => {
  const review = [
    '## Findings (Important: 1)',
    '`PR body:L5`: 🔴 Important: la voce non copre `scripts/ci/review-scope.mjs:169`.',
  ].join('\n');
  const findings = importantFindings(review);
  assert.equal(findings.length, 1);
  assert.ok(findings[0].citations.length > 0, 'il finding cita un file');
  assert.equal(isContractDomainBodyFinding(findings[0], PR_BODY), true,
    'il predicato da solo guarda solo l\'anchor');
  const result = classifyImportantFindings(review, ['scripts/ci/review-scope.mjs'], null, {
    bodyContractPassed: true,
    prBody: PR_BODY,
  });
  assert.equal(result.bodyDeclassified.length, 0,
    'con una citazione di file il finding va classificato sul diff, non declassato');
  assert.equal(result.inScope.length, 1);
  assert.equal(result.blocking, true);
});

test('prBodyFindingLine legge l\'anchor dal testo e dalla riga del marker', () => {
  assert.equal(prBodyFindingLine({ text: '`PR body:L12`: 🔴 Important: x' }), 12);
  assert.equal(prBodyFindingLine({ text: '- PR body#L7 — nota' }), 7);
  assert.equal(prBodyFindingLine({ line: 'qualcosa `PR body:L3` in mezzo', text: 'no anchor here' }), 3);
  assert.equal(prBodyFindingLine({ text: 'nessun anchor' }), null);
  assert.equal(prBodyFindingLine({ text: '`PR body:L0`' }), null, 'L0 non e\' una riga valida');
});

test('il gate porta il verdetto del contratto e non pretende una follow-up che non esiste', () => {
  const gate = read('scripts/ci/review-gate.mjs');
  assert.match(gate, /BODY_CONTRACT_PASSED = process\.env\.BODY_CONTRACT_OUTCOME === 'success'/u,
    'review-gate.mjs deve leggere il verdetto del contratto dall\'env');
  assert.match(gate, /bodyContractPassed: BODY_CONTRACT_PASSED/u,
    'il verdetto deve arrivare al classificatore');
  assert.match(gate, /DECLASSIFIED-BODY/u, 'il declassamento deve lasciare una traccia nel log');
  // La trappola del corpus: `outsideOnly` da solo non approvava, perche' qui
  // l'approvazione pretende anche `minted`. Senza questa congiunzione una PR
  // i cui unici 🔴 sono sul body resterebbe rossa pur essendo stata assolta.
  assert.match(gate, /\(scope\?\.outside\?\.length \?\? 0\) === 0 \|\| scope\?\.minted/u,
    'il conio della follow-up va preteso solo quando ci sono finding fuori dal diff');

  const workflow = read('.github/workflows/tests.yml');
  assert.match(workflow, /BODY_CONTRACT_OUTCOME: \$\{\{ steps\.body_contract\.outcome \}\}/u,
    'tests.yml deve esportare l\'esito del contratto');
  assert.ok(workflow.includes('## Deterministic body contract'),
    'il bundle deve portare il verdetto del contratto al reviewer');
  assert.ok(workflow.includes('PR body: una sola fonte di verita\''),
    'il prompt deve dire al reviewer che il contratto verde chiude il body');
  assert.ok(read('REVIEW.md').includes('Una sola fonte di verita\' sul body'),
    'REVIEW.md deve documentare la regola: e\' il file che il reviewer legge');
});

test('il claim di performance resta 🔴 anche con parole che il primo filtro non vedeva', () => {
  // Il filtro iniziale conosceva solo baseline/perf/misura: `throughput`,
  // `latency`, `benchmark`, `faster` passavano e un claim senza baseline
  // veniva declassato, violando il punto 7 di REVIEW.md. Finding della review
  // su #1629.
  for (const word of ['throughput', 'latency', 'benchmark', 'faster', 'p95', 'overhead']) {
    const result = classifyImportantFindings(
      bodyFinding('PR body:L5', `la voce promette ${word} migliore senza una misura.`),
      ['scripts/ci/review-scope.mjs'], null, { bodyContractPassed: true, prBody: PR_BODY },
    );
    assert.equal(result.bodyDeclassified.length, 0, `«${word}» non deve essere declassato`);
    assert.equal(result.blocking, true);
  }
});

test('il claim puo\' stare nella RIGA citata, non nel testo del finding', () => {
  const body = [
    '## Implementato',
    '- x',
    '',
    '## Non implementato (ancora)',
    '- Riduzione del throughput di rendering: `per scelta`. **Motivo:** y. **Prossimo passo:** z.',
  ].join('\n');
  const result = classifyImportantFindings(
    bodyFinding('PR body:L5', 'questa voce non regge.'),
    ['scripts/ci/review-scope.mjs'], null, { bodyContractPassed: true, prBody: body },
  );
  assert.equal(result.bodyDeclassified.length, 0,
    'il finding puo\' limitarsi a puntare la riga: il claim va cercato anche li\'');
});

test('un finding con DUE anchor, uno fuori sezione, non si declassa', () => {
  const review = [
    '## Findings (Important: 1)',
    '`PR body:L5`: 🔴 Important: questa voce e anche `PR body:L2` non tornano.',
  ].join('\n');
  const result = classifyImportantFindings(review, ['scripts/ci/review-scope.mjs'], null, {
    bodyContractPassed: true, prBody: PR_BODY,
  });
  assert.equal(result.bodyDeclassified.length, 0,
    'L2 sta in `## Implementato`: il contratto non giudica quella riga');
  assert.equal(result.blocking, true);
  // Due anchor entrambi dentro la sezione restano declassabili.
  const both = classifyImportantFindings(
    ['## Findings (Important: 1)',
     '`PR body:L5`: 🔴 Important: questa voce e anche `PR body:L6` non tornano.'].join('\n'),
    ['scripts/ci/review-scope.mjs'], null, { bodyContractPassed: true, prBody: PR_BODY },
  );
  assert.equal(both.bodyDeclassified.length, 1);
});

test('il verdetto del contratto si RICALCOLA dal body, per ogni consumer', () => {
  // Il fixer e la CLI di review-scope non hanno lo step `PR-body completeness`:
  // senza questa funzione applicherebbero una politica diversa sullo stesso
  // finding e brucerebbero round su lavoro che non esiste. Finding della
  // review su #1629.
  assert.equal(bodyContractIsGreen(PR_BODY), true, 'il body di prova rispetta il contratto');
  assert.equal(bodyContractIsGreen('## Implementato\n- solo questa'), false,
    'manca la seconda sezione: contratto rosso');
  assert.equal(bodyContractIsGreen(''), false);
  assert.equal(bodyContractIsGreen(null), false);
});

// Il ramo «diff non verificabile» e' il caso NORMALE qui: una PR che rigenera
// il corpus tocca migliaia di file e la lista arriva troncata o vuota. Il
// gemello del sito non ha questo ramo, quindi il declassamento va provato
// proprio li' — ed e' li' che la prima stesura sbagliava: `blocking` diventava
// false ma `outsideOnly` restava false, e `review-gate.mjs` non approvava
// comunque. Il ramo non sbloccava niente. Finding della review su #1629.
const DIFF_EMPTY_GH = `#!/usr/bin/env node
'use strict';
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({ changedFiles: 0, files: [] }));
  process.exit(0);
}
if (args[0] === 'api' && args[1].endsWith('/files')) { process.exit(0); }
if (args[0] === 'api' && /pulls\\/\\d+$/.test(args[1])) {
  process.stdout.write(JSON.stringify({ body: process.env.FAKE_PR_BODY || '' }));
  process.exit(0);
}
if (args[0] === 'api') { process.stdout.write('c'.repeat(40) + '\\n'); process.exit(0); }
process.exit(0);
`;

test('diff illeggibile: i 🔴 sul body cadono E la PR resta approvabile', { concurrency: false }, async () => {
  const os = await import('node:os');
  const { classifyAndMintReview } = await import('../../scripts/ci/review-scope.mjs');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-body-diff-'));
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'gh'), DIFF_EMPTY_GH, { mode: 0o755 });
  const previous = { PATH: process.env.PATH, FAKE_PR_BODY: process.env.FAKE_PR_BODY };
  process.env.PATH = `${binDir}${path.delimiter}${previous.PATH}`;
  process.env.FAKE_PR_BODY = PR_BODY;
  try {
    const result = await classifyAndMintReview(
      bodyFinding('PR body:L5', 'la voce non dichiara uno stato accettabile.'),
      { repo: 'o/r', pr: 42, prUrl: 'https://x/pr/42', mutate: false },
    );
    assert.equal(result.bodyDeclassified.length, 1, 'il finding sul body va declassato');
    assert.equal(result.blocking, false);
    assert.equal(result.outsideOnly, true,
      'senza outsideOnly il gate non approva: il ramo non sbloccherebbe nulla');
    assert.equal(result.minted, false, 'non c\'e\' niente fuori dal diff da tracciare');

    // Un 🔴 di CODICE nello stesso ramo resta invece bloccante.
    const mixed = await classifyAndMintReview(
      [bodyFinding('PR body:L5', 'la voce non dichiara uno stato accettabile.'),
       '`engine/x.mjs:10`: 🔴 Important: rotto.'].join('\n'),
      { repo: 'o/r', pr: 42, prUrl: 'https://x/pr/42', mutate: false },
    );
    assert.equal(mixed.bodyDeclassified.length, 1);
    assert.equal(mixed.blocking, true);
    assert.equal(mixed.outsideOnly, false);
  } finally {
    process.env.PATH = previous.PATH;
    if (previous.FAKE_PR_BODY === undefined) delete process.env.FAKE_PR_BODY;
    else process.env.FAKE_PR_BODY = previous.FAKE_PR_BODY;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('un anchor a INTERVALLO si valida riga per riga, non solo sul primo estremo', () => {
  // `PR body:L5-9` copre righe che possono uscire da `## Non implementato`:
  // tenere solo `5` declassava un finding che parla anche di quelle. Finding
  // della review incrementale su #1629.
  const body = [
    '## Implementato',              // 1
    '- Fa una cosa.',               // 2
    '',                             // 3
    '## Non implementato (ancora)', // 4
    '- Cosa X: `per scelta`. **Motivo:** y. **Prossimo passo:** z.', // 5
    '- Cosa Y: `per scelta`. **Motivo:** y. **Prossimo passo:** z.', // 6
    '',                             // 7
    '## Note',                      // 8
    '- fuori dal dominio del contratto.', // 9
  ].join('\n');
  const inRange = classifyImportantFindings(
    bodyFinding('PR body:L5-6', 'le due voci non tornano.'),
    ['scripts/ci/review-scope.mjs'], null, { bodyContractPassed: true, prBody: body },
  );
  assert.equal(inRange.bodyDeclassified.length, 1, 'un intervallo tutto dentro la sezione si declassa');

  const spanning = classifyImportantFindings(
    bodyFinding('PR body:L5-9', 'queste righe non tornano.'),
    ['scripts/ci/review-scope.mjs'], null, { bodyContractPassed: true, prBody: body },
  );
  assert.equal(spanning.bodyDeclassified.length, 0,
    'L9 sta in `## Note`: il contratto non giudica quella riga');
  assert.equal(spanning.blocking, true);

  const reversed = classifyImportantFindings(
    bodyFinding('PR body:L6-5', 'intervallo rovesciato.'),
    ['scripts/ci/review-scope.mjs'], null, { bodyContractPassed: true, prBody: body },
  );
  assert.equal(reversed.bodyDeclassified.length, 0, 'un intervallo rovesciato si rifiuta');

  const past = classifyImportantFindings(
    bodyFinding('PR body:L5-99', 'intervallo oltre la fine.'),
    ['scripts/ci/review-scope.mjs'], null, { bodyContractPassed: true, prBody: body },
  );
  assert.equal(past.bodyDeclassified.length, 0, 'una riga oltre la fine non e\' verificabile');
});
