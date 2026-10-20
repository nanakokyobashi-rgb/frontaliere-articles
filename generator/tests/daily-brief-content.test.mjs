/**
 * Daily-brief EDITION builder (Bollettino del Frontaliere). Run with `node --test`.
 *
 * Pins the four properties the edition lives or dies by: the title carries a
 * proprietary number of the day; every locale gets a complete body with its
 * hub links; a degraded block turns into a note instead of a hole; and the
 * sitemap retention selector keeps exactly the newest 90 dated editions.
 * (The generator SCRIPT itself is exercised by dry-run-entrypoints in CI,
 * where npm ci provides create-article.mjs's static deps — not here.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { writeFileSync, mkdtempSync } from 'node:fs';
import {
  buildDailyBriefArticle,
  pickHeadline,
  pickDailyAuthor,
  dailyBriefSlugs,
  selectRetiredDailyEditions,
  DAILY_EDITION_SITEMAP_KEEP,
  loadSnapshot,
  buildData,
  humanDate,
} from '../scripts/lib/daily-brief-content.mjs';
import { buildDailyBriefCoverAlt, buildDailyBriefCoverPrompt } from '../scripts/lib/daily-brief-image.mjs';
import { findArticleLocalizedToponymMismatches } from '../scripts/lib/localized-toponyms.mjs';
import { shapeBorderWait, shapeExchange, shapeFuel, BORDER_WAIT_MIN_CROSSINGS } from '../scripts/lib/daily-brief-data.mjs';
import { buildDailyBriefInsights } from '../scripts/lib/daily-brief-insights.mjs';

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
        { slug: 'gaggiolo', name: 'Gaggiolo', waitMinutes: 20, status: 'yellow', direction: 'Entrambi' },
        { slug: 'ponte-tresa', name: 'Ponte Tresa', waitMinutes: 10, status: 'yellow', direction: 'Entrambi' },
        { slug: 'anieres', name: 'Anières', waitMinutes: 0, status: 'green', direction: 'Entrambi' },
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
        { municipality: 'Como', province: 'CO', minPriceEur: 1.899, stationName: null },
      ],
      bestSavings: [
        { municipality: 'Livigno', province: 'SO', cheaperCountry: 'IT', italyPriceEur: 1.528, swissPriceEur: 2.033, swissPriceChf: 1.9, saving50LEur: 25.25 },
      ],
      cheapestSwissStation: { name: 'Alpina Tankstelle', sp95PriceChf: 1.42, sp95PriceEur: 1.519, nearestMunicipality: 'Curon Venosta (BZ)' },
    },
    exchange: {
      available: true,
      rate: 1.0695,
      lastDate: '2026-08-08',
      prevRate: 1.0695,
      prevDate: '2026-08-07',
      delta1d: 0,
      rate7dAgo: 1.0741,
      delta7d: -0.0046,
      source: 'frankfurter',
      pointCount: 32,
    },
    jobs: {
      available: true,
      generatedAt: '2026-08-08T04:27:00.000Z',
      activeJobs: 22645,
      activeCompanies: 857,
      todayAdded: 12,
      yesterdayAdded: 591,
      last7dAdded: 4869,
    },
  },
};

test('the title leads with the day’s proprietary number, in every locale', () => {
  const article = buildDailyBriefArticle(BRIEF);
  assert.equal(article.id, 'bollettino-frontaliere-2026-08-08');
  assert.match(article.content.it.title, /Chiasso Brogeda 47 minuti/);
  assert.match(article.content.it.title, /8 agosto 2026/);
  assert.match(article.content.en.title, /47-minute queue at Chiasso Brogeda/);
  assert.match(article.content.de.title, /47 Minuten Wartezeit/);
  assert.match(article.content.fr.title, /47 minutes d'attente/);
});

test('every locale gets 4 bodies, its hub links and a 3-question FAQ', () => {
  const article = buildDailyBriefArticle(BRIEF);
  for (const locale of ['it', 'en', 'de', 'fr']) {
    const c = article.content[locale];
    for (const key of ['body1', 'body2', 'body3', 'body4']) {
      assert.ok(c[key]?.length > 100, `${locale}.${key} too short`);
      assert.ok(!/<[a-z]+[\s>]/.test(c[key]), `${locale}.${key} contains raw HTML (renders as literal text)`);
    }
    assert.equal(c.faq.length, 3);
    assert.ok(article.imageAlt[locale].length > 20);
  }
  assert.match(article.content.it.body1, /\/traffico-dogane\//);
  assert.match(article.content.it.body2, /\/prezzi-benzina\/oggi\//);
  assert.match(article.content.it.body3, /\/compara-servizi\/cambio-franco-euro\//);
  assert.match(article.content.it.body3, /\/calcola-stipendio\//);
  assert.match(article.content.it.body4, /\/cerca-lavoro-ticino\//);
  assert.match(article.content.de.body1, /\/de\/wartezeit-grenze\//);
  assert.match(article.content.en.body2, /\/en\/gasoline-price-switzerland\/today\//);
  assert.match(article.content.fr.body4, /\/fr\/trouver-emploi-tessin\//);
});

test('the published copy reflects available observations and verified-data recovery', () => {
  const article = buildDailyBriefArticle(BRIEF);
  assert.match(article.content.it.body1, /Tra i rilevamenti disponibili/);
  assert.match(article.content.en.body1, /Among the available readings/);
  assert.match(article.content.de.body1, /Unter den verfügbaren Messungen/);
  assert.match(article.content.fr.body1, /Parmi les relevés disponibles/);

  const degradedFuel = structuredClone(BRIEF);
  degradedFuel.blocks.fuel.available = false;
  const degradedArticle = buildDailyBriefArticle(degradedFuel);
  assert.match(degradedArticle.content.it.body2, /quando sono di nuovo disponibili dati verificabili/);
  assert.match(degradedArticle.content.en.body2, /when verifiable data are available again/);
  assert.match(degradedArticle.content.de.body2, /sobald wieder verifizierbare Daten vorliegen/);
  assert.match(degradedArticle.content.fr.body2, /dès que des données vérifiables sont de nouveau disponibles/);

  assert.match(article.content.de.body2, /beträgt die Differenz der gemeldeten Preise .* pro 50 Liter/);
  assert.doesNotMatch(article.content.de.body2, /pro 50 Liter\*\* wert/);
});

test('the daily body omits the rolling jobs window without publishing its cutoff', () => {
  const article = buildDailyBriefArticle(BRIEF);
  for (const locale of ['it', 'en', 'de', 'fr']) {
    const body = article.content[locale].body4.replace(/[\s.,\u202f]/g, '');
    assert.equal(body.includes('4869'), false, `${locale} deve omettere la finestra mobile non specificata`);
  }
});

test('localizes dynamic border-crossing exonyms before the shared factuality gate', () => {
  const brief = structuredClone(BRIEF);
  const name = 'Basel – Weil am Rhein, Autostrada A2/A5';
  brief.blocks.borderWait.worst = { ...brief.blocks.borderWait.worst, name, waitMinutes: 47 };
  brief.blocks.borderWait.crossings[0] = {
    ...brief.blocks.borderWait.crossings[0],
    name,
    waitMinutes: 47,
  };

  const article = buildDailyBriefArticle(brief);
  assert.match(article.content.fr.title, /à Bâle – Weil am Rhein/);
  assert.match(article.content.fr.body1, /Bâle – Weil am Rhein/);
  assert.match(article.content.it.title, /a Basilea – Weil am Rhein/);
  assert.match(article.content.en.title, /at Basel – Weil am Rhein/);
  assert.match(article.content.de.title, /in Basel – Weil am Rhein/);
  assert.deepEqual(findArticleLocalizedToponymMismatches(article), []);
});

test('the cover follows the article headline without rendering place names or numbers, and slugs stay opaque', () => {
  const brief = structuredClone(BRIEF);
  const sourceName = 'Basel – Weil am Rhein, Autostrada A2/A5';
  brief.blocks.borderWait.worst = { ...brief.blocks.borderWait.worst, name: sourceName };
  brief.blocks.borderWait.crossings[0] = { ...brief.blocks.borderWait.crossings[0], name: sourceName };

  const localizedArticle = buildDailyBriefArticle(brief);
  const coverPrompt = buildDailyBriefCoverPrompt(localizedArticle._headline);
  assert.match(coverPrompt, /Swiss-Italian border crossing/);
  assert.doesNotMatch(coverPrompt, /47|Basel|Weil am Rhein|A2|A5/);
  assert.match(buildDailyBriefCoverAlt(localizedArticle._headline).it, /valico tra Svizzera e Italia/);

  const slugFallback = structuredClone(BRIEF);
  const slug = 'basel-weil-am-rhein';
  slugFallback.blocks.borderWait.worst = { ...slugFallback.blocks.borderWait.worst, slug, name: slug };
  slugFallback.blocks.borderWait.crossings[0] = { ...slugFallback.blocks.borderWait.crossings[0], slug, name: slug };
  const article = buildDailyBriefArticle(slugFallback);
  const content = Object.values(article.content).map((locale) => `${locale.title}\n${locale.body1}`).join('\n');
  assert.match(content, /basel-weil-am-rhein/);
  assert.doesNotMatch(content, /Basilea-weil-am-rhein/);
});

/**
 * THREE descriptive surfaces, three budgets — and the reason the split exists.
 *
 * Until #80 one string was excerpt, meta description and OG description at
 * once, so the tightest of the three constraints governed all of them. The
 * 2026-08-09 edition shipped a 265-char meta description and turned the site's
 * `tests` job red on every branch; the fix that unblocked it cut the excerpt to
 * ~155, which made the READER pay for a Google limit. #81 separates them.
 *
 * What this test pins, per locale:
 *
 *   excerpt         ≥ MIN_EXCERPT. A MINIMUM, deliberately: the failure mode
 *                   this repo has already lived through is someone shortening
 *                   the excerpt to make a SEO test pass. There is no maximum
 *                   the site enforces on it — nothing truncates a card teaser —
 *                   so the only ceiling here is a sanity one.
 *   seoDescription  120–150. The render cap is 150 and the site hard-fails
 *                   above 170 (`tests/seo-description-length.test.ts`).
 *   ogDescription   200–250. Social cards render far more than a SERP does.
 *
 * Measured across every month at BOTH ends of the date-label width, because the
 * label is interpolated and swings up to 7 characters (`May 1, 2026` →
 * `September 22, 2026`). Checking one date proves nothing about the other 364.
 */
const SURFACE_BUDGETS = {
  excerpt: { min: 200, max: 320 },
  seoDescription: { min: 120, max: 150 },
  ogDescription: { min: 200, max: 250 },
};
/** The site's hard bound on `description`, mirrored so a drift here is loud. */
const SITE_DESCRIPTION_HARD_MAX = 170;

test('the maximum wait is attributed to available observations, not the newest crossing update', () => {
  const nowMs = Date.parse('2026-10-14T15:00:00Z');
  const older = '2026-10-14T14:00:00Z';
  const newer = '2026-10-14T14:58:00Z';
  for (const maximum of [8, 30]) {
    const docs = Array.from({ length: BORDER_WAIT_MIN_CROSSINGS }, (_, i) => ({
      slug: `crossing-${i}`, crossingName: i === 0 ? 'Worst Border' : `Border ${i}`,
      waitTimeMinutes: i === 0 ? maximum : 0, lastUpdate: i === 0 ? older : newer,
    }));
    const borderWait = shapeBorderWait(docs, { nowMs });
    assert.equal(borderWait.available, true);
    assert.equal(borderWait.worst.waitMinutes, maximum);
    assert.equal(Date.parse(borderWait.updatedAt), Date.parse(newer));
    assert.equal(borderWait.crossings[0].updatedAt, older);
    const article = buildDailyBriefArticle({ dateIso: '2026-10-14', blocks: { borderWait } });
    for (const locale of ['it', 'en', 'de', 'fr']) {
      assert.match(article.content[locale].body1, new RegExp(`Worst Border.*${maximum}|${maximum}.*Worst Border`, 's'));
      assert.doesNotMatch(article.content[locale].body1, /rilevamento più recente|latest reading|jüngste Messung|letzter Messung|dernier relevé/i);
    }
  }
});

test('fresh border readings below the coverage floor are not described as missing fresh data', () => {
  const nowMs = Date.parse('2026-10-14T15:00:00Z');
  const borderWait = shapeBorderWait([{ slug: 'fresh-border', crossingName: 'Fresh Border', waitTimeMinutes: 8, lastUpdate: '2026-10-14T14:59:00Z' }], { nowMs });
  assert.equal(borderWait.available, false);
  const article = buildDailyBriefArticle({ ...BRIEF, blocks: { ...BRIEF.blocks, borderWait } });
  for (const locale of ['it', 'en', 'de', 'fr']) {
    assert.doesNotMatch(article.content[locale].body1, /non ha dati freschi|no fresh data|keine frischen Daten|pas de données fraîches/);
    assert.match(article.content[locale].body1, /sufficienti|sufficient|ausreichend|suffisantes/);
  }
});

test('Friday-to-Monday exchange comparison refers to the preceding observation', () => {
  const exchange = shapeExchange({ points: [
    { date: '2026-10-02', rate: 1.06 },
    { date: '2026-10-09', rate: 1.07 },
    { date: '2026-10-12', rate: 1.08 },
  ] }, { todayIso: '2026-10-12' });
  assert.equal(exchange.available, true);
  assert.equal(exchange.prevDate, '2026-10-09');
  assert.equal(exchange.delta1d, 0.01);
  const blocks = { exchange };
  const insights = buildDailyBriefInsights({ todayIso: '2026-10-12', blocks });
  const article = buildDailyBriefArticle({ dateIso: '2026-10-12', blocks, insights });
  for (const locale of ['it', 'en', 'de', 'fr']) {
    assert.match(article.content[locale].body3, /precedente rilevamento|previous reading|vorherigen Messung|relevé précédent/);
    assert.doesNotMatch(article.content[locale].body3, /giorno precedente|previous day|Vortag|la veille/);
    assert.doesNotMatch(article.content[locale].body3, /cambio di sette giorni prima|exchange rate seven days earlier|Wechselkurs sieben Tage zuvor|taux de change sept jours auparavant/);
  }
});

test('a usable exchange rate without a weekly baseline states that the comparison is unavailable', () => {
  const exchange = shapeExchange({ points: [
    { date: '2026-10-09', rate: 1.07 },
    { date: '2026-10-12', rate: 1.08 },
  ] }, { todayIso: '2026-10-12' });
  assert.equal(exchange.available, true);
  assert.equal(exchange.delta7d, null);
  const article = buildDailyBriefArticle({ dateIso: '2026-10-12', blocks: { exchange } });
  for (const locale of ['it', 'en', 'de', 'fr']) {
    assert.match(article.content[locale].body3, /confronto settimanale non è disponibile|weekly comparison is unavailable|Wochenvergleich ist nicht verfügbar|comparaison hebdomadaire n’est pas disponible/);
    assert.doesNotMatch(article.content[locale].body3, /variazione è di —|the move is —|Veränderung —|variation est de —/);
  }
});

test('fresh fuel metadata rejected by validation is not described as a stopped source', () => {
  const nowMs = Date.parse('2026-10-14T15:00:00Z');
  const fuel = shapeFuel({ generatedAt: '2026-10-14T14:59:00Z', rankings: {
    cheapestItalyMunicipalities: [{ municipality: 'Rejected quote', minPriceEur: -1 }],
    bestCrossBorderSavings: [],
  } }, { nowMs });
  assert.equal(fuel.available, false);
  assert.equal(fuel.reason, 'fuel rankings are empty');
  const article = buildDailyBriefArticle({ ...BRIEF, blocks: { ...BRIEF.blocks, fuel } });
  for (const locale of ['it', 'en', 'de', 'fr']) {
    assert.doesNotMatch(article.content[locale].body2, /fonte riprende|source is back|Quelle wieder liefert|source reprend|48/);
    assert.match(article.content[locale].body2, /verificabili|verifiable|verifizierbare|vérifiables/);
  }
});

test('the three descriptive surfaces each fit their own budget, every locale, every date', () => {
  assert.ok(
    SURFACE_BUDGETS.seoDescription.max < SITE_DESCRIPTION_HARD_MAX,
    'the SERP budget must leave headroom under the site hard limit',
  );
  for (let month = 1; month <= 12; month++) {
    // '01' = narrowest label, '22' = widest. Both ends, or the band is untested.
    for (const day of ['01', '22']) {
      const dateIso = `2026-${String(month).padStart(2, '0')}-${day}`;
      const article = buildDailyBriefArticle({ ...BRIEF, dateIso });
      for (const locale of ['it', 'en', 'de', 'fr']) {
        const c = article.content[locale];
        for (const [field, { min, max }] of Object.entries(SURFACE_BUDGETS)) {
          const value = c[field];
          assert.equal(typeof value, 'string', `${locale}.${field} is not a string`);
          assert.ok(
            value.length >= min && value.length <= max,
            `${locale}.${field} is ${value.length} chars at ${dateIso} (budget ${min}-${max}): ${value}`,
          );
          // The date has to survive any rewrite: an edition ships every morning,
          // so a template without it gives 365 pages a year one identical text.
          assert.ok(
            value.includes(humanDate(dateIso, locale)),
            `${locale}.${field} dropped its date label at ${dateIso}: ${value}`,
          );
          // A truncated template is the shape this split exists to avoid.
          assert.ok(!/[…]|\.\.\.$/.test(value), `${locale}.${field} looks truncated: ${value}`);
        }
      }
    }
  }
});

test('metadata describes active job listings without claiming unfinalized new arrivals', () => {
  const activeListings = {
    it: /annunci di lavoro attivi/,
    en: /active (?:Swiss )?job listings/,
    de: /aktive Stellenanzeigen|aktive Stellenangebote/,
    fr: /offres d'emploi actives/,
  };
  const unverifiedArrivalClaims = {
    it: /nuovi annunci|nuove offerte|sono usciti/,
    en: /\bnew\b|\bposted\b|\badded\b/,
    de: /neue Stellen|neu dazugekommen/,
    fr: /nouvelles offres|ajoutées|sont parues/,
  };
  const article = buildDailyBriefArticle(BRIEF);
  for (const locale of ['it', 'en', 'de', 'fr']) {
    const copy = ['excerpt', 'seoDescription', 'ogDescription']
      .map((field) => article.content[locale][field]).join('\n');
    assert.match(copy, activeListings[locale], `${locale}: metadata must describe the active listings shown in the body`);
    assert.doesNotMatch(copy, unverifiedArrivalClaims[locale], `${locale}: date buckets do not establish newly added listings`);
  }
});

/**
 * The regression guard proper. Everything above could pass while the three
 * fields carried the same string — which is precisely the state that produced
 * #79. Assert they are DISTINCT, and that the one the reader sees is the
 * longest of the three.
 */
test('the excerpt never doubles as the meta description again (#79 regression guard)', () => {
  for (const dateIso of ['2026-03-01', '2026-09-22']) {
    const article = buildDailyBriefArticle({ ...BRIEF, dateIso });
    for (const locale of ['it', 'en', 'de', 'fr']) {
      const { excerpt, seoDescription, ogDescription } = article.content[locale];
      assert.notEqual(seoDescription, excerpt, `${locale}: seoDescription is the excerpt again`);
      assert.notEqual(ogDescription, excerpt, `${locale}: ogDescription is the excerpt again`);
      assert.notEqual(seoDescription, ogDescription, `${locale}: SERP and social text collapsed into one`);
      // The reader-facing text is the richest of the three, by construction.
      assert.ok(excerpt.length > ogDescription.length, `${locale}: excerpt is not the richest text`);
      assert.ok(ogDescription.length > seoDescription.length, `${locale}: social text is not richer than the SERP one`);
      // And none of them is a prefix of another: that would be a truncation,
      // not a text written for its surface.
      assert.ok(!excerpt.startsWith(seoDescription), `${locale}: seoDescription is a truncation of the excerpt`);
      assert.ok(!excerpt.startsWith(ogDescription), `${locale}: ogDescription is a truncation of the excerpt`);
    }
  }
});

/**
 * The wiring, at the object the registrar actually receives. `buildData` is
 * where the excerpt used to leak into `seo.description` — one assignment, and
 * the reason a rich excerpt was impossible.
 */
test('buildData feeds seo.description from seoDescription, never from the excerpt', () => {
  const data = buildData(BRIEF);
  const c = buildDailyBriefArticle(BRIEF).content.it;
  assert.equal(data.seo.description, c.seoDescription);
  assert.equal(data.seo.ogDescription, c.ogDescription);
  assert.notEqual(data.seo.description, c.excerpt);
  assert.notEqual(data.seo.ogDescription, c.excerpt);
  // The bound the site enforces on `description`, restated where it is set.
  assert.ok(
    data.seo.description.length <= SITE_DESCRIPTION_HARD_MAX,
    `seo.description is ${data.seo.description.length} chars (site hard max ${SITE_DESCRIPTION_HARD_MAX})`,
  );
});

test('a degraded block becomes a note, never a hole', () => {
  const degraded = structuredClone(BRIEF);
  degraded.blocks.fuel = { available: false, reason: 'stale' };
  degraded.counts.availableBlocks = 3;
  const article = buildDailyBriefArticle(degraded);
  assert.match(article.content.it.body2, /⚠️/);
  assert.match(article.content.it.body2, /\/prezzi-benzina\/oggi\//);
  assert.ok(article.content.it.body2.length > 60);
});

test('a significant current crossing wait remains a valid lead', () => {
  assert.equal(pickHeadline(BRIEF.blocks).kind, 'borderWait');
});

test('pickHeadline is TOTAL over available blocks (PR #51 review finding)', () => {
  // The shapes that used to exhaust the cascade: fuel available with EMPTY
  // cheapestItaly (bestSavings only), jobs available with null yesterdayAdded.
  const variants = {
    borderWait: [null, { available: false }, BRIEF.blocks.borderWait,
      { ...BRIEF.blocks.borderWait, worst: { slug: 's', name: 'S', waitMinutes: 3 } }],
    fuel: [null, { available: false }, BRIEF.blocks.fuel,
      { ...BRIEF.blocks.fuel, cheapestItaly: [] }],
    exchange: [null, { available: false }, BRIEF.blocks.exchange],
    jobs: [null, { available: false }, BRIEF.blocks.jobs,
      { ...BRIEF.blocks.jobs, yesterdayAdded: null },
      { ...BRIEF.blocks.jobs, yesterdayAdded: 3 }],
  };
  const KINDS = new Set(['dailyBrief', 'borderWait', 'borderWaitChange', 'exchangeChange', 'fuelSaving']);
  let combos = 0;
  for (const borderWait of variants.borderWait)
    for (const fuel of variants.fuel)
      for (const exchange of variants.exchange)
        for (const jobs of variants.jobs) {
          combos++;
          const blocks = { borderWait, fuel, exchange, jobs };
          const anyAvailable = Object.values(blocks).some((b) => b?.available);
          const h = pickHeadline(blocks);
          if (anyAvailable) {
            assert.ok(h, `null headline despite available blocks: ${Object.entries(blocks).filter(([, b]) => b?.available).map(([k]) => k)}`);
            assert.ok(KINDS.has(h.kind), `unknown kind ${h.kind}`);
          } else {
            assert.equal(h, null);
          }
        }
  assert.equal(combos, 4 * 4 * 3 * 5);
});

test('the review scenario builds an edition instead of throwing (exit-0 contract)', () => {
  const brief = structuredClone(BRIEF);
  brief.blocks.borderWait = { available: false, reason: 'x' };
  brief.blocks.exchange = { available: false, reason: 'x' };
  brief.blocks.fuel.cheapestItaly = [];
  brief.blocks.jobs.yesterdayAdded = 3; // sub-threshold
  brief.counts.availableBlocks = 2;
  const a1 = buildDailyBriefArticle(brief); // used to throw here
  assert.equal(a1._headline.kind, 'dailyBrief');
  assert.match(a1.content.it.title, /dati verificati di oggi/);
  brief.blocks.jobs.yesterdayAdded = null; // active totals stay available
  const a2 = buildDailyBriefArticle(brief);
  assert.equal(a2._headline.kind, 'dailyBrief');
  brief.blocks.jobs = { available: false, reason: 'x' };
  const a3 = buildDailyBriefArticle(brief);
  assert.equal(a3._headline.kind, 'dailyBrief');
});

test('a neutral lead does not hide valid jobs totals or claim an outage', () => {
  const brief = structuredClone(BRIEF);
  brief.blocks.jobs.yesterdayAdded = null;
  const article = buildDailyBriefArticle(brief);
  for (const locale of ['it', 'en', 'de', 'fr']) {
    const body4 = article.content[locale].body4;
    assert.ok(!body4.includes('⚠️'), `${locale}.body4 carries the outage note despite jobs.available`);
  }
  assert.match(article.content.it.body4, /22'645|22.645|22645/); // the totals lead
  assert.match(article.content.it.body4, /\/cerca-lavoro-ticino\//); // link still there
  assert.equal(article._headline.kind, 'borderWait'); // only the measured 47-minute wait clears a signal floor
});

test('a raw job-board count and sub-threshold readings produce a neutral headline', () => {
  const calm = structuredClone(BRIEF.blocks);
  calm.borderWait.worst.waitMinutes = 3; // sub-threshold queue
  calm.jobs.yesterdayAdded = 666; // an unfinalized date bucket cannot become a lead
  calm.exchange = { available: false };
  calm.fuel.bestSavings[0].italyObservedAt = '17/10/2026';
  calm.fuel.bestSavings[0].swissObservedAt = '16/10/2026 00:01'; // unknown interval could approach 48h
  assert.equal(pickHeadline(calm).kind, 'dailyBrief');
});

test('seven date-only job rows cannot create a weekly lead or period claim', () => {
  const todayIso = '2026-10-18';
  const currentAdds = [1000, 1000, 1000, 1000, 1000, 1000, 942];
  const previousAdds = [1387, 1387, 1387, 1387, 1387, 1387, 1391];
  const history = [...currentAdds, ...previousAdds].map((added, index) => ({
    date: new Date(Date.parse(`${todayIso}T00:00:00Z`) - (index + 1) * 86400000).toISOString().slice(0, 10),
    added,
  }));
  const brief = structuredClone(BRIEF);
  brief.dateIso = todayIso;
  brief.blocks.borderWait.worst.waitMinutes = 5;
  brief.blocks.jobs = { ...brief.blocks.jobs, yesterdayAdded: null };
  brief.insights = buildDailyBriefInsights({ blocks: brief.blocks, jobsStats: {
    history,
    leaders: { topCompaniesActive: [{ name: 'Employer', count: 8 }], topLocationsActive: [{ name: 'Chiasso', count: 5 }] },
  }, todayIso });
  const article = buildDailyBriefArticle(brief);
  assert.equal(article._headline.kind, 'dailyBrief');
  assert.equal(brief.insights.jobs.currentWeekAdded, undefined);
  assert.equal(brief.insights.jobs.weeklyChange, undefined);
  for (const locale of ['it', 'en', 'de', 'fr']) {
    const copy = `${article.content[locale].body1}\n${article.content[locale].body4}`;
    assert.doesNotMatch(copy, /6[.,’']?942|9[.,’']?713|2[.,’']?771|28[,.]5/);
    assert.doesNotMatch(copy, /complete week|complete weeks|vollständige Woche|vollständigen Woche|semaine complète|settimana completa|settimane complete|gestern|yesterday|ieri|hier/i);
    assert.ok(article.content[locale].body4.includes((22645).toLocaleString({ it: 'it-CH', en: 'en-CH', de: 'de-CH', fr: 'fr-CH' }[locale])), `${locale}: active total missing`);
    assert.match(article.content[locale].body4, /Employer/);
    assert.match(article.content[locale].body4, /Chiasso/);
  }
});

test('legacy weekly fields without closure evidence are ignored in every locale', () => {
  const brief = structuredClone(BRIEF);
  brief.dateIso = '2026-10-18';
  brief.blocks.borderWait.worst.waitMinutes = 5;
  brief.blocks.jobs.yesterdayAdded = null;
  brief.insights = { jobs: { lastClosedDay: '2026-10-17', currentWeekAdded: 6942,
    previousWeekAdded: 9713, weeklyChange: -2771, weeklyChangePct: -28.5,
    currentPeriod: { from: '2026-10-11', to: '2026-10-17' },
    previousPeriod: { from: '2026-10-04', to: '2026-10-10' } } };
  const article = buildDailyBriefArticle(brief);
  assert.equal(article._headline.kind, 'dailyBrief');
  for (const locale of ['it', 'en', 'de', 'fr']) {
    const copy = `${article.content[locale].title}\n${article.content[locale].body1}\n${article.content[locale].body4}`;
    assert.doesNotMatch(copy, /6[.,’']?942|9[.,’']?713|2[.,’']?771|28[,.]5/);
    assert.doesNotMatch(copy, /complete week|complete weeks|vollständige Woche|vollständigen Woche|semaine complète|settimana completa|settimane complete/i);
    assert.match(article.content[locale].body4, /22645|22[.,’']?645/);
  }
});

test('a supported border comparison can lead when no other signal is available', () => {
  const brief = structuredClone(BRIEF);
  brief.blocks.borderWait.worst = { slug: 'chiasso-brogeda', name: 'Chiasso Brogeda', waitMinutes: 20 };
  brief.insights = { borderWait: { slug: 'chiasso-brogeda', name: 'Chiasso Brogeda',
    previousWaitMinutes: 5, waitMinutes: 20, changeMinutes: 15,
    previousDate: '2026-08-07', currentDate: '2026-08-08' } };
  assert.equal(pickHeadline(brief.blocks, brief.insights).kind, 'borderWaitChange');
  const article = buildDailyBriefArticle(brief);
  assert.match(article.content.it.body1, /due edizioni consecutive/);
  assert.match(article.content.en.body1, /two consecutive editions/);
});

test('a dated exchange-rate reference can lead with a scoped CHF 4,000 comparison', () => {
  const blocks = structuredClone(BRIEF.blocks);
  blocks.borderWait.worst.waitMinutes = 5;
  blocks.exchange.lastDate = '2026-08-08';
  const insights = { exchange: { rate7dAgo: 1.07, previousDate: '2026-08-01',
    weeklySalaryChangeEur: 40, referenceSalaryChf: 4000 } };
  assert.equal(pickHeadline(blocks, insights).kind, 'exchangeChange');
  const article = buildDailyBriefArticle({ ...BRIEF, blocks, insights });
  assert.match(article.content.it.body1, /non è una stima dello stipendio netto/);
  assert.match(article.content.it.body1, /commissioni/);
});

test('fuel price-gap lead requires precise compatible observation times', () => {
  const brief = structuredClone(BRIEF);
  brief.blocks.borderWait.worst.waitMinutes = 5;
  const saving = brief.blocks.fuel.bestSavings[0];
  saving.italyObservedAt = '2026-10-18T12:00:00Z';
  saving.swissObservedAt = '2026-10-18T15:00:00+02:00';
  assert.equal(pickHeadline(brief.blocks).kind, 'fuelSaving');
  const article = buildDailyBriefArticle({ ...brief, dateIso: '2026-10-18' });
  assert.match(article.content.it.body1, /14:00 \(ora Svizzera\)/);
  assert.match(article.content.it.body1, /15:00 \(ora Svizzera\)/);
  assert.match(article.content.en.body1, /14:00 \(Swiss time\)/);
  assert.match(article.content.de.body1, /14:00 \(Schweizer Zeit\)/);
  assert.match(article.content.fr.body1, /14:00 \(heure suisse\)/);
  assert.match(article.content.it.body1, /non per tutte le stazioni/);

  saving.italyObservedAt = '17/10/2026';
  saving.swissObservedAt = '16/10/2026 00:01';
  assert.equal(pickHeadline(brief.blocks).kind, 'dailyBrief');
  saving.italyObservedAt = '2026-10-18T99:99';
  saving.swissObservedAt = '2026-10-18T12:00';
  assert.equal(pickHeadline(brief.blocks).kind, 'dailyBrief');

  // A wall-clock timestamp without an offset cannot be compared to a UTC or
  // offset timestamp as an instant; the local timezone interpretation is not
  // encoded in the source value.
  saving.italyObservedAt = '2026-10-17T18:00';
  saving.swissObservedAt = '2026-10-18T17:00:00Z';
  assert.equal(pickHeadline(brief.blocks).kind, 'dailyBrief');

  saving.italyObservedAt = '2026-10-18T13:00';
  saving.swissObservedAt = '2026-10-18T17:00:00Z';
  assert.equal(pickHeadline(brief.blocks).kind, 'fuelSaving');
  const mixedZoneArticle = buildDailyBriefArticle({ ...brief, dateIso: '2026-10-18' });
  assert.match(mixedZoneArticle.content.it.body1, /18 ottobre 2026 13:00 \(ora Svizzera\)/);
  assert.match(mixedZoneArticle.content.en.body1, /October 18, 2026 13:00 \(Swiss time\)/);

  saving.italyObservedAt = '25/10/2026 02:30';
  saving.swissObservedAt = '2026-10-25T01:30:00Z';
  assert.equal(pickHeadline(brief.blocks).kind, 'dailyBrief', 'an ambiguous repeated Rome wall clock is not an instant');
});

test('the fuel comparison in body2 uses the same eligible row that won the headline', () => {
  const brief = structuredClone(BRIEF);
  brief.blocks.borderWait.worst.waitMinutes = 5;
  const chosen = { ...brief.blocks.fuel.bestSavings[0], municipality: 'Mendrisio', saving50LEur: 26.5,
    italyPriceEur: 1.5, swissPriceEur: 2.03,
    italyObservedAt: '2026-10-18T12:00:00Z', swissObservedAt: '2026-10-18T15:00:00+02:00' };
  brief.blocks.fuel.bestSavings = [
    { ...chosen, municipality: 'Lugano', italyPriceEur: 1.42, swissPriceEur: 2.1,
      italyObservedAt: '17/10/2026', swissObservedAt: '16/10/2026 00:01' },
    chosen,
  ];
  const article = buildDailyBriefArticle({ ...brief, dateIso: '2026-10-18' });
  assert.equal(article._headline.kind, 'fuelSaving');
  assert.equal(article._headline.municipality, 'Mendrisio');
  assert.match(article.content.it.body1, /Mendrisio/);
  assert.match(article.content.it.body2, /Mendrisio/);
  assert.doesNotMatch(article.content.it.body2, /Lugano/);
});

test('loadSnapshot refuses a snapshot whose counter disagrees with its own blocks', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'daily-brief-lie-'));
  const file = path.join(dir, 'daily-brief.json');
  const lying = structuredClone(BRIEF);
  lying.blocks.borderWait = { available: false };
  lying.blocks.fuel = { available: false };
  lying.blocks.exchange = { available: false };
  lying.blocks.jobs = { available: false };
  lying.counts.availableBlocks = 4; // the lie
  writeFileSync(file, JSON.stringify(lying));
  const { brief, reason } = loadSnapshot('2026-08-08', file);
  assert.equal(brief, null);
  assert.match(reason, /inconsistent snapshot/);
});

test('slugs are dated per locale; author rotation is deterministic and rotates', () => {
  const slugs = dailyBriefSlugs('2026-08-08');
  assert.equal(slugs.it, 'bollettino-frontaliere-2026-08-08');
  assert.match(slugs.en, /^cross-border-daily-brief-2026-08-08$/);
  assert.match(slugs.de, /2026-08-08$/);
  assert.match(slugs.fr, /2026-08-08$/);
  const a1 = pickDailyAuthor('2026-08-08');
  assert.equal(pickDailyAuthor('2026-08-08').slug, a1.slug); // deterministic
  const three = new Set(['2026-08-08', '2026-08-09', '2026-08-10'].map((d) => pickDailyAuthor(d).slug));
  assert.equal(three.size, 3); // full rotation over three days
  assert.ok(!three.has('redazione'));
});

test('sitemap retention keeps the newest 90 dated editions, ignores everything else', () => {
  const ids = ['classifica-dogane-ticino', 'eventi-weekend-ticino'];
  const day0 = Date.parse('2026-05-01T00:00:00Z');
  const dates = [];
  for (let i = 0; i < 100; i++) {
    const d = new Date(day0 + i * 86_400_000).toISOString().slice(0, 10);
    dates.push(d);
    ids.push(`bollettino-frontaliere-${d}`);
  }
  const retired = selectRetiredDailyEditions(ids);
  assert.equal(retired.size, 100 - DAILY_EDITION_SITEMAP_KEEP);
  assert.ok(retired.has(`bollettino-frontaliere-${dates[0]}`)); // oldest goes
  assert.ok(!retired.has(`bollettino-frontaliere-${dates[99]}`)); // newest stays
  assert.ok(!retired.has('classifica-dogane-ticino')); // evergreen untouched
});

test('the generated cover follows the neutral lead when job history has no closure attestation', () => {
  const todayIso = '2026-10-18';
  const history = Array.from({ length: 14 }, (_, index) => ({
    date: new Date(Date.parse(`${todayIso}T00:00:00Z`) - (index + 1) * 86400000).toISOString().slice(0, 10),
    added: index < 7 ? 942 : 1387,
  }));
  const brief = structuredClone(BRIEF);
  brief.dateIso = todayIso;
  brief.blocks.borderWait.worst.waitMinutes = 5;
  brief.blocks.jobs.yesterdayAdded = null;
  brief.insights = buildDailyBriefInsights({ blocks: brief.blocks, jobsStats: { history }, todayIso });
  const article = buildDailyBriefArticle(brief);
  assert.equal(article._headline.kind, 'dailyBrief');
  for (const locale of ['it', 'en', 'de', 'fr']) {
    assert.match(article.content[locale].body4, /22'645|22\.645|22,645|22645/);
    assert.doesNotMatch(`${article.content[locale].body1}\n${article.content[locale].body4}`, /6[.,’']?942|9[.,’']?709|28[,.]5/);
  }
  const prompt = buildDailyBriefCoverPrompt(article._headline);
  assert.match(prompt, /cross-border commuter/i);
  assert.doesNotMatch(prompt, /6942|9713|2771|28\.5/);
  const alt = buildDailyBriefCoverAlt(article._headline);
  for (const locale of ['it', 'en', 'de', 'fr']) assert.doesNotMatch(alt[locale], /6942|9713|2771|28\.5/);
});

test('loadSnapshot refuses stale, thin and missing snapshots (exit-0 path)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'daily-brief-'));
  const file = path.join(dir, 'daily-brief.json');
  assert.match(loadSnapshot('2026-08-08', file).reason, /missing/);
  writeFileSync(file, JSON.stringify({ ...BRIEF, dateIso: '2026-08-07' }));
  assert.match(loadSnapshot('2026-08-08', file).reason, /stale/);
  writeFileSync(file, JSON.stringify({ ...BRIEF, counts: { ...BRIEF.counts, availableBlocks: 1 } }));
  assert.match(loadSnapshot('2026-08-08', file).reason, /too thin/);
  writeFileSync(file, JSON.stringify(BRIEF));
  assert.equal(loadSnapshot('2026-08-08', file).reason, null);
});

test('buildData wires the registrar shape: novita, named author, generated hero path', () => {
  const data = buildData(BRIEF);
  assert.equal(data.category, 'novita');
  assert.notEqual(data.author.slug, 'redazione');
  assert.equal(data._generatedImagePath, '/images/blog/bollettino-frontaliere-2026-08-08.webp');
  assert.match(data.seo.keywords, /dogana/); // news-sitemap whitelist token
  assert.equal(data.slugs.it, data.id);
  assert.match(data.seo.breadcrumbName, /8 agosto 2026/);
});
