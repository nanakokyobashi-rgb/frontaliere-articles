/**
 * Eco della pagina sorgente nei corpi degli articoli. `node --test`. Issue #202.
 *
 * ## Il difetto
 *
 * Tre articoli pubblicati portavano nel corpo pezzi interi della pagina
 * scrapata: titolo-civetta di un altro pezzo, firma di redazione della testata,
 * invito a registrarsi per commentare, regolamento dei commenti, spalla
 * «ultimi commenti». Su `ristorni-frontalieri-berna` erano 1.961 caratteri, il
 * 27% del corpo. Non e' un modello che divaga — e' SOURCE CONTENT consegnato
 * cosi', e la REGOLA #1 del prompt («ogni fatto DEVE essere presente nel SOURCE
 * CONTENT») lo rende fedele proprio a cio' che non doveva ricevere.
 *
 * ## La causa, e perche' isolamento ed estrazione devono concordare
 *
 * `extractArticleText()` prova sei rami: i primi quattro isolano una radice
 * editoriale, gli ULTIMI DUE no — il quinto legge i `<p>` di `document.body`,
 * il sesto toglie i tag da tutta la pagina senza nemmeno la potatura di
 * nav/footer/aside/form che i rami precedenti hanno gia' avuto. Su una pagina
 * senza JSON-LD e senza `<article>` riconoscibile si finisce li'.
 *
 * `create-article.mjs` isola quindi la radice PRIMA di chiamarlo, cosi' che
 * tutti e sei i rami — cap di fallback compresi — vedano solo il pezzo.
 * Anche i no-script fallback richiedono coerenza: l'estrattore e la prova del
 * titolo eliminavano entrambi il markup `<noscript>`. L'opzione condivisa
 * `scriptingDisabled` arriva dal sito tramite il trasporto dei gemelli
 * `identical`; questa PR la attiva nel generatore corpus e nel ledger dei
 * titoli. Il mirror dell'engine non trasporta `generator/scripts/lib/**`.
 *
 * ## I due strati di questo banco
 *
 *  1. UNIT sulla funzione di isolamento, con una pagina che ha la forma esatta
 *     che ha prodotto il difetto (commenti e firma FUORI dall'`<article>`).
 *  2. SCAN sul corpus pubblicato: nessun corpo puo' contenere un marcatore di
 *     mobilio della fonte. E' il gate sull'OUTPUT — vale qualunque percorso
 *     abbia scritto il file, compresi quelli che nessuno dei due lati conosce.
 *
 * I marcatori sono LETTI da generator/scripts/repair-source-echo.mjs, non
 * ricopiati: lo script di bonifica e il gate devono avere per forza la stessa
 * definizione di «eco della fonte», altrimenti la bonifica dichiara di aver
 * finito su un criterio e il gate ne difende un altro.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_ECHO_MARKERS, scanCorpusForSourceEcho } from '../scripts/repair-source-echo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CREATE_ARTICLE = path.join(ROOT, 'generator', 'scripts', 'create-article.mjs');
const SRC = fs.readFileSync(CREATE_ARTICLE, 'utf-8');

function loadIsolationSandbox() {
  const start = SRC.indexOf('const MIN_ISOLATED_TEXT_CHARS = 400;');
  const fnStart = SRC.indexOf('export function isolateMainSourceHtml(html) {');
  assert.notEqual(start, -1, 'MIN_ISOLATED_TEXT_CHARS non trovato — aggiornare i delimitatori');
  assert.notEqual(fnStart, -1, 'isolateMainSourceHtml non trovato — aggiornare i delimitatori');
  const endRel = SRC.slice(fnStart).search(/\n\}\n/);
  assert.notEqual(endRel, -1);
  const block = SRC.slice(start, fnStart + endRel + 2).replace(/^export /gm, '');
  return new Function(`${block}\nreturn { isolateMainSourceHtml, extractOutermostTagBlock, sourceActivateBodyNoscript, visibleTextLength };`)();
}

const { isolateMainSourceHtml, extractOutermostTagBlock, sourceActivateBodyNoscript, visibleTextLength } = loadIsolationSandbox();

const ARTICLE_PROSE = Array.from({ length: 8 }, (_, i) =>
  `<p>Paragrafo ${i} del pezzo vero, con abbastanza testo da superare la soglia minima di isolamento e sembrare un corpo d'articolo reale.</p>`).join('');

/** La forma della pagina che ha prodotto il difetto: il pezzo in <article>, tutto il resto fuori. */
function varesenewsLikePage() {
  return `<!doctype html><html><head>
    <title>Ristorni frontalieri</title>
    <meta property="og:title" content="Ristorni frontalieri" />
    <meta property="article:published_time" content="2026-06-12T10:00:00+02:00" />
    <script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-06-12T10:00:00+02:00"}</script>
  </head><body>
    <nav><a href="/">Home</a><a href="/cronaca">Cronaca</a></nav>
    <main>
      <article>${ARTICLE_PROSE}</article>
      <div class="pitch"><p>Noi della redazione di VareseNews crediamo che una buona informazione contribuisca a migliorare la vita di tutti. Ogni giorno lavoriamo cercando di stimolare curiosità e spirito critico.</p></div>
      <section id="comments">
        <p>Accedi o registrati per commentare questo articolo.</p>
        <p>Il contenuto di questo commento esprime il pensiero dell'autore e non rappresenta la linea editoriale di VareseNews.it, che rimane autonoma e indipendente.</p>
      </section>
      <div class="latest-comments"><p>principe.rosso su Anche a Varese gli albanesi scendono in piazza contro il resort del genero di Trump</p></div>
    </main>
    <footer><p>Redazione VareseNews redazione@varesenews.it</p></footer>
  </body></html>`;
}

// ── 1. UNIT ────────────────────────────────────────────────────────────────

describe('extractOutermostTagBlock — profondita’, non regex greedy', () => {
  it('prende il blocco di primo livello piu’ lungo, non dal primo open all’ultimo close', () => {
    const html = '<article>corto</article><div><article>molto piu lungo di quello prima</article></div>';
    const block = extractOutermostTagBlock(html, 'article');
    assert.equal(block, '<article>molto piu lungo di quello prima</article>');
  });

  it('non si ferma su una chiusura annidata', () => {
    const html = '<main><p>a</p><main>annidato</main><p>coda del contenitore esterno</p></main>';
    const block = extractOutermostTagBlock(html, 'main');
    assert.ok(block.startsWith('<main><p>a</p>'));
    assert.ok(block.endsWith('</main>'));
    assert.ok(block.includes('coda del contenitore esterno'), 'si e’ fermato sulla chiusura annidata');
  });

  it('sopravvive a un tag mai chiuso', () => {
    const block = extractOutermostTagBlock('<div>x</div><main><p>senza chiusura</p>', 'main');
    assert.ok(block.includes('senza chiusura'));
  });

  it('torna stringa vuota quando il tag non c’e’', () => {
    assert.equal(extractOutermostTagBlock('<div>niente</div>', 'article'), '');
    assert.equal(extractOutermostTagBlock('', 'main'), '');
  });

  it('non confonde <articolo> o <mainframe> con <article> / <main>', () => {
    assert.equal(extractOutermostTagBlock('<articolo>x</articolo>', 'article'), '');
    assert.equal(extractOutermostTagBlock('<mainframe>x</mainframe>', 'main'), '');
  });
});

describe('isolateMainSourceHtml — la pagina si riduce al pezzo', () => {
  const page = varesenewsLikePage();
  const out = isolateMainSourceHtml(page);

  it('isola <article> e non <main>: i commenti stanno dentro <main>, fuori da <article>', () => {
    assert.equal(out.isolated, true);
    assert.equal(out.root, 'article');
  });

  it('nessun marcatore di mobilio sopravvive all’isolamento', () => {
    // E' la proprieta' che conta: NON un elenco di stringhe da cancellare, ma
    // la conseguenza di aver tolto la pagina intera. Se domani la testata
    // cambia le frasi, questo resta vero.
    for (const marker of SOURCE_ECHO_MARKERS) {
      assert.equal(out.html.includes(marker), false, `sopravvissuto all’isolamento: «${marker}»`);
    }
    assert.equal(out.html.includes('principe.rosso su'), false, 'la spalla «ultimi commenti» e’ ancora dentro');
    assert.equal(out.html.includes('Cronaca'), false, 'la navigazione e’ ancora dentro');
  });

  it('il pezzo vero resta tutto', () => {
    assert.ok(out.html.includes('Paragrafo 0 del pezzo vero'));
    assert.ok(out.html.includes('Paragrafo 7 del pezzo vero'));
  });

  it('conserva <head> e il JSON-LD: sono il ramo migliore dell’estrattore e la data della fonte', () => {
    // Isolare buttando il JSON-LD scambierebbe un difetto con due: si perde
    // `articleBody` (l'estrazione piu' affidabile) e `datePublished`, che e'
    // cio' che impedisce di ripubblicare come fresca una notizia di gennaio.
    assert.ok(out.html.includes('application/ld+json'));
    assert.ok(out.html.includes('article:published_time'));
    assert.ok(out.html.includes('og:title'));
  });

  it('conserva il JSON-LD nel head implicito prima del body omesso', () => {
    const page2 = '<html><meta property="article:published_time" content="2026-06-12">'
      + '<script type="application/ld+json">'
      + '{"articleBody":"IMPLICIT_HEAD_ARTICLE_BODY","datePublished":"2026-06-12"}'
      + '</script>'
      + `<article>${ARTICLE_PROSE}</article></html>`;
    const res = isolateMainSourceHtml(page2);
    assert.equal(res.isolated, true);
    assert.ok(res.html.includes('IMPLICIT_HEAD_ARTICLE_BODY'));
    assert.ok(res.html.includes('"datePublished":"2026-06-12"'));
  });

  it('non tronca l’head su un </head> letterale dentro JSON-LD o script', () => {
    const pageWithLiteralBoundary = '<html><head>'
      + '<script type="application/ld+json">{"description":"testo </head> incorporato"}</script>'
      + '<meta property="article:published_time" content="2026-06-12T10:00:00+02:00">'
      + '</head><body><article>' + ARTICLE_PROSE + '</article></body></html>';
    const res = isolateMainSourceHtml(pageWithLiteralBoundary);
    assert.equal(res.isolated, true);
    assert.ok(res.html.includes('article:published_time'), 'il meta dopo il literal </head> e’ stato perso');
    assert.ok(res.html.includes('testo </head> incorporato'), 'il JSON-LD e’ stato troncato');
  });

  it('recupera il JSON-LD anche quando sta in fondo a <body>, fuori dalla radice', () => {
    const page2 = `<html><head></head><body><main><article>${ARTICLE_PROSE}</article></main>` +
      '<script type="application/ld+json">{"articleBody":"corpo"}</script></body></html>';
    const res = isolateMainSourceHtml(page2);
    assert.equal(res.isolated, true);
    assert.ok(res.html.includes('"articleBody":"corpo"'));
  });

  it('riattiva JSON-LD attivo solo come figlio diretto del body', () => {
    const stale = (label, attrs = '') => `<script${attrs ? ` ${attrs}` : ''} type="application/ld+json">{"headline":"${label}"}</script>`;
    const page2 = '<html><head><title>Pagina</title></head><body>'
      + `<!-- ${stale('COMMENT_JSON_LD_SHOULD_NOT_BE_ACTIVATED')} -->`
      + `<template>${stale('TEMPLATE_JSON_LD_SHOULD_NOT_BE_ACTIVATED')}</template>`
      + `<aside>${stale('SIDEBAR_JSON_LD_SHOULD_NOT_BE_ACTIVATED')}</aside>`
      + `<div class="app-shell">${stale('WRAPPED_BODY_JSON_LD_SHOULD_NOT_BE_ACTIVATED')}</div>`
      + stale('SCRIPT_CLASS_JSON_LD_SHOULD_NOT_BE_ACTIVATED', 'class="related"')
      + stale('SCRIPT_ID_JSON_LD_SHOULD_NOT_BE_ACTIVATED', 'id="sidebar-json"')
      + stale('SCRIPT_ROLE_JSON_LD_SHOULD_NOT_BE_ACTIVATED', 'role="complementary"')
      + stale('ACTIVE_BODY_DIRECT_JSON_LD')
      + `<div role="complementary">${stale('COMPLEMENTARY_JSON_LD_SHOULD_NOT_BE_ACTIVATED')}</div>`
      + `<div role="banner">${stale('BANNER_JSON_LD_SHOULD_NOT_BE_ACTIVATED')}</div>`
      + `<div role="contentinfo">${stale('CONTENTINFO_JSON_LD_SHOULD_NOT_BE_ACTIVATED')}</div>`
      + `<article>${ARTICLE_PROSE}</article></body></html>`;
    const res = isolateMainSourceHtml(page2);
    assert.equal(res.isolated, true);
    assert.ok(res.html.includes('ACTIVE_BODY_DIRECT_JSON_LD'));
    assert.equal(res.html.includes('COMMENT_JSON_LD_SHOULD_NOT_BE_ACTIVATED'), false);
    assert.equal(res.html.includes('TEMPLATE_JSON_LD_SHOULD_NOT_BE_ACTIVATED'), false);
    assert.equal(res.html.includes('SIDEBAR_JSON_LD_SHOULD_NOT_BE_ACTIVATED'), false);
    assert.equal(res.html.includes('WRAPPED_BODY_JSON_LD_SHOULD_NOT_BE_ACTIVATED'), false);
    assert.equal(res.html.includes('SCRIPT_CLASS_JSON_LD_SHOULD_NOT_BE_ACTIVATED'), false);
    assert.equal(res.html.includes('SCRIPT_ID_JSON_LD_SHOULD_NOT_BE_ACTIVATED'), false);
    assert.equal(res.html.includes('SCRIPT_ROLE_JSON_LD_SHOULD_NOT_BE_ACTIVATED'), false);
    assert.equal(res.html.includes('COMPLEMENTARY_JSON_LD_SHOULD_NOT_BE_ACTIVATED'), false);
    assert.equal(res.html.includes('BANNER_JSON_LD_SHOULD_NOT_BE_ACTIVATED'), false);
    assert.equal(res.html.includes('CONTENTINFO_JSON_LD_SHOULD_NOT_BE_ACTIVATED'), false);
  });

  it('non sceglie article/main dentro SVG rientrati da foreignObject o annotation-xml', () => {
    const foreignArticle = '<article><p>FOREIGN_SVG_ARTICLE_SHOULD_NOT_BE_SELECTED. '
      + 'Contenuto grafico inerte senza radice editoriale. '.repeat(20)
      + '</p></article>';
    const foreignMain = '<main><p>FOREIGN_ANNOTATION_SVG_MAIN_SHOULD_NOT_BE_SELECTED. '
      + 'Contenuto grafico inerte senza radice editoriale. '.repeat(20)
      + '</p></main>';
    const page2 = '<html><body>'
      + `<svg><foreignObject>${foreignArticle}</foreignObject></svg>`
      + `<math><annotation-xml encoding="text/html">${foreignMain}</annotation-xml></math>`
      + `<article>${ARTICLE_PROSE}</article>`
      + '</body></html>';
    const res = isolateMainSourceHtml(page2);
    assert.equal(res.isolated, true);
    assert.equal(res.root, 'article');
    assert.equal(res.html.includes('FOREIGN_SVG_ARTICLE_SHOULD_NOT_BE_SELECTED'), false);
    assert.equal(res.html.includes('FOREIGN_ANNOTATION_SVG_MAIN_SHOULD_NOT_BE_SELECTED'), false);
    assert.ok(res.html.includes('Paragrafo 7 del pezzo vero'));
  });

  it('non perde il confine document-level dopo self-closing SVG/MathML foreign', () => {
    const page2 = '<html><head><meta property="article:published_time" content="2026-06-12T10:00:00+02:00"></head><body>'
      + '<svg viewBox="0 0 10 10"><path d="M0 0"/><use href="#path"/></svg>'
      + '<math><mrow/><mi>x</mi></math>'
      + '<script type="application/ld+json">{"headline":"FOREIGN_ELEMENTS_KEEP_BODY_TRUSTED"}</script>'
      + `<article>${ARTICLE_PROSE}</article></body></html>`;
    const res = isolateMainSourceHtml(page2);
    assert.equal(res.isolated, true);
    assert.ok(res.html.includes('article:published_time'));
    assert.ok(res.html.includes('FOREIGN_ELEMENTS_KEEP_BODY_TRUSTED'));
  });

  it('ignora un template self-closing foreign dentro un template HTML', () => {
    const page2 = '<html><body><template><svg><template/><path d="M0 0"/></svg></template>'
      + `<article>${ARTICLE_PROSE}</article></body></html>`;
    const res = isolateMainSourceHtml(page2);
    assert.equal(res.isolated, true);
    assert.equal(res.root, 'article');
    assert.ok(res.html.includes('Paragrafo 7 del pezzo vero'));
    assert.equal(res.html.includes('<template>'), false);
  });

  it('ignora le chiusure apparenti dentro script SVG quando salta un template HTML', () => {
    const decoy = '<article><p>SVG_SCRIPT_TEMPLATE_DECOY. '
      + 'Questo markup appartiene al testo dello script, non a un articolo attivo. '.repeat(20)
      + '</p></article>';
    const embeddedMarkup = `</svg></template>${decoy}`;
    const page2 = '<html><body><template><svg><script>'
      + `const source = ${JSON.stringify(embeddedMarkup)};`
      + '</script></svg></template>'
      + `<article>${ARTICLE_PROSE}</article></body></html>`;
    const res = isolateMainSourceHtml(page2);
    assert.equal(res.isolated, true);
    assert.equal(res.root, 'article');
    assert.equal(res.html.includes('SVG_SCRIPT_TEMPLATE_DECOY'), false);
    assert.ok(res.html.includes('Paragrafo 7 del pezzo vero'));
  });

  it('segue le chiusure implicite HTML per head, p e li', () => {
    const page2 = '<html><head><title>Head senza end-tag</title>'
      + '<meta property="article:published_time" content="2026-06-12T10:00:00+02:00">'
      + '<body><ul><li>uno<li>due</ul><p>intro<div>chiude il paragrafo</div>'
      + '<script type="application/ld+json">{"headline":"IMPLICIT_HTML_STAYS_TRUSTED"}</script>'
      + `<article>${ARTICLE_PROSE}</article></body></html>`;
    const res = isolateMainSourceHtml(page2);
    assert.equal(res.isolated, true);
    assert.ok(res.html.includes('Head senza end-tag'));
    assert.ok(res.html.includes('article:published_time'));
    assert.ok(res.html.includes('IMPLICIT_HTML_STAYS_TRUSTED'));
  });

  it('non sceglie una radice article inattiva in commenti, template o sidebar', () => {
    const stale = `<article>${ARTICLE_PROSE}<p>INACTIVE_ARTICLE_SHOULD_NOT_BE_SELECTED</p>${ARTICLE_PROSE}</article>`;
    const page2 = '<html><body>'
      + `<!-- ${stale} -->`
      + `<template>${stale}</template>`
      + `<div class="sidebar-wrapper">${stale}</div>`
      + `<article>${ARTICLE_PROSE}</article>`
      + '</body></html>';
    const res = isolateMainSourceHtml(page2);
    assert.equal(res.isolated, true);
    assert.equal(res.root, 'article');
    assert.equal(res.html.includes('INACTIVE_ARTICLE_SHOULD_NOT_BE_SELECTED'), false);
    assert.ok(res.html.includes('Paragrafo 7 del pezzo vero'));
  });

  it('non tratta un <head> annidato nel body come head del documento', () => {
    const nestedHead = '<html><body><aside><head>'
      + '<script type="application/ld+json">{"headline":"NESTED_HEAD_SHOULD_NOT_BE_ACTIVATED"}</script>'
      + '</head></aside>'
      + `<article>${ARTICLE_PROSE}</article></body></html>`;
    const res = isolateMainSourceHtml(nestedHead);
    assert.equal(res.isolated, true);
    assert.equal(res.html.includes('NESTED_HEAD_SHOULD_NOT_BE_ACTIVATED'), false);
  });

  it('non promuove radici editoriali da un documento con head annidato non attendibile', () => {
    const nestedHead = '<html><head><head></head>'
      + `<article>${ARTICLE_PROSE}</article></html>`;
    const res = isolateMainSourceHtml(nestedHead);
    assert.equal(res.isolated, false);
    assert.equal(res.root, 'none');
    assert.equal(res.trustedDocument, false);
    assert.equal(res.html, nestedHead);
  });

  it('non lascia uscire un article da un noscript dentro un template', () => {
    const templateAttack = '<html><body><template><noscript>literal </template>'
      + `<article>${ARTICLE_PROSE.replace(/Paragrafo/g, 'TEMPLATE_ATTACK')}</article>`
      + '</noscript></template>'
      + `<article>${ARTICLE_PROSE}</article></body></html>`;
    const res = isolateMainSourceHtml(templateAttack);
    assert.equal(res.isolated, true);
    assert.equal(res.root, 'article');
    assert.equal(res.html.includes('TEMPLATE_ATTACK'), false);
    assert.ok(res.html.includes('Paragrafo 7 del pezzo vero'));
  });

  it('mantiene un JSON-LD body-only quando il body e’ document-level', () => {
    const bodyOnly = '<html><body>'
      + '<script type="application/ld+json">{"headline":"BODY_ONLY_ACTIVE"}</script>'
      + `<article>${ARTICLE_PROSE}</article></body></html>`;
    const res = isolateMainSourceHtml(bodyOnly);
    assert.equal(res.isolated, true);
    assert.ok(res.html.includes('BODY_ONLY_ACTIVE'));
  });

  it('mantiene il JSON-LD nel body implicito dopo la chiusura dell’head', () => {
    const bodyOnly = '<html><head><title>Fonte valida</title></head>'
      + '<script type="application/ld+json">{"headline":"IMPLICIT_BODY_ONLY_ACTIVE"}</script>'
      + `<article>${ARTICLE_PROSE}</article></html>`;
    const res = isolateMainSourceHtml(bodyOnly);
    assert.equal(res.isolated, true);
    assert.ok(res.html.includes('IMPLICIT_BODY_ONLY_ACTIVE'));
  });

  it('isola l’article-markup attivo dentro noscript con scripting disabilitato', () => {
    const page2 = '<html><body><noscript>'
      + `<article>${ARTICLE_PROSE}</article>`
      + '</noscript><aside>CHROME OUTSIDE THE ARTICLE</aside></body></html>';
    const res = isolateMainSourceHtml(page2);
    assert.equal(res.isolated, true);
    assert.equal(res.root, 'article');
    assert.ok(res.html.includes('Paragrafo 7 del pezzo vero'));
    assert.equal(res.html.includes('CHROME OUTSIDE THE ARTICLE'), false);
  });

  it('rende attivo il fallback noscript del main per estrattore e title evidence', () => {
    const page2 = '<html><head><noscript><h1>HEAD_INACTIVE</h1></noscript></head><body>'
      + '<main><noscript><h1>ACTIVE_HEADLINE</h1>'
      + `<p>${ARTICLE_PROSE.replace(/<p>|<\/p>/g, ' ')}</p></noscript>`
      + '<template><noscript><h1>TEMPLATE_INACTIVE</h1></noscript></template></main>'
      + '</body></html>';
    const res = isolateMainSourceHtml(page2);
    assert.equal(res.isolated, true);
    assert.equal(res.root, 'main');
    assert.ok(res.html.includes('ACTIVE_HEADLINE'));
    assert.equal(res.html.includes('<main><noscript>'), false);
    assert.ok(res.html.includes('<head><noscript>'));
    assert.ok(res.html.includes('<template><noscript>'));

    const activated = sourceActivateBodyNoscript(
      '<html><head><noscript><h1>HEAD_INACTIVE</h1></noscript></head>'
      + '<body><main><noscript><h1>ACTIVE_HEADLINE</h1></noscript>'
      + '<template><noscript><h1>TEMPLATE_INACTIVE</h1></noscript></template></main></body></html>',
    );
    assert.ok(activated.includes('<h1>ACTIVE_HEADLINE</h1>'));
    assert.ok(activated.includes('<head><noscript>'));
    assert.ok(activated.includes('<template><noscript>'));
    assert.equal(activated.includes('<main><noscript>'), false);
  });

  it('mantiene inattivo il noscript nell’head implicito e chiude l’head esplicito sul testo', () => {
    const headFallback = '<html><noscript>'
      + `<article><p>${'CONTENUTO_HEAD_STALE '.repeat(20)}</p></article>`
      + '</noscript><body>'
      + `<article>${ARTICLE_PROSE}</article></body></html>`;
    const implicit = isolateMainSourceHtml(headFallback);
    assert.equal(implicit.isolated, true);
    assert.equal(implicit.root, 'article');
    assert.equal(implicit.html.includes('CONTENUTO_HEAD_STALE'), false);
    assert.ok(implicit.html.includes('Paragrafo 7 del pezzo vero'));

    const textClosesHead = '<html><head><title>Fonte</title>testo che chiude l’head'
      + '<noscript><article>'
      + `${ARTICLE_PROSE.replace(/Paragrafo/g, 'NOSCRIPT_BODY_ACTIVE')}`
      + '</article></noscript></html>';
    const bodyFallback = isolateMainSourceHtml(textClosesHead);
    assert.equal(bodyFallback.isolated, true);
    assert.equal(bodyFallback.root, 'article');
    assert.ok(bodyFallback.html.includes('NOSCRIPT_BODY_ACTIVE 7'));
  });

  it('tratta script SVG foreign dentro template come raw-text opaco', () => {
    const page2 = '<html><body><template><svg><script><svg>literal'
      + '</script></svg></template>'
      + `<article>${ARTICLE_PROSE}</article></body></html>`;
    const res = isolateMainSourceHtml(page2);
    assert.equal(res.isolated, true);
    assert.equal(res.root, 'article');
    assert.ok(res.html.includes('Paragrafo 7 del pezzo vero'));
  });

  it('ripiega su <main> quando <article> non c’e’ o e’ troppo corto', () => {
    const teaserOnly = `<html><body><article>Leggi anche</article><main>${ARTICLE_PROSE}</main></body></html>`;
    const res = isolateMainSourceHtml(teaserOnly);
    assert.equal(res.root, 'main');
    assert.ok(res.html.includes('Paragrafo 3 del pezzo vero'));
  });

  it('NON isola quando non riconosce una radice: nessuna regressione sotto il comportamento precedente', () => {
    // Se isolasse a vuoto consegnerebbe un frammento vuoto al posto di una
    // pagina rumorosa, che e' peggio: zero contenuto invece di contenuto sporco.
    const noRoot = `<html><body><div>${ARTICLE_PROSE}</div></body></html>`;
    const res = isolateMainSourceHtml(noRoot);
    assert.equal(res.isolated, false);
    assert.equal(res.root, 'none');
    assert.equal(res.html, noRoot);
  });

  it('regge input degeneri', () => {
    for (const input of ['', null, undefined]) {
      const res = isolateMainSourceHtml(input);
      assert.equal(res.isolated, false);
    }
    assert.ok(visibleTextLength('<p>ciao</p>') > 0);
  });

  it('fallisce chiuso su un head malformato senza riesaminare ogni tag fino a fondo pagina', () => {
    // Ogni `<x ` ha un attributo apparente e condivide una virgoletta non
    // chiusa in fondo: il vecchio scanner rifaceva la ricerca di `>` per ogni
    // apertura, bloccando l’event loop su una risposta ancora piccola.
    const malformedHead = '<html><head><meta data='
      + '<x '.repeat(16000)
      + '"</head><body><article>' + ARTICLE_PROSE + '</article></body></html>';
    const started = performance.now();
    const res = isolateMainSourceHtml(malformedHead);
    const elapsed = performance.now() - started;
    assert.equal(res.isolated, false);
    assert.equal(res.root, 'none');
    assert.equal(res.html, malformedHead);
    assert.ok(elapsed < 250, `scanner sorgente troppo lento su markup malformato: ${elapsed.toFixed(1)}ms`);
  });

  it('non isola né promuove JSON-LD con una scansione dell’head malformata', () => {
    const staleJsonLd = '<script type="application/ld+json">'
      + '{"headline":"STALE_JSON_LD_SHOULD_NOT_BE_ACTIVATED"}</script>';
    const malformedHead = '<html><head><meta data="unterminated'
      + '</head><body><article>' + ARTICLE_PROSE + '</article>'
      + staleJsonLd + '</body></html>';
    const res = isolateMainSourceHtml(malformedHead);
    assert.equal(res.isolated, false);
    assert.equal(res.root, 'none');
    assert.equal(res.html, malformedHead);
  });
});

// ── 2. WIRING ──────────────────────────────────────────────────────────────

describe('cablaggio in fetchPageContent', () => {
  it('la pagina viene isolata PRIMA di essere estratta', () => {
    // Una funzione corretta e non chiamata e' il modo in cui questo repo ha
    // gia' pubblicato un titolo tutto maiuscolo (vedi blog-title-casing).
    const at = SRC.indexOf('async function fetchPageContent(url) {');
    assert.notEqual(at, -1);
    const end = SRC.indexOf('\n// ── Date filtering:', at);
    assert.ok(end > at, 'delimitatore di fetchPageContent non trovato');
    // Delimita la funzione alla sezione successiva invece di usare un numero
    // fisso di caratteri: commenti e guardie aggiunti prima della chiamata
    // non devono far sparire il wiring dal controllo statico.
    const body = SRC.slice(at, end);
    const isolateAt = body.indexOf('const isolation = isolateMainSourceHtml(html);');
    const trustGuardAt = body.indexOf('if (!isolation.trustedDocument)');
    const extractAt = body.indexOf('extractArticleText(isolation.html');
    const titleAt = body.indexOf('pageTitleEvidence(isolation.html, { scriptingDisabled: true })');
    assert.ok(isolateAt !== -1, 'fetchPageContent non isola la pagina');
    assert.ok(trustGuardAt > isolateAt, 'fetchPageContent deve rifiutare una struttura HTML non attendibile');
    assert.ok(trustGuardAt < extractAt, 'l’estrattore non deve ricevere HTML da un documento non attendibile');
    assert.ok(extractAt !== -1, 'l’estrattore riceve ancora l’HTML grezzo invece di quello isolato');
    assert.ok(titleAt !== -1, 'la title evidence non abilita il fallback noscript della stessa fetch');
    assert.ok(isolateAt < extractAt, 'isolamento dopo l’estrazione: non serve a niente');
    assert.ok(isolateAt < titleAt, 'isolamento dopo la title evidence: non serve a niente');
    assert.match(body, /extractArticleText\(isolation\.html,\s*\{[^}]*scriptingDisabled:\s*true/);
    assert.match(body, /pageTitleEvidence\(isolation\.html,\s*\{\s*scriptingDisabled:\s*true\s*\}\)/);
  });

  it('l’estrattore condiviso non viene modificato da questo lato', () => {
    // `generator/scripts/lib/extract-article-text.mjs` e' `mode: identical` nel
    // manifest del ciclo: toccarlo qui creerebbe un `corpus-ahead` su un file
    // dichiarato uguale al sito. Il gate non puo' provarlo sull'hash, ma puo'
    // provare che la fix sta dalla parte giusta del confine.
    const lib = fs.readFileSync(path.join(ROOT, 'generator', 'scripts', 'lib', 'extract-article-text.mjs'), 'utf-8');
    assert.equal(lib.includes('isolateMainSourceHtml'), false, 'l’isolamento e’ finito nel file identical');
    for (const marker of SOURCE_ECHO_MARKERS) {
      assert.equal(lib.includes(marker), false, `denylist di stringhe finita nell’estrattore condiviso: «${marker}»`);
    }
  });
});

// ── 3. SCAN sul corpus pubblicato ──────────────────────────────────────────

describe('corpus pubblicato — nessun mobilio della fonte nei corpi', () => {
  it('l’elenco dei marcatori non e’ vuoto (un elenco vuoto non prova nulla)', () => {
    assert.ok(SOURCE_ECHO_MARKERS.length >= 10, `solo ${SOURCE_ECHO_MARKERS.length} marcatori dichiarati`);
  });

  it('i corpi sono davvero sul disco (un worktree sparse non materializza content/)', () => {
    const dir = path.join(ROOT, 'content', 'blog-body', 'it');
    assert.ok(fs.existsSync(dir), 'content/blog-body/it assente: il gate passerebbe a vuoto');
    assert.ok(fs.readdirSync(dir).length > 3000, 'troppo pochi corpi IT letti');
  });

  it('zero file portano un marcatore di eco della fonte', () => {
    const offenders = scanCorpusForSourceEcho(ROOT);
    assert.deepEqual(
      offenders.map((o) => `${o.file} → ${o.markers.join(', ')}`),
      [],
      'un corpo pubblicato contiene mobilio della pagina sorgente: bonifica con ' +
        '`node generator/scripts/repair-source-echo.mjs --apply` e verifica che la causa a monte regga',
    );
  });
});
