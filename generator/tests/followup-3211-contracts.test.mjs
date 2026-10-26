import assert from 'node:assert/strict';
import test from 'node:test';

import {
  lastStaticPropertyValue,
  readStructuredSeoDescription,
} from '../../scripts/lib/corpus-floors.mjs';
import { assertRssProjectorContract } from '../../scripts/lib/rss-projector-contract.mjs';
import { familySourceTransitionState } from '../../scripts/lib/section-registry.mjs';
import { rejectRawFaqControlEscape } from '../../scripts/lib/faq-control-contract.mjs';
import { RSS_DESCRIPTION_MAX_CHARS } from '../scripts/lib/seo-description-contract.mjs';
import { unescapeTsString, tsStringEscapesWithNewlineAs } from '../scripts/lib/unescape-ts-string.mjs';
import {
  activeRunSampleIsComplete,
  compareRunIdsDeterministically,
  decodeChunkedJsonResponse,
  MAX_ACTIVE_JOB_GET_REQUESTS,
} from '../../scripts/ci/translate-queue-recovery.mjs';

test('SEO readers follow the producer last-write-wins contract', () => {
  const block = `({
    description: 'first description',
    description: 'final description',
    structuredData: {
      description: 'nested first',
      description: 'nested final',
    },
    unrelated: { description: 'must not leak' },
  })`;

  assert.equal(lastStaticPropertyValue(block, 'description'), 'final description');
  assert.equal(readStructuredSeoDescription(block), 'nested final');
});

test('SEO reader non eredita un campo dal primo structuredData shadowato', () => {
  const block = `({
    structuredData: {
      headline: 'stale headline',
      datePublished: '2026-01-01T00:00:00Z',
    },
    structuredData: {
      datePublished: '2026-09-01T00:00:00Z',
    },
  })`;

  assert.equal(lastStaticPropertyValue(block, 'headline'), undefined);
  assert.equal(lastStaticPropertyValue(block, 'datePublished'), '2026-09-01T00:00:00Z');
});

test('description reader resetta anche quando structuredData finale non è un oggetto', () => {
  const block = `({
    structuredData: {
      description: 'stale description',
    },
    structuredData: ['runtime replacement'],
  })`;

  assert.equal(readStructuredSeoDescription(block), undefined);
});

test('family source transitions are explicit and fail closed', () => {
  assert.equal(familySourceTransitionState({
    registryPresent: false,
    slugPresent: false,
    metaPresent: false,
  }), 'new');
  assert.equal(familySourceTransitionState({
    registryPresent: true,
    slugPresent: true,
    metaPresent: true,
  }), 'ready');
  assert.equal(familySourceTransitionState({
    registryPresent: true,
    slugPresent: false,
    metaPresent: true,
  }), 'partial');
  assert.throws(
    () => familySourceTransitionState({ registryPresent: true, slugPresent: 'yes', metaPresent: true }),
    /presence must be boolean/u,
  );
});

test('RSS projection is capped, non-empty, and idempotent', () => {
  const projector = (value) => String(value).trim().slice(0, RSS_DESCRIPTION_MAX_CHARS);
  assert.equal(assertRssProjectorContract(projector), projector);
  assert.throws(
    () => assertRssProjectorContract((value) => String(value).trim()),
    /cap output/u,
  );
});

test('literal readers preserve octal tokens and decode opted-in controls', () => {
  const escapes = tsStringEscapesWithNewlineAs('\n');
  assert.equal(
    unescapeTsString(String.raw`legacy \08`, escapes, { decodeControlEscapes: true }),
    String.raw`legacy \08`,
  );
  assert.equal(
    unescapeTsString(String.raw`**bold**\b\f\v`, escapes, { decodeControlEscapes: true }),
    `**bold**\b\f\v`,
  );
  assert.equal(rejectRawFaqControlEscape(String.raw`invalid \u0008`), true);
  assert.equal(rejectRawFaqControlEscape('valid FAQ text'), false);
});

test('translation watchdog keeps UTF-8, sample bounds, and run ordering deterministic', async () => {
  const encoded = new TextEncoder().encode(JSON.stringify({ message: 'è' }));
  const splitAt = encoded.indexOf(0xc3) + 1;
  const chunks = [encoded.slice(0, splitAt), encoded.slice(splitAt)];
  let cursor = 0;
  const reader = {
    async read() {
      if (cursor >= chunks.length) return { done: true, value: undefined };
      return { done: false, value: chunks[cursor++] };
    },
  };
  assert.deepEqual(await decodeChunkedJsonResponse(reader), { message: 'è' });

  const active = Array.from({ length: MAX_ACTIVE_JOB_GET_REQUESTS }, (_, index) => ({
    id: String(index + 1),
    status: 'in_progress',
  }));
  assert.equal(activeRunSampleIsComplete(active), true);
  assert.equal(activeRunSampleIsComplete([...active, { id: '999', status: 'in_progress' }]), false);
  assert.equal(compareRunIdsDeterministically('9007199254740993', '9007199254740992'), -1);
});
