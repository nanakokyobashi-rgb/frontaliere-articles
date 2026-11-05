/**
 * loop-drift-fetch-concurrency.test.mjs — il report cross-repo non deve
 * serializzare centinaia di letture indipendenti fino al timeout del job.
 *
 * La rete reale non entra nella suite: si prova il worker pool puro e si
 * pinna che entrambe le fasi della passata normale lo usino. Il limite interno
 * del walk storico resta invece responsabilità di `repoHistoryMatch()`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapWithConcurrency } from '../../scripts/ci/loop-drift-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHECKER = fs.readFileSync(path.join(ROOT, 'scripts/ci/loop-drift-check.mjs'), 'utf8');

test('il mapper bounded conserva l’ordine senza superare il limite di worker', async () => {
  let active = 0;
  let maximum = 0;
  const values = await mapWithConcurrency([40, 5, 25, 1, 15], 2, async (delay, index) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active -= 1;
    return `${index}:${delay}`;
  });

  assert.equal(maximum, 2);
  assert.deepEqual(values, ['0:40', '1:5', '2:25', '3:1', '4:15']);
});

test('la passata normale usa pool bounded sia per le entry sia per la provenienza', () => {
  assert.match(
    CHECKER,
    /mapWithConcurrency\(entries, DRIFT_ENTRY_CONCURRENCY, async \(entry\)/,
    'le letture raw del manifest non devono tornare seriali',
  );
  assert.match(
    CHECKER,
    /mapWithConcurrency\(entries, PROVENANCE_ENTRY_CONCURRENCY, async \(entry\)/,
    'i walk storici per entry non devono tornare seriali',
  );
});
