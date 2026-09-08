/**
 * ── IL TITOLO DI LINGUA SBAGLIATA CHE IL GATE NON VEDEVA (#800) ────────────
 *
 * `classifyBody2Payload` aveva UN solo controllo di lingua, `isNonItalianScript`,
 * e quel controllo guarda la SCRITTURA: CJK, cirillico, ebraico, arabo. Un
 * titolo inglese, tedesco o francese ha ratio 0 non-latino, quindi passava.
 *
 * Il modo in cui ci arrivava e' `normalizeItalianContentFromPayload`: cerca
 * ogni campo attraverso tre candidati — `content[locale]`, `content` senza
 * locale, la radice — e da #768 il `content` locale-less ha priorita' sulla
 * radice. Su una risposta come
 *
 *     { content: { it: { title: "", excerpt: "…" },
 *                  title: "Cross-border workers in Switzerland: …" } }
 *
 * il `title` locale-less riempie il `title` vuoto di `content.it`, esce
 * `verdict:"ok"`, diventa slug e canonical, e va live SENZA rebuild del sito.
 *
 * ── PERCHE' LA MISURA ANTI-FALSO-POSITIVO E' PARTE DEL TEST ────────────────
 *
 * Su questa superficie un falso positivo non e' un fastidio: e' un articolo
 * buttato, perche' `reject` fa rigenerare. Il rilevatore va quindi misurato
 * contro il corpus VERO prima di fidarsene, ed e' esattamente cio' che fa il
 * terzo blocco: scansiona i `title` e gli `excerpt` IT pubblicati e pretende
 * zero offender — l'allowlist e' vuota da #985 e deve restarci.
 *
 * Il conteggio minimo non e' decorativo. Un checkout sparso senza `content/`
 * farebbe trovare zero titoli, zero offender, e il test passerebbe A VUOTO
 * dichiarando verde la proprieta' che non ha misurato — il modo silenzioso in
 * cui una gate smette di essere una gate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyBody2Payload,
  wrongLanguageAdoptions,
  resolveContentFieldSources,
  META_ONLY_FIELDS,
} from '../scripts/lib/body2-payload-verdict.mjs';
import {
  detectWrongLatinLanguage,
  detectWrongLatinLanguageInField,
  isCompactItalianRateTable,
  latinLanguageMarkerHits,
  vowelFinalWordRatio,
} from '../scripts/lib/itLanguageCheck.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const EXCERPT_IT = 'Excerpt italiano abbastanza lungo da superare il floor di plausibilita del gate.';

// ── 1. Il caso della issue: adozione da un candidato NON-locale ────────────

test('#800 — un title EN adottato da `content` senza locale finisce in missing', () => {
  const verdetto = classifyBody2Payload({
    parsed: {
      content: {
        it: { title: '', excerpt: EXCERPT_IT },
        title: 'Cross-border workers in Switzerland: the 2026 tax rules',
      },
    },
    expectedFields: META_ONLY_FIELDS,
  });

  assert.equal(verdetto.verdict, 'reject');
  assert.ok(
    verdetto.missing.some((m) => m.startsWith('title lingua')),
    `missing non nomina la lingua del title: ${JSON.stringify(verdetto.missing)}`,
  );
});

test('#800 — vale anche per DE e FR, e anche dalla radice del payload', () => {
  const casi = [
    ['Die neuen Regeln fuer Grenzgaenger in der Schweiz ab 2026', 'content'],
    ['Les nouvelles regles pour les frontaliers en Suisse des 2026', 'content'],
    ['Cross-border workers in Switzerland: the 2026 tax rules', 'root'],
  ];

  for (const [title, dove] of casi) {
    const parsed = dove === 'content'
      ? { content: { it: { title: '', excerpt: EXCERPT_IT }, title } }
      : { content: { it: { title: '', excerpt: EXCERPT_IT } }, title };

    const verdetto = classifyBody2Payload({ parsed, expectedFields: META_ONLY_FIELDS });
    assert.equal(verdetto.verdict, 'reject', `non rigettato: ${title}`);
    assert.ok(
      verdetto.missing.some((m) => m.startsWith('title lingua')),
      `missing non nomina la lingua: ${title} → ${JSON.stringify(verdetto.missing)}`,
    );
  }
});

test('#800 — il campo adottato da `content[locale]` NON viene rigiudicato', () => {
  // Stesso testo inglese, ma dichiarato dal modello nella lingua chiesta. Il
  // controllo nuovo tace apposta: li' non c'e' l'adozione silenziosa che e' la
  // causa, e rigiudicare aggiungerebbe solo rischio di falso positivo.
  const sources = resolveContentFieldSources(
    { content: { it: { title: 'Cross-border workers in Switzerland: the 2026 tax rules', excerpt: EXCERPT_IT } } },
    'it',
    META_ONLY_FIELDS,
  );
  assert.equal(sources.title.isLocale, true);
  assert.deepEqual(
    wrongLanguageAdoptions(
      { content: { it: { title: 'Cross-border workers in Switzerland: the 2026 tax rules', excerpt: EXCERPT_IT } } },
      'it',
      META_ONLY_FIELDS,
    ),
    [],
  );
});

test('#800 — nessuna regressione: un title italiano in content.it resta ok', () => {
  const verdetto = classifyBody2Payload({
    parsed: {
      content: {
        it: {
          title: 'Stipendio netto frontaliere 2026: come calcolarlo',
          excerpt: EXCERPT_IT,
        },
      },
    },
    expectedFields: META_ONLY_FIELDS,
  });

  assert.equal(verdetto.verdict, 'ok', JSON.stringify(verdetto.missing));
  assert.deepEqual(verdetto.missing, []);
});

test('#800 — un title italiano adottato da un candidato non-locale resta ok', () => {
  const verdetto = classifyBody2Payload({
    parsed: {
      content: {
        it: { title: '', excerpt: EXCERPT_IT },
        title: 'Frontalieri e telelavoro: le nuove regole del 2026',
      },
    },
    expectedFields: META_ONLY_FIELDS,
  });

  assert.equal(verdetto.verdict, 'ok', JSON.stringify(verdetto.missing));
});

test('#1177 — un excerpt italiano denso di sigle non e\' un falso non-IT', () => {
  const excerpt = 'Aliquote: AVS/AI/IPG 5,3%, AD/AC 1,1%, LAINF 0,7–1,5%';
  assert.equal(isCompactItalianRateTable(excerpt), true);
  const verdetto = classifyBody2Payload({
    parsed: {
      content: {
        it: { title: 'Titolo italiano abbastanza descrittivo', excerpt: '' },
        excerpt,
      },
    },
    expectedFields: META_ONLY_FIELDS,
  });

  assert.equal(verdetto.verdict, 'ok', JSON.stringify(verdetto.missing));
  assert.deepEqual(verdetto.missing, []);
});

test('#1177 — la deroga alle sigle non rende permissivo un excerpt generico', () => {
  const excerpt = 'Tax rates: AHV/IV 5.3%, ALV 1.1%, employers pay the contribution.';
  assert.equal(isCompactItalianRateTable(excerpt), false);
  const verdetto = classifyBody2Payload({
    parsed: {
      content: {
        it: { title: 'Titolo italiano abbastanza descrittivo', excerpt: '' },
        excerpt,
      },
    },
    expectedFields: META_ONLY_FIELDS,
  });

  assert.equal(verdetto.verdict, 'reject', JSON.stringify(verdetto.missing));
  assert.ok(verdetto.missing.some((m) => m.startsWith('excerpt lingua ')));
});

test('#1220 — la deroga vale sulle stesse stringhe anche per il corpus pubblicato', () => {
  // Il gate di generazione e gli scan del corpus DEVONO dare lo stesso verdetto
  // sullo stesso testo: se l'excerpt-tabella passa in generazione ma lo scan lo
  // legge grezzo, il primo articolo accettato rende rosso il gate su OGNI PR
  // successiva, per contenuto che il gate ha gia' dichiarato valido.
  const tabella = 'Aliquote: AVS/AI/IPG 5,3%, AD/AC 1,1%, LAINF 0,7-1,5%';

  assert.notEqual(detectWrongLatinLanguage(tabella, 'it'), null, 'il caso non e\' piu\' quello misurato');
  assert.deepEqual(
    wrongLanguageAdoptions(
      { content: { it: { title: 'Titolo italiano abbastanza descrittivo', excerpt: '' }, excerpt: tabella } },
      'it',
      META_ONLY_FIELDS,
    ),
    [],
  );
  // I campi che gli scan del corpus misurano: l'excerpt e le sue due copie SEO,
  // che `create-article.mjs` deriva da `it.excerpt`.
  for (const campo of ['excerpt', 'description', 'ogDescription']) {
    assert.equal(detectWrongLatinLanguageInField(tabella, 'it', campo), null, `deroga assente su ${campo}`);
  }
  // ...e nessun altro: il title resta giudicato dalla soglia misurata sui titoli.
  for (const campo of ['title', 'ogTitle']) {
    assert.notEqual(detectWrongLatinLanguageInField(tabella, 'it', campo), null, `deroga estesa a ${campo}`);
  }
});

test('#1220 — la deroga non copre un excerpt non-IT con percentuali e sigle', () => {
  // Il confine della deroga: la forma «tabella» da sola non basta a passare,
  // ne' l'ancoraggio italiano ne' i marker di lingua si spengono.
  const inglese = 'The AVS/AI and ALV rates are 5,3% and 1,1% for the workers with the new tax rules';

  assert.equal(isCompactItalianRateTable(inglese), false);
  assert.equal(detectWrongLatinLanguageInField(inglese, 'it', 'excerpt')?.lang, 'en');
  assert.equal(
    wrongLanguageAdoptions(
      { content: { it: { title: 'Titolo italiano abbastanza descrittivo', excerpt: '' }, excerpt: inglese } },
      'it',
      META_ONLY_FIELDS,
    ).length,
    1,
  );
});

test('#1153 — il rilevatore distingue un campo italiano su EN/DE/FR', () => {
  const casi = [
    ['en', 'Giovani nel Ticino: fuga e mancato rientro, la posizione politica'],
    ['de', 'Il territorio poroso tra Varese e la Svizzera: un confine che ora unisce più che dividere'],
    ['fr', 'Giovani nel Ticino: fuga e mancato rientro, la posizione politica'],
  ];

  for (const [locale, title] of casi) {
    const verdetto = classifyBody2Payload({
      parsed: {
        content: {
          [locale]: { title: '', excerpt: 'A sufficiently long local excerpt for this language.' },
          title,
        },
      },
      locale,
      expectedFields: META_ONLY_FIELDS,
    });

    assert.equal(verdetto.verdict, 'reject', `${locale}: ${title}`);
    assert.ok(verdetto.missing.some((m) => m.startsWith('title lingua it')), `${locale}: ${JSON.stringify(verdetto.missing)}`);
  }
});

// ── 2. Il rilevatore, sui suoi due segnali ────────────────────────────────

test('#800 — le liste di parole-funzione sono ESCLUSIVE fra le quattro lingue', () => {
  // `la`, `le`, `un`, `il`, `a`, `in`, `des`… esistono in piu' lingue: la
  // deduplica le toglie da tutte. Se una di queste tornasse a contare, il
  // margine fra italiano e francese si romperebbe per prima.
  for (const parola of ['la', 'le', 'un', 'il', 'a', 'in', 'des', 'qui', 'si', 'on']) {
    const hits = latinLanguageMarkerHits(parola);
    const totale = Object.values(hits).reduce((s, n) => s + n, 0);
    assert.equal(totale, 0, `"${parola}" conta ancora come marker di qualche lingua`);
  }
});

test('#800 — la morfologia separa italiano e non-italiano', () => {
  assert.ok(vowelFinalWordRatio('Stipendio netto frontaliere 2026: come calcolarlo') > 0.6);
  assert.ok(vowelFinalWordRatio('Cross-border workers in Switzerland: the 2026 tax rules') < 0.35);
  // Troppe poche parole per dire qualcosa: `null`, non un numero inventato.
  assert.equal(vowelFinalWordRatio('AVS 2026'), null);
});

test('#800 — senza evidenza il rilevatore torna null, non false', () => {
  assert.equal(detectWrongLatinLanguage('', 'it'), null);
  assert.equal(detectWrongLatinLanguage('Titolo breve', 'it'), null);
  // Locale fuori dalle quattro: nessuna competenza, nessun verdetto.
  assert.equal(detectWrongLatinLanguage('Cross-border workers in Switzerland: the rules', 'es'), null);
});

test('#800 — un titolo italiano con un prestito straniero non basta a rigettare', () => {
  // Margine 2: un colpo isolato («smart working», «Black Friday») non decide.
  for (const titolo of [
    'Smart working per frontalieri: cosa cambia nel 2026',
    'Black Friday in Ticino: le offerte per chi lavora oltre confine',
    'Home office e imposta alla fonte: la guida per i frontalieri',
  ]) {
    assert.equal(detectWrongLatinLanguage(titolo, 'it'), null, `falso positivo su: ${titolo}`);
  }
});

// ── 3. La misura anti-falso-positivo sul corpus pubblicato ────────────────

const META_IT = ['content/blog-meta-it.ts', 'content/blog-meta-ch-it.ts'];
// Il corpus pubblicato ne conta 5.682 (title) e 5.683 (excerpt) al 2026-09-06. La soglia sta molto sotto
// per non rompersi a ogni pubblicazione, ma abbastanza sopra da rendere
// impossibile un pass a vuoto su un checkout troncato.
const MIN_CAMPI_IT = 5000;
// #985 ha bonificato l'unico offender genuino rimasto
// (`sbb-controllers-bonuses-fines-ticino-2026`), quindi questa lista e' VUOTA
// e deve restarci: ogni voce aggiunta qui e' un titolo in lingua sbagliata che
// il gate smette di vedere. Una regressione si ritraduce, non si allowlista.
const OFFENDER_GENUINI = [];

function campiDalSorgente(sorgente, campo) {
  // Accetta sia stringhe JS con apici singoli sia quelle con doppi apici: il
  // corpus CH contiene entrambe le forme. Il lookahead evita di considerare
  // una stringa troncata come un campo pubblicato.
  const re = new RegExp(
    `['"]blog\\.article\\.([^'"]+)\\.${campo}['"]\\s*:\\s*(['"])((?:\\\\.|(?!\\2)[^\\r\\n])*?)\\2\\s*(?=[,}])`,
    'g',
  );
  return [...sorgente.matchAll(re)].map((m) => ({
    slug: m[1],
    value: m[3].replace(/\\([\\'"\\\\])/g, '$1'),
  }));
}

function campiPubblicati(file, campo) {
  const sorgente = readFileSync(path.join(ROOT, file), 'utf8');
  const slugs = campiDalSorgente(sorgente, 'title').map(({ slug }) => slug);
  const campi = campiDalSorgente(sorgente, campo);
  const slugSet = new Set(slugs);
  const campoSet = new Set(campi.map(({ slug }) => slug));

  assert.equal(slugs.length, slugSet.size, `${file}: slug title duplicati o parser disallineato`);
  assert.equal(campi.length, campoSet.size, `${file}: ${campo} duplicati o parser disallineato`);
  assert.equal(
    campi.length,
    slugs.length,
    `${file}: ${campo} letti ${campi.length}, ma gli slug sono ${slugs.length}: estrazione parziale`,
  );
  assert.deepEqual(
    [...campoSet].sort(), [...slugSet].sort(),
    `${file}: gli slug di ${campo} non coincidono con quelli dei title`,
  );
  return campi;
}

function scanCorpusIt(t, campo) {
  const mancanti = META_IT.filter((f) => !existsSync(path.join(ROOT, f)));
  if (mancanti.length > 0) {
    t.skip(`corpus non presente in questo checkout: ${mancanti.join(', ')}`);
    return;
  }

  const valori = META_IT.flatMap((f) => campiPubblicati(f, campo).map(({ value }) => value));
  assert.ok(
    valori.length >= MIN_CAMPI_IT,
    `letti solo ${valori.length} ${campo} IT (minimo ${MIN_CAMPI_IT}): corpus troncato o `
    + 'regex di estrazione disallineata — questo test NON deve passare a vuoto',
  );

  const offender = valori
    .map((valore) => [valore, detectWrongLatinLanguageInField(valore, 'it', campo)])
    .filter(([valore, esito]) => esito && !OFFENDER_GENUINI.includes(valore));

  assert.deepEqual(
    offender.map(([valore, esito]) => `${esito.lang}/${esito.reason} :: ${valore}`),
    [],
    `il rilevatore rigetta ${campo} italiani legittimi su ${valori.length} misurati`,
  );
}

test('#800 — zero falsi positivi sui title IT pubblicati', (t) => {
  scanCorpusIt(t, 'title');
});

// L'excerpt e' pubblicato quanto il title — meta-<locale>.json, RSS, og:description
// — e #985 ne ha bonificato uno inglese che nessuno stava misurando.
test('#985 — zero falsi positivi sugli excerpt IT pubblicati', (t) => {
  scanCorpusIt(t, 'excerpt');
});

const META_NON_IT = {
  en: ['content/blog-meta-en.ts', 'content/blog-meta-ch-en.ts'],
  de: ['content/blog-meta-de.ts', 'content/blog-meta-ch-de.ts'],
  fr: ['content/blog-meta-fr.ts', 'content/blog-meta-ch-fr.ts'],
};
// Misura corrente del parser: 3.845 campi sui file main e 2.022 sui CH per
// ciascun locale. Il margine assorbe ritiri fisiologici senza permettere a un
// file perso o troncato di far passare una sola superficie.
const MIN_CAMPI_TRADOTTI_PER_FILE = {
  main: 3400,
  ch: 1800,
};

function scanCorpusLocale(t, locale, campo) {
  const files = META_NON_IT[locale];
  const mancanti = files.filter((file) => !existsSync(path.join(ROOT, file)));
  if (mancanti.length > 0) {
    t.skip(`superficie ${locale} non presente in questo checkout: ${mancanti.join(', ')}`);
    return;
  }

  const scansioni = files.map((file) => {
    const valori = campiPubblicati(file, campo).map(({ value }) => value);
    const minimo = file.includes('blog-meta-ch-')
      ? MIN_CAMPI_TRADOTTI_PER_FILE.ch
      : MIN_CAMPI_TRADOTTI_PER_FILE.main;
    assert.ok(
      valori.length >= minimo,
      `letti solo ${valori.length} ${campo} ${locale} in ${file} (minimo ${minimo}): superficie tradotta troncata`,
    );
    return valori;
  });
  const valori = scansioni.flat();

  const offender = valori
    .map((valore) => [valore, detectWrongLatinLanguageInField(valore, locale, campo)])
    .filter(([, esito]) => esito);

  assert.deepEqual(
    offender.map(([valore, esito]) => `${esito.lang}/${esito.reason} :: ${valore}`),
    [],
    `il rilevatore trova lingua sbagliata su ${campo} ${locale} (${valori.length} misurati)`,
  );
}

for (const locale of Object.keys(META_NON_IT)) {
  test(`#1153 — zero adozioni di lingua sbagliata sui title ${locale} pubblicati`, (t) => {
    scanCorpusLocale(t, locale, 'title');
  });
  test(`#1153 — zero adozioni di lingua sbagliata sugli excerpt ${locale} pubblicati`, (t) => {
    scanCorpusLocale(t, locale, 'excerpt');
  });
}

const SEO_DIR = path.join(ROOT, 'content/seo');
const SEO_FILES = existsSync(SEO_DIR)
  ? readdirSync(SEO_DIR)
    .filter((file) => /^seo-blog.*\.ts$/.test(file))
    .sort()
    .map((file) => path.join('content/seo', file))
  : [];
const SEO_FIELDS = ['title', 'description', 'ogTitle', 'ogDescription'];
const MIN_SEO_CAMPI_IT = 20000;
const SEO_ENTRY_RE = /^\s*['"](blog-[^'"]+)['"]:\s*\{([\s\S]*?)(?=^\s*['"]blog-[^'"]+['"]:\s*\{|^\s*};)/gm;

function seoCampo(blocco, campo) {
  const re = new RegExp(
    `^\\s*${campo}:\\s*(['"])((?:\\\\.|(?!\\1)[^\\r\\n])*?)\\1`,
    'm',
  );
  const match = blocco.match(re);
  return match ? match[2].replace(/\\([\\'"\\\\])/g, '$1') : null;
}

test('#1177 — la classe SEO IT resta coperta dalla scansione', (t) => {
  if (!existsSync(SEO_DIR)) {
    t.skip('directory SEO non presente in questo checkout');
    return;
  }
  const mancanti = SEO_FILES.filter((file) => !existsSync(path.join(ROOT, file)));
  if (mancanti.length > 0) {
    t.skip(`SEO non presente in questo checkout: ${mancanti.join(', ')}`);
    return;
  }

  const campi = [];
  for (const file of SEO_FILES) {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    for (const entry of source.matchAll(SEO_ENTRY_RE)) {
      const blocco = entry[2];
      // I chunk possono contenere più superfici; `/articoli-` è il contratto
      // del canonical IT, quindi è il discriminante di lingua della scansione.
      const canonical = seoCampo(blocco, 'canonicalPath');
      if (!canonical?.startsWith('/articoli-')) continue;
      for (const campo of SEO_FIELDS) {
        const value = seoCampo(blocco, campo);
        assert.notEqual(value, null, `${file}:${entry[1]} manca ${campo}`);
        campi.push({ file, id: entry[1], campo, value });
      }
    }
  }

  assert.ok(campi.length >= MIN_SEO_CAMPI_IT, `letti solo ${campi.length} campi SEO IT: scansione troncata`);
  const offender = campi
    .map(({ value, campo, ...meta }) => ({ ...meta, campo, value, esito: detectWrongLatinLanguageInField(value, 'it', campo) }))
    .filter(({ esito }) => esito);
  assert.deepEqual(
    offender.map(({ file, id, campo, value, esito }) => `${file}:${id}.${campo} ${esito.lang}/${esito.reason} :: ${value}`),
    [],
    `il rilevatore trova lingua sbagliata in ${offender.length} campi SEO IT`,
  );
});

test('#1177 — il bullet del body IT e\' italiano', () => {
  const source = readFileSync(path.join(ROOT, 'content/blog-body/it/chiese-ticino-derubate-2026.ts'), 'utf8');
  assert.doesNotMatch(source, /Bargeld, Silberbesteck und Einbruchswerkzeug sichergestellt/);
  assert.match(source, /Contanti, posate d\\'argento e strumenti da scasso sequestrati/);
});
