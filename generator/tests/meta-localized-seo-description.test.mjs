/**
 * `seoDescription` / `ogDescription` per-locale: dal content builder alla
 * superficie dati. Si esegue con `node --test`.
 *
 * ## Il difetto che pinna
 *
 * La PR #83 ha separato tre superfici descrittive del Bollettino — `excerpt`
 * (~250-280, cio' che l'utente LEGGE), `seoDescription` (150-160, cio' che
 * Google mostra), `ogDescription` (200-250, la card social) — e le ha scritte e
 * misurate in tutte e quattro le locali. Poi nessuna delle tre localizzate e'
 * uscita dal processo: `buildMetaBlock` emetteva `title|excerpt|imageAlt` e
 * basta. Misurato sulla superficie pubblicata prima di questo cambio:
 *
 *     curl -s .../frontaliere-articles/meta-en.json
 *     → 9423 chiavi: 3141 title, 3141 excerpt, 3141 imageAlt, 0 seoDescription
 *
 * Testi corretti, testati, e non consumati da nessuno: per /en/, /de/, /fr/ la
 * meta description continuava a nascere dall'excerpt della locale troncato a
 * 155 da `engine/ogPagesPlugin.ts`. Un difetto di EMISSIONE non ha una forma
 * che un test sul produttore possa vedere — `daily-brief-content.test.mjs`
 * misurava i tre campi ed era verde mentre succedeva.
 *
 * ## Le tre lenti, perche' una sola non basta
 *
 *   1. l'EMETTITORE (`buildMetaBlock`): dato un articolo che porta i campi,
 *      escono le righe, per tutte e quattro le locali, e sono rileggibili con
 *      lo stesso `metaFieldRegex` che il repo usa per leggerle. Sempre non
 *      vacuo: l'input se lo costruisce il test.
 *   2. la RETROCOMPATIBILITA': un articolo che NON porta i campi produce
 *      esattamente le righe di prima, nello stesso ordine. E' questa a rendere
 *      il cambio additivo per i ~3100 articoli che una seoDescription
 *      localizzata non ce l'hanno e continueranno a cadere sull'excerpt.
 *   3. la SUPERFICIE (`content/blog-meta*.ts` → `meta-<locale>.json`): quello
 *      che e' davvero scritto sul disco del repo, con il cricchetto
 *      auto-armante descritto sotto.
 *
 * ## Il cricchetto auto-armante
 *
 * Un'asserzione di PRESENZA sul corpus sarebbe rossa il giorno del merge (oggi
 * nessun articolo porta il campo: le due edizioni gia' pubblicate sono nate
 * prima di questo cambio e `content/**` non si tocca a mano), e una data di
 * cutover scritta a mano sarebbe una bomba a orologeria tarata su quando la PR
 * viene mergiata — cioe' su niente.
 *
 * Quindi il cricchetto si arma da solo: cerca la PRIMA edizione datata che
 * porta il campo in tutte e quattro le locali e pretende che ogni edizione
 * SUCCESSIVA lo porti. Finche' non ce n'e' nessuna resta dormiente e lo dice;
 * dalla prima edizione emessa col codice nuovo — la mattina dopo il merge — una
 * regressione dell'emettitore rende rosso `main` entro ventiquattr'ore, senza
 * che nessuno abbia dovuto indovinare una data.
 *
 * ## L'anti-falso-verde
 *
 * Le scansioni su `content/` sono il posto dove un test diventa verde per
 * assenza: in un checkout sparse `content/` non esiste, `readdir` restituisce
 * zero file e ogni `for` sopra a zero elementi passa. Qui il numero di file
 * letti e di articoli visti e' asserito PRIMA di qualunque invariante.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildMetaBlock,
  buildMetaBlockLines,
  escapeForSingleQuoteTS,
  META_FIELDS,
  META_CORE_FIELDS,
  META_SEO_FIELDS,
} from '../scripts/lib/article-meta-block.mjs';
import { metaFieldRegex, unescapeTsValue } from '../scripts/lib/meta-field-regex.mjs';
import { buildDailyBriefArticle } from '../scripts/lib/daily-brief-content.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOCALES = ['it', 'en', 'de', 'fr'];

/** Le due famiglie di file meta: frontaliere e svizzera. */
const META_FAMILIES = [
  { id: 'frontaliere', prefix: 'blog-meta', minIds: 500 },
  { id: 'svizzera', prefix: 'blog-meta-ch', minIds: 200 },
];

// ── 1. L'emettitore ──────────────────────────────────────────────────────────

/** Un articolo minimo nella forma che `registerArticleFiles` riceve. */
const articleWith = (extra = {}) => ({
  id: 'demo-articolo',
  imageAlt: { it: 'Alt IT', en: 'Alt EN', de: 'Alt DE', fr: 'Alt FR' },
  content: {
    it: { title: 'Titolo IT', excerpt: 'Estratto IT', ...(extra.it || {}) },
    en: { title: 'Title EN', excerpt: 'Excerpt EN', ...(extra.en || {}) },
    de: { title: 'Titel DE', excerpt: 'Auszug DE', ...(extra.de || {}) },
    fr: { title: 'Titre FR', excerpt: 'Extrait FR', ...(extra.fr || {}) },
  },
});

test('emettitore: senza i campi SEO l\'output resta byte-identico a prima', () => {
  const block = buildMetaBlock(articleWith(), 'en');
  assert.equal(
    block,
    "    'blog.article.demo-articolo.title': 'Title EN',\n" +
      "    'blog.article.demo-articolo.excerpt': 'Excerpt EN',\n" +
      "    'blog.article.demo-articolo.imageAlt': 'Alt EN',",
    'il blocco meta di un articolo senza campi SEO per-locale deve essere ' +
      'IDENTICO a quello della versione precedente: e\' cio\' che rende il cambio ' +
      'additivo per i ~3100 articoli che non hanno una seoDescription localizzata.',
  );
});

test('emettitore: i campi SEO escono per TUTTE le locali, in coda ai tre storici', () => {
  const seo = {};
  for (const loc of LOCALES) {
    seo[loc] = { seoDescription: `SERP ${loc}`, ogDescription: `SOCIAL ${loc}` };
  }
  for (const loc of LOCALES) {
    const lines = buildMetaBlockLines(articleWith(seo), loc);
    assert.equal(lines.length, 5, `${loc}: attese 5 righe, ricevute ${lines.length}`);
    // Ordine: i tre storici non si spostano.
    for (let i = 0; i < META_FIELDS.length; i++) {
      assert.ok(
        lines[i].includes(`.${META_FIELDS[i]}':`),
        `${loc}: riga ${i} non e' \`${META_FIELDS[i]}\` — l'ordine dei campi e' parte del contratto`,
      );
    }
    assert.ok(lines[3].includes(`'SERP ${loc}'`), `${loc}: seoDescription non e' quella della locale`);
    assert.ok(lines[4].includes(`'SOCIAL ${loc}'`), `${loc}: ogDescription non e' quella della locale`);
  }
});

test('emettitore: le righe emesse sono rileggibili dal parser del repo', () => {
  // La seconda lente sull'emissione: non basta che la riga ci sia, deve essere
  // ESTRAIBILE da `metaFieldRegex` — lo stesso lettore che usano il rilevatore
  // di duplicati qui e (dopo la PR gemella) il parser dell'engine. Il valore
  // porta un apostrofo apposta: e' la classe di bug per cui `metaFieldRegex`
  // esiste (#4881, cinque copie del regex naive, quattro che troncavano).
  const withQuote = {
    en: {
      seoDescription: "Cross-border brief: what's cheapest today at the border.",
      ogDescription: "Today's numbers for cross-border workers: queues, fuel, rate.",
    },
  };
  const block = buildMetaBlock(articleWith(withQuote), 'en');
  for (const field of META_SEO_FIELDS) {
    const rx = metaFieldRegex(field);
    const m = rx.exec(block);
    assert.ok(m, `${field}: la riga emessa non e' estraibile da metaFieldRegex('${field}')`);
    assert.equal(m[1], 'demo-articolo');
    assert.equal(unescapeTsValue(m[2]), withQuote.en[field], `${field}: valore non round-trip`);
  }
  // E il file resta valutabile come JS: un escape sbagliato lo spezzerebbe.
  const src = `const m = {\n${block}\n};\nexport default m;\n`;
  assert.doesNotThrow(
    () => new Function(src.replace(/^export default .*/m, '')),
    'il blocco emesso non e\' sintatticamente valido',
  );
  assert.equal(escapeForSingleQuoteTS("l'A9"), "l\\'A9");
});

test('emettitore: un campo vuoto o assente non produce una chiave vuota', () => {
  const lines = buildMetaBlockLines(
    articleWith({ en: { seoDescription: '   ', ogDescription: '' } }),
    'en',
  );
  assert.equal(lines.length, 3, 'un valore vuoto deve essere OMESSO, non emesso come stringa vuota');
});

test('emettitore: title/excerpt whitespace-only restano byte-identici a prima (#123)', () => {
  // Il vecchio `buildMetaBlock` (prima di #117) non faceva alcun controllo di
  // presenza su title/excerpt: un valore whitespace-only usciva intatto. Un
  // trim generico applicato a tutti i campi lo collasserebbe a stringa vuota.
  const data = articleWith({ en: { title: '   ', excerpt: '  \t ' } });
  const block = buildMetaBlock(data, 'en');
  assert.equal(
    block,
    "    'blog.article.demo-articolo.title': '   ',\n" +
      "    'blog.article.demo-articolo.excerpt': '  \t ',\n" +
      "    'blog.article.demo-articolo.imageAlt': 'Alt EN',",
    'title/excerpt whitespace-only devono uscire cosi\' come stanno, non come stringa vuota',
  );
});

test('emettitore: imageAlt whitespace-only viene comunque emesso (#123)', () => {
  // Il vecchio codice era `if (alt)`: falsy solo sulla stringa vuota, quindi un
  // valore whitespace-only era gia' sufficiente per emetterlo.
  const data = articleWith();
  data.imageAlt.en = '   ';
  const lines = buildMetaBlockLines(data, 'en');
  assert.equal(lines.length, 3, 'imageAlt whitespace-only deve essere emesso, non omesso');
  assert.ok(lines[2].includes("'   '"), 'imageAlt whitespace-only deve uscire intatto');
});

// ── 2. L'edizione vera ───────────────────────────────────────────────────────

const BRIEF = {
  schemaVersion: 1,
  generatedAt: '2026-09-22T05:00:00.000Z',
  dateIso: '2026-09-22',
  counts: { availableBlocks: 4 },
  blocks: {
    borderWait: {
      available: true,
      count: 141,
      zeroWaitCount: 104,
      worst: { slug: 'chiasso-brogeda', name: 'Chiasso Brogeda', waitMinutes: 47 },
      crossings: [{ slug: 'chiasso-brogeda', name: 'Chiasso Brogeda', waitMinutes: 47, status: 'red', direction: 'Entrambi' }],
    },
    fuel: {
      available: true,
      municipalityCount: 518,
      cheaperItalyCount: 66,
      cheaperSwissCount: 71,
      tieCount: 9,
      cheapestItaly: [{ municipality: 'Livigno', province: 'SO', minPriceEur: 1.528, stationName: 'TOTAL ERG' }],
      bestSavings: [{ municipality: 'Livigno', province: 'SO', cheaperCountry: 'IT', italyPriceEur: 1.528, swissPriceEur: 2.033, swissPriceChf: 1.9, saving50LEur: 25.25 }],
      cheapestSwissStation: { name: 'Alpina', sp95PriceChf: 1.42, sp95PriceEur: 1.519, nearestMunicipality: 'Curon Venosta (BZ)' },
    },
    exchange: { available: true, rate: 1.0695, lastDate: '2026-09-22', prevRate: 1.0695, prevDate: '2026-09-21', delta1d: 0, rate7dAgo: 1.0741, delta7d: -0.0046, pointCount: 32 },
    jobs: { available: true, activeJobs: 22645, activeCompanies: 857, todayAdded: 12, yesterdayAdded: 591, last7dAdded: 4869 },
  },
};

/**
 * I budget: gli stessi che `daily-brief-content.test.mjs` misura sul content
 * builder, riverificati QUI sull'uscita dell'emettitore. Sono due punti diversi
 * della stessa catena, ed e' fra i due che il testo si perdeva.
 */
const BUDGET = {
  seoDescription: { min: 120, max: 165 },
  ogDescription: { min: 180, max: 250 },
};

test('edizione datata: il blocco meta porta i due campi in tutte e quattro le locali', () => {
  const article = buildDailyBriefArticle(BRIEF);
  const data = { id: article.id, imageAlt: article.imageAlt, content: article.content };
  for (const locale of LOCALES) {
    const block = buildMetaBlock(data, locale);
    const values = {};
    for (const field of META_SEO_FIELDS) {
      const m = metaFieldRegex(field).exec(block);
      assert.ok(m, `${locale}: \`${field}\` non emesso per ${article.id}`);
      values[field] = unescapeTsValue(m[2]);
      const { min, max } = BUDGET[field];
      assert.ok(
        values[field].length >= min && values[field].length <= max,
        `${locale}.${field}: ${values[field].length} caratteri, fuori da ${min}-${max}`,
      );
    }
    const excerpt = unescapeTsValue(metaFieldRegex('excerpt').exec(block)[2]);
    assert.notEqual(values.seoDescription, excerpt, `${locale}: la SERP e' di nuovo l'excerpt`);
    assert.ok(
      excerpt.length > values.seoDescription.length,
      `${locale}: l'excerpt non e' piu' il testo piu' ricco — e' la regressione #80`,
    );
    assert.ok(
      !excerpt.startsWith(values.seoDescription),
      `${locale}: la seoDescription e' un troncamento dell'excerpt, non un testo scritto per la SERP`,
    );
  }
});

// ── 3. La superficie pubblicata ──────────────────────────────────────────────

test('build-api: meta-<locale>.json non filtra i campi', () => {
  // Il campo esiste solo se sopravvive anche a questo passaggio. `build-api.mjs`
  // serializza il default export intero; il giorno in cui qualcuno ci mette una
  // allowlist, questa asserzione lo dice. Contratto NOMINATO e non importato —
  // la classe che CLAUDE.md chiama «un contratto che non ha forma di import».
  const src = fs.readFileSync(path.join(ROOT, 'scripts/build-api.mjs'), 'utf-8');
  assert.ok(
    src.includes('write(`meta-${loc}.json`, meta);'),
    'build-api.mjs non scrive piu\' l\'oggetto meta intero: se ora filtra i campi, ' +
      'un campo nuovo del blocco meta non raggiunge meta-<locale>.json.',
  );
  assert.ok(
    src.includes('write(`meta-ch-${loc}.json`, metaCh);'),
    'build-api.mjs non scrive piu\' l\'oggetto meta-ch intero.',
  );
});

/** Legge un file meta e ne estrae `{ id -> { campo -> valore } }`. */
function parseMetaFile(absPath) {
  const src = fs.readFileSync(absPath, 'utf-8');
  const out = new Map();
  for (const field of META_FIELDS) {
    const rx = metaFieldRegex(field);
    let m;
    while ((m = rx.exec(src)) !== null) {
      if (!out.has(m[1])) out.set(m[1], {});
      out.get(m[1])[field] = unescapeTsValue(m[2]);
    }
  }
  return out;
}

test('superficie: la scansione vede davvero i file (anti-falso-verde)', () => {
  const missing = [];
  for (const family of META_FAMILIES) {
    for (const locale of LOCALES) {
      const p = path.join(ROOT, 'content', `${family.prefix}-${locale}.ts`);
      if (!fs.existsSync(p)) missing.push(path.relative(ROOT, p));
    }
  }
  assert.deepEqual(
    missing,
    [],
    'file meta assenti: ' +
      missing.join(', ') +
      '. In un checkout sparse `content/` non esiste e ogni invariante qui sotto ' +
      'passerebbe su zero articoli. Questa asserzione e\' cio\' che impedisce a ' +
      'questo test di diventare verde per assenza.',
  );
  for (const family of META_FAMILIES) {
    for (const locale of LOCALES) {
      const parsed = parseMetaFile(path.join(ROOT, 'content', `${family.prefix}-${locale}.ts`));
      assert.ok(
        parsed.size >= family.minIds,
        `${family.prefix}-${locale}.ts: ${parsed.size} articoli letti, attesi almeno ${family.minIds}. ` +
          'O il corpus si e\' svuotato, o il parser non aggancia piu\' le righe.',
      );
    }
  }
});

test('superficie: i campi SEO arrivano a TUTTE le locali, o a nessuna', () => {
  // Il difetto originale ha una forma precisa: il campo esiste per una locale
  // e non per le altre (era IT-only, via l'entry SEO `blog-<id>`). Una presenza
  // asimmetrica e' peggio dell'assenza — la SERP inglese resterebbe
  // sull'excerpt mentre tutto dice che il campo c'e'.
  for (const family of META_FAMILIES) {
    const byLocale = {};
    for (const locale of LOCALES) {
      byLocale[locale] = parseMetaFile(path.join(ROOT, 'content', `${family.prefix}-${locale}.ts`));
    }
    for (const field of META_SEO_FIELDS) {
      const asymmetric = [];
      const ids = new Set();
      for (const locale of LOCALES) {
        for (const [id, entry] of byLocale[locale]) if (entry[field]) ids.add(id);
      }
      for (const id of ids) {
        const without = LOCALES.filter((l) => !byLocale[l].get(id)?.[field]);
        if (without.length) asymmetric.push(`${id} → manca in ${without.join(', ')}`);
      }
      assert.deepEqual(
        asymmetric,
        [],
        `${family.id}: \`${field}\` presente solo per alcune locali:\n  ${asymmetric.join('\n  ')}`,
      );
    }
  }
});

test('superficie: `excerpt` non viene mai SOSTITUITO dai campi SEO', () => {
  // La separazione delle tre superfici e' additiva per definizione: il giorno in
  // cui un articolo ha una seoDescription ma non piu' un excerpt, la card e la
  // newsletter perdono il testo che l'utente legge. E' la regressione #80 al
  // contrario, e da qui si vede.
  for (const family of META_FAMILIES) {
    for (const locale of LOCALES) {
      const parsed = parseMetaFile(path.join(ROOT, 'content', `${family.prefix}-${locale}.ts`));
      const broken = [];
      for (const [id, entry] of parsed) {
        if (!entry.seoDescription && !entry.ogDescription) continue;
        for (const field of META_CORE_FIELDS.slice(0, 2)) {
          if (!entry[field]) broken.push(`${id}.${field}`);
        }
      }
      assert.deepEqual(
        broken,
        [],
        `${family.prefix}-${locale}.ts: articoli con un campo SEO ma senza ${broken.join('/')}`,
      );
    }
  }
});

/**
 * Il cricchetto auto-armante sulle edizioni datate. Vedi l'intestazione: si arma
 * da solo alla prima edizione emessa dal codice nuovo e da quel momento in poi
 * una regressione dell'emettitore rende rosso `main` la mattina dopo.
 */
test('superficie: dalla prima edizione datata che porta il campo, lo portano tutte', () => {
  const EDITION_RE = /^bollettino-frontaliere-(\d{4}-\d{2}-\d{2})$/;
  const byLocale = {};
  for (const locale of LOCALES) {
    byLocale[locale] = parseMetaFile(path.join(ROOT, 'content', `blog-meta-${locale}.ts`));
  }
  const editions = [...byLocale.it.keys()]
    .map((id) => ({ id, date: EDITION_RE.exec(id)?.[1] }))
    .filter((e) => e.date)
    .sort((a, b) => a.date.localeCompare(b.date));

  assert.ok(
    editions.length > 0,
    'nessuna edizione datata `bollettino-frontaliere-YYYY-MM-DD` in blog-meta-it.ts. ' +
      'O il Bollettino non esce piu\', o questa scansione non vede il corpus: in ' +
      'entrambi i casi il cricchetto qui sotto sarebbe vacuo.',
  );

  const complete = (id) => LOCALES.every((l) => Boolean(byLocale[l].get(id)?.seoDescription));
  const armedFrom = editions.find((e) => complete(e.id));

  if (!armedFrom) {
    // Dormiente: nessuna edizione e' ancora nata dall'emettitore nuovo. Le lenti
    // 1 e 2 restano attive e coprono il codice; questa copre il corpus e si
    // accende da sola. Non e' un `skip`: il test PASSA dicendo perche'.
    console.log(
      `[meta-seo] cricchetto dormiente: ${editions.length} edizioni datate, nessuna con ` +
        'seoDescription in tutte e quattro le locali. Si arma alla prima edizione ' +
        'generata dopo il merge di questo cambio.',
    );
    return;
  }

  const regressed = editions
    .filter((e) => e.date > armedFrom.date && !complete(e.id))
    .map((e) => `${e.id} → manca in ${LOCALES.filter((l) => !byLocale[l].get(e.id)?.seoDescription).join(', ')}`);
  assert.deepEqual(
    regressed,
    [],
    `l'emettitore ha smesso di scrivere \`seoDescription\`: la prima edizione che lo porta ` +
      `e' ${armedFrom.id}, ma queste, successive, no:\n  ${regressed.join('\n  ')}\n` +
      'Il campo per-locale e\' cio\' che porta la meta description di en/de/fr fuori ' +
      'dall\'excerpt troncato a 155: senza, quelle SERP tornano indietro in silenzio.',
  );
});

// ── Il cablaggio, che nessuno pinnava ────────────────────────────────────────
//
// I test sopra provano che `buildMetaBlock` emette i campi. NON provano che sia
// LEI a scrivere i registri. Verificato da una seconda lente reintroducendo in
// `create-article.mjs` l'emettitore vecchio a tre campi: **627 test, 625 pass,
// 0 fail** — verde su copie reali. In quello stato la produzione non emette
// piu' niente e il cricchetto non se ne accorge mai, perche' senza edizioni che
// portano il campo `armedFrom` resta `undefined`, il test stampa «cricchetto
// dormiente» e passa per sempre.
//
// E' letteralmente la classe che l'intestazione di questo file dichiara di
// chiudere — «un difetto di EMISSIONE non ha una forma che un test sul
// produttore possa vedere» — reintrodotta un livello piu' in alto.
//
// Non e' teorica: `create-article.mjs` e' `adapted`, il gemello sul sito ha
// ancora la funzione inline, e un rebase che perde l'import non accende nulla
// perche' `generate-article.yml` degrada un exit non-zero a `::warning::`.
//
// Stesso pattern di `seo-description-cap.test.mjs`: si asserisce sul SORGENTE.
test('create-article usa la lib condivisa e non ridefinisce buildMetaBlock', () => {
  const src = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'create-article.mjs'),
    'utf-8',
  );
  const importMatch = /import\s*\{([^}]*)\}\s*from\s*'\.\/lib\/article-meta-block\.mjs'/.exec(src);
  assert.ok(
    importMatch,
    "create-article.mjs non importa piu' scripts/lib/article-meta-block.mjs: i registri li scrive qualcun altro",
  );
  assert.match(
    importMatch[1],
    /\bbuildMetaBlock\b/,
    "buildMetaBlock non e' fra i simboli importati dalla lib condivisa",
  );
  assert.doesNotMatch(
    src,
    /function\s+buildMetaBlock\s*\(/,
    "create-article.mjs ridefinisce buildMetaBlock localmente: la lib condivisa e' scavalcata e i campi SEO non escono",
  );
});

