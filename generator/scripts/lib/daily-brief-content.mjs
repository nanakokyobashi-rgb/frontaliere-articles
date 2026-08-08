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
 * The proprietary number that leads the title. Cascade: a real queue beats
 * everything (it is the one number nobody else has), then yesterday's job
 * count, then the exchange rate, then fuel.
 *
 * The cascade is TOTAL over available blocks — proven by the enumeration test
 * in daily-brief-content.test.mjs: whenever ≥1 block is `available`, a
 * headline exists. That totality is load-bearing: shapeFuel can be available
 * with an empty cheapestItaly (bestSavings only), shapeJobs with a null
 * yesterdayAdded — without the terminal fallbacks below, that combination
 * made buildDailyBriefArticle throw and the cron exit 1, violating the
 * "a day without data must not break the cron" contract (review finding on
 * PR #51). `null` is still returned for zero available blocks, which
 * loadSnapshot refuses long before this runs.
 */
export function pickHeadline(blocks) {
  const bw = blocks.borderWait;
  if (bw?.available && bw.worst?.waitMinutes >= 10) {
    return { kind: 'borderWait', name: bw.worst.name, minutes: bw.worst.waitMinutes };
  }
  const jobs = blocks.jobs;
  if (jobs?.available && Number.isFinite(jobs.yesterdayAdded) && jobs.yesterdayAdded >= 25) {
    return { kind: 'jobs', count: jobs.yesterdayAdded };
  }
  const fx = blocks.exchange;
  if (fx?.available) return { kind: 'exchange', rate: fx.rate };
  const fuel = blocks.fuel;
  if (fuel?.available && fuel.cheapestItaly[0]) {
    return { kind: 'fuel', municipality: fuel.cheapestItaly[0].municipality, priceEur: fuel.cheapestItaly[0].minPriceEur };
  }
  // Terminal fallbacks — sub-threshold numbers still beat no edition.
  if (bw?.available) return { kind: 'borderWait', name: bw.worst.name, minutes: bw.worst.waitMinutes };
  if (jobs?.available && Number.isFinite(jobs.yesterdayAdded)) return { kind: 'jobs', count: jobs.yesterdayAdded };
  if (jobs?.available) return { kind: 'jobsTotal', count: jobs.activeJobs };
  if (fuel?.available && fuel.bestSavings[0]) {
    const s = fuel.bestSavings[0];
    return { kind: 'fuelSaving', municipality: s.municipality, saving50LEur: s.saving50LEur };
  }
  return null;
}

const T = {
  it: {
    briefName: 'Bollettino del frontaliere',
    headline: (h) => ({
      borderWait: `a ${h.name} ${h.minutes} minuti di coda`,
      jobs: `${fmt('it', h.count)} nuovi annunci di lavoro ieri`,
      jobsTotal: `${fmt('it', h.count)} annunci di lavoro attivi in Svizzera`,
      exchange: `franco a ${fmt('it', h.rate, 4)} €`,
      fuel: `benzina da ${fmt('it', h.priceEur, 3)} €/L a ${h.municipality}`,
      fuelSaving: `a ${h.municipality} il pieno giusto vale ${fmt('it', h.saving50LEur, 0)} €`,
    })[h.kind],
    title: (dateLabel, headline) => `Bollettino del frontaliere – ${dateLabel}: ${headline}`,
    excerpt: (dateLabel) =>
      `I numeri di oggi, ${dateLabel}, per chi attraversa il confine: attese ai valichi misurate stamattina, i comuni dove la benzina costa meno, il cambio franco–euro e i nuovi annunci di lavoro in Svizzera. Dati raccolti dal nostro monitoraggio, aggiornati ogni giorno.`,
    imageAlt: (dateLabel) => `I numeri del giorno per i frontalieri – ${dateLabel}: attese ai valichi, prezzi benzina, cambio franco-euro e annunci di lavoro`,
    intro: (wd, dateLabel) =>
      `Buongiorno, è ${wd} ${dateLabel}. Questo è il bollettino quotidiano per chi vive da una parte del confine e lavora dall'altra: quattro numeri misurati oggi dal nostro monitoraggio — code ai valichi, benzina, cambio e lavoro — con i link alle pagine live per seguirli durante la giornata.`,
    bwH: 'Attese ai valichi stamattina',
    bwLead: (b) =>
      b.worst.waitMinutes >= 10
        ? `Il rilevamento più recente (${b.count} valichi monitorati) segna l'attesa più lunga a **${b.worst.name}: ${b.worst.waitMinutes} minuti**. ${b.zeroWaitCount} valichi risultano senza coda.`
        : `Stamattina si passa: su ${b.count} valichi monitorati, ${b.zeroWaitCount} risultano senza coda e l'attesa più lunga è di appena **${b.worst.waitMinutes} minuti** (${b.worst.name}).`,
    bwCols: ['Valico', 'Attesa', 'Stato'],
    bwMin: (n) => `${n} min`,
    bwLink: `Il traffico cambia di ora in ora: la situazione live di ogni valico è sulla [pagina del traffico alle dogane](${HUB.traffic.it}).`,
    bwDown: '⚠️ Il monitoraggio dei valichi non ha dati freschi stamattina: il blocco torna nella prossima edizione. La situazione live resta sulla [pagina del traffico alle dogane](/traffico-dogane/).',
    fuelH: 'Benzina: dove costa meno oggi',
    fuelLead: (f) =>
      `Su ${f.municipalityCount} comuni di confine monitorati, oggi conviene fare il pieno in Svizzera in ${f.cheaperSwissCount} casi e in Italia in ${f.cheaperItalyCount}.`,
    fuelCols: ['Comune (IT)', 'Verde, prezzo minimo'],
    fuelPrice: (p) => `${fmt('it', p, 3)} €/L`,
    fuelSaving: (s) =>
      `📊 **Il pieno giusto dal lato giusto.** A **${s.municipality}** (${s.province}) il divario oggi vale **${fmt('it', s.saving50LEur, 2)} € su un pieno da 50 litri** (${fmt('it', s.italyPriceEur, 3)} €/L in Italia contro ${fmt('it', s.swissPriceEur, 3)} €/L al distributore svizzero più vicino).`,
    fuelSwiss: (st) =>
      st ? `Il distributore svizzero più economico oggi è **${st.name}** (${fmt('it', st.sp95PriceChf, 2)} CHF/L, ≈ ${fmt('it', st.sp95PriceEur, 3)} €/L), vicino a ${st.nearestMunicipality}.` : '',
    fuelLink: `Prezzi comune per comune, aggiornati ogni giorno: [prezzi benzina al confine, oggi](${HUB.fuel.it}).`,
    fuelDown: '⚠️ I prezzi carburante non sono stati aggiornati nelle ultime 48 ore: il blocco torna appena la fonte riprende. Intanto: [prezzi benzina al confine](/prezzi-benzina/oggi/).',
    fxH: 'Cambio franco–euro',
    fxLead: (e) =>
      `Un franco vale **${fmt('it', e.rate, 4)} €** (chiusura ${e.lastDate}). Rispetto al giorno precedente ${describeDeltaIt(e.delta1d)}; su sette giorni la variazione è di ${signed('it', e.delta7d, 4)} €.`,
    fxWhy: `💡 Per chi prende lo stipendio in franchi e spende in euro, il cambio È una parte dello stipendio: su 4.000 CHF, un centesimo di variazione vale 40 € al mese. Il [calcolatore dello stipendio netto](${HUB.salary.it}) e il [confronto dei servizi di cambio](${HUB.fx.it}) fanno i conti sul tuo caso.`,
    fxDown: '⚠️ La serie del cambio non è aggiornata: il blocco torna nella prossima edizione. Il confronto dei servizi di cambio resta [qui](/compara-servizi/cambio-franco-euro/).',
    jobsH: 'Lavoro: i numeri di ieri',
    jobsLead: (j) =>
      `Ieri sono arrivati **${fmt('it', j.yesterdayAdded)} nuovi annunci** di lavoro in Svizzera sul nostro job board; negli ultimi sette giorni ${fmt('it', j.last7dAdded)}. In totale gli annunci attivi sono **${fmt('it', j.activeJobs)}**${j.activeCompanies ? `, da ${fmt('it', j.activeCompanies)} aziende` : ''}.`,
    jobsLeadTotal: (j) =>
      `Sul nostro job board gli annunci di lavoro attivi in Svizzera sono **${fmt('it', j.activeJobs)}**${j.activeCompanies ? `, da ${fmt('it', j.activeCompanies)} aziende` : ''}${Number.isFinite(j.last7dAdded) ? `; negli ultimi sette giorni ne sono arrivati ${fmt('it', j.last7dAdded)} nuovi` : ''}.`,
    jobsLink: `Le offerte si filtrano per cantone, settore e città: [cerca lavoro in Ticino e in Svizzera](${HUB.jobs.it}).`,
    jobsDown: '⚠️ Le statistiche del job board non sono aggiornate: il blocco torna nella prossima edizione. Gli annunci restano su [cerca lavoro](/cerca-lavoro-ticino/).',
    methodH: 'Come nasce questo bollettino',
    method:
      `I numeri qui sopra non arrivano da un'agenzia: sono il nostro monitoraggio. Le attese ai valichi vengono campionate più volte l'ora su tutti i valichi di confine svizzeri; i prezzi dei carburanti coprono i comuni italiani di fascia e i distributori svizzeri vicini al confine; il cambio segue la serie ufficiale giornaliera; gli annunci arrivano dai crawler del nostro job board. Il bollettino esce ogni mattina presto, prima del pendolarismo — i numeri fotografano la situazione al momento della pubblicazione, le pagine linkate restano live tutto il giorno.`,
    faq: (ctx) => [
      { q: 'Quando esce il bollettino del frontaliere?', a: `Ogni mattina presto, prima dell'ora di punta. Questa edizione è del ${ctx.dateLabel}, con dati raccolti nelle ore precedenti la pubblicazione.` },
      { q: 'Da dove arrivano i dati?', a: 'Dal monitoraggio proprietario di frontaliereticino.ch: rilevamento delle code su tutti i valichi svizzeri, prezzi carburante nei comuni di confine, serie giornaliera del cambio CHF/EUR e crawler del job board. Nessun dato di seconda mano.' },
      { q: 'I numeri restano validi tutta la giornata?', a: 'No: fotografano il momento della pubblicazione. Per la situazione in tempo reale usa le pagine live linkate in ogni sezione, aggiornate durante tutta la giornata.' },
    ],
  },
  en: {
    briefName: 'Cross-border daily brief',
    headline: (h) => ({
      borderWait: `${h.minutes}-minute queue at ${h.name}`,
      jobs: `${fmt('en', h.count)} new job listings yesterday`,
      jobsTotal: `${fmt('en', h.count)} active job listings in Switzerland`,
      exchange: `franc at €${fmt('en', h.rate, 4)}`,
      fuel: `petrol from €${fmt('en', h.priceEur, 3)}/L in ${h.municipality}`,
      fuelSaving: `the right fill-up in ${h.municipality} is worth €${fmt('en', h.saving50LEur, 0)}`,
    })[h.kind],
    title: (dateLabel, headline) => `Cross-border daily brief – ${dateLabel}: ${headline}`,
    excerpt: (dateLabel) =>
      `Today's numbers (${dateLabel}) for cross-border commuters: border waits measured this morning, the cheapest fuel municipalities, the CHF–EUR rate and new Swiss job listings. Proprietary monitoring, updated daily.`,
    imageAlt: (dateLabel) => `The day's numbers for cross-border commuters – ${dateLabel}: border waits, fuel prices, CHF-EUR rate and job listings`,
    intro: (wd, dateLabel) =>
      `Good morning — it's ${wd}, ${dateLabel}. This is the daily brief for people who live on one side of the border and work on the other: four numbers measured today by our monitoring — border queues, fuel, the exchange rate and jobs — each with a link to its live page.`,
    bwH: 'Border waits this morning',
    bwLead: (b) =>
      b.worst.waitMinutes >= 10
        ? `The latest reading (${b.count} crossings monitored) puts the longest wait at **${b.worst.name}: ${b.worst.waitMinutes} minutes**. ${b.zeroWaitCount} crossings report no queue.`
        : `Smooth crossing this morning: of ${b.count} monitored crossings, ${b.zeroWaitCount} report no queue and the longest wait is just **${b.worst.waitMinutes} minutes** (${b.worst.name}).`,
    bwCols: ['Crossing', 'Wait', 'Status'],
    bwMin: (n) => `${n} min`,
    bwLink: `Traffic shifts by the hour — every crossing's live status is on the [border traffic page](${HUB.traffic.en}).`,
    bwDown: '⚠️ Border monitoring has no fresh data this morning; this section returns in the next edition. Live status stays on the [border traffic page](/en/border-wait/).',
    fuelH: 'Fuel: where it costs least today',
    fuelLead: (f) =>
      `Across ${f.municipalityCount} monitored border municipalities, filling up is cheaper in Switzerland in ${f.cheaperSwissCount} of them and in Italy in ${f.cheaperItalyCount}.`,
    fuelCols: ['Municipality (IT)', 'Unleaded, lowest price'],
    fuelPrice: (p) => `€${fmt('en', p, 3)}/L`,
    fuelSaving: (s) =>
      `📊 **The right side for a full tank.** In **${s.municipality}** (${s.province}) today's gap is worth **€${fmt('en', s.saving50LEur, 2)} on a 50-litre tank** (€${fmt('en', s.italyPriceEur, 3)}/L in Italy vs €${fmt('en', s.swissPriceEur, 3)}/L at the nearest Swiss station).`,
    fuelSwiss: (st) =>
      st ? `The cheapest Swiss station today is **${st.name}** (CHF ${fmt('en', st.sp95PriceChf, 2)}/L, ≈ €${fmt('en', st.sp95PriceEur, 3)}/L), near ${st.nearestMunicipality}.` : '',
    fuelLink: `Prices town by town, updated daily: [border fuel prices today](${HUB.fuel.en}).`,
    fuelDown: '⚠️ Fuel prices have not refreshed in the last 48 hours; this section returns once the source is back. Meanwhile: [border fuel prices](/en/gasoline-price-switzerland/today/).',
    fxH: 'CHF–EUR exchange rate',
    fxLead: (e) =>
      `One franc buys **€${fmt('en', e.rate, 4)}** (close of ${e.lastDate}). Versus the previous day ${describeDeltaEn(e.delta1d)}; over seven days the move is ${signed('en', e.delta7d, 4)} €.`,
    fxWhy: `💡 If you earn francs and spend euros, the rate IS part of your salary: on CHF 4,000, one cent of movement is worth €40 a month. The [net salary calculator](${HUB.salary.en}) and the [currency-exchange comparison](${HUB.fx.en}) run the numbers for your case.`,
    fxDown: '⚠️ The exchange-rate series is not up to date; this section returns in the next edition. The exchange comparison stays [here](/en/service-comparison/chf-eur-exchange-rate/).',
    jobsH: 'Jobs: yesterday’s numbers',
    jobsLead: (j) =>
      `**${fmt('en', j.yesterdayAdded)} new Swiss job listings** landed on our job board yesterday; ${fmt('en', j.last7dAdded)} over the last seven days. Active listings now total **${fmt('en', j.activeJobs)}**${j.activeCompanies ? ` from ${fmt('en', j.activeCompanies)} companies` : ''}.`,
    jobsLeadTotal: (j) =>
      `Our job board currently carries **${fmt('en', j.activeJobs)} active Swiss job listings**${j.activeCompanies ? ` from ${fmt('en', j.activeCompanies)} companies` : ''}${Number.isFinite(j.last7dAdded) ? `; ${fmt('en', j.last7dAdded)} new ones arrived over the last seven days` : ''}.`,
    jobsLink: `Filter by canton, sector and city: [find jobs in Ticino and Switzerland](${HUB.jobs.en}).`,
    jobsDown: '⚠️ Job-board statistics are not up to date; this section returns in the next edition. Listings stay on [find jobs](/en/find-jobs-ticino/).',
    methodH: 'How this brief is made',
    method:
      'None of the numbers above come from an agency feed — they are our own monitoring: border queues sampled several times an hour at every Swiss crossing, fuel prices across Italian border municipalities and nearby Swiss stations, the official daily CHF/EUR series, and our job-board crawlers. The brief goes out early each morning, before the commute; numbers are a snapshot at publication time, the linked pages stay live all day.',
    faq: (ctx) => [
      { q: 'When is the cross-border daily brief published?', a: `Early every morning, before rush hour. This edition is dated ${ctx.dateLabel}, with data collected in the hours before publication.` },
      { q: 'Where does the data come from?', a: 'From frontaliereticino.ch’s proprietary monitoring: queue sampling at every Swiss border crossing, fuel prices in border municipalities, the daily CHF/EUR series and our job-board crawlers. No second-hand data.' },
      { q: 'Do the numbers stay valid all day?', a: 'No — they are a snapshot at publication time. For real-time status use the live pages linked in each section, updated throughout the day.' },
    ],
  },
  de: {
    briefName: 'Grenzgänger-Tagesbulletin',
    headline: (h) => ({
      borderWait: `${h.minutes} Minuten Wartezeit in ${h.name}`,
      jobs: `${fmt('de', h.count)} neue Stellenangebote gestern`,
      jobsTotal: `${fmt('de', h.count)} aktive Stellenangebote in der Schweiz`,
      exchange: `Franken bei ${fmt('de', h.rate, 4)} €`,
      fuel: `Benzin ab ${fmt('de', h.priceEur, 3)} €/L in ${h.municipality}`,
      fuelSaving: `in ${h.municipality} ist die richtige Tankfüllung ${fmt('de', h.saving50LEur, 0)} € wert`,
    })[h.kind],
    title: (dateLabel, headline) => `Grenzgänger-Tagesbulletin – ${dateLabel}: ${headline}`,
    excerpt: (dateLabel) =>
      `Die Zahlen von heute (${dateLabel}) für Grenzgänger: heute Morgen gemessene Wartezeiten an den Grenzübergängen, die günstigsten Tank-Gemeinden, der CHF-EUR-Kurs und neue Stellenangebote in der Schweiz. Eigene Messung, täglich aktualisiert.`,
    imageAlt: (dateLabel) => `Die Zahlen des Tages für Grenzgänger – ${dateLabel}: Wartezeiten, Benzinpreise, CHF-EUR-Kurs und Stellenangebote`,
    intro: (wd, dateLabel) =>
      `Guten Morgen — heute ist ${wd}, der ${dateLabel}. Das ist das tägliche Bulletin für alle, die auf der einen Seite der Grenze wohnen und auf der anderen arbeiten: vier heute gemessene Zahlen — Staus an den Übergängen, Benzin, Wechselkurs und Arbeitsmarkt — jeweils mit Link zur Live-Seite.`,
    bwH: 'Wartezeiten an der Grenze heute Morgen',
    bwLead: (b) =>
      b.worst.waitMinutes >= 10
        ? `Die jüngste Messung (${b.count} überwachte Übergänge) zeigt die längste Wartezeit in **${b.worst.name}: ${b.worst.waitMinutes} Minuten**. ${b.zeroWaitCount} Übergänge melden keine Warteschlange.`
        : `Heute Morgen läuft es: Von ${b.count} überwachten Übergängen melden ${b.zeroWaitCount} keine Warteschlange, die längste Wartezeit beträgt nur **${b.worst.waitMinutes} Minuten** (${b.worst.name}).`,
    bwCols: ['Übergang', 'Wartezeit', 'Status'],
    bwMin: (n) => `${n} Min.`,
    bwLink: `Der Verkehr ändert sich stündlich — der Live-Status jedes Übergangs steht auf der [Seite zur Wartezeit an der Grenze](${HUB.traffic.de}).`,
    bwDown: '⚠️ Die Grenzüberwachung hat heute Morgen keine frischen Daten; der Abschnitt kehrt in der nächsten Ausgabe zurück. Live-Status: [Wartezeit an der Grenze](/de/wartezeit-grenze/).',
    fuelH: 'Benzin: Wo es heute am wenigsten kostet',
    fuelLead: (f) =>
      `In ${f.municipalityCount} überwachten Grenzgemeinden lohnt sich das Tanken heute in ${f.cheaperSwissCount} Fällen in der Schweiz und in ${f.cheaperItalyCount} in Italien.`,
    fuelCols: ['Gemeinde (IT)', 'Bleifrei, Tiefstpreis'],
    fuelPrice: (p) => `${fmt('de', p, 3)} €/L`,
    fuelSaving: (s) =>
      `📊 **Die richtige Seite für eine volle Tankfüllung.** In **${s.municipality}** (${s.province}) ist die Differenz heute **${fmt('de', s.saving50LEur, 2)} € pro 50-Liter-Tank** wert (${fmt('de', s.italyPriceEur, 3)} €/L in Italien gegenüber ${fmt('de', s.swissPriceEur, 3)} €/L an der nächsten Schweizer Tankstelle).`,
    fuelSwiss: (st) =>
      st ? `Die günstigste Schweizer Tankstelle ist heute **${st.name}** (${fmt('de', st.sp95PriceChf, 2)} CHF/L, ≈ ${fmt('de', st.sp95PriceEur, 3)} €/L), bei ${st.nearestMunicipality}.` : '',
    fuelLink: `Preise Gemeinde für Gemeinde, täglich aktualisiert: [Benzinpreise an der Grenze, heute](${HUB.fuel.de}).`,
    fuelDown: '⚠️ Die Kraftstoffpreise wurden seit 48 Stunden nicht aktualisiert; der Abschnitt kehrt zurück, sobald die Quelle wieder liefert. Inzwischen: [Benzinpreise an der Grenze](/de/benzinpreis-schweiz/heute/).',
    fxH: 'Wechselkurs Franken–Euro',
    fxLead: (e) =>
      `Ein Franken ist **${fmt('de', e.rate, 4)} €** wert (Schluss ${e.lastDate}). Gegenüber dem Vortag ${describeDeltaDe(e.delta1d)}; über sieben Tage beträgt die Veränderung ${signed('de', e.delta7d, 4)} €.`,
    fxWhy: `💡 Wer in Franken verdient und in Euro ausgibt, für den IST der Kurs ein Teil des Lohns: Bei 4.000 CHF ist ein Rappen Bewegung 40 € im Monat wert. Der [Nettolohn-Rechner](${HUB.salary.de}) und der [Vergleich der Wechseldienste](${HUB.fx.de}) rechnen Ihren Fall durch.`,
    fxDown: '⚠️ Die Kursreihe ist nicht aktuell; der Abschnitt kehrt in der nächsten Ausgabe zurück. Der Vergleich der Wechseldienste bleibt [hier](/de/service-vergleich/chf-eur-wechselkurs/).',
    jobsH: 'Arbeitsmarkt: die Zahlen von gestern',
    jobsLead: (j) =>
      `Gestern kamen **${fmt('de', j.yesterdayAdded)} neue Stellenangebote** in der Schweiz auf unser Job-Board; in den letzten sieben Tagen ${fmt('de', j.last7dAdded)}. Insgesamt sind **${fmt('de', j.activeJobs)}** Anzeigen aktiv${j.activeCompanies ? `, von ${fmt('de', j.activeCompanies)} Unternehmen` : ''}.`,
    jobsLeadTotal: (j) =>
      `Auf unserem Job-Board sind derzeit **${fmt('de', j.activeJobs)} Stellenangebote in der Schweiz aktiv**${j.activeCompanies ? `, von ${fmt('de', j.activeCompanies)} Unternehmen` : ''}${Number.isFinite(j.last7dAdded) ? `; in den letzten sieben Tagen kamen ${fmt('de', j.last7dAdded)} neue hinzu` : ''}.`,
    jobsLink: `Nach Kanton, Branche und Stadt filtern: [Jobs im Tessin und in der Schweiz](${HUB.jobs.de}).`,
    jobsDown: '⚠️ Die Job-Board-Statistik ist nicht aktuell; der Abschnitt kehrt in der nächsten Ausgabe zurück. Die Angebote bleiben unter [Jobs im Tessin](/de/jobs-im-tessin/).',
    methodH: 'Wie dieses Bulletin entsteht',
    method:
      'Keine der Zahlen oben stammt aus einem Agentur-Feed — es ist unsere eigene Messung: mehrmals pro Stunde erfasste Warteschlangen an jedem Schweizer Grenzübergang, Kraftstoffpreise in den italienischen Grenzgemeinden und an nahen Schweizer Tankstellen, die offizielle tägliche CHF/EUR-Reihe und die Crawler unseres Job-Boards. Das Bulletin erscheint früh am Morgen, vor dem Pendlerverkehr; die Zahlen sind eine Momentaufnahme zum Zeitpunkt der Veröffentlichung, die verlinkten Seiten bleiben den ganzen Tag live.',
    faq: (ctx) => [
      { q: 'Wann erscheint das Grenzgänger-Tagesbulletin?', a: `Jeden Morgen früh, vor der Hauptverkehrszeit. Diese Ausgabe ist vom ${ctx.dateLabel}, mit Daten aus den Stunden vor der Veröffentlichung.` },
      { q: 'Woher stammen die Daten?', a: 'Aus der eigenen Messung von frontaliereticino.ch: Stau-Erfassung an jedem Schweizer Grenzübergang, Kraftstoffpreise in den Grenzgemeinden, die tägliche CHF/EUR-Reihe und die Crawler des Job-Boards. Keine Daten aus zweiter Hand.' },
      { q: 'Gelten die Zahlen den ganzen Tag?', a: 'Nein — sie sind eine Momentaufnahme zum Zeitpunkt der Veröffentlichung. Für den Echtzeit-Status nutzen Sie die in jedem Abschnitt verlinkten Live-Seiten.' },
    ],
  },
  fr: {
    briefName: 'Bulletin quotidien du frontalier',
    headline: (h) => ({
      borderWait: `${h.minutes} minutes d'attente à ${h.name}`,
      jobs: `${fmt('fr', h.count)} nouvelles offres d'emploi hier`,
      jobsTotal: `${fmt('fr', h.count)} offres d'emploi actives en Suisse`,
      exchange: `franc à ${fmt('fr', h.rate, 4)} €`,
      fuel: `essence dès ${fmt('fr', h.priceEur, 3)} €/L à ${h.municipality}`,
      fuelSaving: `à ${h.municipality}, le bon plein vaut ${fmt('fr', h.saving50LEur, 0)} €`,
    })[h.kind],
    title: (dateLabel, headline) => `Bulletin du frontalier – ${dateLabel} : ${headline}`,
    excerpt: (dateLabel) =>
      `Les chiffres du jour (${dateLabel}) pour les frontaliers : attentes aux douanes mesurées ce matin, les communes où l'essence coûte le moins cher, le taux CHF-EUR et les nouvelles offres d'emploi en Suisse. Suivi propriétaire, mis à jour chaque jour.`,
    imageAlt: (dateLabel) => `Les chiffres du jour pour les frontaliers – ${dateLabel} : attentes aux douanes, prix de l'essence, taux CHF-EUR et offres d'emploi`,
    intro: (wd, dateLabel) =>
      `Bonjour — nous sommes ${wd} ${dateLabel}. Voici le bulletin quotidien pour celles et ceux qui vivent d'un côté de la frontière et travaillent de l'autre : quatre chiffres mesurés aujourd'hui par notre suivi — files aux douanes, essence, taux de change et emploi — chacun avec le lien vers sa page en direct.`,
    bwH: 'Attentes aux douanes ce matin',
    bwLead: (b) =>
      b.worst.waitMinutes >= 10
        ? `Le dernier relevé (${b.count} passages surveillés) place l'attente la plus longue à **${b.worst.name} : ${b.worst.waitMinutes} minutes**. ${b.zeroWaitCount} passages ne signalent aucune file.`
        : `Ça roule ce matin : sur ${b.count} passages surveillés, ${b.zeroWaitCount} ne signalent aucune file et l'attente la plus longue n'est que de **${b.worst.waitMinutes} minutes** (${b.worst.name}).`,
    bwCols: ['Douane', 'Attente', 'État'],
    bwMin: (n) => `${n} min`,
    bwLink: `Le trafic change d'heure en heure — l'état en direct de chaque douane est sur la [page du temps d'attente](${HUB.traffic.fr}).`,
    bwDown: '⚠️ Le suivi des douanes n’a pas de données fraîches ce matin ; la section revient dans la prochaine édition. L’état en direct reste sur la [page du temps d’attente](/fr/temps-attente-douane/).',
    fuelH: 'Essence : où elle coûte le moins cher aujourd’hui',
    fuelLead: (f) =>
      `Sur ${f.municipalityCount} communes frontalières suivies, faire le plein revient aujourd'hui moins cher en Suisse dans ${f.cheaperSwissCount} cas et en Italie dans ${f.cheaperItalyCount}.`,
    fuelCols: ['Commune (IT)', 'Sans plomb, prix minimum'],
    fuelPrice: (p) => `${fmt('fr', p, 3)} €/L`,
    fuelSaving: (s) =>
      `📊 **Le bon côté pour un plein.** À **${s.municipality}** (${s.province}), l'écart vaut aujourd'hui **${fmt('fr', s.saving50LEur, 2)} € sur un plein de 50 litres** (${fmt('fr', s.italyPriceEur, 3)} €/L en Italie contre ${fmt('fr', s.swissPriceEur, 3)} €/L à la station suisse la plus proche).`,
    fuelSwiss: (st) =>
      st ? `La station suisse la moins chère aujourd'hui est **${st.name}** (${fmt('fr', st.sp95PriceChf, 2)} CHF/L, ≈ ${fmt('fr', st.sp95PriceEur, 3)} €/L), près de ${st.nearestMunicipality}.` : '',
    fuelLink: `Les prix commune par commune, mis à jour chaque jour : [prix de l'essence à la frontière, aujourd'hui](${HUB.fuel.fr}).`,
    fuelDown: '⚠️ Les prix des carburants n’ont pas été actualisés depuis 48 heures ; la section revient dès que la source reprend. En attendant : [prix de l’essence à la frontière](/fr/prix-essence-suisse/aujourd-hui/).',
    fxH: 'Taux de change franc–euro',
    fxLead: (e) =>
      `Un franc vaut **${fmt('fr', e.rate, 4)} €** (clôture du ${e.lastDate}). Par rapport à la veille ${describeDeltaFr(e.delta1d)} ; sur sept jours, la variation est de ${signed('fr', e.delta7d, 4)} €.`,
    fxWhy: `💡 Quand on gagne en francs et qu'on dépense en euros, le taux fait partie du salaire : sur 4 000 CHF, un centime de variation vaut 40 € par mois. Le [calculateur de salaire net](${HUB.salary.fr}) et le [comparatif des services de change](${HUB.fx.fr}) font le calcul pour votre cas.`,
    fxDown: '⚠️ La série du taux de change n’est pas à jour ; la section revient dans la prochaine édition. Le comparatif des services de change reste [ici](/fr/comparaison-services/taux-change-chf-eur/).',
    jobsH: 'Emploi : les chiffres d’hier',
    jobsLead: (j) =>
      `Hier, **${fmt('fr', j.yesterdayAdded)} nouvelles offres d'emploi** en Suisse sont arrivées sur notre job board ; ${fmt('fr', j.last7dAdded)} sur les sept derniers jours. Au total, **${fmt('fr', j.activeJobs)}** annonces sont actives${j.activeCompanies ? `, de ${fmt('fr', j.activeCompanies)} entreprises` : ''}.`,
    jobsLeadTotal: (j) =>
      `Notre job board compte actuellement **${fmt('fr', j.activeJobs)} offres d'emploi actives en Suisse**${j.activeCompanies ? `, de ${fmt('fr', j.activeCompanies)} entreprises` : ''}${Number.isFinite(j.last7dAdded) ? ` ; ${fmt('fr', j.last7dAdded)} nouvelles sont arrivées sur les sept derniers jours` : ''}.`,
    jobsLink: `Filtrez par canton, secteur et ville : [trouver un emploi au Tessin et en Suisse](${HUB.jobs.fr}).`,
    jobsDown: '⚠️ Les statistiques du job board ne sont pas à jour ; la section revient dans la prochaine édition. Les offres restent sur [trouver un emploi](/fr/trouver-emploi-tessin/).',
    methodH: 'Comment naît ce bulletin',
    method:
      'Aucun des chiffres ci-dessus ne vient d’un flux d’agence — c’est notre propre suivi : files échantillonnées plusieurs fois par heure à chaque passage frontalier suisse, prix des carburants dans les communes frontalières italiennes et aux stations suisses proches, série officielle quotidienne CHF/EUR et crawlers de notre job board. Le bulletin sort tôt chaque matin, avant les trajets pendulaires ; les chiffres sont un instantané au moment de la publication, les pages liées restent en direct toute la journée.',
    faq: (ctx) => [
      { q: 'Quand paraît le bulletin quotidien du frontalier ?', a: `Tôt chaque matin, avant l'heure de pointe. Cette édition date du ${ctx.dateLabel}, avec des données collectées dans les heures précédant la publication.` },
      { q: 'D’où viennent les données ?', a: 'Du suivi propriétaire de frontaliereticino.ch : relevé des files à chaque passage frontalier suisse, prix des carburants dans les communes frontalières, série quotidienne CHF/EUR et crawlers du job board. Aucune donnée de seconde main.' },
      { q: 'Les chiffres restent-ils valables toute la journée ?', a: 'Non — ce sont des instantanés au moment de la publication. Pour l’état en temps réel, utilisez les pages en direct liées dans chaque section.' },
    ],
  },
};

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

function buildLocaleContent(locale, brief, headline) {
  const t = T[locale];
  const { blocks } = brief;
  const dateLabel = humanDate(brief.dateIso, locale);
  const wd = weekday(brief.dateIso, locale);

  // body1 — intro + border waits
  const parts1 = [t.intro(wd, dateLabel)];
  const bw = blocks.borderWait;
  parts1.push(`## ${t.bwH}`);
  if (bw?.available) {
    parts1.push(t.bwLead(bw));
    const top = bw.crossings.filter((c) => c.waitMinutes > 0).slice(0, 5);
    if (top.length >= 2) {
      parts1.push(mdTable(t.bwCols, top.map((c) => [c.name, t.bwMin(c.waitMinutes), STATUS_LABEL[locale][c.status] || '—'])));
    }
    parts1.push(t.bwLink);
  } else {
    parts1.push(t.bwDown);
  }

  // body2 — fuel
  const parts2 = [`## ${t.fuelH}`];
  const fuel = blocks.fuel;
  if (fuel?.available) {
    parts2.push(t.fuelLead(fuel));
    if (fuel.cheapestItaly.length >= 2) {
      parts2.push(mdTable(t.fuelCols, fuel.cheapestItaly.map((m) => [`${m.municipality} (${m.province})`, t.fuelPrice(m.minPriceEur)])));
    }
    if (fuel.bestSavings[0]) parts2.push(t.fuelSaving(fuel.bestSavings[0]));
    const swiss = t.fuelSwiss(fuel.cheapestSwissStation);
    if (swiss) parts2.push(swiss);
    parts2.push(t.fuelLink);
  } else {
    parts2.push(t.fuelDown);
  }

  // body3 — exchange
  const parts3 = [`## ${t.fxH}`];
  const fx = blocks.exchange;
  if (fx?.available) {
    parts3.push(t.fxLead(fx));
    parts3.push(t.fxWhy);
  } else {
    parts3.push(t.fxDown);
  }

  // body4 — jobs + method. Gated on `available`, like the headline cascade:
  // a null yesterdayAdded (the stats regenerate during the day — plausible on
  // the morning cron) falls back to the totals lead, so the title and this
  // section can never contradict each other (second review finding, PR #51).
  const parts4 = [`## ${t.jobsH}`];
  const jobs = blocks.jobs;
  if (jobs?.available && Number.isFinite(jobs.yesterdayAdded)) {
    parts4.push(t.jobsLead(jobs));
    parts4.push(t.jobsLink);
  } else if (jobs?.available) {
    parts4.push(t.jobsLeadTotal(jobs));
    parts4.push(t.jobsLink);
  } else {
    parts4.push(t.jobsDown);
  }
  parts4.push(`## ${t.methodH}`);
  parts4.push(t.method);

  return {
    title: t.title(dateLabel, t.headline(headline)),
    excerpt: t.excerpt(dateLabel),
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
      description: it.excerpt,
      // 'dogana' is deliberate: it is a news-sitemap whitelist token, so each
      // edition becomes Google News-eligible inside the 48h window on its own.
      keywords:
        'bollettino frontaliere, dogana, attesa dogana, code valichi ticino, prezzi benzina confine, cambio franco euro, lavoro svizzera, frontalieri ticino',
      ogTitle: it.title,
      ogDescription: it.excerpt,
      headline: it.title,
      breadcrumbName: `Bollettino ${humanDate(brief.dateIso, 'it')}`,
    },
    slugs: article.slugs,
    imageAlt: article.imageAlt,
    content: article.content,
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
  const headline = pickHeadline(brief.blocks || {});
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
