const ARTICLE_HERO_PATH = /^\/images\/(?:blog|generated)\/[a-z0-9][a-z0-9._-]{2,127}\.webp$/;
const CANTON_NAMES = Object.freeze({
  AG: 'Aargau', AI: 'Appenzell Innerrhoden', AR: 'Appenzell Ausserrhoden', BE: 'Bern', BL: 'Basel-Landschaft',
  BS: 'Basel-Stadt', FR: 'Fribourg', GE: 'Geneva', GL: 'Glarus', GR: 'Graubünden', JU: 'Jura', LU: 'Lucerne',
  NE: 'Neuchâtel', NW: 'Nidwalden', OW: 'Obwalden', SG: 'St. Gallen', SH: 'Schaffhausen', SO: 'Solothurn',
  SZ: 'Schwyz', TG: 'Thurgau', TI: 'Ticino', UR: 'Uri', VD: 'Vaud', VS: 'Valais', ZG: 'Zug', ZH: 'Zurich',
});

function articleTitle(data = {}) {
  return String(data.title || data.content?.it?.title || data.content?.title || '').trim();
}

function textValues(values) {
  return values
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => String(value || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export function articleImageTopic(data = {}) {
  return textValues([data.topic, data.category, data.subject]).join(', ').slice(0, 500);
}

export function articleImagePlace(data = {}, area = '') {
  const cantonValues = textValues([data.canton, data.cantonCode])
    .map((value) => CANTON_NAMES[value.toUpperCase()] || value);
  return textValues([data.place, data.location, cantonValues, area]).join(', ').slice(0, 500);
}

export function articleImageKeywords(data = {}) {
  return textValues([
    data.keywords,
    data.tags,
    data.seo?.keywords,
    data.content?.it?.keywords,
  ]).slice(0, 32);
}

export function articleImageSubject(data = {}) {
  const title = articleTitle(data);
  const context = String(data.imagePrompt || '').replace(/\s+/g, ' ').trim();
  return [title, context].filter(Boolean).join(' — ').slice(0, 500);
}

export function articleImageAssetId(value) {
  const raw = typeof value === 'object' && value !== null ? value.id : value;
  const normalized = String(raw || 'article').toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `article-${(normalized || 'article').slice(0, 110)}`;
}

export function articleHeroImagePath(imageUrl) {
  const normalized = String(imageUrl || '');
  if (!ARTICLE_HERO_PATH.test(normalized)) {
    throw new Error(`Governed engine returned an invalid article-hero path: ${normalized || '<empty>'}`);
  }
  return normalized;
}
