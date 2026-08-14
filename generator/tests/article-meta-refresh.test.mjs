/**
 * `generator/scripts/lib/article-meta-refresh.mjs` — the write path issue #85
 * was missing: an already-registered article's excerpt/seoDescription/
 * ogDescription (meta) and description/ogDescription (SEO entry) could only
 * be set ONCE, at registration. `registerArticleFiles` is append-only by
 * design (it throws on a second registration), so a content builder whose
 * output changes after publication — exactly what #83 did to the daily
 * Bollettino's template — had no way back into `content/` for an id that
 * already existed.
 *
 * Three lenses, matching the convention `meta-localized-seo-description.test.mjs`
 * and `seo-description-cap.test.mjs` already use for this same corpus surface:
 *
 *   1. `upsertLocaleMetaFields` / `upsertSeoDescriptionBlock` — pure
 *      string-in/string-out, no filesystem. Update-in-place, insert-when-
 *      missing (the pre-#83 editions never got a `seoDescription`/
 *      `ogDescription` KEY at all, not just a short value), scoped to the
 *      right id and never bleeding into a sibling entry, and idempotent.
 *   2. `refreshDescriptiveTexts` — the file-I/O wrapper, against a synthetic
 *      corpus tree (a real repo checkout is not needed, and must not be
 *      required — see the anti-false-green note in the sibling test file).
 *   3. WIRING — `generate-daily-brief-article.mjs`'s `exists` branch actually
 *      calls this. Asserted on the SOURCE, not by importing the script: it
 *      pulls in create-article.mjs, whose static `jsdom` dependency does not
 *      exist under this repo's dependency-free `node --test` (no `npm ci` on
 *      that gate — see generator-ci.yml / tests.yml).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  upsertLocaleMetaFields,
  upsertSeoDescriptionBlock,
  refreshDescriptiveTexts,
  SEO_DESCRIPTION_MAX,
  SEO_OG_DESCRIPTION_MAX,
} from '../scripts/lib/article-meta-refresh.mjs';
import { buildDescriptiveTexts, buildDailyBriefArticle } from '../scripts/lib/daily-brief-content.mjs';
import { sanitizePromptPlaceholders } from '../scripts/lib/prompt-placeholder-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GENERATE_SCRIPT = path.join(HERE, '..', 'scripts', 'generate-daily-brief-article.mjs');
const CREATE_ARTICLE = path.join(HERE, '..', 'scripts', 'create-article.mjs');

// ── 1a. upsertLocaleMetaFields ──────────────────────────────────────────────

const META_FIXTURE =
  "const blogMetaIt: Record<string, string> = {\n" +
  "    'blog.article.before-article.title': 'Prima',\n" +
  "    'blog.article.before-article.excerpt': 'Estratto prima',\n" +
  "    'blog.article.demo-id.title': 'Titolo demo',\n" +
  "    'blog.article.demo-id.excerpt': 'Estratto corto',\n" +
  "    'blog.article.demo-id.imageAlt': 'Alt demo',\n" +
  "    'blog.article.after-article.title': 'Dopo',\n" +
  "};\nexport default blogMetaIt;\n";

test('upsertLocaleMetaFields: aggiorna excerpt esistente, inserisce i due campi mancanti', () => {
  const out = upsertLocaleMetaFields(META_FIXTURE, 'demo-id', {
    excerpt: 'Estratto lungo e ricco, il testo che il lettore legge davvero.',
    seoDescription: 'Testo per la SERP.',
    ogDescription: 'Testo per la card social.',
  });

  assert.ok(
    out.includes("'blog.article.demo-id.excerpt': 'Estratto lungo e ricco, il testo che il lettore legge davvero.',"),
    "l'excerpt esistente deve essere sostituito in place",
  );
  assert.ok(
    !out.includes("'blog.article.demo-id.excerpt': 'Estratto corto',"),
    'il vecchio valore corto non deve sopravvivere',
  );
  // Inserite DOPO l'ultima riga esistente di questo id (imageAlt), nell'ordine
  // seoDescription poi ogDescription — lo stesso ordine di META_FIELDS.
  const imageAltAt = out.indexOf("'blog.article.demo-id.imageAlt'");
  const seoAt = out.indexOf("'blog.article.demo-id.seoDescription': 'Testo per la SERP.',");
  const ogAt = out.indexOf("'blog.article.demo-id.ogDescription': 'Testo per la card social.',");
  assert.ok(imageAltAt > -1 && seoAt > imageAltAt && ogAt > seoAt, 'ordine di inserimento errato');

  // Righe di altri articoli intatte, prima e dopo.
  assert.ok(out.includes("'blog.article.before-article.excerpt': 'Estratto prima',"));
  assert.ok(out.includes("'blog.article.after-article.title': 'Dopo',"));

  // Indentazione preservata (4 spazi, come le righe esistenti).
  assert.ok(out.includes("\n    'blog.article.demo-id.seoDescription':"), 'indentazione non preservata');
});

test('upsertLocaleMetaFields: e\' idempotente — un secondo giro non cambia nulla', () => {
  const once = upsertLocaleMetaFields(META_FIXTURE, 'demo-id', {
    excerpt: 'Estratto lungo',
    seoDescription: 'SERP',
    ogDescription: 'Social',
  });
  const twice = upsertLocaleMetaFields(once, 'demo-id', {
    excerpt: 'Estratto lungo',
    seoDescription: 'SERP',
    ogDescription: 'Social',
  });
  assert.equal(twice, once, 'un rerun con gli stessi testi deve restituire la stringa invariata');
});

test('upsertLocaleMetaFields: un valore gia\' corretto non tocca il file (nessuna riscrittura spuria)', () => {
  const out = upsertLocaleMetaFields(META_FIXTURE, 'before-article', { excerpt: 'Estratto prima' });
  assert.equal(out, META_FIXTURE, "il valore e' gia' quello giusto: la stringa deve restare la STESSA reference");
});

test('upsertLocaleMetaFields: un apostrofo nel valore resta un round-trip esatto', () => {
  const out = upsertLocaleMetaFields(META_FIXTURE, 'demo-id', {
    seoDescription: "Quello che costa meno all'estero oggi.",
  });
  assert.ok(out.includes("'blog.article.demo-id.seoDescription': 'Quello che costa meno all\\'estero oggi.',"));
});

test('upsertLocaleMetaFields: id non registrato in questo file — errore esplicito, nessun corpus a mano', () => {
  assert.throws(
    () => upsertLocaleMetaFields(META_FIXTURE, 'id-inesistente', { seoDescription: 'x' }),
    /non e'? registrato/,
  );
});

// ── 1b. upsertSeoDescriptionBlock ───────────────────────────────────────────

const SEO_FIXTURE =
  "const BLOG_SEO_METADATA_5: Record<string, SEOMetadata> = {\n" +
  "  'blog-before-entry': {\n" +
  "    title: 'Before',\n" +
  "    description: 'Before desc',\n" +
  "    ogDescription: 'Before og',\n" +
  "  },\n" +
  "\n" +
  "  'blog-demo-id': {\n" +
  "    title: 'Demo',\n" +
  "    description: 'Corto',\n" +
  "    keywords: 'k',\n" +
  "    ogTitle: 'Demo',\n" +
  "    ogDescription: 'Corto',\n" +
  "    canonicalPath: '/x',\n" +
  "    structuredData: {\n" +
  "      \"@type\": \"NewsArticle\",\n" +
  "      \"description\": \"Corto\",\n" +
  "      \"headline\": \"Demo\"\n" +
  "    }\n" +
  "  },\n" +
  "\n" +
  "  'blog-after-entry': {\n" +
  "    title: 'After',\n" +
  "    description: 'After desc',\n" +
  "  },\n" +
  "};\nexport default BLOG_SEO_METADATA_5;\n";

test('upsertSeoDescriptionBlock: aggiorna description/ogDescription e il gemello structuredData, scoped al solo id', () => {
  const out = upsertSeoDescriptionBlock(SEO_FIXTURE, 'demo-id', {
    description: 'Descrizione nuova per la SERP.',
    ogDescription: 'Descrizione social nuova, piu\' lunga.',
  });

  assert.ok(out.includes("    description: 'Descrizione nuova per la SERP.',"));
  assert.ok(out.includes("    ogDescription: 'Descrizione social nuova, piu\\' lunga.',"));
  assert.ok(out.includes('      "description": "Descrizione nuova per la SERP.",'), 'structuredData.description non aggiornata in coppia');
  assert.notEqual(
    out.match(/description: '([^']*)'/)[1],
    out.match(/ogDescription: '([^']*)'/)[1],
    'description e ogDescription devono restare due testi distinti (la regressione #79/#80)',
  );

  // Le entry vicine non si toccano.
  assert.ok(out.includes("    description: 'Before desc',"), 'entry precedente alterata');
  assert.ok(out.includes("    description: 'After desc',"), 'entry successiva alterata');
});

test('upsertSeoDescriptionBlock: idempotente', () => {
  const once = upsertSeoDescriptionBlock(SEO_FIXTURE, 'demo-id', {
    description: 'Nuova.',
    ogDescription: 'Nuova social.',
  });
  const twice = upsertSeoDescriptionBlock(once, 'demo-id', {
    description: 'Nuova.',
    ogDescription: 'Nuova social.',
  });
  assert.equal(twice, once);
});

test('upsertSeoDescriptionBlock: entry gia\' corretta — nessuna riscrittura (stessa reference)', () => {
  const out = upsertSeoDescriptionBlock(SEO_FIXTURE, 'before-entry', { description: 'Before desc' });
  assert.equal(out, SEO_FIXTURE);
});

test('upsertSeoDescriptionBlock: entry assente — errore esplicito', () => {
  assert.throws(() => upsertSeoDescriptionBlock(SEO_FIXTURE, 'non-esiste', { description: 'x' }), /nessuna entry/);
});

// ── 2. refreshDescriptiveTexts — la scrittura su un albero sintetico ────────

/** Un albero minimo che imita il layout `content/` del corpus, cosi' il test
 * non tocca (e non dipende da) i file veri del repo. */
function syntheticCorpus() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'article-meta-refresh-'));
  fs.mkdirSync(path.join(root, 'content', 'seo'), { recursive: true });
  for (const locale of ['it', 'en', 'de', 'fr']) {
    fs.writeFileSync(
      path.join(root, 'content', `blog-meta-${locale}.ts`),
      "const m: Record<string, string> = {\n" +
        `    'blog.article.demo-id.title': 'T ${locale}',\n` +
        `    'blog.article.demo-id.excerpt': 'Corto ${locale}',\n` +
        `    'blog.article.demo-id.imageAlt': 'Alt ${locale}',\n` +
        '};\nexport default m;\n',
    );
  }
  fs.writeFileSync(
    path.join(root, 'content', 'seo', 'seo-blog-5.ts'),
    "const BLOG_SEO_METADATA_5: Record<string, SEOMetadata> = {\n" +
      "  'blog-demo-id': {\n" +
      "    title: 'T',\n" +
      "    description: 'Corto',\n" +
      "    ogTitle: 'T',\n" +
      "    ogDescription: 'Corto',\n" +
      "    canonicalPath: '/demo-id',\n" +
      '    structuredData: {\n' +
      '      "description": "Corto"\n' +
      '    }\n' +
      '  },\n' +
      '};\nexport default BLOG_SEO_METADATA_5;\n',
  );
  return root;
}

test('refreshDescriptiveTexts: scrive tutte e 4 le locali + il file SEO, e riporta i file toccati', () => {
  const root = syntheticCorpus();
  try {
    const localeTexts = {};
    for (const locale of ['it', 'en', 'de', 'fr']) {
      localeTexts[locale] = {
        excerpt: `Estratto lungo e ricco ${locale}`,
        seoDescription: `SERP ${locale}`,
        ogDescription: `Social ${locale}`,
      };
    }
    const { changed, touched } = refreshDescriptiveTexts(
      'demo-id',
      localeTexts,
      { description: 'SERP it', ogDescription: 'Social it' },
      { repoRoot: root },
    );
    assert.equal(changed, true);
    assert.equal(touched.length, 5, '4 file meta + 1 file seo');

    const en = fs.readFileSync(path.join(root, 'content', 'blog-meta-en.ts'), 'utf-8');
    assert.ok(en.includes("'blog.article.demo-id.excerpt': 'Estratto lungo e ricco en',"));
    assert.ok(en.includes("'blog.article.demo-id.seoDescription': 'SERP en',"));
    assert.ok(en.includes("'blog.article.demo-id.ogDescription': 'Social en',"));

    const seo = fs.readFileSync(path.join(root, 'content', 'seo', 'seo-blog-5.ts'), 'utf-8');
    assert.ok(seo.includes("description: 'SERP it',"));
    assert.ok(seo.includes("ogDescription: 'Social it',"));
    assert.ok(seo.includes('"description": "SERP it"'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refreshDescriptiveTexts: un secondo giro con gli stessi testi non scrive niente (changed: false)', () => {
  const root = syntheticCorpus();
  try {
    const localeTexts = {};
    for (const locale of ['it', 'en', 'de', 'fr']) {
      localeTexts[locale] = { excerpt: `E ${locale}`, seoDescription: `S ${locale}`, ogDescription: `O ${locale}` };
    }
    const seoTexts = { description: 'S it', ogDescription: 'O it' };
    const first = refreshDescriptiveTexts('demo-id', localeTexts, seoTexts, { repoRoot: root });
    assert.equal(first.changed, true);

    // mtime prima del secondo giro, per provare che non e' stato scritto niente
    // (non solo che il CONTENUTO e' rimasto uguale).
    const metaFile = path.join(root, 'content', 'blog-meta-it.ts');
    const mtimeBefore = fs.statSync(metaFile).mtimeMs;

    const second = refreshDescriptiveTexts('demo-id', localeTexts, seoTexts, { repoRoot: root });
    assert.equal(second.changed, false, "issue #85 review note: un rerun senza cambi non deve scrivere — e' quello che tiene dateModified da non sfarfallare");
    assert.deepEqual(second.touched, []);
    assert.equal(fs.statSync(metaFile).mtimeMs, mtimeBefore, 'il file non deve essere stato riscritto');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── 1c. Il clamp (issue #146 review: il write path non ne aveva uno) ───────
//
// `registerArticleFiles` applica `clampSeoDescriptions` PRIMA di scrivere;
// questo modulo e' l'ALTRO write path sugli stessi campi (cron `exists` +
// script di repair) e deve avere la stessa rete, altrimenti una description
// fuori budget raggiunge `dist/api/` senza che nulla nel loop se ne accorga
// (`.github/workflows/generate-daily-brief.yml` push-a `main` senza
// `node --test` in mezzo).

const LONG_TEXT =
  'I numeri di oggi, 9 agosto 2026, per chi attraversa il confine: attese ai valichi misurate ' +
  'stamattina, i comuni dove la benzina costa meno, il cambio franco–euro e i nuovi annunci di ' +
  'lavoro in Svizzera. Dati raccolti dal nostro monitoraggio, aggiornati ogni giorno.';

test('refreshDescriptiveTexts: una seoDescription/description fuori budget viene tagliata prima di scrivere', () => {
  const root = syntheticCorpus();
  try {
    assert.ok(LONG_TEXT.length > SEO_DESCRIPTION_MAX);
    const localeTexts = {
      it: { excerpt: 'Estratto lungo, non tagliato', seoDescription: LONG_TEXT, ogDescription: 'Social it' },
    };
    const seoTexts = { description: LONG_TEXT, ogDescription: 'Social it' };
    refreshDescriptiveTexts('demo-id', localeTexts, seoTexts, { repoRoot: root });

    const it = fs.readFileSync(path.join(root, 'content', 'blog-meta-it.ts'), 'utf-8');
    const seoMatch = it.match(/'blog\.article\.demo-id\.seoDescription': '([^']*)'/);
    assert.ok(seoMatch, 'seoDescription non scritta');
    assert.ok(seoMatch[1].length <= SEO_DESCRIPTION_MAX, `seoDescription scritta fuori budget: ${seoMatch[1].length} chars`);
    assert.ok(LONG_TEXT.startsWith(seoMatch[1]), 'il taglio deve essere un prefisso del testo originale');
    // excerpt non ha budget: deve restare intatto.
    assert.ok(it.includes("'blog.article.demo-id.excerpt': 'Estratto lungo, non tagliato',"));

    const seo = fs.readFileSync(path.join(root, 'content', 'seo', 'seo-blog-5.ts'), 'utf-8');
    const descMatch = seo.match(/ {4}description: '([^']*)'/);
    assert.ok(descMatch, 'description non scritta');
    assert.ok(descMatch[1].length <= SEO_DESCRIPTION_MAX, `description scritta fuori budget: ${descMatch[1].length} chars`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refreshDescriptiveTexts: una ogDescription oltre il proprio budget (250) viene tagliata comunque', () => {
  const root = syntheticCorpus();
  try {
    const huge = `${LONG_TEXT} ${LONG_TEXT}`;
    assert.ok(huge.length > SEO_OG_DESCRIPTION_MAX);
    const localeTexts = { it: { ogDescription: huge } };
    refreshDescriptiveTexts('demo-id', localeTexts, undefined, { repoRoot: root });
    const it = fs.readFileSync(path.join(root, 'content', 'blog-meta-it.ts'), 'utf-8');
    const ogMatch = it.match(/'blog\.article\.demo-id\.ogDescription': '([^']*)'/);
    assert.ok(ogMatch, 'ogDescription non scritta');
    assert.ok(ogMatch[1].length <= SEO_OG_DESCRIPTION_MAX, `ogDescription scritta fuori budget: ${ogMatch[1].length} chars`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refreshDescriptiveTexts: un testo social entro budget social ma sopra quello SERP resta intatto sull\'ogDescription', () => {
  const root = syntheticCorpus();
  try {
    const social =
      'I numeri del 22 settembre 2026 per i frontalieri: quanto si aspetta a ogni valico stamattina, ' +
      'in quali comuni conviene fare il pieno, quanto vale oggi il franco e quanti annunci di lavoro ' +
      'sono usciti in Svizzera.';
    assert.ok(social.length > SEO_DESCRIPTION_MAX);
    assert.ok(social.length <= SEO_OG_DESCRIPTION_MAX);
    refreshDescriptiveTexts('demo-id', { it: { ogDescription: social } }, undefined, { repoRoot: root });
    const it = fs.readFileSync(path.join(root, 'content', 'blog-meta-it.ts'), 'utf-8');
    assert.ok(it.includes(`'blog.article.demo-id.ogDescription': '${social}',`), 'ogDescription non doveva essere tagliata');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refreshDescriptiveTexts: il clamp e\' idempotente sul rerun (nessuna riscrittura al secondo giro)', () => {
  const root = syntheticCorpus();
  try {
    const localeTexts = { it: { seoDescription: LONG_TEXT } };
    const first = refreshDescriptiveTexts('demo-id', localeTexts, undefined, { repoRoot: root });
    assert.equal(first.changed, true);
    const second = refreshDescriptiveTexts('demo-id', localeTexts, undefined, { repoRoot: root });
    assert.equal(second.changed, false, 'il testo gia\' tagliato deve tagliarsi identico e non produrre un secondo write');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SEO_DESCRIPTION_MAX/SEO_OG_DESCRIPTION_MAX restano allineati ai valori di create-article.mjs', () => {
  const src = fs.readFileSync(CREATE_ARTICLE, 'utf-8');
  const max = src.match(/^const SEO_DESCRIPTION_MAX = (\d+);$/m);
  const ogMax = src.match(/^const SEO_OG_DESCRIPTION_MAX = (\d+);$/m);
  assert.ok(max, 'SEO_DESCRIPTION_MAX non trovato in create-article.mjs — aggiornare i delimitatori di questo test');
  assert.ok(ogMax, 'SEO_OG_DESCRIPTION_MAX non trovato in create-article.mjs — aggiornare i delimitatori di questo test');
  assert.equal(
    SEO_DESCRIPTION_MAX,
    Number(max[1]),
    "article-meta-refresh.mjs duplica questo valore (non puo' importarlo senza jsdom) — i due sono andati fuori sincrono",
  );
  assert.equal(
    SEO_OG_DESCRIPTION_MAX,
    Number(ogMax[1]),
    "article-meta-refresh.mjs duplica questo valore (non puo' importarlo senza jsdom) — i due sono andati fuori sincrono",
  );
});

// ── 2b. Ricostruzione pura per una data passata (la riparazione delle 2 edizioni) ─

test('buildDescriptiveTexts: ricostruisce ESATTAMENTE gli stessi testi del content builder completo, senza lo snapshot', () => {
  // Il builder completo (buildDailyBriefArticle) ha bisogno di un brief vero
  // (blocchi, headline...); buildDescriptiveTexts no — solo della data. Questo
  // test prova che l'assenza dei blocchi non cambia il risultato per i TRE
  // campi descrittivi, che e' esattamente la proprieta' che rende
  // riparabile un'edizione il cui snapshot originale non esiste piu'.
  const BRIEF = {
    dateIso: '2026-08-08',
    counts: { availableBlocks: 4 },
    blocks: {
      borderWait: { available: true, count: 10, zeroWaitCount: 5, worst: { name: 'Chiasso', waitMinutes: 12 }, crossings: [] },
      fuel: { available: true, municipalityCount: 5, cheaperSwissCount: 2, cheaperItalyCount: 3, cheapestItaly: [], bestSavings: [], cheapestSwissStation: null },
      exchange: { available: true, rate: 1.05, lastDate: '2026-08-07', delta1d: 0, delta7d: 0 },
      jobs: { available: true, activeJobs: 100, activeCompanies: 10, yesterdayAdded: 1188, last7dAdded: 500 },
    },
  };
  const article = buildDailyBriefArticle(BRIEF);
  for (const locale of ['it', 'en', 'de', 'fr']) {
    const reconstructed = buildDescriptiveTexts('2026-08-08', locale);
    assert.equal(reconstructed.excerpt, article.content[locale].excerpt, `${locale}.excerpt non combacia`);
    assert.equal(reconstructed.seoDescription, article.content[locale].seoDescription, `${locale}.seoDescription non combacia`);
    assert.equal(reconstructed.ogDescription, article.content[locale].ogDescription, `${locale}.ogDescription non combacia`);
  }
});

test('buildDescriptiveTexts: description e ogDescription restano due testi distinti (anti #79/#80)', () => {
  for (const locale of ['it', 'en', 'de', 'fr']) {
    const t = buildDescriptiveTexts('2026-09-22', locale);
    assert.notEqual(t.seoDescription, t.ogDescription, `${locale}: le due description sono tornate a coincidere`);
    assert.ok(t.excerpt.length > t.seoDescription.length, `${locale}: l'excerpt non e' piu' il testo piu' ricco`);
  }
});

// ── 3. Wiring — il ramo `exists` chiama davvero il refresh ──────────────────
//
// Stesso pattern di `create-article usa la lib condivisa` (meta-localized-seo-
// description.test.mjs) e di `registerArticleFiles applica il cap PRIMA di
// scrivere` (seo-description-cap.test.mjs): un'asserzione sul SORGENTE, non
// un import, perche' generate-daily-brief-article.mjs pull-a create-article.mjs
// e quindi jsdom, assente sotto questo gate dependency-free.

test('wiring: generate-daily-brief-article.mjs importa refreshDescriptiveTexts dalla lib condivisa', () => {
  const src = fs.readFileSync(GENERATE_SCRIPT, 'utf-8');
  assert.match(
    src,
    /import\s*\{\s*refreshDescriptiveTexts\s*\}\s*from\s*'\.\/lib\/article-meta-refresh\.mjs'/,
    'lo script non importa piu\' la lib condivisa: il refresh di meta/seo rischia di essere reimplementato in loco',
  );
});

test('wiring: il ramo `exists` chiama il refresh di meta/seo DOPO i body e PRIMA del bump di dateModified', () => {
  const src = fs.readFileSync(GENERATE_SCRIPT, 'utf-8');
  const startRe = /console\.log\('♻️ {2}same-day rerun — refreshing body files in place…'\);/;
  const startMatch = startRe.exec(src);
  assert.ok(startMatch, 'ramo `exists` non trovato — aggiornare il delimitatore di questo test');
  const tail = src.slice(startMatch.index);
  const endRel = tail.indexOf("console.log('✅ refreshed.');");
  assert.ok(endRel > -1, 'fine del ramo `exists` non trovata');
  const branch = tail.slice(0, endRel);

  const bodyAt = branch.indexOf('refreshBodyFiles(data);');
  const metaAt = branch.indexOf('refreshMetaAndSeo(data)');
  const bumpAt = branch.indexOf('bumpDateModified(');
  assert.ok(bodyAt > -1, 'refreshBodyFiles non chiamato nel ramo exists');
  assert.ok(metaAt > -1, 'refreshMetaAndSeo non chiamato nel ramo exists — issue #85 non risolta qui');
  assert.ok(bumpAt > -1, 'bumpDateModified non chiamato nel ramo exists');
  assert.ok(bodyAt < metaAt, 'il refresh di meta/seo deve avvenire dopo quello dei body');
  assert.ok(metaAt < bumpAt, 'il refresh di meta/seo deve avvenire prima del bump di dateModified');
});

/**
 * Sandbox execution of the REAL `refreshMetaAndSeo` body (extracted from the
 * source, not reimplemented) against a stubbed `refreshDescriptiveTexts` —
 * same technique `seo-description-cap.test.mjs` uses to exercise code inside
 * create-article.mjs without importing it. Stronger than a substring check:
 * this proves the actual mapping from `data.content[locale]`/`data.seo` to
 * `refreshDescriptiveTexts`'s arguments, not just that the right identifiers
 * appear somewhere in the function's text.
 */
test('wiring: refreshMetaAndSeo mappa data.content/data.seo su refreshDescriptiveTexts (sandbox)', () => {
  const src = fs.readFileSync(GENERATE_SCRIPT, 'utf-8');
  const header = 'export function refreshMetaAndSeo(';
  const start = src.indexOf(header);
  assert.ok(start > -1, "refreshMetaAndSeo non e' (piu') esportata");
  const endRel = src.slice(start).search(/\n\}\n/);
  assert.ok(endRel > -1, 'chiusura di refreshMetaAndSeo non trovata');
  const fnSrc = src.slice(start, start + endRel + 2).replace('export function', 'return function');

  const calls = [];
  const stubRefresh = (id, localeTexts, seoTexts, opts) => {
    calls.push({ id, localeTexts, seoTexts, opts });
    return { changed: true, touched: ['stub-file'] };
  };
  const FAKE_ROOT = '/fake/repo/root';
  // `sanitizePromptPlaceholders` e' iniettata quella VERA (follow-up #315): la
  // guardia sui segnaposto e' passata in processo, e questo sandbox eseguirebbe
  // il corpo reale con un identificatore non definito. Il fixture qui sotto e'
  // pulito, quindi la guardia e' un no-op e la mappatura sotto test non cambia.
  const refreshMetaAndSeo = new Function(
    'LOCALES', 'refreshDescriptiveTexts', 'REPO_ROOT', 'sanitizePromptPlaceholders',
    `${fnSrc}\n`,
  )(['it', 'en', 'de', 'fr'], stubRefresh, FAKE_ROOT, sanitizePromptPlaceholders);

  const data = {
    id: 'demo-id',
    content: {
      it: { excerpt: 'E it', seoDescription: 'S it', ogDescription: 'O it' },
      en: { excerpt: 'E en', seoDescription: 'S en', ogDescription: 'O en' },
      de: { excerpt: 'E de', seoDescription: 'S de', ogDescription: 'O de' },
      fr: { excerpt: 'E fr', seoDescription: 'S fr', ogDescription: 'O fr' },
    },
    seo: { description: 'S it', ogDescription: 'O it' },
  };
  const result = refreshMetaAndSeo(data);

  assert.equal(calls.length, 1, 'refreshDescriptiveTexts deve essere chiamata esattamente una volta');
  assert.equal(calls[0].id, 'demo-id');
  assert.deepEqual(
    calls[0].localeTexts.en,
    { excerpt: 'E en', seoDescription: 'S en', ogDescription: 'O en' },
    'i testi EN passati non sono quelli di data.content.en',
  );
  assert.deepEqual(
    calls[0].seoTexts,
    { description: 'S it', ogDescription: 'O it' },
    "l'entry SEO deve venire da data.seo.description/ogDescription (IT-only)",
  );
  assert.equal(calls[0].opts.repoRoot, FAKE_ROOT, 'repoRoot non propagato');
  assert.deepEqual(result, { changed: true, touched: ['stub-file'] }, 'il valore di ritorno deve essere quello di refreshDescriptiveTexts, non ricostruito');
});
