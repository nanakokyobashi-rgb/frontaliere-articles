import '../../../host/cantonSectionsBootstrap.mjs';
import { linkContentKeywords } from '../../../engine/shared/linkContentKeywords.mjs';
import { createBodyLinkMatcher, destinationPaths } from './body-link-destinations.mjs';

// Tetto dei link nel corpo (piano cadenza §10.2: corpo ≤ 4 link interni).
const BODY_LINK_CAP = 4;
// Strumenti `nav:`: il tetto storico resta 3 e sale a 4 solo se un link
// verso lavori/professioni e' stato aggiunto prima.
const NAV_LINK_CAP = 3;
// Al massimo due link verso destinazioni (landing, pagine tematiche) per articolo, contando quelli gia' presenti.
const DESTINATION_LINK_CAP = 2;

/** Link existing localized prose. Missing translations and missing intent
 * stay missing: a random salary CTA cannot repair either of them.
 *
 * Prima passata: landing lavoro del cantone/Svizzera e landing di professione
 * (F6.3b), con l'ancora presa dal testo e l'URL da un elenco verificato.
 * Seconda passata: gli strumenti del sito (`nav:`), come prima.
 */
export function enrichArticleInternalLinks(data, { isPending, bodySections, sectionName = 'frontaliere', entityAnchors = false } = {}) {
  const destinationMatcher = createBodyLinkMatcher({ sectionName, entityAnchors });
  for (const locale of ['it', 'en', 'de', 'fr']) {
    const content = data?.content?.[locale];
    if (!content) continue;
    const sections = bodySections(content);
    const combined = Object.values(sections).join('\n');
    const usedIds = new Set([...combined.matchAll(/\[[^\]]+\]\(nav:([a-z-]+)\)/g)].map(m => m[1]));
    const destinations = destinationPaths(locale);
    let destinationsPresent = 0;
    for (const [id, target] of Object.entries(destinations)) {
      if (target && combined.includes(`](${target})`)) { usedIds.add(id); destinationsPresent += 1; }
    }
    const fields = Object.entries(sections)
      .filter(([field, text]) => !isPending(data, locale, field) && typeof text === 'string' && text.trim());

    const before = usedIds.size;
    // Il tetto vale sul totale dei link verso destinazioni (anche quelli gia' presenti): rieseguire il
    // linker sullo stesso corpo non ne aggiunge altri.
    const destinationBudget = Math.min(BODY_LINK_CAP, before + Math.max(0, DESTINATION_LINK_CAP - destinationsPresent));
    for (const [field, text] of fields) {
      content[field] = linkContentKeywords(content[field] ?? text, locale, {
        matcher: destinationMatcher, destinations, usedIds, maxLinks: destinationBudget,
      });
    }
    const added = usedIds.size - before;
    for (const [field] of fields) {
      content[field] = linkContentKeywords(content[field], locale, {
        usedIds, maxLinks: Math.min(BODY_LINK_CAP, NAV_LINK_CAP + added),
        // Fuel is resolved to locale-specific daily URLs by the site adapter;
        // these are not SPA nav actions and must not become nav:fuel markers.
        isEnabled: id => !id.startsWith('fuel-'),
      });
    }
  }
  return data;
}
