import '../../host/cantonSectionsBootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  generateImageFromSpec,
  imageVisionRejectionError,
} from '../../engine/shared/generatedImageEngine.mjs';

test('il rejection error conserva i flag vision booleani anche con note generiche', () => {
  const error = imageVisionRejectionError({
    ok: false,
    contains_text: true,
    contains_logo: false,
    contains_recognizable_face: false,
    notes: 'generic synthetic illustration',
  });

  assert.equal(error.code, 'IMAGE_VISION_REJECTED');
  assert.equal(error.message, 'vision gate rejected image: generic synthetic illustration');
  assert.deepEqual(error.vision, {
    contains_text: true,
    contains_logo: false,
    contains_recognizable_face: false,
  });
});

test('il ledger dichiara completezza solo dopo l esaurimento della catena richiesta', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-image-ledger-'));
  const previousGemini = process.env.GEMINI_API_KEY;
  const previousFal = process.env.FAL_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.FAL_KEY;
  try {
    const complete = await generateImageFromSpec({
      scope: 'editorial-profile',
      subject: 'an abstract illustrated border landscape',
      assetId: 'complete-ledger-contract',
    }, {
      outputDir: root,
      providers: ['gemini', 'fal'],
    }).catch((error) => error);
    assert.deepEqual(complete.imageProviderLedger, {
      schema: 1,
      complete: true,
      expectedProviders: ['gemini', 'fal'],
      attemptedProviders: ['gemini', 'fal'],
    });

    const partial = await generateImageFromSpec({
      scope: 'editorial-profile',
      subject: 'an abstract illustrated border landscape',
      assetId: 'partial-ledger-contract',
    }, {
      outputDir: root,
      providers: ['gemini', 'fal'],
      maxAttempts: 1,
    }).catch((error) => error);
    assert.deepEqual(partial.imageProviderLedger, {
      schema: 1,
      complete: false,
      expectedProviders: ['gemini', 'fal'],
      attemptedProviders: ['gemini'],
    });
  } finally {
    if (previousGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousGemini;
    if (previousFal === undefined) delete process.env.FAL_KEY;
    else process.env.FAL_KEY = previousFal;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
