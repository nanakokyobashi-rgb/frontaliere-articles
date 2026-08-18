/**
 * ── UN BREAKER CHE NON PUO' MAI VEDERE 8 TENTATIVI ──────────────────────────
 *
 * Issue #432 (2026-08-18): `CLAUDE_CLI_TIMEOUT_STORM_THRESHOLD` era 8, tarato
 * sull'incidente del 29824354962 (159/162 timeout — il volume non era mai il
 * vincolo). Le run che offrono claude-cli/haiku ne fanno pero' solo 2 o 4 in
 * TUTTA la run: il contatore non arriva mai a 8, il breaker non scatta MAI a
 * quel volume, e ogni run ripaga il prezzo pieno (120s per tentativo, zero
 * byte) da capo.
 *
 * Estratto dal sorgente e non importato: la soglia e' una costante di modulo
 * non esportata, e farla scattare per davvero vorrebbe dire spawnare `claude`
 * e aspettare due minuti per tentativo — lo stesso vincolo documentato in
 * claude-cli-timeout-diagnosticabile.test.mjs.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.resolve(HERE, '../scripts/lib/ai-models.mjs'), 'utf-8');

function sogliaStorm() {
  const m = SRC.match(/const CLAUDE_CLI_TIMEOUT_STORM_THRESHOLD = (\d+);/);
  assert.ok(m, 'costante CLAUDE_CLI_TIMEOUT_STORM_THRESHOLD non trovata — aggiornare questo test');
  return Number(m[1]);
}

describe('la soglia del breaker claude-cli e\' raggiungibile dal volume reale di una run', () => {
  it('scatta entro il volume osservato in produzione (2-4 tentativi/run), non a 8', () => {
    const soglia = sogliaStorm();
    assert.ok(
      soglia <= 4,
      `soglia ${soglia}: una run che offre claude-cli/haiku solo 2-4 volte non la raggiunge mai (issue #432)`,
    );
  });

  it('non scatta su un singolo timeout transitorio — resta un breaker, non un ban al primo colpo', () => {
    const soglia = sogliaStorm();
    assert.ok(
      soglia > 1,
      'un solo timeout deve restare un blip retriabile: vedi il commento sopra _claudeCliConsecutiveTimeouts',
    );
  });

  it('il contatore si azzera a ogni successo, quindi la soglia bassa non penalizza un modello sano', () => {
    assert.ok(
      /if \(provider === PROVIDER\.CLAUDE_CLI\) _claudeCliConsecutiveTimeouts = 0;/.test(SRC),
      'il reset sul ramo di successo e\' sparito: una soglia bassa senza reset banderebbe un modello sano dopo pochi blip sparsi',
    );
  });
});
