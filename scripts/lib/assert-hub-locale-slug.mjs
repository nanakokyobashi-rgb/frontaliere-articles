import '../../host/cantonSectionsBootstrap.mjs';
import { CANTON_HUB_TOPIC_KEYS } from '../../engine/shared/cantonArticleSectionCore.generated.mjs';
import { assertCantonHubLocaleSlug } from '../../engine/shared/cantonSectionCopy.mjs';

/**
 * Validate one localized reserved hub slug before it is interpolated into a
 * published route. A missing own property must fail closed: inherited values,
 * `undefined`, and empty strings are not publishable slugs.
 */
export function assertHubLocaleSlug(section, topic, locale, slugs) {
  return assertCantonHubLocaleSlug(section, topic, locale, slugs);
}

/**
 * Return the canonical hub order and fail closed if the core omits or invents
 * a topic. Consumers must validate the whole set before emitting any surface.
 */
export function assertHubTopicEntries(section, topicHubs) {
  const isRecord = topicHubs !== null
    && typeof topicHubs === 'object'
    && !Array.isArray(topicHubs);
  if (!isRecord) throw new Error(`${section}: mappa hub non valida`);

  const keys = Object.keys(topicHubs);
  const missing = CANTON_HUB_TOPIC_KEYS.filter((topic) => !Object.prototype.hasOwnProperty.call(topicHubs, topic));
  const extra = keys.filter((topic) => !CANTON_HUB_TOPIC_KEYS.includes(topic));
  if (missing.length || extra.length) {
    const details = [];
    if (missing.length) details.push(`mancanti: ${missing.join(', ')}`);
    if (extra.length) details.push(`extra: ${extra.join(', ')}`);
    throw new Error(`${section}: chiavi hub non valide (${details.join('; ')})`);
  }

  return CANTON_HUB_TOPIC_KEYS.map((topic) => [topic, topicHubs[topic]]);
}
