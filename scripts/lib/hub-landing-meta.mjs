/**
 * Metadata that belongs to the Italian Switzerland article-hub landing.
 *
 * The landing is served from the article shard, so the corpus-side hub
 * refresher has to carry this small correction after it fetches the existing
 * HTML. The replacement is deliberately stale-value guarded: a later full
 * site build or an editorial update remains authoritative.
 */
export const SWISS_HUB_ROOT_SEO_IT = Object.freeze({
  title: 'Articoli sulla Svizzera 2026 | Frontaliere Ticino',
  description: 'Notizie, analisi e guide sulla Svizzera per frontalieri: tasse, lavoro, costo della vita e aggiornamenti cantonali.',
  ogDescription: 'Notizie, analisi e guide sulla Svizzera per frontalieri: tasse, lavoro, costo della vita e aggiornamenti cantonali.',
});

const STALE_SWISS_HUB_ROOT_SEO_IT = Object.freeze({
  title: 'Articoli Svizzera | Frontaliere Ticino',
  description: 'Informazioni utili per frontalieri Svizzera-Italia: articoli svizzera.',
  ogDescription: 'Informazioni utili per frontalieri: articoli svizzera.',
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceMetaContent(html, attribute, attributeValue, staleValue, nextValue) {
  const identity = new RegExp(
    `\\b${escapeRegExp(attribute)}\\s*=\\s*(["'])${escapeRegExp(attributeValue)}\\1`,
    'i',
  );
  const content = /\bcontent\s*=\s*(['"])(.*?)\1/i;
  return html.replace(/<meta\b[^>]*>/gi, (tag) => {
    if (!identity.test(tag)) return tag;
    const match = content.exec(tag);
    if (!match || match[2] !== staleValue) return tag;
    const before = tag.slice(0, match.index);
    const after = tag.slice(match.index + match[0].length);
    return `${before}${match[0].slice(0, match[0].indexOf(match[2]))}${nextValue}${match[1]}${after}`;
  });
}

/**
 * Upgrade the stale generic metadata left on the Italian Switzerland landing.
 * Other sections/locales and already-curated values pass through unchanged.
 */
export function patchHubLandingMetadata(html, section, locale) {
  if (section !== 'svizzera' || locale !== 'it') return html;

  let out = String(html).replace(
    new RegExp(`<title>${escapeRegExp(STALE_SWISS_HUB_ROOT_SEO_IT.title)}<\\/title>`, 'i'),
    `<title>${SWISS_HUB_ROOT_SEO_IT.title}</title>`,
  );
  out = replaceMetaContent(
    out,
    'name',
    'description',
    STALE_SWISS_HUB_ROOT_SEO_IT.description,
    SWISS_HUB_ROOT_SEO_IT.description,
  );
  out = replaceMetaContent(
    out,
    'property',
    'og:title',
    STALE_SWISS_HUB_ROOT_SEO_IT.title,
    SWISS_HUB_ROOT_SEO_IT.title,
  );
  out = replaceMetaContent(
    out,
    'property',
    'og:description',
    STALE_SWISS_HUB_ROOT_SEO_IT.ogDescription,
    SWISS_HUB_ROOT_SEO_IT.ogDescription,
  );
  return out;
}
