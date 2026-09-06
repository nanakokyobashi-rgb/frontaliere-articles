/**
 * count-xml-tags.mjs — conteggio dei tag a livello di DOCUMENTO.
 *
 * WHY THIS EXISTS
 * ───────────────
 * `rssItems` (e la sua controparte `sitemapBlogUrls`) veniva contato con uno
 * `split('<item>')` sul testo grezzo del feed. Ma una `description` RSS viaggia
 * dentro `<![CDATA[ ... ]]>`, e il corpus contiene articoli che parlano di RSS:
 * una description che cita letteralmente `<item>` viene contata come se fosse
 * un elemento del feed. Il needle testuale non distingue markup da testo.
 *
 * Il difetto e' peggiore di un numero sbagliato: il gate di
 * `manifest.counts` in build-api.mjs confronta un numero DICHIARATO con uno
 * RI-DERIVATO, e se entrambi i lati usano lo stesso needle il CDATA gonfia
 * identicamente i due, quindi il gate resta verde. Gonfia nella direzione che
 * MASCHERA un troncamento: un feed che perde un item ma ne cita uno nel testo
 * torna a pareggiare. Stessa cosa dal lato dei pavimenti
 * (`scripts/ci/verify-api-floors.mjs`), dove un `<item>` fantasma alza il
 * conteggio misurato sopra il pavimento.
 *
 * Per questo la funzione vive qui e non in uno dei due chiamanti: writer, gate
 * e pavimenti DEVONO usare la stessa formula (AGENTS.md #6, «un valore
 * condiviso ha UNA sorgente»). Due formule che divergono sono esattamente il
 * modo in cui un gate smette di poter fallire.
 *
 * Cosa NON e': un parser XML. Non ne serve uno per contare i tag di apertura di
 * documenti che questo repo scrive, e aggiungere una dipendenza a un gate di
 * publish e' un costo che non paghiamo. Quello che serve e' escludere le
 * regioni che per definizione NON sono markup — sezioni CDATA e commenti —
 * prima di contare.
 */

const NON_MARKUP_REGIONS = /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->/g;

/** Il documento senza le regioni che non sono markup (CDATA, commenti). */
export function stripNonMarkup(xml) {
  return String(xml ?? '').replace(NON_MARKUP_REGIONS, '');
}

/**
 * Quante volte `<tag>` compare come tag di apertura nel documento.
 *
 * Il match ammette gli attributi (`<item foo="bar">`) ma pretende un
 * delimitatore dopo il nome, quindi `<url>` non collide con `<urlset>` —
 * la stessa proprieta' che il needle `'<url>'` otteneva per caso con la
 * parentesi chiusa, qui resa esplicita.
 */
export function countXmlTags(xml, tag) {
  const openTag = new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'g');
  return (stripNonMarkup(xml).match(openTag) ?? []).length;
}
