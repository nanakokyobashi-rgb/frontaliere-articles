import { fetchFirstOk } from './rewire-fetch.mjs';

/** Return the first contract violation in a published crossing-slug map. */
export function validateBorderWaitAveragesPayload(payload, { previousCount } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'is not a crossing-slug map — refusing to cache it';
  }

  const slugs = Object.keys(payload);
  if (slugs.length === 0) return 'carries zero crossings — refusing';

  for (const slug of slugs) {
    const entry = payload[slug];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return `'${slug}' is not an object — refusing`;
    }
    for (const window of ['morning', 'evening']) {
      const value = entry[window];
      if (value === undefined) continue;
      if (typeof value !== 'string' || !/^\d+(-\d+)? min$/.test(value)) {
        return `'${slug}'.${window} is ${JSON.stringify(value)}, ` +
          'not a "N min" or "N-M min" range';
      }
    }
  }

  if (previousCount !== undefined && slugs.length < previousCount / 2) {
    return `would shrink from ${previousCount} to ${slugs.length} crossings — refusing`;
  }
  return null;
}

/** Try each source until it parses and passes the same shape/size gate. */
export function fetchFirstValidBorderWaitAverages(urls, { getBody, previousCount } = {}) {
  return fetchFirstOk(urls, {
    ...(getBody ? { getBody } : {}),
    validate: (payload) => validateBorderWaitAveragesPayload(payload, { previousCount }),
  });
}
