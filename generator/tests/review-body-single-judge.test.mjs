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
