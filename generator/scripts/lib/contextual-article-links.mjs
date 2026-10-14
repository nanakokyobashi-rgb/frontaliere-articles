import '../../../host/cantonSectionsBootstrap.mjs';
import { linkContentKeywords } from '../../../engine/shared/linkContentKeywords.mjs';

/** Link existing localized prose. Missing translations and missing intent
 * stay missing: a random salary CTA cannot repair either of them.
 */
export function enrichArticleInternalLinks(data, { isPending, bodySections } = {}) {
  for (const locale of ['it', 'en', 'de', 'fr']) {
    const content = data?.content?.[locale];
    if (!content) continue;
    const sections = bodySections(content);
    const combined = Object.values(sections).join('\n');
    const usedIds = new Set([...combined.matchAll(/\[[^\]]+\]\(nav:([a-z-]+)\)/g)].map(m => m[1]));
    for (const [field, text] of Object.entries(sections)) {
      if (isPending(data, locale, field) || typeof text !== 'string' || !text.trim()) continue;
      content[field] = linkContentKeywords(text, locale, {
        usedIds, maxLinks: 3,
        // Fuel is resolved to locale-specific daily URLs by the site adapter;
        // these are not SPA nav actions and must not become nav:fuel markers.
        isEnabled: id => !id.startsWith('fuel-'),
      });
    }
  }
  return data;
}
