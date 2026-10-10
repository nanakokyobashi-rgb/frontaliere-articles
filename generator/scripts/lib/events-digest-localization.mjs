import { LOCALIZED_TOPONYM_LOCALES, replaceLocalizedToponymMismatches } from './localized-toponyms.mjs';

function repairParallelLocaleValue(source, target, locale) {
  if (typeof target === 'string') {
    if (typeof source !== 'string') return target;
    return replaceLocalizedToponymMismatches({ sourceText: source, targetText: target, locale }).text;
  }

  if (Array.isArray(target)) {
    return target.map((value, index) => repairParallelLocaleValue(
      Array.isArray(source) ? source[index] : undefined,
      value,
      locale,
    ));
  }

  if (target && typeof target === 'object') {
    return Object.fromEntries(Object.entries(target).map(([key, value]) => [
      key,
      repairParallelLocaleValue(
        source && typeof source === 'object' && !Array.isArray(source) ? source[key] : undefined,
        value,
        locale,
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

  const repaired = { ...data };
  if (data.content && typeof data.content === 'object' && !Array.isArray(data.content)
      && Object.hasOwn(data.content, 'it')) {
    repaired.content = { ...data.content };
    for (const locale of LOCALIZED_TOPONYM_LOCALES) {
      if (locale === 'it' || !Object.hasOwn(repaired.content, locale)) continue;
      repaired.content[locale] = repairParallelLocaleValue(data.content.it, data.content[locale], locale);
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
      }).text;
    }
  }

  return repaired;
}
