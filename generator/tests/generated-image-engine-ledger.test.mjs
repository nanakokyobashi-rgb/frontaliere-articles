import '../../host/cantonSectionsBootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { imageVisionRejectionError } from '../../engine/shared/generatedImageEngine.mjs';
const ENGINE = fs.readFileSync(new URL('../../engine/shared/generatedImageEngine.mjs', import.meta.url), 'utf8');

test('il rejection error conserva i flag vision booleani nel ledger provider', () => {
  const error = imageVisionRejectionError({
    ok: false,
    contains_text: true,
    contains_logo: false,
    contains_recognizable_face: false,
    contains_recognizable_foreground_person: true,
    looks_like_specific_real_event: false,
    is_photograph: false,
    is_topic_relevant: true,
    notes: 'The image contains text.',
    ignored_non_boolean: 'not part of the ledger',
  });

  assert.equal(error.code, 'IMAGE_VISION_REJECTED');
  assert.deepEqual(error.vision, {
    contains_text: true,
    contains_logo: false,
    contains_recognizable_face: false,
    contains_recognizable_foreground_person: true,
    looks_like_specific_real_event: false,
    is_photograph: false,
    is_topic_relevant: true,
  });
  assert.match(ENGINE, /error\?\.code === 'IMAGE_VISION_REJECTED'[\s\S]*?\? \{ vision: structuredVisionFailure\(error\.vision\) \}/);
});

test('il ledger prova completezza solo dopo l esaurimento della catena richiesta', () => {
  assert.match(ENGINE, /const attemptLimit = Number\.isInteger\(maxAttempts\)[\s\S]*?Math\.min\(maxAttempts, sequence\.length\)[\s\S]*?: sequence\.length;/);
  assert.match(ENGINE, /providerLoop: for \(let attempt = 0; attempt < attemptLimit; attempt\+\+\)[\s\S]*?attemptedProviders\.push\(selectedProvider\);/);
  assert.match(ENGINE, /photoCandidateLoop: while \(true\)[\s\S]*?if \(deadlineExpired\(deadlineAt\)\) break providerLoop;[\s\S]*?continue photoCandidateLoop;[\s\S]*?continue providerLoop;/);
  assert.match(ENGINE, /error\.imageProviderLedger = \{[\s\S]*?schema: 1,[\s\S]*?complete: attemptedProviders\.length === sequence\.length,[\s\S]*?expectedProviders: \[\.\.\.sequence\],[\s\S]*?attemptedProviders: \[\.\.\.attemptedProviders\],[\s\S]*?\};/);
});
