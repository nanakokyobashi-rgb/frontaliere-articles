/**
 * Conteggio comune per producer P10 e confine del publisher cantonale.
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

function paragraphsOf(intro) {
  return String(intro ?? '')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** Parole che restano visibili nel contenuto dell'hub. */
export function countCantonHubContentWords(input) {
  const paragraphs = paragraphsOf(input?.intro);
  return (
    paragraphs.reduce((total, paragraph) => total + countWords(paragraph), 0) +
    (input?.keyFacts ?? []).reduce((total, fact) => total + countWords(`${fact.label} ${fact.value} ${fact.note ?? ''}`), 0) +
    (input?.dataBlocks ?? []).reduce((total, block) => total + countWords(`${block.title} ${block.description ?? ''}`) +
      (block.items ?? []).reduce((subtotal, item) => subtotal + countWords(`${item.label} ${item.value ?? ''} ${item.detail ?? ''}`), 0), 0) +
    (input?.curatedArticles ?? []).reduce((total, article) => total + countWords(`${article.title} ${article.excerpt ?? ''}`), 0)
  );
}

/** Parole dell'intro evergreen, per il fallback senza dataset. */
export function countCantonHubIntroWords(input) {
  return paragraphsOf(input?.intro).reduce((total, paragraph) => total + countWords(paragraph), 0);
}
