/**
 * The markdown the daily-brief generator emits must be markdown the SITE can
 * render — in BOTH of the ways it renders an article. Run with `node --test`.
 *
 * WHY THIS EXISTS (valerielinc-ops/frontaliere-si-o-no#5415)
 * ─────────────────────────────────────────────────────────
 * On 2026-08-08 the edition's two pipe tables reached readers as raw pipes, in
 * all four locales. The generator was not at fault — it emitted correct
 * markdown-lite — but nothing on this side stated what "correct" meant, so the
 * mismatch was only discoverable by looking at the published page.
 *
 * Three renderers on the site touch this text and they do NOT all accept the
 * same thing:
 *
 *   1. the static engine (`engine/articleSeoFallback.ts`, mirrored here from
 *      the site, where it is the source of truth) — what a crawler and a
 *      first paint see;
 *   2. the SPA renderer, for an article the deployed bundle contains;
 *   3. the SPA renderer again for an article the bundle does NOT contain —
 *      which is EVERY edition on its own publication day, because the bundle
 *      shipped that morning predates it. That path rebuilds the markdown from
 *      the static HTML, so anything renderer 1 flattens is gone for good.
 *
 * The intersection of what all three accept is small, and this file pins the
 * generator to it. It reads the source text only — no TypeScript import, so it
 * runs under a bare `node --test` alongside the rest of the suite, and it does
 * not care which version of the mirrored engine happens to be checked out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDailyBriefArticle } from '../scripts/lib/daily-brief-content.mjs';

const BRIEF = {
  schemaVersion: 1,
  generatedAt: '2026-08-08T05:00:00.000Z',
  dateIso: '2026-08-08',
  counts: { availableBlocks: 4, crossings: 141, fuelMunicipalities: 518, exchangePoints: 32, jobsActive: 22645 },
  blocks: {
    borderWait: {
      available: true,
      updatedAt: '2026-08-08T04:30:00.000Z',
      count: 141,
      zeroWaitCount: 104,
      worst: { slug: 'chiasso-brogeda', name: 'Chiasso Brogeda', waitMinutes: 47 },
      crossings: [
        { slug: 'chiasso-brogeda', name: 'Chiasso Brogeda', waitMinutes: 47, status: 'red', direction: 'Entrambi' },
        { slug: 'ponte-tresa', name: 'Ponte Tresa', waitMinutes: 12, status: 'yellow', direction: 'Entrambi' },
        { slug: 'gaggiolo', name: 'Gaggiolo', waitMinutes: 0, status: 'green', direction: 'Entrambi' },
      ],
    },
    fuel: {
      available: true,
      generatedAt: '2026-08-08T04:00:00.000Z',
      municipalityCount: 518,
      cheaperItalyCount: 66,
      cheaperSwissCount: 71,
      tieCount: 9,
      cheapestItaly: [
        { municipality: 'Livigno', province: 'SO', minPriceEur: 1.528, stationName: 'TOTAL ERG' },
        { municipality: 'Sondrio', province: 'SO', minPriceEur: 1.839, stationName: 'IP' },
      ],
      bestSavings: [
        { municipality: 'Livigno', province: 'SO', cheaperCountry: 'IT', italyPriceEur: 1.528, swissPriceEur: 2.033, swissPriceChf: 1.9, saving50LEur: 25.25 },
      ],
      cheapestSwissStation: { name: 'Alpina Tankstelle', sp95PriceChf: 1.42, sp95PriceEur: 1.519, nearestMunicipality: 'Curon Venosta (BZ)' },
    },
    exchange: {
      available: true, rate: 1.0695, lastDate: '2026-08-08', prevRate: 1.0695, prevDate: '2026-08-07',
      delta1d: 0, rate7dAgo: 1.0741, delta7d: -0.0046, source: 'frankfurter', pointCount: 32,
    },
    jobs: {
      available: true, generatedAt: '2026-08-08T04:00:00.000Z',
      activeJobs: 22645, activeCompanies: 857, todayAdded: 591, yesterdayAdded: 1188, last7dAdded: 4869,
    },
  },
};

const LOCALES = ['it', 'en', 'de', 'fr'];
const article = buildDailyBriefArticle(BRIEF);

/** Every bodyN of every locale, as [label, text]. */
function bodies() {
  const out = [];
  for (const locale of LOCALES) {
    const content = article.content[locale];
    for (const [key, value] of Object.entries(content)) {
      if (/^body\d+$/.test(key) && typeof value === 'string') out.push([`${locale}.${key}`, value]);
    }
  }
  return out;
}

const SEPARATOR_RX = /^\|(\s*:?-{2,}:?\s*\|)+\s*$/;

test('the edition still produces a body for every locale', () => {
  const list = bodies();
  assert.ok(list.length >= 4 * 4, `expected at least 16 bodies, got ${list.length}`);
  for (const [label, text] of list) assert.ok(text.trim().length > 0, `${label} is empty`);
});

/**
 * THE ONE THAT WOULD HAVE CAUGHT #5415's SHAPE.
 *
 * Both renderers recognise a table by finding a `|---|` separator among the
 * pipe rows, and the static engine additionally requires it on the line
 * IMMEDIATELY after the header. Put a blank line between the two, or start the
 * table with the separator, and the static renderer silently reverts to a
 * paragraph of raw pipes — which the day-one path then inherits with the
 * newlines already gone, past any hope of repair.
 */
test('every pipe row belongs to a well-formed table: header, separator on the next line, rows', () => {
  for (const [label, text] of bodies()) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith('|')) continue;
      if (SEPARATOR_RX.test(line)) {
        assert.ok(i > 0 && lines[i - 1].trim().startsWith('|'), `${label}:${i} separator with no header row above it`);
        continue;
      }
      const prev = (lines[i - 1] ?? '').trim();
      const next = (lines[i + 1] ?? '').trim();
      const isHeader = SEPARATOR_RX.test(next);
      const isBodyRow = prev.startsWith('|');
      assert.ok(isHeader || isBodyRow, `${label}:${i} pipe row detached from a table — "${line.slice(0, 60)}"`);
    }
  }
});

test('every table has at least one data row, so it is a table and not a lone header', () => {
  for (const [label, text] of bodies()) {
    const lines = text.split('\n').map((l) => l.trim());
    for (let i = 0; i < lines.length; i++) {
      if (!SEPARATOR_RX.test(lines[i])) continue;
      const after = lines[i + 1] ?? '';
      assert.ok(after.startsWith('|'), `${label}: table at line ${i} has a separator but no rows`);
    }
  }
});

test('a table is never split by a blank line, which would break it into two blocks', () => {
  for (const [label, text] of bodies()) {
    for (const block of text.split('\n\n')) {
      const lines = block.split('\n').map((l) => l.trim());
      const separators = lines.filter((l) => SEPARATOR_RX.test(l)).length;
      if (!separators) continue;
      assert.equal(separators, 1, `${label}: a single block carries ${separators} separator rows`);
      const first = lines.findIndex((l) => l.startsWith('|'));
      const last = lines.length - 1 - [...lines].reverse().findIndex((l) => l.startsWith('|'));
      for (let i = first; i <= last; i++) {
        assert.ok(lines[i].startsWith('|'), `${label}: non-pipe line inside a table block — "${lines[i].slice(0, 60)}"`);
      }
    }
  }
});

/**
 * Constructs at least one of the three renderers does not handle. Each would
 * reach a reader as its own source text.
 */
test('the edition uses no construct the site cannot render', () => {
  const BANNED = [
    [/^```/m, 'fenced code block'],
    [/!\[[^\]]*\]\(/, 'image'],
    [/^\s*\d+\.\s+/m, 'ordered list'],
    [/~~[^~]+~~/, 'strikethrough'],
    [/<[a-z][^>]*>/i, 'raw HTML'],
    [/^\s{0,3}\|.*\|\s*$\n\s*$\n\s*\|/m, 'table split by a blank line'],
  ];
  for (const [label, text] of bodies()) {
    for (const [pattern, name] of BANNED) {
      assert.ok(!pattern.test(text), `${label} contains a ${name}, which not every renderer supports`);
    }
  }
});

test('headings stay at the level the renderers agree on', () => {
  for (const [label, text] of bodies()) {
    for (const line of text.split('\n')) {
      const heading = /^(#{1,6})\s+/.exec(line.trim());
      if (!heading) continue;
      // `#` collides with the page's own <h1>; `###` and deeper are clamped to
      // <h4> by the static renderer and cannot round-trip back to their own
      // level. `##` is the one that survives all three paths intact.
      assert.equal(heading[1], '##', `${label}: heading "${line.trim().slice(0, 40)}" is not a level-2 heading`);
    }
  }
});

test('links are absolute-path links, which every renderer resolves the same way', () => {
  for (const [label, text] of bodies()) {
    for (const match of text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
      assert.ok(
        match[2].startsWith('/') || match[2].startsWith('https://'),
        `${label}: link target "${match[2]}" is neither an absolute path nor an https URL`,
      );
    }
  }
});
