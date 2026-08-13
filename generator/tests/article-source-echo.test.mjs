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
 * ## La causa, e perche' non e' l'estrattore
 *
 * `extractArticleText()` prova sei rami: i primi quattro isolano una radice
 * editoriale, gli ULTIMI DUE no — il quinto legge i `<p>` di `document.body`,
 * il sesto toglie i tag da tutta la pagina senza nemmeno la potatura di
 * nav/footer/aside/form che i rami precedenti hanno gia' avuto. Su una pagina
 * senza JSON-LD e senza `<article>` riconoscibile si finisce li'.
 *
 * `create-article.mjs` isola quindi la radice PRIMA di chiamarlo, cosi' che
 * tutti e sei i rami — cap di fallback compresi — vedano solo il pezzo.
 * `extract-article-text.mjs` non e' toccato: e' `mode: identical` nel manifest
 * del ciclo, e una modifica la' si fa sul sito e scende col mirror.
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
  return new Function(`${block}\nreturn { isolateMainSourceHtml, extractOutermostTagBlock, visibleTextLength };`)();
}

const { isolateMainSourceHtml, extractOutermostTagBlock, visibleTextLength } = loadIsolationSandbox();

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

  it('recupera il JSON-LD anche quando sta in fondo a <body>, fuori dalla radice', () => {
    const page2 = `<html><head></head><body><main><article>${ARTICLE_PROSE}</article></main>` +
      '<script type="application/ld+json">{"articleBody":"corpo"}</script></body></html>';
    const res = isolateMainSourceHtml(page2);
    assert.equal(res.isolated, true);
    assert.ok(res.html.includes('"articleBody":"corpo"'));
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
});

// ── 2. WIRING ──────────────────────────────────────────────────────────────

describe('cablaggio in fetchPageContent', () => {
  it('la pagina viene isolata PRIMA di essere estratta', () => {
    // Una funzione corretta e non chiamata e' il modo in cui questo repo ha
    // gia' pubblicato un titolo tutto maiuscolo (vedi blog-title-casing).
    const at = SRC.indexOf('async function fetchPageContent(url) {');
    assert.notEqual(at, -1);
    const body = SRC.slice(at, at + 6000);
    const isolateAt = body.indexOf('const isolation = isolateMainSourceHtml(html);');
    const extractAt = body.indexOf('extractArticleText(isolation.html');
    assert.ok(isolateAt !== -1, 'fetchPageContent non isola la pagina');
    assert.ok(extractAt !== -1, 'l’estrattore riceve ancora l’HTML grezzo invece di quello isolato');
    assert.ok(isolateAt < extractAt, 'isolamento dopo l’estrazione: non serve a niente');
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
