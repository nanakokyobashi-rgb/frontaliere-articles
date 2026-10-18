import '../../host/cantonSectionsBootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const ENGINE = fs.readFileSync(new URL('../../engine/shared/generatedImageEngine.mjs', import.meta.url), 'utf8');

test('il rejection error conserva i flag vision booleani nel ledger provider', () => {
  assert.match(ENGINE, /export function imageVisionRejectionError\(verdict\)[\s\S]*?error\.code = 'IMAGE_VISION_REJECTED';[\s\S]*?error\.vision = structuredVisionFailure\(verdict\);/);
  assert.match(ENGINE, /error\?\.code === 'IMAGE_VISION_REJECTED'[\s\S]*?\? \{ vision: structuredVisionFailure\(error\.vision\) \}/);
});

test('il ledger prova completezza solo dopo l esaurimento della catena richiesta', () => {
  assert.match(ENGINE, /const attemptLimit = Number\.isInteger\(maxAttempts\)[\s\S]*?Math\.min\(maxAttempts, sequence\.length\)[\s\S]*?: sequence\.length;/);
  assert.match(ENGINE, /for \(let attempt = 0; attempt < attemptLimit; attempt\+\+\)[\s\S]*?attemptedProviders\.push\(selectedProvider\);/);
  assert.match(ENGINE, /error\.imageProviderLedger = \{[\s\S]*?schema: 1,[\s\S]*?complete: attemptedProviders\.length === sequence\.length,[\s\S]*?expectedProviders: \[\.\.\.sequence\],[\s\S]*?attemptedProviders: \[\.\.\.attemptedProviders\],[\s\S]*?\};/);
});
