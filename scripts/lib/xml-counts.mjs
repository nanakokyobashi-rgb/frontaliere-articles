/**
 * xml-counts.mjs — contare i tag di un documento XML senza contare il testo che
 * ci sta dentro.
 *
 * WHY THIS EXISTS
 * ───────────────
 * `manifest.counts.rssItems` e il pavimento dei feed (`verify-api-floors.mjs`)
 * derivavano entrambi il numero di voci di un feed con
 * `xml.split('<item>').length - 1`: una ricerca TESTUALE sull'intero documento.
 *
 * Ma `renderFeed` incorpora il corpo integrale dell'articolo in
 * `<content:encoded><![CDATA[…]]></content:encoded>` (`engine/rssFeeds.mjs`), e
 * `escapeCData` neutralizza SOLO `]]>` — il literal `<item>` dentro un corpo
 * resta tale e viene contato. Un corpo che parla di markup (o una tabella
 * incollata da un feed altrui) gonfia quindi il conteggio, e l'errore va nella
 * direzione peggiore: **maschera** un troncamento, perche' il pavimento e' un
 * `<` e un conteggio gonfiato lo supera.
 *
 * Il fix e' contare a livello di DOCUMENTO: le sezioni CDATA sono testo per
 * definizione, quindi vengono rimosse prima di cercare i tag. Non e' un parser
 * XML — non ne serve uno per contare un tag di apertura — ma non guarda piu'
 * dentro il testo, che era l'unico difetto.
 *
 * Solo builtin Node, per la regola di `scripts/ci/**`: eseguibile senza `npm ci`.
 */

/**
 * Il contenuto delle sezioni CDATA, sostituito da niente.
 *
 * `[\s\S]*?` e non `.*?`: i corpi degli articoli sono multi-riga, e senza il
 * match su newline la rimozione si fermerebbe alla prima riga lasciando dentro
 * tutto il resto.
 */
const CDATA_RE = /<!\[CDATA\[[\s\S]*?]]>/g;

/** I commenti XML: anche loro sono testo, e possono contenere un tag d'esempio. */
const COMMENT_RE = /<!--[\s\S]*?-->/g;

/** Il documento senza le sue sezioni di testo — cioe' la sola struttura. */
export function stripTextSections(xml) {
  return String(xml ?? '')
    .replace(CDATA_RE, '')
    .replace(COMMENT_RE, '');
}

/**
 * Quante volte il tag di APERTURA `name` compare nella struttura del documento.
 *
 * `<item>` e `<item attr="…">` contano entrambi; `<items>` no (il confine e'
 * esplicito), e `</item>` nemmeno — si contano le aperture, una per elemento.
 * Il nome viene passato senza parentesi: `countTags(xml, 'item')`.
 */
export function countTags(xml, name) {
  const re = new RegExp(`<${name}(?=[\\s/>])`, 'g');
  return (stripTextSections(xml).match(re) || []).length;
}
