/** Additional proprietary observations. Never infer a missing baseline or
 * publish free-text search queries. Every delta names its comparison period.
 */
export const DEMAND_THEMES = Object.freeze({
  jobs: ['Lavoro', 'Jobs', 'Arbeit', 'Emploi'], salary: ['Stipendio netto', 'Net salary', 'Nettolohn', 'Salaire net'],
  fuel: ['Carburanti', 'Fuel', 'Kraftstoff', 'Carburants'], exchange: ['Cambio CHF/EUR', 'CHF/EUR exchange', 'CHF/EUR Wechselkurs', 'Change CHF/EUR'],
  traffic: ['Valichi e mobilità', 'Border crossings and mobility', 'Grenze und Mobilität', 'Frontière et mobilité'],
  tax: ['Fisco', 'Taxes', 'Steuern', 'Fiscalité'], health: ['Cassa malati', 'Health insurance', 'Krankenversicherung', 'Assurance maladie'],
  pension: ['Pensione', 'Pension', 'Rente', 'Retraite'], living: ['Costo della vita', 'Cost of living', 'Lebenshaltungskosten', 'Coût de la vie'],
});

const DAY = 86400000;
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

function leaders(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter(row => typeof row?.name === 'string' && number(row.count) > 0)
    .map(row => ({ name: row.name.replace(/[|\r\n\[\]*_`<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100), count: row.count }))
    .filter(row => row.name)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 5);
}

export function buildDailyBriefInsights({ blocks, jobsStats, todayIso, previousSnapshot, searchDemand = null }) {
  const insights = {};
  const today = Date.parse(`${todayIso}T00:00:00Z`);
  const yesterday = new Date(today - DAY).toISOString().slice(0, 10);
  if (blocks.jobs?.available) {
    // The producer stores one bucket per Zurich calendar date, but exposes no
    // finalization timestamp. A D-1 bucket may still be updated during D, so
    // seven consecutive date labels cannot support a complete-week claim.
    insights.jobs = {
      topCompanies: leaders(jobsStats?.leaders?.topCompaniesActive),
      topLocations: leaders(jobsStats?.leaders?.topLocationsActive),
    };
  }
  const fx = blocks.exchange;
  if (fx?.available && number(fx.rate) > 0) {
    const rate7dAgo = number(fx.rate7dAgo);
    const weeklyRateDelta = rate7dAgo !== null && number(fx.delta7d) !== null
      ? Math.round((fx.rate - rate7dAgo) * 10000) / 10000 : null;
    insights.exchange = {
      referenceSalaryChf: 4000,
      salaryValueEur: Math.round(fx.rate * 400000) / 100,
      weeklyRateDelta,
      weeklySalaryChangeEur: weeklyRateDelta !== null ? Math.round(weeklyRateDelta * 400000) / 100 : null,
      lastDate: fx.lastDate,
      previousDate: typeof fx.rate7dAgoDate === 'string' ? fx.rate7dAgoDate : null,
      rate7dAgo,
    };
  }
  // Only consecutive editions can establish a day-on-day comparison. A same-day
  // refresh reads the snapshot written by the first run of the day, so retain
  // that edition's per-crossing D-1 baseline while replacing its current reading.
  // Carry it even if this run's feed is unavailable: another same-day refresh
  // may recover the source after this snapshot has replaced yesterday's.
  let borderWaitBaseline = null;
  if (previousSnapshot?.dateIso === yesterday && previousSnapshot.blocks?.borderWait?.available) {
    const rows = Array.isArray(previousSnapshot.blocks.borderWait.crossings)
      ? previousSnapshot.blocks.borderWait.crossings : [];
    const countsBySlug = new Map();
    for (const row of rows) {
      if (typeof row?.slug === 'string') countsBySlug.set(row.slug, (countsBySlug.get(row.slug) || 0) + 1);
    }
    const uniqueRows = rows.filter(row => typeof row?.slug === 'string'
      && countsBySlug.get(row.slug) === 1 && number(row.waitMinutes) !== null && row.waitMinutes >= 0);
    borderWaitBaseline = { date: yesterday, crossings: uniqueRows.map(({ slug, waitMinutes }) => ({ slug, waitMinutes })) };
  } else if (previousSnapshot?.dateIso === todayIso) {
    const priorBaseline = previousSnapshot.insights?.borderWaitBaseline;
    if (priorBaseline?.date === yesterday && Array.isArray(priorBaseline.crossings)) borderWaitBaseline = priorBaseline;
  }
  if (borderWaitBaseline) insights.borderWaitBaseline = borderWaitBaseline;

  if (blocks.borderWait?.available) {
    const worst = blocks.borderWait.worst;
    let previousWaitMinutes = null;
    let previousDate = null;
    const matching = borderWaitBaseline?.crossings?.filter(row => row?.slug === worst.slug) || [];
    if (borderWaitBaseline?.date === yesterday && matching.length === 1
      && number(matching[0].waitMinutes) !== null && matching[0].waitMinutes >= 0) {
      previousWaitMinutes = matching[0].waitMinutes;
      previousDate = yesterday;
    } else if (previousSnapshot?.dateIso === todayIso) {
      const priorInsight = previousSnapshot.insights?.borderWait;
      if (priorInsight?.slug === worst.slug
        && priorInsight.currentDate === todayIso
        && priorInsight.previousDate === yesterday
        && number(priorInsight.previousWaitMinutes) !== null) {
        // Backward compatibility with a same-day snapshot written before the
        // per-crossing baseline was added: preserve the one known comparison.
        previousWaitMinutes = priorInsight.previousWaitMinutes;
        previousDate = priorInsight.previousDate;
      }
    }
    if (previousDate && Number.isFinite(worst.waitMinutes)) {
      insights.borderWait = { name: worst.name, slug: worst.slug, previousDate, currentDate: todayIso,
        waitMinutes: worst.waitMinutes, previousWaitMinutes,
        changeMinutes: worst.waitMinutes - previousWaitMinutes };
    }
  }
  if (searchDemand?.available) insights.searchDemand = searchDemand;
  return insights;
}
