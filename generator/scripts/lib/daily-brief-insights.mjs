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
    .map(row => ({ name: row.name.replace(/[|\r\n[\]]/g, ' ').trim().slice(0, 100), count: row.count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 5);
}

function closedWeek(history, endDate) {
  const end = Date.parse(`${endDate}T00:00:00Z`);
  let total = 0;
  for (let i = 0; i < 7; i++) {
    const day = new Date(end - i * DAY).toISOString().slice(0, 10);
    const rows = history.filter(row => row?.date === day);
    if (rows.length !== 1 || number(rows[0].added) === null || rows[0].added < 0) return null;
    total += rows[0].added;
  }
  return total;
}

export function buildDailyBriefInsights({ blocks, jobsStats, todayIso, previousSnapshot, searchDemand = null }) {
  const insights = {};
  const today = Date.parse(`${todayIso}T00:00:00Z`);
  const yesterday = new Date(today - DAY).toISOString().slice(0, 10);
  if (blocks.jobs?.available) {
    const history = Array.isArray(jobsStats?.history) ? jobsStats.history : [];
    const currentWeekAdded = closedWeek(history, yesterday);
    const previousWeekAdded = closedWeek(history, new Date(today - 8 * DAY).toISOString().slice(0, 10));
    insights.jobs = {
      lastClosedDay: yesterday,
      currentWeekAdded, previousWeekAdded,
      weeklyChange: currentWeekAdded !== null && previousWeekAdded !== null ? currentWeekAdded - previousWeekAdded : null,
      weeklyChangePct: currentWeekAdded !== null && previousWeekAdded > 0 ? Math.round((currentWeekAdded / previousWeekAdded - 1) * 1000) / 10 : null,
      topCompanies: leaders(jobsStats?.leaders?.topCompaniesActive),
      topLocations: leaders(jobsStats?.leaders?.topLocationsActive),
    };
  }
  const fx = blocks.exchange;
  if (fx?.available && number(fx.rate) > 0) {
    insights.exchange = {
      referenceSalaryChf: 4000,
      salaryValueEur: Math.round(fx.rate * 400000) / 100,
      weeklySalaryChangeEur: number(fx.delta7d) !== null ? Math.round(fx.delta7d * 400000) / 100 : null,
      lastDate: fx.lastDate,
    };
  }
  // Only consecutive editions can establish a day-on-day comparison.
  if (previousSnapshot?.dateIso === yesterday && blocks.borderWait?.available && previousSnapshot.blocks?.borderWait?.available) {
    const worst = blocks.borderWait.worst;
    const previous = previousSnapshot.blocks.borderWait.crossings?.find(row => row.slug === worst.slug);
    if (number(previous?.waitMinutes) !== null) {
      insights.borderWait = { name: worst.name, slug: worst.slug, previousDate: yesterday,
        waitMinutes: worst.waitMinutes, previousWaitMinutes: previous.waitMinutes,
        changeMinutes: worst.waitMinutes - previous.waitMinutes };
    }
  }
  if (searchDemand?.available) insights.searchDemand = searchDemand;
  return insights;
}
