/**
 * find-dirty-content-ids.test.mjs — la logica pura del rilevatore di articoli
 * il cui corpus porta ancora un control character C0 (issue #67, dopo #65).
 *
 * PROPRIETA' DIFESE:
 *   - il nome della directory del corpo (`blog-body` / `blog-body-ch`) decide
 *     la sezione (frontaliere/svizzera): sbagliarlo dispatcherebbe il backfill
 *     sulla sezione sbagliata;
 *   - un chunk meta associa l'id alla RIGA (chiave `blog.article.<id>.<campo>`),
 *     non al file: un file con piu' articoli non deve marcarli tutti sporchi
 *     per colpa di uno solo;
 *   - un chunk SEO associa l'id al BLOCCO che lo precede (`'blog-<id>': {`):
 *     una riga sporca prima di qualunque chiave di record non ha un id certo
 *     e va ignorata piuttosto che attribuita al blocco sbagliato;
 *   - l'ordinamento e il cap sono deterministici (sezione, poi id): niente
 *     priorita' di data, e' un backlog storico non un evento fresco.
 *
 * PROPRIETA' DEL FILTRO LIVE (issue #73 — la parte che fa CONVERGERE):
 *   - un id sporco nel corpus ma con le pagine live gia' pulite e' ESCLUSO:
 *     senza questo la selezione non cambia mai dopo una ripubblicazione
 *     riuscita (ripubblicare non riscrive `content/`), i primi N alfabetici si
 *     rifanno per sempre e la coda non viene servita mai;
 *   - un id sporco in entrambi resta INCLUSO;
 *   - la sola forma escapata sulla pagina (backslash-u-0-0-1-7, oppure
 *     backslash-b, dentro il ld+json)
 *     conta come sporca: e' invisibile a un byte-scan, ed e' il dato
 *     STRUTTURATO che il crawler parsa;
 *   - un fetch che fallisce NON e' «pulita»: l'id resta candidato. Un falso
 *     positivo costa una ripubblicazione idempotente, un falso negativo lascia
 *     una pagina sporca per sempre;
 *   - le URL escono da `slugs.json`, non dall'id: l'id e' italiano e lo slug e'
 *     localizzato, quindi costruirle dall'id darebbe 404 su en/de/fr — cioe'
 *     «pagina assente», cioe' un id scartato per il motivo sbagliato.
 *
 * La rete non e' mai toccata: `fetchImpl` e' un parametro.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  sectionForBodyDir,
  extractMetaArticleId,
  extractSeoBlockKey,
  dirtyIdsInMetaText,
  dirtyIdsInSeoText,
  scanContentForDirtyIds,
  orderAndCap,
  pageCarriesControlChars,
  liveUrlsForCandidate,
  classifyProbe,
  verdictForCandidate,
  mapWithConcurrency,
  filterCandidatesByLivePage,
  residuesInText,
  isPlaceholderFaqQuestion,
  faqQuestionNamesInHtml,
  faqQuestionsInBodyText,
  pageCarriesFaqPlaceholder,
} from '../../scripts/find-dirty-content-ids.mjs';

test('sectionForBodyDir mappa le due directory dei corpi, null altrove', () => {
  assert.equal(sectionForBodyDir('blog-body'), 'frontaliere');
  assert.equal(sectionForBodyDir('blog-body-ch'), 'svizzera');
  assert.equal(sectionForBodyDir('blog-meta'), null);
});

test('extractMetaArticleId legge l\'id dalla chiave, ignora righe senza quella forma', () => {
  assert.equal(
    extractMetaArticleId("    'blog.article.trump-intesa-o-inferno.title': 'Trump: ...',"),
    'trump-intesa-o-inferno',
  );
  assert.equal(extractMetaArticleId("    canonicalPath: '/articoli-frontaliere/foo/',"), null);
  assert.equal(extractMetaArticleId(''), null);
});

test('extractSeoBlockKey riconosce blog- e swiss-, non altre chiavi', () => {
  assert.deepEqual(extractSeoBlockKey("  'blog-lavena-ponte-tresa-territorio-poroso': {"), {
    section: 'frontaliere',
    id: 'lavena-ponte-tresa-territorio-poroso',
  });
  assert.deepEqual(extractSeoBlockKey("  'swiss-credito-imposta-frontalieri-2026': {"), {
    section: 'svizzera',
    id: 'credito-imposta-frontalieri-2026',
  });
  assert.equal(extractSeoBlockKey("  title: 'qualcosa',"), null);
});

test('dirtyIdsInMetaText marca solo le righe con un C0 illegale, dedup per id', () => {
  const text = [
    "export default {",
    "  'blog.article.pulito.title': 'Titolo pulito',",
    "  'blog.article.trump-intesa-o-inferno.title': 'Trump: \"Intesa o sar\x170 l\\'inferno\"',",
    "  'blog.article.trump-intesa-o-inferno.excerpt': 'spostato a marted\x088',",
    "};",
  ].join('\n');
  const ids = dirtyIdsInMetaText(text);
  assert.deepEqual([...ids].sort(), ['trump-intesa-o-inferno']);
});

test('dirtyIdsInSeoText attribuisce la riga sporca al blocco che la precede', () => {
  const text = [
    "export default {",
    " 'blog-pulito': {",
    "  title: 'Titolo pulito',",
    " },",
    " 'blog-lavena-ponte-tresa-territorio-poroso': {",
    "  title: 'Il \x083territorio poroso\x083 tra Varese e la Svizzera',",
    " },",
    " 'swiss-credito-imposta-frontalieri-2026': {",
    "  description: 'testo pulito',",
    " },",
    "};",
  ].join('\n');
  const found = dirtyIdsInSeoText(text);
  assert.deepEqual(found, [{ section: 'frontaliere', id: 'lavena-ponte-tresa-territorio-poroso' }]);
});

test('dirtyIdsInSeoText ignora una riga sporca prima di qualunque chiave di record', () => {
  const text = ["export default {", "  title: 'sporco \x08qui',", " 'blog-x': {", "  title: 'pulito',", " },", "};"].join('\n');
  assert.deepEqual(dirtyIdsInSeoText(text), []);
});

test('orderAndCap e\' deterministico (sezione poi id) e rispetta il cap', () => {
  const ids = [
    { section: 'frontaliere', id: 'zebra' },
    { section: 'svizzera', id: 'alfa' },
    { section: 'frontaliere', id: 'alfa' },
  ];
  const { selected, leftover } = orderAndCap(ids, 2);
  assert.deepEqual(selected, [
    { section: 'frontaliere', id: 'alfa' },
    { section: 'frontaliere', id: 'zebra' },
  ]);
  assert.deepEqual(leftover, [{ section: 'svizzera', id: 'alfa' }]);
});

test('orderAndCap con cap non numerico usa il default (10), non lo tronca a zero', () => {
  const ids = Array.from({ length: 3 }, (_, i) => ({ section: 'frontaliere', id: `id-${i}` }));
  const { selected, leftover } = orderAndCap(ids, 'not-a-number');
  assert.equal(selected.length, 3);
  assert.equal(leftover.length, 0);
});

// ── scanContentForDirtyIds: fixture su disco (unico punto che tocca fs) ────

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

test('scanContentForDirtyIds copre le tre superfici e deduplica per (sezione, id)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dirty-content-ids-'));
  try {
    writeTree(root, {
      'content/blog-body/de/hirte-werden-tessin.ts': "export const body = 'Ein Hirte \x00werden';\n",
      'content/blog-body/fr/pulito.ts': "export const body = 'tout va bien';\n",
      'content/blog-body-ch/de/credito-imposta-frontalieri-2026.ts':
        "export const body = 'Text mit C0 \x06 hier';\n",
      'content/blog-meta-it.ts':
        "export default {\n  'blog.article.trump-intesa-o-inferno.title': 'sar\x170',\n};\n",
      'content/blog-meta-en.ts': "export default {\n  'blog.article.pulito.title': 'clean',\n};\n",
      'content/seo/seo-blog-3.ts':
        "export default {\n 'blog-lavena-ponte-tresa-territorio-poroso': {\n  title: 'Il \x083territorio\x083',\n },\n};\n",
    });

    const { ids, totalFiles, totalOccurrences } = scanContentForDirtyIds(root);
    const keys = ids.map((e) => `${e.section}:${e.id}`).sort();
    assert.deepEqual(keys, [
      'frontaliere:hirte-werden-tessin',
      'frontaliere:lavena-ponte-tresa-territorio-poroso',
      'frontaliere:trump-intesa-o-inferno',
      'svizzera:credito-imposta-frontalieri-2026',
    ]);
    assert.equal(totalFiles, 4); // il body pulito e il meta pulito non contano
    assert.ok(totalOccurrences >= 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scanContentForDirtyIds su un content/ senza corpi sporchi ritorna vuoto, non lancia', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dirty-content-ids-empty-'));
  try {
    writeTree(root, { 'content/blog-body/it/pulito.ts': "export const body = 'ok';\n" });
    const { ids, totalFiles, totalOccurrences } = scanContentForDirtyIds(root);
    assert.deepEqual(ids, []);
    assert.equal(totalFiles, 0);
    assert.equal(totalOccurrences, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── Il residuo PROPAGATO (issue #220 / #222) ────────────────────────────────
//
// Caso reale che ha guidato questo predicato: `lavena-ponte-tresa-territorio-
// poroso` porta `<08>3territorio` ancora col byte C0 nel body IT e in
// seo-blog-3.ts, ma la STESSA coppia senza un solo C0 in blog-meta-it.ts — un
// file che non ha ALTRO C0 al suo interno, quindi il passo 1 lo salta per
// intero. Questi fixture riproducono la stessa forma in miniatura: il residuo
// e' CONFERMATO da un byte C0 vero in un file, e va cercato (non indovinato)
// nelle altre superfici dello STESSO articolo.

test('scanContentForDirtyIds: un residuo confermato da C0 in un file si propaga alle altre superfici dello stesso id, anche senza C0 li\'', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dirty-content-ids-propag-'));
  try {
    writeTree(root, {
      // Ancora: il body porta ancora il marker C0, residuesInText lo trova.
      'content/blog-body/it/lavena-ponte-tresa-territorio-poroso.ts':
        "export default {\n 'blog.article.lavena-ponte-tresa-territorio-poroso.body1': 'descrive il \x083territorio poroso\x083 come';\n};\n",
      // ZERO C0 in questo file: il passo 1 (findControlChars) non lo tocca.
      // Il residuo 'poroso3' pero' c'e', dentro il campo title di QUESTO id —
      // e nello STESSO file, per un ALTRO id, una cifra in mezzo a lettere
      // che NON e' mai stata confermata da un C0 vero da nessuna parte: il
      // controllo negativo che la propagazione non deve prendere per
      // coincidenza testuale.
      'content/blog-meta-it.ts':
        "export default {\n" +
          "  'blog.article.lavena-ponte-tresa-territorio-poroso.title': 'Il 3territorio poroso3 tra Varese',\n" +
          "  'blog.article.altro-articolo.title': 'Il modello M5S vince a poroso3ville',\n" +
          '};\n',
    });

    const { ids } = scanContentForDirtyIds(root);
    const lavena = ids.find((e) => e.id === 'lavena-ponte-tresa-territorio-poroso');
    assert.ok(lavena, 'l\'id con C0 deve comunque comparire');
    assert.ok(
      lavena.sources.some((s) => s.includes('blog-meta-it.ts') && s.includes('residuo propagato')),
      `blog-meta-it.ts deve comparire come residuo propagato, sources=${JSON.stringify(lavena.sources)}`,
    );

    // Il controllo negativo: 'altro-articolo' non ha un byte C0 suo, e
    // 'poroso3' che gli compare per coincidenza testuale non e' un residuo
    // CONFERMATO per QUEL id (nessun file di 'altro-articolo' porta mai un C0)
    // — non deve comparire affatto.
    assert.ok(
      !ids.some((e) => e.id === 'altro-articolo'),
      'un id senza un solo byte C0 proprio non deve comparire per coincidenza testuale',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scanContentForDirtyIds: senza un\'ancora C0 da nessuna parte per quell\'id, niente si propaga (fail-closed)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dirty-content-ids-propag-none-'));
  try {
    writeTree(root, {
      // 'sar0' e' la FORMA del residuo, ma senza un file gemello che porti
      // ancora il C0 per QUESTO id non c'e' niente da confermare: indovinare
      // dalla sola forma (senza prova) e' esattamente il rischio scartato in
      // fase di design (428 falsi positivi misurati su un solo file reale).
      'content/blog-meta-it.ts':
        "export default {\n  'blog.article.trump-intesa-o-inferno.title': 'Trump: sar0 l\\'inferno',\n};\n",
    });
    const { ids } = scanContentForDirtyIds(root);
    assert.deepEqual(ids, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── Il segnaposto FAQ (issue #220) ──────────────────────────────────────────

test('isPlaceholderFaqQuestion riconosce l\'etichetta numerata dello schema nelle quattro lingue, non una domanda vera che parla di FAQ', () => {
  assert.ok(isPlaceholderFaqQuestion('FAQ 1 based on the facts of the article?'));
  assert.ok(isPlaceholderFaqQuestion('Domanda frequente 2 basata sui fatti?'));
  assert.ok(isPlaceholderFaqQuestion('Häufig gestellte Frage 3: was bedeutet das?'));
  assert.ok(isPlaceholderFaqQuestion('Question Fréquemment Posée 2 : Comment ?'));
  // Caso reale trovato costruendo il predicato: l'etichetta sopravvive fusa
  // dentro una domanda altrimenti genuina, non il segnaposto intero.
  assert.ok(isPlaceholderFaqQuestion('FAQ 1: What does the uncomfortable question mean?'));
  assert.ok(!isPlaceholderFaqQuestion('Quanto costa il diesel in Svizzera nel 2026?'));
  assert.ok(!isPlaceholderFaqQuestion('Come funzionano le FAQ del sito?'));
  assert.ok(!isPlaceholderFaqQuestion(''));
  assert.ok(!isPlaceholderFaqQuestion(null));
});

test('faqQuestionNamesInHtml legge Question.name dal JSON-LD FAQPage, ignora blocchi non-FAQ o non parsabili', () => {
  const html = [
    '<script type="application/ld+json">{"@type":"BreadcrumbList"}</script>',
    '<script type="application/ld+json">{ questo non e\' json </script>',
    '<script type="application/ld+json">',
    JSON.stringify({
      '@type': 'FAQPage',
      mainEntity: [{ '@type': 'Question', name: 'Una domanda vera?' }, { '@type': 'Question', name: 'FAQ 2 based on the facts?' }],
    }),
    '</script>',
  ].join('\n');
  assert.deepEqual(faqQuestionNamesInHtml(html), ['Una domanda vera?', 'FAQ 2 based on the facts?']);
  assert.deepEqual(faqQuestionNamesInHtml('<html>niente script</html>'), []);
});

test('pageCarriesFaqPlaceholder: pulita no, con l\'etichetta dello schema si', () => {
  const clean = '<script type="application/ld+json">' +
    JSON.stringify({ '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'Quanto costa il diesel?' }] }) +
    '</script>';
  const dirty = '<script type="application/ld+json">' +
    JSON.stringify({ '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'Domanda frequente 1 basata sui fatti?' }] }) +
    '</script>';
  assert.equal(pageCarriesFaqPlaceholder(clean), false);
  assert.equal(pageCarriesFaqPlaceholder(dirty), true);
});

test('faqQuestionsInBodyText legge le domande dal campo .faq grezzo del body, [] se assente o non JSON valido', () => {
  const text = "export default {\n 'blog.article.esempio.faq': '[{\"q\":\"Prima domanda?\",\"a\":\"risposta\"},{\"q\":\"Seconda domanda?\",\"a\":\"risposta\"}]',\n};\n";
  assert.deepEqual(faqQuestionsInBodyText(text), ['Prima domanda?', 'Seconda domanda?']);
  assert.deepEqual(faqQuestionsInBodyText("export default {\n 'blog.article.senza-faq.body1': 'niente qui';\n};\n"), []);
  assert.deepEqual(faqQuestionsInBodyText("'blog.article.rotto.faq': '[non json',"), []);
});

test('scanContentForDirtyIds: un body con la FORMA dell\'etichetta FAQ e\' sporco anche senza un solo byte C0', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dirty-content-ids-faq-'));
  try {
    writeTree(root, {
      'content/blog-body/de/domanda-scomoda.ts':
        "export default {\n 'blog.article.domanda-scomoda.faq': '[{\"q\":\"FAQ 1: Was bedeutet das?\",\"a\":\"...\"}]',\n};\n",
      'content/blog-body/it/pulito.ts':
        "export default {\n 'blog.article.pulito.faq': '[{\"q\":\"Una domanda vera?\",\"a\":\"...\"}]',\n};\n",
    });
    const { ids, totalFaqPlaceholderFiles } = scanContentForDirtyIds(root);
    assert.equal(totalFaqPlaceholderFiles, 1);
    const hit = ids.find((e) => e.id === 'domanda-scomoda');
    assert.ok(hit, 'l\'id con l\'etichetta FAQ deve comparire');
    assert.ok(hit.sources.some((s) => s.includes('faq-placeholder')));
    assert.ok(!ids.some((e) => e.id === 'pulito'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('classifyProbe: una pagina con l\'etichetta FAQ nel JSON-LD e\' dirty anche a zero control character e zero residui', () => {
  const dirtyFaqPage = '<script type="application/ld+json">' +
    JSON.stringify({ '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'FAQ 1 based on the facts of the article?' }] }) +
    '</script>';
  assert.equal(classifyProbe({ status: 200, body: dirtyFaqPage, residues: [] }), 'dirty');
});

// ── Il filtro sulla pagina live (issue #73) ─────────────────────────────────
//
// Niente rete: `fetchImpl` e' un parametro e le pagine sono stringhe qui sotto.
// I control character si scrivono con un escape JS e MAI come byte letterali
// nel sorgente: un file di test che porta un C0 grezzo e' esso stesso il
// difetto che sta descrivendo (e lo perderebbe ogni diff).

/** ETB, il C0 reale del corpus (`sar<ETB>0` per «sara'»). */
const C0_ETB = '\u0017';
/** BACKSPACE: quello che `JSON.stringify` scrive come `\b`, non come `\u0008`. */
const C0_BS = '\u0008';
/** Un byte-scan puro: esattamente cio' che vede — e cio' che si perde. */
const RAW_C0 = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

/** Le due sezioni, nella forma che il chiamante legge da section-shard-slugs.json. */
const SHARD_SLUGS = {
  articolifrontaliere: {
    it: 'articoli-frontaliere',
    en: 'cross-border-articles',
    de: 'grenzgaenger-artikel',
    fr: 'articles-frontalier',
  },
  articolisvizzera: {
    it: 'articoli-svizzera',
    en: 'swiss-articles',
    de: 'schweiz-artikel',
    fr: 'articles-suisse',
  },
};

// Slug REALI (dalla slugs.json pubblicata): mostrano che l'id italiano non
// compare affatto nelle URL en/de/fr.
const SLUGS = {
  blog: {
    'aggregazione-rischio-basso-mendrisiotto': {
      it: 'aggregazione-rischio-basso-mendrisiotto',
      en: 'merger-risk-lower-mendrisio',
      de: 'fusion-risiko-unteres-mendrisio',
      fr: 'fusion-risque-bas-mendrisio',
    },
    'prezzi-benzina-ticino': {
      it: 'prezzi-benzina-ticino',
      en: 'petrol-prices-ticino',
      de: 'benzinpreise-tessin',
      fr: 'prix-essence-tessin',
    },
  },
  swiss: {
    'credito-imposta-frontalieri-2026': {
      it: 'credito-imposta-frontalieri-2026',
      en: 'tax-credit-cross-border-2026',
      de: 'steuer-gutschrift-grenzarbeiter-2026',
      fr: 'credit-dimpot-frontalier-2026',
    },
  },
};

const CLEAN_PAGE = [
  '<!doctype html><html><head><title>Titolo pulito</title></head><body>',
  '<h1>Titolo pulito</h1>',
  '<script type="application/ld+json">{"headline":"Titolo pulito"}</script>',
  // Un `\b` in un LETTERALE REGEX significa «confine di parola», non backspace.
  // Se il rilevatore lo contasse come sporco, OGNI pagina risulterebbe sporca
  // per sempre: la stessa non-convergenza di #73, con un'altra causa.
  '<script>if (/\\bfrontaliere\\b/.test(document.title)) {}</script>',
  '</body></html>',
].join('\n');

/** C0 grezzo nel markup: quello che un byte-scan trova. */
const RAW_DIRTY_PAGE = CLEAN_PAGE.replace('<h1>Titolo pulito</h1>', `<h1>marted${C0_BS}8 sporco</h1>`);

/**
 * SOLO la forma escapata, dentro il ld+json. La pagina non porta un solo byte
 * C0 grezzo — un byte-scan la dichiarerebbe pulita — ma il dato STRUTTURATO che
 * il crawler parsa e' avvelenato.
 */
const ESCAPED_ONLY_PAGE = CLEAN_PAGE.replace(
  '{"headline":"Titolo pulito"}',
  JSON.stringify({ headline: `sar${C0_ETB}0 inferno` }),
);

function response(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, text: async () => body };
}

/** fetch finto: url -> pagina, o funzione (per simulare un guasto). 404 se ignota. */
function fakeFetch(pages, seen = []) {
  return async (url) => {
    seen.push(url);
    const page = pages[url];
    if (page === undefined) return response('', 404);
    if (typeof page === 'function') return page();
    return response(page);
  };
}

const noSleep = async () => {};

test('pageCarriesControlChars: pulita no, C0 grezzo si, forma escapata nel ld+json si', () => {
  assert.equal(pageCarriesControlChars(CLEAN_PAGE), false);
  assert.equal(pageCarriesControlChars(RAW_DIRTY_PAGE), true);
  assert.equal(pageCarriesControlChars(ESCAPED_ONLY_PAGE), true);
  // La prova che la seconda spelling e' quella che un byte-scan si perde.
  assert.ok(RAW_C0.test(RAW_DIRTY_PAGE), 'la pagina grezza deve essere visibile a un byte-scan');
  assert.ok(!RAW_C0.test(ESCAPED_ONLY_PAGE), 'la pagina escapata NON deve essere visibile a un byte-scan');
  assert.equal(pageCarriesControlChars(null), false);
});

test("liveUrlsForCandidate usa gli slug LOCALIZZATI e gli host origin, non l'id", () => {
  const urls = liveUrlsForCandidate({
    section: 'frontaliere',
    id: 'aggregazione-rischio-basso-mendrisiotto',
    slugs: SLUGS,
    sectionShardSlugs: SHARD_SLUGS,
  });
  assert.deepEqual(urls, [
    {
      locale: 'it',
      url: 'https://origin-articolifrontaliere-it.frontaliereticino.ch/articoli-frontaliere/aggregazione-rischio-basso-mendrisiotto/',
    },
    {
      locale: 'en',
      url: 'https://origin-articolifrontaliere-en.frontaliereticino.ch/en/cross-border-articles/merger-risk-lower-mendrisio/',
    },
    {
      locale: 'de',
      url: 'https://origin-articolifrontaliere-de.frontaliereticino.ch/de/grenzgaenger-artikel/fusion-risiko-unteres-mendrisio/',
    },
    {
      locale: 'fr',
      url: 'https://origin-articolifrontaliere-fr.frontaliereticino.ch/fr/articles-frontalier/fusion-risque-bas-mendrisio/',
    },
  ]);
  // L'id italiano non compare nelle URL en/de/fr: costruire l'URL dall'id
  // darebbe 404, cioe' «pagina assente», cioe' un id scartato per il motivo
  // sbagliato.
  for (const { locale, url } of urls.slice(1)) {
    assert.ok(!url.includes('aggregazione-rischio-basso-mendrisiotto'), `${locale} non deve portare l'id italiano`);
  }
  // Apex mai: li' il Worker tiene due varianti di cache e negative-cachea i 404.
  for (const { url } of urls) assert.ok(url.startsWith('https://origin-'), url);
});

test('liveUrlsForCandidate: la sezione svizzera va sul proprio shard; id non annunciato -> nessuna URL', () => {
  const urls = liveUrlsForCandidate({
    section: 'svizzera',
    id: 'credito-imposta-frontalieri-2026',
    slugs: SLUGS,
    sectionShardSlugs: SHARD_SLUGS,
  });
  assert.equal(urls.length, 4);
  assert.equal(
    urls[2].url,
    'https://origin-articolisvizzera-de.frontaliereticino.ch/de/schweiz-artikel/steuer-gutschrift-grenzarbeiter-2026/',
  );
  assert.deepEqual(
    liveUrlsForCandidate({ section: 'frontaliere', id: 'mai-annunciato', slugs: SLUGS, sectionShardSlugs: SHARD_SLUGS }),
    [],
  );
});

test('classifyProbe: 200 pulita clean, 200 sporca dirty, 404 absent, errore/5xx unknown', () => {
  assert.equal(classifyProbe({ status: 200, body: CLEAN_PAGE }), 'clean');
  assert.equal(classifyProbe({ status: 200, body: RAW_DIRTY_PAGE }), 'dirty');
  assert.equal(classifyProbe({ status: 200, body: ESCAPED_ONLY_PAGE }), 'dirty');
  assert.equal(classifyProbe({ status: 404 }), 'absent');
  assert.equal(classifyProbe({ status: 503, body: '' }), 'unknown');
  assert.equal(classifyProbe({ error: new Error('ETIMEDOUT') }), 'unknown');
});

test('verdictForCandidate: una sola pagina sporca basta a tenerlo, e un solo dubbio anche', () => {
  assert.deepEqual(verdictForCandidate([{ locale: 'it', verdict: 'clean' }, { locale: 'de', verdict: 'dirty' }]), {
    keep: true,
    reason: 'dirty',
    dirtyLocales: ['de'],
    unknownLocales: [],
  });
  assert.deepEqual(verdictForCandidate([{ locale: 'it', verdict: 'clean' }, { locale: 'de', verdict: 'unknown' }]), {
    keep: true,
    reason: 'unverified',
    dirtyLocales: [],
    unknownLocales: ['de'],
  });
  assert.equal(verdictForCandidate([{ locale: 'it', verdict: 'clean' }, { locale: 'de', verdict: 'absent' }]).keep, false);
  // Nessuna URL da verificare (id non annunciato): non si deduce «pulito».
  assert.equal(verdictForCandidate([]).keep, true);
  assert.equal(verdictForCandidate([]).reason, 'unannounced');
});

test("mapWithConcurrency conserva l'ordine degli input e non supera il limite", async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight -= 1;
    return n * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60, 70]);
  assert.ok(peak <= 3, `concorrenza di picco ${peak} > 3`);
});

// ── I quattro casi che #73 chiede espressamente ─────────────────────────────

const CANDIDATES = [
  { section: 'frontaliere', id: 'aggregazione-rischio-basso-mendrisiotto', sources: ['content/blog-meta-de.ts'] },
  { section: 'frontaliere', id: 'prezzi-benzina-ticino', sources: ['content/blog-body/de/prezzi-benzina-ticino.ts'] },
];

function urlsOf(section, id) {
  return liveUrlsForCandidate({ section, id, slugs: SLUGS, sectionShardSlugs: SHARD_SLUGS }).map((u) => u.url);
}

function allPages(body) {
  const pages = {};
  for (const c of CANDIDATES) for (const url of urlsOf(c.section, c.id)) pages[url] = body;
  return pages;
}

test('sporco nel corpus ma pagine live pulite -> ESCLUSO (la fix che fa convergere)', async () => {
  const { kept, cleared, probes } = await filterCandidatesByLivePage(CANDIDATES, {
    slugs: SLUGS,
    sectionShardSlugs: SHARD_SLUGS,
    fetchImpl: fakeFetch(allPages(CLEAN_PAGE)),
    sleep: noSleep,
  });
  assert.deepEqual(kept, []);
  assert.deepEqual(cleared.map((c) => c.id).sort(), CANDIDATES.map((c) => c.id).sort());
  assert.equal(probes, 8); // 2 candidati x 4 locali
});

test('sporco nel corpus E sulla pagina live -> INCLUSO, coi locali sporchi', async () => {
  const pages = allPages(CLEAN_PAGE);
  pages[urlsOf('frontaliere', 'prezzi-benzina-ticino')[2]] = RAW_DIRTY_PAGE; // solo il de
  const { kept, cleared } = await filterCandidatesByLivePage(CANDIDATES, {
    slugs: SLUGS,
    sectionShardSlugs: SHARD_SLUGS,
    fetchImpl: fakeFetch(pages),
    sleep: noSleep,
  });
  assert.deepEqual(kept.map((k) => k.id), ['prezzi-benzina-ticino']);
  assert.deepEqual(kept[0].dirtyLocales, ['de']);
  assert.equal(kept[0].liveReason, 'dirty');
  // I campi del candidato sopravvivono al filtro: il workflow legge `section`.
  assert.equal(kept[0].section, 'frontaliere');
  assert.deepEqual(kept[0].sources, ['content/blog-body/de/prezzi-benzina-ticino.ts']);
  assert.deepEqual(cleared.map((c) => c.id), ['aggregazione-rischio-basso-mendrisiotto']);
});

test('solo la forma escapata sulla pagina -> INCLUSO (un byte-scan la perderebbe)', async () => {
  const pages = allPages(CLEAN_PAGE);
  pages[urlsOf('frontaliere', 'prezzi-benzina-ticino')[0]] = ESCAPED_ONLY_PAGE; // it
  const { kept } = await filterCandidatesByLivePage(CANDIDATES, {
    slugs: SLUGS,
    sectionShardSlugs: SHARD_SLUGS,
    fetchImpl: fakeFetch(pages),
    sleep: noSleep,
  });
  assert.deepEqual(kept.map((k) => k.id), ['prezzi-benzina-ticino']);
  assert.deepEqual(kept[0].dirtyLocales, ['it']);
});

test('fetch che fallisce -> INCLUSO (in dubbio si tiene), dopo aver ritentato', async () => {
  const pages = allPages(CLEAN_PAGE);
  let attempts = 0;
  pages[urlsOf('frontaliere', 'prezzi-benzina-ticino')[3]] = () => {
    attempts += 1;
    throw new Error('ETIMEDOUT');
  };
  const { kept, cleared } = await filterCandidatesByLivePage(CANDIDATES, {
    slugs: SLUGS,
    sectionShardSlugs: SHARD_SLUGS,
    fetchImpl: fakeFetch(pages),
    sleep: noSleep,
  });
  assert.equal(attempts, 3, 'un fallimento di rete va ritentato prima di arrendersi');
  assert.deepEqual(kept.map((k) => k.id), ['prezzi-benzina-ticino']);
  assert.equal(kept[0].liveReason, 'unverified');
  assert.deepEqual(kept[0].unverifiedLocales, ['fr']);
  assert.deepEqual(kept[0].dirtyLocales, []);
  assert.deepEqual(cleared.map((c) => c.id), ['aggregazione-rischio-basso-mendrisiotto']);
});

test("un 5xx persistente non vale «pulita»: l'id resta candidato", async () => {
  const pages = allPages(CLEAN_PAGE);
  pages[urlsOf('frontaliere', 'prezzi-benzina-ticino')[1]] = () => response('', 502);
  const { kept } = await filterCandidatesByLivePage(CANDIDATES, {
    slugs: SLUGS,
    sectionShardSlugs: SHARD_SLUGS,
    fetchImpl: fakeFetch(pages),
    sleep: noSleep,
  });
  assert.deepEqual(kept.map((k) => k.id), ['prezzi-benzina-ticino']);
  assert.equal(kept[0].liveReason, 'unverified');
});

test('un id non annunciato in slugs.json resta candidato invece di sparire', async () => {
  const { kept, probes } = await filterCandidatesByLivePage(
    [{ section: 'frontaliere', id: 'mai-annunciato', sources: ['content/blog-body/it/mai-annunciato.ts'] }],
    { slugs: SLUGS, sectionShardSlugs: SHARD_SLUGS, fetchImpl: fakeFetch({}), sleep: noSleep },
  );
  assert.deepEqual(kept.map((k) => k.id), ['mai-annunciato']);
  assert.equal(kept[0].liveReason, 'unannounced');
  assert.equal(probes, 0);
});

test('filtro live + orderAndCap: il giro dopo serve id DIVERSI, non gli stessi', async () => {
  // La regressione di #73 in forma eseguibile. Cinque candidati dal corpus, i
  // primi due gia' ripubblicati (pagine pulite): col solo pre-filtro il cap 2 li
  // rifarebbe per sempre e gli altri tre non verrebbero serviti mai.
  const ids = ['a-uno', 'b-due', 'c-tre', 'd-quattro', 'e-cinque'];
  const slugs = { blog: Object.fromEntries(ids.map((id) => [id, { it: id, en: id, de: id, fr: id }])), swiss: {} };
  const candidates = ids.map((id) => ({ section: 'frontaliere', id, sources: [`content/blog-body/it/${id}.ts`] }));

  const senzaFiltro = orderAndCap(candidates, 2);
  assert.deepEqual(senzaFiltro.selected.map((s) => s.id), ['a-uno', 'b-due']);

  const pages = {};
  for (const c of candidates) {
    for (const { url } of liveUrlsForCandidate({ ...c, slugs, sectionShardSlugs: SHARD_SLUGS })) {
      pages[url] = ['a-uno', 'b-due'].includes(c.id) ? CLEAN_PAGE : RAW_DIRTY_PAGE;
    }
  }
  const { kept } = await filterCandidatesByLivePage(candidates, {
    slugs,
    sectionShardSlugs: SHARD_SLUGS,
    fetchImpl: fakeFetch(pages),
    sleep: noSleep,
  });
  const conFiltro = orderAndCap(kept, 2);
  assert.deepEqual(conFiltro.selected.map((s) => s.id), ['c-tre', 'd-quattro']);
  assert.deepEqual(conFiltro.leftover.map((s) => s.id), ['e-cinque']);
});

// ── Il residuo: il criterio che mancava ──────────────────────────────────────
//
// `pageCarriesControlChars` chiede «sanificare cambierebbe il documento?». Su
// una pagina emessa dopo #65 la risposta e' NO anche quando il testo e' rotto,
// perche' l'emitter il byte lo toglie in uscita e lascia la CIFRA dentro la
// parola. Misurato: il drenaggio riportava `0 con pagina live ancora sporca`
// mentre `nestle-200-postes-de-travail-en-lombardie` rispondeva 200 con 23
// parole rotte. E' lo stesso criterio con cui #71 fu chiusa per sbaglio.

test('residuesInText ricava la stringa che restera\' sulla pagina', () => {
  // \x16 al posto di 'é': tolto il byte resta la cifra dentro la parola.
  const out = residuesInText("const a = 'comp\u00169tences et con\u00167ues';");
  assert.ok(out.has('comp9tences'), `atteso comp9tences, visti: ${[...out]}`);
  assert.ok(out.has('con7ues'), `atteso con7ues, visti: ${[...out]}`);
});

test('residuesInText ignora i marker che non lasciano traccia', () => {
  // Qui il marker sostituiva un separatore: tolto il byte la parola e' gia'
  // corretta, quindi non c'e' nessuna stringa da cercare sulla pagina. Cercare
  // un `\w+\d\w+` generico darebbe invece falsi positivi ovunque.
  const out = residuesInText("const a = 'Ita\u0008lia e Svizzera';");
  assert.equal(out.size, 0, `nessun residuo atteso, visti: ${[...out]}`);
});

test('residuesInText copre anche il residuo a inizio o fine parola', () => {
  // Il marker puo' sostituire il PRIMO o l'ULTIMO carattere di una parola, non
  // solo uno in mezzo: misurato sul corpus reale in
  // lavena-ponte-tresa-territorio-poroso.ts (`\x083territorio`, `poroso\x083`).
  // Una parola con una sola lettera prima della cifra ('c1us') e' lo stesso
  // difetto: il byte era il carattere iniziale, non uno interno.
  const out = residuesInText("const a = '\x083territorio e poroso\x083, c\x011us dem Direktor';");
  assert.ok(out.has('3territorio'), `atteso 3territorio, visti: ${[...out]}`);
  assert.ok(out.has('poroso3'), `atteso poroso3, visti: ${[...out]}`);
  assert.ok(out.has('c1us'), `atteso c1us, visti: ${[...out]}`);
});

test('residuesInText ignora i token rimasti puramente numerici', () => {
  // Un marker fra due cifre (una lista, un range) resta un token di sole
  // cifre dopo lo strip: nessuna lettera, nessuna parola visibilmente rotta.
  const out = residuesInText("const a = '2024\x0e2033';");
  assert.equal(out.size, 0, `nessun residuo atteso, visti: ${[...out]}`);
});

test('una pagina SENZA control character ma col residuo e\' sporca', () => {
  // Il caso reale: l'emitter ha gia' sanificato, quindi zero byte C0, e la
  // pagina resta rotta. Senza questo ramo il drenaggio non converge mai.
  const body = '<p>des programmes sp9cifiques pour les comp9tences pratiques</p>';
  assert.equal(classifyProbe({ status: 200, body }), 'clean');
  assert.equal(classifyProbe({ status: 200, body, residues: ['comp9tences'] }), 'dirty');
});

test('i residui di un ALTRO articolo non sporcano questa pagina', () => {
  // Il residuo e' un oracolo per-articolo, non un pattern globale: e' cio' che
  // rende il criterio senza falsi positivi.
  const body = '<p>testo perfettamente pulito</p>';
  assert.equal(classifyProbe({ status: 200, body, residues: ['comp9tences', 'situ9e'] }), 'clean');
});

