/**
 * Deterministic, quota-free content builder for the DAILY "Bollettino del
 * Frontaliere" edition. Sibling of border-wait-ranking-content.mjs and
 * events-digest-content.mjs — same pattern (per-locale T dictionary, markdown-
 * lite bodies, zero LLM) with one deliberate difference: the id is DATED
 * (`bollettino-frontaliere-YYYY-MM-DD`), one new article per day, because a
 * bumped `updatedAt` on a stable id is not a new story for Google Discover.
 * The flooding that dated ids imply is bounded by the sitemap retention in
 * scripts/build-api.mjs (latest N editions listed, older ones de-listed but
 * never deleted — house rule: never noindex, never delete HTML).
 *
 * Input is the `public/data/daily-brief.json` snapshot (see
 * lib/daily-brief-data.mjs): blocks degrade individually, and this builder
 * mirrors that — a degraded block becomes a one-line note, never a hole.
 *
 * Pure `.mjs`, no `.ts` imports → runs under plain `node` (unlike the ranking
 * builder, which needs tsx). Hub links below are hardcoded per locale and were
 * curl-verified 200 on 2026-08-08 — they are the SSG verticals, NOT the
 * SLUG_TABLES SPA-tab slugs (`/prezzi-benzina-confine/` 404s; the real page is
 * `/prezzi-benzina/oggi/`).
 */
import { readFileSync, existsSync } from 'node:fs';
import { replaceLocalizedToponymMismatches } from './localized-toponyms.mjs';
import { DEMAND_THEMES } from './daily-brief-insights.mjs';
import { ITALY_FUEL_TIME_ZONE, SWISS_FUEL_TIME_ZONE } from './daily-brief-data.mjs';

export const DAILY_BRIEF_ID_PREFIX = 'bollettino-frontaliere-';
/** Keep this many editions in the blog sitemap; older ones are de-listed. */
export const DAILY_EDITION_SITEMAP_KEEP = 90;
export const DAILY_EDITION_ID_RE = /^bollettino-frontaliere-\d{4}-\d{2}-\d{2}$/;

const LOCALES = ['it', 'en', 'de', 'fr'];

/** Real, named authors (host/authors.ts mirror) — deliberately no `redazione`:
 * a faceless byline on 1.100+ articles/month is the scaled-content profile the
 * bollettino exists to move away from. Deterministic daily rotation. */
const AUTHORS = [
  { slug: 'marco-ferrari', name: 'Marco Ferrari' },
  { slug: 'laura-bianchi', name: 'Laura Bianchi' },
  { slug: 'samuele-valente', name: 'Samuele Valente' },
];

/** Hub pages, one per data block — all curl-verified 200 (2026-08-08). */
const HUB = {
  traffic: { it: '/traffico-dogane/', en: '/en/border-wait/', de: '/de/wartezeit-grenze/', fr: '/fr/temps-attente-douane/' },
  fuel: { it: '/prezzi-benzina/oggi/', en: '/en/gasoline-price-switzerland/today/', de: '/de/benzinpreis-schweiz/heute/', fr: '/fr/prix-essence-suisse/aujourd-hui/' },
  fx: { it: '/compara-servizi/cambio-franco-euro/', en: '/en/service-comparison/chf-eur-exchange-rate/', de: '/de/service-vergleich/chf-eur-wechselkurs/', fr: '/fr/comparaison-services/taux-change-chf-eur/' },
  salary: { it: '/calcola-stipendio/', en: '/en/calculate-salary/', de: '/de/gehalt-berechnen/', fr: '/fr/calculer-salaire/' },
  jobs: { it: '/cerca-lavoro-ticino/', en: '/en/find-jobs-ticino/', de: '/de/jobs-im-tessin/', fr: '/fr/trouver-emploi-tessin/' },
};

const MONTHS = {
  it: ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  de: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
};

const WEEKDAYS = {
  it: ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'],
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  de: ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'],
  fr: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'],
};

export function dailyBriefArticleId(dateIso) {
  return `${DAILY_BRIEF_ID_PREFIX}${dateIso}`;
}

export function dailyBriefSlugs(dateIso) {
  return {
    it: dailyBriefArticleId(dateIso),
    en: `cross-border-daily-brief-${dateIso}`,
    de: `grenzgaenger-tagesbulletin-${dateIso}`,
    fr: `bulletin-frontalier-${dateIso}`,
  };
}

/** Deterministic per-day rotation across the three named authors. */
export function pickDailyAuthor(dateIso) {
  const day = Math.floor(Date.parse(`${dateIso}T00:00:00Z`) / 86_400_000);
  return AUTHORS[((day % AUTHORS.length) + AUTHORS.length) % AUTHORS.length];
}

/**
 * The sitemap-retention selector: dated edition ids beyond the newest `keep`.
 * Pure so scripts/build-api.mjs and the tests share one implementation.
 * @param {string[]} ids - all article ids (any mix; non-editions are ignored)
 * @returns {Set<string>} ids to DE-LIST from the sitemap (never delete)
 */
export function selectRetiredDailyEditions(ids, keep = DAILY_EDITION_SITEMAP_KEEP) {
  const editions = (ids || []).filter((id) => DAILY_EDITION_ID_RE.test(id)).sort().reverse();
  return new Set(editions.slice(keep));
}

export function humanDate(dateIso, locale) {
  const [y, mo, d] = dateIso.split('-').map(Number);
  const month = MONTHS[locale][mo - 1];
  if (locale === 'de') return `${d}. ${month} ${y}`;
  return locale === 'en' ? `${month} ${d}, ${y}` : `${d} ${month} ${y}`;
}

function weekday(dateIso, locale) {
  return WEEKDAYS[locale][new Date(`${dateIso}T12:00:00Z`).getUTCDay()];
}

/** Locale-aware number formatting, Swiss conventions: apostrophe grouping
 * (22'645); decimal separator is a POINT for it-CH/de-CH/en-CH and a comma
 * only for fr-CH — matching what Swiss users see on the site itself. */
function fmt(locale, n, digits = 0) {
  if (!Number.isFinite(n)) return '—';
  const tag = { it: 'it-CH', en: 'en-CH', de: 'de-CH', fr: 'fr-CH' }[locale];
  return n.toLocaleString(tag, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function signed(locale, n, digits) {
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${fmt(locale, n, digits)}`;
}

/**
 * Border-wait source names are canonical source labels, not locale-specific
 * prose. Project canton/capital exonyms into the target locale before those
 * labels enter a title or body; otherwise the shared factuality gate correctly
 * rejects (for example) `Basel` in a French edition.
 */
function localizeBorderWaitName(value, locale, sourceSlug) {
  if (typeof value !== 'string' || !value) return value;
  // shapeBorderWait falls back to d.slug when the publisher has no display
  // name. Keep that opaque identifier intact instead of translating only its
  // first token into a hybrid label.
  if (typeof sourceSlug === 'string' && value === sourceSlug) return value;
  return replaceLocalizedToponymMismatches({
    sourceText: value,
    targetText: value,
    locale,
  }).text;
}

function localizeBorderWaitBlock(block, locale) {
  if (!block || typeof block !== 'object') return block;
  return {
    ...block,
    ...(block.worst && typeof block.worst === 'object'
      ? { worst: { ...block.worst, name: localizeBorderWaitName(block.worst.name, locale, block.worst.slug) } }
      : {}),
    ...(Array.isArray(block.crossings)
      ? {
        crossings: block.crossings.map((crossing) => crossing && typeof crossing === 'object'
          ? { ...crossing, name: localizeBorderWaitName(crossing.name, locale, crossing.slug) }
          : crossing),
      }
      : {}),
  };
}

/** The same locale projection feeds article text and its generated hero card. */
export function projectDailyBriefForLocale(brief, locale) {
  if (!brief || typeof brief !== 'object') return brief;
  const sourceBlocks = brief.blocks && typeof brief.blocks === 'object' ? brief.blocks : {};
  return {
    ...brief,
    blocks: {
      ...sourceBlocks,
      borderWait: localizeBorderWaitBlock(sourceBlocks.borderWait, locale),
    },
  };
}

const EDITORIAL_SIGNAL_FLOORS = Object.freeze({
  borderWaitChangeMinutes: 15,
  borderWaitMinutes: 30,
  jobsChangePct: 20,
  jobsChangeCount: 500,
  exchangeSalaryChangeEur: 40,
  fuelSaving50LEur: 15,
});
const DAY_MS = 86400000;

function fuelSourceTimeZone(value, expected) {
  // Legacy snapshots predate explicit timezone fields; the side-specific
  // source contract remains known from the producer (MIMIT vs TCS). A present
  // but different value is not trusted as a new timezone convention.
  if (value == null || value === '') return expected;
  return value === expected ? value : null;
}

const zonedClockFormatters = new Map();

function zonedClockParts(timestamp, timeZone) {
  let formatter = zonedClockFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    zonedClockFormatters.set(timeZone, formatter);
  }
  return Object.fromEntries(formatter.formatToParts(timestamp)
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, Number(part.value)]));
}

/** Resolve a source-local clock only when its timezone maps to one instant. */
function sourceWallClockTimestamp(dateIso, time, timeZone) {
  if (!timeZone) return null;
  const [year, month, day] = dateIso.split('-').map(Number);
  const [hour, minute, second = 0] = time.split(':').map(Number);
  const wallClockMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const matchingInstants = new Set();

  // Sample both sides of any nearby DST transition, infer their UTC offsets,
  // and keep only instants that round-trip to the exact source wall clock.
  for (const deltaHours of [-36, -12, 12, 36]) {
    const sample = wallClockMs + deltaHours * 60 * 60 * 1000;
    const parts = zonedClockParts(sample, timeZone);
    const representedMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const candidate = wallClockMs - (representedMs - sample);
    const actual = zonedClockParts(candidate, timeZone);
    if (actual.year === year && actual.month === month && actual.day === day
      && actual.hour === hour && actual.minute === minute && actual.second === second) {
      matchingInstants.add(candidate);
    }
  }
  return matchingInstants.size === 1 ? [...matchingInstants][0] : null;
}

function parseFuelObservation(value, sourceTimeZone) {
  if (typeof value !== 'string') return null;
  const dayFirst = /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim());
  let dateIso;
  let time = '';
  let timestamp;
  let dateOnly = false;
  let hasExplicitZone = false;
  if (dayFirst) {
    const [, d, m, y, hh = '00', mm = '00', ss = '00'] = dayFirst;
    dateIso = `${y}-${m}-${d}`;
    time = dayFirst[4] ? `${hh}:${mm}` : '';
    const dateTimestamp = Date.parse(`${dateIso}T00:00:00Z`);
    if (!Number.isFinite(dateTimestamp) || new Date(dateTimestamp).toISOString().slice(0, 10) !== dateIso
      || Number(hh) > 23 || Number(mm) > 59 || Number(ss) > 59) return null;
    dateOnly = !dayFirst[4];
    timestamp = dateOnly ? dateTimestamp : sourceWallClockTimestamp(dateIso, `${hh}:${mm}:${ss}`, sourceTimeZone);
    if (!Number.isFinite(timestamp)) return null;
  } else {
    const iso = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(value.trim());
    if (!iso) return null;
    dateIso = iso[1];
    time = iso[2] || '';
    dateOnly = !iso[2];
    hasExplicitZone = Boolean(iso[4]);
    const dateTimestamp = Date.parse(`${dateIso}T00:00:00Z`);
    if (!Number.isFinite(dateTimestamp) || new Date(dateTimestamp).toISOString().slice(0, 10) !== dateIso) return null;
    if (iso[2]) {
      const [hour, minute] = iso[2].split(':').map(Number);
      const second = Number(iso[3] || 0);
      if (hour > 23 || minute > 59 || second > 59) return null;
    }
    // MIMIT publishes Italian wall clocks; TCS observations are Swiss wall
    // clocks when an offset is absent. Resolve those by the owning field's
    // source timezone, never by the process timezone or generatedAt.
    timestamp = iso[2] && !hasExplicitZone
      ? sourceWallClockTimestamp(dateIso, `${iso[2]}:${iso[3] || '00'}`, sourceTimeZone)
      : dateOnly ? dateTimestamp : Date.parse(value);
    if (!Number.isFinite(timestamp)) return null;
  }
  return { dateIso, time, timestamp, dateOnly, hasExplicitZone, sourceTimeZone };
}

function formatFuelObservation(value, locale, sourceTimeZone) {
  const parsed = parseFuelObservation(value, sourceTimeZone);
  if (!parsed) return '—';
  if (parsed.time) {
    const parts = new Intl.DateTimeFormat({ it: 'it-CH', en: 'en-CH', de: 'de-CH', fr: 'fr-CH' }[locale], {
      timeZone: SWISS_FUEL_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(parsed.timestamp);
    const get = type => parts.find(part => part.type === type)?.value;
    const localDate = `${get('year')}-${get('month')}-${get('day')}`;
    const timezoneLabel = {
      it: 'ora Svizzera', en: 'Swiss time', de: 'Schweizer Zeit', fr: 'heure suisse',
    }[locale];
    return `${humanDate(localDate, locale)} ${get('hour')}:${get('minute')} (${timezoneLabel})`;
  }
  return `${humanDate(parsed.dateIso, locale)}${parsed.time ? ` ${parsed.time}` : ''}`;
}

function canonicalDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
}

/**
 * Select one primary finding from comparisons with a traceable baseline. The
 * thresholds are expressed as multiples of documented materiality floors, so
 * unlike comparing minutes, listings and euros directly, the ranking is
 * dimensionless. A current queue of at least 30 minutes is also a valid
 * stand-alone finding. When no signal clears its floor, the headline stays
 * neutral; an unfinalized job-board date bucket is not a lead signal.
 */
export function pickHeadline(blocks, insights = {}, dateIso) {
  const candidates = [];
  const add = (score, priority, headline) => {
    if (Number.isFinite(score) && score >= 1) candidates.push({ score, priority, headline });
  };
  const bw = blocks?.borderWait;
  const borderInsight = insights?.borderWait;
  if (bw?.available && Number.isFinite(bw.worst?.waitMinutes)) {
    const comparisonValid = borderInsight
      && typeof borderInsight.name === 'string'
      && typeof borderInsight.slug === 'string'
      && canonicalDay(borderInsight.previousDate) !== null
      && canonicalDay(borderInsight.currentDate) !== null
      && canonicalDay(borderInsight.currentDate) - canonicalDay(borderInsight.previousDate) === DAY_MS
      && Number.isFinite(borderInsight.previousWaitMinutes)
      && Number.isFinite(borderInsight.changeMinutes)
      && borderInsight.waitMinutes === bw.worst.waitMinutes;
    if (comparisonValid && Math.abs(borderInsight.changeMinutes) >= EDITORIAL_SIGNAL_FLOORS.borderWaitChangeMinutes) {
      add(Math.max(
        Math.abs(borderInsight.changeMinutes) / EDITORIAL_SIGNAL_FLOORS.borderWaitChangeMinutes,
        borderInsight.waitMinutes / EDITORIAL_SIGNAL_FLOORS.borderWaitMinutes,
      ), 0, { kind: 'borderWaitChange', name: borderInsight.name, slug: borderInsight.slug,
        waitMinutes: borderInsight.waitMinutes, previousWaitMinutes: borderInsight.previousWaitMinutes,
        changeMinutes: borderInsight.changeMinutes, previousDate: borderInsight.previousDate,
        currentDate: borderInsight.currentDate });
    } else if (bw.worst.waitMinutes >= EDITORIAL_SIGNAL_FLOORS.borderWaitMinutes) {
      add(bw.worst.waitMinutes / EDITORIAL_SIGNAL_FLOORS.borderWaitMinutes, 0,
        { kind: 'borderWait', name: bw.worst.name, minutes: bw.worst.waitMinutes });
    }
  }

  const exchange = blocks?.exchange;
  const exchangeInsight = insights?.exchange;
  if (exchange?.available && exchangeInsight
    && Number.isFinite(exchangeInsight.weeklySalaryChangeEur)
    && Number.isFinite(exchangeInsight.rate7dAgo)
    && Number.isFinite(exchange.rate)
    && canonicalDay(exchangeInsight.previousDate) !== null
    && canonicalDay(exchange.lastDate) !== null
    && canonicalDay(exchange.lastDate) - canonicalDay(exchangeInsight.previousDate) >= 7 * DAY_MS
    && canonicalDay(exchange.lastDate) - canonicalDay(exchangeInsight.previousDate) <= 12 * DAY_MS) {
    add(Math.abs(exchangeInsight.weeklySalaryChangeEur) / EDITORIAL_SIGNAL_FLOORS.exchangeSalaryChangeEur, 2,
      { kind: 'exchangeChange', rate: exchange.rate, rate7dAgo: exchangeInsight.rate7dAgo,
        weeklyDelta: exchangeInsight.weeklyRateDelta, weeklySalaryChangeEur: exchangeInsight.weeklySalaryChangeEur,
        previousDate: exchangeInsight.previousDate, currentDate: exchange.lastDate,
        referenceSalaryChf: exchangeInsight.referenceSalaryChf });
  }

  const fuelRows = Array.isArray(blocks?.fuel?.bestSavings) ? blocks.fuel.bestSavings : [];
  for (const saving of fuelRows) {
    const italyTimeZone = fuelSourceTimeZone(saving?.italyTimeZone, ITALY_FUEL_TIME_ZONE);
    const swissTimeZone = fuelSourceTimeZone(saving?.swissTimeZone, SWISS_FUEL_TIME_ZONE);
    const italyObservation = parseFuelObservation(saving?.italyObservedAt, italyTimeZone);
    const swissObservation = parseFuelObservation(saving?.swissObservedAt, swissTimeZone);
    if (!italyObservation || !swissObservation
      || !italyTimeZone || !swissTimeZone
      || (italyObservation.dateOnly || swissObservation.dateOnly
        ? italyObservation.dateIso !== swissObservation.dateIso
        : Math.abs(italyObservation.timestamp - swissObservation.timestamp) > DAY_MS)
      || !Number.isFinite(saving.saving50LEur)
      || saving.saving50LEur < EDITORIAL_SIGNAL_FLOORS.fuelSaving50LEur
      || !Number.isFinite(saving.italyPriceEur) || !Number.isFinite(saving.swissPriceEur)) continue;
    add(saving.saving50LEur / EDITORIAL_SIGNAL_FLOORS.fuelSaving50LEur, 3,
      { kind: 'fuelSaving', municipality: saving.municipality,
        saving50LEur: saving.saving50LEur, italyPriceEur: saving.italyPriceEur,
        swissPriceEur: saving.swissPriceEur, italyTimeZone, swissTimeZone,
        italyObservedAt: saving.italyObservedAt,
        swissObservedAt: saving.swissObservedAt });
    break;
  }

  if (candidates.length) {
    candidates.sort((a, b) => b.score - a.score || a.priority - b.priority);
    return candidates[0].headline;
  }

  if (Object.values(blocks || {}).some(block => block?.available)) return { kind: 'dailyBrief' };
  return null;
}

/**
 * Locale copy for the brief.
 *
 * ## Three descriptive surfaces, three different budgets
 *
 * Until #80 a single string served all three, so the tightest constraint —
 * Google's snippet — silently became the ceiling for the other two, and the
 * reader got the shortest text any of the three could tolerate. They are now
 * three separate fields, each written for its own surface:
 *
 *   `excerpt`          RICH, 200+ chars. This is what a HUMAN reads: the card
 *                      in the blog list, the related-articles rail, the
 *                      newsletter teaser. Nothing truncates it there, so the
 *                      only reason to shorten it would be to appease a SEO
 *                      test — which is exactly what this split removes. Never
 *                      trim it below 200: that regression is the one that
 *                      already happened once (#80, 2026-08-09).
 *
 *   `seoDescription`   150–160 chars. Google truncates a SERP snippet around
 *                      160, and the site's `tests/seo-description-length.test.ts`
 *                      hard-fails above 170 on EVERY branch. Written to stand
 *                      alone in a result list: date first, then the two or
 *                      three things people actually search for.
 *
 *   `ogDescription`    200–250 chars. Facebook/LinkedIn/WhatsApp show far more
 *                      than a SERP does, so the social card gets a fuller text.
 *
 * All three are measured at the LONGEST date label a locale can produce
 * (`22 settembre 2026`, `September 22, 2026`, `22. September 2026`) AND at the
 * shortest (`1 marzo 2026`, `May 1, 2026`): the label is interpolated, and its
 * width swings by up to 7 characters over the year. `daily-brief-content.test.mjs`
 * checks every month at both ends.
 *
 * `clampSeoDescriptions` in create-article.mjs stays as a SAFETY NET at the
 * shared write path (160 for description, 250 for ogDescription). After this
 * split it must never fire on the brief — these texts are born the right size.
 *
 * ONE CAVEAT, and it is a site-side one. Only the IT `seoDescription` reaches a
 * meta description today: the SEO entry `blog-<id>` is IT-only, and the site's
 * `packages/articles/engine/ogPagesPlugin.ts` still derives the en/de/fr meta
 * description from the LOCALE EXCERPT, clipping it at 155 with an ellipsis.
 * The localized `seoDescription`s below are therefore written and tested here,
 * but consuming them needs a change on the site — see the PR body.
 *
 * The date stays in all three on purpose: an edition ships every morning, so a
 * template without it would give 365 pages a year one identical description.
 */
const T = {
  it: {
    briefName: 'Bollettino del frontaliere',
    headline: (h) => ({
      dailyBrief: 'i dati verificati di oggi',
      borderWaitChange: `${h.name}: attesa ${h.previousWaitMinutes} → ${h.waitMinutes} min`,
      exchangeChange: `cambio ${signed('it', h.weeklySalaryChangeEur, 2)} € su 4.000 CHF`,
      borderWait: `a ${h.name} ${h.minutes} minuti di coda`,
      exchange: `franco a ${fmt('it', h.rate, 4)} €`,
      fuel: `benzina da ${fmt('it', h.priceEur, 3)} €/L a ${h.municipality}`,
      fuelSaving: `prezzi carburante a ${h.municipality}: ${fmt('it', h.saving50LEur, 0)} € su 50 L`,
    })[h.kind],
    primaryInsight: (h) => {
      if (h.kind === 'borderWaitChange') return `A ${h.name}, la rilevazione è passata da ${h.previousWaitMinutes} minuti il ${humanDate(h.previousDate, 'it')} a ${h.waitMinutes} il ${humanDate(h.currentDate, 'it')} (${signed('it', h.changeMinutes, 0)} min). È il confronto fra due edizioni consecutive, non una previsione per le ore successive.`;
      if (h.kind === 'exchangeChange') return `Tra il ${humanDate(h.previousDate, 'it')} e il ${humanDate(h.currentDate, 'it')}, il tasso è passato da ${fmt('it', h.rate7dAgo, 4)} a ${fmt('it', h.rate, 4)} EUR per CHF. Applicata solo al cambio su ${fmt('it', h.referenceSalaryChf)} CHF, la differenza è ${signed('it', h.weeklySalaryChangeEur, 2)} EUR; non è una stima dello stipendio netto né considera commissioni.`;
      if (h.kind === 'fuelSaving') return `A ${h.municipality}, le quotazioni disponibili per la benzina (${fmt('it', h.italyPriceEur, 3)} €/L in Italia e ${fmt('it', h.swissPriceEur, 3)} €/L sul lato svizzero) differiscono di ${fmt('it', h.saving50LEur, 2)} EUR su 50 litri. Sono rilevazioni del ${formatFuelObservation(h.italyObservedAt, 'it', h.italyTimeZone)} e del ${formatFuelObservation(h.swissObservedAt, 'it', h.swissTimeZone)}: il confronto vale per questi prezzi e momenti, non per tutte le stazioni.`;
      if (h.kind === 'borderWait') return `La rilevazione disponibile indica ${h.minutes} minuti di attesa a ${h.name}. È una fotografia del monitoraggio, non una previsione per il resto della giornata.`;
      return 'Nessun confronto omogeneo supera le soglie per indicare una variazione come notizia principale. Riportiamo i dati disponibili e il periodo a cui si riferisce ciascuna rilevazione.';
    },
    title: (dateLabel, headline) => `Frontalieri: ${headline} — ${dateLabel}`,
    excerpt: (dateLabel) =>
      `I numeri di oggi, ${dateLabel}, per chi attraversa il confine: le ultime attese ai valichi, i comuni con la benzina meno cara, il cambio franco-euro e gli annunci di lavoro attivi sul nostro job board in Svizzera. Dati del nostro monitoraggio quotidiano.`,
    seoDescription: (dateLabel) =>
      `Bollettino quotidiano per frontalieri, ${dateLabel}: code ai valichi, prezzi della benzina, cambio CHF/EUR e offerte attive sul nostro job board svizzero.`,
    ogDescription: (dateLabel) =>
      `I numeri del ${dateLabel} per i frontalieri: quanto si aspetta a ogni valico, in quali comuni conviene fare il pieno, quanto vale il franco al cambio rilevato e quanti annunci di lavoro attivi sono presenti sul nostro job board in Svizzera.`,
    imageAlt: (dateLabel) => `I numeri del giorno per i frontalieri – ${dateLabel}: attese ai valichi, prezzi benzina, cambio franco-euro e annunci di lavoro`,
    intro: (wd, dateLabel) =>
      `È ${wd} ${dateLabel}. Questo è il bollettino quotidiano per chi vive da una parte del confine e lavora dall'altra: quattro temi seguiti dal nostro monitoraggio — code ai valichi, benzina, cambio e lavoro — con i link alle pagine live per seguirli durante la giornata.`,
    bwH: 'Attese ai valichi: rilevamenti disponibili',
    bwLead: (b) =>
      b.worst.waitMinutes >= 10
        ? `Tra i rilevamenti disponibili (${b.count} valichi monitorati), l'attesa massima risulta a **${b.worst.name}: ${b.worst.waitMinutes} minuti**. ${b.zeroWaitCount} valichi risultano senza coda.`
        : `Tra i rilevamenti disponibili il traffico risulta scorrevole: su ${b.count} valichi monitorati, ${b.zeroWaitCount} risultano senza coda e l'attesa massima registrata è di appena **${b.worst.waitMinutes} minuti** (${b.worst.name}).`,
    bwCols: ['Valico', 'Attesa', 'Stato'],
    bwMin: (n) => `${n} min`,
    bwLink: `Il traffico cambia di ora in ora: la situazione live di ogni valico è sulla [pagina del traffico alle dogane](${HUB.traffic.it}).`,
    bwDown: '⚠️ Non ci sono dati sufficienti sui valichi per questa edizione: il blocco torna quando sono disponibili dati verificabili. La situazione live resta sulla [pagina del traffico alle dogane](/traffico-dogane/).',
    fuelH: 'Carburanti: prezzi comunicati al confine',
    fuelLead: (f) =>
      `Su ${f.municipalityCount} comuni di confine monitorati, nel riepilogo il pieno risulta meno caro in Svizzera in ${f.cheaperSwissCount} casi e in Italia in ${f.cheaperItalyCount}.`,
    fuelCols: ['Comune (IT)', 'Benzina, minimo comunicato'],
    fuelPrice: (p) => `${fmt('it', p, 3)} €/L`,
    fuelSaving: (s) =>
      `A **${s.municipality}** (${s.province}), i prezzi comunicati differiscono di **${fmt('it', s.saving50LEur, 2)} € su 50 litri** (${fmt('it', s.italyPriceEur, 3)} €/L in Italia contro ${fmt('it', s.swissPriceEur, 3)} €/L al distributore svizzero più vicino).`,
    fuelSwiss: (st) =>
      st ? `Il distributore svizzero con il prezzo comunicato più basso è **${st.name}** (${fmt('it', st.sp95PriceChf, 2)} CHF/L, ≈ ${fmt('it', st.sp95PriceEur, 3)} €/L), vicino a ${st.nearestMunicipality}.` : '',
    fuelLink: `Prezzi comune per comune, aggiornati ogni giorno: [prezzi benzina al confine, oggi](${HUB.fuel.it}).`,
    fuelDown: '⚠️ Il monitoraggio carburanti non ha dati verificabili per questa edizione: la sezione torna quando sono di nuovo disponibili dati verificabili. Intanto: [prezzi benzina al confine](/prezzi-benzina/oggi/).',
    fxH: 'Cambio franco–euro',
    fxLead: (e) =>
      `Un franco vale **${fmt('it', e.rate, 4)} €** (rilevamento del ${e.lastDate}). Rispetto al precedente rilevamento ${describeDeltaIt(e.delta1d)}; ${Number.isFinite(e.delta7d) ? `rispetto al riferimento settimanale disponibile la variazione è di ${signed('it', e.delta7d, 4)} €` : 'il confronto settimanale non è disponibile'}.`,
    fxWhy: `💡 Per chi prende lo stipendio in franchi e spende in euro, il cambio È una parte dello stipendio: su 4.000 CHF, un centesimo di variazione vale 40 € al mese. Il [calcolatore dello stipendio netto](${HUB.salary.it}) e il [confronto dei servizi di cambio](${HUB.fx.it}) fanno i conti sul tuo caso.`,
    fxDown: '⚠️ Non ci sono dati verificabili sul cambio per questa edizione: il blocco torna quando sono disponibili. Il confronto dei servizi di cambio resta [qui](/compara-servizi/cambio-franco-euro/).',
    jobsH: 'Lavoro: annunci attivi',
    jobsLeadTotal: (j) =>
      `Sul nostro job board gli annunci di lavoro attivi in Svizzera sono **${fmt('it', j.activeJobs)}**${j.activeCompanies ? `, da ${fmt('it', j.activeCompanies)} aziende` : ''}.`,
    jobsLink: `Le offerte si filtrano per cantone, settore e città: [cerca lavoro in Ticino e in Svizzera](${HUB.jobs.it}).`,
    jobsDown: '⚠️ Non ci sono statistiche verificabili del job board per questa edizione: il blocco torna quando sono disponibili. Gli annunci restano su [cerca lavoro](/cerca-lavoro-ticino/).',
    methodH: 'Come nasce questo bollettino',
    method:
      `I numeri qui sopra non arrivano da un'agenzia: sono il nostro monitoraggio. Le attese ai valichi vengono campionate più volte l'ora su tutti i valichi di confine svizzeri; i prezzi dei carburanti coprono i comuni italiani di fascia e i distributori svizzeri vicini al confine; il cambio segue la serie ufficiale giornaliera; gli annunci arrivano dai crawler del nostro job board. Il bollettino esce ogni giorno e può essere aggiornato durante la giornata — i periodi di osservazione dipendono dalla fonte, le pagine linkate restano live tutto il giorno.`,
    faq: (ctx) => [
      { q: 'Quando esce il bollettino del frontaliere?', a: `Ogni giorno, con possibili aggiornamenti durante la giornata. Questa edizione è del ${ctx.dateLabel}; i dati delle diverse fonti possono riferirsi a momenti diversi.` },
      { q: 'Da dove arrivano i dati?', a: 'Dal monitoraggio proprietario di frontaliereticino.ch: rilevamento delle code su tutti i valichi svizzeri, prezzi carburante nei comuni di confine, serie giornaliera del cambio CHF/EUR e crawler del job board. Nessun dato di seconda mano.' },
      { q: 'I numeri restano validi tutta la giornata?', a: 'No: si riferiscono ai periodi di osservazione delle singole fonti e possono cambiare quando questa edizione viene aggiornata. Per la situazione in tempo reale usa le pagine live linkate in ogni sezione.' },
    ],
  },
  en: {
    briefName: 'Cross-border daily brief',
    headline: (h) => ({
      dailyBrief: "today's verified readings",
      borderWaitChange: `${h.name}: wait ${h.previousWaitMinutes} → ${h.waitMinutes} min`,
      exchangeChange: `exchange ${signed('en', h.weeklySalaryChangeEur, 2)} € on CHF 4,000`,
      borderWait: `${h.minutes}-minute queue at ${h.name}`,
      exchange: `franc at €${fmt('en', h.rate, 4)}`,
      fuel: `petrol from €${fmt('en', h.priceEur, 3)}/L in ${h.municipality}`,
      fuelSaving: `fuel prices in ${h.municipality}: €${fmt('en', h.saving50LEur, 0)} per 50 L`,
    })[h.kind],
    primaryInsight: (h) => {
      if (h.kind === 'borderWaitChange') return `At ${h.name}, the reported wait changed from ${h.previousWaitMinutes} minutes on ${humanDate(h.previousDate, 'en')} to ${h.waitMinutes} on ${humanDate(h.currentDate, 'en')} (${signed('en', h.changeMinutes, 0)} min). This compares two consecutive editions; it is not a forecast for later today.`;
      if (h.kind === 'exchangeChange') return `Between ${humanDate(h.previousDate, 'en')} and ${humanDate(h.currentDate, 'en')}, the rate moved from ${fmt('en', h.rate7dAgo, 4)} to ${fmt('en', h.rate, 4)} EUR per CHF. Applied only to CHF ${fmt('en', h.referenceSalaryChf)}, the exchange-only difference is ${signed('en', h.weeklySalaryChangeEur, 2)} EUR; this is not net pay and excludes fees.`;
      if (h.kind === 'fuelSaving') return `In ${h.municipality}, the available petrol quotes (${fmt('en', h.italyPriceEur, 3)} EUR/L in Italy and ${fmt('en', h.swissPriceEur, 3)} EUR/L on the Swiss side) differ by ${fmt('en', h.saving50LEur, 2)} EUR for 50 litres. The readings were reported on ${formatFuelObservation(h.italyObservedAt, 'en', h.italyTimeZone)} and ${formatFuelObservation(h.swissObservedAt, 'en', h.swissTimeZone)}; the comparison applies to these prices and times, not every station.`;
      if (h.kind === 'borderWait') return `The available reading reports a ${h.minutes}-minute wait at ${h.name}. It is a snapshot from the monitoring feed, not a forecast for the rest of the day.`;
      return 'No like-for-like comparison clears the threshold for a lead finding today. The edition reports the available readings and the period each source covers.';
    },
    title: (dateLabel, headline) => `Cross-border workers: ${headline} — ${dateLabel}`,
    excerpt: (dateLabel) =>
      `Today's numbers, ${dateLabel}, for cross-border commuters: the latest crossing waits, cheapest fuel municipalities, the franc-euro rate and active Swiss job listings on our job board. Measured daily by our own monitoring.`,
    seoDescription: (dateLabel) =>
      `Daily cross-border brief for workers, ${dateLabel}: latest measured border waits, fuel prices, franc-euro rate and active Swiss job listings on our board.`,
    ogDescription: (dateLabel) =>
      `Daily figures for cross-border commuters, ${dateLabel}: measured waits at each crossing, where fuel costs least, the latest franc-euro rate and active Swiss job listings on our board, with links to live pages.`,
    imageAlt: (dateLabel) => `The day's numbers for cross-border commuters – ${dateLabel}: border waits, fuel prices, CHF-EUR rate and job listings`,
    intro: (wd, dateLabel) =>
      `Hello — it's ${wd}, ${dateLabel}. This is the daily brief for people who live on one side of the border and work on the other: four topics tracked by our monitoring — border queues, fuel, the exchange rate and jobs — each with a link to its live page.`,
    bwH: 'Border waits: available readings',
    bwLead: (b) =>
      b.worst.waitMinutes >= 10
        ? `Among the available readings (${b.count} crossings monitored), the longest recorded wait is at **${b.worst.name}: ${b.worst.waitMinutes} minutes**. ${b.zeroWaitCount} crossings report no queue.`
        : `The available readings show smooth crossings: of ${b.count} monitored crossings, ${b.zeroWaitCount} report no queue and the longest recorded wait is just **${b.worst.waitMinutes} minutes** (${b.worst.name}).`,
    bwCols: ['Crossing', 'Wait', 'Status'],
    bwMin: (n) => `${n} min`,
    bwLink: `Traffic shifts by the hour — every crossing's live status is on the [border traffic page](${HUB.traffic.en}).`,
    bwDown: '⚠️ There are insufficient border readings for this edition; this section returns when verifiable data is available. Live status stays on the [border traffic page](/en/border-wait/).',
    fuelH: 'Fuel: reported prices near the border',
    fuelLead: (f) =>
      `Across ${f.municipalityCount} monitored border municipalities, filling up is cheaper in Switzerland in ${f.cheaperSwissCount} of them and in Italy in ${f.cheaperItalyCount}.`,
    fuelCols: ['Municipality (IT)', 'Unleaded, reported minimum'],
    fuelPrice: (p) => `€${fmt('en', p, 3)}/L`,
    fuelSaving: (s) =>
      `In **${s.municipality}** (${s.province}), the reported prices differ by **€${fmt('en', s.saving50LEur, 2)} for 50 litres** (€${fmt('en', s.italyPriceEur, 3)}/L in Italy vs €${fmt('en', s.swissPriceEur, 3)}/L at the nearest Swiss station).`,
    fuelSwiss: (st) =>
      st ? `The Swiss station with the lowest reported price is **${st.name}** (CHF ${fmt('en', st.sp95PriceChf, 2)}/L, ≈ €${fmt('en', st.sp95PriceEur, 3)}/L), near ${st.nearestMunicipality}.` : '',
    fuelLink: `Prices town by town, updated daily: [border fuel prices today](${HUB.fuel.en}).`,
    fuelDown: '⚠️ Fuel monitoring has no verifiable data for this edition; this section returns when verifiable data are available again. Meanwhile: [border fuel prices](/en/gasoline-price-switzerland/today/).',
    fxH: 'CHF–EUR exchange rate',
    fxLead: (e) =>
      `One franc buys **€${fmt('en', e.rate, 4)}** (reported on ${e.lastDate}). Versus the previous reading ${describeDeltaEn(e.delta1d)}; ${Number.isFinite(e.delta7d) ? `against the available weekly reference the move is ${signed('en', e.delta7d, 4)} €` : 'the weekly comparison is unavailable'}.`,
    fxWhy: `💡 If you earn francs and spend euros, the rate IS part of your salary: on CHF 4,000, one cent of movement is worth €40 a month. The [net salary calculator](${HUB.salary.en}) and the [currency-exchange comparison](${HUB.fx.en}) run the numbers for your case.`,
    fxDown: '⚠️ Verifiable exchange-rate data is unavailable for this edition; this section returns when it is available. The exchange comparison stays [here](/en/service-comparison/chf-eur-exchange-rate/).',
    jobsH: 'Jobs: active listings',
    jobsLeadTotal: (j) =>
      `Our job board currently carries **${fmt('en', j.activeJobs)} active Swiss job listings**${j.activeCompanies ? ` from ${fmt('en', j.activeCompanies)} companies` : ''}.`,
    jobsLink: `Filter by canton, sector and city: [find jobs in Ticino and Switzerland](${HUB.jobs.en}).`,
    jobsDown: '⚠️ Verifiable job-board statistics are unavailable for this edition; this section returns when they are available. Listings stay on [find jobs](/en/find-jobs-ticino/).',
    methodH: 'How this brief is made',
    method:
      'None of the numbers above come from an agency feed — they are our own monitoring: border queues sampled several times an hour at every Swiss crossing, fuel prices across Italian border municipalities and nearby Swiss stations, the official daily CHF/EUR series, and our job-board crawlers. The brief is published daily and may be refreshed during the day; observation periods depend on the source, the linked pages stay live all day.',
    faq: (ctx) => [
      { q: 'When is the cross-border daily brief published?', a: `Daily, with possible updates during the day. This edition is dated ${ctx.dateLabel}; data from different sources may refer to different times.` },
      { q: 'Where does the data come from?', a: 'From frontaliereticino.ch’s proprietary monitoring: queue sampling at every Swiss border crossing, fuel prices in border municipalities, the daily CHF/EUR series and our job-board crawlers. No second-hand data.' },
      { q: 'Do the numbers stay valid all day?', a: 'No — the values refer to each source’s observation period and can change when this edition is updated. For current conditions, follow the live pages linked in each section.' },
    ],
  },
  de: {
    briefName: 'Grenzgänger-Tagesbulletin',
    headline: (h) => ({
      dailyBrief: 'die verfügbaren Messwerte von heute',
      borderWaitChange: `${h.name}: Wartezeit ${h.previousWaitMinutes} → ${h.waitMinutes} Min.`,
      exchangeChange: `Wechselkurs ${signed('de', h.weeklySalaryChangeEur, 2)} € bei CHF 4.000`,
      borderWait: `${h.minutes} Minuten Wartezeit in ${h.name}`,
      exchange: `Franken bei ${fmt('de', h.rate, 4)} €`,
      fuel: `Benzin ab ${fmt('de', h.priceEur, 3)} €/L in ${h.municipality}`,
      fuelSaving: `Kraftstoffpreise in ${h.municipality}: ${fmt('de', h.saving50LEur, 0)} € je 50 L`,
    })[h.kind],
    primaryInsight: (h) => {
      if (h.kind === 'borderWaitChange') return `Bei ${h.name} änderte sich die gemeldete Wartezeit von ${h.previousWaitMinutes} Minuten am ${humanDate(h.previousDate, 'de')} auf ${h.waitMinutes} am ${humanDate(h.currentDate, 'de')} (${signed('de', h.changeMinutes, 0)} Min.). Das ist der Vergleich zweier aufeinanderfolgender Ausgaben, keine Vorhersage für den weiteren Tagesverlauf.`;
      if (h.kind === 'exchangeChange') return `Zwischen dem ${humanDate(h.previousDate, 'de')} und dem ${humanDate(h.currentDate, 'de')} änderte sich der Kurs von ${fmt('de', h.rate7dAgo, 4)} auf ${fmt('de', h.rate, 4)} EUR je CHF. Nur auf CHF ${fmt('de', h.referenceSalaryChf)} umgerechnet ergibt sich eine Differenz von ${signed('de', h.weeklySalaryChangeEur, 2)} EUR; das ist weder Nettolohn noch berücksichtigt es Gebühren.`;
      if (h.kind === 'fuelSaving') return `In ${h.municipality} liegen die gemeldeten Benzinpreise (${fmt('de', h.italyPriceEur, 3)} EUR/L in Italien und ${fmt('de', h.swissPriceEur, 3)} EUR/L auf Schweizer Seite) für 50 Liter um ${fmt('de', h.saving50LEur, 2)} EUR auseinander. Die Meldungen stammen vom ${formatFuelObservation(h.italyObservedAt, 'de', h.italyTimeZone)} und ${formatFuelObservation(h.swissObservedAt, 'de', h.swissTimeZone)}; der Vergleich gilt für diese Preise und Zeitpunkte, nicht für alle Tankstellen.`;
      if (h.kind === 'borderWait') return `Die verfügbare Messung meldet ${h.minutes} Minuten Wartezeit bei ${h.name}. Das ist eine Momentaufnahme des Monitorings, keine Vorhersage für den restlichen Tag.`;
      return 'Kein vergleichbarer Befund überschreitet heute die Schwelle für eine Hauptmeldung. Die Ausgabe nennt die verfügbaren Messwerte und den jeweiligen Beobachtungszeitraum.';
    },
    title: (dateLabel, headline) => `Grenzgänger: ${headline} — ${dateLabel}`,
    excerpt: (dateLabel) =>
      `Die Zahlen von heute, ${dateLabel}, für Grenzgänger: die zuletzt gemeldeten Wartezeiten an den Übergängen, die günstigsten Benzinpreise, der Franken-Euro-Kurs und aktive Stellenanzeigen in der Schweiz auf unserem Job-Board. Täglich aus unserem Monitoring.`,
    seoDescription: (dateLabel) =>
      `Grenzgänger-Bulletin heute, ${dateLabel}: Wartezeiten, Benzinpreise, Franken-Euro-Kurs und aktive Stellenanzeigen auf unserem Job-Board in der Schweiz.`,
    ogDescription: (dateLabel) =>
      `Die Zahlen vom ${dateLabel} für Grenzgänger: wie lange man an jedem Übergang wartet, wo das Benzin am günstigsten ist, der aktuelle Franken-Euro-Kurs und die Zahl aktiver Stellenanzeigen auf unserem Job-Board in der Schweiz.`,
    imageAlt: (dateLabel) => `Die Zahlen des Tages für Grenzgänger – ${dateLabel}: Wartezeiten, Benzinpreise, CHF-EUR-Kurs und Stellenangebote`,
    intro: (wd, dateLabel) =>
      `Guten Tag — heute ist ${wd}, der ${dateLabel}. Das ist das tägliche Bulletin für alle, die auf der einen Seite der Grenze wohnen und auf der anderen arbeiten: vier Themen aus unserem Monitoring — Staus an den Übergängen, Benzin, Wechselkurs und Arbeitsmarkt — jeweils mit Link zur Live-Seite.`,
    bwH: 'Wartezeiten laut verfügbaren Messungen',
    bwLead: (b) =>
      b.worst.waitMinutes >= 10
        ? `Unter den verfügbaren Messungen (${b.count} überwachte Übergänge) ist die längste Wartezeit bei **${b.worst.name}: ${b.worst.waitMinutes} Minuten**. ${b.zeroWaitCount} Übergänge melden keine Warteschlange.`
        : `Die verfügbaren Messungen zeigen fließenden Verkehr: Von ${b.count} überwachten Übergängen melden ${b.zeroWaitCount} keine Warteschlange; die längste erfasste Wartezeit beträgt nur **${b.worst.waitMinutes} Minuten** (${b.worst.name}).`,
    bwCols: ['Übergang', 'Wartezeit', 'Status'],
    bwMin: (n) => `${n} Min.`,
    bwLink: `Der Verkehr ändert sich stündlich — der Live-Status jedes Übergangs steht auf der [Seite zur Wartezeit an der Grenze](${HUB.traffic.de}).`,
    bwDown: '⚠️ Für diese Ausgabe liegen keine ausreichenden Grenzmessungen vor; der Abschnitt kehrt mit verifizierbaren Daten zurück. Live-Status: [Wartezeit an der Grenze](/de/wartezeit-grenze/).',
    fuelH: 'Kraftstoff: gemeldete Preise an der Grenze',
    fuelLead: (f) =>
      `In ${f.municipalityCount} überwachten Grenzgemeinden ist das Tanken laut Übersicht günstiger in ${f.cheaperSwissCount} Fällen in der Schweiz und in ${f.cheaperItalyCount} in Italien.`,
    fuelCols: ['Gemeinde (IT)', 'Bleifrei, gemeldeter Tiefstpreis'],
    fuelPrice: (p) => `${fmt('de', p, 3)} €/L`,
    fuelSaving: (s) =>
      `In **${s.municipality}** (${s.province}) beträgt die Differenz der gemeldeten Preise **${fmt('de', s.saving50LEur, 2)} € pro 50 Liter** (${fmt('de', s.italyPriceEur, 3)} €/L in Italien gegenüber ${fmt('de', s.swissPriceEur, 3)} €/L an der nächsten Schweizer Tankstelle).`,
    fuelSwiss: (st) =>
      st ? `Die Schweizer Tankstelle mit dem niedrigsten gemeldeten Preis ist **${st.name}** (${fmt('de', st.sp95PriceChf, 2)} CHF/L, ≈ ${fmt('de', st.sp95PriceEur, 3)} €/L), bei ${st.nearestMunicipality}.` : '',
    fuelLink: `Preise Gemeinde für Gemeinde, täglich aktualisiert: [Benzinpreise an der Grenze, heute](${HUB.fuel.de}).`,
    fuelDown: '⚠️ Die Kraftstoffüberwachung hat keine verifizierbaren Daten für diese Ausgabe; der Abschnitt kehrt zurück, sobald wieder verifizierbare Daten vorliegen. Inzwischen: [Benzinpreise an der Grenze](/de/benzinpreis-schweiz/heute/).',
    fxH: 'Wechselkurs Franken–Euro',
    fxLead: (e) =>
      `Ein Franken ist **${fmt('de', e.rate, 4)} €** wert (Stand ${e.lastDate}). Gegenüber der vorherigen Messung ${describeDeltaDe(e.delta1d)}; ${Number.isFinite(e.delta7d) ? `gegenüber dem verfügbaren Wochenvergleich beträgt die Veränderung ${signed('de', e.delta7d, 4)} €` : 'der Wochenvergleich ist nicht verfügbar'}.`,
    fxWhy: `💡 Wer in Franken verdient und in Euro ausgibt, für den IST der Kurs ein Teil des Lohns: Bei 4.000 CHF ist ein Rappen Bewegung 40 € im Monat wert. Der [Nettolohn-Rechner](${HUB.salary.de}) und der [Vergleich der Wechseldienste](${HUB.fx.de}) rechnen Ihren Fall durch.`,
    fxDown: '⚠️ Für diese Ausgabe liegen keine verifizierbaren Wechselkursdaten vor; der Abschnitt kehrt zurück, sobald sie verfügbar sind. Der Vergleich der Wechseldienste bleibt [hier](/de/service-vergleich/chf-eur-wechselkurs/).',
    jobsH: 'Stellenangebote: aktive Anzeigen',
    jobsLeadTotal: (j) =>
      `Auf unserem Job-Board sind derzeit **${fmt('de', j.activeJobs)} Stellenangebote in der Schweiz aktiv**${j.activeCompanies ? `, von ${fmt('de', j.activeCompanies)} Unternehmen` : ''}.`,
    jobsLink: `Nach Kanton, Branche und Stadt filtern: [Jobs im Tessin und in der Schweiz](${HUB.jobs.de}).`,
    jobsDown: '⚠️ Für diese Ausgabe liegen keine verifizierbaren Job-Board-Statistiken vor; der Abschnitt kehrt zurück, sobald sie verfügbar sind. Die Angebote bleiben unter [Jobs im Tessin](/de/jobs-im-tessin/).',
    methodH: 'Wie dieses Bulletin entsteht',
    method:
      'Keine der Zahlen oben stammt aus einem Agentur-Feed — es ist unsere eigene Messung: mehrmals pro Stunde erfasste Warteschlangen an jedem Schweizer Grenzübergang, Kraftstoffpreise in den italienischen Grenzgemeinden und an nahen Schweizer Tankstellen, die offizielle tägliche CHF/EUR-Reihe und die Crawler unseres Job-Boards. Das Bulletin erscheint täglich und kann im Tagesverlauf aktualisiert werden; die Beobachtungszeiträume hängen von der Quelle ab, die verlinkten Seiten bleiben den ganzen Tag live.',
    faq: (ctx) => [
      { q: 'Wann erscheint das Grenzgänger-Tagesbulletin?', a: `Täglich, mit möglichen Aktualisierungen im Tagesverlauf. Diese Ausgabe ist vom ${ctx.dateLabel}; die Daten der verschiedenen Quellen können sich auf unterschiedliche Zeitpunkte beziehen.` },
      { q: 'Woher stammen die Daten?', a: 'Aus der eigenen Messung von frontaliereticino.ch: Stau-Erfassung an jedem Schweizer Grenzübergang, Kraftstoffpreise in den Grenzgemeinden, die tägliche CHF/EUR-Reihe und die Crawler des Job-Boards. Keine Daten aus zweiter Hand.' },
      { q: 'Gelten die Zahlen den ganzen Tag?', a: 'Nein — die Werte beziehen sich auf die Beobachtungszeiträume der einzelnen Quellen und können sich bei einer Aktualisierung dieser Ausgabe ändern. Für den Echtzeit-Status nutzen Sie die in jedem Abschnitt verlinkten Live-Seiten.' },
    ],
  },
  fr: {
    briefName: 'Bulletin quotidien du frontalier',
    headline: (h) => ({
      dailyBrief: 'les relevés disponibles aujourd’hui',
      borderWaitChange: `${h.name} : attente ${h.previousWaitMinutes} → ${h.waitMinutes} min`,
      exchangeChange: `change ${signed('fr', h.weeklySalaryChangeEur, 2)} € sur 4 000 CHF`,
      borderWait: `${h.minutes} minutes d'attente à ${h.name}`,
      exchange: `franc à ${fmt('fr', h.rate, 4)} €`,
      fuel: `essence dès ${fmt('fr', h.priceEur, 3)} €/L à ${h.municipality}`,
      fuelSaving: `prix du carburant à ${h.municipality} : ${fmt('fr', h.saving50LEur, 0)} € pour 50 L`,
    })[h.kind],
    primaryInsight: (h) => {
      if (h.kind === 'borderWaitChange') return `À ${h.name}, l’attente relevée est passée de ${h.previousWaitMinutes} minutes le ${humanDate(h.previousDate, 'fr')} à ${h.waitMinutes} le ${humanDate(h.currentDate, 'fr')} (${signed('fr', h.changeMinutes, 0)} min). Il s’agit de deux éditions consécutives, pas d’une prévision pour la suite de la journée.`;
      if (h.kind === 'exchangeChange') return `Entre le ${humanDate(h.previousDate, 'fr')} et le ${humanDate(h.currentDate, 'fr')}, le taux est passé de ${fmt('fr', h.rate7dAgo, 4)} à ${fmt('fr', h.rate, 4)} EUR par CHF. Appliquée uniquement à CHF ${fmt('fr', h.referenceSalaryChf)}, la différence liée au change est de ${signed('fr', h.weeklySalaryChangeEur, 2)} EUR ; ce n’est pas un salaire net et les frais ne sont pas inclus.`;
      if (h.kind === 'fuelSaving') return `À ${h.municipality}, les prix d’essence communiqués (${fmt('fr', h.italyPriceEur, 3)} EUR/L en Italie et ${fmt('fr', h.swissPriceEur, 3)} EUR/L côté suisse) diffèrent de ${fmt('fr', h.saving50LEur, 2)} EUR pour 50 litres. Les relevés datent du ${formatFuelObservation(h.italyObservedAt, 'fr', h.italyTimeZone)} et du ${formatFuelObservation(h.swissObservedAt, 'fr', h.swissTimeZone)} ; la comparaison porte sur ces prix et ces moments, pas sur toutes les stations.`;
      if (h.kind === 'borderWait') return `Le relevé disponible indique ${h.minutes} minutes d’attente à ${h.name}. C’est une photographie du monitoring, pas une prévision pour le reste de la journée.`;
      return 'Aucune comparaison homogène ne franchit aujourd’hui le seuil pour constituer le fait principal. Le bulletin présente les relevés disponibles et la période couverte par chaque source.';
    },
    title: (dateLabel, headline) => `Frontaliers : ${headline} — ${dateLabel}`,
    excerpt: (dateLabel) =>
      `Les chiffres du jour, ${dateLabel}, pour les frontaliers : les dernières attentes aux douanes, les communes où le carburant coûte le moins cher, le taux franc-euro et les offres d'emploi actives en Suisse sur notre job board. Relevés quotidiens de notre suivi.`,
    seoDescription: (dateLabel) =>
      `Bulletin quotidien des frontaliers ${dateLabel} : files aux douanes, prix du carburant, taux CHF/EUR, offres d'emploi actives sur notre job board suisse.`,
    ogDescription: (dateLabel) =>
      `Les chiffres du ${dateLabel} pour les frontaliers : attentes aux douanes, communes où le carburant coûte le moins cher, dernier taux CHF/EUR et offres d'emploi actives sur notre job board suisse au quotidien.`,
    imageAlt: (dateLabel) => `Les chiffres du jour pour les frontaliers – ${dateLabel} : attentes aux douanes, prix de l'essence, taux CHF-EUR et offres d'emploi`,
    intro: (wd, dateLabel) =>
      `Bonjour — nous sommes ${wd} ${dateLabel}. Voici le bulletin quotidien pour celles et ceux qui vivent d'un côté de la frontière et travaillent de l'autre : quatre thèmes suivis par notre monitoring — files aux douanes, essence, taux de change et emploi — chacun avec le lien vers sa page en direct.`,
    bwH: 'Attentes selon les relevés disponibles',
    bwLead: (b) =>
      b.worst.waitMinutes >= 10
        ? `Parmi les relevés disponibles (${b.count} passages surveillés), l'attente la plus longue est à **${b.worst.name} : ${b.worst.waitMinutes} minutes**. ${b.zeroWaitCount} passages ne signalent aucune file.`
        : `Les relevés disponibles indiquent un trafic fluide : sur ${b.count} passages surveillés, ${b.zeroWaitCount} ne signalent aucune file et l'attente maximale relevée n'est que de **${b.worst.waitMinutes} minutes** (${b.worst.name}).`,
    bwCols: ['Douane', 'Attente', 'État'],
    bwMin: (n) => `${n} min`,
    bwLink: `Le trafic change d'heure en heure — l'état en direct de chaque douane est sur la [page du temps d'attente](${HUB.traffic.fr}).`,
    bwDown: '⚠️ Les données des douanes ne sont pas suffisantes pour cette édition ; la section revient lorsque des données vérifiables sont disponibles. L’état en direct reste sur la [page du temps d’attente](/fr/temps-attente-douane/).',
    fuelH: 'Carburants : prix communiqués à la frontière',
    fuelLead: (f) =>
      `Sur ${f.municipalityCount} communes frontalières suivies, faire le plein revient moins cher selon le relevé en Suisse dans ${f.cheaperSwissCount} cas et en Italie dans ${f.cheaperItalyCount}.`,
    fuelCols: ['Commune (IT)', 'Sans plomb, minimum communiqué'],
    fuelPrice: (p) => `${fmt('fr', p, 3)} €/L`,
    fuelSaving: (s) =>
      `À **${s.municipality}** (${s.province}), les prix communiqués diffèrent de **${fmt('fr', s.saving50LEur, 2)} € pour 50 litres** (${fmt('fr', s.italyPriceEur, 3)} €/L en Italie contre ${fmt('fr', s.swissPriceEur, 3)} €/L à la station suisse la plus proche).`,
    fuelSwiss: (st) =>
      st ? `La station suisse avec le prix communiqué le plus bas est **${st.name}** (${fmt('fr', st.sp95PriceChf, 2)} CHF/L, ≈ ${fmt('fr', st.sp95PriceEur, 3)} €/L), près de ${st.nearestMunicipality}.` : '',
    fuelLink: `Les prix commune par commune, mis à jour chaque jour : [prix de l'essence à la frontière, aujourd'hui](${HUB.fuel.fr}).`,
    fuelDown: '⚠️ Le suivi des carburants n’a pas de données vérifiables pour cette édition ; la section revient dès que des données vérifiables sont de nouveau disponibles. En attendant : [prix de l’essence à la frontière](/fr/prix-essence-suisse/aujourd-hui/).',
    fxH: 'Taux de change franc–euro',
    fxLead: (e) =>
      `Un franc vaut **${fmt('fr', e.rate, 4)} €** (relevé du ${e.lastDate}). Par rapport au relevé précédent ${describeDeltaFr(e.delta1d)} ; ${Number.isFinite(e.delta7d) ? `par rapport au relevé hebdomadaire disponible, la variation est de ${signed('fr', e.delta7d, 4)} €` : 'la comparaison hebdomadaire n’est pas disponible'}.`,
    fxWhy: `💡 Quand on gagne en francs et qu'on dépense en euros, le taux fait partie du salaire : sur 4 000 CHF, un centime de variation vaut 40 € par mois. Le [calculateur de salaire net](${HUB.salary.fr}) et le [comparatif des services de change](${HUB.fx.fr}) font le calcul pour votre cas.`,
    fxDown: '⚠️ Les données de change vérifiables ne sont pas disponibles pour cette édition ; la section revient dès qu’elles le sont. Le comparatif des services de change reste [ici](/fr/comparaison-services/taux-change-chf-eur/).',
    jobsH: 'Offres d’emploi actives',
    jobsLeadTotal: (j) =>
      `Notre job board compte actuellement **${fmt('fr', j.activeJobs)} offres d'emploi actives en Suisse**${j.activeCompanies ? `, de ${fmt('fr', j.activeCompanies)} entreprises` : ''}.`,
    jobsLink: `Filtrez par canton, secteur et ville : [trouver un emploi au Tessin et en Suisse](${HUB.jobs.fr}).`,
    jobsDown: '⚠️ Les statistiques vérifiables du job board ne sont pas disponibles pour cette édition ; la section revient dès qu’elles le sont. Les offres restent sur [trouver un emploi](/fr/trouver-emploi-tessin/).',
    methodH: 'Comment naît ce bulletin',
    method:
      'Aucun des chiffres ci-dessus ne vient d’un flux d’agence — c’est notre propre suivi : files échantillonnées plusieurs fois par heure à chaque passage frontalier suisse, prix des carburants dans les communes frontalières italiennes et aux stations suisses proches, série officielle quotidienne CHF/EUR et crawlers de notre job board. Le bulletin est publié chaque jour et peut être actualisé dans la journée ; les périodes d’observation dépendent de la source, les pages liées restent en direct toute la journée.',
    faq: (ctx) => [
      { q: 'Quand paraît le bulletin quotidien du frontalier ?', a: `Chaque jour, avec des actualisations possibles dans la journée. Cette édition date du ${ctx.dateLabel} ; les données des différentes sources peuvent se rapporter à des moments différents.` },
      { q: 'D’où viennent les données ?', a: 'Du suivi propriétaire de frontaliereticino.ch : relevé des files à chaque passage frontalier suisse, prix des carburants dans les communes frontalières, série quotidienne CHF/EUR et crawlers du job board. Aucune donnée de seconde main.' },
      { q: 'Les chiffres restent-ils valables toute la journée ?', a: 'Non — les valeurs correspondent aux périodes d’observation de chaque source et peuvent changer lors d’une actualisation de cette édition. Pour l’état en temps réel, utilisez les pages en direct liées dans chaque section.' },
    ],
  },
};

/**
 * The three descriptive texts (`excerpt`/`seoDescription`/`ogDescription`)
 * for one locale, as a PURE function of the calendar date.
 *
 * Look at `T[locale].excerpt/seoDescription/ogDescription` above: none of the
 * three reads `headline` or `blocks` — only the interpolated `dateLabel`.
 * `title` and the body sections do need the day's actual numbers, but these
 * three never did. That is what makes a PUBLISHED edition's descriptive texts
 * reconstructable from its id alone, with no dependency on the source day's
 * `daily-brief.json` snapshot — which is overwritten daily and, for any
 * edition older than today, is long gone.
 *
 * This is what `repair-daily-brief-descriptive-texts.mjs` uses to fix the two
 * editions (`bollettino-frontaliere-2026-08-08`, `-09`) that registered
 * before #83 split these three fields apart (issue #85): re-running the
 * generator on their date can't work — today's snapshot is for today, not
 * for a day that has passed — but no historical data is actually needed for
 * this specific fix, only the date itself.
 *
 * `generate-daily-brief-article.mjs`'s `exists` branch does NOT need this: on
 * a same-day rerun it already has a freshly-built `data` (from the live
 * snapshot) whose `content[locale].{excerpt,seoDescription,ogDescription}`
 * are already current — this helper exists for the case that `data` no
 * longer does, because the day itself is in the past.
 *
 * @param {string} dateIso
 * @param {'it'|'en'|'de'|'fr'} locale
 * @returns {{ excerpt: string, seoDescription: string, ogDescription: string }}
 */
export function buildDescriptiveTexts(dateIso, locale) {
  const t = T[locale];
  if (!t) throw new Error(`buildDescriptiveTexts: locale sconosciuta '${locale}'`);
  const dateLabel = humanDate(dateIso, locale);
  return {
    excerpt: t.excerpt(dateLabel),
    seoDescription: t.seoDescription(dateLabel),
    ogDescription: t.ogDescription(dateLabel),
  };
}

function describeDeltaIt(d) {
  if (!Number.isFinite(d) || d === 0) return 'è stabile';
  return d > 0 ? `guadagna ${signed('it', d, 4)} €` : `perde ${fmt('it', Math.abs(d), 4)} €`;
}
function describeDeltaEn(d) {
  if (!Number.isFinite(d) || d === 0) return 'it is flat';
  return d > 0 ? `it gains ${signed('en', d, 4)} €` : `it loses ${fmt('en', Math.abs(d), 4)} €`;
}
function describeDeltaDe(d) {
  if (!Number.isFinite(d) || d === 0) return 'ist er stabil';
  return d > 0 ? `gewinnt er ${signed('de', d, 4)} €` : `verliert er ${fmt('de', Math.abs(d), 4)} €`;
}
function describeDeltaFr(d) {
  if (!Number.isFinite(d) || d === 0) return 'il est stable';
  return d > 0 ? `il gagne ${signed('fr', d, 4)} €` : `il perd ${fmt('fr', Math.abs(d), 4)} €`;
}

const STATUS_LABEL = {
  it: { green: 'scorrevole', yellow: 'rallentato', red: 'coda' },
  en: { green: 'clear', yellow: 'slow', red: 'queue' },
  de: { green: 'flüssig', yellow: 'stockend', red: 'Stau' },
  fr: { green: 'fluide', yellow: 'ralenti', red: 'file' },
};

function mdTable(headerCells, rows) {
  const header = `| ${headerCells.join(' | ')} |`;
  const sep = `|${headerCells.map(() => '---').join('|')}|`;
  const body = rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
  return `${header}\n${sep}\n${body}`;
}

const INSIGHT_COPY = {
  it: { companies: 'Aziende con più annunci attivi in Svizzera', locations: 'Località con più annunci attivi', entity: 'Azienda / località', count: 'Annunci attivi', fx: 'Simulazione del solo cambio su 4.000 CHF', fxValue: 'Controvalore lordo in euro', fxDelta: 'Differenza rispetto al riferimento settimanale disponibile', waits: 'Confronto con la precedente edizione', fuel: 'Prezzi comunicati presso gli stessi distributori', petrol: 'Benzina €/L', diesel: 'Diesel €/L', observed: 'Ultima comunicazione', search: 'I temi cercati dai lettori', theme: 'Tema', demand: 'Impression in Ricerca Google', searches: 'Eventi di ricerca sul sito', note: 'Dati aggregati per tema: non sono pubblicate ricerche individuali. Le impression misurano esposizione su Google. Gli eventi sul sito possono includere aggiornamenti della ricerca; non sono persone o ricerche uniche.', source: 'Fonte', checked: 'Rilevamento', sample: 'campione parziale' },
  en: { companies: 'Companies with the most active listings in Switzerland', locations: 'Locations with the most active listings', entity: 'Company / location', count: 'Active listings', fx: 'Exchange-only illustration for CHF 4,000', fxValue: 'Gross euro equivalent', fxDelta: 'Difference from the available weekly exchange-rate reference', waits: 'Comparison with the previous edition', fuel: 'Reported prices at the same stations', petrol: 'Petrol EUR/L', diesel: 'Diesel EUR/L', observed: 'Last report', search: 'Topics readers search for', theme: 'Topic', demand: 'Google Search impressions', searches: 'Site search events', note: 'Aggregated topics only: individual searches are never published. Impressions measure Google exposure. Site events may include search updates; these are not counts of people or unique searches.', source: 'Source', checked: 'Observation', sample: 'partial sample' },
  de: { companies: 'Unternehmen mit den meisten aktiven Inseraten in der Schweiz', locations: 'Orte mit den meisten aktiven Inseraten', entity: 'Unternehmen / Ort', count: 'Aktive Inserate', fx: 'Reines Wechselkursbeispiel für CHF 4.000', fxValue: 'Bruttogegenwert in Euro', fxDelta: 'Differenz zum verfügbaren wöchentlichen Wechselkursvergleich', waits: 'Vergleich mit der vorherigen Ausgabe', fuel: 'Gemeldete Preise an denselben Tankstellen', petrol: 'Benzin EUR/L', diesel: 'Diesel EUR/L', observed: 'Letzte Meldung', search: 'Von Lesern gesuchte Themen', theme: 'Thema', demand: 'Impressionen in der Google Suche', searches: 'Suchereignisse auf der Website', note: 'Nur aggregierte Themen: einzelne Suchanfragen werden nie veröffentlicht. Impressionen messen Sichtbarkeit auf Google. Suchereignisse können Aktualisierungen enthalten; sie zählen weder Personen noch eindeutige Suchanfragen.', source: 'Quelle', checked: 'Messung', sample: 'unvollständige Stichprobe' },
  fr: { companies: 'Entreprises avec le plus d’annonces actives en Suisse', locations: 'Localités avec le plus d’annonces actives', entity: 'Entreprise / localité', count: 'Annonces actives', fx: 'Simulation du seul change pour 4.000 CHF', fxValue: 'Contre-valeur brute en euros', fxDelta: 'Différence avec le relevé de change hebdomadaire disponible', waits: 'Comparaison avec l’édition précédente', fuel: 'Prix communiqués dans les mêmes stations', petrol: 'Essence EUR/L', diesel: 'Diesel EUR/L', observed: 'Dernière communication', search: 'Les thèmes recherchés par les lecteurs', theme: 'Thème', demand: 'Impressions dans la Recherche Google', searches: 'Événements de recherche sur le site', note: 'Thèmes agrégés uniquement : aucune recherche individuelle n’est publiée. Les impressions mesurent la visibilité sur Google. Les événements peuvent inclure des mises à jour de recherche ; ce ne sont pas des personnes ou des recherches uniques.', source: 'Source', checked: 'Relevé', sample: 'échantillon partiel' },
};

function insightSections(locale, brief) {
  const copy = INSIGHT_COPY[locale];
  const insights = brief.insights || {};
  const sections = { borderWait: [], fuel: [], exchange: [], jobs: [] };
  const bw = insights.borderWait;
  if (bw && Number.isFinite(bw.changeMinutes)) sections.borderWait.push(`### ${copy.waits}\n${localizeBorderWaitName(bw.name, locale, bw.slug)}: ${bw.previousWaitMinutes} → ${bw.waitMinutes} min (${bw.previousDate} → ${brief.dateIso}).`);
  const fuel = brief.blocks?.fuel;
  if (fuel?.available) {
    const rows = fuel.cheapestItaly.filter(row => Number.isFinite(row.dieselPriceEur));
    if (rows.length) sections.fuel.push(`### ${copy.fuel}\n${mdTable([copy.entity, copy.petrol, copy.diesel, copy.observed], rows.map(row => [row.municipality, fmt(locale, row.minPriceEur, 3), fmt(locale, row.dieselPriceEur, 3), row.observedAt || '—']))}`);
    sections.fuel.push(`${copy.checked}: ${fuel.generatedAt}.`);
  }
  const fx = insights.exchange;
  if (fx) {
    sections.exchange.push(`### ${copy.fx}\n${copy.fxValue}: **${fmt(locale, fx.salaryValueEur, 2)} EUR** (${fx.lastDate}).`);
    if (Number.isFinite(fx.weeklySalaryChangeEur)) sections.exchange.push(`${copy.fxDelta}: **${signed(locale, fx.weeklySalaryChangeEur, 2)} EUR**.`);
  }
  const jobs = insights.jobs;
  if (jobs) {
    for (const [key, heading] of [['topCompanies', copy.companies], ['topLocations', copy.locations]]) {
      const rows = jobs[key];
      if (rows?.length) sections.jobs.push(`### ${heading}\n${mdTable([copy.entity, copy.count], rows.map(row => [key === 'topLocations' ? localizeBorderWaitName(row.name, locale) : row.name, fmt(locale, row.count)]))}`);
    }
  }
  return sections;
}

function buildLocaleContent(locale, brief, headline) {
  const t = T[locale];
  const blocks = projectDailyBriefForLocale(brief, locale).blocks;
  const localeHeadline = ['borderWait', 'borderWaitChange'].includes(headline?.kind)
    ? {
      ...headline,
      name: localizeBorderWaitName(headline.name, locale, brief.blocks?.borderWait?.worst?.slug),
    }
    : headline;
  const dateLabel = humanDate(brief.dateIso, locale);
  const wd = weekday(brief.dateIso, locale);
  const insights = insightSections(locale, brief);

  // body1 — intro + border waits
  const parts1 = [t.primaryInsight(localeHeadline), t.intro(wd, dateLabel)];
  const bw = blocks.borderWait;
  parts1.push(`## ${t.bwH}`);
  if (bw?.available) {
    parts1.push(t.bwLead(bw));
    const top = bw.crossings.filter((c) => c.waitMinutes > 0).slice(0, 5);
    if (top.length >= 2) {
      parts1.push(mdTable(t.bwCols, top.map((c) => [c.name, t.bwMin(c.waitMinutes), STATUS_LABEL[locale][c.status] || '—'])));
    }
    parts1.push(...insights.borderWait, t.bwLink);
  } else {
    parts1.push(t.bwDown);
  }

  // body2 — fuel
  const parts2 = [`## ${t.fuelH}`];
  const fuel = blocks.fuel;
  if (fuel?.available) {
    // The lead sentence asserts three counted facts ("su N comuni monitorati …
    // in Svizzera in X casi e in Italia in Y"). `shapeFuel` now reports an
    // unreadable summary field as `null` instead of coercing it to 0, and a
    // sentence that says "in 0 casi" from a field the producer never sent is a
    // fabricated number in a bulletin that sells itself on measured ones. No
    // counters, no sentence: the table below carries the section on its own.
    if ([fuel.municipalityCount, fuel.cheaperSwissCount, fuel.cheaperItalyCount].every((n) => Number.isFinite(n))) {
      parts2.push(t.fuelLead(fuel));
    }
    if (fuel.cheapestItaly.length >= 2) {
      parts2.push(mdTable(t.fuelCols, fuel.cheapestItaly.map((m) => [`${m.municipality} (${m.province})`, t.fuelPrice(m.minPriceEur)])));
    }
    const leadFuel = headline?.kind === 'fuelSaving'
      ? fuel.bestSavings.find(row => row.municipality === headline.municipality
        && row.italyObservedAt === headline.italyObservedAt
        && row.swissObservedAt === headline.swissObservedAt
        && fuelSourceTimeZone(row.italyTimeZone, ITALY_FUEL_TIME_ZONE) === headline.italyTimeZone
        && fuelSourceTimeZone(row.swissTimeZone, SWISS_FUEL_TIME_ZONE) === headline.swissTimeZone
        && row.italyPriceEur === headline.italyPriceEur
        && row.swissPriceEur === headline.swissPriceEur
        && row.saving50LEur === headline.saving50LEur)
      : fuel.bestSavings[0];
    if (leadFuel) parts2.push(t.fuelSaving(leadFuel));
    const swiss = t.fuelSwiss(fuel.cheapestSwissStation);
    if (swiss) parts2.push(swiss);
    parts2.push(...insights.fuel, t.fuelLink);
  } else {
    parts2.push(t.fuelDown);
  }

  // body3 — exchange
  const parts3 = [`## ${t.fxH}`];
  const fx = blocks.exchange;
  if (fx?.available) {
    parts3.push(t.fxLead(fx));
    parts3.push(...insights.exchange);
    parts3.push(t.fxWhy);
  } else {
    parts3.push(t.fxDown);
  }

  // body4 — jobs + method. Only active totals are reported: date-keyed history
  // does not prove that a prior calendar day has finished accumulating.
  const parts4 = [`## ${t.jobsH}`];
  const jobs = blocks.jobs;
  if (jobs?.available) {
    parts4.push(t.jobsLeadTotal(jobs));
    parts4.push(t.jobsLink);
  } else {
    parts4.push(t.jobsDown);
  }
  parts4.push(...insights.jobs);
  const demand = brief.insights?.searchDemand;
  if (demand?.available && demand.topics?.length) {
    const copy = INSIGHT_COPY[locale];
    const rows = demand.topics.filter(row => DEMAND_THEMES[row.theme]);
    if (rows.length) {
      parts4.push(`## ${copy.search}\n${demand.startDate} → ${demand.endDate}`);
      parts4.push(mdTable([copy.theme, copy.demand, copy.searches], rows.map(row => [
        DEMAND_THEMES[row.theme][LOCALES.indexOf(locale)],
        demand.sources.gsc ? fmt(locale, row.impressions) : '—',
        demand.sources.ga4 ? fmt(locale, row.searches) : '—',
      ])));
      parts4.push(copy.note);
      parts4.push(`${copy.source}: ${[demand.sources.gsc ? 'Google Search Console' : '', demand.sources.ga4 ? 'Firebase Analytics / GA4' : ''].filter(Boolean).join(', ')}${demand.partial ? ` (${copy.sample})` : ''}.`);
    }
  }
  parts4.push(`## ${t.methodH}`);
  parts4.push(t.method);

  // `seoDescription` / `ogDescription` ride along on the locale content so the
  // test suite can measure all four locales, and so a future site-side change
  // can pick up the localized ones. They are NOT written to blog-meta-*.ts:
  // `buildMetaBlock` emits title/excerpt/imageAlt only, and `buildBodyFile`
  // scans body1..bodyN — extra keys here are inert in the corpus surface.
  return {
    title: t.title(dateLabel, t.headline(localeHeadline), headline?.kind),
    excerpt: t.excerpt(dateLabel),
    seoDescription: t.seoDescription(dateLabel),
    ogDescription: t.ogDescription(dateLabel),
    body1: parts1.join('\n\n'),
    body2: parts2.join('\n\n'),
    body3: parts3.join('\n\n'),
    body4: parts4.join('\n\n'),
    faq: t.faq({ dateLabel }),
  };
}

/** An edition with one lone block is a stub, not a bulletin. */
export const MIN_AVAILABLE_BLOCKS = 2;

/**
 * Load the day's snapshot, or `{ brief: null, reason }` when it must be
 * refused (missing, stale dateIso, or too few available blocks). Lives here —
 * not in the generator script — so `node --test` can exercise the refusal
 * rules without importing create-article.mjs, whose static deps (jsdom) exist
 * only where `npm ci` ran.
 */
export function loadSnapshot(todayIso, snapshotPath) {
  if (!existsSync(snapshotPath)) return { brief: null, reason: 'snapshot missing (refresh has not run)' };
  let brief;
  try {
    brief = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
  } catch (err) {
    return { brief: null, reason: `snapshot is not valid JSON: ${err.message}` };
  }
  if (brief?.dateIso !== todayIso) {
    return { brief: null, reason: `snapshot is for ${brief?.dateIso ?? 'unknown'}, today is ${todayIso} — stale, refusing` };
  }
  const available = Number(brief?.counts?.availableBlocks);
  if (!Number.isFinite(available) || available < MIN_AVAILABLE_BLOCKS) {
    return { brief: null, reason: `only ${available || 0} available blocks (min ${MIN_AVAILABLE_BLOCKS}) — too thin for an edition` };
  }
  // Defensive recount from the flags themselves: a snapshot whose counter
  // disagrees with its own blocks (producer bug, hand-edited file) must be a
  // refusal here — not a downstream throw that turns the cron red (second
  // review on PR #51, adversarial check).
  const realAvailable = Object.values(brief.blocks || {}).filter((b) => b?.available).length;
  if (realAvailable < MIN_AVAILABLE_BLOCKS) {
    return { brief: null, reason: `counter says ${available} but only ${realAvailable} blocks are actually available — inconsistent snapshot, refusing` };
  }
  return { brief, reason: null };
}

/** Build the full registration `data` object (create-article.mjs shape). */
export function buildData(brief) {
  const article = buildDailyBriefArticle(brief);
  const author = pickDailyAuthor(brief.dateIso);
  const it = article.content.it;
  return {
    id: article.id,
    category: 'novita',
    // Catalog fallback name (required by the registrar's shape); the generated
    // hero wins via _generatedImagePath.
    image: 'lugano-view.webp',
    hasCalculator: false,
    author,
    seo: {
      title: it.title,
      // NOT `it.excerpt`. The excerpt is the reader-facing teaser and is
      // deliberately ~280 chars; this is the SERP snippet and is written for
      // 160. Collapsing the two is the defect #79/#80 came from — the SERP
      // budget ended up governing what the reader was allowed to see.
      // `structuredData.description` in the SEO entry is emitted from this same
      // field, so it inherits the 160-char budget.
      description: it.seoDescription,
      // 'dogana' is deliberate: it is a news-sitemap whitelist token, so each
      // edition becomes Google News-eligible inside the 48h window on its own.
      keywords:
        'bollettino frontaliere, dogana, attesa dogana, code valichi ticino, prezzi benzina confine, cambio franco euro, lavoro svizzera, frontalieri ticino',
      ogTitle: it.title,
      // Facebook/LinkedIn/WhatsApp show far more than a SERP: the social card
      // gets its own ~210-char text, capped at 250 by the safety net.
      ogDescription: it.ogDescription,
      headline: it.title,
      breadcrumbName: `Bollettino ${humanDate(brief.dateIso, 'it')}`,
    },
    slugs: article.slugs,
    imageAlt: article.imageAlt,
    content: article.content,
    // body4 is a deterministic bulletin section, not LLM prose. The shared
    // gate uses this marker to keep cross-section numeric checks while
    // excluding only paragraph heuristics calibrated on LLM output (#1144).
    _deterministicBodySections: ['body4'],
    _generatedImagePath: `/images/blog/${article.id}.webp`,
    _headline: article._headline,
  };
}

/**
 * Build the 4-locale article payload from a daily-brief snapshot.
 * @returns {{ id, slugs, imageAlt, content, _headline }}
 */
export function buildDailyBriefArticle(brief) {
  if (!brief || typeof brief !== 'object' || !brief.dateIso) {
    throw new Error('buildDailyBriefArticle: brief snapshot missing/invalid');
  }
  const headline = pickHeadline(brief.blocks || {}, brief.insights || {}, brief.dateIso);
  if (!headline) throw new Error('buildDailyBriefArticle: no available block to headline from');
  const content = {};
  const imageAlt = {};
  for (const locale of LOCALES) {
    content[locale] = buildLocaleContent(locale, brief, headline);
    imageAlt[locale] = T[locale].imageAlt(humanDate(brief.dateIso, locale));
  }
  return {
    id: dailyBriefArticleId(brief.dateIso),
    slugs: dailyBriefSlugs(brief.dateIso),
    imageAlt,
    content,
    _headline: headline,
  };
}
