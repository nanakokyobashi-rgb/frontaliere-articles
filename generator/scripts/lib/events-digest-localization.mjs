import {
  LOCALIZED_TOPONYM_LOCALES,
  createLocalizedToponymSourceProfileCache,
  replaceEventsDigestBody2LocalizedToponymMismatches,
  replaceLocalizedToponymMismatches,
} from './localized-toponyms.mjs';

function repairParallelLocaleValue(source, target, locale, sourceProfileFor, key = '') {
  if (typeof target === 'string') {
    if (typeof source !== 'string') return target;
    if (key === 'body2') {
      return replaceEventsDigestBody2LocalizedToponymMismatches({
        sourceText: source,
        targetText: target,
        locale,
        sourceProfileFor,
      })?.text ?? target;
    }
    return replaceLocalizedToponymMismatches({
      sourceText: source,
      targetText: target,
      locale,
      sourceProfile: sourceProfileFor(source),
    }).text;
  }

  if (Array.isArray(target)) {
    return target.map((value, index) => repairParallelLocaleValue(
      Array.isArray(source) ? source[index] : undefined,
      value,
      locale,
      sourceProfileFor,
      key,
    ));
  }

  if (target && typeof target === 'object') {
    return Object.fromEntries(Object.entries(target).map(([childKey, value]) => [
      childKey,
      repairParallelLocaleValue(
        source && typeof source === 'object' && !Array.isArray(source) ? source[childKey] : undefined,
        value,
        locale,
        sourceProfileFor,
        childKey,
      ),
    ]));
  }

  return target;
}

/**
 * Repair only table-backed exonyms in locale fields paired with their Italian
 * source fields. The factuality gate still runs afterward and remains the
 * final authority; URL routes and unmatched text are left untouched.
 */
export function repairEventsDigestLocalizedToponyms(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;

  const sourceProfileFor = createLocalizedToponymSourceProfileCache();
  try {
    const repaired = { ...data };
    if (data.content && typeof data.content === 'object' && !Array.isArray(data.content)
        && Object.hasOwn(data.content, 'it')) {
      repaired.content = { ...data.content };
      for (const locale of LOCALIZED_TOPONYM_LOCALES) {
        if (locale === 'it' || !Object.hasOwn(repaired.content, locale)) continue;
        repaired.content[locale] = repairParallelLocaleValue(
          data.content.it,
          data.content[locale],
          locale,
          sourceProfileFor,
        );
      }
    }

    if (data.imageAlt && typeof data.imageAlt === 'object' && !Array.isArray(data.imageAlt)
        && typeof data.imageAlt.it === 'string') {
      repaired.imageAlt = { ...data.imageAlt };
      for (const locale of LOCALIZED_TOPONYM_LOCALES) {
        if (locale === 'it' || typeof repaired.imageAlt[locale] !== 'string') continue;
        repaired.imageAlt[locale] = replaceLocalizedToponymMismatches({
          sourceText: data.imageAlt.it,
          targetText: repaired.imageAlt[locale],
          locale,
          sourceProfile: sourceProfileFor(data.imageAlt.it),
        }).text;
      }
    }

    return repaired;
  } finally {
    sourceProfileFor.clear();
  }
}
