/**
 * Normalizzazione e conteggio comuni per producer P10 e confine del publisher
 * cantonale.
 *
 * Il renderer `engine/cantonSectionPages.ts` e' il mirror del sito e resta la
 * sorgente del contratto di rendering. Il test dei moduli hub verifica che la
 * costante qui mantenuta resti uguale alla costante del renderer: il corpus
 * non importa codice dal repo sito e non modifica il mirror.
 */

export const CANTON_HUB_MIN_CONTENT_WORDS = 50;

function countWords(text) {
  return String(text ?? '').split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function normalizeList(value, field, context, { optional = false } = {}) {
  if (value === undefined && optional) return [];
  if (!Array.isArray(value)) throw new Error(`${context}: ${field} deve essere un array`);
  return value.map((entry, index) => {
    if (!isPlainObject(entry)) throw new Error(`${context}: ${field}[${index}] deve essere un oggetto`);
    return entry;
  });
}

/**
 * Confine canonico per l'input del renderer hub.
 *
 * I dati invalidi non vengono trasformati in liste vuote: il publisher deve
 * fallire chiuso prima che l'engine possa chiamare `.map` o dereferenziare
 * una voce nulla. Le liste vengono clonate e `latestCantonArticles`, che e'
 * opzionale nei documenti storici, viene sempre esposta come array.
 */
export function normalizeCantonHubInput(input, context = 'canton hub') {
  if (!isPlainObject(input)) throw new Error(`${context}: atteso un oggetto`);
  const normalized = {
    ...input,
    keyFacts: normalizeList(input.keyFacts, 'keyFacts', context),
    dataBlocks: normalizeList(input.dataBlocks, 'dataBlocks', context).map((block, index) => ({
      ...block,
      items: normalizeList(block.items, `dataBlocks[${index}].items`, context),
    })),
    curatedArticles: normalizeList(input.curatedArticles, 'curatedArticles', context),
    latestCantonArticles: normalizeList(input.latestCantonArticles, 'latestCantonArticles', context, { optional: true }),
    links: normalizeList(input.links, 'links', context),
  };
  return normalized;
}

function paragraphsOf(intro) {
  return String(intro ?? '')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** Parole che restano visibili nel contenuto dell'hub. */
export function countCantonHubContentWords(input) {
  const normalized = normalizeCantonHubInput(input);
  const paragraphs = paragraphsOf(normalized.intro);
  const { keyFacts, dataBlocks, curatedArticles, latestCantonArticles } = normalized;
  const visibleArticles = curatedArticles.length > 0 ? curatedArticles : latestCantonArticles;
  return (
    paragraphs.reduce((total, paragraph) => total + countWords(paragraph), 0) +
    keyFacts.reduce((total, fact) => total + countWords(`${fact.label} ${fact.value} ${fact.note ?? ''}`), 0) +
    dataBlocks.reduce((total, block) => total + countWords(`${block.title} ${block.description ?? ''}`) +
      block.items.reduce((subtotal, item) => subtotal + countWords(`${item.label} ${item.value ?? ''} ${item.detail ?? ''}`), 0), 0) +
    visibleArticles.reduce((total, article) => total + countWords(`${article.title} ${article.excerpt ?? ''}`), 0)
  );
}

/** Parole dell'intro evergreen, per il fallback senza dataset. */
export function countCantonHubIntroWords(input) {
  return paragraphsOf(input?.intro).reduce((total, paragraph) => total + countWords(paragraph), 0);
}
