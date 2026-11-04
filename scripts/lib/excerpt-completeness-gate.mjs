/** Compare current excerpt defects with the finite set accepted by the publisher. */
export function excerptCompletenessKey({ file, locale, id, field } = {}) {
  if (![file, locale, id, field].every((value) => typeof value === 'string' && value.length > 0)) {
    throw new TypeError('Excerpt completeness entries require file, locale, id, and field strings');
  }
  return file + '|' + locale + '|' + id + '|' + field;
}

function uniqueBaselineKeys(entries, label) {
  if (!Array.isArray(entries)) {
    throw new TypeError('Excerpt completeness baseline must contain a ' + label + ' array');
  }
  const keys = new Set();
  for (const entry of entries) {
    const key = excerptCompletenessKey(entry);
    if (keys.has(key)) throw new Error('Duplicate excerpt completeness baseline ' + label + ': ' + key);
    keys.add(key);
  }
  return keys;
}

function baselineEntries(baseline, { requireMonotonic = false, requireCompleteLedger = false } = {}) {
  if (!baseline || typeof baseline !== 'object') {
    throw new TypeError('Excerpt completeness baseline must be an object');
  }
  const activeKeys = uniqueBaselineKeys(baseline.entries, 'entries');
  // Small unversioned baselines are useful for pure evaluations (for example,
  // comparing two surfaces in isolation). The publisher assertion always
  // requires the versioned, bounded production baseline below.
  if (!requireMonotonic && !requireCompleteLedger && baseline.version == null
    && baseline.initialEntries === undefined && baseline.resolvedEntries === undefined) {
    return activeKeys;
  }
  if (baseline.version !== 2) {
    throw new TypeError('Publisher excerpt completeness baseline must use version 2');
  }
  const initialKeys = uniqueBaselineKeys(baseline.initialEntries, 'initialEntries');
  const resolvedKeys = uniqueBaselineKeys(baseline.resolvedEntries, 'resolvedEntries');
  for (const key of activeKeys) {
    if (!initialKeys.has(key)) {
      throw new Error('Excerpt completeness baseline entry exceeds immutable initialEntries: ' + key);
    }
    if (resolvedKeys.has(key)) {
      throw new Error('Excerpt completeness baseline entry is already resolved: ' + key);
    }
  }
  for (const key of resolvedKeys) {
    if (!initialKeys.has(key)) {
      throw new Error('Resolved excerpt completeness entry is outside initialEntries: ' + key);
    }
  }
  if (requireCompleteLedger) {
    const unrecordedKeys = [...initialKeys].filter((key) => !activeKeys.has(key) && !resolvedKeys.has(key));
    if (unrecordedKeys.length > 0) {
      throw new Error(
        'Excerpt completeness baseline must record every initial key as active or resolved. Examples: ' +
          unrecordedKeys.slice(0, 5).join('; '),
      );
    }
  }
  return activeKeys;
}

export function evaluateExcerptCompleteness(details, baseline, options = {}) {
  if (!Array.isArray(details)) throw new TypeError('Excerpt completeness details must be an array');
  const knownKeys = baselineEntries(baseline, options);
  const currentKeys = new Set();
  const known = [];
  const regressions = [];
  for (const detail of details) {
    const key = excerptCompletenessKey(detail);
    if (currentKeys.has(key)) {
      // The baseline identifies a file/locale/id/field surface, while the scanner
      // can still encounter that logical field more than once. Refuse an
      // ambiguous duplicate so one approved occurrence cannot cover another.
      regressions.push({
        ...detail,
        key,
        defects: [...new Set([...(Array.isArray(detail.defects) ? detail.defects : []), 'duplicate-occurrence'])],
      });
      continue;
    }
    currentKeys.add(key);
    (knownKeys.has(key) ? known : regressions).push({ ...detail, key });
  }
  const resolved = [...knownKeys]
    .filter((key) => !currentKeys.has(key))
    .sort();
  return { known, regressions, resolved };
}

export function assertNoExcerptCompletenessRegression(details, baseline, options = {}) {
  const result = evaluateExcerptCompleteness(details, baseline, { ...options, requireMonotonic: true });
  if (result.regressions.length > 0) {
    const examples = result.regressions
      .slice(0, 5)
      .map(({ key, strategy, defects = [] }) => key + ' [' + (strategy ?? 'unknown') + '] (' + defects.join(', ') + ')')
      .join('; ');
    throw new Error(
      'build-api: found ' + result.regressions.length +
        ' incomplete excerpt/SEO field(s) outside the approved baseline. ' +
        'Repair the source descriptions before publishing. Examples: ' + examples,
    );
  }
  return result;
}
