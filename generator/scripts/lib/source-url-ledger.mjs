/**
 * source-url-ledger.mjs — la CHIAVE e la forma delle voci dei due ledger
 * URL→id, e la finestra oltre la quale una voce smette di bloccare la PROPRIA
 * sezione.
 *
 * ## Il difetto che chiude
 *
 * `data/article-source-urls.json` e `data/swiss-article-source-urls.json`
 * mappano l'URL normalizzato della fonte sull'id dell'articolo che ne è nato.
 * `saveSourceUrls` dichiara una finestra — `entries.slice(-500)` — ma è una
 * FIFO **non ancora ingaggiata** (137/500 e 268/500 il 2026-08-18) e senza
 * alcun criterio temporale: di fatto il ledger cresce di +1 per articolo, per
 * sempre. Le fonti invece riservono gli stessi URL a ogni giro, quindi
 * l'insieme scansionabile resta fisso mentre l'insieme dei bloccati sale.
 *
 * MISURATO il 2026-08-18 sulle 49 fonti `frontaliere`, scansione reale:
 * 1.791 URL normalizzati visti, **45 già nel ledger della stessa sezione**.
 * È da lì che viene il collo di bottiglia `📋 Post-filtro URL: 19/51` — non
 * dal ramo Jaccard (`url_slug_match`), che sugli stessi run pesa 2 scarti su 37.
 *
 * ## Perché la finestra è 5 giorni e non 90
 *
 * La scheda proponeva 90 giorni «per coerenza con `TOPIC_COVERAGE_WINDOW_DAYS`».
 * Rimisurato prima di scrivere il codice, 90 **non scade niente**, e non è un
 * fatto transitorio:
 *
 *  · età delle 45 voci che bloccano oggi (data di primo commit del file, git):
 *    p50 4,6 giorni, p90 8,9, **max 11,6**. Recupero per finestra —
 *    90d: 0/45 · 30d: 0/45 · 14d: 0/45 · 7d: 5/45 · **5d: 19/45** · 3d: 27/45.
 *  · a regime la FIFO da 500 voci, al ritmo misurato di ~9 registrazioni al
 *    giorno per sezione, sfratta da sola tutto ciò che supera i ~55 giorni.
 *    Una finestra a 90 giorni sta quindi SEMPRE dietro al cap: sarebbe codice
 *    che non può eseguirsi.
 *
 * Cinque giorni è l'unico valore che tiene insieme le due cose:
 *
 *  1. **> `MAX_ARTICLE_AGE_DAYS` (3)**, ed è l'invariante che rende la finestra
 *     sicura. Una headline DATATA più vecchia di 3 giorni è già scartata dal
 *     filtro di recency, prima ancora del ledger; una più recente di 3 giorni
 *     non può essere scaduta qui, perché la finestra si apre solo al quinto.
 *     Ne segue che la scadenza può riammettere **solo headline UNDATED** —
 *     esattamente il secchio in cui il ledger sovra-blocca — e mai riaprire un
 *     documento di fonte ancora fresco. Il test
 *     `generator/tests/source-url-ledger-ttl.test.mjs` lo verifica.
 *  2. **< l'orizzonte della FIFO** (~55 giorni), quindi la finestra morde
 *     davvero invece di essere ombreggiata dal cap.
 *
 * ## Cosa NON scade, e perché
 *
 *  · **Il ramo cross-sezione resta permanente.** La garanzia comprata
 *    dall'incidente #251 — una fonte non produce un articolo in due sezioni —
 *    non ha una rete equivalente a valle, mentre il riuso DENTRO la sezione ha
 *    ancora `preFlightHeadlineCheck`, `checkForDuplicates` e
 *    `checkSemanticNearDuplicate`. La scadenza è quindi applicata alla sola
 *    vista della sezione attiva, e `cross-section-dedup.mjs` (`mode: identical`)
 *    non viene toccato: riceve mappe URL→id di stringhe come sempre.
 *  · **Una voce senza `ts` è permanente, non scaduta.** I due file oggi
 *    contengono stringhe nude: leggerle come «senza data quindi vecchie»
 *    azzererebbe entrambi i ledger al primo deploy. Il `ts` compare solo sulle
 *    voci scritte da qui in avanti, quindi la finestra comincia a mordere dopo
 *    `SOURCE_URL_TTL_DAYS` giorni di esercizio.
 *
 * Il modulo è puro (i ledger arrivano come argomento) perché
 * `create-article.mjs` non è importabile in test senza `node_modules` — stessa
 * ragione di `cross-section-dedup.mjs`.
 */

import { createHash } from 'node:crypto';

// ── La CHIAVE del ledger ─────────────────────────────────────────────────────
//
// ## Il difetto che chiude
//
// `normalizeNewsUrl` costruiva la chiave come `protocol//hostname + pathname` e
// buttava via la query. Su una fonte che identifica il documento SOLO nella
// query, ogni articolo del feed collassa sulla stessa chiave: pubblicato un
// comunicato, il giorno dopo un comunicato COMPLETAMENTE DIVERSO trova un hit
// esatto e viene scartato a `preFilterDrops.urlAlreadyUsed`. Il ramo fuzzy non
// salva — `extractUrlSlugWords` su quel path non trova parole descrittive.
//
// MISURATO il 2026-08-18 con l'estrattore reale (`extractRssItems`) sui 69 feed
// di `NEWS_SOURCES`, 1.121 item:
//
//   feed                                        item → chiavi
//   https://www.uil.it/feed                       60 → 1
//   https://www3.ti.ch/xml/rss/rss-comunicati-1108.xml  10 → 1
//   https://www3.ti.ch/xml/rss/rss-attualita.xml        10 → 2
//   https://www3.ti.ch/xml/rss/rss-comunicati.xml        8 → 2
//
// 82 item su 1.121 perdono la propria identità, tutti su 4 feed. Con la finestra
// di `SOURCE_URL_TTL_DAYS` la resa di ciascuno passa da «1 articolo per sempre»
// a «1 ogni 5 giorni», su feed che ne pubblicano ~8-10 a settimana.
//
// ## Il criterio: DENYLIST dei parametri di tracciamento, non allowlist
//
// Tenere tutta la query renderebbe unica ogni condivisione (`utm_*`, `fbclid`)
// e ucciderebbe il dedup dove oggi funziona. Le tre vie possibili, e perché
// questa:
//
//  · **Allowlist** dei nomi identificanti (`NEWS_ID`, `ID_News`, …): il suo
//    fallimento è ESATTAMENTE il difetto che stiamo chiudendo, e fallisce in
//    silenzio — una fonte nuova con un nome di parametro non previsto ricollassa
//    con la CI verde, e l'unico sintomo è «questo feed produce un articolo solo».
//    `NEWS_SOURCES` ha 69 voci e cresce.
//  · **Per-host**: stessa manutenzione dell'allowlist con una tabella più grande,
//    e non generalizza a nessuna fonte futura.
//  · **Denylist**: il suo fallimento è un duplicato che PASSA, e sotto ci sono
//    già `preFlightHeadlineCheck`, `checkForDuplicates`,
//    `checkSemanticNearDuplicate` e il gate di collisione del titolo in
//    `optimizeSeoMetadata`. Il collasso invece non ha niente sotto. È la stessa
//    asimmetria di conseguenze con cui #417 ha scelto DOVE applicare la finestra.
//
// Misura che la rende poco rischiosa oggi: sui 1.121 item reali **solo 88
// portano una query**, e tutti e 88 stanno sui 4 feed qui sopra. Ogni altra
// fonte emette link canonici senza query — per loro la chiave non cambia di un
// byte.
//
// ## `&amp;`, che non è un dettaglio
//
// `extractRssItems` non de-escapa le entità XML dell'href, quindi l'URL che
// arriva qui contiene letteralmente `&amp;`: i parametri di uil.it si chiamano
// `amp;utm_source`, non `utm_source`, e una denylist sul nome NON li
// riconoscerebbe. Si de-escapa qui, dove la chiave si costruisce, perché è qui
// che il nome del parametro conta.
//
// ## Compatibilità con le voci già scritte
//
// Le 414 voci committate il 2026-08-18 (139 + 275) hanno **zero** chiavi con
// query e **zero** chiavi su un path contenitore o su un endpoint di script
// (`index.php`, `*.asp`, `.../dettaglio`): nessuna di loro può quindi essere
// stata prodotta da un URL query-identificato. La chiave di forma 2 coincide con
// quella di forma 1 per ogni URL senza query e per ogni URL la cui query è tutta
// tracciamento — cioè per tutte.
//
// Resta il caso non misurabile dall'esterno (un URL storico con query
// identificante su un path descrittivo). Per quello c'è il ponte: le voci
// scritte da qui in avanti portano `keyForm: 2`, e `isSourceUrlAlreadyUsed`
// consulta la chiave di forma 1 **solo contro le voci senza quel marcatore**.
// Serve soprattutto al ramo cross-sezione di #251, l'unico che non ha una rete
// a valle: senza il ponte, per la durata della transizione la stessa fonte
// potrebbe produrre un articolo in entrambe le sezioni.

// ── L'identita' dell'ITEM, quando l'URL non basta ───────────────────────────
//
// ## Il difetto che chiude (P5b)
//
// Ogni chiave qui sotto assume che un URL sia UN documento. Alcune testate
// hanno pagine-contenitore a URL fisso il cui contenuto e' la notizia del
// momento: il feed le riemette con lo stesso `<link>` (e lo stesso `<guid>`,
// che e' il permalink) e un titolo diverso a ogni aggiornamento.
//
// MISURATO il 2026-10-05 sui feed di suedostschweiz.ch (canton-gr, canton-gl):
//
//   /graubuenden/verkehrsticker-1574112          «Nach Unfall zwischen Flims und Trin: Verkehr fliesst wieder»
//   /graubuenden/kurzvermeldet-2-1413736         «Schluein vs. Sana Surselva: …»
//   /graubuenden/bonaduz-feuerwehr-loescht-brand-auf-dach-mit-photovoltaikanlage-1413717
//                                                «Deshalb war die Strasse gesperrt: Anhänger von Lastwagen …»
//   /glarus/meldungen-aus-dem-glarnerland-1916134 «Bye bye Billettschalter: SBB schliessen Reisezentrum …»
//
// e sul feed Tamedia di bazonline (canton-basilea): tre «Ticker» permanenti
// (`/ticker-ukraine-russland-krieg-moskau-kyjiw-34-…`) il cui titolo e'
// l'ultima notizia. L'ultimo esempio di suedostschweiz dice perche' non basta
// riconoscere la parola «ticker» nello slug: il contenitore e' nato come
// articolo sull'incendio di Bonaduz e oggi porta un incidente stradale.
//
// Con la chiave sul solo URL: generato UN articolo da un contenitore, ogni
// notizia successiva a quell'indirizzo e' «URL gia' usata»; un abort di
// REGOLA #0 su una notizia blocca le successive per 48 h; e il ramo fuzzy
// confronta con gli id esistenti uno slug che non descrive piu' la notizia.
//
// ## La forma: l'identita' viaggia NELL'URL, come frammento
//
// Lo scanner (`canton-news-sources.mjs`, quirk `urlReusedForDifferentStories`
// del profilo) aggiunge all'URL `#ft-item=<impronta di titolo e giornata>`. Il frammento
// non arriva mai al server, quindi l'URL resta scaricabile cosi' com'e'; e
// poiche' ogni consumatore di create-article.mjs (ledger, memo del topic-gate,
// dedup del pool) passa da `newsUrlKey`, basta che la chiave lo conservi
// perche' TUTTI distinguano due notizie allo stesso indirizzo — senza far
// passare un secondo campo per ognuno di quei punti. Ogni altro frammento
// continua a essere ignorato: per gli URL senza `#ft-item=` la chiave non
// cambia di un byte.
//
// Il costo dichiarato: un titolo ritoccato dalla redazione, o una voce
// ripubblicata un altro giorno, cambia l'impronta, e la stessa notizia puo'
// ripassare dal ledger. E' un duplicato che PASSA, e
// sotto ci sono `preFlightHeadlineCheck`, `checkForDuplicates` e
// `checkSemanticNearDuplicate`; il collasso di notizie diverse sulla stessa
// chiave, invece, non ha niente sotto. Stessa asimmetria della denylist qui
// sotto.

/** Nome del frammento che porta l'identita' dell'item (`#ft-item=<impronta>`). */
export const ITEM_IDENTITY_FRAGMENT = 'ft-item';

const ITEM_IDENTITY_RE = new RegExp(`^#${ITEM_IDENTITY_FRAGMENT}=([0-9a-f]{12})$`);

/** Entita' HTML con nome che valgono un carattere preciso (le altre, vedi sotto). */
const NAMED_CHAR_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', szlig: 'ß', aelig: 'æ', oelig: 'œ', oslash: 'ø' };

/**
 * Il testo di un titolo ridotto a cio' che lo identifica: entita' HTML
 * decodificate, accenti e maiuscole tolti, punteggiatura resa spazio.
 *
 * Le entita' si DECODIFICANO prima di normalizzare, non si buttano: lo stesso
 * titolo arriva come `Caf&eacute;`, `Caf&#233;` o `Café` secondo come la fonte
 * serializza quel giorno (o da quale dei suoi feed lo si legge), e tre
 * impronte per un titolo sono tre passaggi dal ledger. Le lettere accentate
 * con nome (`&eacute;`, `&uuml;`, `&ccedil;`…) valgono la lettera base, che e'
 * cio' che NFKD + rimozione dei diacritici lascia del carattere vero; ogni
 * altra entita' con nome e' punteggiatura (`&laquo;`, `&ndash;`, `&hellip;`).
 */
function normalizeItemText(text) {
  return String(text ?? '')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (m, code) => {
      const n = code[0] === 'x' || code[0] === 'X' ? parseInt(code.slice(1), 16) : parseInt(code, 10);
      return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ';
    })
    .replace(/&([a-z])(?:acute|grave|circ|uml|tilde|cedil|ring|caron);/gi, '$1')
    .replace(/&([a-z]+\d*);/gi, (m, name) => NAMED_CHAR_ENTITIES[name.toLowerCase()] ?? ' ')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Impronta stabile di cio' che distingue l'item: il titolo e, dove la fonte la
 * da', la GIORNATA di pubblicazione (UTC). Maiuscole, accenti, punteggiatura e
 * forma delle entita' HTML non contano: «Verkehr fliesst wieder!» e «verkehr
 * fliesst wieder» sono lo stesso item.
 *
 * Perche' anche la giornata: un contenitore ripete i titoli («Julierpass
 * gesperrt» oggi e fra tre giorni sono due notizie), e col solo titolo la
 * seconda resterebbe «gia' usata» fino alla scadenza del ledger. Perche' la
 * giornata e non l'istante: la stessa voce letta dal feed e dalla news sitemap
 * della testata deve avere UNA chiave (misurato su suedostschweiz.ch il
 * 2026-10-05: `pubDate` e `news:publication_date` coincidono al secondo, ma
 * l'invariante non deve dipendere dal secondo), e una voce che resta nel feed
 * per giorni col suo `pubDate` resta se' stessa.
 *
 * @param {string} text il titolo dato dalla fonte
 * @param {Date | null} [date] la data di pubblicazione, se c'e'
 * @returns {string | null} 12 cifre esadecimali, o null se non resta testo
 */
export function itemIdentityToken(text, date = null) {
  const normalized = normalizeItemText(text);
  if (!normalized) return null;
  const day = date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : '';
  return createHash('sha1').update(day ? `${normalized}\n${day}` : normalized).digest('hex').slice(0, 12);
}

/** Quota minima delle parole del titolo che la pagina deve portare (vedi sotto). */
export const ITEM_ON_PAGE_MIN_SHARE = 0.6;

/**
 * Il testo porta le parole distintive (almeno 4 lettere) di questo titolo?
 * Sulle parole e non sulla frase: una pagina non sempre ripete il titolo alla
 * lettera. Un titolo senza parole distintive non si puo' verificare e non
 * passa.
 *
 * @param {string} text
 * @param {string} headline
 * @returns {boolean}
 */
export function pageCarriesItem(text, headline, { minShare = ITEM_ON_PAGE_MIN_SHARE } = {}) {
  const words = [...new Set(normalizeItemText(headline).split(' ').filter((w) => w.length >= 4))];
  if (words.length === 0) return false;
  const page = new Set(normalizeItemText(text).split(' '));
  const found = words.filter((w) => page.has(w)).length;
  return found / words.length >= minShare;
}

// A `<textarea>` or `<title>` is active document content when it appears in
// the page, but its text is raw markup while it is nested in a `<template>`.
// Keep those two sets separate: masking an active `<title>` would erase the
// evidence used by pageTitleEvidence().
const MASK_VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);
const INACTIVE_RAW_TEXT_TAGS = new Set(['script', 'style', 'noscript', 'iframe', 'xmp', 'noembed', 'noframes']);
const TEMPLATE_RAW_TEXT_TAGS = new Set([
  'script', 'style', 'textarea', 'title', 'noscript', 'iframe', 'xmp',
  'noembed', 'noframes',
]);

function maskHtmlWhitespace(char) {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
}

function maskFindTagEnd(html, start) {
  let quote = '';
  for (let i = start + 1; i < html.length; i++) {
    const char = html[i];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return i;
    }
  }
  return -1;
}

function maskIsSelfClosingStartTag(html, nameEnd, end) {
  let i = nameEnd;
  while (i < end) {
    while (i < end && maskHtmlWhitespace(html[i])) i++;
    if (i >= end) return false;
    if (html[i] === '/') return i + 1 === end;

    while (
      i < end &&
      !maskHtmlWhitespace(html[i]) &&
      html[i] !== '=' &&
      html[i] !== '/' &&
      html[i] !== '>'
    ) i++;
    if (html[i] !== '=') continue;

    i++;
    while (i < end && maskHtmlWhitespace(html[i])) i++;
    if (i >= end) return false;
    const quote = html[i];
    if (quote === '"' || quote === "'") {
      i++;
      while (i < end && html[i] !== quote) i++;
      if (i >= end) return false;
      i++;
      continue;
    }
    // In HTML's unquoted attribute-value state `/` belongs to the value.
    while (i < end && !maskHtmlWhitespace(html[i]) && html[i] !== '>') i++;
  }
  return false;
}

function maskReadTag(html, start) {
  if (html[start] !== '<') return null;
  let i = start + 1;
  const closing = html[i] === '/';
  if (closing) i++;
  const nameStart = i;
  while (i < html.length && /[A-Za-z0-9:_-]/.test(html[i])) i++;
  if (i === nameStart) return null;
  const boundary = html[i] ?? '';
  if (boundary && !/[\s/>]/.test(boundary)) return null;
  const end = maskFindTagEnd(html, start);
  if (end < 0) return null;
  const name = html.slice(nameStart, i).toLowerCase();
  return {
    closing,
    end,
    name,
    selfClosing: !closing && MASK_VOID_ELEMENTS.has(name)
      && maskIsSelfClosingStartTag(html, i, end),
  };
}

function maskSkipComment(html, start) {
  const end = html.indexOf('-->', start + 4);
  return end < 0 ? -1 : end + 3;
}

function maskSkipRawText(html, afterOpening, name) {
  const closing = new RegExp(`</${name}\\s*>`, 'ig');
  closing.lastIndex = afterOpening;
  const match = closing.exec(html);
  return match ? match.index + match[0].length : -1;
}

function maskSkipTemplate(html, afterOpening) {
  let depth = 1;
  let cursor = afterOpening;
  while (cursor < html.length) {
    const start = html.indexOf('<', cursor);
    if (start < 0) return -1;
    if (html.startsWith('<!--', start)) {
      const afterComment = maskSkipComment(html, start);
      if (afterComment < 0) return -1;
      cursor = afterComment;
      continue;
    }
    const tag = maskReadTag(html, start);
    if (!tag) {
      cursor = start + 1;
      continue;
    }
    if (tag.name === 'template') {
      if (tag.closing) {
        depth--;
        if (depth === 0) return tag.end + 1;
      } else if (!tag.selfClosing) {
        depth++;
      }
    } else if (
      !tag.closing &&
      !tag.selfClosing &&
      TEMPLATE_RAW_TEXT_TAGS.has(tag.name)
    ) {
      const afterRawText = maskSkipRawText(html, tag.end + 1, tag.name);
      if (afterRawText < 0) return -1;
      cursor = afterRawText;
      continue;
    }
    cursor = tag.end + 1;
  }
  return -1;
}

/**
 * L'HTML con i nodi INATTIVI resi spazi, a pari lunghezza (gli indici restano
 * quelli del documento): commenti, `<script>`, `<style>`, `<template>` e i
 * blocchi annidati dentro i template. Lo scanner e' stateful perche' una
 * regex si ferma al primo `</template>` e rende visibili i link di un template
 * esterno quando il markup contiene template annidati.
 *
 * @param {string} html
 * @returns {string}
 */
export function maskInactiveMarkup(html) {
  const source = String(html || '');
  const output = source.split('');
  const blank = (start, end) => {
    for (let i = start; i < end; i++) output[i] = ' ';
  };
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf('<', cursor);
    if (start < 0) break;
    if (source.startsWith('<!--', start)) {
      const afterComment = maskSkipComment(source, start);
      blank(start, afterComment < 0 ? source.length : afterComment);
      if (afterComment < 0) break;
      cursor = afterComment;
      continue;
    }
    const tag = maskReadTag(source, start);
    if (!tag) {
      cursor = start + 1;
      continue;
    }
    if (!tag.closing && !tag.selfClosing && INACTIVE_RAW_TEXT_TAGS.has(tag.name)) {
      const afterRawText = maskSkipRawText(source, tag.end + 1, tag.name);
      blank(start, afterRawText < 0 ? source.length : afterRawText);
      if (afterRawText < 0) break;
      cursor = afterRawText;
      continue;
    }
    if (tag.name === 'template' && !tag.closing && !tag.selfClosing) {
      const afterTemplate = maskSkipTemplate(source, tag.end + 1);
      blank(start, afterTemplate < 0 ? source.length : afterTemplate);
      if (afterTemplate < 0) break;
      cursor = afterTemplate;
      continue;
    }
    cursor = tag.end + 1;
  }
  return output.join('');
}

/**
 * I titoli che una pagina dichiara di se': `og:title`, `twitter:title`,
 * `<title>` e gli `<h1>`. Servono alla verifica qui sotto perche' il testo che
 * `extractArticleText` estrae e' il CORPO (`articleBody`, i paragrafi di
 * `<article>`/`<main>`), senza l'`h1`: un articolo che non ripete nel corpo le
 * parole del proprio titolo verrebbe scartato pur essendo l'item giusto.
 *
 * @param {string} html
 * @returns {string} i titoli, uno per riga ('' se non ce n'e')
 */
export function pageTitleEvidence(html) {
  // Solo markup attivo: un `<h1>` o un `<title>` dentro un commento, uno
  // script o un template puo' essere il titolo di un'altra notizia.
  const src = maskInactiveMarkup(html);
  const out = [];
  for (const m of src.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\b(?:property|name)\s*=\s*["']?(?:og:title|twitter:title)["'\s>]/i.test(tag)) continue;
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    if (content) out.push(content[1] ?? content[2] ?? '');
  }
  for (const m of src.matchAll(/<(title|h1)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) out.push(m[2].replace(/<[^>]+>/g, ' '));
  return out.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

/**
 * La pagina scaricata e' ancora QUESTO item? La verifica per gli URL riusati,
 * prima di generare.
 *
 * Un URL riusato porta la notizia del momento: fra la lettura del feed e la
 * generazione, o per una voce che il feed riporta accanto a una piu' recente
 * allo stesso indirizzo, la pagina puo' essere gia' passata a un'altra
 * notizia. Generare allora vorrebbe dire il titolo di un aggiornamento con i
 * fatti di un altro. Misurato il 2026-10-05 su
 * `/graubuenden/verkehrsticker-1574112`: la pagina dichiara `og:title` «Nach
 * Unfall zwischen Flims und Trin: Verkehr fliesst wieder» e
 * `article:published_time` 2026-10-05T10:49:15Z — il titolo e l'istante della
 * voce del feed — e nessuna delle parole dei titoli di maggio, giugno e agosto.
 *
 * Due condizioni, entrambe necessarie:
 *   1. le parole del titolo stanno nei titoli della pagina o nel suo testo;
 *   2. se l'item e la pagina dichiarano entrambi una data, e' la stessa
 *      giornata (UTC): l'identita' dell'item comprende la giornata, e lo
 *      stesso titolo riemesso un altro giorno e' un'altra notizia. Dove la
 *      pagina non dichiara una data il confronto non si puo' fare e decide la
 *      sola condizione 1.
 * Senza titoli ne' testo (pagina non scaricata) non si e' verificato niente:
 * la risposta e' no.
 *
 * @param {{ title?: string, text?: string, publishedAt?: string | Date | null }} page
 * @param {{ headline?: string, date?: string | Date | null }} item
 * @returns {{ ok: boolean, reason: 'ok' | 'no-page' | 'title-not-on-page' | 'other-day' }}
 */
export function checkItemOnPage(page, item) {
  const evidence = `${page?.title || ''}\n${page?.text || ''}`;
  if (!evidence.trim()) return { ok: false, reason: 'no-page' };
  if (!pageCarriesItem(evidence, item?.headline || '')) return { ok: false, reason: 'title-not-on-page' };
  const dayOf = (raw) => {
    if (!raw) return '';
    const d = raw instanceof Date ? raw : new Date(raw);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  };
  const itemDay = dayOf(item?.date);
  const pageDay = dayOf(page?.publishedAt);
  if (itemDay && pageDay && itemDay !== pageDay) return { ok: false, reason: 'other-day' };
  return { ok: true, reason: 'ok' };
}

/** L'URL con l'identita' dell'item nel frammento (un frammento gia' presente e' sostituito). */
export function withItemIdentity(rawUrl, token) {
  const raw = String(rawUrl ?? '');
  if (!token) return raw;
  const at = raw.indexOf('#');
  return `${at === -1 ? raw : raw.slice(0, at)}#${ITEM_IDENTITY_FRAGMENT}=${token}`;
}

/** L'impronta dell'item portata dall'URL, o null. */
export function itemIdentityOf(rawUrl) {
  const raw = String(rawUrl ?? '');
  const at = raw.indexOf('#');
  if (at === -1) return null;
  return ITEM_IDENTITY_RE.exec(raw.slice(at))?.[1] ?? null;
}

/** L'URL senza l'identita' dell'item: l'indirizzo da citare e da mostrare. */
export function stripItemIdentity(rawUrl) {
  const raw = String(rawUrl ?? '');
  return itemIdentityOf(raw) ? raw.slice(0, raw.indexOf('#')) : raw;
}

/** La forma di chiave che questo modulo scrive: path + query identificante. */
export const SOURCE_URL_KEY_FORM = 2;

/** Nomi interi di parametri che marcano campagna/referrer, mai il documento. */
const TRACKING_PARAM_NAMES = new Set([
  'fbclid', 'gclid', 'gbraid', 'wbraid', 'dclid', 'msclkid', 'yclid', 'twclid',
  'igshid', 'mc_cid', 'mc_eid', 'ref', 'referrer', 'referer', 'source', 'src',
  'cmpid', 'cmp', 'spm', 'xtor', 'ito', 'ncid', 'sref', 'share', 'sharedfrom',
  'feature', 'trk', 'trkcampaign', 'rss', 'from',
]);

/** Prefissi delle famiglie di tracciamento (Google, AT Internet, Matomo, HubSpot). */
const TRACKING_PARAM_PREFIXES = ['utm_', 'at_', 'pk_', 'mtm_', 'piwik_', 'ns_', 'hsa_', '_ga', '_gl'];

/** Oltre questo numero di parametri identificanti la chiave si accontenta. */
const MAX_KEY_PARAMS = 8;

/** Il parametro è un marcatore di tracciamento, cioè NON identifica il documento? */
export function isTrackingParam(name) {
  const n = String(name ?? '').toLowerCase();
  if (!n) return true;
  if (TRACKING_PARAM_NAMES.has(n)) return true;
  return TRACKING_PARAM_PREFIXES.some((p) => n.startsWith(p));
}

/** La base della chiave, comune alle due forme: schema + host + path. */
function urlKeyBase(u) {
  return `${u.protocol}//${u.hostname}${u.pathname}`.replace(/\/$/, '').toLowerCase();
}

/**
 * La chiave di forma **1**, storica: path soltanto, query buttata via.
 *
 * Non è codice morto e non va tolta: è la forma in cui sono scritte le voci
 * già nei due file, ed è ciò contro cui `isSourceUrlAlreadyUsed` interroga il
 * ponte. Sparirà quando spariranno le voci senza `keyForm`.
 */
export function legacyNewsUrlKey(rawUrl) {
  const raw = String(rawUrl ?? '');
  try {
    return urlKeyBase(new URL(raw));
  } catch {
    return raw.toLowerCase().replace(/\/$/, '');
  }
}

/**
 * La chiave di forma **2**: path + i parametri di query che identificano il
 * documento, ordinati, con i marcatori di tracciamento tolti.
 *
 * Proprietà su cui si appoggia la compatibilità: se dopo il filtro non resta
 * nessun parametro, e l'URL non porta l'identità di un item (`#ft-item=…`,
 * vedi sopra), il risultato è **identico** a `legacyNewsUrlKey`. Con
 * l'identità dell'item la chiave la porta in coda, in entrambi i casi.
 *
 * Il NOME del parametro viene minuscolizzato (uil.it emette lo stesso feed con
 * `ID_News` e `ID_NEWS`: sono lo stesso documento), il VALORE no — un id può
 * essere base64 o un hashid, e minuscolizzarlo fonderebbe due documenti
 * diversi. È la stessa direzione di rischio che questa fix esiste per togliere.
 */
export function newsUrlKey(rawUrl) {
  // `&amp;` → `&` prima di parsare: vedi il blocco su `extractRssItems` sopra.
  const raw = String(rawUrl ?? '').replace(/&amp;/gi, '&');
  let u;
  try {
    u = new URL(raw);
  } catch {
    return raw.toLowerCase().replace(/\/$/, '');
  }
  const base = urlKeyBase(u);
  const parts = [];
  for (const [name, value] of u.searchParams) {
    if (isTrackingParam(name)) continue;
    const v = String(value ?? '');
    // Un parametro senza valore non identifica niente (`?id=`): tenerlo
    // renderebbe la chiave diversa da quella dello stesso URL senza il
    // parametro, cioè romperebbe il dedup senza guadagnare identità.
    if (!v) continue;
    parts.push([name.toLowerCase(), v]);
  }
  // L'identita' dell'item (`#ft-item=…`), dove lo scanner l'ha messa: vedi il
  // blocco «L'identita' dell'ITEM» sopra. Nessun altro frammento entra in chiave.
  const item = itemIdentityOf(raw);
  const suffix = item ? `#${ITEM_IDENTITY_FRAGMENT}=${item}` : '';
  if (parts.length === 0) return `${base}${suffix}`;
  parts.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  // Il taglio a MAX_KEY_PARAMS è su una lista GIÀ ordinata, quindi è
  // deterministico: due volte lo stesso URL danno due volte la stessa chiave.
  // Oltre gli 8 parametri identificanti due documenti possono fondersi — mai
  // visto nel reale (massimo misurato: 4) e, se capitasse, cadrebbe negli
  // strati di dedup a valle.
  const query = parts.slice(0, MAX_KEY_PARAMS).map(([n, v]) => `${n}=${v}`).join('&');
  return `${base}?${query}${suffix}`;
}

/**
 * Giorni dopo i quali una voce DATATA smette di bloccare la propria sezione.
 * Deve restare `> MAX_ARTICLE_AGE_DAYS` (3) e `<` l'orizzonte della FIFO da
 * 500 voci (~55 giorni al ritmo misurato). Vedi il blocco sopra.
 */
export const SOURCE_URL_TTL_DAYS = 5;

/**
 * Normalizza il valore di una voce del ledger, in entrambe le forme.
 *
 * @param {unknown} value stringa (forma storica) oppure `{articleId, ts, keyForm}`.
 * @returns {{articleId: string, ts: string|null, keyForm: number}|null} `null`
 *          se la voce non porta un id utilizzabile. `keyForm` è **1** quando il
 *          marcatore manca: una voce scritta prima che la chiave imparasse la
 *          query è per definizione di forma 1, ed è esattamente l'insieme che
 *          il ponte di `isSourceUrlAlreadyUsed` ha il diritto di interrogare.
 */
export function readLedgerEntry(value) {
  if (typeof value === 'string') return value ? { articleId: value, ts: null, keyForm: 1 } : null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const articleId = typeof value.articleId === 'string' ? value.articleId : '';
  if (!articleId) return null;
  const ts = typeof value.ts === 'string' && value.ts ? value.ts : null;
  const keyForm = Number.isInteger(value.keyForm) && value.keyForm > 0 ? value.keyForm : 1;
  return { articleId, ts, keyForm };
}

/** L'id di articolo di una voce, in entrambe le forme; `''` se non ce n'è uno. */
export function ledgerArticleId(value) {
  return readLedgerEntry(value)?.articleId ?? '';
}

/**
 * La voce da scrivere per una registrazione nuova: id + istante + forma della
 * chiave sotto cui è archiviata, sempre tutte e tre.
 *
 * `keyForm` non serve a leggere QUESTA voce: serve a sapere che la sua CHIAVE
 * porta già la query identificante, e quindi che il ponte verso la forma 1 non
 * deve considerarla. Senza il marcatore quel ponte ricadrebbe sul path nudo
 * anche per le voci nuove, e rimetterebbe in piedi il collasso che la forma 2
 * toglie.
 */
export function makeLedgerEntry(articleId, now = Date.now()) {
  return { articleId: String(articleId), ts: new Date(now).toISOString(), keyForm: SOURCE_URL_KEY_FORM };
}

/**
 * Una voce datata è oltre la finestra?
 *
 * Senza `ts` la risposta è **sempre** `false` (voce storica → permanente).
 * Un `ts` illeggibile è trattato come assente, per la stessa ragione: un
 * timestamp rotto non deve poter sbloccare una fonte.
 */
export function isLedgerEntryExpired(value, { maxAgeDays = SOURCE_URL_TTL_DAYS, now = Date.now() } = {}) {
  const entry = readLedgerEntry(value);
  if (!entry || !entry.ts) return false;
  const at = Date.parse(entry.ts);
  if (!Number.isFinite(at)) return false;
  return now - at > maxAgeDays * 24 * 60 * 60 * 1000;
}

/**
 * La vista URL→id (valori STRINGA) di un ledger di forma mista.
 *
 * È la forma che `findCrossSectionSourceDuplicate` e `listCrossSectionDuplicates`
 * sanno leggere, e la ragione per cui `cross-section-dedup.mjs` non cambia.
 *
 * @param {Record<string, unknown>} map
 * @param {{maxAgeDays?: number|null, now?: number, keyForm?: number|null}} [opts]
 *        con `maxAgeDays` numerico le voci datate oltre la finestra vengono
 *        OMESSE; con `null` (default) la vista è completa, cioè permanente.
 *        Con `keyForm` numerico restano le sole voci archiviate sotto quella
 *        forma di chiave — serve al ponte verso la forma 1, e a nient'altro.
 */
export function ledgerArticleIds(map, { maxAgeDays = null, now = Date.now(), keyForm = null } = {}) {
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [url, value] of Object.entries(map)) {
    const entry = readLedgerEntry(value);
    if (!entry) continue;
    const articleId = entry.articleId;
    if (keyForm != null && entry.keyForm !== keyForm) continue;
    if (maxAgeDays != null && isLedgerEntryExpired(value, { maxAgeDays, now })) continue;
    // `defineProperty` e non `out[url] = …`: un URL che normalizzasse a
    // `__proto__` verrebbe ASSORBITO dall'assegnazione semplice — il valore
    // sparirebbe e la vista perderebbe una voce bloccante senza dirlo.
    // `JSON.parse` invece quella chiave la crea come proprieta' propria, quindi
    // la mappa in ingresso ce l'ha davvero. Stessa cura dell'`hasOwnProperty`
    // in `cross-section-dedup.mjs`, dall'altro capo dello stesso dato.
    Object.defineProperty(out, url, { value: articleId, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/**
 * Le viste da passare a `findCrossSectionSourceDuplicate`: la sezione attiva
 * con la finestra applicata, tutte le altre permanenti.
 *
 * `keyForm` attraversa entrambe: il ponte verso la forma 1 vuole la stessa
 * asimmetria della ricerca principale — finestra sulla sezione attiva, sorelle
 * permanenti — ristretta alle sole voci di quella forma.
 *
 * @param {Record<string, Record<string, unknown>>} ledgersBySection
 * @param {string} activeSection
 */
export function ledgerViewsForLookup(ledgersBySection, activeSection, { maxAgeDays = SOURCE_URL_TTL_DAYS, now = Date.now(), keyForm = null } = {}) {
  const src = ledgersBySection && typeof ledgersBySection === 'object' ? ledgersBySection : {};
  const out = {};
  for (const [section, map] of Object.entries(src)) {
    out[section] = section === activeSection
      ? ledgerArticleIds(map, { maxAgeDays, now, keyForm })
      : ledgerArticleIds(map, { keyForm });
  }
  return out;
}
