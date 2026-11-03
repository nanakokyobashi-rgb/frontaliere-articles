/** Compare current excerpt defects with the finite set accepted by the publisher. */
export function excerptCompletenessKey({ locale, id, field } = {}) {
  if (![locale, id, field].every((value) => typeof value === 'string' && value.length > 0)) {
    throw new TypeError('Excerpt completeness entries require locale, id, and field strings');
  }
  return locale + '/' + id + '/' + field;
}

function baselineEntries(baseline) {
  if (!baseline || !Array.isArray(baseline.entries)) {
    throw new TypeError('Excerpt completeness baseline must contain an entries array');
  }
  const keys = new Set();
  for (const entry of baseline.entries) {
    const key = excerptCompletenessKey(entry);
    if (keys.has(key)) throw new Error('Duplicate excerpt completeness baseline entry: ' + key);
    keys.add(key);
  }
  return keys;
}

export function evaluateExcerptCompleteness(details, baseline) {
  if (!Array.isArray(details)) throw new TypeError('Excerpt completeness details must be an array');
  const knownKeys = baselineEntries(baseline);
  const currentKeys = new Set();
  const known = [];
  const regressions = [];
  for (const detail of details) {
    const key = excerptCompletenessKey(detail);
    currentKeys.add(key);
    (knownKeys.has(key) ? known : regressions).push({ ...detail, key });
  }
  const resolved = [...knownKeys]
    .filter((key) => !currentKeys.has(key))
    .sort();
  return { known, regressions, resolved };
}

export function assertNoExcerptCompletenessRegression(details, baseline) {
  const result = evaluateExcerptCompleteness(details, baseline);
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
