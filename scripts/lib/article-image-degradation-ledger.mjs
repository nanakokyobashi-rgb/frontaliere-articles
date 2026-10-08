export const DEGRADATION_LEDGER_SCHEMA = 1;
export const DEGRADATION_LEDGER_START = '<!-- ARTICLE_IMAGE_DEGRADATION_LEDGER v1 -->';
export const DEGRADATION_LEDGER_END = '<!-- /ARTICLE_IMAGE_DEGRADATION_LEDGER -->';
export const MAX_REPAIR_ATTEMPTS = 3;
export const MAX_ABSENCE_RETRIES = 3;
export const DEFAULT_REPAIR_CAP = 3;
export const DEFAULT_LEDGER_RETENTION_DAYS = 90;
export const DEFAULT_TERMINAL_RETENTION_DAYS = 14;

const VALID_STATUSES = new Set(['pending', 'in-flight', 'exhausted', 'orphaned', 'retired']);

export function ledgerKey({ section, articleId } = {}) {
  if (!section || !articleId) return null;
  return `${section}:${articleId}`;
}

function normalizedItem(item) {
  const section = String(item?.section ?? '').trim();
  const articleId = String(item?.articleId ?? '').trim();
  if (!section || !articleId) throw new Error('ledger item senza section/articleId');
  const attempts = Number.isInteger(item?.attempts) && item.attempts >= 0 ? item.attempts : 0;
  const status = VALID_STATUSES.has(item?.status) ? item.status : attempts >= MAX_REPAIR_ATTEMPTS ? 'exhausted' : 'pending';
  const absenceAttempts = Number.isInteger(item?.absenceAttempts) && item.absenceAttempts >= 0 ? item.absenceAttempts : 0;
  return {
    section,
    articleId,
    url: item?.url ? String(item.url) : null,
    registryImage: item?.registryImage ? String(item.registryImage) : null,
    firstSeenAt: item?.firstSeenAt ? String(item.firstSeenAt) : null,
    lastSeenAt: item?.lastSeenAt ? String(item.lastSeenAt) : null,
    attempts,
    status,
    runId: item?.runId === null || item?.runId === undefined ? null : String(item.runId),
    dispatchedAt: item?.dispatchedAt ? String(item.dispatchedAt) : null,
    lastOutcome: item?.lastOutcome ? String(item.lastOutcome) : null,
    absenceAttempts,
    retiredAt: item?.retiredAt ? String(item.retiredAt) : null,
  };
}

function sortedItems(items) {
  return [...items].map(normalizedItem).sort((a, b) => ledgerKey(a).localeCompare(ledgerKey(b)));
}

export function parseDegradationLedger(body) {
  const source = String(body ?? '');
  const start = source.indexOf(DEGRADATION_LEDGER_START);
  if (start < 0) return { present: false, items: [] };
  const end = source.indexOf(DEGRADATION_LEDGER_END, start + DEGRADATION_LEDGER_START.length);
  if (end < 0) throw new Error('ledger immagini degradate troncato');
  const section = source.slice(start + DEGRADATION_LEDGER_START.length, end);
  const json = section.match(/```json\s*\n([\s\S]*?)\n```/i)?.[1];
  if (!json) throw new Error('ledger immagini degradate senza JSON');
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`ledger immagini degradate non valido: ${error.message}`);
  }
  if (parsed?.schema !== DEGRADATION_LEDGER_SCHEMA || !Array.isArray(parsed.items)) {
    throw new Error('ledger immagini degradate con schema sconosciuto');
  }
  return { present: true, items: sortedItems(parsed.items) };
}

export function renderDegradationLedger(items = []) {
  const payload = JSON.stringify({ schema: DEGRADATION_LEDGER_SCHEMA, items: sortedItems(items) }, null, 2);
  return `${DEGRADATION_LEDGER_START}\n\`\`\`json\n${payload}\n\`\`\`\n${DEGRADATION_LEDGER_END}`;
}

export function upsertDegradationLedger(body, items = []) {
  const source = String(body ?? '');
  const rendered = renderDegradationLedger(items);
  const start = source.indexOf(DEGRADATION_LEDGER_START);
  if (start < 0) return source.trimEnd() ? `${source.trimEnd()}\n\n${rendered}\n` : `${rendered}\n`;
  const endMarker = source.indexOf(DEGRADATION_LEDGER_END, start + DEGRADATION_LEDGER_START.length);
  if (endMarker < 0) throw new Error('ledger immagini degradate troncato');
  const end = endMarker + DEGRADATION_LEDGER_END.length;
  return `${source.slice(0, start)}${rendered}${source.slice(end)}`;
}

export function mergeDegradedItems(existing = [], observed = [], now = new Date().toISOString()) {
  const byKey = new Map(sortedItems(existing).map((item) => [ledgerKey(item), item]));
  for (const raw of observed) {
    const item = normalizedItem({
      section: raw.section,
      articleId: raw.articleId,
      url: raw.url,
      registryImage: raw.registryImage,
      firstSeenAt: raw.firstSeenAt ?? now,
      lastSeenAt: now,
      attempts: raw.attempts ?? 0,
      status: raw.status ?? 'pending',
      runId: raw.runId,
      dispatchedAt: raw.dispatchedAt,
      lastOutcome: raw.lastOutcome,
      absenceAttempts: raw.absenceAttempts,
      retiredAt: raw.retiredAt,
    });
    const key = ledgerKey(item);
    const previous = byKey.get(key);
    if (!previous) {
      byKey.set(key, item);
      continue;
    }
    const status = previous.status === 'in-flight' || previous.status === 'exhausted' ? previous.status : 'pending';
    byKey.set(key, {
      ...previous,
      url: item.url ?? previous.url,
      registryImage: item.registryImage ?? previous.registryImage,
      firstSeenAt: previous.firstSeenAt ?? item.firstSeenAt ?? now,
      lastSeenAt: now,
      status,
      absenceAttempts: 0,
      retiredAt: null,
    });
  }
  return sortedItems([...byKey.values()]);
}

/** Mark durable rows whose registry or slug disappeared without leaving them actionable forever. */
export function markLedgerItemsAbsent(items = [], absentKeys = [], now = new Date().toISOString()) {
  const absent = new Set(absentKeys);
  return sortedItems(items).map((item) => {
    const key = ledgerKey(item);
    if (!absent.has(key) || item.status === 'retired' || item.status === 'exhausted') return item;
    const absenceAttempts = item.absenceAttempts + 1;
    const retired = absenceAttempts >= MAX_ABSENCE_RETRIES;
    return {
      ...item,
      status: retired ? 'retired' : 'orphaned',
      absenceAttempts,
      retiredAt: retired ? now : null,
      runId: retired ? null : item.runId,
      dispatchedAt: retired ? null : item.dispatchedAt,
      lastSeenAt: now,
      lastOutcome: retired ? 'registry-or-slug-missing-retired' : 'registry-or-slug-missing',
    };
  });
}

/**
 * Bound durable state while retaining a short audit trail for terminal rows.
 * Active rows older than the retention window become retired; terminal rows
 * older than their shorter window disappear on the next persistence pass.
 */
export function retainDegradationLedger(
  items = [],
  {
    nowMs = Date.now(),
    retentionDays = DEFAULT_LEDGER_RETENTION_DAYS,
    terminalRetentionDays = DEFAULT_TERMINAL_RETENTION_DAYS,
  } = {},
) {
  const now = new Date(nowMs).toISOString();
  const activeCutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  const terminalCutoff = nowMs - terminalRetentionDays * 24 * 60 * 60 * 1000;
  return sortedItems(items).flatMap((item) => {
    const terminalAt = Date.parse(item.retiredAt || item.lastSeenAt || item.firstSeenAt || '');
    if ((item.status === 'retired' || item.status === 'exhausted') && Number.isFinite(terminalAt) && terminalAt < terminalCutoff) {
      return [];
    }
    const firstSeen = Date.parse(item.firstSeenAt || '');
    if (item.status !== 'retired' && item.status !== 'exhausted' && Number.isFinite(firstSeen) && firstSeen < activeCutoff) {
      return [{
        ...item,
        status: 'retired',
        retiredAt: now,
        runId: null,
        dispatchedAt: null,
        lastOutcome: 'retention-expired',
      }];
    }
    return [item];
  });
}

/** Fallback map consumed by every aggregate writer, including later rerenders. */
export function releasedArticleFallbacks(items = []) {
  const byKey = new Map();
  for (const raw of items) {
    const item = normalizedItem(raw);
    if (item.status === 'retired' || !item.registryImage) continue;
    const key = `${item.section}:${item.articleId}:${item.registryImage}`;
    byKey.set(key, {
      section: item.section,
      articleId: item.articleId,
      declaredImage: item.registryImage,
    });
  }
  return [...byKey.values()].sort((a, b) => `${a.section}:${a.articleId}`.localeCompare(`${b.section}:${b.articleId}`));
}

export function removeHealthyItems(items = [], healthyKeys = []) {
  const healthy = new Set(healthyKeys);
  return sortedItems(items).filter((item) => !healthy.has(ledgerKey(item)));
}

/** Apply only terminal dispatch outcomes; running jobs remain in-flight. */
export function applyDispatchOutcomes(items = [], outcomes = {}, now = new Date().toISOString()) {
  const handledKeys = new Set();
  const next = sortedItems(items).map((item) => {
    if (item.status !== 'in-flight') return item;
    const outcome = outcomes[ledgerKey(item)];
    if (!outcome || outcome.status !== 'completed') return item;
    const success = outcome.conclusion === 'success';
    handledKeys.add(ledgerKey(item));
    const attempts = success ? item.attempts : item.attempts + 1;
    return {
      ...item,
      attempts,
      status: !success && attempts >= MAX_REPAIR_ATTEMPTS ? 'exhausted' : 'pending',
      runId: null,
      dispatchedAt: null,
      lastOutcome: success ? 'success' : String(outcome.conclusion || 'failure'),
      lastSeenAt: item.lastSeenAt ?? now,
    };
  });
  return { items: next, handledKeys };
}

export function markDispatched(items = [], dispatches = [], now = new Date().toISOString()) {
  const byKey = new Map(dispatches.map((dispatch) => [dispatch.key, dispatch]));
  return sortedItems(items).map((item) => {
    const dispatch = byKey.get(ledgerKey(item));
    if (!dispatch) return item;
    // A dispatch lookup can time out after the workflow was accepted. Without
    // a run identifier there is nothing reconcileDispatches can follow, so an
    // in-flight row would become permanent. Leave it retryable instead.
    const hasRunId = dispatch.runId !== null
      && dispatch.runId !== undefined
      && String(dispatch.runId).length > 0;
    if (!hasRunId) {
      return {
        ...item,
        status: 'pending',
        runId: null,
        dispatchedAt: null,
      };
    }
    return {
      ...item,
      status: 'in-flight',
      runId: String(dispatch.runId),
      dispatchedAt: dispatch.dispatchedAt ?? now,
    };
  });
}

export function repairCandidates(items = [], { readyKeys = [], excludeKeys = [], cap = DEFAULT_REPAIR_CAP } = {}) {
  const ready = new Set(readyKeys);
  const excluded = new Set(excludeKeys);
  return sortedItems(items)
    .filter((item) => item.status === 'pending' && item.attempts < MAX_REPAIR_ATTEMPTS)
    .filter((item) => ready.has(ledgerKey(item)) && !excluded.has(ledgerKey(item)))
    .slice(0, Math.max(0, cap));
}

export function groupRepairCandidates(items = []) {
  const groups = new Map();
  for (const item of sortedItems(items)) {
    if (!groups.has(item.section)) groups.set(item.section, []);
    groups.get(item.section).push(item);
  }
  return [...groups.entries()].map(([section, group]) => ({
    section,
    ids: group.map((item) => item.articleId),
    items: group,
  }));
}
