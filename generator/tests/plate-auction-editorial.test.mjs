import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlateAuctionEditorial,
  fetchPlateAuctionEditorialInput,
} from '../../scripts/lib/plate-auction-editorial.mjs';

const SNAPSHOT = {
  schema: 1,
  generatedAt: '2026-09-13T12:00:00.000Z',
  auctions: [
    {
      id: 'gr-1',
      canton: 'Grigioni',
      normalizedPlate: 'GR 7',
      listingType: 'auction',
      auctionStatus: 'active',
      currentBidChf: 700,
      bidCount: 3,
      endsAt: '2026-09-14T18:00:00.000Z',
      officialDetailUrl: 'https://eauktion.gr.ch/',
      sourceFetchedAt: '2026-09-13T12:00:00.000Z',
      dataConfidence: 'verified',
    },
    {
      id: 'vs-2',
      canton: 'Vallese',
      normalizedPlate: 'VS 2',
      auctionStatus: 'closed',
      finalPriceChf: 1200,
      finalPriceVerifiedAt: '2026-09-12T10:00:00.000Z',
      officialAuctionUrl: 'https://ecari.vs.ch/ecari-auction/',
      sourceFetchedAt: '2026-09-13T12:00:00.000Z',
      dataConfidence: 'verified',
    },
    {
      id: 'zh-3',
      canton: 'Zurigo',
      normalizedPlate: 'ZH 3',
      auctionStatus: 'closed',
      finalPriceChf: 999999,
      officialDetailUrl: 'https://www.auktion.stva.zh.ch/de/auction/3',
      sourceFetchedAt: '2026-09-13T12:00:00.000Z',
      dataConfidence: 'partial',
      bidderName: 'must never be published',
      winner: 'must never be published',
    },
  ],
  history: [],
};

test('builds four localized editorial blocks without bidder or winner data', () => {
  const editorial = buildPlateAuctionEditorial({
    snapshot: SNAPSHOT,
    upstreamStatus: 'ready',
    generatedAt: '2026-09-13T12:30:00.000Z',
  });

  assert.equal(editorial.schema, 1);
  assert.equal(editorial.status, 'ready');
  assert.deepEqual(Object.keys(editorial.evergreen).sort(), ['de', 'en', 'fr', 'it']);
  assert.deepEqual(Object.keys(editorial.weekly).sort(), ['de', 'en', 'fr', 'it']);
  assert.deepEqual(
    Object.fromEntries(Object.entries(editorial.evergreen).map(([locale, block]) => [locale, block.slug])),
    {
      it: 'aste-targhe-svizzera-guida',
      en: 'swiss-plate-auctions-guide',
      de: 'leitfaden-schweizer-kontrollschildauktionen',
      fr: 'guide-encheres-plaques-suisses',
    },
  );
  assert.equal(editorial.source.finalRows, 1);
  assert.equal(editorial.weekly.it.highlights.length, 1);
  assert.equal(editorial.weekly.it.highlights[0].plate, 'GR 7');
  const forbiddenKeys = [];
  const collectKeys = (value) => {
    if (Array.isArray(value)) value.forEach(collectKeys);
    else if (value && typeof value === 'object') Object.entries(value).forEach(([key, child]) => {
      if (/bidder|winner/i.test(key)) forbiddenKeys.push(key);
      collectKeys(child);
    });
  };
  collectKeys(editorial);
  assert.deepEqual(forbiddenKeys, []);
});

test('keeps an unavailable upstream explicit and preserves the evergreen guide', () => {
  const editorial = buildPlateAuctionEditorial({
    upstreamStatus: 'unavailable',
    generatedAt: '2026-09-13T12:30:00.000Z',
  });
  assert.equal(editorial.status, 'unavailable');
  assert.equal(editorial.weekly.it.status, 'unavailable');
  assert.equal(editorial.evergreen.it.kind, 'evergreen');
  assert.ok(editorial.evergreen.it.paragraphs.length >= 3);
});

test('does not mark a raw conflicting-only snapshot as ready', async () => {
  const snapshot = {
    schema: 1,
    generatedAt: '2026-09-13T12:00:00.000Z',
    auctions: [{
      id: 'gr-conflict',
      canton: 'Grigioni',
      normalizedPlate: 'GR 9',
      auctionStatus: 'active',
      dataConfidence: 'conflicting',
    }],
    history: [],
  };
  const editorial = buildPlateAuctionEditorial({ snapshot, upstreamStatus: 'ready' });
  assert.equal(editorial.status, 'insufficient-data');
  assert.equal(editorial.weekly.it.status, 'insufficient-data');
  const input = await fetchPlateAuctionEditorialInput({ fetcher: async () => ({ ok: true, json: async () => snapshot }) });
  assert.equal(input.status, 'insufficient-data');
});

test('drops rows whose canton fallback is not a non-empty string', () => {
  const editorial = buildPlateAuctionEditorial({
    snapshot: {
      schema: 1,
      auctions: [
        {
          id: 'invalid-canton',
          canton: { name: 'not public text' },
          platePrefix: 44,
          normalizedPlate: 'ZH 44',
          auctionStatus: 'active',
          dataConfidence: 'verified',
        },
        {
          id: 'valid-canton',
          platePrefix: 'ZH',
          normalizedPlate: 'ZH 7',
          auctionStatus: 'active',
          dataConfidence: 'verified',
        },
      ],
    },
    upstreamStatus: 'ready',
    generatedAt: '2026-09-13T12:00:00.000Z',
  });
  assert.equal(editorial.source.currentRows, 1);
  assert.deepEqual(editorial.weekly.it.highlights.map((row) => row.plate), ['ZH 7']);
  assert.equal(typeof editorial.weekly.it.highlights[0].canton, 'string');
});

test('limits weekly final results to the seven-day observation window', () => {
  const editorial = buildPlateAuctionEditorial({
    snapshot: {
      schema: 1,
      auctions: [{
        id: 'recent-final',
        canton: 'Grigioni',
        normalizedPlate: 'GR 7',
        auctionStatus: 'closed',
        finalPriceChf: 700,
        finalPriceVerifiedAt: '2026-09-12T10:00:00.000Z',
        dataConfidence: 'verified',
      }],
      history: [{
        id: 'old-final',
        canton: 'Zurigo',
        normalizedPlate: 'ZH 1',
        auctionStatus: 'sold',
        finalPriceChf: 1000,
        finalPriceVerifiedAt: '2026-08-01T10:00:00.000Z',
        dataConfidence: 'verified',
      }],
    },
    upstreamStatus: 'ready',
    generatedAt: '2026-09-13T12:00:00.000Z',
  });
  assert.equal(editorial.source.finalRows, 2);
  assert.match(editorial.weekly.it.paragraphs[1], /1 risultati/);
});

test('fetches only the HTTP public snapshot contract and rejects malformed responses', async () => {
  const calls = [];
  const ok = await fetchPlateAuctionEditorialInput({
    url: 'https://example.test/plate-auctions.json',
    fetcher: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => SNAPSHOT };
    },
  });
  assert.equal(ok.status, 'ready');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.test/plate-auctions.json');
  assert.equal(calls[0].options.redirect, 'follow');

  const bad = await fetchPlateAuctionEditorialInput({
    fetcher: async () => ({ ok: true, json: async () => ({ schema: 1, auctions: 'not-an-array' }) }),
  });
  assert.deepEqual(bad, { status: 'unavailable', snapshot: null, errorCode: 'invalid-snapshot' });
});
