/**
 * Il segnaposto del prompt non deve poter diventare un URL pubblico.
 *
 * ## L'incidente (misurato il 2026-08-09 su `slugs.json` pubblicato)
 *
 * Lo schema JSON mostrato al modello nomina i due campi che finiscono in URL
 * con dei valori d'esempio:
 *
 *     "id": "kebab-case-3-5-words-max-40-chars",
 *     "slugs": { "it": "slug-it", "en": "slug-en", "de": "slug-de", "fr": "slug-fr" },
 *
 * Un modello che perde il filo li ricopia invece di compilarli. Nessuno se ne
 * accorgeva: `slugifySlugPart()` vede un token ASCII minuscolo con trattini
 * perfettamente ben formato e lo lascia passare, e il sanitizer di `validate()`
 * toglieva a mano il solo prefisso `kebab-case-` — la famiglia `slug-*` non
 * era coperta da niente.
 *
 * Risultato: **24 slug vivi su 8 articoli**, tutti 200, tutti nelle sitemap
 * (`sitemap-blog.xml`, `sitemap-blog-ch.xml`) e quindi negli hreflang
 * reciproci. Piu' 4 `id` arrivati in produzione nel giro precedente dello
 * stesso difetto (`kebab-case-*`). Esempi vivi:
 *
 *     /en/cross-border-articles/slug-en/
 *     /de/schweiz-artikel/slug-tedesco/
 *     /fr/articles-suisse/slug-terzo-pilastro-3a-suisse/
 *     /articoli-frontaliere/kebab-case-3-5-words-max-40-chars/
 *
 * ## Perche' non basta una lista di letterali
 *
 * `slug-inglese` / `slug-tedesco` / `slug-francese` NON sono nel prompt: lo
 * schema scrive `slug-en` / `slug-de` / `slug-fr`. Il prompt intorno e' in
 * italiano, quindi il modello traduce il SIGNIFICATO del segnaposto e
 * restituisce un token che nel suo input non c'era mai stato. E non e' storia
 * vecchia: `terzo-pilastro-3a-svizzero-vantaggi-2026-canton-basilea` e'
 * generato il 2026-08-09 e li porta tutti e tre. Una lista dei quattro
 * letterali di oggi non ne avrebbe intercettato nemmeno uno.
 *
 * ## Cosa pinna questo file
 *
 *  1. **Le unita'** — `inspectSlugForPromptPlaceholder()` e
 *     `deriveAndSanitizeArticleSlugs()`, estratte dal sorgente ed eseguite in
 *     sandbox. Stessa tecnica di `seo-description-cap.test.mjs` e
 *     `blog-title-casing.test.mjs`: `import` diretto di `create-article.mjs`
 *     e' impossibile senza `node_modules` (la closure tira sharp, undici,
 *     firebase-admin…, che la CI di questo repo non installa di proposito). Se
 *     l'estrazione si rompe il test fallisce rumorosamente, non a vuoto.
 *
 *  2. **Lo scan sull'output gia' pubblicato** — 15.000+ slug in
 *     `content/routerBlogData.ts` e `content/routerSwissData.ts`. E' la meta'
 *     che conta davvero, per due ragioni opposte:
 *
 *      · e' la RETE: qualunque percorso aggiri il guard e scriva un segnaposto
 *        nel registro rende rosso `npm test` su OGNI branch, come per il cap
 *        della meta description;
 *
 *      · ed e' la prova di NON-regressione del classificatore. Il guard e'
 *        deliberatamente aggressivo (un falso positivo costa uno slug diverso
 *        su un articolo non ancora pubblicato, un falso negativo costa un URL
 *        pubblico permanente). Passarlo su 15.000 slug reali e trovarne 25 —
 *        esattamente i 25 noti — e' la misura che l'aggressivita' non tocca il
 *        corpus vero.
 *
 * ## `LEGACY_OFFENDERS` e' congelata, e l'uguaglianza e' ESATTA
 *
 * I 25 sono gia' pubblicati e rispondono 200, quindi non si rinominano da
 * soli: prima serve il bridge che manda la vecchia URL sulla nuova.
 *
 * **Corretto il 2026-08-10** (`valerielinc-ops/frontaliere-si-o-no#5352`): la
 * versione precedente di questo commento diceva che una mappa
 * old-slug -> new-slug per gli articoli non esiste, e che il renderer capace
 * di emettere un bridge sta in `engine/` (`outOfScope`). Sbagliato su
 * entrambi i punti. Il bridge lo emette `build-plugins/legacyRedirectsPlugin.ts`
 * del sito — non l'engine, quindi il mirror non c'entra — nella forma
 * `noindex,follow` + canonical + meta-refresh 0s scelta in #2996, ed e' vivo in
 * produzione da mesi su una quindicina di rename di articoli (misurato:
 * `/articoli-frontaliere/tassa-transito-svizzera-2023/` e
 * `/en/cross-border-articles/transit-fee-switzerland-2023/` rispondono 200
 * `noindex,follow` con il canonical sul 2026). Dalla stessa PR quella mappa ha
 * un ingresso a dati, `data/article-redirects.json`, e riparare un offender di
 * questa lista e' quindi: una voce li', il rename qui, in quest'ordine.
 * `content/swiss-article-canonical-overrides.json` resta la strada diversa che
 * era — consolidare due pagine entrambe vive, non spostarne una.
 *
 * L'asserzione e' di uguaglianza esatta, non di inclusione: un offender NUOVO
 * rompe il test (e' il punto), e un offender RIPARATO lo rompe pure, finche'
 * non viene tolto da questa lista. La lista puo' solo restringersi, e ogni
 * restringimento passa da una riga di codice che si vede in review.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CREATE_ARTICLE = path.join(ROOT, 'generator', 'scripts', 'create-article.mjs');

// ── Estrazione in sandbox ──────────────────────────────────────────────────

const src = fs.readFileSync(CREATE_ARTICLE, 'utf-8');

/** Dalla riga `header` fino alla prima riga che e' esattamente `}` in colonna 0. */
function sliceFn(header) {
  const start = src.indexOf(header);
  assert.notEqual(
    start,
    -1,
    `"${header}" non trovato in create-article.mjs — il guard e' stato rinominato o rimosso. ` +
      'Aggiornare i delimitatori di questo test, non cancellare le asserzioni.',
  );
  const endRel = src.slice(start).search(/\n\}\n/);
  assert.notEqual(endRel, -1, `chiusura di "${header}" non trovata`);
  return src.slice(start, start + endRel + 2);
}

/** Il blocco contiguo dalle tre regex fino alla fine del classificatore. */
function slicePlaceholderBlock() {
  const start = src.indexOf('const PROMPT_SLUG_PREFIX_RX');
  assert.notEqual(start, -1, 'PROMPT_SLUG_PREFIX_RX non trovato in create-article.mjs');
  const fn = sliceFn('export function inspectSlugForPromptPlaceholder(input) {');
  const fnStart = src.indexOf(fn);
  assert.ok(fnStart > start, 'il classificatore non segue piu\' le sue regex — aggiornare l\'estrazione');
  return src.slice(start, fnStart + fn.length);
}

function loadGuard() {
  const block = [
    sliceFn('function slugifySlugPart(input) {'),
    slicePlaceholderBlock(),
    sliceFn('export function deriveAndSanitizeArticleSlugs(data) {'),
  ]
    .join('\n\n')
    .replace(/^export /gm, '');
  return new Function(
    'console',
    `${block}\nreturn { inspectSlugForPromptPlaceholder, deriveAndSanitizeArticleSlugs, slugifySlugPart,` +
      ' PROMPT_SLUG_PREFIX_RX, NON_SLUG_REMAINDER_RX, SCHEMA_HINT_SHAPE_RX };',
  );
}

/** Sandbox con una console che REGISTRA: il guard deve essere rumoroso, e la
 *  rumorosita' e' una proprieta' da verificare, non da assumere. */
function freshGuard() {
  const logged = [];
  const fakeConsole = {
    error: (...a) => logged.push(a.join(' ')),
    warn: (...a) => logged.push(a.join(' ')),
    log: (...a) => logged.push(a.join(' ')),
  };
  return { ...loadGuard()(fakeConsole), logged };
}

const { inspectSlugForPromptPlaceholder } = freshGuard();

// ── I valori reali, presi dalla produzione ──────────────────────────────

/** Segnaposti puri: non resta niente di utile una volta tolto il prefisso. */
const UNRECOVERABLE = [
  'slug-it',
  'slug-en',
  'slug-de',
  'slug-fr',
  'slug-inglese',
  'slug-tedesco',
  'slug-francese',
  'kebab-case-3-5-words-max-40-chars',
  'placeholder',
  'undefined',
  'null',
  'slug',
  'esempio',
  'tbd',
  // Doppio prefisso: capita quando il modello ricopia la chiave E il valore.
  'slug-slug-en',
];

/** Segnaposto incollato a uno slug vero: il resto va tenuto, non buttato. */
const RECOVERABLE = [
  ['slug-gaggiolo-traffic', 'gaggiolo-traffic'],
  ['slug-gaggiolo-verkehr', 'gaggiolo-verkehr'],
  ['slug-traffico-da-record', 'traffico-da-record'],
  ['slug-terzo-pilastro-3a-vantaggi-2026-basilea', 'terzo-pilastro-3a-vantaggi-2026-basilea'],
  ['slug-terzo-pilastro-3a-switzerland', 'terzo-pilastro-3a-switzerland'],
  ['slug-terzo-pilastro-3a-schweiz', 'terzo-pilastro-3a-schweiz'],
  ['slug-terzo-pilastro-3a-suisse', 'terzo-pilastro-3a-suisse'],
  ['kebab-case-turismo-ticino', 'turismo-ticino'],
  ['kebab-case-ticino-nubifragio-grigioni', 'ticino-nubifragio-grigioni'],
  ['kebab-case-rossi-bruxelles-ticino', 'rossi-bruxelles-ticino'],
];

/** Slug veri, presi dal registro pubblicato: nessuno di questi puo' muoversi. */
const REAL_SLUGS = [
  'stipendio-netto-frontaliere-2026',
  'cross-border-net-salary-2026',
  'nettolohn-grenzgaenger-2026',
  'salaire-net-frontalier-2026',
  'lamal-vs-cmi-frontaliere',
  'first-day-working-switzerland',
  'saeule-3a-grenzgaenger',
  '13eme-salaire-frontalier',
  'costo-vita-svizzera-2026',
  'telework-agreement-italy-switzerland-ratified',
];

test('inspect: ogni segnaposto puro e\' segnalato e non lascia resto', () => {
  for (const value of UNRECOVERABLE) {
    const r = inspectSlugForPromptPlaceholder(value);
    assert.equal(r.leaked, true, `"${value}" non riconosciuto come segnaposto`);
    assert.equal(r.recovered, false, `"${value}" non ha resto utile ma e' stato dichiarato recuperabile`);
    assert.equal(r.slug, '', `"${value}" ha prodotto un resto ("${r.slug}") che non esiste`);
  }
});

test('inspect: il segnaposto incollato a uno slug vero conserva lo slug vero', () => {
  for (const [value, expected] of RECOVERABLE) {
    const r = inspectSlugForPromptPlaceholder(value);
    assert.equal(r.leaked, true, `"${value}" non riconosciuto come segnaposto`);
    assert.equal(r.recovered, true, `"${value}" ha un resto utile ma non e' stato recuperato`);
    assert.equal(r.slug, expected, `"${value}" → "${r.slug}", atteso "${expected}"`);
  }
});

test('inspect: gli slug veri non si muovono', () => {
  for (const value of REAL_SLUGS) {
    const r = inspectSlugForPromptPlaceholder(value);
    assert.equal(r.leaked, false, `falso positivo su uno slug reale: "${value}"`);
    assert.equal(r.slug, value, `"${value}" e' stato alterato in "${r.slug}"`);
  }
});

// ── L'enforcement al punto di scrittura condiviso ──────────────────────────

const IT_TITLE = 'Terzo pilastro 3a: i vantaggi fiscali nel Canton Lucerna';

function articleFixture(slugs) {
  return {
    id: 'terzo-pilastro-3a-canton-lucerna',
    slugs,
    content: {
      it: { title: IT_TITLE },
      en: { title: 'Pillar 3a: tax benefits in canton Lucerne' },
      de: { title: 'Saeule 3a: Steuervorteile im Kanton Luzern' },
      fr: { title: 'Pilier 3a: avantages fiscaux dans le canton de Lucerne' },
    },
  };
}

test('derive: un id segnaposto NON viene riscritto — fa fallire la registrazione', () => {
  const { deriveAndSanitizeArticleSlugs } = freshGuard();
  for (const badId of ['kebab-case-3-5-words-max-40-chars', 'kebab-case-turismo-ticino', 'slug-it']) {
    const data = { ...articleFixture({}), id: badId };
    assert.throws(
      () => deriveAndSanitizeArticleSlugs(data),
      /slug-placeholder/,
      `l'id "${badId}" e' passato: e' la chiave del registro, il nome del file body e lo slug italiano, ` +
        'e checkArticleIdExists() gira PRIMA di qui. Riscriverlo qui pubblicherebbe sotto un id mai ' +
        'controllato per collisioni; deve fallire.',
    );
  }
});

test('derive: un id vero passa e lo slug IT resta agganciato all\'id', () => {
  const { deriveAndSanitizeArticleSlugs } = freshGuard();
  const data = articleFixture({ en: 'pillar-3a-lucerne', de: 'saeule-3a-luzern', fr: 'pilier-3a-lucerne' });
  const slugs = deriveAndSanitizeArticleSlugs(data);
  assert.equal(slugs.it, data.id);
  assert.deepEqual(slugs, {
    it: 'terzo-pilastro-3a-canton-lucerna',
    en: 'pillar-3a-lucerne',
    de: 'saeule-3a-luzern',
    fr: 'pilier-3a-lucerne',
  });
});

test('derive: il resto del segnaposto vince sul titolo — il modello uno slug lo aveva prodotto', () => {
  const { deriveAndSanitizeArticleSlugs } = freshGuard();
  const data = articleFixture({
    en: 'slug-terzo-pilastro-3a-switzerland',
    de: 'slug-terzo-pilastro-3a-schweiz',
    fr: 'slug-terzo-pilastro-3a-suisse',
  });
  const slugs = deriveAndSanitizeArticleSlugs(data);
  assert.equal(slugs.en, 'terzo-pilastro-3a-switzerland');
  assert.equal(slugs.de, 'terzo-pilastro-3a-schweiz');
  assert.equal(slugs.fr, 'terzo-pilastro-3a-suisse');
});

test('derive: senza resto utile si scende sul titolo tradotto', () => {
  const { deriveAndSanitizeArticleSlugs } = freshGuard();
  const data = articleFixture({ en: 'slug-en', de: 'slug-tedesco', fr: 'slug-fr' });
  const slugs = deriveAndSanitizeArticleSlugs(data);
  assert.equal(slugs.en, 'pillar-3a-tax-benefits-in-canton-lucerne');
  assert.equal(slugs.de, 'saeule-3a-steuervorteile-im-kanton-luzern');
  assert.equal(slugs.fr, 'pilier-3a-avantages-fiscaux-dans-le-canton-de-lucerne');
  for (const slug of Object.values(slugs)) {
    assert.equal(inspectSlugForPromptPlaceholder(slug).leaked, false, `sopravvive un segnaposto: "${slug}"`);
  }
});

test('derive: senza resto e senza titolo tradotto si scende sullo slug IT, mai su una stringa vuota', () => {
  const { deriveAndSanitizeArticleSlugs } = freshGuard();
  const data = articleFixture({ en: 'slug-en', de: 'slug-de', fr: 'slug-fr' });
  data.content.en = {};
  data.content.de = {};
  data.content.fr = {};
  const slugs = deriveAndSanitizeArticleSlugs(data);
  // Uno slug vuoto instrada sull'hub della sezione: l'articolo diventa
  // irraggiungibile al proprio URL senza che niente lo dica.
  for (const locale of ['en', 'de', 'fr']) {
    assert.equal(slugs[locale], slugs.it, `${locale} non e' caduto sullo slug IT`);
  }
});

test('derive: la sostituzione e\' RUMOROSA — ogni locale corretto lascia una riga', () => {
  const g = freshGuard();
  const data = articleFixture({ en: 'slug-en', de: 'slug-tedesco', fr: 'slug-gaggiolo-traffic' });
  g.deriveAndSanitizeArticleSlugs(data);
  const lines = g.logged.filter((l) => l.includes('[slug-placeholder]'));
  assert.equal(
    lines.length,
    3,
    'una sostituzione silenziosa e\' il difetto, non la cura: ogni locale corretto deve lasciare ' +
      `una riga marcata [slug-placeholder] nel log del run. Trovate ${lines.length} righe su 3.`,
  );
  for (const locale of ['en', 'de', 'fr']) {
    assert.ok(
      lines.some((l) => l.includes(`slug ${locale}`)),
      `nessuna riga di log per il locale ${locale}`,
    );
  }
});

test('derive: nessun log quando non c\'e\' niente da correggere', () => {
  const g = freshGuard();
  g.deriveAndSanitizeArticleSlugs(
    articleFixture({ en: 'pillar-3a-lucerne', de: 'saeule-3a-luzern', fr: 'pilier-3a-lucerne' }),
  );
  assert.deepEqual(g.logged, [], 'un guard che parla sempre non lo legge piu\' nessuno');
});

// ── Lo scan sul registro pubblicato ────────────────────────────────────────

/**
 * I 25 segnaposti gia' pubblicati, congelati. Chiave: `<sezione>|<id>|<locale>`.
 * Vedi l'intestazione: la lista puo' solo restringersi, e restringerla e' una
 * modifica di codice.
 */
const LEGACY_OFFENDERS = new Set([
  // Giro precedente dello stesso difetto: il segnaposto nell'`id`, quindi
  // anche nello slug italiano (`data.slugs.it = data.id`).
  'blog|kebab-case-turismo-ticino|it',
  'blog|kebab-case-ticino-nubifragio-grigioni|it',
  'blog|kebab-case-rossi-bruxelles-ticino|it',
  'blog|kebab-case-3-5-words-max-40-chars|it',
  // 2026-08-09: la famiglia `slug-*`, mai coperta da niente.
  'blog|kebab-case-3-5-words-max-40-chars|en',
  'blog|kebab-case-3-5-words-max-40-chars|de',
  'blog|kebab-case-3-5-words-max-40-chars|fr',
  'blog|dipiu-frenata-per-gli-annunci-di-lavoro-in-svizzera|en',
  'blog|dipiu-frenata-per-gli-annunci-di-lavoro-in-svizzera|de',
  'blog|dipiu-frenata-per-gli-annunci-di-lavoro-in-svizzera|fr',
  'swiss|traffico-da-record|en',
  'swiss|traffico-da-record|de',
  'swiss|traffico-da-record|fr',
  'swiss|terzo-pilastro-3a-vantaggi-2026-basilea|en',
  'swiss|terzo-pilastro-3a-vantaggi-2026-basilea|de',
  'swiss|terzo-pilastro-3a-vantaggi-2026-basilea|fr',
  'swiss|raffreddare-le-citta-svizzere-il-lavoro-e-appena-iniziato|en',
  'swiss|raffreddare-le-citta-svizzere-il-lavoro-e-appena-iniziato|de',
  'swiss|raffreddare-le-citta-svizzere-il-lavoro-e-appena-iniziato|fr',
  'swiss|terzo-pilastro-3a-svizzero-vantaggi-2026-canton-basilea|en',
  'swiss|terzo-pilastro-3a-svizzero-vantaggi-2026-canton-basilea|de',
  'swiss|terzo-pilastro-3a-svizzero-vantaggi-2026-canton-basilea|fr',
  'swiss|terzo-pilastro-3a-svizzero-vantaggi-canton-lucerna|en',
  'swiss|terzo-pilastro-3a-svizzero-vantaggi-canton-lucerna|de',
  'swiss|terzo-pilastro-3a-svizzero-vantaggi-canton-lucerna|fr',
]);

const REGISTRIES = [
  { section: 'blog', file: 'content/routerBlogData.ts', constName: 'BLOG_SLUGS' },
  { section: 'swiss', file: 'content/routerSwissData.ts', constName: 'SWISS_SLUGS' },
];

/**
 * Legge la mappa `'<id>': { it: '…', en: '…', de: '…', fr: '…' }` di un
 * registro. Le due sezioni usano formattazioni diverse — `routerBlogData.ts`
 * tiene ogni voce su una riga, `routerSwissData.ts` la espande su cinque — e
 * `[^}]*` copre entrambe perche' attraversa i newline.
 */
function readRegistry({ file, constName }) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf-8');
  const start = text.indexOf(`export const ${constName}`);
  assert.notEqual(start, -1, `${constName} non trovato in ${file}`);
  const open = text.indexOf('{', start);
  const end = text.indexOf('\n};', open);
  assert.ok(end > open, `chiusura di ${constName} non trovata in ${file}`);
  const body = text.slice(open, end);
  const entries = [];
  const entryRx = /'([^']+)':\s*\{([^}]*)\}/g;
  let m;
  while ((m = entryRx.exec(body)) !== null) {
    const perLocale = {};
    const localeRx = /\b(it|en|de|fr):\s*'([^']*)'/g;
    let l;
    while ((l = localeRx.exec(m[2])) !== null) perLocale[l[1]] = l[2];
    entries.push({ id: m[1], perLocale });
  }
  return entries;
}

test('registro: nessun segnaposto oltre i 25 congelati, e la lista non e\' stantia', () => {
  const found = new Set();
  const detail = new Map();
  let scanned = 0;
  for (const registry of REGISTRIES) {
    const entries = readRegistry(registry);
    assert.ok(
      entries.length > 500,
      `${registry.file}: lette solo ${entries.length} voci — il parser non sta leggendo il registro, ` +
        'e un test che scansiona il vuoto passa sempre.',
    );
    for (const { id, perLocale } of entries) {
      for (const [locale, slug] of Object.entries(perLocale)) {
        scanned += 1;
        if (!inspectSlugForPromptPlaceholder(slug).leaked) continue;
        const key = `${registry.section}|${id}|${locale}`;
        found.add(key);
        detail.set(key, slug);
      }
    }
  }

  // Autoverifica: senza questa soglia un parser rotto renderebbe verde sia
  // questo test sia la prova di non-regressione sui falsi positivi.
  assert.ok(scanned > 14000, `scansionati solo ${scanned} slug — il parser e' rotto`);

  const nuovi = [...found].filter((k) => !LEGACY_OFFENDERS.has(k));
  assert.deepEqual(
    nuovi,
    [],
    `${nuovi.length} slug NUOVI con il segnaposto del prompt sono entrati nel registro.\n` +
      'Un segnaposto pubblicato e\' un URL pubblico permanente. Ripararlo dopo si puo\', ma costa due\n' +
      'PR in quest\'ordine: prima il bridge sul sito (data/article-redirects.json ->\n' +
      'legacyRedirectsPlugin), poi il rename qui. Non farlo entrare e\' molto piu\' economico.\n' +
      nuovi.map((k) => `  ${k} = "${detail.get(k)}"`).join('\n'),
  );

  const spariti = [...LEGACY_OFFENDERS].filter((k) => !found.has(k));
  assert.deepEqual(
    spariti,
    [],
    'Questi erano in LEGACY_OFFENDERS e nel registro non ci sono piu\'. Se sono stati riparati,\n' +
      'toglierli dalla lista in questo file. La vecchia URL era pubblicata e rispondeva 200: deve\n' +
      'avere una voce in data/article-redirects.json sul sito, atterrata PRIMA di questo rename.\n' +
      spariti.map((k) => `  ${k}`).join('\n'),
  );
});

test('registro: il classificatore non tocca i 15.000 slug veri gia\' pubblicati', () => {
  // La prova di non-regressione del guard aggressivo. Gli unici `leaked` sono
  // i 25 noti: tutto il resto del corpus attraversa il classificatore intatto.
  //
  // Il confronto e' con `slugifySlugPart(slug)` e non con `slug` per una
  // ragione preesistente al guard: la normalizzazione taglia a 80 caratteri, e
  // nel registro c'e' un pugno di slug piu' lunghi, scritti prima che il cap
  // esistesse. Pinnare `slug` grezzo misurerebbe quel cap, non il guard.
  const { slugifySlugPart } = freshGuard();
  let unchanged = 0;
  for (const registry of REGISTRIES) {
    for (const { id, perLocale } of readRegistry(registry)) {
      for (const [locale, slug] of Object.entries(perLocale)) {
        const key = `${registry.section}|${id}|${locale}`;
        if (LEGACY_OFFENDERS.has(key)) continue;
        const r = inspectSlugForPromptPlaceholder(slug);
        assert.equal(r.leaked, false, `falso positivo su uno slug pubblicato: ${key} = "${slug}"`);
        assert.equal(
          r.slug,
          slugifySlugPart(slug),
          `slug pubblicato alterato oltre la normalizzazione: ${key} "${slug}" → "${r.slug}"`,
        );
        unchanged += 1;
      }
    }
  }
  assert.ok(unchanged > 14000, `verificati solo ${unchanged} slug`);
});
