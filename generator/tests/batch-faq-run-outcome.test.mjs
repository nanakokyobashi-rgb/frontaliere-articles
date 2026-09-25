/**
 * batch-faq-run-outcome.test.mjs — una run di batch-faq-articles che tenta
 * lavoro e non ne produce nessuno deve uscire rossa.
 *
 * Misurato: run 35690020249 (2026-09-22) e 35958863091 (2026-09-24), entrambe
 * `success` con «Total processed: 36 / Succeeded: 0 / Failed: 36». Lo script
 * usciva 0 e `scan-failed-runs.mjs` raccoglie solo le run `failure`: nessuna
 * issue, per giorni.
 *
 * Due meta', provate in due modi, come `roster-exhaustion-red.test.mjs`:
 *   1. la DECISIONE (`faqRunOutcome`) e il suo trasporto su `$GITHUB_OUTPUT`;
 *   2. la PROPAGAZIONE nello YAML: lo step gate viene estratto dal file che
 *      gira in produzione ed eseguito con bash. L'oracolo e' il codice di
 *      uscita, non il testo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { faqRunOutcome, writeFaqRunOutcome } from '../scripts/batch-add-faq-to-articles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github/workflows/batch-faq-articles.yml'), 'utf8');
const GATE_NAME = 'Fail when every attempted FAQ article failed';

/** Il blocco di uno step (dal suo `- name:` al successivo) nel job generate-faq. */
function stepBlock(name) {
  const lines = WORKFLOW.split('\n');
  const start = lines.findIndex((line) => line === `      - name: ${name}`);
  assert.ok(start >= 0, `step «${name}» assente da batch-faq-articles.yml`);
  let end = start + 1;
  while (end < lines.length && !/^ {6}- name: /.test(lines[end]) && !/^ {0,5}\S/.test(lines[end])) end += 1;
  return lines.slice(start, end);
}

function runBlock(block) {
  const at = block.findIndex((line) => /^ {8}run: \|$/.test(line));
  assert.ok(at >= 0, 'lo step gate deve avere un run: | multilinea');
  return block.slice(at + 1).filter((line) => line.trim()).map((line) => line.replace(/^ {10}/, '')).join('\n');
}

test('faqRunOutcome: rosso solo se c\'era lavoro e non ne e\' riuscito nessuno', () => {
  assert.deepEqual(faqRunOutcome({ succeeded: 0, failed: 36 }), { processed: 36, succeeded: 0, allFailed: true });
  assert.deepEqual(faqRunOutcome({ succeeded: 1, failed: 35 }), { processed: 36, succeeded: 1, allFailed: false });
  assert.deepEqual(faqRunOutcome({ succeeded: 0, failed: 0 }), { processed: 0, succeeded: 0, allFailed: false });
  assert.deepEqual(faqRunOutcome(), { processed: 0, succeeded: 0, allFailed: false });
});

test('writeFaqRunOutcome scrive le chiavi che il workflow legge, e niente senza GITHUB_OUTPUT', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faq-outcome-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'github_output');
  assert.equal(writeFaqRunOutcome(faqRunOutcome({ succeeded: 0, failed: 36 }), out), true);
  const written = Object.fromEntries(
    fs.readFileSync(out, 'utf8').trim().split('\n').map((line) => line.split('=')),
  );
  assert.deepEqual(written, { processed: '36', succeeded: '0', all_failed: 'true' });

  // Ogni `steps.faq.outputs.<chiave>` citata dallo YAML deve essere scritta qui:
  // una chiave rinominata da un lato solo renderebbe il gate lettera morta.
  const read = new Set([...WORKFLOW.matchAll(/steps\.faq\.outputs\.(\w+)/g)].map((m) => m[1]));
  assert.ok(read.has('all_failed'));
  for (const key of read) assert.ok(key in written, `lo YAML legge steps.faq.outputs.${key}, lo script non la scrive`);

  assert.equal(writeFaqRunOutcome(faqRunOutcome({ succeeded: 0, failed: 1 }), ''), false);
});

test('lo step gate legge l\'esito dello step `faq` e sta dopo il commit', () => {
  assert.match(WORKFLOW, /- name: Run batch FAQ generation\n {8}id: faq\n/);
  const gate = stepBlock(GATE_NAME);
  assert.match(gate.join('\n'), /if: steps\.mode\.outputs\.dry != 'true' && steps\.faq\.outputs\.all_failed == 'true'/);
  assert.ok(
    WORKFLOW.indexOf(`- name: ${GATE_NAME}`) > WORKFLOW.indexOf('- name: Commit and push changes'),
    'il verdetto non deve impedire il commit di cio\' che e\' riuscito',
  );
});

test('lo step gate esce rosso con un ::error:: che nomina il conteggio', () => {
  const script = runBlock(stepBlock(GATE_NAME));
  const child = spawnSync('bash', ['-e', '-c', script], {
    encoding: 'utf8',
    env: { ...process.env, FAQ_PROCESSED: '36' },
  });
  assert.equal(child.status, 1, child.stderr || child.stdout);
  assert.match(child.stdout, /^::error::batch-faq: 0\/36 articoli riusciti/m);
});
