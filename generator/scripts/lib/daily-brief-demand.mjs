import { matchContentLinks } from '../../../engine/shared/contentLinkVocabulary.mjs';
import { getServiceAccountAccessToken } from './google-service-account-token.mjs';
import { fetchWithRefTimeout, releaseFetchWithRefTimeout } from './fetch-with-ref-timeout.mjs';

const THEMES = {
  'job-board': 'jobs', jobs: 'jobs', 'jobs-observatory': 'jobs', companies: 'jobs',
  calculator: 'salary', payslip: 'salary', ral: 'salary', 'salary-compare': 'salary',
  'fuel-petrol': 'fuel', 'fuel-diesel': 'fuel', 'car-cost': 'fuel',
  exchange: 'exchange', border: 'traffic', 'traffic-history': 'traffic', transport: 'traffic',
  'tax-return': 'tax', calendar: 'tax', ristorni: 'tax', health: 'health',
  pension: 'pension', pillar3: 'pension', 'cost-of-living': 'living',
};
export const DEMAND_THEMES = Object.freeze({
  jobs: ['Lavoro', 'Jobs', 'Arbeit', 'Emploi'], salary: ['Stipendio netto', 'Net salary', 'Nettolohn', 'Salaire net'],
  fuel: ['Carburanti', 'Fuel', 'Kraftstoff', 'Carburants'], exchange: ['Cambio CHF/EUR', 'CHF/EUR exchange', 'CHF/EUR Wechselkurs', 'Change CHF/EUR'],
  traffic: ['Valichi e mobilità', 'Border crossings and mobility', 'Grenze und Mobilität', 'Frontière et mobilité'],
  tax: ['Fisco', 'Taxes', 'Steuern', 'Fiscalité'], health: ['Cassa malati', 'Health insurance', 'Krankenversicherung', 'Assurance maladie'],
  pension: ['Pensione', 'Pension', 'Rente', 'Retraite'], living: ['Costo della vita', 'Cost of living', 'Lebenshaltungskosten', 'Coût de la vie'],
});

/** Only predefined theme IDs and aggregate counters leave this function. */
export function shapeSearchDemand({ gscRows = [], ga4Rows = [], startDate, endDate, gscAvailable = false, ga4Available = false, partial = false }) {
  const counts = new Map();
  const themeFor = (query, origin = '') => {
    if (!query || /^(?:\(not set\)|\(other\))$/i.test(query)) return null;
    if (/job.board|job.search/i.test(origin)) return 'jobs';
    for (const locale of ['it', 'en', 'de', 'fr']) {
      const hits = matchContentLinks(query, locale).sort((a, b) => b.score - a.score);
      for (const hit of hits) if (THEMES[hit.id]) return THEMES[hit.id];
    }
    return null;
  };
  const add = (theme, metric, value) => {
    if (!theme || !Number.isFinite(value) || value <= 0) return;
    const row = counts.get(theme) || { theme, impressions: 0, searches: 0 };
    row[metric] += value;
    counts.set(theme, row);
  };
  for (const row of gscRows) add(themeFor(row.keys?.[0]), 'impressions', row.impressions);
  for (const row of ga4Rows) add(themeFor(row.dimensionValues?.[0]?.value, row.dimensionValues?.[1]?.value), 'searches', Number(row.metricValues?.[0]?.value));
  const topics = [...counts.values()].filter(row => row.impressions >= 20 || row.searches >= 5)
    .sort((a, b) => b.impressions - a.impressions || b.searches - a.searches || a.theme.localeCompare(b.theme)).slice(0, 5);
  return { available: topics.length > 0, startDate, endDate, topics, partial,
    sources: { gsc: gscAvailable, ga4: ga4Available } };
}

export async function fetchSearchDemand(creds, todayIso, { fetchImpl = fetchWithRefTimeout, tokenImpl = getServiceAccountAccessToken } = {}) {
  // Seven complete days with a three-day settlement lag. Search demand is not
  // called “today's searches”, unlike the live traffic observation.
  const end = Date.parse(`${todayIso}T00:00:00Z`) - 3 * 86400000;
  const endDate = new Date(end).toISOString().slice(0, 10);
  const startDate = new Date(end - 6 * 86400000).toISOString().slice(0, 10);
  const request = async (url, scope, body) => {
    const token = await tokenImpl(creds, scope);
    const response = await fetchImpl(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 20000);
    if (!response.ok) {
      releaseFetchWithRefTimeout(response);
      throw new Error(`Audience aggregate HTTP ${response.status}`);
    }
    return response.json();
  };
  const results = await Promise.allSettled([
    request('https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Afrontaliereticino.ch/searchAnalytics/query', 'https://www.googleapis.com/auth/webmasters.readonly', { startDate, endDate, type: 'web', dimensions: ['query'], rowLimit: 1000, dataState: 'final' }),
    request('https://analyticsdata.googleapis.com/v1beta/properties/524485296:runReport', 'https://www.googleapis.com/auth/analytics.readonly', {
      dateRanges: [{ startDate, endDate }], dimensions: [{ name: 'searchTerm' }, { name: 'customEvent:search_origin' }], metrics: [{ name: 'eventCount' }],
      dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: ['search', 'view_search_results'] } } }, limit: 1000,
    }),
  ]);
  const gsc = results[0].status === 'fulfilled' ? results[0].value : null;
  const ga4 = results[1].status === 'fulfilled' ? results[1].value : null;
  return shapeSearchDemand({ startDate, endDate, gscRows: gsc?.rows, ga4Rows: ga4?.rows,
    gscAvailable: !!gsc, ga4Available: !!ga4,
    partial: !gsc || !ga4 || gsc.rows?.length === 1000 || ga4.rowCount > 1000 || !!ga4.metadata?.dataLossFromOtherRow || !!ga4.metadata?.subjectToThresholding || !!ga4.metadata?.samplingMetadatas?.length });
}
